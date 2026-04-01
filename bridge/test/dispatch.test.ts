/**
 * Dispatch priority sorting and batch grouping tests.
 *
 * Gate tier: no network, no LLM, no gt binary required.
 *
 * Verifies:
 *   1. Security tasks always get P0 regardless of position
 *   2. Fix/bug tasks get P1
 *   3. Default tasks get P2
 *   4. Priority sorting: P0 first, then P1, then P2
 *   5. Within same priority, extraction order preserved
 *   6. Batch grouping respects --max-concurrent limit
 *   7. Full pipeline: prioritize + batch
 *   8. Mountain dispatch for large task sets (10+)
 *   9. Dispatch strategy selection (mountain vs convoy)
 */

import { describe, test, expect } from 'bun:test';
import {
  assignPriority,
  prioritize,
  batchTasks,
  planDispatch,
  batchBeadIds,
  stageAndLaunch,
  mountainDispatch,
  chooseDispatchStrategy,
  MOUNTAIN_THRESHOLD,
  type PrioritizedTask,
} from '../dispatch.js';
import type { ExtractedTask } from '../task-extract.js';
import type { Adapter } from '../orchestrate.js';

// --- Helpers ---

function makeTask(
  number: number,
  title: string,
  body: string = '',
): ExtractedTask {
  return { number, title, body, hasAcceptanceCriteria: false };
}

// --- Priority assignment ---

describe('assignPriority — security detection', () => {
  test('task with "auth" in title gets P0', () => {
    const result = assignPriority(makeTask(1, 'Fix auth bypass'));
    expect(result.priority).toBe(0);
    expect(result.reason).toContain('security');
  });

  test('task with "XSS" in body gets P0', () => {
    const result = assignPriority(makeTask(2, 'Clean up form', 'Prevent XSS in user input'));
    expect(result.priority).toBe(0);
  });

  test('task with "injection" keyword gets P0', () => {
    const result = assignPriority(makeTask(3, 'SQL injection prevention'));
    expect(result.priority).toBe(0);
  });

  test('task with "CSRF" gets P0 (case insensitive)', () => {
    const result = assignPriority(makeTask(4, 'Add CSRF Token'));
    expect(result.priority).toBe(0);
  });

  test('task with "credential" in body gets P0', () => {
    const result = assignPriority(makeTask(5, 'Update config', 'Rotate credential store'));
    expect(result.priority).toBe(0);
  });

  test('task with "sanitiz" matches sanitize/sanitization', () => {
    const result = assignPriority(makeTask(6, 'Sanitize input fields'));
    expect(result.priority).toBe(0);
  });
});

describe('assignPriority — critical fix detection', () => {
  test('task with "fix" in title gets P1', () => {
    const result = assignPriority(makeTask(1, 'Fix broken pagination'));
    expect(result.priority).toBe(1);
    expect(result.reason).toContain('critical fix');
  });

  test('task with "bug" in body gets P1', () => {
    const result = assignPriority(makeTask(2, 'Investigate issue', 'Known bug in parser'));
    expect(result.priority).toBe(1);
  });

  test('task with "crash" gets P1', () => {
    const result = assignPriority(makeTask(3, 'Handle crash on startup'));
    expect(result.priority).toBe(1);
  });

  test('task with "regression" gets P1', () => {
    const result = assignPriority(makeTask(4, 'Regression in v2.0'));
    expect(result.priority).toBe(1);
  });
});

describe('assignPriority — default priority', () => {
  test('feature task gets P2', () => {
    const result = assignPriority(makeTask(1, 'Add dark mode'));
    expect(result.priority).toBe(2);
    expect(result.reason).toBe('default priority');
  });

  test('refactor task gets P2', () => {
    const result = assignPriority(makeTask(2, 'Refactor state management'));
    expect(result.priority).toBe(2);
  });

  test('docs task gets P2', () => {
    const result = assignPriority(makeTask(3, 'Update README'));
    expect(result.priority).toBe(2);
  });
});

describe('assignPriority — security wins over fix', () => {
  test('task with both "fix" and "auth" gets P0 (security wins)', () => {
    const result = assignPriority(makeTask(1, 'Fix auth token rotation'));
    expect(result.priority).toBe(0);
  });
});

// --- Priority sorting ---

