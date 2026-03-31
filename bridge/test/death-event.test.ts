/**
 * Death event handling tests (ga-qoe).
 *
 * Tests the failure policy decision tree and orchestrator death event handling:
 *   1. session_death first occurrence → retry (transient failure)
 *   2. session_death repeated same task → investigate (root cause needed)
 *   3. mass_death → halt all dispatch
 *   4. scheduler_dispatch_failed → halt
 *   5. Mass death detection from accumulated individual deaths
 *   6. Orchestrator dispatch halt + resume
 *   7. QualityAdapter classify-death command routing
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { createTestRig, type TestRig } from './test-rig.js';
import {
  classifyDeathEvent,
  detectMassDeath,
  DEFAULT_FAILURE_POLICY,
  type DeathEvent,
  type DeathLedger,
  type FailurePolicy,
  QualityAdapter,
} from '../quality.js';
import { Orchestrator } from '../orchestrate.js';

let rig: TestRig;

beforeEach(() => {
  rig = createTestRig();
});

afterEach(() => {
  rig.cleanup();
});

// --- Helper ---

function makeDeathEvent(overrides?: Partial<DeathEvent>): DeathEvent {
  return {
    type: 'session_death',
    taskId: 'task-abc',
    sessionId: 'sess-123',
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

// --- classifyDeathEvent unit tests ---

describe('classifyDeathEvent', () => {
  test('1. session_death first occurrence → retry', () => {
    const ledger: DeathLedger = new Map();
    const event = makeDeathEvent();

    const response = classifyDeathEvent(event, ledger);

    expect(response.action).toBe('retry');
    expect(response.taskId).toBe('task-abc');
    expect(response.surfaceToHuman).toBe(false);
    expect(response.reason).toContain('attempt 1');
    // Ledger updated
    expect(ledger.get('task-abc')).toBe(1);
  });

  test('2. session_death repeated same task → investigate', () => {
    const ledger: DeathLedger = new Map();
    const event = makeDeathEvent();

    // First death: retry
    const first = classifyDeathEvent(event, ledger);
    expect(first.action).toBe('retry');

    // Second death: investigate (exceeds default maxRetries=1)
    const second = classifyDeathEvent(event, ledger);
    expect(second.action).toBe('investigate');
    expect(second.taskId).toBe('task-abc');
    expect(second.surfaceToHuman).toBe(true);
    expect(second.reason).toContain('/investigate');
    expect(ledger.get('task-abc')).toBe(2);
  });

  test('3. mass_death → halt all dispatch', () => {
    const ledger: DeathLedger = new Map();
    const event = makeDeathEvent({
      type: 'mass_death',
      count: 5,
      windowSeconds: 60,
    });

    const response = classifyDeathEvent(event, ledger);

    expect(response.action).toBe('halt');
    expect(response.surfaceToHuman).toBe(true);
    expect(response.reason).toContain('Mass death');
    expect(response.reason).toContain('5');
  });

  test('4. scheduler_dispatch_failed → halt', () => {
    const ledger: DeathLedger = new Map();
    const event = makeDeathEvent({
      type: 'scheduler_dispatch_failed',
      reason: 'no available workers',
    });

    const response = classifyDeathEvent(event, ledger);

    expect(response.action).toBe('halt');
    expect(response.surfaceToHuman).toBe(true);
    expect(response.reason).toContain('Scheduler dispatch failed');
    expect(response.reason).toContain('no available workers');
  });

  test('different tasks tracked independently', () => {
    const ledger: DeathLedger = new Map();

    // Task A dies once → retry
    const a1 = classifyDeathEvent(makeDeathEvent({ taskId: 'task-a' }), ledger);
    expect(a1.action).toBe('retry');

    // Task B dies once → retry (independent)
    const b1 = classifyDeathEvent(makeDeathEvent({ taskId: 'task-b' }), ledger);
    expect(b1.action).toBe('retry');

    // Task A dies again → investigate
    const a2 = classifyDeathEvent(makeDeathEvent({ taskId: 'task-a' }), ledger);
    expect(a2.action).toBe('investigate');

    // Task B still has 1 retry left → retry
    // (but next death will trigger investigate since maxRetries=1)
    const b2 = classifyDeathEvent(makeDeathEvent({ taskId: 'task-b' }), ledger);
    expect(b2.action).toBe('investigate');
  });

  test('custom maxRetries policy', () => {
    const ledger: DeathLedger = new Map();
    const policy: FailurePolicy = { ...DEFAULT_FAILURE_POLICY, maxRetries: 3 };
    const event = makeDeathEvent();

    // Deaths 1-3: retry
    for (let i = 0; i < 3; i++) {
      const r = classifyDeathEvent(event, ledger, policy);
      expect(r.action).toBe('retry');
    }

    // Death 4: investigate
    const r = classifyDeathEvent(event, ledger, policy);
    expect(r.action).toBe('investigate');
  });

  test('unknown taskId defaults to "unknown"', () => {
    const ledger: DeathLedger = new Map();
    const event = makeDeathEvent({ taskId: undefined });

    const response = classifyDeathEvent(event, ledger);
    expect(response.taskId).toBe('unknown');
    expect(ledger.get('unknown')).toBe(1);
  });
});

// --- detectMassDeath ---

describe('detectMassDeath', () => {
  test('below threshold → false', () => {
    const deaths = [makeDeathEvent(), makeDeathEvent()];
    expect(detectMassDeath(deaths)).toBe(false);
  });

  test('at threshold within window → true', () => {
    const now = new Date();
    const deaths = Array.from({ length: 3 }, (_, i) =>
      makeDeathEvent({ timestamp: new Date(now.getTime() - i * 1000).toISOString() }),
    );
    expect(detectMassDeath(deaths)).toBe(true);
  });

  test('at threshold but outside window → false', () => {
    const deaths = Array.from({ length: 3 }, () =>
      makeDeathEvent({
        timestamp: new Date(Date.now() - 600_000).toISOString(), // 10 min ago
      }),
    );
    expect(detectMassDeath(deaths)).toBe(false);
  });
});

// --- Orchestrator.handleDeathEvent ---

describe('Orchestrator.handleDeathEvent', () => {
  test('single death → retry, dispatch not halted', () => {
    const orch = rig.createOrchestrator();
    const event = makeDeathEvent();

    const response = orch.handleDeathEvent(event);

    expect(response.action).toBe('retry');
    expect(orch.isDispatchHalted()).toBe(false);
  });

  test('repeated death → investigate, dispatch not halted', () => {
    const orch = rig.createOrchestrator();
    const event = makeDeathEvent();

    orch.handleDeathEvent(event); // retry
    const response = orch.handleDeathEvent(event); // investigate

    expect(response.action).toBe('investigate');
    // investigate doesn't halt dispatch — it triggers diagnosis
    expect(orch.isDispatchHalted()).toBe(false);
  });

  test('mass_death event → halt dispatch', () => {
    const orch = rig.createOrchestrator();
    const event = makeDeathEvent({
      type: 'mass_death',
      count: 5,
      windowSeconds: 60,
    });

    const response = orch.handleDeathEvent(event);

    expect(response.action).toBe('halt');
    expect(orch.isDispatchHalted()).toBe(true);
  });

  test('accumulated session_deaths trigger synthetic mass_death', () => {
    const orch = rig.createOrchestrator();
    orch.setFailurePolicy({ massDeathThreshold: 3, massDeathWindowSeconds: 300 });

    const now = new Date();

    // 3 different tasks dying triggers mass death detection
    const r1 = orch.handleDeathEvent(makeDeathEvent({
      taskId: 'task-1',
      timestamp: new Date(now.getTime() - 2000).toISOString(),
    }));
    expect(r1.action).toBe('retry');

    const r2 = orch.handleDeathEvent(makeDeathEvent({
      taskId: 'task-2',
      timestamp: new Date(now.getTime() - 1000).toISOString(),
    }));
    expect(r2.action).toBe('retry');

    const r3 = orch.handleDeathEvent(makeDeathEvent({
      taskId: 'task-3',
      timestamp: now.toISOString(),
    }));
    // Third death triggers mass death detection
    expect(r3.action).toBe('halt');
    expect(orch.isDispatchHalted()).toBe(true);
  });

  test('resumeDispatch clears halt and recent deaths', () => {
    const orch = rig.createOrchestrator();
    orch.handleDeathEvent(makeDeathEvent({ type: 'mass_death', count: 5 }));
    expect(orch.isDispatchHalted()).toBe(true);

    orch.resumeDispatch();

    expect(orch.isDispatchHalted()).toBe(false);
  });

  test('death ledger tracks per-task counts', () => {
    const orch = rig.createOrchestrator();
    // Raise threshold so individual deaths don't trigger mass death
    orch.setFailurePolicy({ massDeathThreshold: 10 });

    orch.handleDeathEvent(makeDeathEvent({ taskId: 'task-x' }));
    orch.handleDeathEvent(makeDeathEvent({ taskId: 'task-x' }));
    orch.handleDeathEvent(makeDeathEvent({ taskId: 'task-y' }));

    const ledger = orch.getDeathLedger();
    expect(ledger.get('task-x')).toBe(2);
    expect(ledger.get('task-y')).toBe(1);
  });
});

// --- QualityAdapter classify-death command ---

describe('QualityAdapter classify-death', () => {
  test('routes classify-death through adapter execute()', async () => {
    const adapter = new QualityAdapter();
    const event = makeDeathEvent();

    const result = await adapter.execute('classify-death', { event });
    const parsed = JSON.parse(result);

    expect(parsed.action).toBe('retry');
    expect(parsed.taskId).toBe('task-abc');
  });

  test('repeated calls track state in ledger', async () => {
    const adapter = new QualityAdapter();
    const event = makeDeathEvent();

    await adapter.execute('classify-death', { event });
    const result = await adapter.execute('classify-death', { event });
    const parsed = JSON.parse(result);

    expect(parsed.action).toBe('investigate');
  });

  test('accepts event as JSON string', async () => {
    const adapter = new QualityAdapter();
    const event = makeDeathEvent({ type: 'mass_death', count: 5 });

    const result = await adapter.execute('classify-death', {
      event: JSON.stringify(event),
    });
    const parsed = JSON.parse(result);

    expect(parsed.action).toBe('halt');
  });

  test('failure-policy command returns configuration', async () => {
    const adapter = new QualityAdapter({
      failurePolicy: { maxRetries: 5 },
    });

    const result = await adapter.execute('failure-policy');
    const parsed = JSON.parse(result);

    expect(parsed.maxRetries).toBe(5);
    expect(parsed.massDeathThreshold).toBe(3); // default
  });

  test('resetDeathLedger clears tracking', async () => {
    const adapter = new QualityAdapter();
    const event = makeDeathEvent();

    await adapter.execute('classify-death', { event });
    expect(adapter.getDeathLedger().get('task-abc')).toBe(1);

    adapter.resetDeathLedger();
    expect(adapter.getDeathLedger().size).toBe(0);
  });
});
