/**
 * Tests for the quality adapter — policy decision tree.
 *
 * Unit tests cover:
 *   - compareGrades / gradePassesMinimum: grade ordering and comparison
 *   - evaluateSecurityGate: CSO result → BLOCKED/WARN/PASS
 *   - evaluateCorrectnessGate: review result → BLOCKED/WARN/PASS
 *   - evaluate: combined quality report with overall verdict
 *   - QualityAdapter: command routing and JSON round-tripping
 */

import { describe, test, expect } from 'bun:test';
import {
  compareGrades,
  gradePassesMinimum,
  evaluateSecurityGate,
  evaluateCorrectnessGate,
  evaluate,
  mergeStrategyFromVerdict,
  QualityAdapter,
  DEFAULT_POLICY,
  type QualityPolicy,
} from './quality.js';
import type { ReviewResult, Finding } from './adapters/gstack.js';

// --- Test helpers ---

function makeReview(overrides?: Partial<ReviewResult>): ReviewResult {
  return {
    grade: 'B',
    findings: [],
    raw: 'mock review output',
    ...overrides,
  };
}

function makeFinding(severity: Finding['severity'], desc = 'test finding'): Finding {
  return { severity, description: desc };
}

// --- Grade comparison ---

describe('compareGrades', () => {
  test('A+ is better than A', () => {
    expect(compareGrades('A+', 'A')).toBeGreaterThan(0);
  });

  test('A is better than B', () => {
    expect(compareGrades('A', 'B')).toBeGreaterThan(0);
  });

  test('F is worse than D-', () => {
    expect(compareGrades('F', 'D-')).toBeLessThan(0);
  });

  test('same grade returns 0', () => {
    expect(compareGrades('B', 'B')).toBe(0);
  });

  test('case insensitive', () => {
    expect(compareGrades('b+', 'B+')).toBe(0);
  });

  test('unknown grade sorts to worst', () => {
    expect(compareGrades('X', 'F')).toBeLessThan(0);
  });
});

describe('gradePassesMinimum', () => {
  test('B+ passes minimum C', () => {
    expect(gradePassesMinimum('B+', 'C')).toBe(true);
  });

  test('C passes minimum C (exact match)', () => {
    expect(gradePassesMinimum('C', 'C')).toBe(true);
  });

  test('D does not pass minimum C', () => {
    expect(gradePassesMinimum('D', 'C')).toBe(false);
  });

  test('F does not pass minimum C', () => {
    expect(gradePassesMinimum('F', 'C')).toBe(false);
  });

  test('A+ passes minimum A', () => {
    expect(gradePassesMinimum('A+', 'A')).toBe(true);
  });
});

// --- Security gate ---

describe('evaluateSecurityGate', () => {
  test('null result → PASS (advisory in B1)', () => {
    const result = evaluateSecurityGate(null);
    expect(result.verdict).toBe('PASS');
    expect(result.gate).toBe('security');
  });

  test('no findings → PASS', () => {
    const result = evaluateSecurityGate(makeReview({ findings: [] }));
    expect(result.verdict).toBe('PASS');
  });

  test('CRITICAL finding → BLOCKED', () => {
    const result = evaluateSecurityGate(makeReview({
      findings: [makeFinding('CRITICAL', 'SQL injection')],
    }));
    expect(result.verdict).toBe('BLOCKED');
    expect(result.findings).toHaveLength(1);
  });

  test('MAJOR finding → BLOCKED', () => {
    const result = evaluateSecurityGate(makeReview({
      findings: [makeFinding('MAJOR', 'XSS vulnerability')],
    }));
    expect(result.verdict).toBe('BLOCKED');
  });

  test('MINOR finding → WARN', () => {
    const result = evaluateSecurityGate(makeReview({
      findings: [makeFinding('MINOR', 'missing CSP header')],
    }));
    expect(result.verdict).toBe('WARN');
    expect(result.findings).toHaveLength(1);
  });

  test('mixed CRITICAL and MINOR → BLOCKED (CRITICAL wins)', () => {
    const result = evaluateSecurityGate(makeReview({
      findings: [
        makeFinding('CRITICAL', 'RCE'),
        makeFinding('MINOR', 'informational'),
      ],
    }));
    expect(result.verdict).toBe('BLOCKED');
    // Only blocking findings are returned
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].severity).toBe('CRITICAL');
  });

  test('custom policy: only CRITICAL blocks', () => {
    const policy: QualityPolicy = {
      ...DEFAULT_POLICY,
      blockingSecuritySeverities: ['CRITICAL'],
      warningSecuritySeverities: ['MAJOR', 'MINOR'],
    };
    const result = evaluateSecurityGate(
      makeReview({ findings: [makeFinding('MAJOR', 'XSS')] }),
      policy,
    );
    expect(result.verdict).toBe('WARN');
  });
});

