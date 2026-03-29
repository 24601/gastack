/**
 * Bridge output adapter — adaptive output calibration.
 *
 * Reads user signals (run count, memory, sessions, feedback) and selects
 * an output profile from a 3×3 grid of detail × style variants.
 *
 * CLI flags --verbose/--quiet override calibration. The adapter integrates
 * with the bridge orchestrator via the standard Adapter interface.
 */

import type { Adapter } from './orchestrate.js';

// --- Detail × Style grid (3×3 = 9 variants) ---

export type DetailLevel = 'minimal' | 'standard' | 'detailed';
export type StyleLevel = 'terse' | 'balanced' | 'expressive';

export interface OutputProfile {
  detail: DetailLevel;
  style: StyleLevel;
}

/** All 9 valid output profiles. */
export const PROFILES: readonly OutputProfile[] = [
  { detail: 'minimal', style: 'terse' },
  { detail: 'minimal', style: 'balanced' },
  { detail: 'minimal', style: 'expressive' },
  { detail: 'standard', style: 'terse' },
  { detail: 'standard', style: 'balanced' },
  { detail: 'standard', style: 'expressive' },
  { detail: 'detailed', style: 'terse' },
  { detail: 'detailed', style: 'balanced' },
  { detail: 'detailed', style: 'expressive' },
] as const;

// --- User signals ---

export interface UserSignals {
  /** Number of times the user has run this tool. 0 = first run. */
  runCount: number;
  /** Whether the user has stored memory/preferences. */
  hasMemory: boolean;
  /** Number of prior conversation sessions. */
  sessionCount: number;
  /** Number of feedback entries (corrections + confirmations). */
  feedbackCount: number;
  /** Explicit preference from feedback history, if any. */
  preferredDetail?: DetailLevel;
  preferredStyle?: StyleLevel;
}

/** CLI override flags. */
export interface OutputFlags {
  verbose?: boolean;
  quiet?: boolean;
}

// --- Calibration logic ---

/**
 * Calibrate output profile from user signals.
 *
 * Progression heuristic:
 *   - New users (runCount < 3): detailed + expressive (onboarding)
 *   - Early users (runCount < 10): standard + balanced (settling in)
 *   - Experienced users (runCount >= 10): minimal + terse (efficiency)
 *
 * Adjustments:
 *   - Users with feedback history get detail bumped up one level
 *     (they've invested in the tool, they want substance)
 *   - Users with memory get style shifted toward balanced
 *     (they've set preferences, respect the middle ground)
 *   - Explicit preferences from feedback override heuristics
 *
 * CLI flags override everything:
 *   --verbose → detailed + expressive
 *   --quiet   → minimal + terse
 */
export function calibrate(
  signals: UserSignals,
  flags?: OutputFlags,
): OutputProfile {
  // CLI flags are absolute overrides
  if (flags?.verbose) {
    return { detail: 'detailed', style: 'expressive' };
  }
  if (flags?.quiet) {
    return { detail: 'minimal', style: 'terse' };
  }

  // Start with heuristic baseline from run count
  let detail: DetailLevel;
  let style: StyleLevel;

  if (signals.runCount < 3) {
    detail = 'detailed';
    style = 'expressive';
  } else if (signals.runCount < 10) {
    detail = 'standard';
    style = 'balanced';
  } else {
    detail = 'minimal';
    style = 'terse';
  }

  // Feedback investment: bump detail up one level
  if (signals.feedbackCount >= 3) {
    detail = bumpDetail(detail);
  }

  // Memory presence: pull style toward balanced
  if (signals.hasMemory && style !== 'balanced') {
    style = 'balanced';
  }

  // Explicit preferences from feedback history override heuristics
  if (signals.preferredDetail) {
    detail = signals.preferredDetail;
  }
  if (signals.preferredStyle) {
    style = signals.preferredStyle;
  }

  return { detail, style };
}

/** Bump detail up one level (minimal → standard → detailed). */
function bumpDetail(level: DetailLevel): DetailLevel {
  switch (level) {
    case 'minimal': return 'standard';
    case 'standard': return 'detailed';
    case 'detailed': return 'detailed';
  }
}

// --- Signal readers ---

/**
 * Read user signals from filesystem paths.
 *
 * This is the IO boundary — reads run count, memory, sessions, feedback
 * from well-known locations. Pure logic is in calibrate().
 */
