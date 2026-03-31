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

// --- Failure policy (session death response) ---

/**
 * Death event types from gastown.
 *   - session_death: a single polecat session died
 *   - mass_death: multiple sessions died in a short window
 *   - scheduler_dispatch_failed: scheduler couldn't assign work
 */
export type DeathEventType = 'session_death' | 'mass_death' | 'scheduler_dispatch_failed';

/** A death event received from gastown's event stream. */
export interface DeathEvent {
  type: DeathEventType;
  /** Task or bead ID that was being worked on. */
  taskId?: string;
  /** Polecat/session that died. */
  sessionId?: string;
  /** How many sessions died (for mass_death). */
  count?: number;
  /** Time window in seconds (for mass_death). */
  windowSeconds?: number;
  /** Error or reason for death if known. */
  reason?: string;
  /** ISO timestamp of the event. */
  timestamp: string;
}

/**
 * Failure response actions.
 *   - retry: transient failure, retry the task
 *   - investigate: repeated failure, run /investigate to find root cause
 *   - halt: mass failure, stop all dispatch and surface to human
 */
export type FailureAction = 'retry' | 'investigate' | 'halt';

/** Result of classifying a death event. */
export interface FailureResponse {
  action: FailureAction;
  reason: string;
  /** Task ID to retry or investigate (if applicable). */
  taskId?: string;
  /** Whether to surface this to a human operator. */
  surfaceToHuman: boolean;
}

/**
 * Failure policy configuration.
 *   - maxRetries: how many times to auto-retry before triggering investigation
 *   - massDeathThreshold: how many deaths in a window trigger HALT
 *   - massDeathWindowSeconds: the time window for mass death detection
 */
export interface FailurePolicy {
  maxRetries: number;
  massDeathThreshold: number;
  massDeathWindowSeconds: number;
}

export const DEFAULT_FAILURE_POLICY: FailurePolicy = {
  maxRetries: 1,
  massDeathThreshold: 3,
  massDeathWindowSeconds: 300,
};

/**
 * Track per-task death counts for retry vs investigate decisions.
 * Key: taskId, Value: number of deaths seen.
 */
export type DeathLedger = Map<string, number>;

/**
 * Classify a death event into a failure response.
 *
 * Decision tree:
 *   - mass_death → HALT (always, regardless of retry count)
 *   - scheduler_dispatch_failed → HALT (infrastructure broken)
 *   - session_death, first occurrence for task → retry (transient)
 *   - session_death, repeated for same task → investigate (root cause needed)
 *
 * Encodes gstack's /investigate opinion:
 * "Iron Law: no fixes without root cause." Blind retry is the opposite of investigation.
 */
export function classifyDeathEvent(
  event: DeathEvent,
  ledger: DeathLedger,
  policy: FailurePolicy = DEFAULT_FAILURE_POLICY,
): FailureResponse {
  // mass_death: always halt
  if (event.type === 'mass_death') {
    return {
      action: 'halt',
      reason: `Mass death: ${event.count ?? 'unknown'} sessions died within ${event.windowSeconds ?? 'unknown'}s. All dispatch halted pending human review.`,
      surfaceToHuman: true,
    };
  }

  // scheduler_dispatch_failed: infrastructure failure → halt
  if (event.type === 'scheduler_dispatch_failed') {
    return {
      action: 'halt',
      reason: `Scheduler dispatch failed: ${event.reason ?? 'unknown cause'}. Infrastructure may be degraded.`,
      surfaceToHuman: true,
    };
  }

  // session_death: check retry count for this task
  const taskId = event.taskId ?? 'unknown';
  const priorDeaths = ledger.get(taskId) ?? 0;
  const newCount = priorDeaths + 1;
  ledger.set(taskId, newCount);

  if (newCount <= policy.maxRetries) {
    return {
      action: 'retry',
      reason: `Session death for task ${taskId} (attempt ${newCount}/${policy.maxRetries + 1}). Retrying — may be transient.`,
      taskId,
      surfaceToHuman: false,
    };
  }

  // Repeated death: Iron Law — no fixes without root cause
  return {
    action: 'investigate',
    reason: `Session death for task ${taskId} repeated ${newCount} times (exceeds ${policy.maxRetries} retry limit). Triggering /investigate for root cause analysis.`,
    taskId,
    surfaceToHuman: true,
  };
}

