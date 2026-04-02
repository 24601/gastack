/**
 * B2 health gate tests — code quality scoring as quality gate.
 *
 * Gate tier: no network, no LLM. Pure logic.
 */

import { describe, test, expect } from 'bun:test';
import { evaluateHealthGate, evaluate } from '../quality.js';

describe('evaluateHealthGate', () => {
  test('score >= 7 is PASS', () => {
    const result = evaluateHealthGate({ score: 8.5 });
    expect(result.verdict).toBe('PASS');
    expect(result.gate).toBe('health');
    expect(result.reason).toContain('8.5/10');
  });

  test('score 7 is PASS (boundary)', () => {
    const result = evaluateHealthGate({ score: 7 });
    expect(result.verdict).toBe('PASS');
  });

  test('score 4-6 is WARN', () => {
    const result = evaluateHealthGate({ score: 5 });
    expect(result.verdict).toBe('WARN');
    expect(result.reason).toContain('needs attention');
  });

  test('score 6 is WARN (boundary)', () => {
    const result = evaluateHealthGate({ score: 6 });
    expect(result.verdict).toBe('WARN');
  });

  test('score < 4 is BLOCKED', () => {
    const result = evaluateHealthGate({ score: 2 });
    expect(result.verdict).toBe('BLOCKED');
    expect(result.reason).toContain('serious quality issues');
  });

  test('score 3 is BLOCKED (boundary)', () => {
    const result = evaluateHealthGate({ score: 3 });
    expect(result.verdict).toBe('BLOCKED');
  });

  test('score 0 is BLOCKED', () => {
    const result = evaluateHealthGate({ score: 0 });
    expect(result.verdict).toBe('BLOCKED');
  });

  test('null (not run) is PASS (advisory)', () => {
    const result = evaluateHealthGate(null);
    expect(result.verdict).toBe('PASS');
    expect(result.reason).toContain('advisory');
  });

  test('health gate produces no findings (score-based, not finding-based)', () => {
    const result = evaluateHealthGate({ score: 2 });
    expect(result.findings).toHaveLength(0);
  });
});

describe('evaluate() includes health gate', () => {
  test('health BLOCKED makes overall BLOCKED', () => {
    const report = evaluate({
      review: { grade: 'A', findings: [], specialists: [], raw: '' },
      cso: null,
      health: { score: 2 },
    });
    expect(report.overall).toBe('BLOCKED');
    expect(report.gates.find((g) => g.gate === 'health')?.verdict).toBe('BLOCKED');
  });

  test('health WARN with review PASS makes overall WARN', () => {
    const report = evaluate({
      review: { grade: 'A', findings: [], specialists: [], raw: '' },
      cso: null,
      health: { score: 5 },
    });
    expect(report.overall).toBe('WARN');
  });

  test('all gates PASS makes overall PASS', () => {
    const report = evaluate({
      review: { grade: 'A', findings: [], specialists: [], raw: '' },
      cso: null,
      health: { score: 9 },
    });
    expect(report.overall).toBe('PASS');
  });

  test('health null does not block', () => {
    const report = evaluate({
      review: { grade: 'B', findings: [], specialists: [], raw: '' },
      cso: null,
      health: null,
    });
    expect(report.overall).toBe('PASS');
    expect(report.gates.find((g) => g.gate === 'health')?.verdict).toBe('PASS');
  });

  test('report includes 3 gates (correctness, security, health)', () => {
    const report = evaluate({ review: null, cso: null, health: null });
    expect(report.gates).toHaveLength(3);
    expect(report.gates.map((g) => g.gate).sort()).toEqual(['correctness', 'health', 'security']);
  });
});
