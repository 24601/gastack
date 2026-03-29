/**
 * T2.3 EventLog corruption resilience + T2.2 Complex crash recovery
 *
 * Gate tier: deterministic, file-I/O only, no external deps, <3s.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { EventLog, type EventEnvelope, type LoadResult } from './events.ts';
import { Orchestrator, type Adapter } from './orchestrate.ts';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-corruption-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// Helper: create a valid JSON envelope string
function envelope(event: Record<string, unknown>, id?: string): string {
  return JSON.stringify({
    id: id ?? crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    event,
  });
}

// --- T2.3: EventLog corruption resilience ---

describe('T2.3 EventLog corruption resilience', () => {
  test('partial last line survives load — truncated envelope is repaired', () => {
    const logPath = path.join(tmpDir, 'partial-last.jsonl');

    // Write two valid lines, then a truncated third
    const line1 = envelope({ type: 'SESSION_CREATED', sessionId: 's1', projectDir: '/tmp', config: {} });
    const line2 = envelope({ type: 'STAGE_ENTERED', stage: 'PLAN' });
    // Truncated: missing closing braces (simulates kill mid-write)
    const truncated = '{"id":"trunc-1","timestamp":"2026-01-01T00:00:00Z","event":{"type":"STAGE_COMPLETED","stage":"PLAN","summary":"done"';
    fs.writeFileSync(logPath, [line1, line2, truncated].join('\n') + '\n');

    const result = EventLog.load(logPath, { diagnostics: true });

    // All three lines should load (truncated repaired)
    expect(result.envelopes).toHaveLength(3);
    expect(result.envelopes[0].event.type).toBe('SESSION_CREATED');
    expect(result.envelopes[1].event.type).toBe('STAGE_ENTERED');
    expect(result.envelopes[2].event.type).toBe('STAGE_COMPLETED');

    // Diagnostic recorded for the repair
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0].kind).toBe('truncation');
    expect(result.diagnostics[0].repaired).toBe(true);
    expect(result.diagnostics[0].lineNumber).toBe(3);
  });

  test('empty file loads cleanly — zero events, zero diagnostics', () => {
    const logPath = path.join(tmpDir, 'empty.jsonl');
    fs.writeFileSync(logPath, '');

    // Simple overload
    const envelopes = EventLog.load(logPath);
    expect(envelopes).toHaveLength(0);

    // Diagnostics overload
    const result = EventLog.load(logPath, { diagnostics: true });
    expect(result.envelopes).toHaveLength(0);
    expect(result.diagnostics).toHaveLength(0);
  });

  test('nonexistent file loads cleanly — zero events, zero diagnostics', () => {
    const logPath = path.join(tmpDir, 'does-not-exist.jsonl');

    const envelopes = EventLog.load(logPath);
    expect(envelopes).toHaveLength(0);

    const result = EventLog.load(logPath, { diagnostics: true });
    expect(result.envelopes).toHaveLength(0);
    expect(result.diagnostics).toHaveLength(0);
  });

  test('file with only whitespace/blank lines loads cleanly', () => {
    const logPath = path.join(tmpDir, 'blanks.jsonl');
    fs.writeFileSync(logPath, '\n\n   \n\n');

    const envelopes = EventLog.load(logPath);
    expect(envelopes).toHaveLength(0);
  });

  test('valid events before and after corruption are preserved', () => {
    const logPath = path.join(tmpDir, 'sandwich.jsonl');

    const before = envelope({ type: 'SESSION_CREATED', sessionId: 's1', projectDir: '/tmp', config: {} }, 'good-1');
    const garbage = '\x00\x01\x02GARBAGE\xff\xfe';
    const after = envelope({ type: 'STAGE_ENTERED', stage: 'PLAN' }, 'good-2');
    fs.writeFileSync(logPath, [before, garbage, after].join('\n') + '\n');

    const result = EventLog.load(logPath, { diagnostics: true });

    // Both valid events preserved
    expect(result.envelopes).toHaveLength(2);
    expect(result.envelopes[0].id).toBe('good-1');
    expect(result.envelopes[1].id).toBe('good-2');

    // Garbage diagnosed
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0].kind).toBe('garbage');
    expect(result.diagnostics[0].repaired).toBe(false);
  });

  test('multiple consecutive corrupted lines do not derail loading', () => {
    const logPath = path.join(tmpDir, 'multi-corrupt.jsonl');

    const valid1 = envelope({ type: 'SESSION_CREATED', sessionId: 's1', projectDir: '/tmp', config: {} });
    const garbage1 = 'totally broken';
    const garbage2 = '{incomplete json';
    const garbage3 = 'more garbage here!!!';
    const valid2 = envelope({ type: 'STAGE_ENTERED', stage: 'PLAN' });
    fs.writeFileSync(logPath, [valid1, garbage1, garbage2, garbage3, valid2].join('\n') + '\n');

    const result = EventLog.load(logPath, { diagnostics: true });

    expect(result.envelopes).toHaveLength(2);
    expect(result.diagnostics.length).toBeGreaterThanOrEqual(3);
  });

  test('byte offsets in diagnostics are accurate', () => {
    const logPath = path.join(tmpDir, 'offsets.jsonl');

    const line1 = envelope({ type: 'SESSION_CREATED', sessionId: 's1', projectDir: '/tmp', config: {} });
    const garbage = 'not json';
    fs.writeFileSync(logPath, line1 + '\n' + garbage + '\n');

    const result = EventLog.load(logPath, { diagnostics: true });
    expect(result.diagnostics).toHaveLength(1);

    // Byte offset of the garbage line should equal byte length of line1 + newline
    const expectedOffset = Buffer.byteLength(line1, 'utf-8') + 1;
    expect(result.diagnostics[0].byteOffset).toBe(expectedOffset);
  });

  test('replay() works on a log with corrupted lines', () => {
    const logPath = path.join(tmpDir, 'replay-corrupt.jsonl');

    const env1 = envelope(
      { type: 'SESSION_CREATED', sessionId: 'replay-s1', projectDir: '/tmp', config: {} },
      'r1',
    );
    const garbage = 'CORRUPT';
    const env2 = envelope({ type: 'STAGE_ENTERED', stage: 'PLAN' }, 'r2');
    fs.writeFileSync(logPath, [env1, garbage, env2].join('\n') + '\n');

    const log = EventLog.replay(logPath);
    expect(log.length).toBe(2);
    expect(log.latest('SESSION_CREATED')?.sessionId).toBe('replay-s1');
    expect(log.latest('STAGE_ENTERED')?.stage).toBe('PLAN');
  });

  test('valid JSON that is not an EventEnvelope is classified as garbage', () => {
    const logPath = path.join(tmpDir, 'not-envelope.jsonl');

    const validEnv = envelope({ type: 'SESSION_CREATED', sessionId: 's1', projectDir: '/tmp', config: {} });
    const notEnvelope = '{"some":"random","data":42}';
    fs.writeFileSync(logPath, [validEnv, notEnvelope].join('\n') + '\n');

    const result = EventLog.load(logPath, { diagnostics: true });
    expect(result.envelopes).toHaveLength(1);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0].kind).toBe('garbage');
    expect(result.diagnostics[0].detail).toContain('missing required EventEnvelope fields');
  });
});

// --- T2.2: Complex crash recovery ---

describe('T2.2 Complex crash recovery', () => {
  function createOrch(adapters?: Record<string, Adapter>) {
    return Orchestrator.create({
      logDir: tmpDir,
      projectDir: '/tmp/project',
      adapters,
      config: { test: true },
    });
  }

  test('resume mid-EXECUTE reconstructs all state', () => {
    // Build up state: PLAN complete, EXECUTE in progress with tasks
    const orch1 = createOrch();
    orch1.enterStage('PLAN');
    const planTask = orch1.queueTask('Plan work');
    orch1.startTask(planTask);
    orch1.completeTask(planTask, 'Planned 3 items');
    orch1.completeStage('Plan complete');

    orch1.enterStage('EXECUTE');
    const execTask1 = orch1.queueTask('Build component A');
    const execTask2 = orch1.queueTask('Build component B');
    const execTask3 = orch1.queueTask('Build component C');
    orch1.startTask(execTask1);
    orch1.completeTask(execTask1, 'Component A built');
    orch1.startTask(execTask2);
    // Task 2 is running, task 3 is queued — simulate crash here

    const logPath = orch1.eventLog.path;

    // Resume from the log
    const orch2 = Orchestrator.resume(logPath);

    // Stage should be EXECUTE
    expect(orch2.currentStage()).toBe('EXECUTE');
    expect(orch2.isDone()).toBe(false);

    // All tasks reconstructed with correct states
    const tasks = orch2.tasks();
    expect(tasks).toHaveLength(4); // 1 plan + 3 execute tasks

    const planTasks = orch2.tasksForStage('PLAN');
    expect(planTasks).toHaveLength(1);
    expect(planTasks[0].status).toBe('completed');

    const execTasks = orch2.tasksForStage('EXECUTE');
    expect(execTasks).toHaveLength(3);

    const completed = execTasks.find(t => t.taskId === execTask1);
    expect(completed?.status).toBe('completed');
    expect(completed?.result).toBe('Component A built');

    const running = execTasks.find(t => t.taskId === execTask2);
    expect(running?.status).toBe('running');

    const queued = execTasks.find(t => t.taskId === execTask3);
    expect(queued?.status).toBe('queued');

    // Session ID preserved
    expect(orch2.id).toBe(orch1.id);

    // Can continue work after resume
    orch2.completeTask(execTask2, 'Component B built');
    orch2.startTask(execTask3);
    orch2.completeTask(execTask3, 'Component C built');
    expect(orch2.stageTasksComplete('EXECUTE')).toBe(true);
  });

  test('resume preserves approval state through crash', () => {
    // Create a session with a pending approval in REVIEW
    const orch1 = createOrch();
    orch1.enterStage('PLAN');
    orch1.completeStage();
    orch1.enterStage('EXECUTE');
    orch1.completeStage();
    orch1.enterStage('REVIEW');

    const approvalId = orch1.requestApproval('Review the code changes before deploy');
    // Approval is pending — simulate crash

    const logPath = orch1.eventLog.path;

    // Resume
    const orch2 = Orchestrator.resume(logPath);

    // Stage is REVIEW
    expect(orch2.currentStage()).toBe('REVIEW');

    // Pending approval is preserved
    const pending = orch2.pendingApproval();
    expect(pending).not.toBeNull();
    expect(pending!.approvalId).toBe(approvalId);
    expect(pending!.stage).toBe('REVIEW');
    expect(pending!.description).toBe('Review the code changes before deploy');

    // Can resolve the approval after resume
    orch2.recordApproval(approvalId, true, 'LGTM');
    expect(orch2.pendingApproval()).toBeNull();
  });

  test('resume preserves granted approval through crash', () => {
    const orch1 = createOrch();
    orch1.enterStage('PLAN');
    orch1.completeStage();
    orch1.enterStage('EXECUTE');
    orch1.completeStage();
    orch1.enterStage('REVIEW');

    const approvalId = orch1.requestApproval('Deploy to production?');
    orch1.recordApproval(approvalId, true, 'Ship it');
    // Crash after approval granted

    const logPath = orch1.eventLog.path;
    const orch2 = Orchestrator.resume(logPath);

    // No pending approval (it was resolved)
    expect(orch2.pendingApproval()).toBeNull();
    expect(orch2.currentStage()).toBe('REVIEW');
  });

  test('REFINE loop state survives restart', () => {
    // Walk through PLAN → EXECUTE → REVIEW → REFINE → back to EXECUTE
    const orch1 = createOrch();
    orch1.enterStage('PLAN');
    orch1.completeStage('Plan v1');

    orch1.enterStage('EXECUTE');
    const t1 = orch1.queueTask('Build v1');
    orch1.startTask(t1);
    orch1.completeTask(t1, 'Built v1');
    orch1.completeStage('Execute v1');

    orch1.enterStage('REVIEW');
    orch1.completeStage('Needs refinement');

    orch1.enterStage('REFINE');
    orch1.completeStage('Refined requirements');

    // Loop back to EXECUTE
    orch1.enterStage('EXECUTE');
    const t2 = orch1.queueTask('Build v2 (refined)');
    orch1.startTask(t2);
    // Crash mid second EXECUTE iteration

    const logPath = orch1.eventLog.path;

    // Resume
    const orch2 = Orchestrator.resume(logPath);

    // Should be back in EXECUTE (second iteration)
    expect(orch2.currentStage()).toBe('EXECUTE');

    // All tasks from both iterations visible
    const allTasks = orch2.tasks();
    expect(allTasks).toHaveLength(2);

    // First EXECUTE task is completed
    const task1 = allTasks.find(t => t.taskId === t1);
    expect(task1?.status).toBe('completed');

    // Second EXECUTE task is running (in-progress at crash)
    const task2 = allTasks.find(t => t.taskId === t2);
    expect(task2?.status).toBe('running');

    // Can complete the second iteration
    orch2.completeTask(t2, 'Built v2');
    expect(orch2.stageTasksComplete('EXECUTE')).toBe(true);

    // Can continue through the rest of the pipeline
    orch2.completeStage('Execute v2 done');
    orch2.enterStage('REVIEW');
    expect(orch2.currentStage()).toBe('REVIEW');
  });

  test('resume with failed tasks preserves failure details', () => {
    const orch1 = createOrch();
    orch1.enterStage('PLAN');
    orch1.completeStage();
    orch1.enterStage('EXECUTE');

    const t1 = orch1.queueTask('Compile code');
    orch1.startTask(t1);
    orch1.failTask(t1, 'Syntax error in main.ts:42', true);

    const t2 = orch1.queueTask('Run tests');
    orch1.startTask(t2);
    orch1.failTask(t2, 'Test timeout after 30s', false);
    // Crash

    const logPath = orch1.eventLog.path;
    const orch2 = Orchestrator.resume(logPath);

    const tasks = orch2.tasksForStage('EXECUTE');
    expect(tasks).toHaveLength(2);

    const failed1 = tasks.find(t => t.taskId === t1);
    expect(failed1?.status).toBe('failed');
    expect(failed1?.error).toBe('Syntax error in main.ts:42');
    expect(failed1?.retryable).toBe(true);

    const failed2 = tasks.find(t => t.taskId === t2);
    expect(failed2?.status).toBe('failed');
    expect(failed2?.error).toBe('Test timeout after 30s');
    expect(failed2?.retryable).toBe(false);
  });

  test('resume with external call idempotency — cached calls survive crash', async () => {
    let callCount = 0;
    const adapter: Adapter = {
      name: 'deploy',
      async execute(cmd) {
        callCount++;
        return `deployed-${callCount}`;
      },
    };

    const orch1 = Orchestrator.create({
      logDir: tmpDir,
      projectDir: '/tmp',
      adapters: { deploy: adapter },
    });
    orch1.enterStage('PLAN');
    orch1.completeStage();
    orch1.enterStage('EXECUTE');

    // Make an external call
    const r1 = await orch1.externalCall('deploy', 'push', { env: 'staging' });
    expect(r1.result).toBe('deployed-1');
    expect(callCount).toBe(1);
    // Crash

    const logPath = orch1.eventLog.path;

    // Resume with adapter
    const orch2 = Orchestrator.resume(logPath, { deploy: adapter });

    // Same call should be cached
    const r2 = await orch2.externalCall('deploy', 'push', { env: 'staging' });
    expect(r2.cached).toBe(true);
    expect(r2.result).toBe('deployed-1');
    expect(callCount).toBe(1); // Not re-executed

    // Different call still executes
    const r3 = await orch2.externalCall('deploy', 'push', { env: 'production' });
    expect(r3.cached).toBe(false);
    expect(r3.result).toBe('deployed-2');
    expect(callCount).toBe(2);
  });

  test('double-crash recovery — resume from a log that was already resumed', () => {
    // First session
    const orch1 = createOrch();
    orch1.enterStage('PLAN');
    orch1.completeStage();
    orch1.enterStage('EXECUTE');
    const t1 = orch1.queueTask('Build');
    orch1.startTask(t1);

    const logPath = orch1.eventLog.path;

    // First crash recovery
    const orch2 = Orchestrator.resume(logPath);
    expect(orch2.currentStage()).toBe('EXECUTE');
    orch2.completeTask(t1, 'Built');
    const t2 = orch2.queueTask('Test');
    orch2.startTask(t2);
    // Second crash

    // Second crash recovery
    const orch3 = Orchestrator.resume(logPath);
    expect(orch3.currentStage()).toBe('EXECUTE');

    const tasks = orch3.tasksForStage('EXECUTE');
    expect(tasks).toHaveLength(2);

    const built = tasks.find(t => t.taskId === t1);
    expect(built?.status).toBe('completed');

    const testing = tasks.find(t => t.taskId === t2);
    expect(testing?.status).toBe('running');

    // SESSION_RESUMED events should exist for both resumes
    const resumed = orch3.eventLog.ofType('SESSION_RESUMED');
    expect(resumed).toHaveLength(2);
  });

  test('complete() works correctly after resume', () => {
    const orch1 = createOrch();
    orch1.enterStage('PLAN');
    orch1.completeStage();
    orch1.enterStage('EXECUTE');
    // Crash

    const logPath = orch1.eventLog.path;
    const orch2 = Orchestrator.resume(logPath);

    // Should be able to complete the session from resumed state
    orch2.complete('Done after recovery');
    expect(orch2.isDone()).toBe(true);

    const completed = orch2.eventLog.latest('SESSION_COMPLETED');
    expect(completed?.success).toBe(true);
    expect(completed?.summary).toBe('Done after recovery');
  });
});
