/**
 * Bridge stage machine — orchestrates PLAN→EXECUTE→REVIEW→REFINE→DEPLOY→VERIFY→DONE.
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
import { execFileSync } from 'child_process';
import {
  type BridgeEvent,
  type Stage,
  type EventEnvelope,
  type ExternalCallCompleted,
  STAGES,
  EventLog,
  idempotencyKey,
} from './events.js';
import {
  type DeathEvent,
  type FailureResponse,
  type FailurePolicy,
  type DeathLedger,
  type ReviewRoutingInput,
  type ReviewMode,
  type ReconciliationResult,
  type QualityReport,
  type QualityIteration,
  type ReviewLoopPolicy,
  DEFAULT_FAILURE_POLICY,
  DEFAULT_REVIEW_LOOP_POLICY,
  classifyDeathEvent,
  detectMassDeath,
  routeReview,
  shouldReiterate,
  extractFixableFindings,
  resolvedFindings,
  summarizeIteration,
  reconcileReports,
  evaluate,
} from './quality.js';
import type { ReviewResult, ReviewSuiteResult } from './adapters/gstack.js';
import {
  type MultiModelConfig,
  type BridgeConfig,
  DEFAULT_MULTI_MODEL,
} from './config.js';
import {
  diagnoseStranded,
  type StrandedConvoy,
  type StrandedDiagnosis,
} from './stranded.js';

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

// --- Changelog entry (from gt changelog --json) ---

/** Entry from gt changelog --json output. Flexible shape to handle varying gt versions. */
export interface ChangelogEntry {
  type?: string;
  id?: string;
  title?: string;
  message?: string;
  sha?: string;
  status?: string;
  [key: string]: unknown;
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
      const isCanaryFailLoop = referenceStage === 'VERIFY' && stage === 'REFINE';