export async function readSignals(opts: {
  /** Project directory (for .bridge/state). */
  projectDir: string;
  /** Path to user memory directory (~/.claude/memory/). */
  memoryDir?: string;
  /** Path to session history directory. */
  sessionDir?: string;
  /** Path to feedback history directory. */
  feedbackDir?: string;
}): Promise<UserSignals> {
  const { readdir, readFile, mkdir } = await import('fs/promises');
  const { join } = await import('path');

  const stateDir = join(opts.projectDir, '.bridge', 'state');
  await mkdir(stateDir, { recursive: true });

  // Run count: stored as a simple counter file
  const runCountPath = join(stateDir, 'run-count');
  let runCount = 0;
  try {
    const content = await readFile(runCountPath, 'utf-8');
    runCount = parseInt(content.trim(), 10) || 0;
  } catch {
    // File doesn't exist yet — first run
  }

  // Memory: check if directory exists and has files
  let hasMemory = false;
  if (opts.memoryDir) {
    try {
      const entries = await readdir(opts.memoryDir);
      hasMemory = entries.some((e) => e.endsWith('.md') && e !== 'MEMORY.md');
    } catch {
      // Directory doesn't exist
    }
  }

  // Sessions: count log files in session directory
  let sessionCount = 0;
  if (opts.sessionDir) {
    try {
      const entries = await readdir(opts.sessionDir);
      sessionCount = entries.filter((e) => e.endsWith('.jsonl')).length;
    } catch {
      // Directory doesn't exist
    }
  }

  // Feedback: count feedback entries and look for explicit preferences
  let feedbackCount = 0;
  let preferredDetail: DetailLevel | undefined;
  let preferredStyle: StyleLevel | undefined;

  if (opts.feedbackDir) {
    try {
      const entries = await readdir(opts.feedbackDir);
      const feedbackFiles = entries.filter((e) => e.endsWith('.md'));
      feedbackCount = feedbackFiles.length;

      // Scan for explicit output preferences in feedback files
      for (const file of feedbackFiles) {
        try {
          const content = await readFile(join(opts.feedbackDir, file), 'utf-8');
          const detailMatch = content.match(/preferred[_-]?detail:\s*(minimal|standard|detailed)/i);
          const styleMatch = content.match(/preferred[_-]?style:\s*(terse|balanced|expressive)/i);
          if (detailMatch) preferredDetail = detailMatch[1].toLowerCase() as DetailLevel;
          if (styleMatch) preferredStyle = styleMatch[1].toLowerCase() as StyleLevel;
        } catch {
          // Skip unreadable files
        }
      }
    } catch {
      // Directory doesn't exist
    }
  }

  return {
    runCount,
    hasMemory,
    sessionCount,
    feedbackCount,
    preferredDetail,
    preferredStyle,
  };
}

/**
 * Increment the run counter. Called after each successful calibration.
 */
export async function incrementRunCount(projectDir: string): Promise<number> {
  const { readFile, writeFile, mkdir } = await import('fs/promises');
  const { join } = await import('path');

  const stateDir = join(projectDir, '.bridge', 'state');
  await mkdir(stateDir, { recursive: true });

  const runCountPath = join(stateDir, 'run-count');
  let count = 0;
  try {
    const content = await readFile(runCountPath, 'utf-8');
    count = parseInt(content.trim(), 10) || 0;
  } catch {
    // First run
  }

  count++;
  await writeFile(runCountPath, String(count), 'utf-8');
  return count;
}

// --- Adapter implementation ---

/**
 * Bridge adapter for output calibration.
 *
 * Commands routed through execute():
 *   - calibrate    → Read signals, return calibrated profile
 *   - profile      → Return current profile without re-reading signals
 *   - override     → Apply CLI flag override (verbose/quiet)
 *   - increment    → Bump run counter
 */
export class OutputAdapter implements Adapter {
  readonly name = 'output';
  private projectDir: string;
  private memoryDir: string | undefined;
  private sessionDir: string | undefined;
  private feedbackDir: string | undefined;
  private flags: OutputFlags;
  /** Last calibrated profile (cached for profile command). */
  private lastProfile: OutputProfile | null = null;

  constructor(opts: {
    projectDir: string;
    memoryDir?: string;
    sessionDir?: string;
    feedbackDir?: string;
    flags?: OutputFlags;
  }) {
    this.projectDir = opts.projectDir;
    this.memoryDir = opts.memoryDir;
    this.sessionDir = opts.sessionDir;
    this.feedbackDir = opts.feedbackDir;
    this.flags = opts.flags ?? {};
  }

  async execute(
    command: string,
    args?: Record<string, unknown>,
  ): Promise<string> {
    switch (command) {
      case 'calibrate':
        return this.calibrateCmd(args);
      case 'profile':
        return this.profileCmd();
      case 'override':
        return this.overrideCmd(args);
      case 'increment':
        return this.incrementCmd();
      default:
        throw new Error(`Unknown output command: ${command}`);
    }
  }

  /** Read signals and calibrate output profile. */
  private async calibrateCmd(args?: Record<string, unknown>): Promise<string> {
    // Allow per-call flag overrides
    const flags: OutputFlags = {
      verbose: Boolean(args?.verbose) || this.flags.verbose,
      quiet: Boolean(args?.quiet) || this.flags.quiet,
    };

    const signals = await readSignals({
      projectDir: this.projectDir,
      memoryDir: this.memoryDir,
      sessionDir: this.sessionDir,
      feedbackDir: this.feedbackDir,
    });

    const profile = calibrate(signals, flags);
    this.lastProfile = profile;

    return JSON.stringify({ profile, signals });
  }

  /** Return last calibrated profile (or default if none). */
  private profileCmd(): string {
    const profile = this.lastProfile ?? { detail: 'standard', style: 'balanced' };
    return JSON.stringify({ profile });
  }

  /** Apply CLI flag override and re-calibrate. */
  private overrideCmd(args?: Record<string, unknown>): string {
    if (args?.verbose !== undefined) {
      this.flags.verbose = Boolean(args.verbose);
    }
    if (args?.quiet !== undefined) {
      this.flags.quiet = Boolean(args.quiet);
    }

    // If we have a cached profile, re-calibrate with new flags
    // (use minimal signals since flags override everything)
    if (this.flags.verbose || this.flags.quiet) {
      this.lastProfile = calibrate(
        { runCount: 0, hasMemory: false, sessionCount: 0, feedbackCount: 0 },
        this.flags,
      );
    }

    return JSON.stringify({ flags: this.flags, profile: this.lastProfile });
  }

  /** Increment run counter. */
  private async incrementCmd(): Promise<string> {
    const count = await incrementRunCount(this.projectDir);
    return JSON.stringify({ runCount: count });
  }
}
