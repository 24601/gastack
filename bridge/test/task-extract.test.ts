/**
 * Task extraction semantic verification against fixture design docs (ga-0bu).
 *
 * Gate tier: regex fast-path (deterministic, no LLM calls).
 * Verifies extractTasks() produces semantically correct results, not just
 * "didn't crash."
 *
 * 3 fixture design docs with known expectations:
 *   1. standard.md — 3 specific named tasks with acceptance criteria + Next Steps
 *   2. no-nextsteps.md — 2 tasks, no Next Steps section
 *   3. injection.md — 3 tasks with shell metacharacters in titles
 *   4. empty.md — no tasks section at all → graceful empty result
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { createTestRig, type TestRig } from './test-rig.js';
import {
  extractTasks,
  containsShellMetacharacters,
  type ExtractionResult,
} from '../task-extract.js';

let rig: TestRig;

beforeEach(() => {
  rig = createTestRig();
});

afterEach(() => {
  rig.cleanup();
});

/** Load a design doc fixture and run regex extraction. */
function extract(name: string): ExtractionResult {
  const markdown = rig.readFixture('design-docs', name);
  return extractTasks(markdown);
}

// --- Case 1: Standard doc with Next Steps ---

describe('standard.md — 3 named tasks with acceptance criteria', () => {
  test('extracts exactly 3 tasks', () => {
    const result = extract('standard.md');
    expect(result.tasks).toHaveLength(3);
  });

  test('tasks have correct titles (semantic match)', () => {
    const result = extract('standard.md');
    const titles = result.tasks.map((t) => t.title);

    // Exact titles from the fixture
    expect(titles[0]).toBe('Wire review-suite adapter command');
    expect(titles[1]).toBe('Implement quality policy evaluation');
    expect(titles[2]).toBe('Add quality adapter to orchestrator');
  });

  test('tasks are numbered 1-3 in order', () => {
    const result = extract('standard.md');
    expect(result.tasks.map((t) => t.number)).toEqual([1, 2, 3]);
  });

  test('all tasks have acceptance criteria', () => {
    const result = extract('standard.md');
    expect(result.tasks.every((t) => t.hasAcceptanceCriteria)).toBe(true);
  });

  test('task bodies contain expected content', () => {
    const result = extract('standard.md');

    // Task 1: review-suite adapter
    expect(result.tasks[0].body).toContain('Promise.all');
    expect(result.tasks[0].body).toContain('Grade parsing');

    // Task 2: quality policy
    expect(result.tasks[1].body).toContain('evaluate()');
    expect(result.tasks[1].body).toContain('BLOCKED');

    // Task 3: quality adapter
    expect(result.tasks[2].body).toContain('QualityAdapter');
    expect(result.tasks[2].body).toContain('REVIEW stage');
  });

  test('detects Tasks section and Next Steps', () => {
    const result = extract('standard.md');
    expect(result.hasTasksSection).toBe(true);
    expect(result.hasNextSteps).toBe(true);
  });

  test('uses regex method', () => {
    const result = extract('standard.md');
    expect(result.method).toBe('regex');
  });

  test('no shell metacharacters in task titles', () => {
    const result = extract('standard.md');
    for (const task of result.tasks) {
      expect(containsShellMetacharacters(task.title)).toBe(false);
    }
  });
});

// --- Case 2: Doc with no Next Steps section ---

describe('no-nextsteps.md — tasks without Next Steps', () => {
  test('extracts tasks despite missing Next Steps', () => {
    const result = extract('no-nextsteps.md');
    expect(result.tasks.length).toBeGreaterThanOrEqual(1);
    expect(result.tasks.length).toBeLessThanOrEqual(10);
  });

  test('extracts exactly 2 tasks', () => {
    const result = extract('no-nextsteps.md');
    expect(result.tasks).toHaveLength(2);
  });

  test('task titles match fixture content', () => {
    const result = extract('no-nextsteps.md');
    const titles = result.tasks.map((t) => t.title);

    expect(titles[0]).toBe('Detect truncation vs garbage');
    expect(titles[1]).toBe('Implement structural JSON repair');
  });

  test('detects no Next Steps section', () => {
    const result = extract('no-nextsteps.md');
    expect(result.hasNextSteps).toBe(false);
  });

  test('still has Tasks section', () => {
    const result = extract('no-nextsteps.md');
    expect(result.hasTasksSection).toBe(true);
  });

  test('tasks have acceptance criteria', () => {
    const result = extract('no-nextsteps.md');
    expect(result.tasks.every((t) => t.hasAcceptanceCriteria)).toBe(true);
  });
});

