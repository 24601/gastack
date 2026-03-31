/**
 * Bridge quality adapter — policy decision tree.
 *
 * Maps review and security scan results to gate decisions:
 *   - Security (/cso): HIGH+ severity → BLOCKED, LOW-MED → WARN
 *   - Correctness (/review): FAIL → BLOCKED, PASS → continue, NOT_RUN → BLOCKED
 *
 * Phase B1 scope: security and correctness gates only.
 * No design review or test gates (those are later phases).
 *
 * The adapter integrates with the bridge orchestrator via the standard
 * Adapter interface. Pure decision logic is in evaluate() — no IO.
 */

import type { Adapter } from './orchestrate.js';
import type { ReviewResult, Finding } from './adapters/gstack.js';

// --- Merge strategy ---

/**
 * Merge strategies that encode how code should land based on quality.
 *   - 'direct': push straight to main (earned by excellent code)
 *   - 'mr': go through refinery merge queue (default for decent code)
 *   - 'local': quarantine on branch, human must review (dangerous code)
 */
export type MergeStrategy = 'direct' | 'mr' | 'local';

// --- Gate decisions ---

export type GateVerdict = 'PASS' | 'WARN' | 'BLOCKED';

export interface GateResult {
  gate: string;
  verdict: GateVerdict;
  reason: string;
  findings: Finding[];
}

export interface QualityReport {
  overall: GateVerdict;
  gates: GateResult[];
  /** Human-readable summary of what happened. */
  summary: string;
}

// --- Policy configuration ---

export interface QualityPolicy {
  /** Minimum passing grade for correctness review (default: 'C'). */
  minReviewGrade: string;
  /** Security severities that trigger BLOCKED (default: ['CRITICAL', 'MAJOR']). */
  blockingSecuritySeverities: Finding['severity'][];
  /** Security severities that trigger WARN (default: ['MINOR']). */
  warningSecuritySeverities: Finding['severity'][];
  /** Whether NOT_RUN review should block (default: true). */
  blockOnNotRun: boolean;
}

export const DEFAULT_POLICY: QualityPolicy = {
  minReviewGrade: 'C',
  blockingSecuritySeverities: ['CRITICAL', 'MAJOR'],
  warningSecuritySeverities: ['MINOR'],
  blockOnNotRun: true,
};

// --- Grade comparison ---

const GRADE_ORDER = ['A+', 'A', 'A-', 'B+', 'B', 'B-', 'C+', 'C', 'C-', 'D+', 'D', 'D-', 'F'];

/**
 * Compare two letter grades. Returns negative if a < b, 0 if equal, positive if a > b.
 * "Better" grades have lower index (A+ = 0, F = 12).
 */
export function compareGrades(a: string, b: string): number {
  const aIdx = GRADE_ORDER.indexOf(a.toUpperCase());
  const bIdx = GRADE_ORDER.indexOf(b.toUpperCase());

  // Unknown grades sort to worst
  const aPos = aIdx === -1 ? GRADE_ORDER.length : aIdx;
  const bPos = bIdx === -1 ? GRADE_ORDER.length : bIdx;

  // Lower index = better grade, so invert for natural comparison
  return bPos - aPos;
}

/**
 * Check if a grade meets or exceeds the minimum.
 * e.g., gradePassesMinimum('B+', 'C') → true
 */
export function gradePassesMinimum(grade: string, minimum: string): boolean {
  return compareGrades(grade, minimum) >= 0;
}

// --- Security gate ---

/**
 * Evaluate CSO (security) review results.
 *
 * Policy:
 *   - Findings with CRITICAL or MAJOR severity → BLOCKED
 *   - Findings with MINOR severity → WARN
 *   - No findings → PASS
 *   - NOT_RUN (null result) → PASS (security scan is advisory in B1)
 */
