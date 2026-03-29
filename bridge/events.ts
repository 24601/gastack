/**
 * Bridge event system — event-sourced state for the stage machine.
 *
 * The event log IS the state. On restart, replay events to reconstruct
 * the current stage, pending tasks, and completed work. No separate
 * "current state" field — everything is derived from the log.
 *
 * 13-event schema covers: session lifecycle, stage transitions, task
 * execution, external calls (with idempotency tokens), and approvals.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

// --- Stage definition ---

export const STAGES = ['PLAN', 'EXECUTE', 'REVIEW', 'REFINE', 'DEPLOY', 'DONE'] as const;
export type Stage = (typeof STAGES)[number];

// --- 13-event schema ---

export type BridgeEvent =
  | SessionCreated
  | SessionResumed
  | StageEntered
  | StageCompleted
  | TaskQueued
  | TaskStarted
  | TaskCompleted
  | TaskFailed
  | ExternalCallInitiated
  | ExternalCallCompleted
  | ApprovalRequested
  | ApprovalDecision
  | SessionCompleted;

// 1. Session lifecycle
export interface SessionCreated {
  type: 'SESSION_CREATED';
  sessionId: string;
  projectDir: string;
  config: Record<string, unknown>;
}

// 2. Session resumed from replay
export interface SessionResumed {
  type: 'SESSION_RESUMED';
  sessionId: string;
  replayedEvents: number;
  resumedAtStage: Stage;
}

// 3. Stage entered
export interface StageEntered {
  type: 'STAGE_ENTERED';
  stage: Stage;
}

// 4. Stage completed
export interface StageCompleted {
  type: 'STAGE_COMPLETED';
  stage: Stage;
  summary?: string;
}

// 5. Task queued for execution
export interface TaskQueued {
  type: 'TASK_QUEUED';
  taskId: string;
  description: string;
  stage: Stage;
  metadata?: Record<string, unknown>;
}

// 6. Task started
export interface TaskStarted {
  type: 'TASK_STARTED';
  taskId: string;
}

// 7. Task completed successfully
export interface TaskCompleted {
  type: 'TASK_COMPLETED';
  taskId: string;
  result?: string;
}

// 8. Task failed
export interface TaskFailed {
  type: 'TASK_FAILED';
  taskId: string;
  error: string;
  retryable: boolean;
}

// 9. External call initiated (idempotency-keyed)
export interface ExternalCallInitiated {
  type: 'EXTERNAL_CALL_INITIATED';
  callId: string;
  idempotencyKey: string;
  adapter: string;
  command: string;
  args?: Record<string, unknown>;
}

// 10. External call completed
export interface ExternalCallCompleted {
  type: 'EXTERNAL_CALL_COMPLETED';
  callId: string;
  idempotencyKey: string;
  success: boolean;
  result?: string;
  error?: string;
}

// 11. Approval requested (human gate)
export interface ApprovalRequested {
  type: 'APPROVAL_REQUESTED';
  approvalId: string;
  stage: Stage;
  description: string;
}

// 12. Approval granted or denied
export interface ApprovalDecision {
  type: 'APPROVAL_DECISION';
  approvalId: string;
  approved: boolean;
  reason?: string;
}

// 13. Session completed (terminal)
export interface SessionCompleted {
  type: 'SESSION_COMPLETED';
  finalStage: Stage;
  success: boolean;
  summary?: string;
}

// --- Event envelope ---

export interface EventEnvelope {
  id: string;
  timestamp: string;
  event: BridgeEvent;
}

// --- Event log (append-only, file-backed) ---

export class EventLog {
  private logPath: string;
  private events: EventEnvelope[] = [];

  constructor(logDir: string, sessionId?: string) {
    const id = sessionId ?? crypto.randomUUID();
    fs.mkdirSync(logDir, { recursive: true });
    this.logPath = path.join(logDir, `${id}.jsonl`);
  }

  /** Append an event to the log. Returns the envelope. */
  append(event: BridgeEvent): EventEnvelope {
    const envelope: EventEnvelope = {
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      event,
    };
    fs.appendFileSync(this.logPath, JSON.stringify(envelope) + '\n');
    this.events.push(envelope);
    return envelope;
  }

  /** Load all events from disk. Used for replay on restart. */
  static load(logPath: string): EventEnvelope[] {
    if (!fs.existsSync(logPath)) return [];
    const lines = fs.readFileSync(logPath, 'utf-8').split('\n').filter(Boolean);
    const envelopes: EventEnvelope[] = [];
    for (const line of lines) {
      try {
        envelopes.push(JSON.parse(line) as EventEnvelope);
      } catch {
        // Malformed/truncated line — skip (e.g. process killed mid-write).
      }
    }
    return envelopes;
  }

  /** Replay events into a fresh log instance (for crash recovery). */
  static replay(logPath: string): EventLog {
    const envelopes = EventLog.load(logPath);
    const log = Object.create(EventLog.prototype) as EventLog;
    log.logPath = logPath;
    log.events = envelopes;
    return log;
  }

  /** All events in order. */
  all(): ReadonlyArray<EventEnvelope> {
    return this.events;
  }

  /** Find the most recent event matching a type. */
  latest<T extends BridgeEvent['type']>(
    type: T,
  ): Extract<BridgeEvent, { type: T }> | undefined {
    for (let i = this.events.length - 1; i >= 0; i--) {
      if (this.events[i].event.type === type) {
        return this.events[i].event as Extract<BridgeEvent, { type: T }>;
      }
    }
    return undefined;
  }

  /** Check if an idempotency key has already been used. */
  hasIdempotencyKey(key: string): boolean {
    return this.events.some(
      (e) =>
        e.event.type === 'EXTERNAL_CALL_INITIATED' &&
        e.event.idempotencyKey === key,
    );
  }

  /** Get the result of a completed external call by idempotency key. */
  getCallResult(
    key: string,
  ): ExternalCallCompleted | undefined {
    for (let i = this.events.length - 1; i >= 0; i--) {
      const ev = this.events[i].event;
      if (ev.type === 'EXTERNAL_CALL_COMPLETED' && ev.idempotencyKey === key) {
        return ev;
      }
    }
    return undefined;
  }

  /** Get all events of a given type. */
  ofType<T extends BridgeEvent['type']>(
    type: T,
  ): Extract<BridgeEvent, { type: T }>[] {
    return this.events
      .filter((e) => e.event.type === type)
      .map((e) => e.event as Extract<BridgeEvent, { type: T }>);
  }

  /** Path to the backing file. */
  get path(): string {
    return this.logPath;
  }

  /** Total event count. */
  get length(): number {
    return this.events.length;
  }
}

// --- Idempotency helper ---

/** Generate a deterministic idempotency key from adapter + command + args. */
export function idempotencyKey(
  adapter: string,
  command: string,
  args?: Record<string, unknown>,
): string {
  const payload = JSON.stringify({ adapter, command, args: args ?? {} });
  return crypto.createHash('sha256').update(payload).digest('hex').slice(0, 16);
}
