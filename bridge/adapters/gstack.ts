/**
 * gstack adapter — skill execution via gt sling --agent.
 *
 * Routes /review, /cso, /investigate, /canary skills through gt sling --agent
 * for native multi-model dispatch and proper lifecycle management from the
 * witness (see GASTOWN-BRIDGE-REVIEW.md #4).
 *
 * claudeExec() is still exported for lightweight one-shot operations (e.g.,
 * task extraction in extract.ts) that don't need lifecycle management.
 *
 * All CLI calls use Bun.spawn with array args (no shell interpolation).
 */

import type { Adapter } from '../orchestrate.js';
import { gtExec } from './gastown.js';

// --- Types ---

export interface ClaudeResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Parsed review output with grade and findings. */
export interface ReviewResult {
  grade: string | null;
  findings: Finding[];
  raw: string;
}

export interface Finding {
  severity: 'CRITICAL' | 'MAJOR' | 'MINOR';
  description: string;
}

/** Combined result from parallel review + CSO execution. */
export interface ReviewSuiteResult {
  review: ReviewResult;
  cso: ReviewResult;
}

/** Structured output from /investigate root cause analysis. */
export interface InvestigationResult {
  /** Root cause description (extracted or full output). */
  rootCause: string;
  /** Whether the issue is systemic (infra/config) vs task-specific (code bug). */
  systemic: boolean;
  /** Full diagnosis text. */
  diagnosis: string;
  /** Raw output from claude -p. */
  raw: string;
}

// --- Grade parser ---

const GRADE_PATTERN = /\b(?:Grade|Rating|Score)\s*[:=]\s*([A-F][+-]?)/i;
const FINDING_PATTERN = /\*\*?(CRITICAL|MAJOR|MINOR)\*?\*?\s*[:—\-]\s*(.+)/gi;

/** Extract a letter grade (A-F, with optional +/-) from review output. */
export function parseGrade(text: string): string | null {
  const match = GRADE_PATTERN.exec(text);
  return match ? match[1].toUpperCase() : null;
}

/** Extract structured findings from review output. */
export function parseFindings(text: string): Finding[] {
  const findings: Finding[] = [];
  let match: RegExpExecArray | null;

  // Reset lastIndex for global regex
  FINDING_PATTERN.lastIndex = 0;
  while ((match = FINDING_PATTERN.exec(text)) !== null) {
    findings.push({
      severity: match[1].toUpperCase() as Finding['severity'],
      description: match[2].trim(),
    });
  }
  return findings;
}

/** Parse full review output into structured result. */
export function parseReviewOutput(raw: string): ReviewResult {
  return {
    grade: parseGrade(raw),
    findings: parseFindings(raw),
    raw,
  };
}

// --- Investigation output parser ---

const ROOT_CAUSE_PATTERN = /(?:Root\s*Cause|Root\s*cause|ROOT\s*CAUSE)\s*[:—\-]\s*(.+?)(?:\n|$)/i;
const SYSTEMIC_PATTERNS = [
  /\bsystemic\b/i,
  /\binfrastructure\b/i,
  /\bconfig(?:uration)?\s+(?:drift|issue|error|problem)\b/i,
  /\bdependency\s+(?:failure|issue|broken|incompatib)/i,
  /\bservice\s+(?:outage|down|unavailabl)/i,
  /\bnetwork\b/i,
  /\bDNS\b/,
  /\bOOM\b/,
  /\bout\s*of\s*memory\b/i,
  /\bdisk\s+(?:full|space)\b/i,
  /\bpermission\s+denied\b/i,
  /\brate\s*limit/i,
];

/**
 * Parse /investigate output into structured diagnosis.
 * Extracts root cause, systemic classification, and full diagnosis.
 */
export function parseInvestigationOutput(raw: string): InvestigationResult {
  // Extract root cause line if present
  const rootCauseMatch = ROOT_CAUSE_PATTERN.exec(raw);
  const rootCause = rootCauseMatch
    ? rootCauseMatch[1].trim()
    : raw.slice(0, 200).trim(); // Fallback: first 200 chars

  // Check for systemic indicators
  const systemic = SYSTEMIC_PATTERNS.some((p) => p.test(raw));

  return {
    rootCause,
    systemic,
    diagnosis: raw,
    raw,
  };
}

