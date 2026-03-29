/**
 * Bridge stage machine — orchestrates PLAN→EXECUTE→REVIEW→REFINE→DEPLOY→DONE.
 *
 * State is derived entirely from the event log. No mutable state fields.
 * On crash/restart, replay the log to reconstruct exactly where we left off.
 *
 * The orchestrator manages stage transitions, task tracking, and external
 * call idempotency. Adapters (gstack, gastown) plug in via the Adapter
 * interface to execute stage-specific work.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import {
  type BridgeEvent,
  type Stage,
  type EventEnvelope,
  type ExternalCallCompleted,
  STAGES,
  EventLog,
  idempotencyKey,
} from './events.js';

// --- Adapter interface ---

/** Adapters execute work for a specific stage. Plugged in at construction. */
export interface Adapter {
  name: string;
  /** Execute a command. Returns result string on success, throws on failure. */
  execute(command: string, args?: Record<string, unknown>): Promise<string>;
}

// --- Task state (derived from events) ---

export type TaskStatus = 'queued' | 'running' | 'completed' | 'failed';

export interface TaskState {
  taskId: string;
  description: string;
  stage: Stage;
  status: TaskStatus;
  result?: string;
  error?: string;
  retryable: boolean;
  metadata?: Record<string, unknown>;
}

// --- Orchestrator options ---

export interface OrchestratorOptions {
  /** Directory for event log storage. */
  logDir: string;
  /** Project directory being orchestrated. */
  projectDir: string;
  /** Registered adapters by name. */
  adapters?: Record<string, Adapter>;
  /** Optional session config stored in SESSION_CREATED event. */
  config?: Record<string, unknown>;
}

// --- Orchestrator ---

export class Orchestrator {
  private log: EventLog;
  private sessionId: string;
  private adapters: Record<string, Adapter>;
  private projectDir: string;

  private constructor(
    log: EventLog,
    sessionId: string,
    projectDir: string,
    adapters: Record<string, Adapter>,
  ) {
    this.log = log;
    this.sessionId = sessionId;
    this.projectDir = projectDir;
    this.adapters = adapters;
  }

  /** Start a new orchestration session. */
  static create(opts: OrchestratorOptions): Orchestrator {
    const sessionId = crypto.randomUUID();
    const log = new EventLog(opts.logDir, sessionId);

    log.append({
      type: 'SESSION_CREATED',
      sessionId,
      projectDir: opts.projectDir,
      config: opts.config ?? {},
    });

    return new Orchestrator(
      log,
      sessionId,
      opts.projectDir,
      opts.adapters ?? {},
    );
  }

  /** Resume from an existing event log (crash recovery). */
  static resume(logPath: string, adapters?: Record<string, Adapter>): Orchestrator {
    const log = EventLog.replay(logPath);
    const created = log.latest('SESSION_CREATED');
    if (!created) {
      throw new Error(`Cannot resume: no SESSION_CREATED event in ${logPath}`);
    }

    const orch = new Orchestrator(
      log,
      created.sessionId,
      created.projectDir,
      adapters ?? {},
    );

    const currentStage = orch.currentStage();
    log.append({
      type: 'SESSION_RESUMED',
      sessionId: created.sessionId,
      replayedEvents: log.length - 1, // minus the RESUMED event itself
      resumedAtStage: currentStage ?? 'PLAN',
    });

    return orch;
  }

  // --- State derivation (all from event log) ---

  /** Derive the current stage from the event log. */
  currentStage(): Stage | null {
    if (this.log.latest('SESSION_COMPLETED')) return null;

    const entered = this.log.ofType('STAGE_ENTERED');
    if (entered.length === 0) return null;

    // The most recently entered stage
    const lastEntered = entered[entered.length - 1];

    // Check if it's been completed
    const completions = this.log.ofType('STAGE_COMPLETED');
    // Count completions for this stage that happened after the last entry
    // (simplified: just check if a completion exists for the last entered stage
    // after the last entry event)
    const lastEnteredIdx = this.log.all().findIndex(
      (e) => e.event === this.log.all().filter(
        (env) => env.event.type === 'STAGE_ENTERED' && env.event.stage === lastEntered.stage,
      ).at(-1)?.event,
    );
    const hasCompletionAfter = this.log.all().slice(lastEnteredIdx + 1).some(
      (e) => e.event.type === 'STAGE_COMPLETED' && e.event.stage === lastEntered.stage,
    );

    if (hasCompletionAfter) return null;
    return lastEntered.stage;
  }

  /** The last stage that was completed (used to validate transitions). */
  private lastCompletedStage(): Stage | null {
    const completions = this.log.ofType('STAGE_COMPLETED');
    if (completions.length === 0) return null;
    return completions[completions.length - 1].stage;
  }

