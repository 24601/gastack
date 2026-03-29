import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  start,
  status,
  list,
  watch,
  approve,
  reject,
  parseArgs,
  CliError,
  type CliContext,
  type ApprovalSignal,
} from './cli.ts';
import { Orchestrator } from './orchestrate.ts';
import { EventLog } from './events.ts';

let tmpDir: string;
let logDir: string;
let ctx: CliContext;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-cli-test-'));
  logDir = path.join(tmpDir, 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  ctx = { logDir, projectDir: tmpDir };
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// --- parseArgs ---

describe('parseArgs', () => {
  test('parses command and positional args', () => {
    const result = parseArgs(['bun', 'cli.ts', 'status', 'abc-123']);
    expect(result.command).toBe('status');
    expect(result.positional).toEqual(['abc-123']);
  });

  test('parses --flag value pairs', () => {
    const result = parseArgs(['bun', 'cli.ts', 'start', '--run-id', 'xyz']);
    expect(result.flags['run-id']).toBe('xyz');
  });

  test('parses --flag=value syntax', () => {
    const result = parseArgs(['bun', 'cli.ts', 'watch', '--timeout=5000']);
    expect(result.flags['timeout']).toBe('5000');
  });

  test('boolean flags (no value)', () => {
    const result = parseArgs(['bun', 'cli.ts', 'list', '--json']);
    expect(result.flags['json']).toBe('true');
  });

  test('empty argv gives empty command', () => {
    const result = parseArgs(['bun', 'cli.ts']);
    expect(result.command).toBe('');
  });
});

// --- start ---

describe('start', () => {
  test('creates a new session', () => {
    const result = start(ctx);
    expect(result.sessionId).toBeTruthy();
    expect(result.resumed).toBe(false);
    expect(result.stage).toBeNull();

    // Log file was created
    const logPath = path.join(logDir, `${result.sessionId}.jsonl`);
    expect(fs.existsSync(logPath)).toBe(true);
  });

  test('resumes an existing session by runId', () => {
    // Create a session first
    const orch = Orchestrator.create({ logDir, projectDir: tmpDir });
    orch.enterStage('PLAN');
    const id = orch.id;

    const result = start(ctx, { runId: id });
    expect(result.sessionId).toBe(id);
    expect(result.resumed).toBe(true);
    expect(result.stage).toBe('PLAN');
  });

  test('creates new session when runId not found', () => {
    const result = start(ctx, { runId: 'nonexistent' });
    expect(result.sessionId).not.toBe('nonexistent');
    expect(result.resumed).toBe(false);
  });

  test('passes config to new session', () => {
    const result = start(ctx, { config: { key: 'val' } });
    const logPath = path.join(logDir, `${result.sessionId}.jsonl`);
    const log = EventLog.replay(logPath);
    const created = log.latest('SESSION_CREATED');
    expect(created?.config).toEqual({ key: 'val' });
  });
});

// --- status ---

describe('status', () => {
  test('returns session status', () => {
    const orch = Orchestrator.create({ logDir, projectDir: tmpDir });
    orch.enterStage('PLAN');
    orch.queueTask('test task');

    const result = status(ctx, orch.id);
    expect(result.sessionId).toBe(orch.id);
    expect(result.stage).toBe('PLAN');
    expect(result.done).toBe(false);
    expect(result.tasks.total).toBe(1);
    expect(result.tasks.completed).toBe(0);
    expect(result.pendingApproval).toBeNull();
  });

  test('shows pending approval', () => {
    const orch = Orchestrator.create({ logDir, projectDir: tmpDir });
    orch.enterStage('PLAN');
    orch.requestApproval('Deploy to production?');

    const result = status(ctx, orch.id);
    expect(result.pendingApproval).not.toBeNull();
    expect(result.pendingApproval!.description).toBe('Deploy to production?');
  });

  test('shows completed session', () => {
    const orch = Orchestrator.create({ logDir, projectDir: tmpDir });
    orch.enterStage('PLAN');
    orch.complete('All done');

    const result = status(ctx, orch.id);
    expect(result.done).toBe(true);
  });

  test('throws for unknown session', () => {
    expect(() => status(ctx, 'nonexistent')).toThrow(CliError);
    expect(() => status(ctx, 'nonexistent')).toThrow('Session not found');
  });
});

// --- list ---

describe('list', () => {
  test('returns empty array when no sessions', () => {
    const entries = list(ctx);
    expect(entries).toEqual([]);
  });

  test('lists all sessions', () => {
    Orchestrator.create({ logDir, projectDir: tmpDir });
    Orchestrator.create({ logDir, projectDir: tmpDir });

    const entries = list(ctx);
    expect(entries).toHaveLength(2);
    expect(entries[0].eventCount).toBeGreaterThan(0);
  });

  test('sorted newest first', () => {
    const orch1 = Orchestrator.create({ logDir, projectDir: tmpDir });
    // Small delay to ensure different timestamps
    const orch2 = Orchestrator.create({ logDir, projectDir: tmpDir });

    const entries = list(ctx);
    expect(entries).toHaveLength(2);
    // Newest first — orch2 was created later
    expect(entries[0].sessionId).toBe(orch2.id);
    expect(entries[1].sessionId).toBe(orch1.id);
  });

  test('shows stage and done status', () => {
    const orch = Orchestrator.create({ logDir, projectDir: tmpDir });
    orch.enterStage('PLAN');
    orch.complete('done');

    const entries = list(ctx);
    expect(entries[0].done).toBe(true);
  });

  test('handles empty logDir gracefully', () => {
    const emptyCtx = { ...ctx, logDir: path.join(tmpDir, 'nonexistent') };
    expect(list(emptyCtx)).toEqual([]);
  });
});

// --- watch ---

describe('watch', () => {
  test('emits existing events and stops on SESSION_COMPLETED', async () => {
    const orch = Orchestrator.create({ logDir, projectDir: tmpDir });
    orch.enterStage('PLAN');
    orch.complete('done');

    const events: string[] = [];
    const result = await watch(ctx, orch.id, {
      interval: 50,
      onEvent: (env) => events.push(env.event.type),
    });

    expect(result.reason).toBe('done');
    expect(result.eventsEmitted).toBeGreaterThan(0);
    expect(events).toContain('SESSION_COMPLETED');
  });

  test('stops on timeout', async () => {
    const orch = Orchestrator.create({ logDir, projectDir: tmpDir });
    orch.enterStage('PLAN');
    // Session not completed — will timeout

    const result = await watch(ctx, orch.id, {
      interval: 50,
      timeout: 200,
      onEvent: () => {},
    });

    expect(result.reason).toBe('timeout');
  });

  test('stops on abort signal', async () => {
    const orch = Orchestrator.create({ logDir, projectDir: tmpDir });
    orch.enterStage('PLAN');

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);

    const result = await watch(ctx, orch.id, {
      interval: 50,
      signal: controller.signal,
      onEvent: () => {},
    });

    expect(result.reason).toBe('aborted');
  });

  test('throws for unknown session', async () => {
    try {
      await watch(ctx, 'nonexistent');
      expect(true).toBe(false); // should not reach
    } catch (e) {
      expect(e).toBeInstanceOf(CliError);
    }
  });
});