// --- claude -p executor ---

/**
 * Execute `claude -p` with a prompt string.
 * Uses Bun.spawn with array args — no shell interpolation.
 */
export async function claudeExec(
  prompt: string,
  opts?: {
    cwd?: string;
    timeout?: number;
    model?: string;
    maxTurns?: number;
    allowedTools?: string[];
    dangerouslySkipPermissions?: boolean;
  },
): Promise<ClaudeResult> {
  const timeout = opts?.timeout ?? 300_000; // 5 min default for reviews
  const args = ['-p'];

  if (opts?.model) {
    args.push('--model', opts.model);
  }
  if (opts?.maxTurns) {
    args.push('--max-turns', String(opts.maxTurns));
  }
  if (opts?.dangerouslySkipPermissions) {
    args.push('--dangerously-skip-permissions');
  }
  if (opts?.allowedTools) {
    for (const tool of opts.allowedTools) {
      args.push('--allowed-tools', tool);
    }
  }

  const proc = Bun.spawn(['claude', ...args], {
    cwd: opts?.cwd,
    stdin: new Response(prompt).body!,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env },
  });

  const timer = setTimeout(() => proc.kill(), timeout);

  try {
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;

    return {
      stdout: stdout.trimEnd(),
      stderr: stderr.trimEnd(),
      exitCode,
    };
  } finally {
    clearTimeout(timer);
  }
}

// --- Error type ---

export class ClaudeError extends Error {
  readonly prompt: string;
  readonly result: ClaudeResult;

  constructor(message: string, prompt: string, result: ClaudeResult) {
    super(message);
    this.name = 'ClaudeError';
    this.prompt = prompt;
    this.result = result;
  }
}

// --- Adapter implementation ---

/**
 * gstack adapter for the bridge orchestrator.
 *
 * Commands routed through execute():
 *   - review       → Run /review via gt sling --agent, parse grade + findings
 *   - cso          → Run /cso via gt sling --agent, parse grade + findings
 *   - review-suite → Run /review + /cso via gt sling --agent (parallel)
 *   - investigate  → Run /investigate via gt sling --agent for root cause analysis
 *   - canary       → Run /canary via gt sling --agent for post-deploy verification
 *   - raw          → Run arbitrary prompt via claude -p (no lifecycle needed)
 */
export class GstackAdapter implements Adapter {
  readonly name = 'gstack';
  private cwd: string;
  private timeout: number;
  private agent: string;
  private maxTurns: number;

  constructor(opts: {
    cwd: string;
    timeout?: number;
    /** Agent for gt sling --agent (e.g., 'claude', 'codex', 'gemini'). Default: 'claude'. */
    agent?: string;
    maxTurns?: number;
  }) {
    this.cwd = opts.cwd;
    this.timeout = opts.timeout ?? 300_000;
    this.agent = opts.agent ?? 'claude';
    this.maxTurns = opts.maxTurns ?? 30;
  }

  async execute(
    command: string,
    args?: Record<string, unknown>,
  ): Promise<string> {
    switch (command) {
      case 'review':
        return this.runSkill('/review', args);

      case 'cso':
        return this.runSkill('/cso', args);

      case 'review-suite':
        return this.runReviewSuite(args);

      case 'investigate':
        return this.runInvestigate(args);

      case 'canary':
        return this.runCanary(args);

      case 'raw':
        return this.runRaw(args);

      default:
        throw new Error(`Unknown gstack command: ${command}`);
    }
  }