  /** Derive task states from the event log. */
  tasks(): TaskState[] {
    const taskMap = new Map<string, TaskState>();

    for (const envelope of this.log.all()) {
      const ev = envelope.event;
      switch (ev.type) {
        case 'TASK_QUEUED':
          taskMap.set(ev.taskId, {
            taskId: ev.taskId,
            description: ev.description,
            stage: ev.stage,
            status: 'queued',
            retryable: true,
            metadata: ev.metadata,
          });
          break;
        case 'TASK_STARTED': {
          const t = taskMap.get(ev.taskId);
          if (t) t.status = 'running';
          break;
        }
        case 'TASK_COMPLETED': {
          const t = taskMap.get(ev.taskId);
          if (t) {
            t.status = 'completed';
            t.result = ev.result;
          }
          break;
        }
        case 'TASK_FAILED': {
          const t = taskMap.get(ev.taskId);
          if (t) {
            t.status = 'failed';
            t.error = ev.error;
            t.retryable = ev.retryable;
          }
          break;
        }
      }
    }

    return Array.from(taskMap.values());
  }

  /** Tasks for a specific stage. */
  tasksForStage(stage: Stage): TaskState[] {
    return this.tasks().filter((t) => t.stage === stage);
  }

  /** Check if all tasks in a stage are completed. */
  stageTasksComplete(stage: Stage): boolean {
    const stageTasks = this.tasksForStage(stage);
    if (stageTasks.length === 0) return true; // no tasks = vacuously complete
    return stageTasks.every((t) => t.status === 'completed');
  }

  /** Pending approval (if any). */
  pendingApproval(): { approvalId: string; stage: Stage; description: string } | null {
    const requests = this.log.ofType('APPROVAL_REQUESTED');
    const decisions = new Set(
      this.log.ofType('APPROVAL_DECISION').map((e) => e.approvalId),
    );

    for (let i = requests.length - 1; i >= 0; i--) {
      if (!decisions.has(requests[i].approvalId)) {
        return {
          approvalId: requests[i].approvalId,
          stage: requests[i].stage,
          description: requests[i].description,
        };
      }
    }
    return null;
  }

  /** Whether the session is done (terminal state). */
  isDone(): boolean {
    return this.log.latest('SESSION_COMPLETED') !== undefined;
  }

  // --- Stage transitions ---

  /** Enter a stage. Validates the transition is legal. */
  enterStage(stage: Stage): void {
    if (this.isDone()) {
      throw new Error('Session is already completed');
    }

    const current = this.currentStage();

    // Can't re-enter the current stage
    if (current === stage) {
      throw new Error(`Already in stage ${stage}`);
    }

    // If we're between stages (current is null), check last completed
    const referenceStage = current ?? this.lastCompletedStage();

    // First stage must be PLAN (no prior stage activity)
    if (referenceStage === null && stage !== 'PLAN') {
      throw new Error(`First stage must be PLAN, got ${stage}`);
    }

    // Validate transition from reference stage
    if (referenceStage !== null) {
      const refIdx = STAGES.indexOf(referenceStage);
      const nextIdx = STAGES.indexOf(stage);

      // From an active stage: must go forward by 1 or REFINE→EXECUTE
      // From a completed stage (between stages): next stage in sequence
      const isForward = current !== null
        ? nextIdx === refIdx + 1
        : nextIdx === refIdx + 1;
      const isRefineLoop = referenceStage === 'REFINE' && stage === 'EXECUTE';

      if (!isForward && !isRefineLoop) {
        throw new Error(
          `Invalid transition: ${referenceStage} → ${stage}. ` +
            `Allowed: next stage or REFINE → EXECUTE`,
        );
      }
    }

    this.log.append({ type: 'STAGE_ENTERED', stage });
  }

  /** Complete the current stage. */
  completeStage(summary?: string): void {
    const current = this.currentStage();
    if (!current) {
      throw new Error('No active stage to complete');
    }
    this.log.append({ type: 'STAGE_COMPLETED', stage: current, summary });
  }

  /** Advance to the next stage in sequence. Completes current + enters next. */
  advance(summary?: string): Stage {
    const current = this.currentStage();
    if (!current) {
      // No stage yet — enter PLAN
      this.enterStage('PLAN');
      return 'PLAN';
    }

    const idx = STAGES.indexOf(current);
    if (idx === STAGES.length - 1) {
      throw new Error('Already at final stage (DONE). Call complete() instead.');
    }

    const next = STAGES[idx + 1];
    this.completeStage(summary);
    this.enterStage(next);
    return next;
  }

  // --- Task management ---

  /** Queue a task for the current stage. */
  queueTask(
    description: string,
    metadata?: Record<string, unknown>,
  ): string {
    const stage = this.currentStage();
    if (!stage) throw new Error('No active stage — cannot queue tasks');

    const taskId = crypto.randomUUID().slice(0, 8);
    this.log.append({
      type: 'TASK_QUEUED',
      taskId,
      description,
      stage,
      metadata,
    });
    return taskId;
  }

