/**
 * Bridge configuration — multi-model dispatch settings.
 *
 * Encodes gstack's "20th dentist" philosophy: two models disagreeing is signal,
 * not noise. Primary work uses one model (claude), independent review uses
 * another (codex with GPT 5.4 + xhigh reasoning).
 *
 * Configuration is loaded from bridge.json if present, otherwise uses defaults.
 * All settings are overridable per-session.
 */

import * as fs from 'fs';
import * as path from 'path';

// --- Multi-model dispatch ---

/**
 * Multi-model review configuration.
 *
 * When enabled, the bridge dispatches review to a DIFFERENT model family
 * than the one that authored the code. This produces a genuinely independent
 * second opinion — not the same model grading its own work.
 */
export interface MultiModelConfig {
  /** Whether multi-model review is enabled. Default: true. */
  enabled: boolean;
  /** Agent for primary authoring work. Default: 'claude'. */
  primary: string;
  /** Agent for independent review. Default: 'codex'. */
  review: string;
  /**
   * Maximum iterations for the review-fix-rereview loop.
   * After this many rounds, unresolved findings escalate to human.
   * Default: 3.
   */
  maxReviewIterations: number;
  /**
   * Review dispatch mode: 'quick' or 'deep'.
   *
   * - quick: Run review skills via gt sling --review-only --agent (headless,
   *   fast, no workspace context). This is the existing behavior.
   * - deep: Sling review-only beads to polecats that run full /review and /cso
   *   skills in a workspace context with git diff and file reads. Higher quality
   *   but adds polecat spawn latency.
   *
   * Default: 'quick'. See GASTOWN-BRIDGE-REVIEW.md #3.
   */
  reviewMode: 'quick' | 'deep';
}

export const DEFAULT_MULTI_MODEL: MultiModelConfig = {
  enabled: true,
  primary: 'claude',
  review: 'codex',
  maxReviewIterations: 3,
  reviewMode: 'quick',
};

// --- Gas Town integration config ---

/**
 * Gas Town adapter configuration.
 *
 * Controls how the bridge interacts with gastown's dispatch, patrol,
 * merge, and identity systems.
 */
export interface GasTownConfig {
  /** Effort level for idle patrol cycles. 'abbreviated' saves ~90% token cost. Default: 'abbreviated'. */
  effortIdle: 'full' | 'abbreviated';
  /** Prefer convoy.watch (push) over tail.poll (pull) for completion detection. Default: true. */
  useConvoyWatch: boolean;
  /** Per-rig review gates. When false for a rig, skip REVIEW stage for that rig's work. Default: {}. */
  requireReview: Record<string, boolean>;
  /** Whether to intercept polecat scope expansion requests as approval gates. Default: true. */
  scopeExpansionApproval: boolean;
  /** Use gt done --pre-verified when all quality gates pass (5s merge vs minutes). Default: true. */
  preVerifiedMerge: boolean;
}

export const DEFAULT_GASTOWN: GasTownConfig = {
  effortIdle: 'abbreviated',
  useConvoyWatch: true,
  requireReview: {},
  scopeExpansionApproval: true,
  preVerifiedMerge: true,
};

// --- Bridge config ---

/**
 * Top-level bridge configuration.
 * Loaded from bridge.json in the project root, or constructed programmatically.
 */
export interface BridgeConfig {
  multiModel: MultiModelConfig;
  gastown: GasTownConfig;
}

export const DEFAULT_BRIDGE_CONFIG: BridgeConfig = {
  multiModel: { ...DEFAULT_MULTI_MODEL },
  gastown: { ...DEFAULT_GASTOWN },
};

// --- Config loading ---

/**
 * Load bridge config from a bridge.json file.
 * Returns defaults for any missing fields. Returns full defaults if file not found.
 */
export function loadBridgeConfig(projectDir: string): BridgeConfig {
  const configPath = path.join(projectDir, 'bridge.json');

  if (!fs.existsSync(configPath)) {
    return { ...DEFAULT_BRIDGE_CONFIG };
  }

  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<BridgeConfig>;
    return mergeBridgeConfig(parsed);
  } catch {
    // Malformed config → use defaults (fail open for config, fail closed for gates)
    return { ...DEFAULT_BRIDGE_CONFIG };
  }
}

/** Merge partial config with defaults. */
export function mergeBridgeConfig(partial: Partial<BridgeConfig>): BridgeConfig {
  return {
    multiModel: {
      ...DEFAULT_MULTI_MODEL,
      ...(partial.multiModel ?? {}),
    },
    gastown: {
      ...DEFAULT_GASTOWN,
      ...(partial.gastown ?? {}),
    },
  };
}
