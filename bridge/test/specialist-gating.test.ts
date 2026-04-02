/**
 * B2 specialist gating tests — adaptive skip for zero-finding specialists.
 *
 * Gate tier: no network, no LLM, no gt binary required. Pure logic.
 */

import { describe, test, expect } from 'bun:test';
import {
  deriveSpecialistGating,
  activeSpecialists,
  deduplicateFindings,
  GATING_THRESHOLD,
  EXEMPT_SPECIALISTS,
  RECHECK_INTERVAL,
} from '../specialist-gating.js';
import type { EventEnvelope } from '../events.js';

/** Helper: create a TASK_COMPLETED envelope with specialist data. */
function reviewCompletion(specialists: Array<{ specialist: string; findings: Array<{ severity?: string; fingerprint?: string }> }>): EventEnvelope {
  return {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    event: {
      type: 'TASK_COMPLETED',
      taskId: crypto.randomUUID(),
      result: JSON.stringify({ specialists }),
    },
  };
}

// --- Gating logic ---

describe('specialist gating: threshold behavior', () => {
  test('specialist is NOT gated after fewer than threshold zero-finding runs', () => {
    const events: EventEnvelope[] = [];
    for (let i = 0; i < GATING_THRESHOLD - 1; i++) {
      events.push(reviewCompletion([
        { specialist: 'performance', findings: [] },
      ]));
    }

    const state = deriveSpecialistGating(events);
    expect(state.performance.gated).toBe(false);
    expect(state.performance.consecutiveZeroRuns).toBe(GATING_THRESHOLD - 1);
  });

  test('specialist IS gated after exactly threshold zero-finding runs', () => {
    const events: EventEnvelope[] = [];
    for (let i = 0; i < GATING_THRESHOLD; i++) {
      events.push(reviewCompletion([
        { specialist: 'performance', findings: [] },
      ]));
    }

    const state = deriveSpecialistGating(events);
    expect(state.performance.gated).toBe(true);
    expect(state.performance.consecutiveZeroRuns).toBe(GATING_THRESHOLD);
  });

  test('finding in run N+1 un-gates the specialist', () => {
    const events: EventEnvelope[] = [];
    // Gate it
    for (let i = 0; i < GATING_THRESHOLD; i++) {
      events.push(reviewCompletion([
        { specialist: 'performance', findings: [] },
      ]));
    }
    // Un-gate with a finding
    events.push(reviewCompletion([
      { specialist: 'performance', findings: [{ severity: 'MINOR' }] },
    ]));

    const state = deriveSpecialistGating(events);
    expect(state.performance.gated).toBe(false);
    expect(state.performance.consecutiveZeroRuns).toBe(0);
  });
});

describe('specialist gating: exemptions', () => {
  test('security is NEVER gated even with many zero-finding runs', () => {
    const events: EventEnvelope[] = [];
    for (let i = 0; i < GATING_THRESHOLD + 5; i++) {
      events.push(reviewCompletion([
        { specialist: 'security', findings: [] },
      ]));
    }

    const state = deriveSpecialistGating(events);
    expect(state.security.gated).toBe(false);
    expect(EXEMPT_SPECIALISTS.has('security')).toBe(true);
  });

  test('data-migration is NEVER gated even with many zero-finding runs', () => {
    const events: EventEnvelope[] = [];
    for (let i = 0; i < GATING_THRESHOLD + 5; i++) {
      events.push(reviewCompletion([
        { specialist: 'data-migration', findings: [] },
      ]));
    }

    const state = deriveSpecialistGating(events);
    expect(state['data-migration'].gated).toBe(false);
    expect(EXEMPT_SPECIALISTS.has('data-migration')).toBe(true);
  });
});

describe('specialist gating: multiple specialists', () => {
  test('specialists gate independently', () => {
    const events: EventEnvelope[] = [];
    for (let i = 0; i < GATING_THRESHOLD; i++) {
      events.push(reviewCompletion([
        { specialist: 'performance', findings: [] },
        { specialist: 'maintainability', findings: i < 5 ? [{ severity: 'MINOR' }] : [] },
      ]));
    }

    const state = deriveSpecialistGating(events);
    expect(state.performance.gated).toBe(true);
    // maintainability had findings in first 5 runs, then 5 zeros — not enough to gate
    expect(state.maintainability.gated).toBe(false);
  });
});