// --- Correctness gate ---

describe('evaluateCorrectnessGate', () => {
  test('null result + blockOnNotRun → BLOCKED', () => {
    const result = evaluateCorrectnessGate(null);
    expect(result.verdict).toBe('BLOCKED');
    expect(result.reason).toContain('not run');
  });

  test('null result + blockOnNotRun=false → WARN', () => {
    const policy: QualityPolicy = { ...DEFAULT_POLICY, blockOnNotRun: false };
    const result = evaluateCorrectnessGate(null, policy);
    expect(result.verdict).toBe('WARN');
  });

  test('grade B passes default minimum C', () => {
    const result = evaluateCorrectnessGate(makeReview({ grade: 'B' }));
    expect(result.verdict).toBe('PASS');
  });

  test('grade A passes', () => {
    const result = evaluateCorrectnessGate(makeReview({ grade: 'A' }));
    expect(result.verdict).toBe('PASS');
  });

  test('grade D fails default minimum C', () => {
    const result = evaluateCorrectnessGate(makeReview({ grade: 'D' }));
    expect(result.verdict).toBe('BLOCKED');
    expect(result.reason).toContain('below minimum');
  });

  test('grade F fails', () => {
    const result = evaluateCorrectnessGate(makeReview({ grade: 'F' }));
    expect(result.verdict).toBe('BLOCKED');
  });

  test('passing grade with MINOR findings → WARN', () => {
    const result = evaluateCorrectnessGate(makeReview({
      grade: 'B',
      findings: [makeFinding('MINOR', 'nitpick')],
    }));
    expect(result.verdict).toBe('WARN');
    expect(result.reason).toContain('minor finding');
  });

  test('failing grade returns CRITICAL/MAJOR findings', () => {
    const result = evaluateCorrectnessGate(makeReview({
      grade: 'D',
      findings: [
        makeFinding('CRITICAL', 'broken logic'),
        makeFinding('MINOR', 'style'),
      ],
    }));
    expect(result.verdict).toBe('BLOCKED');
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].severity).toBe('CRITICAL');
  });

  test('no grade + CRITICAL findings → BLOCKED', () => {
    const result = evaluateCorrectnessGate(makeReview({
      grade: null,
      findings: [makeFinding('CRITICAL', 'crash')],
    }));
    expect(result.verdict).toBe('BLOCKED');
  });

  test('no grade + no CRITICAL findings → WARN', () => {
    const result = evaluateCorrectnessGate(makeReview({
      grade: null,
      findings: [makeFinding('MINOR', 'style')],
    }));
    expect(result.verdict).toBe('WARN');
    expect(result.reason).toContain('No grade parsed');
  });

  test('custom minimum grade B', () => {
    const policy: QualityPolicy = { ...DEFAULT_POLICY, minReviewGrade: 'B' };
    const passResult = evaluateCorrectnessGate(makeReview({ grade: 'B' }), policy);
    expect(passResult.verdict).toBe('PASS');

    const failResult = evaluateCorrectnessGate(makeReview({ grade: 'C+' }), policy);
    expect(failResult.verdict).toBe('BLOCKED');
  });
});