      if (!isForward && !isRefineLoop && !isCanaryFailLoop) {
        throw new Error(
          `Invalid transition: ${referenceStage} → ${stage}. ` +
            `Allowed: next stage, REFINE → EXECUTE, or VERIFY → REFINE`,
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

  // --- Death event handling ---

  /** Death ledger: per-task death counts for retry vs investigate decisions. */
  private deathLedger: DeathLedger = new Map();
  /** Recent death events for mass death detection. */
  private recentDeaths: DeathEvent[] = [];
  /** Failure policy configuration. */
  private failurePolicy: FailurePolicy = DEFAULT_FAILURE_POLICY;
  /** Whether dispatch has been halted due to mass death. */
  private dispatchHalted = false;

  /** Configure the failure policy (optional — defaults are sensible). */
  setFailurePolicy(policy: Partial<FailurePolicy>): void {
    this.failurePolicy = { ...this.failurePolicy, ...policy };
  }

  /** Whether dispatch is currently halted. */
  isDispatchHalted(): boolean {
    return this.dispatchHalted;
  }

  /** Resume dispatch after a halt (requires human decision). */
  resumeDispatch(): void {
    this.dispatchHalted = false;
    this.recentDeaths = [];
  }

  /**
   * Handle a death event from gastown's event stream.
   *
   * Decision tree:
   *   - mass_death → HALT all dispatch, surface to human
   *   - scheduler_dispatch_failed → HALT, surface to human
   *   - session_death (first for this task) → auto-retry
   *   - session_death (repeated for same task) → /investigate root cause
   *
   * Encodes gstack's /investigate Iron Law:
   * "No fixes without root cause." Blind retry masks systemic failures.
   * A single auto-retry handles transient crashes (OOM, network blip).
   * Repeated deaths for the same task demand investigation, not retry loops.
   *
   * Returns the classified response so callers can act on it.
   */
  handleDeathEvent(event: DeathEvent): FailureResponse {
    // Track for mass death detection
    this.recentDeaths.push(event);

    // Prune old events outside the window
    const windowMs = this.failurePolicy.massDeathWindowSeconds * 1000;
    const cutoff = Date.now() - windowMs;
    this.recentDeaths = this.recentDeaths.filter(
      (e) => new Date(e.timestamp).getTime() >= cutoff,
    );

    // Check for mass death from accumulated individual session_death events
    if (
      event.type === 'session_death' &&
      detectMassDeath(this.recentDeaths, this.failurePolicy)
    ) {
      this.dispatchHalted = true;
      const syntheticMass: DeathEvent = {
        type: 'mass_death',
        count: this.recentDeaths.length,
        windowSeconds: this.failurePolicy.massDeathWindowSeconds,
        timestamp: event.timestamp,
        reason: `Detected ${this.recentDeaths.length} session deaths within ${this.failurePolicy.massDeathWindowSeconds}s window`,
      };
      return classifyDeathEvent(syntheticMass, this.deathLedger, this.failurePolicy);
    }

    // Classify the individual event
    const response = classifyDeathEvent(event, this.deathLedger, this.failurePolicy);

    if (response.action === 'halt') {
      this.dispatchHalted = true;
    }

    return response;
  }

  /** Get the death ledger (for inspection/debugging). */
  getDeathLedger(): DeathLedger {
    return this.deathLedger;
  }

  // --- Task failure investigation ---

  /**
   * Handle a TASK_FAILED event by auto-invoking /investigate.
   *
   * When a task fails, this method:
   *   1. Spawns a review-only polecat with /investigate on the failed branch
   *   2. Persists root cause diagnosis to bead notes
   *   3. Returns the diagnosis so the next dispatch gets context
   *   4. If /investigate finds a systemic issue, escalates to human
   *
   * Encodes gstack's Iron Law: "No fixes without root cause."
   * Don't blindly retry — understand why it failed first.
   *
   * Returns the investigation result. If investigation itself fails,
   * returns a fallback result and does NOT block the caller.
   */
  async handleTaskFailed(
    taskId: string,
    opts?: {
      /** Bead ID for the failed task. */
      beadId?: string;
      /** Rig to dispatch the investigation polecat to. */
      rig?: string;
      /** Agent to use for investigation. */
      agent?: string;
    },
  ): Promise<{
    /** Root cause description. */
    rootCause: string;
    /** Whether the issue is systemic (not task-specific). */
    systemic: boolean;
    /** Full diagnosis text. */
    diagnosis: string;
    /** Whether a human escalation was triggered. */
    escalated: boolean;
    /** Approval ID if escalation was requested. */
    approvalId?: string;
  }> {
    // Find the failed task in our log
    const task = this.tasks().find((t) => t.taskId === taskId);
    if (!task) {
      return {
        rootCause: `Task ${taskId} not found in event log`,
        systemic: false,
        diagnosis: '',
        escalated: false,
      };
    }

    // Step 1: Dispatch /investigate via gastown adapter (sling.investigate)
    let investigationResult: string;
    try {
      const callArgs: Record<string, unknown> = {
        beadId: opts?.beadId,
        rig: opts?.rig,
        agent: opts?.agent,
        error: task.error ?? 'unknown error',
        taskDescription: task.description,
      };

      const result = await this.externalCall('gastown', 'sling.investigate', callArgs);
      investigationResult = result.result;
    } catch (err) {
      // Investigation dispatch failed — return fallback, don't block
      const message = err instanceof Error ? err.message : String(err);
      return {
        rootCause: `Investigation dispatch failed: ${message}`,
        systemic: false,
        diagnosis: `Could not dispatch /investigate for task ${taskId}: ${message}`,
        escalated: false,
      };
    }

    // Step 2: Parse investigation output
    let rootCause = '';
    let systemic = false;
    let diagnosis = investigationResult;

    try {
      const parsed = JSON.parse(investigationResult);
      rootCause = parsed.rootCause ?? '';
      systemic = parsed.systemic ?? false;
      diagnosis = parsed.diagnosis ?? investigationResult;
    } catch {
      // Raw text output — use as-is
      rootCause = investigationResult.slice(0, 200);
      diagnosis = investigationResult;
    }

    // Step 3: Persist diagnosis to bead notes
    if (opts?.beadId) {
      try {
        await this.externalCall('gastown', 'raw', {
          args: [
            'mail', 'send', '--self',
            '-s', `Investigation: ${taskId}`,
            '-m', `Root cause: ${rootCause}\nSystemic: ${systemic}\nDiagnosis: ${diagnosis.slice(0, 500)}`,
          ],
        });
      } catch {
        // Best-effort: don't fail the flow if note persistence fails
      }
    }

    // Step 4: If systemic, escalate to human
    let escalated = false;
    let approvalId: string | undefined;
    if (systemic) {
      const stage = this.currentStage();
      if (stage) {
        approvalId = this.requestApproval(
          `Systemic issue detected for task ${taskId}: ${rootCause}. ` +
          `This is not task-specific — may affect other tasks. Human review required.`,
        );
      }
      escalated = true;
    }

    return {
      rootCause,
      systemic,
      diagnosis,
      escalated,
      approvalId,
    };
  }

  // --- Multi-model dispatch configuration ---

  private multiModelConfig: MultiModelConfig = { ...DEFAULT_MULTI_MODEL };

  /** Configure multi-model dispatch settings. */
  setMultiModelConfig(config: Partial<MultiModelConfig>): void {
    this.multiModelConfig = { ...this.multiModelConfig, ...config };
  }

  /** Get the current multi-model config. */
  getMultiModelConfig(): MultiModelConfig {
    return { ...this.multiModelConfig };
  }

  // --- Review dispatch ---

  /**
   * Dispatch a review based on the routing decision.
   *
   * Decision tree (encoded in quality.ts routeReview):
   *   - Security-sensitive paths → ALWAYS review-only polecat (separate context)
   *   - Multi-file >50 lines → review-only polecat (unbiased, fresh eyes)
   *   - Single file ≤50 lines → inline review (gstack adapter, same context)
   *
   * For review-only: spawns a separate polecat via gastown sling.review.
   * For inline: runs gstack review-suite in the same context.
   *
   * Returns the review mode used and the raw results.
   */
  async dispatchReview(
    input: ReviewRoutingInput,
    opts?: {
      /** Bead ID for the review-only polecat to report on. */
      beadId?: string;
      /** Rig to dispatch the review-only polecat to. */
      rig?: string;
      /** Agent to use for review (e.g., 'claude', 'gemini'). */
      agent?: string;
      /** Iteration number (breaks idempotency cache for review cycles). */
      iteration?: number;
    },
  ): Promise<{
    mode: ReviewMode;
    reason: string;
    result: string;
  }> {
    const routing = routeReview(input);

    // Fetch execution context from bead notes (best-effort, non-blocking)
    let executionContext: string | undefined;
    if (opts?.beadId) {
      try {
        const ctxResult = await this.externalCall('gastown', 'bead.context', {
          beadId: opts.beadId,
        });
        const ctx = JSON.parse(ctxResult.result);
        if (ctx.summary) {
          executionContext = ctx.summary;
        }
      } catch {
        // Non-fatal: review proceeds without execution context
      }
    }

    if (routing.mode === 'review-only') {
      // Spawn a separate polecat with --review-only
      // Execution context is forwarded via formulaArgs for the review polecat
      const callArgs: Record<string, unknown> = {
        beadId: opts?.beadId,
        rig: opts?.rig,
        agent: opts?.agent,
      };
      if (opts?.iteration) callArgs.iteration = opts.iteration;
      if (executionContext) {
        callArgs.formulaArgs = `${executionContext}\n\nRun /review on the branch, then /cso. Persist findings to bead notes.`;
      }
      const result = await this.externalCall('gastown', 'sling.review', callArgs);
      return { mode: 'review-only', reason: routing.reason, result: result.result };
    }

    // Inline: run review-suite in current context via gstack adapter
    // Include iteration to differentiate review cycles in the idempotency cache
    const callArgs: Record<string, unknown> = {};
    if (opts?.iteration) callArgs.iteration = opts.iteration;
    if (executionContext) callArgs.executionContext = executionContext;
    const result = await this.externalCall(
      'gstack',
      'review-suite',
      Object.keys(callArgs).length > 0 ? callArgs : undefined,
    );
    return { mode: 'inline', reason: routing.reason, result: result.result };
  }

  // --- Review-fix-rereview loop ---

  /** Review loop policy. */
  private reviewLoopPolicy: ReviewLoopPolicy = DEFAULT_REVIEW_LOOP_POLICY;

  /** Configure the review loop policy. */
  setReviewLoopPolicy(policy: Partial<ReviewLoopPolicy>): void {
    this.reviewLoopPolicy = { ...this.reviewLoopPolicy, ...policy };
  }

  /**
   * Count how many review cycles have occurred in this session.
   * Derived from the event log: counts STAGE_ENTERED events for REVIEW.
   */
  reviewCycleCount(): number {
    return this.log.ofType('STAGE_ENTERED')
      .filter((e) => e.stage === 'REVIEW').length;
  }

  /**
   * Get the iteration history from the event log.
   * Each REVIEW stage entry with a subsequent quality evaluation
   * constitutes one iteration.
   */
  iterationHistory(): QualityIteration[] {
    const iterations: QualityIteration[] = [];
    const allEvents = this.log.all();

    let iterationNum = 0;
    for (let i = 0; i < allEvents.length; i++) {
      const ev = allEvents[i].event;
      if (ev.type !== 'STAGE_COMPLETED' || ev.stage !== 'REVIEW') continue;

      iterationNum++;
      // Look for the review cycle summary in the stage completion
      const summary = ev.summary;
      if (!summary) continue;

      try {
        const parsed = JSON.parse(summary) as {
          report?: QualityReport;
          fixesApplied?: string[];
          remainingFindings?: Array<{ severity: string; description: string }>;
        };
        if (parsed.report) {
          iterations.push({
            iteration: iterationNum,
            report: parsed.report,
            fixesApplied: parsed.fixesApplied ?? [],
            remainingFindings: (parsed.remainingFindings ?? []).map((f) => ({
              severity: f.severity as 'CRITICAL' | 'MAJOR' | 'MINOR',
              description: f.description,
            })),
          });
        }
      } catch {
        // Non-JSON summary — skip
      }
    }

    return iterations;
  }

  /**
   * Execute a full review cycle: REVIEW → (if blocked) REFINE → EXECUTE → REVIEW...
   *
   * This is the core of the checkpoint/resume loop. It:
   * 1. Dispatches a review (inline or review-only polecat)
   * 2. Evaluates the quality report
   * 3. If BLOCKED with fixable findings: enters REFINE, queues fix tasks,
   *    loops back to EXECUTE, then re-reviews
   * 4. Compares findings across iterations to detect progress
   * 5. Stops when: quality passes, max iterations reached, or no progress
   *
   * The orchestrator must be in the REVIEW stage when this is called.
   * On completion, the stage will be either:
   *   - REVIEW (completed, ready to advance to DEPLOY) if quality passed
   *   - REVIEW (with pending approval) if max iterations exhausted
   *
   * Returns the final quality report and iteration history.
   */
  async reviewCycle(
    input: ReviewRoutingInput,
    opts?: {
      beadId?: string;
      rig?: string;
      agent?: string;
    },
  ): Promise<{
    report: QualityReport;
    iterations: QualityIteration[];
    passed: boolean;
    approvalRequested: boolean;
  }> {
    const current = this.currentStage();
    if (current !== 'REVIEW') {
      throw new Error(`reviewCycle requires REVIEW stage, currently in ${current}`);
    }

    const iterations: QualityIteration[] = [];
    let lastReport: QualityReport | null = null;
    let approvalRequested = false;

    for (let i = 0; i < this.reviewLoopPolicy.maxIterations; i++) {
      const iterationNum = i + 1;

      // Step 1: Dispatch review
      // Pass iteration number to break idempotency cache — each review cycle
      // must be a fresh external call, not a cached replay of the first.
      const reviewOpts = { ...opts, iteration: iterationNum };
      const reviewResult = await this.dispatchReview(input, reviewOpts);

      // Step 2: Parse and evaluate quality
      const parsed = JSON.parse(reviewResult.result);
      let report: QualityReport;

      if (parsed.review && parsed.cso) {
        // ReviewSuiteResult from inline review
        const suite = parsed as ReviewSuiteResult;
        report = evaluate({ review: suite.review, cso: suite.cso });
      } else if (parsed.grade !== undefined) {
        // Single ReviewResult (from review-only polecat)
        report = evaluate({ review: parsed as ReviewResult });
      } else if (parsed.overall) {
        // Already a QualityReport
        report = parsed as QualityReport;
      } else {
        // Unknown format — treat as WARN
        report = {
          overall: 'WARN',
          gates: [],
          summary: 'Review output could not be parsed into a quality report',
        };
      }

      // Step 3: Build iteration record
      const allFindings = report.gates.flatMap((g) => g.findings);
      const previousFindings = lastReport
        ? lastReport.gates.flatMap((g) => g.findings)
        : [];
      const resolved = lastReport
        ? resolvedFindings(previousFindings, allFindings)
        : [];
      const fixesApplied = resolved.map(
        (f) => `Resolved [${f.severity}]: ${f.description}`,
      );

      const iteration: QualityIteration = {
        iteration: iterationNum,
        report,
        fixesApplied,
        remainingFindings: allFindings,
      };
      iterations.push(iteration);

      // Step 4: Record iteration in event log (stage completion summary)
      const iterationSummary = JSON.stringify({
        report,
        fixesApplied,
        remainingFindings: allFindings,
        iterationNum,
      });

      // Step 5: Check if we pass
      if (report.overall === 'PASS' || report.overall === 'WARN') {
        this.completeStage(iterationSummary);
        lastReport = report;
        return { report, iterations, passed: true, approvalRequested: false };
      }

      // Step 6: BLOCKED — check if we should reiterate
      lastReport = report;

      if (!shouldReiterate(iteration, this.reviewLoopPolicy)) {
        // Can't make more progress — request human approval (while still in REVIEW)
        const summary = summarizeIteration(iteration);
        this.requestApproval(
          `Review found ${allFindings.length} issues after ${iterationNum} iteration(s). ` +
            `${summary}`,
        );
        approvalRequested = true;
        return { report, iterations, passed: false, approvalRequested: true };
      }

      // Step 7: Enter REFINE — queue fix tasks for fixable findings
      this.completeStage(iterationSummary);
      this.enterStage('REFINE');

      const fixable = extractFixableFindings(report);
      for (const finding of fixable) {
        this.queueTask(`Fix [${finding.severity}]: ${finding.description}`, {
          finding,
          iteration: iterationNum,
          reviewContext: iterationSummary,
        });
      }

      // Step 8: Complete REFINE, loop back to EXECUTE
      this.completeStage(`Queued ${fixable.length} fix task(s) from iteration ${iterationNum}`);
      this.enterStage('EXECUTE');

      // In a real bridge, the fix polecat would run here.
      // The orchestrator signals EXECUTE for fix dispatch; callers
      // run the fix work and then call back into reviewCycle.
      // For the loop to continue, we complete EXECUTE and re-enter REVIEW.
      this.completeStage(`Fix iteration ${iterationNum} — re-reviewing`);
      this.enterStage('REVIEW');
    }

    // Max iterations exhausted without passing
    const finalReport = lastReport ?? {
      overall: 'BLOCKED' as const,
      gates: [],
      summary: 'Max review iterations exhausted',
    };

    this.requestApproval(
      `Max ${this.reviewLoopPolicy.maxIterations} review iterations exhausted. ` +
        `${iterations.length} cycle(s) completed. Remaining findings: ` +
        `${finalReport.gates.flatMap((g) => g.findings).map((f) => f.description).join('; ')}`,
    );
    approvalRequested = true;
    return { report: finalReport, iterations, passed: false, approvalRequested: true };
  }

  /**
   * Dispatch multi-model review: run primary AND secondary review agents,
   * then reconcile their verdicts.
   *
   * Encodes the "20th dentist" philosophy: two models disagreeing is signal.
   * When primary (claude) and secondary (codex) disagree on verdict,
   * the DISAGREEMENT itself triggers human review via approval request.
   *
   * Flow:
   *   1. Run primary review (default agent or configured primary)
   *   2. Run secondary review (configured review agent, e.g., codex)
   *   3. Evaluate both through quality gates
   *   4. Reconcile verdicts using disagreement policy
   *   5. If human_review outcome → request approval
   *
   * Returns both reports, reconciliation result, and merged report.
   */
  async dispatchMultiModelReview(
    input: ReviewRoutingInput,
    opts?: {
      beadId?: string;
      rig?: string;
      /** Override primary agent. */
      primaryAgent?: string;
      /** Override secondary (review) agent. */
      reviewAgent?: string;
    },
  ): Promise<{
    mode: ReviewMode;
    reason: string;
    primaryReport: QualityReport;
    secondaryReport: QualityReport;
    reconciliation: ReconciliationResult;
    mergedReport: QualityReport;
    /** If human review was requested, the approval ID. */
    approvalId?: string;
  }> {
    const config = this.multiModelConfig;
    const primaryAgent = opts?.primaryAgent ?? config.primary;
    const reviewAgent = opts?.reviewAgent ?? config.review;

    // Step 1: Determine routing
    const routing = routeReview(input);

    // Step 1b: Fetch execution context from bead notes (best-effort)
    let executionContext: string | undefined;
    if (opts?.beadId) {
      try {
        const ctxResult = await this.externalCall('gastown', 'bead.context', {
          beadId: opts.beadId,
        });
        const ctx = JSON.parse(ctxResult.result);
        if (ctx.summary) {
          executionContext = ctx.summary;
        }
      } catch {
        // Non-fatal: review proceeds without execution context
      }
    }

    // Step 2: Dispatch primary review
    const primarySlingArgs: Record<string, unknown> = {
      beadId: opts?.beadId,
      rig: opts?.rig,
      agent: primaryAgent,
    };
    if (executionContext) {
      primarySlingArgs.formulaArgs = `${executionContext}\n\nRun /review on the branch, then /cso. Persist findings to bead notes.`;
    }
    const primaryResult = routing.mode === 'review-only'
      ? await this.externalCall('gastown', 'sling.review', primarySlingArgs)
      : await this.externalCall('gstack', 'review-suite', {
          agent: primaryAgent,
          executionContext,
        });

    // Step 3: Dispatch secondary (independent) review
    // Always use sling.review for secondary — separate context ensures independence
    const secondarySlingArgs: Record<string, unknown> = {
      beadId: opts?.beadId,
      rig: opts?.rig,
      agent: reviewAgent,
    };
    if (executionContext) {
      secondarySlingArgs.formulaArgs = `${executionContext}\n\nRun /review on the branch, then /cso. Persist findings to bead notes.`;
    }
    const secondaryResult = await this.externalCall('gastown', 'sling.review', secondarySlingArgs);

    // Step 4: Parse and evaluate both results through quality gates
    const primaryParsed = safeParseReviewSuite(primaryResult.result);
    const secondaryParsed = safeParseReviewSuite(secondaryResult.result);

    const primaryReport = evaluate(primaryParsed);
    const secondaryReport = evaluate(secondaryParsed);

    // Step 5: Reconcile verdicts
    const { reconciliation, mergedReport } = reconcileReports(primaryReport, secondaryReport);

    // Step 6: If disagreement requires human review, request approval
    let approvalId: string | undefined;
    if (reconciliation.outcome === 'human_review') {
      approvalId = this.requestApproval(
        `Multi-model disagreement: ${primaryAgent} says ${reconciliation.primaryVerdict}, ` +
        `${reviewAgent} says ${reconciliation.secondaryVerdict}. ` +
        `The disagreement itself is signal — human review required.`,
      );
    }

    return {
      mode: routing.mode,
      reason: routing.reason,
      primaryReport,
      secondaryReport,
      reconciliation,
      mergedReport,
      approvalId,
    };
  }

  // --- Stranded convoy polling (EXECUTE stage) ---

  /** Poll counter for stranded checks (breaks idempotency cache per poll). */
  private strandedPollCount = 0;

  /**
   * Poll for stranded convoys during the EXECUTE stage.
   *
   * Calls `gt convoy stranded --json` via the gastown adapter, filters for
   * the specified convoy, joins with quality context from the event log,
   * and returns actionable diagnoses.
   *
   * For each stranded convoy:
   *   - no_workers  → re-sling ready issues via gastown adapter
   *   - quality_blocked → request human approval (quality findings need review)
   *   - dependency_blocked → log and continue (external dependency)
   *   - empty → signal for auto-close
   *
   * Each call increments an internal poll counter to ensure fresh external
   * calls (not cached by idempotency). This is intentional — polling must
   * see current state, not replayed state.
   *
   * The orchestrator must be in the EXECUTE stage when this is called.
   */
  async pollStranded(opts?: {
    /** Convoy ID to filter for. If omitted, diagnoses ALL stranded convoys. */
    convoyId?: string;
    /** Rig to re-sling tasks to (required for auto re-sling). */
    rig?: string;
    /** Agent override for re-slung tasks. */
    agent?: string;
  }): Promise<{
    /** All stranded diagnoses (filtered to convoyId if provided). */
    diagnoses: StrandedDiagnosis[];
    /** Actions taken automatically (re-sling, approval requests). */
    actions: Array<{
      type: 'resling' | 'approval' | 'empty';
      convoyId: string;
      detail: string;
    }>;
    /** Poll number (monotonically increasing). */
    pollNumber: number;
  }> {
    const current = this.currentStage();
    if (current !== 'EXECUTE') {
      throw new Error(`pollStranded requires EXECUTE stage, currently in ${current}`);
    }

    this.strandedPollCount++;
    const pollNumber = this.strandedPollCount;

    // Step 1: Fetch stranded convoys via gastown adapter.
    // Pass pollCount in args to break the idempotency cache — each poll
    // must query current state, not return a cached previous result.
    let rawConvoys: StrandedConvoy[];
    try {
      const result = await this.externalCall('gastown', 'convoy.stranded', {
        _poll: pollNumber,
      });
      const parsed = JSON.parse(result.result);
      rawConvoys = Array.isArray(parsed) ? parsed : (parsed.convoys ?? parsed.data ?? []);
    } catch (err) {
      // convoy.stranded failed — return empty (non-fatal, will retry next poll)
      return { diagnoses: [], actions: [], pollNumber };
    }

    // Step 2: Filter to our convoy if specified
    const convoys = opts?.convoyId
      ? rawConvoys.filter((c) => c.id === opts.convoyId)
      : rawConvoys;

    if (convoys.length === 0) {
      return { diagnoses: [], actions: [], pollNumber };
    }

    // Step 3: Build quality cache from event log
    const qualityCache = this.buildQualityCache();

    // Step 4: Diagnose
    const diagnoses = diagnoseStranded(convoys, qualityCache);

    // Step 5: Take action per diagnosis
    const actions: Array<{
      type: 'resling' | 'approval' | 'empty';
      convoyId: string;
      detail: string;
    }> = [];

    for (const diagnosis of diagnoses) {
      switch (diagnosis.strandedReason) {
        case 'no_workers': {
          // Find the convoy's ready issues and re-sling them
          const convoy = convoys.find((c) => c.id === diagnosis.convoyId);
          if (convoy && convoy.ready_issues.length > 0 && opts?.rig) {
            try {
              await this.externalCall('gastown', 'sling.batch', {
                beadIds: convoy.ready_issues,
                rig: opts.rig,
                agent: opts.agent,
                _poll: pollNumber,
              });
              actions.push({
                type: 'resling',
                convoyId: diagnosis.convoyId,
                detail: `Re-slung ${convoy.ready_issues.length} ready issue(s): ${convoy.ready_issues.join(', ')}`,
              });
            } catch {
              // Re-sling failed — surface to human via approval
              this.requestApproval(
                `Stranded convoy ${diagnosis.convoyId}: re-sling failed for ` +
                  `${convoy.ready_issues.length} issue(s). Manual intervention needed.`,
              );
              actions.push({
                type: 'approval',
                convoyId: diagnosis.convoyId,
                detail: `Re-sling failed — approval requested`,
              });
            }
          }
          break;
        }

        case 'quality_blocked': {
          // Quality findings block progress — surface to human
          this.requestApproval(
            `Stranded convoy ${diagnosis.convoyId}: ${diagnosis.recommendedAction}`,
          );
          actions.push({
            type: 'approval',
            convoyId: diagnosis.convoyId,
            detail: diagnosis.recommendedAction,
          });
          break;
        }

        case 'empty': {
          actions.push({
            type: 'empty',
            convoyId: diagnosis.convoyId,
            detail: 'Empty convoy — candidate for auto-close.',
          });
          break;
        }

        case 'dependency_blocked': {
          // External dependency — nothing we can do, just log
          break;
        }
      }
    }

    return { diagnoses, actions, pollNumber };
  }

  /**
   * Build a quality cache from this session's event log.
   *
   * Scans EXTERNAL_CALL_COMPLETED events for quality evaluation results
   * and maps idempotency keys to QualityReport objects. Used by pollStranded
   * to join convoy data with quality context.
   */
  private buildQualityCache(): Map<string, QualityReport> {
    const cache = new Map<string, QualityReport>();
    const calls = this.log.ofType('EXTERNAL_CALL_COMPLETED');
    for (const call of calls) {
      if (!call.success || !call.result) continue;
      try {
        const parsed = JSON.parse(call.result);
        if (parsed.overall && Array.isArray(parsed.gates)) {
          cache.set(call.idempotencyKey, parsed as QualityReport);
        }
      } catch {
        // Not JSON or not a quality report — skip
      }
    }
    return cache;
  }

  // --- Post-deploy canary verification ---

  /**
   * Run canary verification after deploy, before DONE.
   *
   * Invokes gstack's /canary skill to check for console errors, performance
   * regressions, and page failures on the deployed branch. The orchestrator
   * must be in the VERIFY stage when this is called.
   *
   * On pass: VERIFY completes, ready to advance to DONE.
   * On fail: transitions to REFINE (human decides next action).
   *
   * Returns the canary result and whether verification passed.
   */
  async verifyCycle(opts?: {
    /** Production URL to canary-check. */
    url?: string;
    /** Duration in seconds for the canary monitoring window. */
    duration?: number;
  }): Promise<{
    passed: boolean;
    result: string;
    /** If failed, an approval is requested for the human to decide. */
    approvalRequested: boolean;
  }> {
    const current = this.currentStage();
    if (current !== 'VERIFY') {
      throw new Error(`verifyCycle requires VERIFY stage, currently in ${current}`);
    }

    // Invoke canary via gstack adapter
    const canaryArgs: Record<string, unknown> = {};
    if (opts?.url) canaryArgs.url = opts.url;
    if (opts?.duration) canaryArgs.duration = opts.duration;

    let canaryResult: string;
    try {
      const call = await this.externalCall('gstack', 'canary', canaryArgs);
      canaryResult = call.result;
    } catch (err) {
      // Canary invocation itself failed — treat as verification failure
      const message = err instanceof Error ? err.message : String(err);
      canaryResult = JSON.stringify({ passed: false, error: message });
    }

    // Parse canary result
    let passed = false;
    try {
      const parsed = JSON.parse(canaryResult);
      passed = parsed.passed === true;
    } catch {
      // Unparseable result — treat as failure
      passed = false;
    }

    if (passed) {
      this.completeStage(`Canary verification passed`);
      return { passed: true, result: canaryResult, approvalRequested: false };
    }

    // Canary failed — transition to REFINE, request human decision
    this.completeStage(`Canary verification failed: ${canaryResult}`);
    this.enterStage('REFINE');
    this.requestApproval(
      `Post-deploy canary verification failed. ` +
        `Result: ${canaryResult}. ` +
        `Action needed: investigate and fix, or accept the deployment.`,
    );
    return { passed: false, result: canaryResult, approvalRequested: true };
  }

  // --- Feedback loop: learnings ---

  /**
   * Check if the session had a clean run — no review-fix loops and no approval overrides.
   * A clean run means all stages passed on the first attempt without human intervention.
   *
   * Detects loops by counting REVIEW stage entries (>1 means a REFINE→EXECUTE→REVIEW
   * cycle occurred). Fast-forwarded stages from complete() don't count because
   * complete() fast-forwards linearly without re-entering REVIEW.
   */
  isCleanRun(): boolean {
    // Multiple REVIEW entries = review-fix loop occurred
    const reviewEntries = this.log.ofType('STAGE_ENTERED').filter((e) => e.stage === 'REVIEW');
    if (reviewEntries.length > 1) return false;

    // Any approval decision = human override was needed
    const approvalDecisions = this.log.ofType('APPROVAL_DECISION');
    if (approvalDecisions.length > 0) return false;

    return true;
  }

  /**
   * Extract a learning summary from a clean session run.
   *
   * Analyzes the event log to produce structured learning entries:
   * - Task types that passed cleanly (from TASK_COMPLETED events)
   * - Review quality outcomes (from REVIEW stage completions)
   * - Quality gate results (from review cycle iteration summaries)
   *
   * Returns an array of learning entries ready for gstack-learnings-log.
   */
  extractLearnings(): Array<{
    skill: string;
    type: string;
    key: string;
    insight: string;
    confidence: number;
    source: string;
    files?: string[];
  }> {
    const learnings: Array<{
      skill: string;
      type: string;
      key: string;
      insight: string;
      confidence: number;
      source: string;
      files?: string[];
    }> = [];

    // 1. Tasks that completed successfully
    const completedTasks = this.tasks().filter((t) => t.status === 'completed');
    if (completedTasks.length > 0) {
      const taskTypes = [...new Set(completedTasks.map((t) => t.stage))];
      learnings.push({
        skill: 'bridge',
        type: 'pattern',
        key: 'clean-task-completion',
        insight: `${completedTasks.length} task(s) completed cleanly across stages: ${taskTypes.join(', ')}`,
        confidence: 7,
        source: 'observed',
      });
    }

    // 2. Review quality gate outcomes
    const reviewCompletions = this.log.ofType('STAGE_COMPLETED')
      .filter((e) => e.stage === 'REVIEW' && e.summary);

    for (const completion of reviewCompletions) {
      try {
        const parsed = JSON.parse(completion.summary!) as {
          report?: { overall?: string; gates?: Array<{ name: string; verdict: string }> };
        };
        if (parsed.report?.overall) {
          learnings.push({
            skill: 'bridge',
            type: 'pattern',
            key: `review-outcome-${parsed.report.overall.toLowerCase()}`,
            insight: `Review passed with ${parsed.report.overall} verdict. ` +
              `Gates: ${(parsed.report.gates ?? []).map((g) => `${g.name}=${g.verdict}`).join(', ') || 'none'}`,
            confidence: 8,
            source: 'observed',
          });
        }
      } catch {
        // Non-JSON summary — skip
      }
    }

    // 3. External calls that succeeded (adapter patterns)
    const successfulCalls = this.log.ofType('EXTERNAL_CALL_COMPLETED')
      .filter((e) => e.success);
    if (successfulCalls.length > 0) {
      // Match with initiated calls for adapter info
      const initiatedCalls = this.log.ofType('EXTERNAL_CALL_INITIATED');
      const adapterCommands = new Set<string>();
      for (const call of successfulCalls) {
        const initiated = initiatedCalls.find((ic) => ic.callId === call.callId);
        if (initiated) {
          adapterCommands.add(`${initiated.adapter}:${initiated.command}`);
        }
      }
      if (adapterCommands.size > 0) {
        learnings.push({
          skill: 'bridge',
          type: 'pattern',
          key: 'successful-adapter-calls',
          insight: `Adapter calls succeeded: ${[...adapterCommands].join(', ')}`,
          confidence: 6,
          source: 'observed',
        });
      }
    }

    return learnings;
  }

  /**
   * Log learnings from a clean session to gstack-learnings-log.
   *
   * Called automatically on clean DONE (no REFINE loops, no overrides).
   * Uses the gstack-learnings-log binary to persist entries.
   *
   * Returns the number of learnings logged, or 0 if logging was skipped/failed.
   */
  logLearnings(): number {
    if (!this.isCleanRun()) return 0;

    const learnings = this.extractLearnings();
    if (learnings.length === 0) return 0;

    // Find gstack-learnings-log binary
    const binPaths = [
      path.join(this.projectDir, 'bin', 'gstack-learnings-log'),
      path.join(process.env.HOME ?? '', '.claude', 'skills', 'gstack', 'bin', 'gstack-learnings-log'),
    ];

    let logBin: string | null = null;
    for (const p of binPaths) {
      if (fs.existsSync(p)) {
        logBin = p;
        break;
      }
    }

    if (!logBin) return 0;

    let logged = 0;
    for (const learning of learnings) {
      try {
        execFileSync(logBin, [JSON.stringify(learning)], {
          cwd: this.projectDir,
          timeout: 5000,
          stdio: 'pipe',
        });
        logged++;
      } catch {
        // Best-effort: don't fail the session if learnings can't be logged
      }
    }

    return logged;
  }

  // --- Completion summary ---

  /**
   * Get the session start time from the SESSION_CREATED event envelope.
   * Returns ISO timestamp string, or null if no SESSION_CREATED found.
   */
  sessionStartTime(): string | null {
    const events = this.log.all();
    for (const env of events) {
      if (env.event.type === 'SESSION_CREATED') {
        return env.timestamp;
      }
    }
    return null;
  }

  /**
   * Build a rich completion summary using gt changelog data.
   *
   * Calls `gt changelog --json --since <session-start> --rig <rig>` via the
   * gastown adapter and formats a summary with actual git commits and bead
   * closures instead of just "Shipped. N tasks."
   *
   * Falls back to task-count summary if the adapter call fails or no
   * gastown adapter is registered.
   */
  async buildCompletionSummary(opts?: { rig?: string }): Promise<string> {
    const tasks = this.tasks();
    const completed = tasks.filter((t) => t.status === 'completed');
    const failed = tasks.filter((t) => t.status === 'failed');
    const fallback = `Shipped. ${completed.length} task${completed.length !== 1 ? 's' : ''} completed` +
      (failed.length > 0 ? `, ${failed.length} failed` : '') + '.';

    const adapter = this.adapters['gastown'];
    if (!adapter) return fallback;

    const startTime = this.sessionStartTime();
    if (!startTime) return fallback;

    // Extract date portion (YYYY-MM-DD) for --since flag
    const sinceDate = startTime.slice(0, 10);

    try {
      const changelogArgs: Record<string, unknown> = { since: sinceDate };
      if (opts?.rig) changelogArgs.rig = opts.rig;

      const raw = await adapter.execute('changelog', changelogArgs);
      const changelog = JSON.parse(raw) as ChangelogEntry[];

      if (!Array.isArray(changelog) || changelog.length === 0) {
        return fallback;
      }

      // Build rich summary
      const parts: string[] = [];
      parts.push(`Shipped. ${completed.length} task${completed.length !== 1 ? 's' : ''} completed.`);

      // Summarize bead closures
      const closedBeads = changelog.filter((e) => e.type === 'bead_closed' || e.status === 'closed');
      if (closedBeads.length > 0) {
        parts.push(`Beads closed: ${closedBeads.map((b) => b.id || b.title || 'unknown').join(', ')}.`);
      }

      // Summarize git commits
      const commits = changelog.filter((e) => e.type === 'commit' || e.sha);
      if (commits.length > 0) {
        const commitLines = commits
          .slice(0, 10) // Cap at 10 for readability
          .map((c) => `  ${(c.sha as string)?.slice(0, 7) || '?'} ${c.message || c.title || ''}`)
          .join('\n');
        parts.push(`Git commits:\n${commitLines}`);
        if (commits.length > 10) {
          parts.push(`  ... and ${commits.length - 10} more`);
        }
      }

      if (failed.length > 0) {
        parts.push(`Failed: ${failed.length} task${failed.length !== 1 ? 's' : ''}.`);
      }

      return parts.join('\n');
    } catch {
      // Changelog call failed — fall back to simple summary
      return fallback;
    }
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

    // Log learnings from clean runs before emitting terminal event
    this.logLearnings();

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

// --- Helpers ---

import type { ReviewResult, ReviewSuiteResult } from './adapters/gstack.js';
import type { EvaluateInput } from './quality.js';

/**
 * Parse a review suite result string into EvaluateInput.
 * Handles both ReviewSuiteResult JSON and plain ReviewResult JSON.
 */
function safeParseReviewSuite(raw: string): EvaluateInput {
  try {
    const parsed = JSON.parse(raw);

    // ReviewSuiteResult shape: { review: {...}, cso: {...} }
    if (parsed && typeof parsed === 'object' && 'review' in parsed) {
      return {
        review: parsed.review as ReviewResult,
        cso: parsed.cso as ReviewResult | undefined,
      };
    }

    // Plain ReviewResult: treat as review only
    if (parsed && typeof parsed === 'object' && ('grade' in parsed || 'findings' in parsed)) {
      return { review: parsed as ReviewResult };
    }

    return {};
  } catch {
    return {};
  }
}