/**
 * Check if a batch of recent death events constitutes a mass death.
 * Used by the EventTailer handler to detect mass_death from individual events.
 */
export function detectMassDeath(
  recentDeaths: DeathEvent[],
  policy: FailurePolicy = DEFAULT_FAILURE_POLICY,
): boolean {
  if (recentDeaths.length < policy.massDeathThreshold) return false;

  // Check if enough deaths occurred within the window
  const now = Date.now();
  const windowMs = policy.massDeathWindowSeconds * 1000;
  const inWindow = recentDeaths.filter((e) => {
    const eventTime = new Date(e.timestamp).getTime();
    return now - eventTime <= windowMs;
  });

  return inWindow.length >= policy.massDeathThreshold;
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
 *   - classify-death → Classify a death event into a failure response
 *   - failure-policy → Return current failure policy configuration
 */
export class QualityAdapter implements Adapter {
  readonly name = 'quality';
  private policy: QualityPolicy;
  private failurePolicy: FailurePolicy;
  private deathLedger: DeathLedger = new Map();

  constructor(opts?: {
    policy?: Partial<QualityPolicy>;
    failurePolicy?: Partial<FailurePolicy>;
  }) {
    this.policy = { ...DEFAULT_POLICY, ...opts?.policy };
    this.failurePolicy = { ...DEFAULT_FAILURE_POLICY, ...opts?.failurePolicy };
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
      case 'classify-death':
        return this.classifyDeathCmd(args);
      case 'failure-policy':
        return JSON.stringify(this.failurePolicy);
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

  /** Classify a death event and return the failure response. */
  private classifyDeathCmd(args?: Record<string, unknown>): string {
    if (!args?.event) {
      throw new Error('classify-death requires args.event');
    }
    const event = (typeof args.event === 'string'
      ? JSON.parse(args.event)
      : args.event) as DeathEvent;
    const response = classifyDeathEvent(event, this.deathLedger, this.failurePolicy);
    return JSON.stringify(response);
  }

  /** Expose death ledger for inspection (testing/debugging). */
  getDeathLedger(): DeathLedger {
    return this.deathLedger;
  }

  /** Reset death tracking state (e.g., after manual intervention). */
  resetDeathLedger(): void {
    this.deathLedger.clear();
  }
}

// --- Review routing (inline vs review-only polecat) ---

/**
 * Security-sensitive file path patterns.
 * Changes touching these paths ALWAYS get a review-only polecat
 * (separate context, can't be influenced by "I just wrote this").
 */
export const SECURITY_SENSITIVE_PATTERNS: RegExp[] = [
  /\bauth\b/i,
  /\blogin\b/i,
  /\bsession\b/i,
  /\btoken\b/i,
  /\bcredential/i,
  /\bsecret/i,
  /\bpassword/i,
  /\bcrypto\b/i,
  /\bencrypt/i,
  /\bdecrypt/i,
  /\bpayment/i,
  /\bbilling\b/i,
  /\bstripe\b/i,
  /\bcheckout\b/i,
  /\bpermission/i,
  /\baccess.?control/i,
  /\brbac\b/i,
  /\boauth\b/i,
  /\bjwt\b/i,
  /\bapi.?key/i,
  /\bsigning\b/i,
  /\bcertificat/i,
  /\btls\b/i,
  /\bssl\b/i,
  /\.env\b/,
  /\bsecrets?\.\w+$/i,
];

/**
 * Check whether a file path matches any security-sensitive pattern.
 */
export function isSecuritySensitivePath(filePath: string): boolean {
  return SECURITY_SENSITIVE_PATTERNS.some((p) => p.test(filePath));
}

/**
 * Review routing decision: should we use a review-only polecat
 * (separate context) or inline review (same context)?
 *
 * Decision tree:
 *   - Any security-sensitive file path → ALWAYS review-only polecat
 *   - Multi-file (>1 file) AND >50 total changed lines → review-only polecat
 *   - Single file ≤50 lines → inline review (gstack adapter, same context)
 *
 * Returns 'review-only' or 'inline'.
 */
export type ReviewMode = 'review-only' | 'inline';

export interface ReviewRoutingInput {
  /** Changed file paths in the diff. */
  changedFiles: string[];
  /** Total number of changed lines (additions + deletions). */
  totalChangedLines: number;
}

export function routeReview(input: ReviewRoutingInput): {
  mode: ReviewMode;
  reason: string;
} {
  // Security-sensitive paths always get separate-context review
  const sensitiveFiles = input.changedFiles.filter(isSecuritySensitivePath);
  if (sensitiveFiles.length > 0) {
    return {
      mode: 'review-only',
      reason: `Security-sensitive path(s): ${sensitiveFiles.slice(0, 3).join(', ')}${sensitiveFiles.length > 3 ? ` (+${sensitiveFiles.length - 3} more)` : ''}`,
    };
  }

  // Multi-file, >50 lines → separate context for unbiased review
  if (input.changedFiles.length > 1 && input.totalChangedLines > 50) {
    return {
      mode: 'review-only',
      reason: `${input.changedFiles.length} files, ${input.totalChangedLines} lines changed (threshold: >1 file, >50 lines)`,
    };
  }

  // Small change: inline review is fine
  return {
    mode: 'inline',
    reason: input.changedFiles.length <= 1
      ? `Single file, ${input.totalChangedLines} lines`
      : `${input.changedFiles.length} files, ${input.totalChangedLines} lines (under threshold)`,
  };
}

// --- Review iteration tracking ---

/**
 * Tracks the state of a single review-fix-rereview iteration.
 *
 * The bridge uses this to decide whether to loop back (REFINE→EXECUTE)
 * or escalate to a human. Each iteration records the quality report,
 * what was fixed, and what remains.
 */
export interface QualityIteration {
  /** 1-indexed iteration number. */
  iteration: number;
  /** The quality report from this iteration's review. */
  report: QualityReport;
  /** Descriptions of fixes applied before this review (empty on first iteration). */
  fixesApplied: string[];
  /** Findings that remain unresolved after this iteration. */
  remainingFindings: Finding[];
}

/**
 * Policy for the review-fix-rereview loop.
 */
export interface ReviewLoopPolicy {
  /** Maximum iterations before escalating to human (default: 3). */
  maxIterations: number;
}

export const DEFAULT_REVIEW_LOOP_POLICY: ReviewLoopPolicy = {
  maxIterations: 3,
};

/**
 * Decide whether to reiterate (loop back to fix and re-review).
 *
 * Returns false (stop iterating) when:
 *   - Max iterations reached
 *   - No fixable findings remain (only CRITICAL left, which needs human)
 *   - Last iteration made no progress (same findings, no fixes applied)
 *
 * Returns true (keep iterating) when:
 *   - There are MAJOR or MINOR findings that an agent can fix
 *   - Fixes were applied last round (progress is being made)
 */
export function shouldReiterate(
  current: QualityIteration,
  policy: ReviewLoopPolicy = DEFAULT_REVIEW_LOOP_POLICY,
): boolean {
  // Stop if max iterations reached
  if (current.iteration >= policy.maxIterations) return false;

  // Stop if no fixable findings remain
  // CRITICAL findings need human judgment — not auto-fixable
  const fixable = current.remainingFindings.filter(
    (f) => f.severity !== 'CRITICAL',
  );
  if (fixable.length === 0) return false;

  // Stop if last iteration made no progress (no fixes applied = stuck)
  if (current.iteration > 1 && current.fixesApplied.length === 0) return false;

  return true;
}

/**
 * Extract auto-fixable findings from a quality report.
 * CRITICAL findings are excluded — they require human judgment.
 */
export function extractFixableFindings(report: QualityReport): Finding[] {
  return report.gates.flatMap((gate) =>
    gate.findings.filter((f) => f.severity !== 'CRITICAL'),
  );
}

/**
 * Compare findings across two iterations to detect progress.
 * Returns findings that were resolved (present in previous, absent in current).
 */
export function resolvedFindings(
  previous: Finding[],
  current: Finding[],
): Finding[] {
  return previous.filter(
    (prev) => !current.some(
      (curr) => curr.severity === prev.severity && curr.description === prev.description,
    ),
  );
}

/**
 * Summarize iteration state for human-readable output or bead notes.
 */
export function summarizeIteration(iteration: QualityIteration): string {
  const lines = [
    `Iteration ${iteration.iteration}:`,
    `  Overall: ${iteration.report.overall}`,
    `  Findings remaining: ${iteration.remainingFindings.length}`,
  ];
  if (iteration.fixesApplied.length > 0) {
    lines.push(`  Fixes applied: ${iteration.fixesApplied.join('; ')}`);
  }
  const fixable = iteration.remainingFindings.filter((f) => f.severity !== 'CRITICAL');
  const critical = iteration.remainingFindings.filter((f) => f.severity === 'CRITICAL');
  if (critical.length > 0) {
    lines.push(`  CRITICAL (needs human): ${critical.map((f) => f.description).join('; ')}`);
  }
  if (fixable.length > 0) {
    lines.push(`  Fixable: ${fixable.map((f) => `[${f.severity}] ${f.description}`).join('; ')}`);
  }
  return lines.join('\n');
}

// --- Multi-model verdict reconciliation ---

/**
 * Reconciliation outcome when two models review the same code.
 *   - 'agree_pass': both models agree the code passes
 *   - 'agree_block': both models agree the code should be blocked
 *   - 'human_review': one PASS + one BLOCK — fundamental disagreement, human decides
 *   - 'stricter': one WARN involved — take the stricter verdict automatically
 */
export type ReconciliationOutcome =
  | 'agree_pass'
  | 'agree_block'
  | 'human_review'
  | 'stricter';

export interface ReconciliationResult {
  /** What happened. */
  outcome: ReconciliationOutcome;
  /** The final verdict after reconciliation. */
  finalVerdict: GateVerdict;
  /** Whether the two models disagreed (the interesting signal). */
  disagreement: boolean;
  /** Human-readable explanation. */
  reason: string;
  /** Primary model's verdict. */
  primaryVerdict: GateVerdict;
  /** Secondary (review) model's verdict. */
  secondaryVerdict: GateVerdict;
}

/**
 * Reconcile two quality verdicts from different models.
 *
 * Implements the "20th dentist" philosophy from gstack's /codex skill:
 * two models disagreeing is SIGNAL, not noise.
 *
 * Disagreement policy:
 *   - Both PASS → PASS (agreement)
 *   - Both BLOCKED → BLOCKED (agreement)
 *   - One BLOCKED + one PASS → HUMAN REVIEW (the interesting case)
 *   - One WARN + one anything → take stricter verdict (auto-resolve)
 *
 * The key insight: PASS vs BLOCKED means two independent model families
 * see the code fundamentally differently. That's exactly when a human
 * should look — the disagreement itself is the signal.
 */
export function reconcileVerdicts(
  primary: GateVerdict,
  secondary: GateVerdict,
): ReconciliationResult {
  // Agreement: both same verdict
  if (primary === secondary) {
    return {
      outcome: primary === 'PASS' ? 'agree_pass' : primary === 'BLOCKED' ? 'agree_block' : 'stricter',
      finalVerdict: primary,
      disagreement: false,
      reason: `Both models agree: ${primary}`,
      primaryVerdict: primary,
      secondaryVerdict: secondary,
    };
  }

  // BLOCKED vs PASS (either direction) → human review
  if (
    (primary === 'BLOCKED' && secondary === 'PASS') ||
    (primary === 'PASS' && secondary === 'BLOCKED')
  ) {
    return {
      outcome: 'human_review',
      finalVerdict: 'BLOCKED', // Block until human decides
      disagreement: true,
      reason: `Models disagree: ${primary} vs ${secondary}. Escalating to human review — the disagreement is the signal.`,
      primaryVerdict: primary,
      secondaryVerdict: secondary,
    };
  }

  // WARN involved: take the stricter verdict
  const stricter = stricterVerdict(primary, secondary);
  return {
    outcome: 'stricter',
    finalVerdict: stricter,
    disagreement: true,
    reason: `One model warns, taking stricter: ${stricter} (primary: ${primary}, secondary: ${secondary})`,
    primaryVerdict: primary,
    secondaryVerdict: secondary,
  };
}

/** Return the stricter of two verdicts. BLOCKED > WARN > PASS. */
function stricterVerdict(a: GateVerdict, b: GateVerdict): GateVerdict {
  const order: Record<GateVerdict, number> = { PASS: 0, WARN: 1, BLOCKED: 2 };
  return order[a] >= order[b] ? a : b;
}

/**
 * Reconcile two full quality reports from different models.
 *
 * Applies reconcileVerdicts to the overall verdicts, and merges findings
 * from both reports for complete context.
 */
export function reconcileReports(
  primary: QualityReport,
  secondary: QualityReport,
): {
  reconciliation: ReconciliationResult;
  /** Merged report with findings from both models. */
  mergedReport: QualityReport;
} {
  const reconciliation = reconcileVerdicts(primary.overall, secondary.overall);

  // Merge gates: take the stricter gate result for each gate name
  const gateMap = new Map<string, GateResult>();
  for (const g of [...primary.gates, ...secondary.gates]) {
    const existing = gateMap.get(g.gate);
    if (!existing || verdictSeverity(g.verdict) > verdictSeverity(existing.verdict)) {
      gateMap.set(g.gate, {
        ...g,
        // Merge findings from both if same gate
        findings: existing
          ? deduplicateFindings([...existing.findings, ...g.findings])
          : g.findings,
      });
    } else if (existing) {
      // Keep existing (stricter) but merge findings
      existing.findings = deduplicateFindings([...existing.findings, ...g.findings]);
    }
  }

  const mergedGates = Array.from(gateMap.values());
  const mergedReport: QualityReport = {
    overall: reconciliation.finalVerdict,
    gates: mergedGates,
    summary: reconciliation.disagreement
      ? `Multi-model review: ${reconciliation.reason}\n` +
        formatSummaryFromGates(mergedGates, reconciliation.finalVerdict)
      : formatSummaryFromGates(mergedGates, reconciliation.finalVerdict),
  };

  return { reconciliation, mergedReport };
}

/** Numeric severity for comparison. */
function verdictSeverity(v: GateVerdict): number {
  const order: Record<GateVerdict, number> = { PASS: 0, WARN: 1, BLOCKED: 2 };
  return order[v];
}

/** Deduplicate findings by description (case-insensitive). */
function deduplicateFindings(findings: Finding[]): Finding[] {
  const seen = new Set<string>();
  return findings.filter((f) => {
    const key = f.description.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Format summary from gates (extracted for reuse). */
function formatSummaryFromGates(gates: GateResult[], overall: GateVerdict): string {
  const lines = gates.map((g) => `${g.gate}: ${g.verdict} — ${g.reason}`);
  return `Quality: ${overall}\n${lines.join('\n')}`;
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
