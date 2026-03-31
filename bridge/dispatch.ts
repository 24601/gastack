/**
 * dispatch.ts — Priority sorting and batch grouping for task dispatch.
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
 */

import type { ExtractedTask } from './task-extract.js';

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
