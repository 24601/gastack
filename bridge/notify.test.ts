/**
 * Tests for the notify adapter — Slack/Discord webhook delivery.
 *
 * Uses a mock fetch to avoid real HTTP calls.
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import {
  formatSlack,
  formatDiscord,
  formatPayload,
  deliver,
  NotifyAdapter,
  type WebhookTarget,
  type NotifyPayload,
  type DeliveryResult,
} from './notify.js';

// --- Mock fetch ---

function mockFetch(
  status: number = 200,
  opts?: { delay?: number; failAfter?: number },
): { fn: typeof fetch; calls: { url: string; body: string }[] } {
  let callCount = 0;
  const calls: { url: string; body: string }[] = [];

  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    callCount++;
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, body: String(init?.body ?? '') });

    if (opts?.delay) {
      await new Promise((r) => setTimeout(r, opts.delay));
    }

    if (opts?.failAfter !== undefined && callCount <= opts.failAfter) {
      throw new Error('Connection refused');
    }

    return new Response('ok', { status });
  }) as typeof fetch;

  return { fn, calls };
}

// --- formatSlack tests ---

describe('formatSlack', () => {
  test('plain text message', () => {
    const result = formatSlack({ text: 'Deploy complete' });
    expect(result.text).toBe('Deploy complete');
  });

  test('with severity adds color attachment', () => {
    const result = formatSlack({ text: 'Error!', severity: 'error' });
    const attachments = result.attachments as Array<{ color: string }>;
    expect(attachments).toHaveLength(1);
    expect(attachments[0].color).toBe('#F44336');
  });

  test('with fields adds structured attachment', () => {
    const result = formatSlack({
      text: 'Deploy',
      fields: { Branch: 'main', Commit: 'abc123' },
      severity: 'success',
    });
    const attachments = result.attachments as Array<{
      color: string;
      fields: Array<{ title: string; value: string; short: boolean }>;
    }>;
    expect(attachments[0].fields).toHaveLength(2);
    expect(attachments[0].fields[0].title).toBe('Branch');
    expect(attachments[0].fields[0].short).toBe(true);
  });
});

// --- formatDiscord tests ---

describe('formatDiscord', () => {
  test('plain text without severity uses content', () => {
    const result = formatDiscord({ text: 'Hello' });
    expect(result.content).toBe('Hello');
    expect(result.embeds).toBeUndefined();
  });

  test('with severity uses embed', () => {
    const result = formatDiscord({ text: 'Warning!', severity: 'warn' });
    const embeds = result.embeds as Array<{ description: string; color: number }>;
    expect(embeds).toHaveLength(1);
    expect(embeds[0].description).toBe('Warning!');
    expect(embeds[0].color).toBe(0xFF9800);
  });

  test('with fields adds embed fields', () => {
    const result = formatDiscord({
      text: 'Status',
      fields: { Stage: 'DEPLOY', Status: 'green' },
      severity: 'info',
    });
    const embeds = result.embeds as Array<{
      fields: Array<{ name: string; value: string; inline: boolean }>;
    }>;
    expect(embeds[0].fields).toHaveLength(2);
    expect(embeds[0].fields[0].name).toBe('Stage');
  });
});

// --- formatPayload dispatch ---

describe('formatPayload', () => {
  test('routes to slack formatter', () => {
    const result = formatPayload('slack', { text: 'hi' });
    expect(result.text).toBe('hi');
  });

  test('routes to discord formatter', () => {
    const result = formatPayload('discord', { text: 'hi' });
    expect(result.content).toBe('hi');
  });
});

// --- deliver tests ---

describe('deliver', () => {
  const target: WebhookTarget = {
    url: 'https://hooks.example.com/webhook',
    platform: 'slack',
    label: '#test',
  };

  test('successful delivery', async () => {
    const { fn } = mockFetch(200);
    const result = await deliver(target, { text: 'hello' }, { fetchFn: fn });
    expect(result.success).toBe(true);
    expect(result.status).toBe(200);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  test('4xx error does not retry', async () => {
    const { fn, calls } = mockFetch(400);
    const result = await deliver(target, { text: 'bad' }, { fetchFn: fn, maxRetries: 2 });
    expect(result.success).toBe(false);
    expect(result.error).toBe('HTTP 400');
    expect(calls).toHaveLength(1); // no retry
  });

  test('429 does retry', async () => {
    const { fn, calls } = mockFetch(429);
    const result = await deliver(target, { text: 'throttled' }, {
      fetchFn: fn,
      maxRetries: 1,
      timeout: 5000,
    });
    expect(result.success).toBe(false);
    expect(calls).toHaveLength(2); // initial + 1 retry
  });

  test('5xx retries then fails', async () => {
    const { fn, calls } = mockFetch(500);
    const result = await deliver(target, { text: 'err' }, { fetchFn: fn, maxRetries: 1 });
    expect(result.success).toBe(false);
    expect(calls).toHaveLength(2);
  });

  test('network error retries', async () => {
    const { fn, calls } = mockFetch(200, { failAfter: 1 });
    const result = await deliver(target, { text: 'retry' }, { fetchFn: fn, maxRetries: 2 });
    // First call fails, second succeeds
    expect(result.success).toBe(true);
    expect(calls).toHaveLength(2);
  });

  test('all retries exhausted returns failure', async () => {
    const { fn } = mockFetch(200, { failAfter: 10 }); // always fails
    const result = await deliver(target, { text: 'doom' }, { fetchFn: fn, maxRetries: 1 });
    expect(result.success).toBe(false);
    expect(result.error).toBe('Connection refused');
  });
});

// --- NotifyAdapter tests ---

describe('NotifyAdapter', () => {
  const slackTarget: WebhookTarget = {
    url: 'https://hooks.slack.com/services/T/B/xxx',
    platform: 'slack',
    label: '#deploys',
  };

  const discordTarget: WebhookTarget = {
    url: 'https://discord.com/api/webhooks/123/abc',
    platform: 'discord',
    label: 'ops-alerts',
  };

  test('implements Adapter interface', () => {
    const adapter = new NotifyAdapter({ targets: {} });
    expect(adapter.name).toBe('notify');
    expect(typeof adapter.execute).toBe('function');
  });

  test('send queues delivery to named target', async () => {
    const delivered: DeliveryResult[] = [];
    const { fn } = mockFetch(200);

    const adapter = new NotifyAdapter({
      targets: { deploys: slackTarget },
      onDelivery: (r) => delivered.push(r),
    });
    adapter.fetchFn = fn;

    const result = JSON.parse(
      await adapter.execute('send', { target: 'deploys', text: 'Deployed v1.2' }),
    );
    expect(result.queued).toBe(true);
    expect(result.target).toBe('deploys');

    // Wait for background delivery
    const results = await adapter.flush();
    expect(results).toHaveLength(1);
    expect(results[0].success).toBe(true);
    expect(delivered).toHaveLength(1);
  });

  test('send throws on unknown target', async () => {
    const adapter = new NotifyAdapter({ targets: { deploys: slackTarget } });
    await expect(
      adapter.execute('send', { target: 'nonexistent', text: 'hi' }),
    ).rejects.toThrow('Unknown notify target: "nonexistent"');
  });

  test('send throws when text is missing', async () => {
    const adapter = new NotifyAdapter({ targets: { deploys: slackTarget } });
    await expect(
      adapter.execute('send', { target: 'deploys' }),
    ).rejects.toThrow('"text" is required');
  });

  test('broadcast sends to all targets', async () => {
    const { fn, calls } = mockFetch(200);

    const adapter = new NotifyAdapter({
      targets: { slack: slackTarget, discord: discordTarget },
    });
    adapter.fetchFn = fn;

    const result = JSON.parse(
      await adapter.execute('broadcast', { text: 'System update', severity: 'info' }),
    );
    expect(result.queued).toBe(true);
    expect(result.targets).toHaveLength(2);

    await adapter.flush();
    expect(calls).toHaveLength(2);

    // Verify correct URLs were called
    const urls = calls.map((c) => c.url);
    expect(urls).toContain(slackTarget.url);
    expect(urls).toContain(discordTarget.url);
  });

  test('broadcast formats per platform', async () => {
    const { fn, calls } = mockFetch(200);

    const adapter = new NotifyAdapter({
      targets: { slack: slackTarget, discord: discordTarget },
    });
    adapter.fetchFn = fn;

    await adapter.execute('broadcast', { text: 'Alert', severity: 'error' });
    await adapter.flush();

    // Slack payload has "text" at top level
    const slackCall = calls.find((c) => c.url === slackTarget.url);
    const slackBody = JSON.parse(slackCall!.body);
    expect(slackBody.text).toBe('Alert');

    // Discord payload has "embeds" (due to severity)
    const discordCall = calls.find((c) => c.url === discordTarget.url);
    const discordBody = JSON.parse(discordCall!.body);
    expect(discordBody.embeds).toBeDefined();
    expect(discordBody.embeds[0].description).toBe('Alert');
  });

  test('list returns configured targets', async () => {
    const adapter = new NotifyAdapter({
      targets: { slack: slackTarget, discord: discordTarget },
    });

    const result = JSON.parse(await adapter.execute('list'));
    expect(result.targets).toHaveLength(2);
    expect(result.targets[0].name).toBe('slack');
    expect(result.targets[0].platform).toBe('slack');
    expect(result.targets[0].label).toBe('#deploys');
  });

  test('unknown command throws', async () => {
    const adapter = new NotifyAdapter({ targets: {} });
    await expect(adapter.execute('nope')).rejects.toThrow('Unknown notify command');
  });

  test('pendingCount tracks in-flight deliveries', async () => {
    const { fn } = mockFetch(200, { delay: 50 });

    const adapter = new NotifyAdapter({ targets: { s: slackTarget } });
    adapter.fetchFn = fn;

    expect(adapter.pendingCount).toBe(0);
    await adapter.execute('send', { target: 's', text: 'hi' });
    expect(adapter.pendingCount).toBe(1);

    await adapter.flush();
    expect(adapter.pendingCount).toBe(0);
  });

  test('onDelivery callback fires for each delivery', async () => {
    const results: DeliveryResult[] = [];
    const { fn } = mockFetch(200);

    const adapter = new NotifyAdapter({
      targets: { a: slackTarget, b: discordTarget },
      onDelivery: (r) => results.push(r),
    });
    adapter.fetchFn = fn;

    await adapter.execute('broadcast', { text: 'test' });
    await adapter.flush();

    expect(results).toHaveLength(2);
    expect(results.every((r) => r.success)).toBe(true);
  });

  test('delivery failure logged via callback', async () => {
    const results: DeliveryResult[] = [];
    const { fn } = mockFetch(500);

    const adapter = new NotifyAdapter({
      targets: { s: slackTarget },
      onDelivery: (r) => results.push(r),
      maxRetries: 0,
    });
    adapter.fetchFn = fn;

    await adapter.execute('send', { target: 's', text: 'fail' });
    await adapter.flush();

    expect(results).toHaveLength(1);
    expect(results[0].success).toBe(false);
    expect(results[0].error).toBe('HTTP 500');
  });

  test('integrates with orchestrator as adapter', async () => {
    // Verify it satisfies the Adapter interface shape
    const { fn } = mockFetch(200);
    const adapter = new NotifyAdapter({
      targets: { ops: slackTarget },
    });
    adapter.fetchFn = fn;

    // Adapter interface: { name: string, execute(command, args): Promise<string> }
    expect(adapter.name).toBe('notify');
    const result = await adapter.execute('send', { target: 'ops', text: 'test' });
    expect(typeof result).toBe('string');
    const parsed = JSON.parse(result);
    expect(parsed.queued).toBe(true);

    await adapter.flush();
  });
});
