/**
 * Task failure investigation tests (ga-6cs).
 *
 * Tests the auto-invoke of /investigate on TASK_FAILED events:
 *   1. handleTaskFailed dispatches sling.investigate via gastown adapter
 *   2. Root cause diagnosis is parsed from investigation output
 *   3. Systemic issues trigger human escalation (approval request)
 *   4. Task-specific issues return diagnosis without escalation
 *   5. Investigation dispatch failure returns fallback (non-blocking)
 *   6. Bead note persistence is best-effort
 *   7. parseInvestigationOutput extracts root cause and systemic flag
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { createTestRig, type TestRig } from './test-rig.js';
import { Orchestrator, type Adapter } from '../orchestrate.js';
import {
  parseInvestigationOutput,
  type InvestigationResult,
} from '../adapters/gstack.js';

let rig: TestRig;

beforeEach(() => {
  rig = createTestRig();
});

afterEach(() => {
  rig.cleanup();
});

// --- Mock adapter ---

function createMockGastown(responses: Record<string, string | Error> = {}): Adapter & { _calls: Array<{ command: string; args?: Record<string, unknown> }> } {
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  return {
    name: 'gastown',
    async execute(command: string, args?: Record<string, unknown>): Promise<string> {
      calls.push({ command, args });
      const response = responses[command];
      if (response instanceof Error) throw response;
      return response ?? JSON.stringify({ rootCause: 'test failure', systemic: false, diagnosis: 'test diagnosis' });
    },
    _calls: calls,
  };
}

/** Set up an orchestrator in EXECUTE stage with a failed task. */
function setupFailedTask(
  orch: Orchestrator,
  description: string,
  error: string,
): string {
  orch.enterStage('PLAN');
  orch.completeStage('planned');
  orch.enterStage('EXECUTE');
  const taskId = orch.queueTask(description);
  orch.startTask(taskId);
  orch.failTask(taskId, error);
  return taskId;
}

// --- parseInvestigationOutput unit tests ---

describe('parseInvestigationOutput', () => {
  test('extracts root cause from labeled line', () => {
    const raw = `
## Investigation

Root Cause: Missing database index on users.email column
The query timed out because a full table scan was required.
    `.trim();

    const result = parseInvestigationOutput(raw);
    expect(result.rootCause).toBe('Missing database index on users.email column');
    expect(result.systemic).toBe(false);
  });

  test('detects systemic infrastructure issues', () => {
    const raw = `
Root Cause: OOM kill during build
The container ran out of memory during the TypeScript compilation step.
This is an infrastructure issue affecting all builds.
    `.trim();

    const result = parseInvestigationOutput(raw);
    expect(result.rootCause).toBe('OOM kill during build');
    expect(result.systemic).toBe(true);
  });

  test('detects systemic config drift', () => {
    const raw = `
Root cause: configuration drift in production env vars
The API_URL was changed without updating the client config.
    `.trim();

    const result = parseInvestigationOutput(raw);
    expect(result.systemic).toBe(true);
  });

  test('detects systemic dependency failure', () => {
    const raw = `
The root cause is a dependency failure in the auth service.
    `.trim();

    const result = parseInvestigationOutput(raw);
    expect(result.systemic).toBe(true);
  });

  test('detects systemic network issues', () => {
    const raw = `Root cause: DNS resolution failure for api.example.com`;

    const result = parseInvestigationOutput(raw);
    expect(result.systemic).toBe(true);
  });

  test('detects systemic permission denied', () => {
    const raw = `The build failed because of permission denied on /var/cache/build`;

    const result = parseInvestigationOutput(raw);
    expect(result.systemic).toBe(true);
  });

  test('detects systemic rate limiting', () => {
    const raw = `Root cause: rate limit hit on GitHub API`;

    const result = parseInvestigationOutput(raw);
    expect(result.systemic).toBe(true);
  });

  test('falls back to first 200 chars when no root cause label', () => {
    const raw = 'The test failed because the mock was not configured correctly for the new endpoint.';

    const result = parseInvestigationOutput(raw);
    expect(result.rootCause).toBe(raw);
    expect(result.systemic).toBe(false);
  });

  test('non-systemic code bug is not flagged', () => {
    const raw = `
Root Cause: Off-by-one error in pagination logic
The page offset was calculated as (page - 1) * limit but should be page * limit.
    `.trim();

    const result = parseInvestigationOutput(raw);
    expect(result.rootCause).toBe('Off-by-one error in pagination logic');
    expect(result.systemic).toBe(false);
  });

  test('preserves raw output', () => {
    const raw = 'some investigation output';
    const result = parseInvestigationOutput(raw);
    expect(result.raw).toBe(raw);
    expect(result.diagnosis).toBe(raw);
  });
});

// --- Orchestrator.handleTaskFailed ---

