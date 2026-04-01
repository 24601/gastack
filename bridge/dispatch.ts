/**
 * dispatch.ts — Priority sorting, batch grouping, and convoy dispatch.
 *
 * Encodes gstack's opinion: not all tasks are equal.
 * Security work never gets starved by feature volume.
 *
 * Priority assignment:
 *   - P0 (security): tasks with security keywords (auth, XSS, injection, etc.)
 *   - P1 (critical fixes): tasks with fix/bug/crash keywords
 *   - P2 (default): all other tasks, ordered by extraction number
 *
 * Batch grouping:
 *   - Tasks sorted by priority, then by extraction number within same priority
 *   - Batches respect --max-concurrent limit
 *   - Each batch contains priority-ordered bead IDs for a single gt sling call
 *
 * Convoy dispatch (default):
 *   - stageAndLaunch() uses gt convoy stage + gt convoy launch
 *   - gastown handles dependency ordering and wave-based dispatch natively
 *   - Falls back to manual sling.batch if stage/launch fails
 *
 * Mountain dispatch (for large task sets, 10+ tasks):
 *   - mountainDispatch() uses gt mountain for enhanced stall detection,
 *     skip-after-N-failures, and Deacon auditing
 *   - Falls back to stageAndLaunch, then sling.batch
 *   - chooseDispatchStrategy() picks mountain vs convoy based on task count
 */

import type { ExtractedTask } from './task-extract.js';
import type { Adapter } from './orchestrate.js';

// --- Priority levels ---

/** Priority level (lower = higher priority). */
export type Priority = 0 | 1 | 2;

/** Security keywords that force P0 priority regardless of task position. */
const SECURITY_KEYWORDS = [
  'security', 'auth', 'xss', 'injection', 'csrf', 'ssrf',
  'vulnerability', 'cve', 'owasp', 'encrypt', 'secret',
  'credential', 'token', 'permission', 'privilege', 'sanitiz',
  'escap', 'cso', 'pentest', 'exploit',
];

/** Fix/bug keywords that get P1 priority. */
const CRITICAL_FIX_KEYWORDS = [
  'fix', 'bug', 'crash', 'broken', 'regression', 'hotfix',
  'incident', 'outage', 'data loss', 'corrupt',
];

// --- Task with priority ---

export interface PrioritizedTask {
  /** Original extracted task. */
  task: ExtractedTask;
  /** Assigned priority (0 = highest). */
  priority: Priority;
  /** Why this priority was assigned. */
  reason: string;
  /** Bead ID if available (set by caller before batching). */
  beadId?: string;
}

// --- Priority assignment ---

/**
 * Assign a priority to an extracted task based on content analysis.
 *
 * Security tasks always get P0 regardless of their position in the doc.
 * Fix/bug tasks get P1. Everything else gets P2.
 */
export function assignPriority(task: ExtractedTask): PrioritizedTask {
  const text = `${task.title} ${task.body}`.toLowerCase();

  // Check security keywords first (P0)
  for (const keyword of SECURITY_KEYWORDS) {
    if (text.includes(keyword)) {
      return {
        task,
        priority: 0,
        reason: `security keyword: ${keyword}`,
      };
    }
  }

  // Check critical fix keywords (P1)
  for (const keyword of CRITICAL_FIX_KEYWORDS) {
    if (text.includes(keyword)) {
      return {
        task,
        priority: 1,
        reason: `critical fix keyword: ${keyword}`,
      };
    }
  }

  // Default (P2)
  return {
    task,
    priority: 2,
    reason: 'default priority',
  };
}

/**
 * Assign priorities to all tasks in a batch.
 * Returns tasks sorted by priority (P0 first), then by extraction number.
 */
export function prioritize(tasks: ExtractedTask[]): PrioritizedTask[] {
  return tasks
    .map(assignPriority)
    .sort((a, b) => {
      // Primary sort: priority (lower = higher priority)
      if (a.priority !== b.priority) return a.priority - b.priority;
      // Secondary sort: extraction order (task number)
      return a.task.number - b.task.number;
    });
}

// --- Batch grouping ---