describe('prioritize — ordering', () => {
  test('security tasks sorted before feature tasks', () => {
    const tasks = [
      makeTask(1, 'Add dark mode'),
      makeTask(2, 'Fix XSS vulnerability'),
      makeTask(3, 'Refactor API'),
    ];

    const result = prioritize(tasks);

    expect(result[0].task.number).toBe(2); // XSS → P0
    expect(result[0].priority).toBe(0);
    expect(result[1].task.number).toBe(1); // dark mode → P2
    expect(result[2].task.number).toBe(3); // refactor → P2
  });

  test('mixed priorities sort correctly: P0 → P1 → P2', () => {
    const tasks = [
      makeTask(1, 'Add feature'),        // P2
      makeTask(2, 'Fix crash'),           // P1
      makeTask(3, 'Auth bypass'),         // P0
      makeTask(4, 'Update docs'),         // P2
      makeTask(5, 'Fix regression'),      // P1
      makeTask(6, 'CSRF protection'),     // P0
    ];

    const result = prioritize(tasks);
    const priorities = result.map((r) => r.priority);

    // All P0s first, then P1s, then P2s
    expect(priorities).toEqual([0, 0, 1, 1, 2, 2]);
  });

  test('within same priority, extraction order preserved', () => {
    const tasks = [
      makeTask(3, 'Feature C'),
      makeTask(1, 'Feature A'),
      makeTask(2, 'Feature B'),
    ];

    const result = prioritize(tasks);

    // All P2, sorted by task number
    expect(result.map((r) => r.task.number)).toEqual([1, 2, 3]);
  });

  test('empty input returns empty output', () => {
    expect(prioritize([])).toEqual([]);
  });

  test('single task returns single-element array', () => {
    const result = prioritize([makeTask(1, 'Solo task')]);
    expect(result).toHaveLength(1);
    expect(result[0].task.number).toBe(1);
  });
});

// --- Batch grouping ---

describe('batchTasks — grouping', () => {
  function makePrioritized(n: number, priority: 0 | 1 | 2 = 2): PrioritizedTask {
    return {
      task: makeTask(n, `Task ${n}`),
      priority,
      reason: 'test',
    };
  }

  test('6 tasks with maxConcurrent=2 yields 3 batches', () => {
    const tasks = [1, 2, 3, 4, 5, 6].map((n) => makePrioritized(n));
    const batches = batchTasks(tasks, 2);

    expect(batches).toHaveLength(3);
    expect(batches[0]).toHaveLength(2);
    expect(batches[1]).toHaveLength(2);
    expect(batches[2]).toHaveLength(2);
  });

  test('5 tasks with maxConcurrent=3 yields 2 batches (3+2)', () => {
    const tasks = [1, 2, 3, 4, 5].map((n) => makePrioritized(n));
    const batches = batchTasks(tasks, 3);

    expect(batches).toHaveLength(2);
    expect(batches[0]).toHaveLength(3);
    expect(batches[1]).toHaveLength(2);
  });

  test('tasks fewer than maxConcurrent yields 1 batch', () => {
    const tasks = [1, 2].map((n) => makePrioritized(n));
    const batches = batchTasks(tasks, 5);

    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(2);
  });

  test('empty input yields empty output', () => {
    expect(batchTasks([], 3)).toEqual([]);
  });

  test('maxConcurrent=0 is clamped to 1', () => {
    const tasks = [1, 2, 3].map((n) => makePrioritized(n));
    const batches = batchTasks(tasks, 0);

    expect(batches).toHaveLength(3);
    expect(batches[0]).toHaveLength(1);
  });

  test('default maxConcurrent is 4', () => {
    const tasks = [1, 2, 3, 4, 5].map((n) => makePrioritized(n));
    const batches = batchTasks(tasks);

    expect(batches).toHaveLength(2);
    expect(batches[0]).toHaveLength(4);
    expect(batches[1]).toHaveLength(1);
  });

  test('batch order preserves input order (priority-sorted)', () => {
    const tasks = [
      makePrioritized(3, 0),  // security
      makePrioritized(1, 1),  // fix
      makePrioritized(2, 2),  // feature
      makePrioritized(4, 2),  // feature
    ];
    const batches = batchTasks(tasks, 2);

    // First batch: highest priority tasks
    expect(batches[0][0].priority).toBe(0);
    expect(batches[0][1].priority).toBe(1);
    // Second batch: lower priority
    expect(batches[1][0].priority).toBe(2);
    expect(batches[1][1].priority).toBe(2);
  });
});

// --- Full pipeline ---

