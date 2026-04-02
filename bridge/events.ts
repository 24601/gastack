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

export const STAGES = ['PLAN', 'EXECUTE', 'REVIEW', 'REFINE', 'DEPLOY', 'VERIFY', 'DONE'] as const;
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
  | SessionCompleted
  // B2 events (14-17)
  | CheckpointSaved
  | RateLimitDetected
  | ScopeExpansionRequested
  | SpecialistGatingUpdated;

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

// 14. Checkpoint saved (crash recovery)
export interface CheckpointSaved {
  type: 'CHECKPOINT_SAVED';
  checkpointId: string;
  stage: Stage;
}

// 15. Rate limit detected (from watchdog plugin)
export interface RateLimitDetected {
  type: 'RATE_LIMIT_DETECTED';
  source: string;
  action: 'halt';
}

// 16. Scope expansion requested by polecat
export interface ScopeExpansionRequested {
  type: 'SCOPE_EXPANSION_REQUESTED';
  beadId: string;
  description: string;
}

// 17. Specialist gating state updated
export interface SpecialistGatingUpdated {
  type: 'SPECIALIST_GATING_UPDATED';
  gatingState: Record<string, { runs: number; gated: boolean }>;
}

// --- Event envelope ---

export interface EventEnvelope {
  id: string;
  timestamp: string;
  event: BridgeEvent;
}

// --- Corruption diagnosis ---

export type CorruptionKind = 'truncation' | 'garbage';

export interface CorruptionDiagnostic {
  line: string;
  lineNumber: number;
  byteOffset: number;
  kind: CorruptionKind;
  repaired: boolean;
  detail: string;
}

/** Result from EventLog.load() — envelopes plus any corruption diagnostics. */
export interface LoadResult {
  envelopes: EventEnvelope[];
  diagnostics: CorruptionDiagnostic[];
}

/**
 * Check if a line looks like truncated JSON (vs garbage/binary data).
 * Truncated JSON starts with valid JSON structure but is incomplete.
 */
function isTruncationPattern(line: string): boolean {
  // Must start like JSON (object opening)
  if (!line.trimStart().startsWith('{')) return false;
  // Check that the first ~20 chars are printable ASCII/UTF-8 (not binary garbage)
  const sample = line.slice(0, Math.min(line.length, 40));
  // eslint-disable-next-line no-control-regex
  return !/[\x00-\x08\x0e-\x1f]/.test(sample);
}

/**
 * Attempt heuristic repair of truncated JSON.
 * Handles common truncation patterns: missing closing braces, brackets, quotes.
 * Returns the repaired string or null if repair failed.
 */
function attemptJsonRepair(line: string): string | null {
  let s = line.trim();
  if (!s.startsWith('{')) return null;

  // Track open structural characters
  let inString = false;
  let escaped = false;
  const stack: string[] = [];

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (ch === '\\' && inString) {
      escaped = true;
      continue;
    }

    if (ch === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (ch === '{') stack.push('}');
    else if (ch === '[') stack.push(']');
    else if (ch === '}' || ch === ']') {
      if (stack.length > 0 && stack[stack.length - 1] === ch) {
        stack.pop();
      }
    }
  }

  // If we ended inside a string, close it
  if (inString) {
    s += '"';
  }

  // If the line ends with a key or value separator, add a null placeholder
  const trimEnd = s.replace(/\s+$/, '');
  if (trimEnd.endsWith(':') || trimEnd.endsWith(',')) {
    s = trimEnd + 'null';
  }

  // Close any remaining open braces/brackets in reverse order
  while (stack.length > 0) {
    s += stack.pop();
  }

  // Verify the repair actually produces valid JSON
  try {
    JSON.parse(s);
    return s;
  } catch {
    return null;
  }
}

/**
 * Validate that a parsed object has the required EventEnvelope fields.
 */
