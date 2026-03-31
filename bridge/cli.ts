/**
 * Bridge CLI — start, status, watch, approve, reject, list commands.
 *
 * Entry points for the bridge daemon. Each command operates on a session
 * identified by a run ID (the session UUID). Sessions are stored as
 * event log files (JSONL) in the log directory.
 *
 * Signal scoping: approve/reject target a specific approval within a
 * session using runId + stage + reviewCycle (the Nth approval in that stage).
 */

import * as fs from 'fs';
import * as path from 'path';
import { EventLog, type EventEnvelope, type Stage, STAGES } from './events.js';
import { Orchestrator, type OrchestratorOptions } from './orchestrate.js';
import {
  diagnoseStranded,
  formatDiagnoses,
  type StrandedConvoy,
  type StrandedDiagnosis,
} from './stranded.js';
import type { QualityReport } from './quality.js';

// --- Types ---

export interface CliContext {
  /** Directory for event log storage. */
  logDir: string;
  /** Project directory being orchestrated. */
  projectDir: string;
  /** Output function (default: console.log). */
  out?: (msg: string) => void;
  /** Error output function (default: console.error). */
  err?: (msg: string) => void;
}

export interface StartResult {
  sessionId: string;
  resumed: boolean;
  stage: string | null;
}

export interface StatusResult {
  sessionId: string;
  stage: string | null;
  done: boolean;
  tasks: { total: number; completed: number; failed: number; running: number };
  pendingApproval: {
    approvalId: string;
    stage: string;
    description: string;
  } | null;
  eventCount: number;
}

export interface ListEntry {
  sessionId: string;
  logFile: string;
  stage: string | null;
  done: boolean;
  eventCount: number;
  createdAt: string | null;
}

export interface WatchOptions {
  /** Poll interval in ms (default: 500). */
  interval?: number;
  /** Stop after this many ms (0 = indefinite, default: 0). */
  timeout?: number;
  /** Callback for each new event. If not set, events are printed as JSON. */
  onEvent?: (envelope: EventEnvelope) => void;
  /** AbortSignal for cancellation. */
  signal?: AbortSignal;
}

export interface ApprovalSignal {
  /** Session run ID. */
  runId: string;
  /** Stage the approval belongs to (scoping). */
  stage: Stage;
  /** Review cycle — the Nth approval request in this stage (1-based). */
  reviewCycle: number;
  /** Reason for the decision. */
  reason?: string;
}

export interface StrandedResult {
  diagnoses: StrandedDiagnosis[];
}

// --- Helpers ---

/** Resolve a session log path from runId. */
function sessionLogPath(logDir: string, runId: string): string {
  return path.join(logDir, `${runId}.jsonl`);
}

/** Find all session log files in the log directory. */
function findSessionLogs(logDir: string): string[] {
  if (!fs.existsSync(logDir)) return [];
  return fs.readdirSync(logDir)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => path.join(logDir, f));
}

/**
 * Find the pending approval matching stage + reviewCycle.
 * reviewCycle is 1-based: cycle 1 = first approval in that stage.
 */
function findScopedApproval(
  log: EventLog,
  stage: Stage,
  reviewCycle: number,
): { approvalId: string; stage: Stage; description: string } | null {
  const requests = log.ofType('APPROVAL_REQUESTED').filter((r) => r.stage === stage);
  const decisions = new Set(log.ofType('APPROVAL_DECISION').map((d) => d.approvalId));

  // reviewCycle is 1-based index into stage-scoped requests
  if (reviewCycle < 1 || reviewCycle > requests.length) return null;

  const target = requests[reviewCycle - 1];
  // Must be undecided
  if (decisions.has(target.approvalId)) return null;

  return {
    approvalId: target.approvalId,
    stage: target.stage,
    description: target.description,
  };
}

// --- Commands ---

/**
 * Start a new session or resume an existing one.
 *
 * If runId is provided and the log exists, resumes. Otherwise creates new.
 */
export function start(
  ctx: CliContext,
  opts?: { runId?: string; config?: Record<string, unknown> },
): StartResult {
  const { logDir, projectDir } = ctx;

  // Resume existing session
  if (opts?.runId) {
    const logPath = sessionLogPath(logDir, opts.runId);
    if (fs.existsSync(logPath)) {
      const orch = Orchestrator.resume(logPath);
      return {
        sessionId: orch.id,
        resumed: true,
        stage: orch.status().stage,
      };
    }
  }

  // Create new session
  const orch = Orchestrator.create({
    logDir,
    projectDir,
    config: opts?.config,
  });

  return {
    sessionId: orch.id,
    resumed: false,
    stage: orch.status().stage,
  };
}

/**
 * Get status of a session.
 */