describe('planDispatch — end-to-end', () => {
  test('security tasks always in first batch', () => {
    const tasks = [
      makeTask(1, 'Add feature A'),
      makeTask(2, 'Add feature B'),
      makeTask(3, 'Fix CSRF vulnerability'),
      makeTask(4, 'Add feature C'),
    ];

    const batches = planDispatch(tasks, 2);

    // First batch should contain the CSRF task (P0)
    expect(batches[0].some((t) => t.priority === 0)).toBe(true);
    expect(batches[0][0].task.title).toContain('CSRF');
  });

  test('realistic dispatch: mixed security + features with maxConcurrent=3', () => {
    const tasks = [
      makeTask(1, 'Add dark mode toggle'),           // P2
      makeTask(2, 'Fix SQL injection in search'),     // P0
      makeTask(3, 'Refactor auth token handling'),    // P0 (auth)
      makeTask(4, 'Fix pagination crash'),            // P1
      makeTask(5, 'Update API docs'),                 // P2
      makeTask(6, 'Add rate limiting'),               // P2
    ];

    const batches = planDispatch(tasks, 3);

    // Batch 1: P0 tasks first (SQL injection #2, auth #3), then P1 (crash #4)
    expect(batches[0].map((t) => t.priority)).toEqual([0, 0, 1]);

    // Batch 2: remaining P2 tasks
    expect(batches[1].map((t) => t.priority)).toEqual([2, 2, 2]);
  });
});

// --- batchBeadIds ---

describe('batchBeadIds — extract IDs for sling command', () => {
  test('extracts bead IDs from tasks that have them', () => {
    const batch: PrioritizedTask[] = [
      { task: makeTask(1, 'Task 1'), priority: 0, reason: 'test', beadId: 'ga-001' },
      { task: makeTask(2, 'Task 2'), priority: 1, reason: 'test', beadId: 'ga-002' },
      { task: makeTask(3, 'Task 3'), priority: 2, reason: 'test', beadId: 'ga-003' },
    ];

    expect(batchBeadIds(batch)).toEqual(['ga-001', 'ga-002', 'ga-003']);
  });

  test('skips tasks without beadId', () => {
    const batch: PrioritizedTask[] = [
      { task: makeTask(1, 'Task 1'), priority: 0, reason: 'test', beadId: 'ga-001' },
      { task: makeTask(2, 'Task 2'), priority: 1, reason: 'test' },
      { task: makeTask(3, 'Task 3'), priority: 2, reason: 'test', beadId: 'ga-003' },
    ];

    expect(batchBeadIds(batch)).toEqual(['ga-001', 'ga-003']);
  });

  test('empty batch returns empty array', () => {
    expect(batchBeadIds([])).toEqual([]);
  });
});

// --- stageAndLaunch ---

/** Mock adapter that records calls and returns configured responses. */
function mockAdapter(responses: Record<string, string | Error>): Adapter & { calls: Array<{ command: string; args?: Record<string, unknown> }> } {
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  return {
    name: 'mock-gastown',
    calls,
    async execute(command: string, args?: Record<string, unknown>): Promise<string> {
      calls.push({ command, args });
      const response = responses[command];
      if (response instanceof Error) throw response;
      return response ?? '';
    },
  };
}