// --- approve / reject ---

describe('approve', () => {
  test('approves a pending approval by stage and cycle', () => {
    const orch = Orchestrator.create({ logDir, projectDir: tmpDir });
    orch.enterStage('PLAN');
    const approvalId = orch.requestApproval('Ready to proceed?');

    const signal: ApprovalSignal = {
      runId: orch.id,
      stage: 'PLAN',
      reviewCycle: 1,
      reason: 'Looks good',
    };

    const result = approve(ctx, signal);
    expect(result.approvalId).toBe(approvalId);

    // Verify the decision was recorded
    const resumed = Orchestrator.resume(path.join(logDir, `${orch.id}.jsonl`));
    expect(resumed.pendingApproval()).toBeNull();
  });

  test('targets correct cycle when multiple approvals exist', () => {
    const orch = Orchestrator.create({ logDir, projectDir: tmpDir });
    orch.enterStage('PLAN');
    const id1 = orch.requestApproval('First review');
    orch.recordApproval(id1, true, 'ok'); // Decide first one
    const id2 = orch.requestApproval('Second review');

    // Cycle 2 should target the second approval
    const result = approve(ctx, {
      runId: orch.id,
      stage: 'PLAN',
      reviewCycle: 2,
      reason: 'Also good',
    });

    expect(result.approvalId).toBe(id2);
  });

  test('throws when no pending approval at cycle', () => {
    const orch = Orchestrator.create({ logDir, projectDir: tmpDir });
    orch.enterStage('PLAN');

    expect(() =>
      approve(ctx, { runId: orch.id, stage: 'PLAN', reviewCycle: 1 }),
    ).toThrow(CliError);
  });

  test('throws when approval already decided', () => {
    const orch = Orchestrator.create({ logDir, projectDir: tmpDir });
    orch.enterStage('PLAN');
    const id = orch.requestApproval('Review?');
    orch.recordApproval(id, true);

    expect(() =>
      approve(ctx, { runId: orch.id, stage: 'PLAN', reviewCycle: 1 }),
    ).toThrow('No pending approval');
  });

  test('throws for unknown session', () => {
    expect(() =>
      approve(ctx, { runId: 'nope', stage: 'PLAN', reviewCycle: 1 }),
    ).toThrow('Session not found');
  });
});

describe('reject', () => {
  test('rejects a pending approval', () => {
    const orch = Orchestrator.create({ logDir, projectDir: tmpDir });
    orch.enterStage('PLAN');
    const approvalId = orch.requestApproval('Ready?');

    const result = reject(ctx, {
      runId: orch.id,
      stage: 'PLAN',
      reviewCycle: 1,
      reason: 'Not ready yet',
    });

    expect(result.approvalId).toBe(approvalId);

    // Verify decision
    const resumed = Orchestrator.resume(path.join(logDir, `${orch.id}.jsonl`));
    const decisions = resumed.eventLog.ofType('APPROVAL_DECISION');
    expect(decisions).toHaveLength(1);
    expect(decisions[0].approved).toBe(false);
    expect(decisions[0].reason).toBe('Not ready yet');
  });

  test('scopes rejection to correct stage', () => {
    const orch = Orchestrator.create({ logDir, projectDir: tmpDir });
    orch.enterStage('PLAN');
    orch.requestApproval('Plan approval');
    orch.completeStage();
    orch.enterStage('EXECUTE');
    const execId = orch.requestApproval('Execute approval');

    // Reject the EXECUTE stage approval (cycle 1 in EXECUTE)
    const result = reject(ctx, {
      runId: orch.id,
      stage: 'EXECUTE',
      reviewCycle: 1,
    });

    expect(result.approvalId).toBe(execId);
  });
});
