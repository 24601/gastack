/**
 * gstack adapter — claude -p review execution.
 *
 * Runs /review and /cso skills via `claude -p` in parallel (Promise.all).
 * Parses review output for structured grades and findings.
 *
 * All claude CLI calls use Bun.spawn with array args (no shell interpolation).
 * Output is streamed via --output-format stream-json for real-time parsing.
 */

import type { Adapter } from '../orchestrate.js';

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
 *   - review       → Run /review via claude -p, parse grade + findings
 *   - cso          → Run /cso via claude -p, parse grade + findings
 *   - review-suite → Run /review + /cso in parallel (Promise.all)
 *   - canary       → Run /canary via claude -p for post-deploy verification
 *   - raw          → Run arbitrary prompt via claude -p
 */
export class GstackAdapter implements Adapter {
  readonly name = 'gstack';
  private cwd: string;
  private timeout: number;
  private model: string | undefined;
  private maxTurns: number;

  constructor(opts: {
    cwd: string;
    timeout?: number;
    model?: string;
    maxTurns?: number;
  }) {
    this.cwd = opts.cwd;
    this.timeout = opts.timeout ?? 300_000;
    this.model = opts.model;
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

      case 'canary':
        return this.runCanary(args);

      case 'raw':
        return this.runRaw(args);

      default:
        throw new Error(`Unknown gstack command: ${command}`);
    }
  }

  /**
   * Run a skill (e.g., /review, /cso) via claude -p.
   * Returns parsed JSON with grade, findings, and raw output.
   */
  private async runSkill(
    skill: string,
    args?: Record<string, unknown>,
  ): Promise<string> {
    const branch = args?.branch ? ` --branch ${String(args.branch)}` : '';
    const prompt = `${skill}${branch}`;

    const result = await claudeExec(prompt, {
      cwd: this.cwd,
      timeout: this.timeout,
      model: this.model,
      maxTurns: this.maxTurns,
      dangerouslySkipPermissions: true,
    });

    if (result.exitCode !== 0) {
      throw new ClaudeError(
        `claude -p failed running ${skill} (exit ${result.exitCode})`,
        prompt,
        result,
      );
    }

    const parsed = parseReviewOutput(result.stdout);
    return JSON.stringify(parsed);
  }

  /**
   * Run /review and /cso in parallel via Promise.all.
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
   * Run /canary via claude -p for post-deploy verification.
   * Returns JSON with { passed: boolean, errors?: string[], summary: string }.
   */
  private async runCanary(args?: Record<string, unknown>): Promise<string> {
    const url = args?.url ? ` ${String(args.url)}` : '';
    const duration = args?.duration ? ` --duration ${String(args.duration)}` : '';
    const prompt = `/canary${url}${duration}`;

    const result = await claudeExec(prompt, {
      cwd: this.cwd,
      timeout: this.timeout,
      model: this.model,
      maxTurns: this.maxTurns,
      dangerouslySkipPermissions: true,
    });

    if (result.exitCode !== 0) {
      throw new ClaudeError(
        `claude -p failed running /canary (exit ${result.exitCode})`,
        prompt,
        result,
      );
    }

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
      model: args?.model ? String(args.model) : this.model,
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
}