export function status(ctx: CliContext, runId: string): StatusResult {
  const logPath = sessionLogPath(ctx.logDir, runId);
  if (!fs.existsSync(logPath)) {
    throw new CliError(`Session not found: ${runId}`);
  }

  const orch = Orchestrator.resume(logPath);
  const s = orch.status();
  const pending = orch.pendingApproval();

  return {
    sessionId: s.sessionId,
    stage: s.stage,
    done: s.done,
    tasks: s.tasks,
    pendingApproval: pending,
    eventCount: s.eventCount,
  };
}

/**
 * List all sessions in the log directory.
 */
export function list(ctx: CliContext): ListEntry[] {
  const logs = findSessionLogs(ctx.logDir);
  const entries: ListEntry[] = [];

  for (const logPath of logs) {
    try {
      const envelopes = EventLog.load(logPath);
      if (envelopes.length === 0) continue;

      const log = EventLog.replay(logPath);
      const created = log.latest('SESSION_CREATED');
      const sessionId = created?.sessionId ?? path.basename(logPath, '.jsonl');

      // Derive stage from events
      const orch = Orchestrator.resume(logPath);
      const s = orch.status();

      entries.push({
        sessionId,
        logFile: path.basename(logPath),
        stage: s.stage,
        done: s.done,
        eventCount: s.eventCount,
        createdAt: envelopes[0].timestamp,
      });
    } catch {
      // Skip malformed logs
    }
  }

  // Sort by creation time, newest first
  entries.sort((a, b) => {
    if (!a.createdAt || !b.createdAt) return 0;
    return b.createdAt.localeCompare(a.createdAt);
  });

  return entries;
}

/**
 * Watch a session's event log for new events (live tail).
 *
 * Polls the JSONL file for new lines and emits them. Returns a promise
 * that resolves when the session completes, the timeout fires, or the
 * signal is aborted.
 */
export async function watch(
  ctx: CliContext,
  runId: string,
  opts?: WatchOptions,
): Promise<{ eventsEmitted: number; reason: 'done' | 'timeout' | 'aborted' }> {
  const logPath = sessionLogPath(ctx.logDir, runId);
  if (!fs.existsSync(logPath)) {
    throw new CliError(`Session not found: ${runId}`);
  }

  const interval = opts?.interval ?? 500;
  const timeout = opts?.timeout ?? 0;
  const out = ctx.out ?? console.log;
  const onEvent = opts?.onEvent ?? ((env: EventEnvelope) => {
    out(JSON.stringify(env));
  });

  let offset = 0;
  let eventsEmitted = 0;
  const startTime = Date.now();

  const poll = (): EventEnvelope[] => {
    if (!fs.existsSync(logPath)) return [];

    const stat = fs.statSync(logPath);
    if (stat.size <= offset) return [];

    const fd = fs.openSync(logPath, 'r');
    try {
      const buf = Buffer.alloc(stat.size - offset);
      fs.readSync(fd, buf, 0, buf.length, offset);
      offset = stat.size;

      const chunk = buf.toString('utf-8');
      const envelopes: EventEnvelope[] = [];
      for (const line of chunk.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          envelopes.push(JSON.parse(trimmed) as EventEnvelope);
        } catch {
          // Partial write — skip
        }
      }
      return envelopes;
    } finally {
      fs.closeSync(fd);
    }
  };

  return new Promise((resolve) => {
    const check = () => {
      if (opts?.signal?.aborted) {
        resolve({ eventsEmitted, reason: 'aborted' });
        return;
      }

      if (timeout > 0 && Date.now() - startTime >= timeout) {
        resolve({ eventsEmitted, reason: 'timeout' });
        return;
      }

      const newEvents = poll();
      for (const env of newEvents) {
        onEvent(env);
        eventsEmitted++;

        // Stop when session completes
        if (env.event.type === 'SESSION_COMPLETED') {
          resolve({ eventsEmitted, reason: 'done' });
          return;
        }
      }

      setTimeout(check, interval);
    };

    // Emit all existing events first, then poll for new
    check();
  });
}

/**
 * Approve a pending approval in a session.
 *
 * Signal scoping: targets the approval at (runId, stage, reviewCycle).
 * reviewCycle is 1-based: the first approval request in the stage is cycle 1.
 */
export function approve(ctx: CliContext, signal: ApprovalSignal): { approvalId: string } {
  const logPath = sessionLogPath(ctx.logDir, signal.runId);
  if (!fs.existsSync(logPath)) {
    throw new CliError(`Session not found: ${signal.runId}`);
  }

  const orch = Orchestrator.resume(logPath);
  const log = orch.eventLog;

  const target = findScopedApproval(log, signal.stage, signal.reviewCycle);
  if (!target) {
    throw new CliError(
      `No pending approval at stage=${signal.stage} cycle=${signal.reviewCycle}` +
        ` in session ${signal.runId}`,
    );
  }

  orch.recordApproval(target.approvalId, true, signal.reason);
  return { approvalId: target.approvalId };
}