/**
 * Group prioritized tasks into batches respecting --max-concurrent limit.
 *
 * Each batch is a slice of the priority-sorted task list, sized to
 * maxConcurrent. The first batch always contains the highest-priority
 * tasks (security work first).
 *
 * @param tasks - Priority-sorted tasks (call prioritize() first)
 * @param maxConcurrent - Maximum tasks per batch (default: 4)
 * @returns Array of batches, each containing up to maxConcurrent tasks
 */
export function batchTasks(
  tasks: PrioritizedTask[],
  maxConcurrent: number = 4,
): PrioritizedTask[][] {
  if (tasks.length === 0) return [];
  if (maxConcurrent < 1) maxConcurrent = 1;

  const batches: PrioritizedTask[][] = [];
  for (let i = 0; i < tasks.length; i += maxConcurrent) {
    batches.push(tasks.slice(i, i + maxConcurrent));
  }
  return batches;
}

/**
 * Full dispatch pipeline: prioritize tasks, group into batches.
 *
 * Returns batches ready for gt sling --max-concurrent dispatch.
 * Each batch is priority-ordered (security first, then fixes, then features).
 */
export function planDispatch(
  tasks: ExtractedTask[],
  maxConcurrent: number = 4,
): PrioritizedTask[][] {
  const prioritized = prioritize(tasks);
  return batchTasks(prioritized, maxConcurrent);
}

/**
 * Extract bead IDs from a batch for the gt sling command.
 * Only includes tasks that have beadId set.
 */
export function batchBeadIds(batch: PrioritizedTask[]): string[] {
  return batch
    .filter((t) => t.beadId)
    .map((t) => t.beadId!);
}

// --- Convoy stage + launch dispatch ---

/** Result of a convoy stage + launch dispatch attempt. */
export interface ConvoyDispatchResult {
  /** Whether stage+launch succeeded. */
  ok: boolean;
  /** Convoy ID if staging succeeded. */
  convoyId?: string;
  /** Whether we fell back to manual sling. */
  fellBackToSling: boolean;
  /** Error message if stage or launch failed. */
  error?: string;
}

/**
 * Dispatch tasks via `gt convoy stage` + `gt convoy launch`.
 *
 * Replaces the manual "gt convoy create → gt sling × N" loop.
 * gastown handles dependency ordering and wave-based dispatch natively.
 *
 * Falls back to manual sling.batch if stage or launch fails.
 *
 * @param beadIds - Bead IDs to dispatch (already created via bd create)
 * @param adapter - Gas Town adapter for executing commands
 * @param opts - Optional title, rig, and maxConcurrent for fallback
 */
export async function stageAndLaunch(
  beadIds: string[],
  adapter: Adapter,
  opts?: {
    title?: string;
    rig?: string;
    maxConcurrent?: number;
  },
): Promise<ConvoyDispatchResult> {
  if (beadIds.length === 0) {
    return { ok: true, fellBackToSling: false };
  }

  // Try stage + launch
  try {
    const stageResult = await adapter.execute('convoy.stage', {
      beadIds,
      title: opts?.title,
    });

    // Parse convoy ID from JSON output
    const convoyId = parseConvoyId(stageResult);
    if (!convoyId) {
      throw new Error(`convoy.stage returned no convoy ID: ${stageResult}`);
    }

    await adapter.execute('convoy.launch', { convoyId });

    return { ok: true, convoyId, fellBackToSling: false };
  } catch (stageErr) {
    // Stage or launch failed — fall back to manual sling.batch
    try {
      await adapter.execute('sling.batch', {
        beadIds,
        rig: opts?.rig ?? '',
        maxConcurrent: opts?.maxConcurrent ?? 4,
      });

      return {
        ok: true,
        fellBackToSling: true,
        error: `stage/launch failed, used sling fallback: ${errorMessage(stageErr)}`,
      };
    } catch (slingErr) {
      return {
        ok: false,
        fellBackToSling: true,
        error: `both stage/launch and sling fallback failed: ${errorMessage(stageErr)}; sling: ${errorMessage(slingErr)}`,
      };
    }
  }
}