describe('stageAndLaunch — convoy dispatch', () => {
  test('stages and launches convoy successfully', async () => {
    const adapter = mockAdapter({
      'convoy.stage': JSON.stringify({ convoy_id: 'hq-abc123' }),
      'convoy.launch': 'Convoy hq-abc123 launched',
    });

    const result = await stageAndLaunch(['ga-001', 'ga-002'], adapter, {
      title: 'Test convoy',
    });

    expect(result.ok).toBe(true);
    expect(result.convoyId).toBe('hq-abc123');
    expect(result.fellBackToSling).toBe(false);
    expect(adapter.calls).toHaveLength(2);
    expect(adapter.calls[0].command).toBe('convoy.stage');
    expect(adapter.calls[0].args?.beadIds).toEqual(['ga-001', 'ga-002']);
    expect(adapter.calls[0].args?.title).toBe('Test convoy');
    expect(adapter.calls[1].command).toBe('convoy.launch');
    expect(adapter.calls[1].args?.convoyId).toBe('hq-abc123');
  });

  test('falls back to sling.batch when stage fails', async () => {
    const adapter = mockAdapter({
      'convoy.stage': new Error('stage command not found'),
      'sling.batch': 'Slung 2 beads',
    });

    const result = await stageAndLaunch(['ga-001', 'ga-002'], adapter, {
      rig: 'gastack',
      maxConcurrent: 3,
    });

    expect(result.ok).toBe(true);
    expect(result.fellBackToSling).toBe(true);
    expect(result.error).toContain('stage/launch failed');
    expect(adapter.calls).toHaveLength(2);
    expect(adapter.calls[1].command).toBe('sling.batch');
    expect(adapter.calls[1].args?.beadIds).toEqual(['ga-001', 'ga-002']);
    expect(adapter.calls[1].args?.maxConcurrent).toBe(3);
  });

  test('falls back to sling.batch when launch fails', async () => {
    const adapter = mockAdapter({
      'convoy.stage': JSON.stringify({ convoy_id: 'hq-abc123' }),
      'convoy.launch': new Error('launch failed: no workers available'),
      'sling.batch': 'Slung 2 beads',
    });

    const result = await stageAndLaunch(['ga-001', 'ga-002'], adapter);

    expect(result.ok).toBe(true);
    expect(result.fellBackToSling).toBe(true);
    expect(result.error).toContain('stage/launch failed');
  });

  test('reports failure when both stage and sling fallback fail', async () => {
    const adapter = mockAdapter({
      'convoy.stage': new Error('stage failed'),
      'sling.batch': new Error('sling failed too'),
    });

    const result = await stageAndLaunch(['ga-001'], adapter);

    expect(result.ok).toBe(false);
    expect(result.fellBackToSling).toBe(true);
    expect(result.error).toContain('both stage/launch and sling fallback failed');
    expect(result.error).toContain('stage failed');
    expect(result.error).toContain('sling failed too');
  });

  test('empty beadIds returns ok without calling adapter', async () => {
    const adapter = mockAdapter({});

    const result = await stageAndLaunch([], adapter);

    expect(result.ok).toBe(true);
    expect(result.fellBackToSling).toBe(false);
    expect(adapter.calls).toHaveLength(0);
  });

  test('parses convoy ID from "id" field', async () => {
    const adapter = mockAdapter({
      'convoy.stage': JSON.stringify({ id: 'hq-xyz789' }),
      'convoy.launch': 'Launched',
    });

    const result = await stageAndLaunch(['ga-001'], adapter);

    expect(result.convoyId).toBe('hq-xyz789');
  });

  test('parses convoy ID from text output when JSON fails', async () => {
    const adapter = mockAdapter({
      'convoy.stage': 'Convoy hq-fallback staged successfully',
      'convoy.launch': 'Launched',
    });

    const result = await stageAndLaunch(['ga-001'], adapter);

    expect(result.convoyId).toBe('hq-fallback');
  });

  test('defaults rig and maxConcurrent in sling fallback', async () => {
    const adapter = mockAdapter({
      'convoy.stage': new Error('stage unavailable'),
      'sling.batch': 'OK',
    });

    await stageAndLaunch(['ga-001'], adapter);

    const slingCall = adapter.calls.find((c) => c.command === 'sling.batch');
    expect(slingCall?.args?.rig).toBe('');
    expect(slingCall?.args?.maxConcurrent).toBe(4);
  });
});

// --- chooseDispatchStrategy ---

describe('chooseDispatchStrategy — threshold selection', () => {
  test('returns convoy for task count below threshold', () => {
    expect(chooseDispatchStrategy(5)).toBe('convoy');
    expect(chooseDispatchStrategy(9)).toBe('convoy');
  });

  test('returns mountain for task count at threshold', () => {
    expect(chooseDispatchStrategy(10)).toBe('mountain');
  });

  test('returns mountain for task count above threshold', () => {
    expect(chooseDispatchStrategy(15)).toBe('mountain');
    expect(chooseDispatchStrategy(50)).toBe('mountain');
  });

  test('custom threshold works', () => {
    expect(chooseDispatchStrategy(3, 5)).toBe('convoy');
    expect(chooseDispatchStrategy(5, 5)).toBe('mountain');
    expect(chooseDispatchStrategy(7, 5)).toBe('mountain');
  });

  test('threshold of 1 always returns mountain (except 0)', () => {
    expect(chooseDispatchStrategy(0, 1)).toBe('convoy');
    expect(chooseDispatchStrategy(1, 1)).toBe('mountain');
  });

  test('default threshold is MOUNTAIN_THRESHOLD (10)', () => {
    expect(MOUNTAIN_THRESHOLD).toBe(10);
  });
});

// --- mountainDispatch ---