export function evaluateSecurityGate(
  csoResult: ReviewResult | null,
  policy: QualityPolicy = DEFAULT_POLICY,
): GateResult {
  if (!csoResult) {
    return {
      gate: 'security',
      verdict: 'PASS',
      reason: 'Security scan not run (advisory in B1)',
      findings: [],
    };
  }

  const blockingFindings = csoResult.findings.filter(
    (f) => policy.blockingSecuritySeverities.includes(f.severity),
  );
  const warningFindings = csoResult.findings.filter(
    (f) => policy.warningSecuritySeverities.includes(f.severity),
  );

  if (blockingFindings.length > 0) {
    const severities = blockingFindings.map((f) => f.severity).join(', ');
    return {
      gate: 'security',
      verdict: 'BLOCKED',
      reason: `${blockingFindings.length} blocking security finding(s): ${severities}`,
      findings: blockingFindings,
    };
  }

  if (warningFindings.length > 0) {
    return {
      gate: 'security',
      verdict: 'WARN',
      reason: `${warningFindings.length} low-severity security finding(s)`,
      findings: warningFindings,
    };
  }

  return {
    gate: 'security',
    verdict: 'PASS',
    reason: 'No security findings',
    findings: [],
  };
}

// --- Correctness gate ---

/**
 * Evaluate review (correctness) results.
 *
 * Policy:
 *   - NOT_RUN (null result) → BLOCKED (review is mandatory)
 *   - Grade below minimum → BLOCKED
 *   - Grade at or above minimum → PASS
 *   - No grade but has CRITICAL findings → BLOCKED
 *   - No grade and no CRITICAL findings → WARN (unparseable output)
 */
export function evaluateCorrectnessGate(
  reviewResult: ReviewResult | null,
  policy: QualityPolicy = DEFAULT_POLICY,
): GateResult {
  if (!reviewResult) {
    if (policy.blockOnNotRun) {
      return {
        gate: 'correctness',
        verdict: 'BLOCKED',
        reason: 'Review not run (required by policy)',
        findings: [],
      };
    }
    return {
      gate: 'correctness',
      verdict: 'WARN',
      reason: 'Review not run',
      findings: [],
    };
  }

  // Has a parseable grade
  if (reviewResult.grade) {
    if (gradePassesMinimum(reviewResult.grade, policy.minReviewGrade)) {
      // Pass, but still surface warnings for any findings
      const warnings = reviewResult.findings.filter((f) => f.severity === 'MINOR');
      return {
        gate: 'correctness',
        verdict: warnings.length > 0 ? 'WARN' : 'PASS',
        reason: warnings.length > 0
          ? `Grade ${reviewResult.grade} passes (${warnings.length} minor finding(s))`
          : `Grade ${reviewResult.grade} passes minimum ${policy.minReviewGrade}`,
        findings: warnings,
      };
    }

    return {
      gate: 'correctness',
      verdict: 'BLOCKED',
      reason: `Grade ${reviewResult.grade} below minimum ${policy.minReviewGrade}`,
      findings: reviewResult.findings.filter(
        (f) => f.severity === 'CRITICAL' || f.severity === 'MAJOR',
      ),
    };
  }

  // No grade — check findings as fallback
  const criticalFindings = reviewResult.findings.filter((f) => f.severity === 'CRITICAL');
  if (criticalFindings.length > 0) {
    return {
      gate: 'correctness',
      verdict: 'BLOCKED',
      reason: `No grade parsed, ${criticalFindings.length} CRITICAL finding(s)`,
      findings: criticalFindings,
    };
  }

  return {
    gate: 'correctness',
    verdict: 'WARN',
    reason: 'No grade parsed from review output',
    findings: reviewResult.findings,
  };
}

// --- Combined evaluation ---

export interface EvaluateInput {
  review?: ReviewResult | null;
  cso?: ReviewResult | null;
}

/**
 * Evaluate all quality gates and produce a combined report.
 *
 * Overall verdict: BLOCKED if any gate is BLOCKED, WARN if any is WARN, else PASS.
 */
export function evaluate(
  input: EvaluateInput,
  policy: QualityPolicy = DEFAULT_POLICY,
): QualityReport {
  const gates: GateResult[] = [
    evaluateCorrectnessGate(input.review ?? null, policy),
    evaluateSecurityGate(input.cso ?? null, policy),
  ];

  const overall = deriveOverall(gates);
  const summary = formatSummary(gates, overall);

  return { overall, gates, summary };
}

/** Derive overall verdict from individual gate results. */
function deriveOverall(gates: GateResult[]): GateVerdict {
  if (gates.some((g) => g.verdict === 'BLOCKED')) return 'BLOCKED';
  if (gates.some((g) => g.verdict === 'WARN')) return 'WARN';
  return 'PASS';
}

