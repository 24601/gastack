import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { EventLog, STAGES, idempotencyKey } from './events.ts';
import { Orchestrator, type Adapter } from './orchestrate.ts';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// --- EventLog tests ---

describe('EventLog', () => {
  test('append and load round-trip', () => {
    const log = new EventLog(tmpDir, 'test-session');
    log.append({ type: 'SESSION_CREATED', sessionId: 's1', projectDir: '/tmp', config: {} });
    log.append({ type: 'STAGE_ENTERED', stage: 'PLAN' });

    const loaded = EventLog.load(log.path);
    expect(loaded).toHaveLength(2);
    expect(loaded[0].event.type).toBe('SESSION_CREATED');
    expect(loaded[1].event.type).toBe('STAGE_ENTERED');
  });

  test('replay preserves all events', () => {
    const log = new EventLog(tmpDir, 'replay-test');
    log.append({ type: 'SESSION_CREATED', sessionId: 's1', projectDir: '/tmp', config: {} });
    log.append({ type: 'STAGE_ENTERED', stage: 'PLAN' });
    log.append({ type: 'STAGE_COMPLETED', stage: 'PLAN', summary: 'done' });

    const replayed = EventLog.replay(log.path);
    expect(replayed.length).toBe(3);
    expect(replayed.latest('STAGE_COMPLETED')?.stage).toBe('PLAN');
  });

  test('latest finds most recent event of type', () => {
    const log = new EventLog(tmpDir, 'latest-test');
    log.append({ type: 'STAGE_ENTERED', stage: 'PLAN' });
    log.append({ type: 'STAGE_ENTERED', stage: 'EXECUTE' });

    expect(log.latest('STAGE_ENTERED')?.stage).toBe('EXECUTE');
  });

  test('idempotency key tracking', () => {
    const log = new EventLog(tmpDir, 'idem-test');
    const key = idempotencyKey('gstack', 'review', { pr: 1 });
    expect(log.hasIdempotencyKey(key)).toBe(false);

    log.append({
      type: 'EXTERNAL_CALL_INITIATED',
      callId: 'c1',
      idempotencyKey: key,
      adapter: 'gstack',
      command: 'review',
      args: { pr: 1 },
    });
    expect(log.hasIdempotencyKey(key)).toBe(true);
  });

  test('ofType filters correctly', () => {
    const log = new EventLog(tmpDir, 'filter-test');
    log.append({ type: 'STAGE_ENTERED', stage: 'PLAN' });
    log.append({ type: 'TASK_QUEUED', taskId: 't1', description: 'do thing', stage: 'PLAN' });
    log.append({ type: 'STAGE_ENTERED', stage: 'EXECUTE' });

    const entered = log.ofType('STAGE_ENTERED');
    expect(entered).toHaveLength(2);
    expect(entered[0].stage).toBe('PLAN');
    expect(entered[1].stage).toBe('EXECUTE');
  });
});

// --- Orchestrator tests ---

