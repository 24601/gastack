/**
 * Review cycle tests — checkpoint/resume for review-fix-rereview loop.
 *
 * Verifies:
 *   1. shouldReiterate() decision logic
 *   2. extractFixableFindings() filtering
 *   3. resolvedFindings() cross-iteration comparison
 *   4. summarizeIteration() output formatting
 *   5. Orchestrator.reviewCycle() full loop behavior
 *   6. Iteration history derivation from event log
 *   7. --resume flag in gastown adapter done command
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
  shouldReiterate,
  extractFixableFindings,
  resolvedFindings,
  summarizeIteration,
  evaluate,
  type QualityIteration,
  type QualityReport,
  type ReviewLoopPolicy,
  DEFAULT_REVIEW_LOOP_POLICY,
} from '../quality.js';
import type { Finding, ReviewResult, ReviewSuiteResult } from '../adapters/gstack.js';
import { createTestRig, type TestRig } from './test-rig.js';
import { RecordingAdapter } from './test-adapters.js';
import { TestableGasTownAdapter } from './cli-capture.js';

// --- Helpers ---

function makeReport(overall: 'PASS' | 'WARN' | 'BLOCKED', findings: Finding[] = []): QualityReport {
  return {
    overall,
    gates: [
      {
        gate: 'correctness',
        verdict: overall,
        reason: `Test ${overall}`,
        findings,
      },
    ],
    summary: `Quality: ${overall}`,
  };
}

function makeIteration(
  iteration: number,
  overall: 'PASS' | 'WARN' | 'BLOCKED',
  findings: Finding[] = [],
  fixesApplied: string[] = [],
): QualityIteration {
  return {
    iteration,
    report: makeReport(overall, findings),
    fixesApplied,
    remainingFindings: findings,
  };
}

// --- T: shouldReiterate decision logic ---

describe('shouldReiterate', () => {
  test('returns true when fixable findings exist and under max iterations', () => {
    const iter = makeIteration(1, 'BLOCKED', [
      { severity: 'MAJOR', description: 'Missing error handling' },
    ]);
    expect(shouldReiterate(iter)).toBe(true);
  });

  test('returns false at max iterations', () => {
    const iter = makeIteration(3, 'BLOCKED', [
      { severity: 'MAJOR', description: 'Bug' },
    ]);
    expect(shouldReiterate(iter)).toBe(false);
  });

  test('returns false when only CRITICAL findings remain', () => {
    const iter = makeIteration(1, 'BLOCKED', [
      { severity: 'CRITICAL', description: 'SQL injection vulnerability' },
    ]);
    expect(shouldReiterate(iter)).toBe(false);
  });

  test('returns false when no findings remain', () => {
    const iter = makeIteration(1, 'BLOCKED', []);
    expect(shouldReiterate(iter)).toBe(false);
  });

  test('returns false when no progress was made (iteration > 1, no fixes)', () => {
    const iter = makeIteration(2, 'BLOCKED', [
      { severity: 'MAJOR', description: 'Same bug' },
    ], []);
    expect(shouldReiterate(iter)).toBe(false);
  });

  test('returns true when progress was made (fixes applied)', () => {
    const iter = makeIteration(2, 'BLOCKED', [
      { severity: 'MINOR', description: 'Style issue' },
    ], ['Resolved [MAJOR]: Fixed error handling']);
    expect(shouldReiterate(iter)).toBe(true);
  });

  test('respects custom maxIterations policy', () => {
    const iter = makeIteration(1, 'BLOCKED', [
      { severity: 'MAJOR', description: 'Bug' },
    ]);
    const policy: ReviewLoopPolicy = { maxIterations: 1 };
    expect(shouldReiterate(iter, policy)).toBe(false);
  });

  test('iteration 1 with no fixes applied still returns true (first pass)', () => {
    const iter = makeIteration(1, 'BLOCKED', [
      { severity: 'MINOR', description: 'Typo' },
    ], []);
    expect(shouldReiterate(iter)).toBe(true);
  });

  test('mixed CRITICAL and fixable: returns true (fixable ones remain)', () => {
    const iter = makeIteration(1, 'BLOCKED', [
      { severity: 'CRITICAL', description: 'Auth bypass' },
      { severity: 'MAJOR', description: 'Missing null check' },
    ]);
    expect(shouldReiterate(iter)).toBe(true);
  });

  test('CRITICAL-only at max iterations: returns false', () => {
    const iter = makeIteration(3, 'BLOCKED', [
      { severity: 'CRITICAL', description: 'Auth bypass' },
    ]);
    expect(shouldReiterate(iter)).toBe(false);
  });
});

// --- T: extractFixableFindings ---

describe('extractFixableFindings', () => {
  test('excludes CRITICAL findings', () => {
    const report = makeReport('BLOCKED', [
      { severity: 'CRITICAL', description: 'SQL injection' },
      { severity: 'MAJOR', description: 'Missing validation' },
      { severity: 'MINOR', description: 'Style issue' },
    ]);
    const fixable = extractFixableFindings(report);
    expect(fixable).toHaveLength(2);
    expect(fixable.every((f) => f.severity !== 'CRITICAL')).toBe(true);
  });

  test('returns empty for CRITICAL-only report', () => {
    const report = makeReport('BLOCKED', [
      { severity: 'CRITICAL', description: 'XSS vulnerability' },
    ]);
    expect(extractFixableFindings(report)).toHaveLength(0);
  });

  test('returns all for no-CRITICAL report', () => {
    const report = makeReport('BLOCKED', [
      { severity: 'MAJOR', description: 'Bug' },
      { severity: 'MINOR', description: 'Typo' },
    ]);
    expect(extractFixableFindings(report)).toHaveLength(2);
  });

  test('handles report with no findings', () => {
    const report = makeReport('PASS');
    expect(extractFixableFindings(report)).toHaveLength(0);
  });

  test('collects findings across multiple gates', () => {
    const report: QualityReport = {
      overall: 'BLOCKED',
      gates: [
        { gate: 'correctness', verdict: 'BLOCKED', reason: 'Low grade', findings: [
          { severity: 'MAJOR', description: 'Bug in auth' },
        ]},
        { gate: 'security', verdict: 'WARN', reason: 'Minor issue', findings: [
          { severity: 'MINOR', description: 'Weak hash' },
        ]},
      ],
      summary: 'BLOCKED',
    };
    const fixable = extractFixableFindings(report);
    expect(fixable).toHaveLength(2);
  });
});

// --- T: resolvedFindings ---

describe('resolvedFindings', () => {
  test('detects findings removed between iterations', () => {
    const prev: Finding[] = [
      { severity: 'MAJOR', description: 'Missing null check' },
      { severity: 'MINOR', description: 'Typo in variable name' },
    ];
    const curr: Finding[] = [
      { severity: 'MINOR', description: 'Typo in variable name' },
    ];
    const resolved = resolvedFindings(prev, curr);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].description).toBe('Missing null check');
  });

  test('returns empty when nothing resolved', () => {
    const findings: Finding[] = [
      { severity: 'MAJOR', description: 'Bug' },
    ];
    expect(resolvedFindings(findings, findings)).toHaveLength(0);
  });

  test('returns all when everything resolved', () => {
    const prev: Finding[] = [
      { severity: 'MAJOR', description: 'Bug' },
      { severity: 'MINOR', description: 'Typo' },
    ];
    const resolved = resolvedFindings(prev, []);
    expect(resolved).toHaveLength(2);
  });

  test('handles empty previous (first iteration)', () => {
    expect(resolvedFindings([], [{ severity: 'MAJOR', description: 'Bug' }])).toHaveLength(0);
  });
});

// --- T: summarizeIteration ---

describe('summarizeIteration', () => {
  test('includes iteration number and overall verdict', () => {
    const iter = makeIteration(2, 'BLOCKED', [
      { severity: 'MAJOR', description: 'Bug' },
    ], ['Resolved [MINOR]: Fixed typo']);
    const summary = summarizeIteration(iter);
    expect(summary).toContain('Iteration 2');
    expect(summary).toContain('BLOCKED');
    expect(summary).toContain('Fixes applied');
    expect(summary).toContain('Fixable');
  });

  test('shows CRITICAL findings separately', () => {
    const iter = makeIteration(1, 'BLOCKED', [
      { severity: 'CRITICAL', description: 'SQL injection' },
      { severity: 'MAJOR', description: 'Bug' },
    ]);
    const summary = summarizeIteration(iter);
    expect(summary).toContain('CRITICAL (needs human)');
    expect(summary).toContain('SQL injection');
    expect(summary).toContain('Fixable');
    expect(summary).toContain('Bug');
  });

  test('handles clean iteration with no findings', () => {
    const iter = makeIteration(1, 'PASS');
    const summary = summarizeIteration(iter);
    expect(summary).toContain('Iteration 1');
    expect(summary).toContain('PASS');
    expect(summary).toContain('Findings remaining: 0');
  });
});

// --- T: Orchestrator.reviewCycle ---

describe('Orchestrator.reviewCycle', () => {
  let rig: TestRig;

  beforeEach(() => {
    rig = createTestRig();
  });

  afterEach(() => {
    rig.cleanup();
  });

  function makeReviewSuiteResponse(grade: string, findings: Finding[] = []): string {
    const suite: ReviewSuiteResult = {
      review: { grade, findings, raw: `Grade: ${grade}` },
      cso: { grade: null, findings: [], raw: 'No security findings' },
    };
    return JSON.stringify(suite);
  }

  function advanceToReview(orch: ReturnType<typeof rig.createOrchestrator>): void {
    orch.enterStage('PLAN');
    orch.completeStage();
    orch.enterStage('EXECUTE');
    orch.completeStage();
    orch.enterStage('REVIEW');
  }

  test('passes on first review when quality is PASS', async () => {
    // All review dispatch now routes through gastown sling.review with --agent
    const gastown = new RecordingAdapter('gastown', {
      commandResponses: {
        'sling.review': makeReviewSuiteResponse('A'),
      },
    });
    const orch = rig.createOrchestrator({ gastown });
    advanceToReview(orch);

    const result = await orch.reviewCycle(
      { changedFiles: ['src/utils.ts'], totalChangedLines: 10 },
    );

    expect(result.passed).toBe(true);
    expect(result.approvalRequested).toBe(false);
    expect(result.iterations).toHaveLength(1);
    expect(result.report.overall).toBe('PASS');
  });

  test('passes on first review when quality is WARN', async () => {
    const gastown = new RecordingAdapter('gastown', {
      commandResponses: {
        'sling.review': makeReviewSuiteResponse('B', [
          { severity: 'MINOR', description: 'Style nit' },
        ]),
      },
    });
    const orch = rig.createOrchestrator({ gastown });
    advanceToReview(orch);

    const result = await orch.reviewCycle(
      { changedFiles: ['src/utils.ts'], totalChangedLines: 10 },
    );

    expect(result.passed).toBe(true);
    expect(result.iterations).toHaveLength(1);
  });

  test('loops on BLOCKED with fixable findings', async () => {
    let callCount = 0;
    const gastown = new RecordingAdapter('gastown');

    // First call: BLOCKED with MAJOR finding
    // Second call: PASS (finding fixed)
    const originalExecute = gastown.execute.bind(gastown);
    gastown.execute = async (command: string, args?: Record<string, unknown>) => {
      if (command === 'sling.review') {
        callCount++;
        if (callCount === 1) {
          return makeReviewSuiteResponse('D', [
            { severity: 'MAJOR', description: 'Missing error handling' },
          ]);
        }
        return makeReviewSuiteResponse('A');
      }
      return originalExecute(command, args);
    };

    const orch = rig.createOrchestrator({ gastown });
    advanceToReview(orch);

    const result = await orch.reviewCycle(
      { changedFiles: ['src/utils.ts'], totalChangedLines: 10 },
    );

    expect(result.passed).toBe(true);
    expect(result.iterations).toHaveLength(2);
    // Second iteration should show the fix was applied
    expect(result.iterations[1].fixesApplied.length).toBeGreaterThan(0);
  });

  test('requests approval when only CRITICAL findings remain', async () => {
    const gastown = new RecordingAdapter('gastown');
    gastown.execute = async (command: string) => {
      if (command === 'sling.review') {
        return makeReviewSuiteResponse('F', [
          { severity: 'CRITICAL', description: 'SQL injection vulnerability' },
        ]);
      }
      return '{"ok":true}';
    };

    const orch = rig.createOrchestrator({ gastown });
    advanceToReview(orch);

    const result = await orch.reviewCycle(
      { changedFiles: ['src/utils.ts'], totalChangedLines: 10 },
    );

    expect(result.passed).toBe(false);
    expect(result.approvalRequested).toBe(true);
    expect(result.iterations).toHaveLength(1);
    expect(orch.pendingApproval()).not.toBeNull();
  });

  test('stops after max iterations with approval request', async () => {
    const gastown = new RecordingAdapter('gastown');
    // Always return BLOCKED with fixable findings — never passes
    gastown.execute = async (command: string) => {
      if (command === 'sling.review') {
        return makeReviewSuiteResponse('D', [
          { severity: 'MAJOR', description: 'Persistent bug' },
        ]);
      }
      return '{"ok":true}';
    };

    const orch = rig.createOrchestrator({ gastown });
    orch.setReviewLoopPolicy({ maxIterations: 2 });
    advanceToReview(orch);

    const result = await orch.reviewCycle(
      { changedFiles: ['src/utils.ts'], totalChangedLines: 10 },
    );

    expect(result.passed).toBe(false);
    expect(result.approvalRequested).toBe(true);
    // Should have done 2 iterations (max)
    expect(result.iterations).toHaveLength(2);
  });

  test('stops when no progress is made (same findings, no fixes)', async () => {
    let callCount = 0;
    const gastown = new RecordingAdapter('gastown');
    gastown.execute = async (command: string) => {
      if (command === 'sling.review') {
        callCount++;
        // Always return the same findings — no progress
        return makeReviewSuiteResponse('D', [
          { severity: 'MAJOR', description: 'Unfixable issue' },
        ]);
      }
      return '{"ok":true}';
    };

    const orch = rig.createOrchestrator({ gastown });
    orch.setReviewLoopPolicy({ maxIterations: 5 }); // High limit — should stop before
    advanceToReview(orch);

    const result = await orch.reviewCycle(
      { changedFiles: ['src/utils.ts'], totalChangedLines: 10 },
    );

    expect(result.passed).toBe(false);
    expect(result.approvalRequested).toBe(true);
    // Should stop at 2: iteration 1 dispatches fix, iteration 2 sees no progress
    expect(result.iterations).toHaveLength(2);
  });

  test('records REFINE→EXECUTE transitions in event log', async () => {
    let callCount = 0;
    const gastown = new RecordingAdapter('gastown');
    gastown.execute = async (command: string) => {
      if (command === 'sling.review') {
        callCount++;
        if (callCount === 1) {
          return makeReviewSuiteResponse('D', [
            { severity: 'MAJOR', description: 'Bug' },
          ]);
        }
        return makeReviewSuiteResponse('A');
      }
      return '{"ok":true}';
    };

    const orch = rig.createOrchestrator({ gastown });
    advanceToReview(orch);

    await orch.reviewCycle(
      { changedFiles: ['src/utils.ts'], totalChangedLines: 10 },
    );

    // Should see REFINE and EXECUTE entries in the log
    const stageEntries = orch.eventLog.ofType('STAGE_ENTERED');
    const stageNames = stageEntries.map((e) => e.stage);
    expect(stageNames).toContain('REFINE');

    // The pattern should be: REVIEW → (complete) → REFINE → (complete) → EXECUTE → (complete) → REVIEW
    const reviewIdx = stageNames.lastIndexOf('REVIEW');
    const refineIdx = stageNames.indexOf('REFINE');
    expect(refineIdx).toBeGreaterThan(-1);
  });

  test('queues fix tasks with finding metadata in REFINE stage', async () => {
    let callCount = 0;
    const gastown = new RecordingAdapter('gastown');
    gastown.execute = async (command: string) => {
      if (command === 'sling.review') {
        callCount++;
        if (callCount === 1) {
          // Grade D is below minimum C → BLOCKED, only CRITICAL/MAJOR findings
          // are included in the gate result by evaluateCorrectnessGate
          return makeReviewSuiteResponse('D', [
            { severity: 'MAJOR', description: 'Missing null check' },
            { severity: 'MAJOR', description: 'Unchecked return value' },
          ]);
        }
        return makeReviewSuiteResponse('A');
      }
      return '{"ok":true}';
    };

    const orch = rig.createOrchestrator({ gastown });
    advanceToReview(orch);

    await orch.reviewCycle(
      { changedFiles: ['src/utils.ts'], totalChangedLines: 10 },
    );

    // Should have queued 2 fix tasks (both MAJOR, not CRITICAL)
    const refineTasks = orch.tasksForStage('REFINE');
    expect(refineTasks).toHaveLength(2);
    expect(refineTasks[0].description).toContain('Missing null check');
    expect(refineTasks[1].description).toContain('Unchecked return value');

    // Tasks should have finding metadata
    expect(refineTasks[0].metadata?.finding).toBeDefined();
    expect(refineTasks[0].metadata?.iteration).toBe(1);
  });

  test('review-only dispatch for security-sensitive files', async () => {
    const gastown = new RecordingAdapter('gastown', {
      commandResponses: {
        'sling.review': JSON.stringify({
          grade: 'A',
          findings: [],
          raw: 'Grade: A. No issues.',
        }),
      },
    });
    const gstack = new RecordingAdapter('gstack');
    const orch = rig.createOrchestrator({ gstack, gastown });
    advanceToReview(orch);

    await orch.reviewCycle(
      { changedFiles: ['src/auth/login.ts'], totalChangedLines: 20 },
      { beadId: 'gt-t1x', rig: 'gastack' },
    );

    // Should have dispatched to gastown sling.review, not gstack review-suite
    expect(gastown.calls.some((c) => c.command === 'sling.review')).toBe(true);
    expect(gstack.calls.some((c) => c.command === 'review-suite')).toBe(false);
  });
});

// --- T: reviewCycleCount and iterationHistory ---

describe('Orchestrator review cycle tracking', () => {
  let rig: TestRig;

  beforeEach(() => {
    rig = createTestRig();
  });

  afterEach(() => {
    rig.cleanup();
  });

  test('reviewCycleCount tracks REVIEW stage entries', () => {
    const orch = rig.createOrchestrator();
    expect(orch.reviewCycleCount()).toBe(0);

    orch.enterStage('PLAN');
    orch.completeStage();
    orch.enterStage('EXECUTE');
    orch.completeStage();
    orch.enterStage('REVIEW');
    expect(orch.reviewCycleCount()).toBe(1);

    // Simulate REFINE→EXECUTE→REVIEW loop
    orch.completeStage();
    orch.enterStage('REFINE');
    orch.completeStage();
    orch.enterStage('EXECUTE');
    orch.completeStage();
    orch.enterStage('REVIEW');
    expect(orch.reviewCycleCount()).toBe(2);
  });

  test('iterationHistory extracts from stage completion summaries', () => {
    const orch = rig.createOrchestrator();
    orch.enterStage('PLAN');
    orch.completeStage();
    orch.enterStage('EXECUTE');
    orch.completeStage();
    orch.enterStage('REVIEW');

    // Complete REVIEW with a JSON summary
    const summary = JSON.stringify({
      report: {
        overall: 'BLOCKED',
        gates: [{ gate: 'correctness', verdict: 'BLOCKED', reason: 'Low grade', findings: [] }],
        summary: 'BLOCKED',
      },
      fixesApplied: [],
      remainingFindings: [{ severity: 'MAJOR', description: 'Bug' }],
      iterationNum: 1,
    });
    orch.completeStage(summary);

    const history = orch.iterationHistory();
    expect(history).toHaveLength(1);
    expect(history[0].iteration).toBe(1);
    expect(history[0].report.overall).toBe('BLOCKED');
    expect(history[0].remainingFindings).toHaveLength(1);
  });

  test('iterationHistory skips non-JSON summaries', () => {
    const orch = rig.createOrchestrator();
    orch.enterStage('PLAN');
    orch.completeStage();
    orch.enterStage('EXECUTE');
    orch.completeStage();
    orch.enterStage('REVIEW');
    orch.completeStage('Just a text summary');

    const history = orch.iterationHistory();
    expect(history).toHaveLength(0);
  });
});

// --- T: done --resume flag ---

describe('gastown adapter done --resume', () => {
  test('done with resume flag includes --resume in CLI args', async () => {
    const adapter = new TestableGasTownAdapter();
    await adapter.execute('done', { resume: true, target: 'main' });

    const args = adapter.lastCliArgsFor('done')!;
    expect(args).toContain('--resume');
    expect(args).toContain('--target');
    expect(args).toContain('main');
  });

  test('done without resume flag omits --resume', async () => {
    const adapter = new TestableGasTownAdapter();
    await adapter.execute('done', { target: 'main' });

    const args = adapter.lastCliArgsFor('done')!;
    expect(args).not.toContain('--resume');
  });

  test('done with resume and pre-verified', async () => {
    const adapter = new TestableGasTownAdapter();
    await adapter.execute('done', {
      resume: true,
      preVerified: true,
      target: 'main',
    });

    const args = adapter.lastCliArgsFor('done')!;
    expect(args).toContain('--resume');
    expect(args).toContain('--pre-verified');
    expect(args).toContain('--target');
  });
});