/** Parse convoy ID from gt convoy stage --json output. */
function parseConvoyId(stageOutput: string): string | undefined {
  try {
    const parsed = JSON.parse(stageOutput);
    // gt convoy stage --json returns { convoy_id: "..." } or { id: "..." }
    return parsed.convoy_id ?? parsed.id ?? undefined;
  } catch {
    // Try line-based fallback: "Convoy hq-xxx staged"
    const match = stageOutput.match(/[Cc]onvoy\s+([\w-]+)/);
    return match?.[1];
  }
}

// --- Mountain dispatch ---

/** Default task count threshold for activating mountain mode. */
export const MOUNTAIN_THRESHOLD = 10;

/** Result of a mountain dispatch attempt. */
export interface MountainDispatchResult {
  /** Whether mountain activation succeeded. */
  ok: boolean;
  /** Mountain/convoy ID if activation succeeded. */
  mountainId?: string;
  /** Whether we fell back to convoy stage+launch. */
  fellBackToConvoy: boolean;
  /** Whether we fell back all the way to manual sling. */
  fellBackToSling: boolean;
  /** Error message if mountain activation failed. */
  error?: string;
}

/**
 * Dispatch tasks via `gt mountain` for large task sets.
 *
 * Mountains are convoys with enhanced stall detection, skip-after-N-failures,
 * and active progress monitoring via the Deacon. Use this instead of
 * stageAndLaunch when task count exceeds the mountain threshold.
 *
 * Fallback chain: mountain → stageAndLaunch (convoy) → sling.batch
 *
 * @param epicId - Epic/parent bead ID that owns the tasks
 * @param beadIds - Bead IDs to dispatch (already created via bd create)
 * @param adapter - Gas Town adapter for executing commands
 * @param opts - Optional force flag, rig, and maxConcurrent for fallback
 */
export async function mountainDispatch(
  epicId: string,
  beadIds: string[],
  adapter: Adapter,
  opts?: {
    force?: boolean;
    title?: string;
    rig?: string;
    maxConcurrent?: number;
  },
): Promise<MountainDispatchResult> {
  if (beadIds.length === 0) {
    return { ok: true, fellBackToConvoy: false, fellBackToSling: false };
  }

  // Try mountain activation
  try {
    const result = await adapter.execute('mountain', {
      epicId,
      force: opts?.force,
    });

    // Parse mountain/convoy ID from JSON output
    const mountainId = parseMountainId(result);
    if (!mountainId) {
      throw new Error(`mountain returned no ID: ${result}`);
    }

    return { ok: true, mountainId, fellBackToConvoy: false, fellBackToSling: false };
  } catch (mountainErr) {
    // Mountain failed — fall back to convoy stage+launch
    const convoyResult = await stageAndLaunch(beadIds, adapter, {
      title: opts?.title,
      rig: opts?.rig,
      maxConcurrent: opts?.maxConcurrent,
    });

    return {
      ok: convoyResult.ok,
      mountainId: convoyResult.convoyId,
      fellBackToConvoy: !convoyResult.fellBackToSling,
      fellBackToSling: convoyResult.fellBackToSling,
      error: `mountain failed, fell back to convoy: ${errorMessage(mountainErr)}${convoyResult.error ? `; ${convoyResult.error}` : ''}`,
    };
  }
}

/**
 * Choose the right dispatch strategy based on task count.
 *
 * When taskCount >= MOUNTAIN_THRESHOLD, returns 'mountain'.
 * Otherwise returns 'convoy' (stageAndLaunch).
 */
export function chooseDispatchStrategy(
  taskCount: number,
  threshold: number = MOUNTAIN_THRESHOLD,
): 'mountain' | 'convoy' {
  return taskCount >= threshold ? 'mountain' : 'convoy';
}

/** Parse mountain/convoy ID from gt mountain --json output. */
function parseMountainId(output: string): string | undefined {
  try {
    const parsed = JSON.parse(output);
    return parsed.mountain_id ?? parsed.convoy_id ?? parsed.id ?? undefined;
  } catch {
    // Try line-based fallback: "Mountain hq-xxx activated"
    const match = output.match(/[Mm]ountain\s+([\w-]+)/);
    return match?.[1];
  }
}

/** Extract error message from unknown error type. */
function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