function isValidEnvelope(obj: unknown): obj is EventEnvelope {
  if (typeof obj !== 'object' || obj === null) return false;
  const o = obj as Record<string, unknown>;
  if (typeof o.id !== 'string') return false;
  if (typeof o.timestamp !== 'string') return false;
  if (typeof o.event !== 'object' || o.event === null) return false;
  const ev = o.event as Record<string, unknown>;
  if (typeof ev.type !== 'string') return false;
  return true;
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

  /**
   * Load all events from disk. Used for replay on restart.
   *
   * Attempts JSON repair on malformed lines before skipping them.
   * Diagnoses corruption type (truncation vs garbage) and records
   * diagnostics for each corrupted line.
   */
  static load(logPath: string): EventEnvelope[];
  static load(logPath: string, opts: { diagnostics: true }): LoadResult;
  static load(logPath: string, opts?: { diagnostics: true }): EventEnvelope[] | LoadResult {
    if (!fs.existsSync(logPath)) {
      return opts?.diagnostics ? { envelopes: [], diagnostics: [] } : [];
    }
    const content = fs.readFileSync(logPath, 'utf-8');
    const lines = content.split('\n').filter(Boolean);
    const envelopes: EventEnvelope[] = [];
    const diagnostics: CorruptionDiagnostic[] = [];

    let byteOffset = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      try {
        const parsed = JSON.parse(line);
        if (isValidEnvelope(parsed)) {
          envelopes.push(parsed);
        } else {
          // Valid JSON but not a valid envelope — treat as corruption
          const diag: CorruptionDiagnostic = {
            line,
            lineNumber: i + 1,
            byteOffset,
            kind: 'garbage',
            repaired: false,
            detail: 'Valid JSON but missing required EventEnvelope fields (id, timestamp, event.type)',
          };
          diagnostics.push(diag);
          if (process.env.NODE_ENV !== 'test') {
            console.warn(
              `WARNING: Corrupted event at line ${i + 1}, offset ${byteOffset}: ${diag.detail}`,
            );
          }
        }
      } catch {
        // JSON parse failed — attempt repair
        const kind: CorruptionKind = isTruncationPattern(line) ? 'truncation' : 'garbage';

        if (kind === 'truncation') {
          const repaired = attemptJsonRepair(line);
          if (repaired) {
            const parsed = JSON.parse(repaired);
            if (isValidEnvelope(parsed)) {
              envelopes.push(parsed);
              const diag: CorruptionDiagnostic = {
                line,
                lineNumber: i + 1,
                byteOffset,
                kind,
                repaired: true,
                detail: 'Truncated JSON repaired (likely process kill mid-write)',
              };
              diagnostics.push(diag);
              if (process.env.NODE_ENV !== 'test') {
                console.warn(
                  `WARNING: Repaired truncated event at line ${i + 1}, offset ${byteOffset}`,
                );
              }
              byteOffset += Buffer.byteLength(line, 'utf-8') + 1;
              continue;
            }
          }
        }

        // Unrecoverable — skip with diagnostic
        const isGarbage = kind === 'garbage';
        const diag: CorruptionDiagnostic = {
          line,
          lineNumber: i + 1,
          byteOffset,
          kind,
          repaired: false,
          detail: isGarbage
            ? 'Non-JSON data (possible concurrent writer or disk issue — investigate lock file)'
            : 'Truncated JSON repair failed (data loss — missing closing structures unrecoverable)',
        };
        diagnostics.push(diag);
        if (process.env.NODE_ENV !== 'test') {
          console.warn(
            `WARNING: Skipped ${isGarbage ? 'garbage' : 'unrecoverable truncated'} event at line ${i + 1}, offset ${byteOffset}: ${diag.detail}`,
          );
        }
      }
      byteOffset += Buffer.byteLength(line, 'utf-8') + 1; // +1 for newline
    }

    return opts?.diagnostics ? { envelopes, diagnostics } : envelopes;
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
