import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { EventLog, STAGES, idempotencyKey, type LoadResult, type CorruptionDiagnostic } from './events.ts';
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

  test('load skips malformed lines (backward compat)', () => {
    const log = new EventLog(tmpDir, 'malformed-test');
    log.append({ type: 'STAGE_ENTERED', stage: 'PLAN' });
    // Inject garbage between valid lines
    fs.appendFileSync(log.path, 'not json at all\n');
    log.append({ type: 'STAGE_ENTERED', stage: 'EXECUTE' });

    const envelopes = EventLog.load(log.path);
    expect(envelopes).toHaveLength(2);
    expect(envelopes[0].event.type).toBe('STAGE_ENTERED');
    expect(envelopes[1].event.type).toBe('STAGE_ENTERED');
  });

  test('load repairs truncated JSON (missing closing braces)', () => {
    const logPath = path.join(tmpDir, 'truncated.jsonl');
    const validEnvelope = JSON.stringify({
      id: 'e1',
      timestamp: '2026-01-01T00:00:00Z',
      event: { type: 'STAGE_ENTERED', stage: 'PLAN' },
    });
    // Simulate truncation: valid envelope with missing closing brace
    const truncated = validEnvelope.slice(0, -1); // remove final }
    fs.writeFileSync(logPath, truncated + '\n');

    const envelopes = EventLog.load(logPath);
    expect(envelopes).toHaveLength(1);
    expect(envelopes[0].event.type).toBe('STAGE_ENTERED');
  });

  test('load repairs truncated JSON (missing closing bracket and brace)', () => {
    const logPath = path.join(tmpDir, 'truncated2.jsonl');
    // Envelope with array value truncated
    const line = '{"id":"e2","timestamp":"2026-01-01T00:00:00Z","event":{"type":"SESSION_CREATED","sessionId":"s1","projectDir":"/tmp","config":{"items":[1,2,3';
    fs.writeFileSync(logPath, line + '\n');

    const envelopes = EventLog.load(logPath);
    expect(envelopes).toHaveLength(1);
    expect(envelopes[0].event.type).toBe('SESSION_CREATED');
  });

  test('load repairs truncated string value', () => {
    const logPath = path.join(tmpDir, 'truncated-str.jsonl');
    // Truncated mid-string
    const line = '{"id":"e3","timestamp":"2026-01-01T00:00:00Z","event":{"type":"STAGE_ENTERED","stage":"PLA';
    fs.writeFileSync(logPath, line + '\n');

    const envelopes = EventLog.load(logPath);
    expect(envelopes).toHaveLength(1);
    // Stage will be "PLA" (truncated) but it still parses
    expect(envelopes[0].id).toBe('e3');
  });

  test('load diagnostics mode returns corruption details', () => {
    const logPath = path.join(tmpDir, 'diag.jsonl');
    const valid = JSON.stringify({
      id: 'e1',
      timestamp: '2026-01-01T00:00:00Z',
      event: { type: 'STAGE_ENTERED', stage: 'PLAN' },
    });
    const garbage = 'not json at all';
    const truncated = valid.slice(0, -1);
    fs.writeFileSync(logPath, [valid, garbage, truncated].join('\n') + '\n');

    const result = EventLog.load(logPath, { diagnostics: true });
    expect(result.envelopes).toHaveLength(2); // valid + repaired truncated
    expect(result.diagnostics).toHaveLength(2); // garbage + repaired truncated

    // Garbage line diagnosed correctly
    const garbageDiag = result.diagnostics.find(d => d.kind === 'garbage');
    expect(garbageDiag).toBeDefined();
    expect(garbageDiag!.repaired).toBe(false);
    expect(garbageDiag!.lineNumber).toBe(2);
    expect(garbageDiag!.line).toBe(garbage);

    // Truncated line diagnosed and repaired
    const truncDiag = result.diagnostics.find(d => d.kind === 'truncation');
    expect(truncDiag).toBeDefined();
    expect(truncDiag!.repaired).toBe(true);
    expect(truncDiag!.lineNumber).toBe(3);
  });

  test('load rejects valid JSON that is not an EventEnvelope', () => {
    const logPath = path.join(tmpDir, 'bad-envelope.jsonl');
    fs.writeFileSync(logPath, '{"foo":"bar"}\n');

    const result = EventLog.load(logPath, { diagnostics: true });
    expect(result.envelopes).toHaveLength(0);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0].kind).toBe('garbage');
    expect(result.diagnostics[0].detail).toContain('missing required EventEnvelope fields');
  });

  test('load handles binary garbage (non-printable chars)', () => {
    const logPath = path.join(tmpDir, 'binary.jsonl');
    const binaryGarbage = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe]).toString('utf-8');
    const valid = JSON.stringify({
      id: 'e1',
      timestamp: '2026-01-01T00:00:00Z',
      event: { type: 'STAGE_ENTERED', stage: 'PLAN' },
    });
    fs.writeFileSync(logPath, binaryGarbage + '\n' + valid + '\n');

    const result = EventLog.load(logPath, { diagnostics: true });
    expect(result.envelopes).toHaveLength(1);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0].kind).toBe('garbage');
  });

  test('load handles truncation after colon (key with no value)', () => {
    const logPath = path.join(tmpDir, 'trunc-colon.jsonl');
    const line = '{"id":"e5","timestamp":"2026-01-01T00:00:00Z","event":';
    fs.writeFileSync(logPath, line + '\n');

    // This truncation can't produce a valid envelope (event becomes null)
    const result = EventLog.load(logPath, { diagnostics: true });
    // Repair may succeed structurally but fail envelope validation
    expect(result.diagnostics.length).toBeGreaterThanOrEqual(1);
  });

  test('replay works with repaired events', () => {
    const logPath = path.join(tmpDir, 'replay-repair.jsonl');
    const env1 = JSON.stringify({
      id: 'e1',
      timestamp: '2026-01-01T00:00:00Z',
      event: { type: 'SESSION_CREATED', sessionId: 's1', projectDir: '/tmp', config: {} },
    });
    // Truncated second event
    const env2 = '{"id":"e2","timestamp":"2026-01-01T00:00:01Z","event":{"type":"STAGE_ENTERED","stage":"PLAN"}';
    fs.writeFileSync(logPath, env1 + '\n' + env2 + '\n');

    const replayed = EventLog.replay(logPath);
    expect(replayed.length).toBe(2);
    expect(replayed.latest('STAGE_ENTERED')?.stage).toBe('PLAN');
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
    expect(orch.advance('deploy done')).toBe('VERIFY');
    expect(orch.advance('verify done')).toBe('DONE');
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
    orch.completeStage();
    orch.enterStage('VERIFY');

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

  test('VERIFY can loop back to REFINE on canary failure', () => {
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
    orch.completeStage();
    orch.enterStage('VERIFY');
    orch.completeStage();
    // Loop back to REFINE
    orch.enterStage('REFINE');
    expect(orch.currentStage()).toBe('REFINE');
  });

  test('verifyCycle passes when canary returns passed:true', async () => {
    const mockAdapter: Adapter = {
      name: 'gstack',
      async execute(cmd, args) {
        if (cmd === 'canary') {
          return JSON.stringify({ passed: true, summary: 'All checks green' });
        }
        return '';
      },
    };
    const orch = createOrch({ gstack: mockAdapter });
    // Walk to VERIFY stage
    orch.enterStage('PLAN');
    orch.completeStage();
    orch.enterStage('EXECUTE');
    orch.completeStage();
    orch.enterStage('REVIEW');
    orch.completeStage();
    orch.enterStage('REFINE');
    orch.completeStage();
    orch.enterStage('DEPLOY');
    orch.completeStage();
    orch.enterStage('VERIFY');

    const result = await orch.verifyCycle();
    expect(result.passed).toBe(true);
    expect(result.approvalRequested).toBe(false);
    // VERIFY stage should be completed, ready for DONE
    expect(orch.currentStage()).toBeNull();
  });

  test('verifyCycle fails and transitions to REFINE when canary returns passed:false', async () => {
    const mockAdapter: Adapter = {
      name: 'gstack',
      async execute(cmd, args) {
        if (cmd === 'canary') {
          return JSON.stringify({ passed: false, errors: ['Console error on /home'] });
        }
        return '';
      },
    };
    const orch = createOrch({ gstack: mockAdapter });
    // Walk to VERIFY stage
    orch.enterStage('PLAN');
    orch.completeStage();
    orch.enterStage('EXECUTE');
    orch.completeStage();
    orch.enterStage('REVIEW');
    orch.completeStage();
    orch.enterStage('REFINE');
    orch.completeStage();
    orch.enterStage('DEPLOY');
    orch.completeStage();
    orch.enterStage('VERIFY');

    const result = await orch.verifyCycle();
    expect(result.passed).toBe(false);
    expect(result.approvalRequested).toBe(true);
    // Should have transitioned to REFINE
    expect(orch.currentStage()).toBe('REFINE');
    expect(orch.pendingApproval()).not.toBeNull();
  });

  test('verifyCycle handles adapter exception as failure', async () => {
    const mockAdapter: Adapter = {
      name: 'gstack',
      async execute(cmd) {
        if (cmd === 'canary') throw new Error('Canary process crashed');
        return '';
      },
    };
    const orch = createOrch({ gstack: mockAdapter });
    orch.enterStage('PLAN');
    orch.completeStage();
    orch.enterStage('EXECUTE');
    orch.completeStage();
    orch.enterStage('REVIEW');
    orch.completeStage();
    orch.enterStage('REFINE');
    orch.completeStage();
    orch.enterStage('DEPLOY');
    orch.completeStage();
    orch.enterStage('VERIFY');

    const result = await orch.verifyCycle();
    expect(result.passed).toBe(false);
    expect(result.approvalRequested).toBe(true);
    expect(orch.currentStage()).toBe('REFINE');
  });

  test('verifyCycle rejects if not in VERIFY stage', async () => {
    const orch = createOrch();
    orch.enterStage('PLAN');
    await expect(orch.verifyCycle()).rejects.toThrow('verifyCycle requires VERIFY stage');
  });

  test('verifyCycle passes url and duration to canary', async () => {
    let capturedArgs: Record<string, unknown> | undefined;
    const mockAdapter: Adapter = {
      name: 'gstack',
      async execute(cmd, args) {
        capturedArgs = args;
        return JSON.stringify({ passed: true, summary: 'OK' });
      },
    };
    const orch = createOrch({ gstack: mockAdapter });
    orch.enterStage('PLAN');
    orch.completeStage();
    orch.enterStage('EXECUTE');
    orch.completeStage();
    orch.enterStage('REVIEW');
    orch.completeStage();
    orch.enterStage('REFINE');
    orch.completeStage();
    orch.enterStage('DEPLOY');
    orch.completeStage();
    orch.enterStage('VERIFY');

    await orch.verifyCycle({ url: 'https://example.com', duration: 60 });
    expect(capturedArgs).toEqual({ url: 'https://example.com', duration: 60 });
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