describe('Orchestrator', () => {
  function createOrch(adapters?: Record<string, Adapter>) {
    return Orchestrator.create({
      logDir: tmpDir,
      projectDir: '/tmp/project',
      adapters,
      config: { test: true },
    });
  }

  test('create starts with no active stage', () => {
    const orch = createOrch();
    expect(orch.currentStage()).toBeNull();
    expect(orch.isDone()).toBe(false);
  });

  test('enterStage PLAN works as first stage', () => {
    const orch = createOrch();
    orch.enterStage('PLAN');
    expect(orch.currentStage()).toBe('PLAN');
  });

  test('enterStage rejects non-PLAN as first stage', () => {
    const orch = createOrch();
    expect(() => orch.enterStage('EXECUTE')).toThrow('First stage must be PLAN');
  });

  test('advance walks through all stages', () => {
    const orch = createOrch();
    expect(orch.advance()).toBe('PLAN');
    expect(orch.advance('plan done')).toBe('EXECUTE');
    expect(orch.advance('execute done')).toBe('REVIEW');
    expect(orch.advance('review done')).toBe('REFINE');
    expect(orch.advance('refine done')).toBe('DEPLOY');
    expect(orch.advance('deploy done')).toBe('DONE');
    expect(orch.currentStage()).toBe('DONE');
  });

  test('REFINE can loop back to EXECUTE', () => {
    const orch = createOrch();
    orch.enterStage('PLAN');
    orch.completeStage();
    orch.enterStage('EXECUTE');
    orch.completeStage();
    orch.enterStage('REVIEW');
    orch.completeStage();
    orch.enterStage('REFINE');
    orch.completeStage();
    // Loop back to EXECUTE
    orch.enterStage('EXECUTE');
    expect(orch.currentStage()).toBe('EXECUTE');
  });

  test('rejects invalid transitions', () => {
    const orch = createOrch();
    orch.enterStage('PLAN');
    // Can't skip EXECUTE and go to REVIEW
    expect(() => orch.enterStage('REVIEW')).toThrow('Invalid transition');
  });

  test('rejects re-entering current stage', () => {
    const orch = createOrch();
    orch.enterStage('PLAN');
    expect(() => orch.enterStage('PLAN')).toThrow('Already in stage');
  });

  test('task lifecycle', () => {
    const orch = createOrch();
    orch.enterStage('PLAN');

    const taskId = orch.queueTask('Extract requirements', { source: 'design.md' });
    expect(orch.tasks()).toHaveLength(1);
    expect(orch.tasks()[0].status).toBe('queued');

    orch.startTask(taskId);
    expect(orch.tasks()[0].status).toBe('running');

    orch.completeTask(taskId, 'Found 5 requirements');
    expect(orch.tasks()[0].status).toBe('completed');
    expect(orch.tasks()[0].result).toBe('Found 5 requirements');
  });

  test('task failure tracking', () => {
    const orch = createOrch();
    orch.enterStage('PLAN');

    const taskId = orch.queueTask('Parse doc');
    orch.startTask(taskId);
    orch.failTask(taskId, 'File not found', true);

    const task = orch.tasks()[0];
    expect(task.status).toBe('failed');
    expect(task.error).toBe('File not found');
    expect(task.retryable).toBe(true);
  });

  test('stageTasksComplete', () => {
    const orch = createOrch();
    orch.enterStage('PLAN');

    // No tasks = vacuously complete
    expect(orch.stageTasksComplete('PLAN')).toBe(true);

    const t1 = orch.queueTask('Task 1');
    const t2 = orch.queueTask('Task 2');
    expect(orch.stageTasksComplete('PLAN')).toBe(false);

    orch.startTask(t1);
    orch.completeTask(t1);
    expect(orch.stageTasksComplete('PLAN')).toBe(false);

    orch.startTask(t2);
    orch.completeTask(t2);
    expect(orch.stageTasksComplete('PLAN')).toBe(true);
  });

  test('approval workflow', () => {
    const orch = createOrch();
    orch.enterStage('PLAN');
    orch.completeStage();
    orch.enterStage('EXECUTE');
    orch.completeStage();
    orch.enterStage('REVIEW');

    const approvalId = orch.requestApproval('Review code changes');
    expect(orch.pendingApproval()).not.toBeNull();
    expect(orch.pendingApproval()!.approvalId).toBe(approvalId);

    orch.recordApproval(approvalId, true, 'Looks good');
    expect(orch.pendingApproval()).toBeNull();
  });

  test('external call idempotency', async () => {
    let callCount = 0;
    const mockAdapter: Adapter = {
      name: 'mock',
      async execute(cmd, args) {
        callCount++;
        return `result-${callCount}`;
      },
    };

    const orch = createOrch({ mock: mockAdapter });
    orch.enterStage('PLAN');

    // First call executes
    const r1 = await orch.externalCall('mock', 'test', { x: 1 });
    expect(r1.result).toBe('result-1');
    expect(r1.cached).toBe(false);
    expect(callCount).toBe(1);

    // Same call returns cached result
    const r2 = await orch.externalCall('mock', 'test', { x: 1 });
    expect(r2.result).toBe('result-1');
    expect(r2.cached).toBe(true);
    expect(callCount).toBe(1); // NOT called again

    // Different args = new call
    const r3 = await orch.externalCall('mock', 'test', { x: 2 });
    expect(r3.result).toBe('result-2');
    expect(r3.cached).toBe(false);
    expect(callCount).toBe(2);
  });

  test('external call failure is recorded and retryable', async () => {
    let shouldFail = true;
    const mockAdapter: Adapter = {
      name: 'flaky',
      async execute() {
        if (shouldFail) {
          shouldFail = false;
          throw new Error('Network timeout');
        }
        return 'success';
      },
    };

    const orch = createOrch({ flaky: mockAdapter });
    orch.enterStage('PLAN');

    // First call fails
    await expect(orch.externalCall('flaky', 'cmd')).rejects.toThrow('Network timeout');

    // Retry succeeds (failed calls don't block retry)
    const r2 = await orch.externalCall('flaky', 'cmd');
    expect(r2.result).toBe('success');
    expect(r2.cached).toBe(false);
  });

  test('crash recovery via resume', () => {
    // Create session and do some work
    const orch1 = createOrch();
    orch1.enterStage('PLAN');
    const taskId = orch1.queueTask('Extract tasks');
    orch1.startTask(taskId);
    orch1.completeTask(taskId, 'Found 3 tasks');
    orch1.completeStage('plan complete');
    orch1.enterStage('EXECUTE');

    const logPath = orch1.eventLog.path;

    // Simulate crash: create new orchestrator from log
    const orch2 = Orchestrator.resume(logPath);
    expect(orch2.currentStage()).toBe('EXECUTE');
    expect(orch2.tasks()).toHaveLength(1);
    expect(orch2.tasks()[0].status).toBe('completed');
    expect(orch2.id).toBe(orch1.id);
  });

  test('resume with idempotency preservation', async () => {
    let callCount = 0;
    const mockAdapter: Adapter = {
      name: 'mock',
      async execute() {
        callCount++;
        return `result-${callCount}`;
      },
    };

    // Create and make an external call
    const orch1 = Orchestrator.create({
      logDir: tmpDir,
      projectDir: '/tmp',
      adapters: { mock: mockAdapter },
    });
    orch1.enterStage('PLAN');
    await orch1.externalCall('mock', 'test', { x: 1 });
    expect(callCount).toBe(1);

    const logPath = orch1.eventLog.path;

    // Resume and try same call — should be cached
    const orch2 = Orchestrator.resume(logPath, { mock: mockAdapter });
    const r = await orch2.externalCall('mock', 'test', { x: 1 });
    expect(r.cached).toBe(true);
    expect(callCount).toBe(1); // Not called again
  });

  test('complete() finalizes session', () => {
    const orch = createOrch();
    orch.enterStage('PLAN');
    orch.completeStage();
    orch.enterStage('EXECUTE');
    orch.completeStage();
    orch.enterStage('REVIEW');
    orch.completeStage();
    orch.enterStage('REFINE');
    orch.completeStage();
    orch.enterStage('DEPLOY');

    orch.complete('All deployed');
    expect(orch.isDone()).toBe(true);
    expect(orch.currentStage()).toBeNull();
  });

  test('fail() records failure', () => {
    const orch = createOrch();
    orch.enterStage('PLAN');
    orch.fail('Requirements unclear');

    expect(orch.isDone()).toBe(true);
    const completed = orch.eventLog.latest('SESSION_COMPLETED');
    expect(completed?.success).toBe(false);
    expect(completed?.summary).toBe('Requirements unclear');
  });

  test('status() returns correct summary', () => {
    const orch = createOrch();
    orch.enterStage('PLAN');
    orch.queueTask('Task 1');
    const t2 = orch.queueTask('Task 2');
    orch.startTask(t2);

    const s = orch.status();
    expect(s.stage).toBe('PLAN');
    expect(s.done).toBe(false);
    expect(s.tasks.total).toBe(2);
    expect(s.tasks.running).toBe(1);
    expect(s.tasks.completed).toBe(0);
    expect(s.pendingApproval).toBe(false);
  });

  test('registerAdapter at runtime', async () => {
    const orch = createOrch();
    orch.enterStage('PLAN');

    const adapter: Adapter = {
      name: 'late',
      async execute() { return 'late-result'; },
    };
    orch.registerAdapter(adapter);
    expect(orch.adapterNames).toContain('late');

    const r = await orch.externalCall('late', 'cmd');
    expect(r.result).toBe('late-result');
  });

  test('rejects operations on completed session', () => {
    const orch = createOrch();
    orch.enterStage('PLAN');
    orch.complete();

    expect(() => orch.enterStage('EXECUTE')).toThrow('already completed');
  });
});

// --- idempotencyKey tests ---

describe('idempotencyKey', () => {
  test('same inputs produce same key', () => {
    const k1 = idempotencyKey('gstack', 'review', { pr: 1 });
    const k2 = idempotencyKey('gstack', 'review', { pr: 1 });
    expect(k1).toBe(k2);
  });

  test('different inputs produce different keys', () => {
    const k1 = idempotencyKey('gstack', 'review', { pr: 1 });
    const k2 = idempotencyKey('gstack', 'review', { pr: 2 });
    expect(k1).not.toBe(k2);
  });

  test('key is 16 hex chars', () => {
    const k = idempotencyKey('adapter', 'cmd');
    expect(k).toMatch(/^[0-9a-f]{16}$/);
  });
});
