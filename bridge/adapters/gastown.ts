/**
 * Gas Town adapter — gt CLI integration + event tailing.
 *
 * All gt CLI calls use Bun.spawn with array args (no shell interpolation).
 * JSON-only parsing: commands that support --json get parsed output;
 * if JSON parsing fails, the call fails (fail closed).
 *
 * Event tailing watches events.jsonl with:
 *   - Byte offset tracking (resume from last position)
 *   - Inode change detection (file rotation/replacement)
 *   - Truncation handling (reset offset if file shrinks)
 */

import * as fs from 'fs';
import * as path from 'path';
import type { Adapter } from '../orchestrate.js';

// --- Types ---

export interface GtResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface GtJsonResult<T = unknown> {
  data: T;
  raw: string;
}

/** Parsed event from events.jsonl. */
export interface TailedEvent {
  [key: string]: unknown;
}

/** Tail state persisted between reads. */
export interface TailState {
  offset: number;
  inode: number;
}

// --- Commands that support --json output ---

const JSON_COMMANDS = new Set([
  'hook',
  'mol',
  'mail',
  'status',
  'peek',
  'dolt',
  'convoy',
]);

// --- gt CLI executor ---

/**
 * Execute a gt CLI command using Bun.spawn with array args.
 * No shell — args are passed directly to the process.
 */
export async function gtExec(
  args: string[],
  opts?: { cwd?: string; timeout?: number },
): Promise<GtResult> {
  const proc = Bun.spawn(['gt', ...args], {
    cwd: opts?.cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env },
  });

  const timeout = opts?.timeout ?? 30_000;
  const timer = setTimeout(() => proc.kill(), timeout);

  try {
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;

    return { stdout: stdout.trimEnd(), stderr: stderr.trimEnd(), exitCode };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Execute a gt command expecting JSON output.
 * Appends --json to the args and parses the result.
 * Fails closed: if JSON parsing fails, throws (never returns unparsed text).
 */
export async function gtJson<T = unknown>(
  args: string[],
  opts?: { cwd?: string; timeout?: number },
): Promise<GtJsonResult<T>> {
  const result = await gtExec([...args, '--json'], opts);

  if (result.exitCode !== 0) {
    throw new GtError(
      `gt ${args[0]} failed (exit ${result.exitCode})`,
      args,
      result,
    );
  }

  try {
    const data = JSON.parse(result.stdout) as T;
    return { data, raw: result.stdout };
  } catch {
    throw new GtError(
      `gt ${args[0]} --json returned non-JSON output`,
      [...args, '--json'],
      result,
    );
  }
}

// --- Error type ---

export class GtError extends Error {
  readonly args: string[];
  readonly result: GtResult;

  constructor(message: string, args: string[], result: GtResult) {
    super(message);
    this.name = 'GtError';
    this.args = args;
    this.result = result;
  }
}

// --- Event tailer ---

/**
 * Tail events.jsonl with offset tracking, inode detection, and truncation handling.
 *
 * Usage:
 *   const tailer = new EventTailer('/path/to/events.jsonl');
 *   const newEvents = tailer.poll();  // returns new events since last poll
 *   const state = tailer.state;       // persist this for crash recovery
 *   tailer.restore(state);            // resume from saved state
 */
export class EventTailer {
  private filePath: string;
  private offset: number = 0;
  private inode: number = 0;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  /** Poll for new events since last read. Returns parsed JSON objects. */
  poll(): TailedEvent[] {
    if (!fs.existsSync(this.filePath)) {
      return [];
    }

    const stat = fs.statSync(this.filePath);
    const currentInode = stat.ino;

    // Inode changed → file was replaced (rotation, new file)
    if (this.inode !== 0 && currentInode !== this.inode) {
      this.offset = 0;
    }
    this.inode = currentInode;

    // File truncated → reset to beginning
    if (stat.size < this.offset) {
      this.offset = 0;
    }

    // Nothing new
    if (stat.size === this.offset) {
      return [];
    }

    // Read new bytes from offset
    const fd = fs.openSync(this.filePath, 'r');
    try {
      const buf = Buffer.alloc(stat.size - this.offset);
      fs.readSync(fd, buf, 0, buf.length, this.offset);
      this.offset = stat.size;

      const chunk = buf.toString('utf-8');
      return this.parseLines(chunk);
    } finally {
      fs.closeSync(fd);
    }
  }

  /** Parse JSONL lines, skipping malformed ones (fail closed per line). */
  private parseLines(chunk: string): TailedEvent[] {
    const events: TailedEvent[] = [];
    const lines = chunk.split('\n');

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const parsed = JSON.parse(trimmed);
        if (typeof parsed === 'object' && parsed !== null) {
          events.push(parsed as TailedEvent);
        }
      } catch {
        // Malformed line — skip but don't stop tailing.
        // This handles partial writes (line not yet fully flushed).
      }
    }

    return events;
  }

  /** Current tail state (for persistence across sessions). */
  get state(): TailState {
    return { offset: this.offset, inode: this.inode };
  }

  /** Restore from a previously saved state. */
  restore(saved: TailState): void {
    this.offset = saved.offset;
    this.inode = saved.inode;
  }

  /** Reset to beginning of file. */
  reset(): void {
    this.offset = 0;
    this.inode = 0;
  }

  /** The file being tailed. */
  get path(): string {
    return this.filePath;
  }
}