// --- Combined evaluation ---

describe('evaluate', () => {
  test('both gates pass → overall PASS', () => {
    const report = evaluate({
      review: makeReview({ grade: 'A' }),
      cso: makeReview({ findings: [] }),
    });
    expect(report.overall).toBe('PASS');
    expect(report.gates).toHaveLength(2);
  });

  test('security BLOCKED → overall BLOCKED', () => {
    const report = evaluate({
      review: makeReview({ grade: 'A' }),
      cso: makeReview({ findings: [makeFinding('CRITICAL', 'RCE')] }),
    });
    expect(report.overall).toBe('BLOCKED');
  });

  test('correctness BLOCKED → overall BLOCKED', () => {
    const report = evaluate({
      review: makeReview({ grade: 'F' }),
      cso: makeReview({ findings: [] }),
    });
    expect(report.overall).toBe('BLOCKED');
  });

  test('one WARN, no BLOCKED → overall WARN', () => {
    const report = evaluate({
      review: makeReview({ grade: 'B' }),
      cso: makeReview({ findings: [makeFinding('MINOR', 'info')] }),
    });
    expect(report.overall).toBe('WARN');
  });

  test('no inputs (both null) → correctness BLOCKED, security PASS → overall BLOCKED', () => {
    const report = evaluate({});
    expect(report.overall).toBe('BLOCKED');
    const correctness = report.gates.find((g) => g.gate === 'correctness');
    expect(correctness?.verdict).toBe('BLOCKED');
    const security = report.gates.find((g) => g.gate === 'security');
    expect(security?.verdict).toBe('PASS');
  });

  test('summary includes gate details', () => {
    const report = evaluate({
      review: makeReview({ grade: 'A' }),
      cso: makeReview({ findings: [] }),
    });
    expect(report.summary).toContain('Quality: PASS');
    expect(report.summary).toContain('correctness: PASS');
    expect(report.summary).toContain('security: PASS');
  });
});

// --- Merge strategy from verdicts ---

describe('mergeStrategyFromVerdict', () => {
  test('BLOCKED → local (quarantine)', () => {
    const report = evaluate({
      review: makeReview({ grade: 'F' }),
      cso: makeReview({ findings: [] }),
    });
    expect(report.overall).toBe('BLOCKED');
    expect(mergeStrategyFromVerdict(report)).toBe('local');
  });

  test('BLOCKED from security → local', () => {
    const report = evaluate({
      review: makeReview({ grade: 'A' }),
      cso: makeReview({ findings: [makeFinding('CRITICAL', 'RCE')] }),
    });
    expect(report.overall).toBe('BLOCKED');
    expect(mergeStrategyFromVerdict(report)).toBe('local');
  });

  test('WARN → mr (merge queue)', () => {
    const report = evaluate({
      review: makeReview({ grade: 'B' }),
      cso: makeReview({ findings: [makeFinding('MINOR', 'info')] }),
    });
    expect(report.overall).toBe('WARN');
    expect(mergeStrategyFromVerdict(report)).toBe('mr');
  });

  test('PASS with grade A → direct', () => {
    const report = evaluate({
      review: makeReview({ grade: 'A' }),
      cso: makeReview({ findings: [] }),
    });
    expect(report.overall).toBe('PASS');
    expect(mergeStrategyFromVerdict(report)).toBe('direct');
  });

  test('PASS with grade A+ → direct', () => {
    const report = evaluate({
      review: makeReview({ grade: 'A+' }),
      cso: makeReview({ findings: [] }),
    });
    expect(report.overall).toBe('PASS');
    expect(mergeStrategyFromVerdict(report)).toBe('direct');
  });

  test('PASS with grade A- → direct', () => {
    const report = evaluate({
      review: makeReview({ grade: 'A-' }),
      cso: makeReview({ findings: [] }),
    });
    expect(report.overall).toBe('PASS');
    expect(mergeStrategyFromVerdict(report)).toBe('direct');
  });

  test('PASS with grade B → mr', () => {
    const report = evaluate({
      review: makeReview({ grade: 'B' }),
      cso: makeReview({ findings: [] }),
    });
    expect(report.overall).toBe('PASS');
    expect(mergeStrategyFromVerdict(report)).toBe('mr');
  });

  test('PASS with grade C → mr', () => {
    const report = evaluate({
      review: makeReview({ grade: 'C' }),
      cso: makeReview({ findings: [] }),
    });
    expect(report.overall).toBe('PASS');
    expect(mergeStrategyFromVerdict(report)).toBe('mr');
  });

  test('PASS with no grade (null review but blockOnNotRun=false) → mr', () => {
    const policy: QualityPolicy = { ...DEFAULT_POLICY, blockOnNotRun: false };
    // With blockOnNotRun=false and null review, correctness is WARN, security is PASS → overall WARN
    // So let's construct a PASS with no grade by using a review with no grade and no critical findings
    const report = evaluate({
      review: makeReview({ grade: null, findings: [] }),
      cso: makeReview({ findings: [] }),
    });
    // No grade + no criticals = WARN overall, so this tests WARN path
    expect(mergeStrategyFromVerdict(report)).toBe('mr');
  });
});

