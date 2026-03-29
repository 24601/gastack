/**
 * Bridge notify adapter — non-blocking Slack/Discord webhook delivery.
 *
 * Fire-and-forget webhook POSTs with:
 *   - Configurable webhook URLs per channel (Slack, Discord)
 *   - Platform-specific payload formatting
 *   - Delivery logging via callback (integrates with event log)
 *   - Timeout + retry with exponential backoff
 *   - No blocking: send() returns immediately, delivery happens in background
 */

import type { Adapter } from './orchestrate.js';

// --- Types ---

export type WebhookPlatform = 'slack' | 'discord';

export interface WebhookTarget {
  url: string;
  platform: WebhookPlatform;
  /** Optional label for logging (e.g., "#deploys", "ops-alerts"). */
  label?: string;
}

export interface NotifyPayload {
  /** Plain text message. Always required. */
  text: string;
  /** Optional structured fields (shown as attachment/embed). */
  fields?: Record<string, string>;
  /** Optional severity for color-coding. */
  severity?: 'info' | 'warn' | 'error' | 'success';
}

export interface DeliveryResult {
  target: WebhookTarget;
  success: boolean;
  status?: number;
  error?: string;
  durationMs: number;
}

/** Callback for delivery results (fire-and-forget logging). */
export type DeliveryCallback = (result: DeliveryResult) => void;

export interface NotifyOptions {
  /** Named webhook targets. */
  targets: Record<string, WebhookTarget>;
  /** Called after each delivery attempt (success or failure). */
  onDelivery?: DeliveryCallback;
  /** Timeout per request in ms (default: 10_000). */
  timeout?: number;
  /** Max retries on failure (default: 2). */
  maxRetries?: number;
}

// --- Severity → color mapping ---

const SEVERITY_COLORS: Record<string, { slack: string; discord: number }> = {
  info:    { slack: '#2196F3', discord: 0x2196F3 },
  warn:    { slack: '#FF9800', discord: 0xFF9800 },
  error:   { slack: '#F44336', discord: 0xF44336 },
  success: { slack: '#4CAF50', discord: 0x4CAF50 },
};

// --- Payload formatters ---

/** Build a Slack webhook payload. */
export function formatSlack(payload: NotifyPayload): Record<string, unknown> {
  const body: Record<string, unknown> = { text: payload.text };
  const color = SEVERITY_COLORS[payload.severity ?? 'info']?.slack;

  if (payload.fields || color) {
    body.attachments = [{
      color,
      fields: payload.fields
        ? Object.entries(payload.fields).map(([title, value]) => ({
            title,
            value,
            short: value.length < 40,
          }))
        : undefined,
    }];
  }

  return body;
}

/** Build a Discord webhook payload. */
export function formatDiscord(payload: NotifyPayload): Record<string, unknown> {
  const color = payload.severity ? SEVERITY_COLORS[payload.severity]?.discord : undefined;

  if (!payload.fields && !color) {
    return { content: payload.text };
  }

  return {
    embeds: [{
      description: payload.text,
      color,
      fields: payload.fields
        ? Object.entries(payload.fields).map(([name, value]) => ({
            name,
            value,
            inline: value.length < 40,
          }))
        : undefined,
    }],
  };
}

/** Format payload for a given platform. */
export function formatPayload(
  platform: WebhookPlatform,
  payload: NotifyPayload,
): Record<string, unknown> {
  return platform === 'slack' ? formatSlack(payload) : formatDiscord(payload);
}

// --- Delivery engine ---

/**
 * Deliver a webhook POST. Retries with exponential backoff on failure.
 * Returns the delivery result (never throws).
 */