// --- Adapter implementation ---

/**
 * Gas Town adapter for the bridge orchestrator.
 *
 * Commands routed through execute():
 *   - hook          → gt hook --json
 *   - mol.status    → gt mol status --json
 *   - mail.inbox    → gt mail inbox --json
 *   - mail.send     → gt mail send <target> -s <subject> -m <body>
 *   - done          → gt done [--pre-verified] [--target <branch>]
 *   - prime         → gt prime
 *   - escalate      → gt escalate <desc> -s <severity>
 *   - nudge         → gt nudge <target> <message>
 *   - sling         → gt sling <beadId> <rig> [--merge <strategy>] [--review-only] [--agent <agent>]
 *   - sling.batch   → gt sling <id1> <id2> ... <rig> [--max-concurrent N] [--merge <strategy>]
 *   - tail.poll     → poll events.jsonl for new events
 *   - tail.state    → return current tail state
 *   - tail.restore  → restore tail state from args
 *   - raw           → pass-through for arbitrary gt subcommands
 */
export class GasTownAdapter implements Adapter {
  readonly name = 'gastown';
  private cwd: string;
  private tailer: EventTailer | null = null;
  private timeout: number;

  constructor(opts: {
    cwd: string;
    eventsPath?: string;
    timeout?: number;
  }) {
    this.cwd = opts.cwd;
    this.timeout = opts.timeout ?? 30_000;

    if (opts.eventsPath) {
      this.tailer = new EventTailer(opts.eventsPath);
    }
  }

  /** Initialize the event tailer (can be set after construction). */
  initTailer(eventsPath: string, savedState?: TailState): void {
    this.tailer = new EventTailer(eventsPath);
    if (savedState) {
      this.tailer.restore(savedState);
    }
  }