describe('activeSpecialists filtering', () => {
  test('returns only non-gated plus exempt specialists', () => {
    const gating = {
      security: { consecutiveZeroRuns: 15, lastFindingRun: 0, gated: false },
      performance: { consecutiveZeroRuns: 12, lastFindingRun: 0, gated: true },
      testing: { consecutiveZeroRuns: 0, lastFindingRun: 5, gated: false },
      'data-migration': { consecutiveZeroRuns: 15, lastFindingRun: 0, gated: false },
      maintainability: { consecutiveZeroRuns: 11, lastFindingRun: 0, gated: true },
      'api-contract': { consecutiveZeroRuns: 0, lastFindingRun: 3, gated: false },
      'red-team': { consecutiveZeroRuns: 10, lastFindingRun: 0, gated: true },
    };

    // Non-recheck run: gated specialists excluded
    const active = activeSpecialists(gating, undefined, 3);
    expect(active).toContain('security');
    expect(active).toContain('testing');
    expect(active).toContain('data-migration');
    expect(active).toContain('api-contract');
    expect(active).not.toContain('performance');
    expect(active).not.toContain('maintainability');
    expect(active).not.toContain('red-team');
  });

  test('unknown specialists default to active', () => {
    const active = activeSpecialists({}, ['security', 'new-specialist'], 1);
    expect(active).toContain('new-specialist');
  });

  test('gated specialists re-included on recheck runs', () => {
    const gating = {
      performance: { consecutiveZeroRuns: 12, lastFindingRun: 0, gated: true },
      security: { consecutiveZeroRuns: 12, lastFindingRun: 0, gated: false },
    };

    // Non-recheck run: performance excluded
    const activeNormal = activeSpecialists(gating, undefined, 3);
    expect(activeNormal).not.toContain('performance');

    // Recheck run (multiple of RECHECK_INTERVAL): performance included
    const activeRecheck = activeSpecialists(gating, undefined, RECHECK_INTERVAL);
    expect(activeRecheck).toContain('performance');

    // Another recheck run
    const activeRecheck2 = activeSpecialists(gating, undefined, RECHECK_INTERVAL * 2);
    expect(activeRecheck2).toContain('performance');
  });

  test('runNumber 0 does not trigger recheck', () => {
    const gating = {
      performance: { consecutiveZeroRuns: 12, lastFindingRun: 0, gated: true },
    };
    // runNumber 0 (default/unset) should NOT re-include gated
    const active = activeSpecialists(gating, undefined, 0);
    expect(active).not.toContain('performance');
  });
});

// --- Finding dedup ---

describe('deduplicateFindings', () => {
  test('deduplicates by fingerprint keeping highest severity', () => {
    const findings = [
      { fingerprint: 'fp-1', severity: 'MINOR', description: 'Perf issue' },
      { fingerprint: 'fp-1', severity: 'MAJOR', description: 'Perf issue' },
      { fingerprint: 'fp-2', severity: 'CRITICAL', description: 'XSS' },
    ];

    const deduped = deduplicateFindings(findings);
    expect(deduped).toHaveLength(2);

    const fp1 = deduped.find((f) => f.fingerprint === 'fp-1');
    expect(fp1!.severity).toBe('MAJOR'); // Higher severity kept
  });

  test('keeps findings without fingerprints', () => {
    const findings = [
      { description: 'No fingerprint 1' },
      { description: 'No fingerprint 2' },
      { fingerprint: 'fp-1', severity: 'MINOR', description: 'Has FP' },
    ];

    const deduped = deduplicateFindings(findings);
    expect(deduped).toHaveLength(3);
  });

  test('empty findings returns empty', () => {
    expect(deduplicateFindings([])).toHaveLength(0);
  });

  test('single finding returns single', () => {
    const findings = [{ fingerprint: 'fp-1', severity: 'CRITICAL' }];
    expect(deduplicateFindings(findings)).toHaveLength(1);
  });
});