export async function deliver(
  target: WebhookTarget,
  payload: NotifyPayload,
  opts?: { timeout?: number; maxRetries?: number; fetchFn?: typeof fetch },
): Promise<DeliveryResult> {
  const timeout = opts?.timeout ?? 10_000;
  const maxRetries = opts?.maxRetries ?? 2;
  const fetchFn = opts?.fetchFn ?? fetch;
  const body = JSON.stringify(formatPayload(target.platform, payload));

  let lastError: string | undefined;
  let lastStatus: number | undefined;
  const start = Date.now();

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      // Exponential backoff: 500ms, 1000ms, ...
      await new Promise((r) => setTimeout(r, 500 * Math.pow(2, attempt - 1)));
    }

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);

      const response = await fetchFn(target.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: controller.signal,
      });

      clearTimeout(timer);
      lastStatus = response.status;

      if (response.ok) {
        return {
          target,
          success: true,
          status: response.status,
          durationMs: Date.now() - start,
        };
      }

      lastError = `HTTP ${response.status}`;
      // Don't retry client errors (4xx) except 429
      if (response.status >= 400 && response.status < 500 && response.status !== 429) {
        break;
      }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }

  return {
    target,
    success: false,
    status: lastStatus,
    error: lastError,
    durationMs: Date.now() - start,
  };
}

// --- Notify adapter ---

/**
 * Bridge adapter for webhook notifications.
 *
 * Commands routed through execute():
 *   - send         → Send to a named target (args: { target, text, fields?, severity? })
 *   - broadcast    → Send to ALL targets (args: { text, fields?, severity? })
 *   - list         → List configured targets
 */
export class NotifyAdapter implements Adapter {
  readonly name = 'notify';
  private targets: Record<string, WebhookTarget>;
  private onDelivery: DeliveryCallback | undefined;
  private timeout: number;
  private maxRetries: number;
  /** Pending deliveries (tracked for flush/testing). */
  private pending: Promise<DeliveryResult>[] = [];
  /** Injection point for testing. */
  fetchFn: typeof fetch = fetch;

  constructor(opts: NotifyOptions) {
    this.targets = { ...opts.targets };
    this.onDelivery = opts.onDelivery;
    this.timeout = opts.timeout ?? 10_000;
    this.maxRetries = opts.maxRetries ?? 2;
  }

  async execute(
    command: string,
    args?: Record<string, unknown>,
  ): Promise<string> {
    switch (command) {
      case 'send':
        return this.send(args);
      case 'broadcast':
        return this.broadcast(args);
      case 'list':
        return this.list();
      default:
        throw new Error(`Unknown notify command: ${command}`);
    }
  }

  /** Send to a single named target. Non-blocking — returns immediately. */
  private send(args?: Record<string, unknown>): string {
    const targetName = String(args?.target ?? '');
    const target = this.targets[targetName];
    if (!target) {
      throw new Error(
        `Unknown notify target: "${targetName}". Available: ${Object.keys(this.targets).join(', ')}`,
      );
    }

    const payload = this.parsePayload(args);
    this.fireAndForget(target, payload);
    return JSON.stringify({ queued: true, target: targetName });
  }

  /** Send to all configured targets. Non-blocking. */
  private broadcast(args?: Record<string, unknown>): string {
    const payload = this.parsePayload(args);
    const names = Object.keys(this.targets);

    for (const name of names) {
      this.fireAndForget(this.targets[name], payload);
    }

    return JSON.stringify({ queued: true, targets: names });
  }

  /** List configured targets. */
  private list(): string {
    const entries = Object.entries(this.targets).map(([name, t]) => ({
      name,
      platform: t.platform,
      label: t.label ?? null,
    }));
    return JSON.stringify({ targets: entries });
  }

  /** Fire-and-forget delivery with callback logging. */
  private fireAndForget(target: WebhookTarget, payload: NotifyPayload): void {
    const promise = deliver(target, payload, {
      timeout: this.timeout,
      maxRetries: this.maxRetries,
      fetchFn: this.fetchFn,
    }).then((result) => {
      this.onDelivery?.(result);
      return result;
    });

    this.pending.push(promise);
  }

  /** Wait for all pending deliveries to complete (for testing/graceful shutdown). */
  async flush(): Promise<DeliveryResult[]> {
    const results = await Promise.all(this.pending);
    this.pending = [];
    return results;
  }

  /** Number of pending (in-flight) deliveries. */
  get pendingCount(): number {
    return this.pending.length;
  }

  /** Parse a NotifyPayload from command args. */
  private parsePayload(args?: Record<string, unknown>): NotifyPayload {
    const text = String(args?.text ?? '');
    if (!text) {
      throw new Error('notify: "text" is required');
    }

    return {
      text,
      fields: args?.fields as Record<string, string> | undefined,
      severity: (args?.severity as NotifyPayload['severity']) ?? 'info',
    };
  }
}
