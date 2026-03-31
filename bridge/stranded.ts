/**
 * Stranded convoy diagnosis — joins gastown's "what's stuck" with gstack's "why it's stuck."
 *
 * When convoys get stranded (blocked by quality findings, missing workers, or
 * dependency cycles), this module produces actionable diagnoses with quality
 * context — not just "convoy stuck" but "convoy stuck because /cso found
 * CRITICAL XSS in task gt-t1x (A03: Injection)."
 *
 * Pure logic lives in diagnoseStranded(). The IO boundary is in the adapter
 * calls (gastown for convoy data, quality cache for gate results).
 */

import type { QualityReport, GateResult } from './quality.js';
import type { Finding } from './adapters/gstack.js';

// --- Types ---

/** Raw convoy data from `gt convoy stranded --json`. */
export interface StrandedConvoy {
  id: string;
  title: string;
  /** Number of issues tracked in the convoy. */
  tracked_count: number;
  /** Number of issues ready for dispatch. */
  ready_count: number;
  /** Issue IDs that are ready for dispatch. */
  ready_issues: string[];
  /** Issue IDs that are blocked. */
  blocked_issues?: string[];
}

/** Why a convoy is stranded. */
export type StrandedReason =
  | 'quality_blocked'
  | 'no_workers'
  | 'dependency_blocked'
  | 'empty';

/** Quality context attached to a stranded diagnosis. */
export interface QualityContext {
  blockingFindings: Finding[];
  reviewGrade?: string;
  csoSeverity?: string;
}

/** Full diagnosis for a single stranded convoy. */
export interface StrandedDiagnosis {
  convoyId: string;
  title: string;
  strandedReason: StrandedReason;
  qualityContext?: QualityContext;
  /** Human-readable recommended action. */
  recommendedAction: string;
}

// --- Diagnosis logic ---

/**
 * Diagnose why each convoy is stranded by joining convoy status with quality reports.
 *
 * For each stranded convoy, checks whether any of its ready issues have
 * BLOCKED quality reports. If so, surfaces the blocking findings as the
 * reason. Otherwise, classifies as no_workers, dependency_blocked, or empty.
 */
export function diagnoseStranded(
  convoys: StrandedConvoy[],
  qualityCache: Map<string, QualityReport>,
): StrandedDiagnosis[] {
  return convoys.map((convoy) => diagnoseOne(convoy, qualityCache));
}

/** Diagnose a single stranded convoy. */
function diagnoseOne(
  convoy: StrandedConvoy,
  qualityCache: Map<string, QualityReport>,
): StrandedDiagnosis {
  // Check if any tracked issues have BLOCKED quality reports
  const allIssues = [
    ...convoy.ready_issues,
    ...(convoy.blocked_issues ?? []),
  ];
  const blockedReports = allIssues
    .map((id) => ({ id, report: qualityCache.get(id) }))
    .filter((entry): entry is { id: string; report: QualityReport } =>
      entry.report !== undefined && entry.report.overall === 'BLOCKED',
    );

  if (blockedReports.length > 0) {
    return diagnoseQualityBlocked(convoy, blockedReports);
  }

  if (convoy.ready_count > 0) {
    return {
      convoyId: convoy.id,
      title: convoy.title,
      strandedReason: 'no_workers',
      recommendedAction:
        `${convoy.ready_count} issue(s) ready but no workers assigned. ` +
        `Re-sling to available polecats.`,
    };
  }

  if (convoy.tracked_count === 0) {
    return {
      convoyId: convoy.id,
      title: convoy.title,
      strandedReason: 'empty',
      recommendedAction: 'Empty convoy — auto-close.',
    };
  }

  return {
    convoyId: convoy.id,
    title: convoy.title,
    strandedReason: 'dependency_blocked',
    recommendedAction:
      'All issues blocked by dependencies. Check dependency graph.',
  };
}