/**
 * Reject a pending approval in a session.
 *
 * Same signal scoping as approve.
 */
export function reject(ctx: CliContext, signal: ApprovalSignal): { approvalId: string } {
  const logPath = sessionLogPath(ctx.logDir, signal.runId);
  if (!fs.existsSync(logPath)) {
    throw new CliError(`Session not found: ${signal.runId}`);
  }

  const orch = Orchestrator.resume(logPath);
  const log = orch.eventLog;

  const target = findScopedApproval(log, signal.stage, signal.reviewCycle);
  if (!target) {
    throw new CliError(
      `No pending approval at stage=${signal.stage} cycle=${signal.reviewCycle}` +
        ` in session ${signal.runId}`,
    );
  }

  orch.recordApproval(target.approvalId, false, signal.reason);
  return { approvalId: target.approvalId };
}

/**
 * Diagnose stranded convoys with quality context.
 *
 * Accepts raw convoy data and an optional quality cache. When called from the
 * CLI, convoy data comes from `gt convoy stranded --json` and the quality
 * cache comes from session event logs (quality evaluation results).
 */
export function stranded(
  convoys: StrandedConvoy[],
  qualityCache?: Map<string, QualityReport>,
): StrandedResult {
  const cache = qualityCache ?? new Map();
  const diagnoses = diagnoseStranded(convoys, cache);
  return { diagnoses };
}

/**
 * Build a quality cache from a session's event log.
 *
 * Scans EXTERNAL_CALL_COMPLETED events for quality evaluation results and
 * maps issue IDs to their QualityReport. Used by the stranded command to
 * join convoy data with quality context.
 */
export function buildQualityCacheFromLog(
  logDir: string,
): Map<string, QualityReport> {
  const cache = new Map<string, QualityReport>();

  const logs = findSessionLogs(logDir);
  for (const logPath of logs) {
    try {
      const log = EventLog.replay(logPath);
      const calls = log.ofType('EXTERNAL_CALL_COMPLETED');
      for (const call of calls) {
        if (!call.success || !call.result) continue;
        try {
          const parsed = JSON.parse(call.result);
          // Quality evaluation results have an 'overall' verdict and 'gates' array
          if (parsed.overall && Array.isArray(parsed.gates)) {
            // Extract issue ID from the idempotency key or use callId as fallback
            const issueId = call.idempotencyKey ?? call.callId;
            cache.set(issueId, parsed as QualityReport);
          }
        } catch {
          // Not JSON or not a quality report — skip
        }
      }
    } catch {
      // Malformed log — skip
    }
  }

  return cache;
}

// --- CLI argument parser ---

export interface ParsedArgs {
  command: string;
  flags: Record<string, string>;
  positional: string[];
}

/** Minimal arg parser for bridge CLI. No dependencies. */
export function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2); // skip bun/node + script path
  const command = args[0] ?? '';
  const flags: Record<string, string> = {};
  const positional: string[] = [];

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const eqIdx = arg.indexOf('=');
      if (eqIdx > 0) {
        flags[arg.slice(2, eqIdx)] = arg.slice(eqIdx + 1);
      } else {
        // Next arg is the value, unless it's another flag or missing
        const next = args[i + 1];
        if (next && !next.startsWith('--')) {
          flags[arg.slice(2)] = next;
          i++;
        } else {
          flags[arg.slice(2)] = 'true';
        }
      }
    } else {
      positional.push(arg);
    }
  }

  return { command, flags, positional };
}

// --- Error type ---

export class CliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliError';
  }
}

// --- Main entry point ---

const USAGE = `bridge — orchestration daemon CLI

Commands:
  start [--run-id ID] [--config JSON]   Start new session or resume existing
  status <run-id>                        Show session status
  list                                   List all sessions
  watch <run-id> [--timeout MS]          Live event stream
  stranded [--convoy-data JSON]          Diagnose stranded convoys with quality context
  approve <run-id> --stage STAGE --cycle N [--reason TEXT]
                                         Approve pending gate
  reject <run-id> --stage STAGE --cycle N [--reason TEXT]
                                         Reject pending gate

Options:
  --log-dir DIR       Event log directory (default: .bridge/logs)
  --project-dir DIR   Project directory (default: cwd)
  --json              Output as JSON
`;

