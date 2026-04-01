/**
 * extract.ts — Task extraction from design documents.
 *
 * Two extraction methods:
 *   1. Regex fast-path (deterministic, free) — parses `### N. Title` headings
 *   2. LLM extraction (Haiku, ~$0.001/call) — sends doc to Haiku for structured extraction
 *
 * Reconciliation compares both results and flags discrepancies:
 *   - Tasks found by regex but missed by LLM (or vice versa)
 *   - Title mismatches between matched tasks
 *   - Body/criteria differences
 *
 * Usage:
 *   - CI/gate tier: use extractTasks() (regex only, deterministic)
 *   - Periodic evals: use extractWithLLM() or extractAndReconcile() (both methods + comparison)
 *   - Bridge orchestrator PLAN stage: use extractAndReconcile() for maximum confidence
 */

import { claudeExec, type ClaudeResult } from './adapters/gstack.js';
import {
  extractTasks,
  containsShellMetacharacters,
  detectTargetBranch,
  type ExtractedTask,
  type ExtractionResult,
} from './task-extract.js';

// Re-export regex types and functions for convenience
export {
  extractTasks,
  containsShellMetacharacters,
  detectTargetBranch,
  type ExtractedTask,
  type ExtractionResult,
} from './task-extract.js';

// --- LLM extraction types ---

/** Task extracted by the LLM. */
export interface LLMExtractedTask {
  /** Task number (1-based, from LLM's interpretation). */
  number: number;
  /** Task title as interpreted by the LLM. */
  title: string;
  /** Task description/summary from the LLM. */
  description: string;
  /** Acceptance criteria extracted by the LLM. */
  acceptanceCriteria: string[];
}

/** Result from LLM extraction. */
export interface LLMExtractionResult {
  /** Extracted tasks. */
  tasks: LLMExtractedTask[];
  /** Whether the LLM detected a structured Tasks section. */
  hasTasksSection: boolean;
  /** Whether the LLM detected a Next Steps section. */
  hasNextSteps: boolean;
  /** Raw LLM output (JSON string). */
  raw: string;
  /** Extraction method. */
  method: 'llm';
  /** Model used. */
  model: string;
}

// --- Reconciliation types ---

export type MatchStatus =
  | 'matched'          // Found in both regex and LLM with matching titles
  | 'title-mismatch'   // Found in both by number but titles differ
  | 'regex-only'       // Found by regex but not by LLM
  | 'llm-only';        // Found by LLM but not by regex

export interface ReconciledTask {
  /** Task number. */
  number: number;
  /** Match status between regex and LLM extraction. */
  status: MatchStatus;
  /** Task from regex extraction (null if llm-only). */
  regex: ExtractedTask | null;
  /** Task from LLM extraction (null if regex-only). */
  llm: LLMExtractedTask | null;
  /** Canonical title — prefer regex (deterministic) when matched. */
  title: string;
  /** Title similarity score (0-1) when both present. */
  titleSimilarity: number | null;
}

export interface ReconciliationResult {
  /** Reconciled tasks (ordered by number). */
  tasks: ReconciledTask[];
  /** Regex extraction result. */
  regexResult: ExtractionResult;
  /** LLM extraction result. */
  llmResult: LLMExtractionResult;
  /** Summary statistics. */
  stats: {
    total: number;
    matched: number;
    titleMismatches: number;
    regexOnly: number;
    llmOnly: number;
  };
}

// --- LLM extraction ---

const EXTRACTION_PROMPT = `You are a task extraction system. Given a design document in Markdown, extract all tasks.

Output ONLY valid JSON (no markdown fences, no explanation) with this exact schema:
{
  "tasks": [
    {
      "number": 1,
      "title": "Task title",
      "description": "Brief description of what the task involves",
      "acceptanceCriteria": ["Criterion 1", "Criterion 2"]
    }
  ],
  "hasTasksSection": true,
  "hasNextSteps": false
}

Rules:
- Extract tasks from ## Tasks sections (### N. Title format) if present
- If no structured Tasks section exists, infer tasks from the document content
- Preserve task titles EXACTLY as written (including special characters)
- Extract acceptance criteria as an array of strings
- Set hasTasksSection to true if a ## Tasks heading exists
- Set hasNextSteps to true if a ## Next Steps heading exists
- If the document has no tasks at all, return {"tasks": [], "hasTasksSection": false, "hasNextSteps": false}

Design document:
`;

/**
 * Extract tasks from a design document using Haiku LLM.
 *
 * Sends the document to claude -p with Haiku for structured extraction.
 * Falls back gracefully on LLM errors (returns empty result with error info).
 */