  async execute(
    command: string,
    args?: Record<string, unknown>,
  ): Promise<string> {
    switch (command) {
      case 'hook':
        return this.jsonCommand(['hook']);

      case 'mol.status':
        return this.jsonCommand(['mol', 'status']);

      case 'mail.inbox':
        return this.jsonCommand(['mail', 'inbox']);

      case 'mail.send':
        return this.textCommand([
          'mail', 'send',
          String(args?.target ?? ''),
          '-s', String(args?.subject ?? ''),
          '-m', String(args?.body ?? ''),
        ]);

      case 'done': {
        const doneArgs = ['done'];
        if (args?.preVerified) doneArgs.push('--pre-verified');
        if (args?.target) doneArgs.push('--target', String(args.target));
        if (args?.cleanupStatus) doneArgs.push('--cleanup-status', String(args.cleanupStatus));
        if (args?.status) doneArgs.push('--status', String(args.status));
        return this.textCommand(doneArgs);
      }

      case 'prime':
        return this.textCommand(['prime']);

      case 'escalate': {
        const escArgs = ['escalate', String(args?.description ?? '')];
        if (args?.severity) escArgs.push('-s', String(args.severity));
        if (args?.message) escArgs.push('-m', String(args.message));
        return this.textCommand(escArgs);
      }

      case 'nudge':
        return this.textCommand([
          'nudge',
          String(args?.target ?? ''),
          String(args?.message ?? ''),
        ]);

      case 'sling': {
        const slingArgs = ['sling', String(args?.beadId ?? ''), String(args?.rig ?? '')];
        if (args?.merge) slingArgs.push('--merge', String(args.merge));
        if (args?.reviewOnly) slingArgs.push('--review-only');
        if (args?.agent) slingArgs.push('--agent', String(args.agent));
        if (args?.formula) slingArgs.push('--formula', String(args.formula));
        if (args?.formulaArgs) slingArgs.push('--args', String(args.formulaArgs));
        return this.textCommand(slingArgs);
      }

      case 'sling.batch': {
        const beadIds = args?.beadIds;
        if (!Array.isArray(beadIds) || beadIds.length === 0) {
          throw new Error('sling.batch requires args.beadIds as non-empty string[]');
        }
        const batchArgs = ['sling', ...beadIds.map(String), String(args?.rig ?? '')];
        if (args?.maxConcurrent) batchArgs.push('--max-concurrent', String(args.maxConcurrent));
        if (args?.merge) batchArgs.push('--merge', String(args.merge));
        if (args?.reviewOnly) batchArgs.push('--review-only');
        if (args?.agent) batchArgs.push('--agent', String(args.agent));
        if (args?.formula) batchArgs.push('--formula', String(args.formula));
        if (args?.formulaArgs) batchArgs.push('--args', String(args.formulaArgs));
        return this.textCommand(batchArgs);
      }

      case 'convoy.stranded':
        return this.jsonCommand(['convoy', 'stranded']);

      case 'tail.poll':
        return this.pollEvents();

      case 'tail.state':
        return this.getTailState();

      case 'tail.restore': {
        const state = args as unknown as TailState | undefined;
        if (state && typeof state.offset === 'number' && typeof state.inode === 'number') {
          this.tailer?.restore(state);
        }
        return JSON.stringify({ restored: true });
      }

      case 'raw': {
        const rawArgs = args?.args;
        if (!Array.isArray(rawArgs)) {
          throw new Error('raw command requires args.args as string[]');
        }
        const useJson = args?.json === true && JSON_COMMANDS.has(String(rawArgs[0]));
        if (useJson) {
          return this.jsonCommand(rawArgs as string[]);
        }
        return this.textCommand(rawArgs as string[]);
      }

      default:
        throw new Error(`Unknown gastown command: ${command}`);
    }
  }

  // --- Internal helpers ---

  /** Run a gt command expecting JSON. Fail closed on parse failure. */
  private async jsonCommand(args: string[]): Promise<string> {
    const { data, raw } = await gtJson(args, {
      cwd: this.cwd,
      timeout: this.timeout,
    });
    return raw;
  }

  /** Run a gt command returning text output. */
  private async textCommand(args: string[]): Promise<string> {
    const result = await gtExec(args, {
      cwd: this.cwd,
      timeout: this.timeout,
    });

    if (result.exitCode !== 0) {
      throw new GtError(
        `gt ${args[0]} failed (exit ${result.exitCode})`,
        args,
        result,
      );
    }

    return result.stdout;
  }

  /** Poll for new events via the tailer. */
  private pollEvents(): string {
    if (!this.tailer) {
      throw new Error('Event tailer not initialized. Call initTailer() first.');
    }
    const events = this.tailer.poll();
    return JSON.stringify({ events, count: events.length });
  }

  /** Return the current tail state as JSON. */
  private getTailState(): string {
    if (!this.tailer) {
      throw new Error('Event tailer not initialized. Call initTailer() first.');
    }
    return JSON.stringify(this.tailer.state);
  }
}