  /**
   * Run a skill (e.g., /review, /cso) via gt sling --agent.
   * Returns parsed JSON with grade, findings, and raw output.
   */
  private async runSkill(
    skill: string,
    args?: Record<string, unknown>,
  ): Promise<string> {
    const branch = args?.branch ? ` --branch ${String(args.branch)}` : '';
    const contextPreamble = args?.executionContext
      ? `${String(args.executionContext)}\n\n`
      : '';
    const prompt = `${contextPreamble}${skill}${branch}`;

    const agent = args?.agent ? String(args.agent) : this.agent;
    const result = await this.slingExec(prompt, agent);

    const parsed = parseReviewOutput(result.stdout);
    return JSON.stringify(parsed);
  }

  /**
   * Run /review and /cso in parallel via gt sling --agent (Promise.all).
   * Returns combined JSON with both results.
   */
  private async runReviewSuite(
    args?: Record<string, unknown>,
  ): Promise<string> {
    const [review, cso] = await Promise.all([
      this.runSkill('/review', args),
      this.runSkill('/cso', args),
    ]);

    const reviewParsed = JSON.parse(review) as ReviewResult;
    const csoParsed = JSON.parse(cso) as ReviewResult;

    const suite: ReviewSuiteResult = {
      review: reviewParsed,
      cso: csoParsed,
    };

    return JSON.stringify(suite);
  }

  /**
   * Run /investigate via gt sling --agent for root cause analysis.
   * Returns JSON with { rootCause, systemic, diagnosis, raw }.
   */
  private async runInvestigate(
    args?: Record<string, unknown>,
  ): Promise<string> {
    const error = args?.error ? String(args.error) : '';
    const taskDescription = args?.taskDescription ? String(args.taskDescription) : '';

    const contextParts = [
      taskDescription ? `Failed task: ${taskDescription}` : '',
      error ? `Error: ${error}` : '',
      '',
      '/investigate',
    ].filter(Boolean);

    const prompt = contextParts.join('\n');
    const agent = args?.agent ? String(args.agent) : this.agent;
    const result = await this.slingExec(prompt, agent);

    const diagnosis = parseInvestigationOutput(result.stdout);
    return JSON.stringify(diagnosis);
  }

  /**
   * Run /canary via gt sling --agent for post-deploy verification.
   * Returns JSON with { passed: boolean, errors?: string[], summary: string }.
   */
  private async runCanary(args?: Record<string, unknown>): Promise<string> {
    const url = args?.url ? ` ${String(args.url)}` : '';
    const duration = args?.duration ? ` --duration ${String(args.duration)}` : '';
    const prompt = `/canary${url}${duration}`;

    const agent = args?.agent ? String(args.agent) : this.agent;
    const result = await this.slingExec(prompt, agent);

    return result.stdout;
  }

  /** Run an arbitrary prompt via claude -p. Returns raw stdout. */
  private async runRaw(args?: Record<string, unknown>): Promise<string> {
    const prompt = String(args?.prompt ?? '');
    if (!prompt) {
      throw new Error('gstack raw command requires args.prompt');
    }

    const result = await claudeExec(prompt, {
      cwd: this.cwd,
      timeout: this.timeout,
      model: args?.model ? String(args.model) : undefined,
      maxTurns: args?.maxTurns ? Number(args.maxTurns) : this.maxTurns,
      dangerouslySkipPermissions: Boolean(args?.dangerouslySkipPermissions ?? true),
    });

    if (result.exitCode !== 0) {
      throw new ClaudeError(
        `claude -p failed (exit ${result.exitCode})`,
        prompt,
        result,
      );
    }

    return result.stdout;
  }

  /**
   * Execute a skill prompt via gt sling --agent for proper lifecycle management.
   * Uses gt sling --review-only --agent <agent> --args <prompt>.
   */
  private async slingExec(
    prompt: string,
    agent: string,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const slingArgs = [
      'sling', '--review-only',
      '--agent', agent,
      '--args', prompt,
    ];

    const result = await gtExec(slingArgs, {
      cwd: this.cwd,
      timeout: this.timeout,
    });

    if (result.exitCode !== 0) {
      throw new ClaudeError(
        `gt sling --agent ${agent} failed (exit ${result.exitCode})`,
        prompt,
        { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode },
      );
    }

    return result;
  }
}