export async function extractWithLLM(
  markdown: string,
  opts?: {
    model?: string;
    timeout?: number;
    cwd?: string;
  },
): Promise<LLMExtractionResult> {
  const model = opts?.model ?? 'claude-haiku-4-5-20251001';
  const prompt = EXTRACTION_PROMPT + markdown;

  let result: ClaudeResult;
  try {
    result = await claudeExec(prompt, {
      model,
      timeout: opts?.timeout ?? 30_000,
      cwd: opts?.cwd,
      maxTurns: 1,
      dangerouslySkipPermissions: true,
    });
  } catch (err) {
    // LLM call failed — return empty result
    return {
      tasks: [],
      hasTasksSection: false,
      hasNextSteps: false,
      raw: String(err),
      method: 'llm',
      model,
    };
  }

  if (result.exitCode !== 0) {
    return {
      tasks: [],
      hasTasksSection: false,
      hasNextSteps: false,
      raw: result.stderr || result.stdout,
      method: 'llm',
      model,
    };
  }

  // Parse LLM JSON output
  const raw = result.stdout.trim();
  try {
    const parsed = JSON.parse(raw) as {
      tasks: LLMExtractedTask[];
      hasTasksSection: boolean;
      hasNextSteps: boolean;
    };

    return {
      tasks: parsed.tasks ?? [],
      hasTasksSection: parsed.hasTasksSection ?? false,
      hasNextSteps: parsed.hasNextSteps ?? false,
      raw,
      method: 'llm',
      model,
    };
  } catch {
    // JSON parse failed — try to extract JSON from markdown fences
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenced) {
      try {
        const parsed = JSON.parse(fenced[1].trim());
        return {
          tasks: parsed.tasks ?? [],
          hasTasksSection: parsed.hasTasksSection ?? false,
          hasNextSteps: parsed.hasNextSteps ?? false,
          raw,
          method: 'llm',
          model,
        };
      } catch {
        // Fall through to empty result
      }
    }

    return {
      tasks: [],
      hasTasksSection: false,
      hasNextSteps: false,
      raw,
      method: 'llm',
      model,
    };
  }
}

// --- Title similarity ---

/**
 * Compute normalized Jaccard similarity between two titles.
 * Splits on whitespace and punctuation, lowercases, compares word sets.
 */
export function titleSimilarity(a: string, b: string): number {
  const tokenize = (s: string) =>
    new Set(s.toLowerCase().replace(/[^\w\s]/g, ' ').split(/\s+/).filter(Boolean));

  const setA = tokenize(a);
  const setB = tokenize(b);

  if (setA.size === 0 && setB.size === 0) return 1;
  if (setA.size === 0 || setB.size === 0) return 0;

  let intersection = 0;
  for (const word of setA) {
    if (setB.has(word)) intersection++;
  }

  const union = new Set([...setA, ...setB]).size;
  return intersection / union;
}

// --- Reconciliation ---

/** Threshold above which titles are considered a match. */
const TITLE_MATCH_THRESHOLD = 0.6;

/**
 * Reconcile regex and LLM extraction results.
 *
 * Matching strategy:
 *   1. Match by task number first
 *   2. For same-numbered tasks, check title similarity
 *   3. Tasks with no number match are regex-only or llm-only
 */
export function reconcile(
  regexResult: ExtractionResult,
  llmResult: LLMExtractionResult,
): ReconciliationResult {
  const regexByNumber = new Map(regexResult.tasks.map((t) => [t.number, t]));
  const llmByNumber = new Map(llmResult.tasks.map((t) => [t.number, t]));

  // All task numbers from both sources
  const allNumbers = new Set([
    ...regexResult.tasks.map((t) => t.number),
    ...llmResult.tasks.map((t) => t.number),
  ]);

  const tasks: ReconciledTask[] = [];

  for (const num of [...allNumbers].sort((a, b) => a - b)) {
    const regex = regexByNumber.get(num) ?? null;
    const llm = llmByNumber.get(num) ?? null;

    if (regex && llm) {
      const sim = titleSimilarity(regex.title, llm.title);
      const status: MatchStatus = sim >= TITLE_MATCH_THRESHOLD ? 'matched' : 'title-mismatch';
      tasks.push({
        number: num,
        status,
        regex,
        llm,
        title: regex.title, // Prefer regex (deterministic)
        titleSimilarity: sim,
      });
    } else if (regex) {
      tasks.push({
        number: num,
        status: 'regex-only',
        regex,
        llm: null,
        title: regex.title,
        titleSimilarity: null,
      });
    } else if (llm) {
      tasks.push({
        number: num,
        status: 'llm-only',
        regex: null,
        llm,
        title: llm.title,
        titleSimilarity: null,
      });
    }
  }

  const stats = {
    total: tasks.length,
    matched: tasks.filter((t) => t.status === 'matched').length,
    titleMismatches: tasks.filter((t) => t.status === 'title-mismatch').length,
    regexOnly: tasks.filter((t) => t.status === 'regex-only').length,
    llmOnly: tasks.filter((t) => t.status === 'llm-only').length,
  };

  return { tasks, regexResult, llmResult, stats };
}

/**
 * Full extraction pipeline: regex + LLM + reconciliation.
 *
 * Runs regex extraction (deterministic, instant) then LLM extraction
 * (Haiku, ~1-2s), and reconciles the results.
 */
export async function extractAndReconcile(
  markdown: string,
  opts?: {
    model?: string;
    timeout?: number;
    cwd?: string;
  },
): Promise<ReconciliationResult> {
  const regexResult = extractTasks(markdown);
  const llmResult = await extractWithLLM(markdown, opts);
  return reconcile(regexResult, llmResult);
}