  /** Mark a task as started. */
  startTask(taskId: string): void {
    this.log.append({ type: 'TASK_STARTED', taskId });
  }

  /** Mark a task as completed. */
  completeTask(taskId: string, result?: string): void {
    this.log.append({ type: 'TASK_COMPLETED', taskId, result });
  }

  /** Mark a task as failed. */
  failTask(taskId: string, error: string, retryable = true): void {
    this.log.append({ type: 'TASK_FAILED', taskId, error, retryable });
  }

  // --- External calls (idempotent) ---

  /**
   * Execute an external call via an adapter, with idempotency.
   * If the same call (adapter + command + args) was already made,
   * returns the cached result instead of re-executing.
   */
  async externalCall(
    adapterName: string,
    command: string,
    args?: Record<string, unknown>,
  ): Promise<{ result: string; cached: boolean }> {
    const adapter = this.adapters[adapterName];
    if (!adapter) {
      throw new Error(`Unknown adapter: ${adapterName}`);
    }

    const key = idempotencyKey(adapterName, command, args);

    // Check for cached result (idempotency)
    const cached = this.log.getCallResult(key);
    if (cached) {
      if (cached.success) {
        return { result: cached.result ?? '', cached: true };
      }
      // Previous call failed — allow retry
    }

    const callId = crypto.randomUUID().slice(0, 8);
    this.log.append({
      type: 'EXTERNAL_CALL_INITIATED',
      callId,
      idempotencyKey: key,
      adapter: adapterName,
      command,
      args,
    });

    try {
      const result = await adapter.execute(command, args);
      this.log.append({
        type: 'EXTERNAL_CALL_COMPLETED',
        callId,
        idempotencyKey: key,
        success: true,
        result,
      });
      return { result, cached: false };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.append({
        type: 'EXTERNAL_CALL_COMPLETED',
        callId,
        idempotencyKey: key,
        success: false,
        error: message,
      });
      throw err;
    }
  }

  // --- Approvals ---

  /** Request approval (human gate). */
  requestApproval(description: string): string {
    const stage = this.currentStage();
    if (!stage) throw new Error('No active stage — cannot request approval');

    const approvalId = crypto.randomUUID().slice(0, 8);
    this.log.append({
      type: 'APPROVAL_REQUESTED',
      approvalId,
      stage,
      description,
    });
    return approvalId;
  }

  /** Record an approval decision. */
  recordApproval(approvalId: string, approved: boolean, reason?: string): void {
    this.log.append({
      type: 'APPROVAL_DECISION',
      approvalId,
      approved,
      reason,
    });
  }

  // --- Session lifecycle ---

  /** Complete the session. Fast-forwards through remaining stages to DONE. */
  complete(summary?: string): void {
    // Complete current stage if active
    const current = this.currentStage();
    if (current && current !== 'DONE') {
      this.completeStage();
    }

    // Fast-forward: enter and complete remaining stages up to DONE
    const lastCompleted = this.lastCompletedStage();
    const startIdx = lastCompleted ? STAGES.indexOf(lastCompleted) + 1 : 0;
    for (let i = startIdx; i < STAGES.length; i++) {
      this.log.append({ type: 'STAGE_ENTERED', stage: STAGES[i] });
      this.log.append({ type: 'STAGE_COMPLETED', stage: STAGES[i] });
    }

    this.log.append({
      type: 'SESSION_COMPLETED',
      finalStage: 'DONE',
      success: true,
      summary,
    });
  }

  /** Fail the session. */
  fail(summary: string): void {
    const current = this.currentStage() ?? 'PLAN';
    this.log.append({
      type: 'SESSION_COMPLETED',
      finalStage: current,
      success: false,
      summary,
    });
  }

  // --- Accessors ---

  /** Session ID. */
  get id(): string {
    return this.sessionId;
  }

  /** The event log backing this orchestrator. */
  get eventLog(): EventLog {
    return this.log;
  }

  /** Registered adapter names. */
  get adapterNames(): string[] {
    return Object.keys(this.adapters);
  }

  /** Register an adapter at runtime. */
  registerAdapter(adapter: Adapter): void {
    this.adapters[adapter.name] = adapter;
  }

  /** Summary of current state (for CLI display / debugging). */
  status(): {
    sessionId: string;
    stage: Stage | null;
    done: boolean;
    tasks: { total: number; completed: number; failed: number; running: number };
    pendingApproval: boolean;
    eventCount: number;
  } {
    const allTasks = this.tasks();
    return {
      sessionId: this.sessionId,
      stage: this.currentStage(),
      done: this.isDone(),
      tasks: {
        total: allTasks.length,
        completed: allTasks.filter((t) => t.status === 'completed').length,
        failed: allTasks.filter((t) => t.status === 'failed').length,
        running: allTasks.filter((t) => t.status === 'running').length,
      },
      pendingApproval: this.pendingApproval() !== null,
      eventCount: this.log.length,
    };
  }
}