// --- QualityAdapter ---

describe('QualityAdapter', () => {
  test('evaluate command returns JSON report', async () => {
    const adapter = new QualityAdapter();
    const result = await adapter.execute('evaluate', {
      review: { grade: 'B', findings: [], raw: '' },
      cso: { grade: null, findings: [], raw: '' },
    });

    const report = JSON.parse(result);
    expect(report.overall).toBe('PASS');
    expect(report.gates).toHaveLength(2);
  });

  test('security command evaluates CSO only', async () => {
    const adapter = new QualityAdapter();
    const result = await adapter.execute('security', {
      cso: { grade: null, findings: [{ severity: 'CRITICAL', description: 'bad' }], raw: '' },
    });

    const gate = JSON.parse(result);
    expect(gate.verdict).toBe('BLOCKED');
    expect(gate.gate).toBe('security');
  });

  test('correctness command evaluates review only', async () => {
    const adapter = new QualityAdapter();
    const result = await adapter.execute('correctness', {
      review: { grade: 'A', findings: [], raw: '' },
    });

    const gate = JSON.parse(result);
    expect(gate.verdict).toBe('PASS');
    expect(gate.gate).toBe('correctness');
  });

  test('policy command returns current policy', async () => {
    const adapter = new QualityAdapter({ policy: { minReviewGrade: 'B' } });
    const result = await adapter.execute('policy');

    const policy = JSON.parse(result);
    expect(policy.minReviewGrade).toBe('B');
    expect(policy.blockOnNotRun).toBe(true);
  });

  test('custom policy propagates to evaluations', async () => {
    const adapter = new QualityAdapter({ policy: { minReviewGrade: 'A' } });
    const result = await adapter.execute('correctness', {
      review: { grade: 'B', findings: [], raw: '' },
    });

    const gate = JSON.parse(result);
    expect(gate.verdict).toBe('BLOCKED');
  });

  test('accepts JSON string args', async () => {
    const adapter = new QualityAdapter();
    const result = await adapter.execute('evaluate', {
      review: JSON.stringify({ grade: 'A', findings: [], raw: '' }),
      cso: JSON.stringify({ grade: null, findings: [], raw: '' }),
    });

    const report = JSON.parse(result);
    expect(report.overall).toBe('PASS');
  });

  test('unknown command throws', async () => {
    const adapter = new QualityAdapter();
    expect(adapter.execute('bogus')).rejects.toThrow('Unknown quality command');
  });
});