// --- Case 3: Shell metacharacters in task titles ---

describe('injection.md — shell metacharacters must be safe', () => {
  test('extracts 3 tasks with dangerous titles', () => {
    const result = extract('injection.md');
    expect(result.tasks).toHaveLength(3);
  });

  test('titles with metacharacters preserve them literally', () => {
    const result = extract('injection.md');
    const titles = result.tasks.map((t) => t.title);

    // Task 1 title contains $(whoami) — must be literal, not expanded
    expect(titles[0]).toContain('$(whoami)');
    expect(containsShellMetacharacters(titles[0])).toBe(true);

    // Task 2 title contains ; rm -rf / — must be literal
    expect(titles[1]).toContain('; rm -rf /');
    expect(containsShellMetacharacters(titles[1])).toBe(true);

    // Task 3 title references backtick injection (actual backticks are in body)
    expect(titles[2]).toContain('backtick injection');
  });

  test('task bodies contain shell metacharacters as literals', () => {
    const result = extract('injection.md');

    // Task 1 body: $(whoami) in description
    expect(result.tasks[0].body).toContain('$(whoami)');

    // Task 2 body: ; rm -rf / in args
    expect(result.tasks[1].body).toContain('; rm -rf /');

    // Task 3 body: backtick expression
    expect(result.tasks[2].body).toContain('`cat /etc/passwd`');
  });

  test('all extracted text is safe — no shell expansion occurred', () => {
    const result = extract('injection.md');

    for (const task of result.tasks) {
      // No control characters from shell expansion
      expect(task.title).not.toMatch(/[\x00-\x08\x0e-\x1f]/);
      expect(task.body).not.toMatch(/[\x00-\x08\x0e-\x1f]/);
    }
  });

  test('extraction result is safe to pass to queueTask', () => {
    const result = extract('injection.md');
    // queueTask stores the description as a string — titles must be literal,
    // not shell-interpreted. Verify they are non-empty preserved strings.
    for (const task of result.tasks) {
      expect(task.title.length).toBeGreaterThan(0);
      // Titles contain the words from the fixture headings
      expect(task.title).toMatch(/Test/);
    }
  });
});

// --- Case 4: Empty doc (no tasks section) ---

describe('empty.md — graceful handling of missing tasks', () => {
  test('returns empty tasks array', () => {
    const result = extract('empty.md');
    expect(result.tasks).toHaveLength(0);
  });

  test('detects missing Tasks section', () => {
    const result = extract('empty.md');
    expect(result.hasTasksSection).toBe(false);
  });

  test('detects missing Next Steps', () => {
    const result = extract('empty.md');
    expect(result.hasNextSteps).toBe(false);
  });

  test('uses regex method', () => {
    const result = extract('empty.md');
    expect(result.method).toBe('regex');
  });
});

// --- Cross-cutting: containsShellMetacharacters ---

describe('containsShellMetacharacters utility', () => {
  test('flags backtick', () => {
    expect(containsShellMetacharacters('hello `world`')).toBe(true);
  });

  test('flags dollar-paren', () => {
    expect(containsShellMetacharacters('$(cmd)')).toBe(true);
  });

  test('flags semicolon', () => {
    expect(containsShellMetacharacters('a; b')).toBe(true);
  });

  test('flags pipe', () => {
    expect(containsShellMetacharacters('a | b')).toBe(true);
  });

  test('flags ampersand', () => {
    expect(containsShellMetacharacters('a & b')).toBe(true);
  });

  test('passes clean title', () => {
    expect(containsShellMetacharacters('Wire review-suite adapter command')).toBe(false);
  });
});