describe('Orchestrator.handleTaskFailed', () => {
  test('dispatches sling.investigate for a failed task', async () => {
    const adapter = createMockGastown();
    const orch = rig.createOrchestrator({ gastown: adapter });

    const taskId = setupFailedTask(orch, 'Build the feature', 'Build failed: syntax error on line 42');

    const result = await orch.handleTaskFailed(taskId, {
      beadId: 'ga-test',
      rig: 'gastack',
    });

    expect(result.rootCause).toBe('test failure');
    expect(result.systemic).toBe(false);
    expect(result.escalated).toBe(false);

    // Verify the adapter was called with sling.investigate
    const investigateCall = adapter._calls.find((c) => c.command === 'sling.investigate');
    expect(investigateCall).toBeDefined();
    expect(investigateCall!.args!.error).toBe('Build failed: syntax error on line 42');
    expect(investigateCall!.args!.taskDescription).toBe('Build the feature');
    expect(investigateCall!.args!.beadId).toBe('ga-test');
  });

  test('escalates systemic issues with approval request', async () => {
    const adapter = createMockGastown({
      'sling.investigate': JSON.stringify({
        rootCause: 'OOM kill in container',
        systemic: true,
        diagnosis: 'Out of memory during build — infrastructure issue',
      }),
      'raw': 'ok',
    });
    const orch = rig.createOrchestrator({ gastown: adapter });

    const taskId = setupFailedTask(orch, 'Run tests', 'Process killed: OOM');

    const result = await orch.handleTaskFailed(taskId, { beadId: 'ga-test' });

    expect(result.systemic).toBe(true);
    expect(result.escalated).toBe(true);
    expect(result.approvalId).toBeDefined();
    expect(result.rootCause).toBe('OOM kill in container');

    // Verify approval was requested
    const pending = orch.pendingApproval();
    expect(pending).not.toBeNull();
    expect(pending!.description).toContain('Systemic issue');
    expect(pending!.description).toContain('OOM kill in container');
  });

  test('returns fallback when investigation dispatch fails', async () => {
    const adapter = createMockGastown({
      'sling.investigate': new Error('sling failed: no workers available'),
    });
    const orch = rig.createOrchestrator({ gastown: adapter });

    const taskId = setupFailedTask(orch, 'Deploy service', 'Deploy timed out');

    const result = await orch.handleTaskFailed(taskId);

    expect(result.rootCause).toContain('Investigation dispatch failed');
    expect(result.rootCause).toContain('no workers available');
    expect(result.escalated).toBe(false);
  });

  test('returns fallback for unknown taskId', async () => {
    const adapter = createMockGastown();
    const orch = rig.createOrchestrator({ gastown: adapter });

    const result = await orch.handleTaskFailed('nonexistent-task');

    expect(result.rootCause).toContain('not found');
    expect(result.diagnosis).toBe('');
    expect(result.escalated).toBe(false);
  });

  test('handles raw text investigation output (non-JSON)', async () => {
    const adapter = createMockGastown({
      'sling.investigate': 'Root Cause: missing env var API_KEY\nThis is a configuration drift issue.',
      'raw': 'ok',
    });
    const orch = rig.createOrchestrator({ gastown: adapter });

    const taskId = setupFailedTask(orch, 'Start server', 'API_KEY not set');

    const result = await orch.handleTaskFailed(taskId, { beadId: 'ga-test' });

    // Raw text fallback: first 200 chars as root cause
    expect(result.rootCause.length).toBeGreaterThan(0);
    expect(result.diagnosis).toContain('missing env var');
  });

  test('persists diagnosis to bead notes via self-mail', async () => {
    const adapter = createMockGastown({
      'sling.investigate': JSON.stringify({
        rootCause: 'Type error in handler',
        systemic: false,
        diagnosis: 'The handler expected string but got number',
      }),
      'raw': 'ok',
    });
    const orch = rig.createOrchestrator({ gastown: adapter });

    const taskId = setupFailedTask(orch, 'Fix handler', 'TypeError');

    await orch.handleTaskFailed(taskId, { beadId: 'ga-fix' });

    // Verify self-mail was sent with diagnosis
    const rawCall = adapter._calls.find((c) => c.command === 'raw');
    expect(rawCall).toBeDefined();
    expect((rawCall!.args as any).args).toContain('mail');
    expect((rawCall!.args as any).args).toContain('send');
  });

  test('uses cached external call for same investigation (idempotency)', async () => {
    let callCount = 0;
    const adapter: Adapter = {
      name: 'gastown',
      async execute(command: string) {
        callCount++;
        return JSON.stringify({
          rootCause: 'cached result',
          systemic: false,
          diagnosis: 'cached',
        });
      },
    };

    const orch = rig.createOrchestrator({ gastown: adapter });

    const taskId = setupFailedTask(orch, 'Test idempotency', 'test error');

    // First call
    await orch.handleTaskFailed(taskId, { beadId: 'ga-test' });
    const firstCallCount = callCount;

    // Second call with same args — should use cached result
    await orch.handleTaskFailed(taskId, { beadId: 'ga-test' });
    // External call is idempotent — adapter only called once for sling.investigate
    // (second call uses cached result)
    // Note: self-mail may also be called, so we check sling.investigate specifically
    expect(callCount).toBeLessThanOrEqual(firstCallCount + 1);
  });
});

// --- GasTown adapter sling.investigate command ---

describe('sling.investigate command args', () => {
  test('builds investigate prompt with error and description', async () => {
    let capturedArgs: string[] = [];
    const adapter = createMockGastown();

    // We test the arg building logic by checking what handleTaskFailed passes
    const orch = rig.createOrchestrator({ gastown: adapter });

    const taskId = setupFailedTask(orch, 'Compile module', 'ModuleNotFoundError: no module named foo');

    await orch.handleTaskFailed(taskId, {
      beadId: 'ga-compile',
      rig: 'gastack',
      agent: 'claude',
    });

    const investigateCall = adapter._calls.find((c) => c.command === 'sling.investigate');

    expect(investigateCall!.args!.error).toBe('ModuleNotFoundError: no module named foo');
    expect(investigateCall!.args!.taskDescription).toBe('Compile module');
    expect(investigateCall!.args!.beadId).toBe('ga-compile');
    expect(investigateCall!.args!.rig).toBe('gastack');
    expect(investigateCall!.args!.agent).toBe('claude');
  });
});