export async function main(argv: string[]): Promise<void> {
  const parsed = parseArgs(argv);

  if (!parsed.command || parsed.command === 'help' || parsed.flags['help']) {
    console.log(USAGE);
    return;
  }

  const logDir = parsed.flags['log-dir'] ?? path.join(process.cwd(), '.bridge', 'logs');
  const projectDir = parsed.flags['project-dir'] ?? process.cwd();
  const json = parsed.flags['json'] === 'true';

  const out = (msg: string) => console.log(msg);
  const err = (msg: string) => console.error(msg);
  const ctx: CliContext = { logDir, projectDir, out, err };

  try {
    switch (parsed.command) {
      case 'start': {
        const result = start(ctx, {
          runId: parsed.flags['run-id'],
          config: parsed.flags['config'] ? JSON.parse(parsed.flags['config']) : undefined,
        });
        if (json) {
          out(JSON.stringify(result));
        } else {
          out(result.resumed
            ? `Resumed session ${result.sessionId} at stage ${result.stage ?? '(none)'}`
            : `Started session ${result.sessionId}`);
        }
        break;
      }

      case 'status': {
        const runId = parsed.positional[0];
        if (!runId) {
          err('Usage: bridge status <run-id>');
          process.exit(1);
        }
        const result = status(ctx, runId);
        if (json) {
          out(JSON.stringify(result));
        } else {
          out(`Session: ${result.sessionId}`);
          out(`Stage:   ${result.stage ?? '(completed)'}`);
          out(`Done:    ${result.done}`);
          out(`Tasks:   ${result.tasks.completed}/${result.tasks.total} complete` +
            (result.tasks.failed ? `, ${result.tasks.failed} failed` : '') +
            (result.tasks.running ? `, ${result.tasks.running} running` : ''));
          out(`Events:  ${result.eventCount}`);
          if (result.pendingApproval) {
            out(`Pending: ${result.pendingApproval.description} (${result.pendingApproval.approvalId})`);
          }
        }
        break;
      }

      case 'list': {
        const entries = list(ctx);
        if (json) {
          out(JSON.stringify(entries));
        } else if (entries.length === 0) {
          out('No sessions found.');
        } else {
          for (const e of entries) {
            const stageStr = e.done ? 'DONE' : (e.stage ?? '???');
            out(`${e.sessionId}  ${stageStr.padEnd(8)}  ${e.eventCount} events  ${e.createdAt ?? ''}`);
          }
        }
        break;
      }

      case 'watch': {
        const runId = parsed.positional[0];
        if (!runId) {
          err('Usage: bridge watch <run-id>');
          process.exit(1);
        }
        const timeout = parsed.flags['timeout'] ? parseInt(parsed.flags['timeout'], 10) : 0;
        const result = await watch(ctx, runId, { timeout });
        if (!json) {
          out(`\nWatch ended: ${result.reason} (${result.eventsEmitted} events)`);
        }
        break;
      }

      case 'stranded': {
        const convoyData = parsed.flags['convoy-data'];
        let convoys: StrandedConvoy[] = [];
        if (convoyData) {
          convoys = JSON.parse(convoyData) as StrandedConvoy[];
        }
        const qualityCache = buildQualityCacheFromLog(logDir);
        const result = stranded(convoys, qualityCache);
        if (json) {
          out(JSON.stringify(result));
        } else if (result.diagnoses.length === 0) {
          out('No stranded convoys.');
        } else {
          out(formatDiagnoses(result.diagnoses));
        }
        break;
      }

      case 'approve':
      case 'reject': {
        const runId = parsed.positional[0];
        const stage = parsed.flags['stage'] as Stage;
        const cycle = parseInt(parsed.flags['cycle'] ?? '0', 10);
        const reason = parsed.flags['reason'];

        if (!runId || !stage || !cycle) {
          err(`Usage: bridge ${parsed.command} <run-id> --stage STAGE --cycle N [--reason TEXT]`);
          process.exit(1);
        }

        if (!STAGES.includes(stage)) {
          err(`Invalid stage: ${stage}. Valid: ${STAGES.join(', ')}`);
          process.exit(1);
        }

        const signal: ApprovalSignal = { runId, stage, reviewCycle: cycle, reason };
        const fn = parsed.command === 'approve' ? approve : reject;
        const result = fn(ctx, signal);

        if (json) {
          out(JSON.stringify(result));
        } else {
          out(`${parsed.command === 'approve' ? 'Approved' : 'Rejected'}: ${result.approvalId}`);
        }
        break;
      }

      default:
        err(`Unknown command: ${parsed.command}`);
        console.log(USAGE);
        process.exit(1);
    }
  } catch (error) {
    if (error instanceof CliError) {
      err(`Error: ${error.message}`);
      process.exit(1);
    }
    throw error;
  }
}

// Run if executed directly
if (import.meta.main) {
  main(process.argv).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