/** Format a human-readable summary. */
function formatSummary(gates: GateResult[], overall: GateVerdict): string {
  const lines = gates.map(
    (g) => `${g.gate}: ${g.verdict} — ${g.reason}`,
  );
  return `Quality: ${overall}\n${lines.join('\n')}`;
}

// --- Merge strategy from quality verdicts ---

/**
 * Map a quality report to a merge strategy.
 *
 * Decision tree:
 *   - BLOCKED → 'local' (quarantine on branch, human must review)
 *   - WARN → 'mr' (refinery merge queue, extra scrutiny)
 *   - PASS with grade A (any variant) → 'direct' (push straight to main)
 *   - PASS with grade B-C → 'mr' (still goes through queue)
 *
 * The correctness gate's grade drives the direct/mr split for PASS verdicts.
 * If no grade is available (PASS from no-findings fallback), defaults to 'mr'.
 */
export function mergeStrategyFromVerdict(report: QualityReport): MergeStrategy {
  if (report.overall === 'BLOCKED') return 'local';
  if (report.overall === 'WARN') return 'mr';

  // PASS — check if the review grade earns direct merge
  const correctnessGate = report.gates.find((g) => g.gate === 'correctness');
  if (correctnessGate) {
    // Extract grade from the reason string (format: "Grade X passes ...")
    const gradeMatch = correctnessGate.reason.match(/^Grade\s+(\S+)\s+passes/);
    if (gradeMatch) {
      const grade = gradeMatch[1];
      // A+, A, A- all earn direct merge
      if (grade.toUpperCase().startsWith('A')) return 'direct';
    }
  }

  return 'mr';
}

// --- Adapter implementation ---

/**
 * Bridge adapter for quality policy evaluation.
 *
 * Commands routed through execute():
 *   - evaluate     → Run full quality evaluation from review suite JSON
 *   - security     → Evaluate security gate only
 *   - correctness  → Evaluate correctness gate only
 *   - policy       → Return current policy configuration
 */
export class QualityAdapter implements Adapter {
  readonly name = 'quality';
  private policy: QualityPolicy;

  constructor(opts?: { policy?: Partial<QualityPolicy> }) {
    this.policy = { ...DEFAULT_POLICY, ...opts?.policy };
  }

  async execute(
    command: string,
    args?: Record<string, unknown>,
  ): Promise<string> {
    switch (command) {
      case 'evaluate':
        return this.evaluateCmd(args);
      case 'security':
        return this.securityCmd(args);
      case 'correctness':
        return this.correctnessCmd(args);
      case 'policy':
        return this.policyCmd();
      default:
        throw new Error(`Unknown quality command: ${command}`);
    }
  }

  /** Full quality evaluation from review suite results. */
  private evaluateCmd(args?: Record<string, unknown>): string {
    const input = parseEvaluateInput(args);
    const report = evaluate(input, this.policy);
    return JSON.stringify(report);
  }

  /** Security gate evaluation only. */
  private securityCmd(args?: Record<string, unknown>): string {
    const cso = parseReviewArg(args?.cso);
    const result = evaluateSecurityGate(cso, this.policy);
    return JSON.stringify(result);
  }

  /** Correctness gate evaluation only. */
  private correctnessCmd(args?: Record<string, unknown>): string {
    const review = parseReviewArg(args?.review);
    const result = evaluateCorrectnessGate(review, this.policy);
    return JSON.stringify(result);
  }

  /** Return current policy. */
  private policyCmd(): string {
    return JSON.stringify(this.policy);
  }
}

// --- Input parsing helpers ---

/** Parse evaluate command input from adapter args. */
function parseEvaluateInput(args?: Record<string, unknown>): EvaluateInput {
  if (!args) return {};

  // Accept pre-parsed objects or JSON strings
  return {
    review: parseReviewArg(args.review),
    cso: parseReviewArg(args.cso),
  };
}

/** Parse a single ReviewResult from adapter args (object or JSON string). */
function parseReviewArg(value: unknown): ReviewResult | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as ReviewResult;
    } catch {
      return null;
    }
  }
  if (typeof value === 'object') return value as ReviewResult;
  return null;
}
