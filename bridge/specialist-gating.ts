/**
 * Adaptive specialist gating — auto-skip zero-finding specialists.
 *
 * After a specialist produces zero findings for GATING_THRESHOLD consecutive
 * reviews, it gets gated (skipped) in future reviews. Finding something in
 * a subsequent review un-gates it immediately.
 *
 * Security and data-migration are EXEMPT — they always run as insurance
 * policies, even with zero findings. These catch rare but catastrophic issues.
 *
 * State is derived from the event log (replay review task completions),
 * not stored mutably. This follows the bridge's event-sourcing pattern.
 */

import type { EventEnvelope } from './events.js';
import type { SpecialistOutput } from './adapters/gstack.js';

// --- Types ---

export interface SpecialistGatingEntry {
  /** Consecutive runs with zero findings. */
  consecutiveZeroRuns: number;
  /** Run number of the last run that produced findings. */
  lastFindingRun: number;
  /** Whether this specialist is currently gated. */
  gated: boolean;
}

export type SpecialistGatingState = Record<string, SpecialistGatingEntry>;

// --- Constants ---

/** Number of consecutive zero-finding runs before auto-gating. */
export const GATING_THRESHOLD = 10;

/** Specialists exempt from gating (insurance policies). */
export const EXEMPT_SPECIALISTS = new Set(['security', 'data-migration']);

// --- Gating logic ---

/**
 * Derive specialist gating state from event log.
 *
 * Scans TASK_COMPLETED events in the REVIEW stage for specialist output
 * metadata. Tracks consecutive zero-finding runs per specialist.
 */
export function deriveSpecialistGating(events: EventEnvelope[]): SpecialistGatingState {
  const state: SpecialistGatingState = {};
  let runNumber = 0;

  for (const envelope of events) {
    const ev = envelope.event;

    // Look for review task completions with specialist metadata
    if (ev.type !== 'TASK_COMPLETED') continue;

    // Check if the result contains specialist data
    let specialists: SpecialistOutput[] | undefined;
    try {
      if (ev.result) {
        const parsed = JSON.parse(ev.result);
        specialists = parsed.specialists ?? parsed.specialistOutputs;
      }
    } catch {
      continue;
    }

    if (!specialists || !Array.isArray(specialists)) continue;

    runNumber++;

    for (const spec of specialists) {
      const name = spec.specialist;
      if (!name) continue;

      if (!state[name]) {
        state[name] = { consecutiveZeroRuns: 0, lastFindingRun: 0, gated: false };
      }

      const entry = state[name];
      const findingCount = spec.findings?.length ?? 0;

      if (findingCount === 0) {
        entry.consecutiveZeroRuns++;
      } else {
        entry.consecutiveZeroRuns = 0;
        entry.lastFindingRun = runNumber;
      }

      // Apply gating (exempt specialists never gate)
      if (EXEMPT_SPECIALISTS.has(name)) {
        entry.gated = false;
      } else {
        entry.gated = entry.consecutiveZeroRuns >= GATING_THRESHOLD;
      }
    }
  }

  return state;
}

/** How often (in runs) to re-check a gated specialist so it can ungate. */
export const RECHECK_INTERVAL = 5;

/**
 * Get the list of active specialists for a given run.
 *
 * Gated specialists are re-included every RECHECK_INTERVAL runs so they
 * can produce events that un-gate them. Without periodic re-checks, a
 * gated specialist would never appear in review output again and could
 * never reset its consecutiveZeroRuns counter — making gating permanent
 * instead of adaptive.
 *
 * Exempt specialists (security, data-migration) always run.
 */
export function activeSpecialists(
  gating: SpecialistGatingState,
  allSpecialists?: string[],
  runNumber?: number,
): string[] {
  const all = allSpecialists ?? [
    'security', 'performance', 'testing',
    'data-migration', 'maintainability', 'api-contract', 'red-team',
  ];

  const run = runNumber ?? 0;

  return all.filter((name) => {
    if (EXEMPT_SPECIALISTS.has(name)) return true;
    const entry = gating[name];
    if (!entry) return true; // Unknown specialists default to active
    if (!entry.gated) return true;

    // Periodic re-check: include gated specialist every N runs
    // so it can produce output that un-gates it (or confirms the gate).
    if (run > 0 && run % RECHECK_INTERVAL === 0) return true;

    return false;
  });
}

/**
 * Deduplicate findings across specialists using fingerprints.
 *
 * When the same fingerprint appears from multiple specialists,
 * keep the one with highest severity. When the same fingerprint
 * appears across review iterations, suppress if it was already seen.
 */
export function deduplicateFindings<T extends { fingerprint?: string; severity?: string }>(
  findings: T[],
): T[] {
  const seen = new Map<string, T>();
  const severityRank: Record<string, number> = {
    CRITICAL: 4,
    MAJOR: 3,
    MINOR: 2,
    INFORMATIONAL: 1,
  };

  for (const finding of findings) {
    const key = finding.fingerprint;
    if (!key) {
      // No fingerprint — keep all
      seen.set(crypto.randomUUID(), finding);
      continue;
    }

    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, finding);
      continue;
    }

    // Keep higher severity
    const existingRank = severityRank[existing.severity ?? ''] ?? 0;
    const newRank = severityRank[finding.severity ?? ''] ?? 0;
    if (newRank > existingRank) {
      seen.set(key, finding);
    }
  }

  return [...seen.values()];
}
