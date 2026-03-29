/**
 * Quality policy semantic verification — decision tree cases (ga-0ms).
 *
 * Tests the full evaluate() decision tree using fixture review output markdown
 * parsed through parseReviewOutput(). Each test verifies:
 *   - Overall verdict (BLOCKED / WARN / PASS)
 *   - Which gate category drove the decision
 *   - Findings array contents
 *
 * 6 named cases covering the decision tree:
 *   1. HIGH security finding → BLOCKED
 *   2. MEDIUM correctness finding → BLOCKED (grade below minimum)
 *   3. LOW design findings → WARN (passing grade, minor findings)
 *   4. Clean review → PASS
 *   5. Conflicting signals (HIGH security + A- review) → BLOCKED (security wins)
 *   6. 3+ MEDIUM findings in security scan → BLOCKED
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { createTestRig, type TestRig } from './test-rig.js';
import { parseReviewOutput } from '../adapters/gstack.js';
import { evaluate, type QualityReport } from '../quality.js';

let rig: TestRig;

beforeEach(() => {
  rig = createTestRig();
});

afterEach(() => {
  rig.cleanup();
});

/** Load a review output fixture and parse it into a ReviewResult. */
function loadReview(name: string) {
  const raw = rig.readFixture('review-outputs', name);
  return parseReviewOutput(raw);
}

/** Find a gate result by name from a quality report. */
function gate(report: QualityReport, name: string) {
  return report.gates.find((g) => g.gate === name)!;
}

describe('Quality policy decision tree (fixture-driven)', () => {
  test('1. HIGH security finding → BLOCKED', () => {
    const cso = loadReview('high-security.md');
    const review = loadReview('clean-review.md');

    const report = evaluate({ review, cso });

    // Overall blocked by security
    expect(report.overall).toBe('BLOCKED');

    // Security gate: BLOCKED with CRITICAL findings
    const sec = gate(report, 'security');
    expect(sec.verdict).toBe('BLOCKED');
    expect(sec.findings.length).toBeGreaterThanOrEqual(1);
    expect(sec.findings.some((f) => f.severity === 'CRITICAL')).toBe(true);

    // Correctness gate: PASS (A- passes minimum C, no findings)
    const cor = gate(report, 'correctness');
    expect(cor.verdict).toBe('PASS');
  });

  test('2. MEDIUM correctness finding → BLOCKED (grade below minimum)', () => {
    const review = loadReview('medium-correctness.md');

    const report = evaluate({ review });

    // Overall blocked by correctness (D+ below default minimum C)
    expect(report.overall).toBe('BLOCKED');

    // Correctness gate: BLOCKED with filtered MAJOR findings
    const cor = gate(report, 'correctness');
    expect(cor.verdict).toBe('BLOCKED');
    expect(cor.reason).toContain('below minimum');
    expect(cor.findings.some((f) => f.severity === 'MAJOR')).toBe(true);
    // MINOR findings filtered out when grade fails
    expect(cor.findings.every((f) => f.severity !== 'MINOR')).toBe(true);

    // Security gate: PASS (not provided)
    const sec = gate(report, 'security');
    expect(sec.verdict).toBe('PASS');
  });

  test('3. LOW design findings → WARN (passing grade, minor findings only)', () => {
    const review = loadReview('low-design.md');

    const report = evaluate({ review });

    // Overall WARN — grade passes but MINOR findings surface
    expect(report.overall).toBe('WARN');

    // Correctness gate: WARN with MINOR findings
    const cor = gate(report, 'correctness');
    expect(cor.verdict).toBe('WARN');
    expect(cor.findings.length).toBeGreaterThanOrEqual(1);
    expect(cor.findings.every((f) => f.severity === 'MINOR')).toBe(true);

    // Security gate: PASS (not provided)
    const sec = gate(report, 'security');
    expect(sec.verdict).toBe('PASS');
  });

  test('4. Clean review → PASS', () => {
    const review = loadReview('clean-review.md');

    const report = evaluate({ review });

    // Overall PASS — no findings, good grade
    expect(report.overall).toBe('PASS');

    // Correctness gate: PASS (A- passes minimum C, 0 findings)
    const cor = gate(report, 'correctness');
    expect(cor.verdict).toBe('PASS');
    expect(cor.findings).toHaveLength(0);

    // Security gate: PASS (not provided → advisory)
    const sec = gate(report, 'security');
    expect(sec.verdict).toBe('PASS');
  });

  test('5. Conflicting signals: HIGH security + A- review → BLOCKED (security wins)', () => {
    const review = loadReview('clean-review.md');
    const cso = loadReview('mixed-signals.md');

    const report = evaluate({ review, cso });

    // Overall BLOCKED — security overrides clean review
    expect(report.overall).toBe('BLOCKED');

    // Security gate: BLOCKED (mixed-signals has CRITICAL finding)
    const sec = gate(report, 'security');
    expect(sec.verdict).toBe('BLOCKED');
    expect(sec.findings.some((f) => f.severity === 'CRITICAL')).toBe(true);

    // Correctness gate: PASS (A- passes, clean review)
    const cor = gate(report, 'correctness');
    expect(cor.verdict).toBe('PASS');
  });

  test('6. 3+ MEDIUM findings in security scan → BLOCKED', () => {
    const review = loadReview('clean-review.md');
    const cso = loadReview('multiple-medium.md');

    const report = evaluate({ review, cso });

    // Overall BLOCKED — MAJOR findings in security scan trigger block
    expect(report.overall).toBe('BLOCKED');

    // Security gate: BLOCKED (multiple MAJOR findings)
    const sec = gate(report, 'security');
    expect(sec.verdict).toBe('BLOCKED');
    expect(sec.findings.filter((f) => f.severity === 'MAJOR').length).toBeGreaterThanOrEqual(2);

    // Correctness gate: PASS (clean review, A-)
    const cor = gate(report, 'correctness');
    expect(cor.verdict).toBe('PASS');
  });
});
