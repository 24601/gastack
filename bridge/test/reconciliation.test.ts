/**
 * Multi-model verdict reconciliation tests (ga-fvf).
 *
 * Verifies the "20th dentist" disagreement policy:
 *   1. Both PASS → PASS (agreement)
 *   2. Both BLOCKED → BLOCKED (agreement)
 *   3. One BLOCKED + one PASS → human review (the interesting case)
 *   4. One WARN + one PASS → WARN (take stricter)
 *   5. One WARN + one BLOCKED → BLOCKED (take stricter)
 *   6. Both WARN → WARN (agreement)
 *   7. reconcileReports merges findings from both models
 *   8. reconcileReports produces disagreement summary
 */

import { describe, test, expect } from 'bun:test';
import {
  reconcileVerdicts,
  reconcileReports,
  type GateVerdict,
  type QualityReport,
  type GateResult,
} from '../quality.js';

// --- T: reconcileVerdicts disagreement policy ---

describe('reconcileVerdicts — disagreement policy', () => {
  test('both PASS → agree_pass', () => {
    const result = reconcileVerdicts('PASS', 'PASS');
    expect(result.outcome).toBe('agree_pass');
    expect(result.finalVerdict).toBe('PASS');
    expect(result.disagreement).toBe(false);
  });

  test('both BLOCKED → agree_block', () => {
    const result = reconcileVerdicts('BLOCKED', 'BLOCKED');
    expect(result.outcome).toBe('agree_block');
    expect(result.finalVerdict).toBe('BLOCKED');
    expect(result.disagreement).toBe(false);
  });

  test('BLOCKED vs PASS → human_review', () => {
    const result = reconcileVerdicts('BLOCKED', 'PASS');
    expect(result.outcome).toBe('human_review');
    expect(result.finalVerdict).toBe('BLOCKED');
    expect(result.disagreement).toBe(true);
    expect(result.reason).toContain('disagree');
  });

  test('PASS vs BLOCKED → human_review (order independent)', () => {
    const result = reconcileVerdicts('PASS', 'BLOCKED');
    expect(result.outcome).toBe('human_review');
    expect(result.finalVerdict).toBe('BLOCKED');
    expect(result.disagreement).toBe(true);
  });

  test('WARN vs PASS → stricter (WARN)', () => {
    const result = reconcileVerdicts('WARN', 'PASS');
    expect(result.outcome).toBe('stricter');
    expect(result.finalVerdict).toBe('WARN');
    expect(result.disagreement).toBe(true);
  });

  test('PASS vs WARN → stricter (WARN)', () => {
    const result = reconcileVerdicts('PASS', 'WARN');
    expect(result.outcome).toBe('stricter');
    expect(result.finalVerdict).toBe('WARN');
    expect(result.disagreement).toBe(true);
  });

  test('WARN vs BLOCKED → stricter (BLOCKED)', () => {
    const result = reconcileVerdicts('WARN', 'BLOCKED');
    expect(result.outcome).toBe('stricter');
    expect(result.finalVerdict).toBe('BLOCKED');
    expect(result.disagreement).toBe(true);
  });

  test('BLOCKED vs WARN → stricter (BLOCKED)', () => {
    const result = reconcileVerdicts('BLOCKED', 'WARN');
    expect(result.outcome).toBe('stricter');
    expect(result.finalVerdict).toBe('BLOCKED');
    expect(result.disagreement).toBe(true);
  });

  test('both WARN → agreement (WARN)', () => {
    const result = reconcileVerdicts('WARN', 'WARN');
    expect(result.outcome).toBe('stricter');
    expect(result.finalVerdict).toBe('WARN');
    expect(result.disagreement).toBe(false);
  });
});

// --- T: reconcileReports merges findings ---

describe('reconcileReports — report merging', () => {
  function makeReport(
    overall: GateVerdict,
    gates: GateResult[],
  ): QualityReport {
    return {
      overall,
      gates,
      summary: `Quality: ${overall}`,
    };
  }

  test('merges findings from both models', () => {
    const primary = makeReport('PASS', [
      {
        gate: 'correctness',
        verdict: 'PASS',
        reason: 'Grade A passes minimum C',
        findings: [],
      },
      {
        gate: 'security',
        verdict: 'PASS',
        reason: 'No security findings',
        findings: [],
      },
    ]);

    const secondary = makeReport('BLOCKED', [
      {
        gate: 'correctness',
        verdict: 'BLOCKED',
        reason: 'Grade D below minimum C',
        findings: [
          { severity: 'MAJOR', description: 'Missing null check in auth handler' },
        ],
      },
      {
        gate: 'security',
        verdict: 'WARN',
        reason: '1 low-severity security finding',
        findings: [
          { severity: 'MINOR', description: 'Unused import' },
        ],
      },
    ]);

    const { reconciliation, mergedReport } = reconcileReports(primary, secondary);

    // PASS vs BLOCKED → human review
    expect(reconciliation.outcome).toBe('human_review');
    expect(reconciliation.disagreement).toBe(true);

    // Merged report takes stricter gate verdicts
    const correctness = mergedReport.gates.find((g) => g.gate === 'correctness')!;
    expect(correctness.verdict).toBe('BLOCKED');
    expect(correctness.findings.some((f) => f.description.includes('null check'))).toBe(true);

    const security = mergedReport.gates.find((g) => g.gate === 'security')!;
    expect(security.verdict).toBe('WARN');
    expect(security.findings.some((f) => f.description.includes('Unused import'))).toBe(true);
  });

  test('deduplicates identical findings', () => {
    const finding = { severity: 'MAJOR' as const, description: 'SQL injection in user input' };

    const primary = makeReport('BLOCKED', [
      { gate: 'security', verdict: 'BLOCKED', reason: '1 finding', findings: [finding] },
    ]);
    const secondary = makeReport('BLOCKED', [
      { gate: 'security', verdict: 'BLOCKED', reason: '1 finding', findings: [finding] },
    ]);

    const { mergedReport } = reconcileReports(primary, secondary);
    const sec = mergedReport.gates.find((g) => g.gate === 'security')!;

    // Should have 1 finding, not 2
    expect(sec.findings).toHaveLength(1);
  });

  test('agreement reports have clean summary', () => {
    const primary = makeReport('PASS', [
      { gate: 'correctness', verdict: 'PASS', reason: 'Grade A', findings: [] },
    ]);
    const secondary = makeReport('PASS', [
      { gate: 'correctness', verdict: 'PASS', reason: 'Grade A-', findings: [] },
    ]);

    const { reconciliation, mergedReport } = reconcileReports(primary, secondary);

    expect(reconciliation.disagreement).toBe(false);
    expect(mergedReport.summary).not.toContain('Multi-model');
  });

  test('disagreement reports include multi-model context in summary', () => {
    const primary = makeReport('PASS', [
      { gate: 'correctness', verdict: 'PASS', reason: 'Grade A', findings: [] },
    ]);
    const secondary = makeReport('BLOCKED', [
      {
        gate: 'correctness',
        verdict: 'BLOCKED',
        reason: 'Grade D',
        findings: [{ severity: 'MAJOR', description: 'Logic error' }],
      },
    ]);

    const { mergedReport } = reconcileReports(primary, secondary);

    expect(mergedReport.summary).toContain('Multi-model');
    expect(mergedReport.summary).toContain('disagree');
  });
});
