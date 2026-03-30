/**
 * Tests for extract.ts — task extraction reconciliation (ga-4c7).
 *
 * Gate tier: tests reconciliation logic and title similarity (deterministic, no LLM).
 * LLM extraction tests are periodic tier (require ANTHROPIC_API_KEY).
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { createTestRig, type TestRig } from './test-rig.js';
import {
  extractTasks,
  titleSimilarity,
  reconcile,
  type ExtractionResult,
  type LLMExtractionResult,
  type LLMExtractedTask,
} from '../extract.js';

let rig: TestRig;

beforeEach(() => {
  rig = createTestRig();
});

afterEach(() => {
  rig.cleanup();
});

// --- Title similarity ---

describe('titleSimilarity', () => {
  test('identical titles → 1.0', () => {
    expect(titleSimilarity('Wire review-suite adapter', 'Wire review-suite adapter')).toBe(1);
  });

  test('completely different titles → 0.0', () => {
    expect(titleSimilarity('Implement auth flow', 'Deploy monitoring stack')).toBe(0);
  });

  test('partial overlap scores between 0 and 1', () => {
    const score = titleSimilarity(
      'Wire review-suite adapter command',
      'Wire the review suite adapter',
    );
    expect(score).toBeGreaterThan(0.5);
    expect(score).toBeLessThan(1);
  });

  test('case insensitive', () => {
    expect(titleSimilarity('Wire Adapter', 'wire adapter')).toBe(1);
  });

  test('ignores punctuation', () => {
    expect(titleSimilarity('test $(whoami) injection', 'test whoami injection')).toBeGreaterThan(0.5);
  });

  test('both empty → 1.0', () => {
    expect(titleSimilarity('', '')).toBe(1);
  });

  test('one empty → 0.0', () => {
    expect(titleSimilarity('something', '')).toBe(0);
  });
});

// --- Reconciliation ---

/** Build a mock regex ExtractionResult from task tuples. */
function mockRegex(
  tasks: Array<{ number: number; title: string }>,
  opts?: { hasTasksSection?: boolean; hasNextSteps?: boolean },
): ExtractionResult {
  return {
    tasks: tasks.map((t) => ({
      number: t.number,
      title: t.title,
      body: `Body for task ${t.number}`,
      hasAcceptanceCriteria: true,
    })),
    hasTasksSection: opts?.hasTasksSection ?? true,
    hasNextSteps: opts?.hasNextSteps ?? false,
    method: 'regex',
  };
}

/** Build a mock LLM ExtractionResult from task tuples. */
function mockLLM(
  tasks: Array<{ number: number; title: string }>,
  opts?: { hasTasksSection?: boolean; hasNextSteps?: boolean },
): LLMExtractionResult {
  return {
    tasks: tasks.map((t) => ({
      number: t.number,
      title: t.title,
      description: `Description for task ${t.number}`,
      acceptanceCriteria: [`Criterion for task ${t.number}`],
    })),
    hasTasksSection: opts?.hasTasksSection ?? true,
    hasNextSteps: opts?.hasNextSteps ?? false,
    raw: '{}',
    method: 'llm',
    model: 'claude-haiku-4-5-20251001',
  };
}