/** Build diagnosis when quality findings are the cause. */
function diagnoseQualityBlocked(
  convoy: StrandedConvoy,
  blockedReports: { id: string; report: QualityReport }[],
): StrandedDiagnosis {
  // Collect all blocking findings across all blocked issues
  const allBlockingFindings: Finding[] = [];
  let worstGrade: string | undefined;
  let worstCsoSeverity: string | undefined;

  for (const { report } of blockedReports) {
    for (const gate of report.gates) {
      if (gate.verdict === 'BLOCKED') {
        allBlockingFindings.push(...gate.findings);
        if (gate.gate === 'correctness') {
          // Extract grade from reason (e.g., "Grade D below minimum C")
          const gradeMatch = gate.reason.match(/Grade\s+([A-F][+-]?)/i);
          if (gradeMatch) {
            worstGrade = gradeMatch[1];
          }
        }
        if (gate.gate === 'security') {
          // Pick worst severity from findings
          for (const f of gate.findings) {
            if (f.severity === 'CRITICAL') worstCsoSeverity = 'CRITICAL';
            else if (f.severity === 'MAJOR' && worstCsoSeverity !== 'CRITICAL') {
              worstCsoSeverity = 'MAJOR';
            }
          }
        }
      }
    }
  }

  const action = formatBlockedAction(blockedReports, allBlockingFindings);

  return {
    convoyId: convoy.id,
    title: convoy.title,
    strandedReason: 'quality_blocked',
    qualityContext: {
      blockingFindings: allBlockingFindings,
      reviewGrade: worstGrade,
      csoSeverity: worstCsoSeverity,
    },
    recommendedAction: action,
  };
}

/** Format a human-readable action for quality-blocked convoys. */
function formatBlockedAction(
  blockedReports: { id: string; report: QualityReport }[],
  findings: Finding[],
): string {
  if (findings.length === 0) {
    const issueIds = blockedReports.map((r) => r.id).join(', ');
    return `Quality gates BLOCKED on ${issueIds}. Check review output for details.`;
  }

  const criticals = findings.filter((f) => f.severity === 'CRITICAL');
  const majors = findings.filter((f) => f.severity === 'MAJOR');

  const parts: string[] = [];
  if (criticals.length > 0) {
    parts.push(
      `${criticals.length} CRITICAL: ${criticals.map((f) => f.description).join('; ')}`,
    );
  }
  if (majors.length > 0) {
    parts.push(
      `${majors.length} MAJOR: ${majors.map((f) => f.description).join('; ')}`,
    );
  }

  return `Quality blocked — ${parts.join('. ')}. Fix findings or accept risk before re-dispatching.`;
}

// --- Formatting ---

/**
 * Format diagnoses for human-readable CLI output.
 *
 * Example output:
 *   Convoy hq-cv-abc stranded (quality_blocked):
 *     /cso found CRITICAL XSS in task gt-t1x (A03: Injection).
 *     Fix findings or accept risk before re-dispatching.
 */
export function formatDiagnoses(diagnoses: StrandedDiagnosis[]): string {
  if (diagnoses.length === 0) {
    return 'No stranded convoys.';
  }

  return diagnoses
    .map((d) => {
      const header = `Convoy ${d.convoyId} stranded (${d.strandedReason}): ${d.title}`;
      const action = `  ${d.recommendedAction}`;
      const context = d.qualityContext
        ? formatQualityContext(d.qualityContext)
        : '';
      return [header, context, action].filter(Boolean).join('\n');
    })
    .join('\n\n');
}

/** Format quality context as indented detail lines. */
function formatQualityContext(ctx: QualityContext): string {
  const lines: string[] = [];
  if (ctx.reviewGrade) {
    lines.push(`  Review grade: ${ctx.reviewGrade}`);
  }
  if (ctx.csoSeverity) {
    lines.push(`  CSO severity: ${ctx.csoSeverity}`);
  }
  if (ctx.blockingFindings.length > 0) {
    for (const f of ctx.blockingFindings) {
      lines.push(`  [${f.severity}] ${f.description}`);
    }
  }
  return lines.join('\n');
}

/** Format a diagnosis for notification payload (compact, single message). */
export function formatDiagnosisForNotify(diagnosis: StrandedDiagnosis): {
  text: string;
  fields: Record<string, string>;
  severity: 'info' | 'warn' | 'error';
} {
  const severity: 'info' | 'warn' | 'error' =
    diagnosis.strandedReason === 'quality_blocked' ? 'error' :
    diagnosis.strandedReason === 'no_workers' ? 'warn' : 'info';

  const text = `Convoy ${diagnosis.convoyId} stranded: ${diagnosis.title}`;

  const fields: Record<string, string> = {
    Reason: diagnosis.strandedReason,
    Action: diagnosis.recommendedAction,
  };

  if (diagnosis.qualityContext?.csoSeverity) {
    fields['CSO Severity'] = diagnosis.qualityContext.csoSeverity;
  }
  if (diagnosis.qualityContext?.reviewGrade) {
    fields['Review Grade'] = diagnosis.qualityContext.reviewGrade;
  }
  if (diagnosis.qualityContext?.blockingFindings.length) {
    fields['Findings'] = diagnosis.qualityContext.blockingFindings
      .map((f) => `[${f.severity}] ${f.description}`)
      .join('\n');
  }

  return { text, fields, severity };
}