describe('mountainDispatch — mountain activation', () => {
  test('activates mountain successfully', async () => {
    const adapter = mockAdapter({
      'mountain': JSON.stringify({ mountain_id: 'hq-mtn-001', convoy_id: 'hq-conv-001' }),
    });

    const result = await mountainDispatch('ga-epic-1', ['ga-001', 'ga-002'], adapter);

    expect(result.ok).toBe(true);
    expect(result.mountainId).toBe('hq-mtn-001');
    expect(result.fellBackToConvoy).toBe(false);
    expect(result.fellBackToSling).toBe(false);
    expect(adapter.calls).toHaveLength(1);
    expect(adapter.calls[0].command).toBe('mountain');
    expect(adapter.calls[0].args?.epicId).toBe('ga-epic-1');
  });

  test('parses convoy_id when mountain_id absent', async () => {
    const adapter = mockAdapter({
      'mountain': JSON.stringify({ convoy_id: 'hq-conv-002' }),
    });

    const result = await mountainDispatch('ga-epic-2', ['ga-001'], adapter);

    expect(result.ok).toBe(true);
    expect(result.mountainId).toBe('hq-conv-002');
  });

  test('parses id field as fallback', async () => {
    const adapter = mockAdapter({
      'mountain': JSON.stringify({ id: 'hq-id-003' }),
    });

    const result = await mountainDispatch('ga-epic-3', ['ga-001'], adapter);

    expect(result.ok).toBe(true);
    expect(result.mountainId).toBe('hq-id-003');
  });

  test('parses text output when JSON fails', async () => {
    const adapter = mockAdapter({
      'mountain': 'Mountain hq-mtn-text activated',
    });

    const result = await mountainDispatch('ga-epic-4', ['ga-001'], adapter);

    expect(result.ok).toBe(true);
    expect(result.mountainId).toBe('hq-mtn-text');
  });

  test('falls back to convoy when mountain fails', async () => {
    const adapter = mockAdapter({
      'mountain': new Error('mountain command not available'),
      'convoy.stage': JSON.stringify({ convoy_id: 'hq-conv-fallback' }),
      'convoy.launch': 'Launched',
    });

    const result = await mountainDispatch('ga-epic-5', ['ga-001', 'ga-002'], adapter, {
      title: 'Test convoy fallback',
    });

    expect(result.ok).toBe(true);
    expect(result.mountainId).toBe('hq-conv-fallback');
    expect(result.fellBackToConvoy).toBe(true);
    expect(result.fellBackToSling).toBe(false);
    expect(result.error).toContain('mountain failed');
    expect(result.error).toContain('fell back to convoy');
  });

  test('falls back to sling when both mountain and convoy fail', async () => {
    const adapter = mockAdapter({
      'mountain': new Error('mountain unavailable'),
      'convoy.stage': new Error('stage unavailable'),
      'sling.batch': 'Slung 2 beads',
    });

    const result = await mountainDispatch('ga-epic-6', ['ga-001', 'ga-002'], adapter, {
      rig: 'gastack',
    });

    expect(result.ok).toBe(true);
    expect(result.fellBackToConvoy).toBe(false);
    expect(result.fellBackToSling).toBe(true);
    expect(result.error).toContain('mountain failed');
  });

  test('reports failure when all three strategies fail', async () => {
    const adapter = mockAdapter({
      'mountain': new Error('mountain unavailable'),
      'convoy.stage': new Error('stage unavailable'),
      'sling.batch': new Error('sling unavailable'),
    });

    const result = await mountainDispatch('ga-epic-7', ['ga-001'], adapter);

    expect(result.ok).toBe(false);
    expect(result.fellBackToConvoy).toBe(false);
    expect(result.fellBackToSling).toBe(true);
    expect(result.error).toContain('mountain failed');
  });

  test('empty beadIds returns ok without calling adapter', async () => {
    const adapter = mockAdapter({});

    const result = await mountainDispatch('ga-epic-8', [], adapter);

    expect(result.ok).toBe(true);
    expect(result.fellBackToConvoy).toBe(false);
    expect(result.fellBackToSling).toBe(false);
    expect(adapter.calls).toHaveLength(0);
  });

  test('passes force flag to mountain command', async () => {
    const adapter = mockAdapter({
      'mountain': JSON.stringify({ mountain_id: 'hq-mtn-force' }),
    });

    await mountainDispatch('ga-epic-9', ['ga-001'], adapter, { force: true });

    expect(adapter.calls[0].args?.force).toBe(true);
  });

  test('passes fallback options through to stageAndLaunch', async () => {
    const adapter = mockAdapter({
      'mountain': new Error('unavailable'),
      'convoy.stage': JSON.stringify({ convoy_id: 'hq-fallback' }),
      'convoy.launch': 'OK',
    });

    await mountainDispatch('ga-epic-10', ['ga-001'], adapter, {
      title: 'My title',
      rig: 'gastack',
      maxConcurrent: 6,
    });

    const stageCall = adapter.calls.find((c) => c.command === 'convoy.stage');
    expect(stageCall?.args?.title).toBe('My title');
  });
});