describe('reconcile', () => {
  test('perfect match — same tasks, same titles', () => {
    const tasks = [
      { number: 1, title: 'Wire review-suite adapter command' },
      { number: 2, title: 'Implement quality policy evaluation' },
      { number: 3, title: 'Add quality adapter to orchestrator' },
    ];
    const result = reconcile(mockRegex(tasks), mockLLM(tasks));

    expect(result.stats.total).toBe(3);
    expect(result.stats.matched).toBe(3);
    expect(result.stats.titleMismatches).toBe(0);
    expect(result.stats.regexOnly).toBe(0);
    expect(result.stats.llmOnly).toBe(0);

    // All tasks should be 'matched' with similarity 1.0
    for (const task of result.tasks) {
      expect(task.status).toBe('matched');
      expect(task.titleSimilarity).toBe(1);
      expect(task.regex).not.toBeNull();
      expect(task.llm).not.toBeNull();
    }
  });

  test('title mismatch — same numbers but different titles', () => {
    const regex = mockRegex([
      { number: 1, title: 'Wire adapter' },
    ]);
    const llm = mockLLM([
      { number: 1, title: 'Deploy monitoring' },
    ]);
    const result = reconcile(regex, llm);

    expect(result.stats.total).toBe(1);
    expect(result.stats.titleMismatches).toBe(1);
    expect(result.tasks[0].status).toBe('title-mismatch');
    expect(result.tasks[0].titleSimilarity).toBeLessThan(0.6);
  });

  test('regex-only — task found by regex but not LLM', () => {
    const regex = mockRegex([
      { number: 1, title: 'Task A' },
      { number: 2, title: 'Task B' },
    ]);
    const llm = mockLLM([
      { number: 1, title: 'Task A' },
    ]);
    const result = reconcile(regex, llm);

    expect(result.stats.total).toBe(2);
    expect(result.stats.matched).toBe(1);
    expect(result.stats.regexOnly).toBe(1);

    const regexOnly = result.tasks.find((t) => t.status === 'regex-only');
    expect(regexOnly).toBeTruthy();
    expect(regexOnly!.number).toBe(2);
    expect(regexOnly!.regex).not.toBeNull();
    expect(regexOnly!.llm).toBeNull();
    expect(regexOnly!.titleSimilarity).toBeNull();
  });

  test('llm-only — task found by LLM but not regex', () => {
    const regex = mockRegex([
      { number: 1, title: 'Task A' },
    ]);
    const llm = mockLLM([
      { number: 1, title: 'Task A' },
      { number: 2, title: 'Task B (inferred)' },
    ]);
    const result = reconcile(regex, llm);

    expect(result.stats.total).toBe(2);
    expect(result.stats.matched).toBe(1);
    expect(result.stats.llmOnly).toBe(1);

    const llmOnly = result.tasks.find((t) => t.status === 'llm-only');
    expect(llmOnly).toBeTruthy();
    expect(llmOnly!.number).toBe(2);
    expect(llmOnly!.regex).toBeNull();
    expect(llmOnly!.llm).not.toBeNull();
  });

  test('empty results — both return no tasks', () => {
    const regex = mockRegex([]);
    const llm = mockLLM([]);
    const result = reconcile(regex, llm);

    expect(result.stats.total).toBe(0);
    expect(result.tasks).toHaveLength(0);
  });

  test('tasks sorted by number', () => {
    const regex = mockRegex([
      { number: 3, title: 'Task C' },
      { number: 1, title: 'Task A' },
    ]);
    const llm = mockLLM([
      { number: 2, title: 'Task B' },
      { number: 1, title: 'Task A' },
    ]);
    const result = reconcile(regex, llm);

    expect(result.tasks.map((t) => t.number)).toEqual([1, 2, 3]);
  });

  test('canonical title prefers regex (deterministic)', () => {
    const regex = mockRegex([
      { number: 1, title: 'Wire review-suite adapter command' },
    ]);
    const llm = mockLLM([
      { number: 1, title: 'Wire the review suite adapter command' },
    ]);
    const result = reconcile(regex, llm);

    // Regex title wins when matched
    expect(result.tasks[0].title).toBe('Wire review-suite adapter command');
  });

  test('llm-only tasks use LLM title as canonical', () => {
    const regex = mockRegex([]);
    const llm = mockLLM([
      { number: 1, title: 'Inferred task from prose' },
    ]);
    const result = reconcile(regex, llm);

    expect(result.tasks[0].title).toBe('Inferred task from prose');
  });
});

// --- Integration: reconcile with real fixture extraction ---

describe('reconcile with fixture design docs', () => {
  test('standard.md — regex + simulated LLM agree on 3 tasks', () => {
    const markdown = rig.readFixture('design-docs', 'standard.md');
    const regexResult = extractTasks(markdown);

    // Simulate LLM returning same tasks (perfect agreement)
    const llm = mockLLM(
      regexResult.tasks.map((t) => ({ number: t.number, title: t.title })),
      { hasTasksSection: true, hasNextSteps: true },
    );

    const result = reconcile(regexResult, llm);
    expect(result.stats.matched).toBe(3);
    expect(result.stats.total).toBe(3);
  });

  test('empty.md — both methods return empty', () => {
    const markdown = rig.readFixture('design-docs', 'empty.md');
    const regexResult = extractTasks(markdown);
    const llm = mockLLM([]);

    const result = reconcile(regexResult, llm);
    expect(result.stats.total).toBe(0);
  });

  test('injection.md — reconciliation preserves metacharacters', () => {
    const markdown = rig.readFixture('design-docs', 'injection.md');
    const regexResult = extractTasks(markdown);

    // Simulate LLM returning same dangerous titles
    const llm = mockLLM(
      regexResult.tasks.map((t) => ({ number: t.number, title: t.title })),
    );

    const result = reconcile(regexResult, llm);
    expect(result.stats.matched).toBe(3);

    // Verify titles still contain metacharacters (not sanitized away)
    const titles = result.tasks.map((t) => t.title);
    expect(titles[0]).toContain('$(whoami)');
    expect(titles[1]).toContain('; rm -rf /');
  });

  test('no-nextsteps.md — LLM finds extra inferred task', () => {
    const markdown = rig.readFixture('design-docs', 'no-nextsteps.md');
    const regexResult = extractTasks(markdown);

    // Simulate LLM finding an extra task it inferred from prose
    const llm = mockLLM([
      ...regexResult.tasks.map((t) => ({ number: t.number, title: t.title })),
      { number: 3, title: 'Write unit tests for JSON repair' },
    ]);

    const result = reconcile(regexResult, llm);
    expect(result.stats.matched).toBe(2);
    expect(result.stats.llmOnly).toBe(1);
    expect(result.tasks.find((t) => t.status === 'llm-only')?.title).toBe(
      'Write unit tests for JSON repair',
    );
  });
});
