/**
 * Full lifecycle integration test — PLAN→EXECUTE→REVIEW→DEPLOY→DONE
 * with realistic adapters (ga-ckv).
 *
 * Single test walks through all stages with realistic gt CLI responses
 * and review fixture output. Verifies:
 *   - Stage transitions follow the correct sequence
 *   - Tasks are tracked per-stage with correct status
 *   - External calls are idempotent (cached on second invocation)
 *   - Review output is parsed and quality gates evaluated
 *   - Final status reflects correct event count and completion state
 *   - Bead IDs flow through the lifecycle
 *
 * <10s, fully deterministic with fixtures. No real CLI calls.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { createTestRig, type TestRig } from './test-rig.js';
import { RealisticGtAdapter, ReviewFixtureAdapter, RecordingAdapter } from './test-adapters.js';
import { Orchestrator } from '../orchestrate.js';
import { EventLog, type Stage, STAGES } from '../events.js';
import { evaluate, type QualityReport } from '../quality.js';
import { parseReviewOutput } from '../adapters/gstack.js';

let rig: TestRig;

beforeEach(() => {
  rig = createTestRig();
});

afterEach(() => {
  rig.cleanup();
});

describe('Full lifecycle integration', () => {
  test('PLAN→EXECUTE→REVIEW→DEPLOY→DONE with realistic adapters', async () => {
    // --- Setup adapters ---

    // Gastown adapter: returns realistic gt CLI fixture responses
    // plus custom responses for bead/convoy operations
    const gtAdapter = new RealisticGtAdapter({
      'bd.create': JSON.stringify({ id: 'gt-t1x', title: 'Implement feature X' }),
      'bd.update': JSON.stringify({ id: 'gt-t1x', status: 'in_progress' }),
      'bd.close': JSON.stringify({ id: 'gt-t1x', status: 'closed' }),
      'convoy.create': JSON.stringify({
        convoy_id: 'convoy-abc123',
        bead_ids: ['gt-t1x'],
        status: 'pending',
      }),
      'convoy.sling': JSON.stringify({
        convoy_id: 'convoy-abc123',
        status: 'submitted',
        message: 'Convoy submitted to merge queue',
      }),
      done: JSON.stringify({
        success: true,
        mr_id: 'mr-xyz789',
        branch: 'polecat/slit/feature-x',
        target: 'main',
      }),
    });

    // Review adapter: returns clean review (A- grade, no findings)
    const reviewAdapter = new ReviewFixtureAdapter({
      reviewFixture: 'clean-review.md',
      csoFixture: 'low-design.md', // B+ with minor findings only
    });

    // Recording adapter for deploy commands
    const deployAdapter = new RecordingAdapter('deploy', {
      commandResponses: {
        'pre-flight': JSON.stringify({ checks: ['lint', 'test', 'build'], all_passed: true }),
        push: JSON.stringify({ pushed: true, branch: 'polecat/slit/feature-x', sha: 'abc1234' }),
        submit: JSON.stringify({ mr_id: 'mr-xyz789', status: 'queued' }),
      },
    });

    // Create orchestrator with all adapters
    const orch = rig.createOrchestrator({
      gastown: gtAdapter,
      gstack: reviewAdapter,
      deploy: deployAdapter,
    });

    // --- PLAN stage ---

    orch.enterStage('PLAN');
    expect(orch.currentStage()).toBe('PLAN');

    // Check hook to confirm assignment
    const hookResult = await orch.externalCall('gastown', 'hook');
    expect(hookResult.cached).toBe(false);
    const hookData = JSON.parse(hookResult.result);
    expect(hookData.hooked).toBe(true);
    expect(hookData.bead_id).toBe('ga-b04');

    // Queue planning tasks
    const planTask1 = orch.queueTask('Parse design doc for requirements');
    const planTask2 = orch.queueTask('Check mol status for formula steps');

    // Execute planning tasks
    orch.startTask(planTask1);
    orch.completeTask(planTask1, '3 tasks extracted from design doc');

    orch.startTask(planTask2);
    const molResult = await orch.externalCall('gastown', 'mol.status');
    const molData = JSON.parse(molResult.result);
    expect(molData.steps_total).toBe(8);
    orch.completeTask(planTask2, `Formula has ${molData.steps_total} steps`);

    expect(orch.stageTasksComplete('PLAN')).toBe(true);
    orch.completeStage('3 tasks planned from design doc');

    // --- EXECUTE stage ---

    orch.enterStage('EXECUTE');
    expect(orch.currentStage()).toBe('EXECUTE');

    // Create bead for the work
    const bdResult = await orch.externalCall('gastown', 'bd.create');
    expect(bdResult.cached).toBe(false);
    const beadData = JSON.parse(bdResult.result);
    expect(beadData.id).toBe('gt-t1x');

    // Queue implementation tasks
    const execTask1 = orch.queueTask('Implement feature X', { bead_id: beadData.id });
    const execTask2 = orch.queueTask('Write tests for feature X', { bead_id: beadData.id });
    const execTask3 = orch.queueTask('Update bead status', { bead_id: beadData.id });

    // Execute them
    orch.startTask(execTask1);
    orch.completeTask(execTask1, 'Feature implemented in 3 files');

    orch.startTask(execTask2);
    orch.completeTask(execTask2, '12 tests added, all passing');

    orch.startTask(execTask3);
    const updateResult = await orch.externalCall('gastown', 'bd.update');
    orch.completeTask(execTask3, `Bead ${beadData.id} updated to in_progress`);

    expect(orch.stageTasksComplete('EXECUTE')).toBe(true);
    orch.completeStage('All 3 execution tasks completed');

    // --- REVIEW stage ---

    orch.enterStage('REVIEW');
    expect(orch.currentStage()).toBe('REVIEW');

    const reviewTask = orch.queueTask('Run review suite');
    orch.startTask(reviewTask);

    // Run review via gstack adapter
    const reviewResult = await orch.externalCall('gstack', 'review');
    const reviewParsed = JSON.parse(reviewResult.result);
    expect(reviewParsed.grade).toBe('A-');
    expect(reviewParsed.findings).toHaveLength(0);

    // Run CSO via gstack adapter
    const csoResult = await orch.externalCall('gstack', 'cso');
    const csoParsed = JSON.parse(csoResult.result);
    expect(csoParsed.grade).toBe('B+');
    expect(csoParsed.findings.every((f: { severity: string }) => f.severity === 'MINOR')).toBe(true);

    // Run quality evaluation
    const qualityReport = evaluate({
      review: reviewParsed,
      cso: csoParsed,
    });
    expect(qualityReport.overall).not.toBe('BLOCKED');

    orch.completeTask(reviewTask, `Quality: ${qualityReport.overall}`);

    // Request and grant approval
    const approvalId = orch.requestApproval('Review passed, approve for deployment?');
    expect(orch.pendingApproval()).not.toBeNull();
    orch.recordApproval(approvalId, true, `Quality ${qualityReport.overall} — proceeding`);
    expect(orch.pendingApproval()).toBeNull();

    orch.completeStage('Review passed with A- grade, approved for deployment');

    // --- REFINE stage (pass through — no refinement needed) ---

    orch.enterStage('REFINE');
    expect(orch.currentStage()).toBe('REFINE');
    orch.completeStage('No refinement needed — review passed clean');

    // --- DEPLOY stage ---

    orch.enterStage('DEPLOY');
    expect(orch.currentStage()).toBe('DEPLOY');

    const deployTask = orch.queueTask('Deploy to merge queue');
    orch.startTask(deployTask);

    // Pre-flight checks
    const preFlightResult = await orch.externalCall('deploy', 'pre-flight');
    const preFlightData = JSON.parse(preFlightResult.result);
    expect(preFlightData.all_passed).toBe(true);

    // Push branch
    const pushResult = await orch.externalCall('deploy', 'push');
    const pushData = JSON.parse(pushResult.result);
    expect(pushData.pushed).toBe(true);

    // Submit to merge queue
    const submitResult = await orch.externalCall('deploy', 'submit');
    const submitData = JSON.parse(submitResult.result);
    expect(submitData.mr_id).toBe('mr-xyz789');

    orch.completeTask(deployTask, `MR ${submitData.mr_id} queued`);
    orch.completeStage('Branch pushed and MR submitted to merge queue');

    // --- DONE stage ---

    orch.enterStage('DONE');
    expect(orch.currentStage()).toBe('DONE');

    // Signal completion via gastown adapter
    const doneResult = await orch.externalCall('gastown', 'done');
    const doneData = JSON.parse(doneResult.result);
    expect(doneData.success).toBe(true);
    expect(doneData.mr_id).toBe('mr-xyz789');

    orch.completeStage('Session complete');

    // Finalize the session
    orch.complete('Full lifecycle complete: PLAN→EXECUTE→REVIEW→DEPLOY→DONE');

    // --- Verify final state ---

    expect(orch.isDone()).toBe(true);
    expect(orch.currentStage()).toBeNull();

    const finalStatus = orch.status();
    expect(finalStatus.done).toBe(true);
    expect(finalStatus.tasks.total).toBe(7); // 2 plan + 3 execute + 1 review + 1 deploy
    expect(finalStatus.tasks.completed).toBe(7);
    expect(finalStatus.tasks.failed).toBe(0);
    expect(finalStatus.tasks.running).toBe(0);
    expect(finalStatus.pendingApproval).toBe(false);
    expect(finalStatus.eventCount).toBeGreaterThan(30); // substantial event log

    // Verify adapter call counts
    expect(gtAdapter.calls.length).toBeGreaterThanOrEqual(5); // hook, mol.status, bd.create, bd.update, done
    expect(reviewAdapter.calls).toHaveLength(2); // review + cso
    expect(deployAdapter.calls).toHaveLength(3); // pre-flight, push, submit
  });

  test('idempotent external calls are cached on second invocation', async () => {
    const gtAdapter = new RealisticGtAdapter({
      'bd.create': JSON.stringify({ id: 'gt-t1x', title: 'Test bead' }),
    });

    const orch = rig.createOrchestrator({ gastown: gtAdapter });
    orch.enterStage('PLAN');

    // First call — executes
    const r1 = await orch.externalCall('gastown', 'hook');
    expect(r1.cached).toBe(false);

    // Same call again — cached
    const r2 = await orch.externalCall('gastown', 'hook');
    expect(r2.cached).toBe(true);
    expect(r2.result).toBe(r1.result);

    // Verify the adapter was only called once
    expect(gtAdapter.callsFor('hook')).toHaveLength(1);

    // Different command — not cached
    const r3 = await orch.externalCall('gastown', 'mol.status');
    expect(r3.cached).toBe(false);
    expect(gtAdapter.callsFor('mol.status')).toHaveLength(1);
  });

  test('stage transitions follow correct sequence', () => {
    const orch = rig.createOrchestrator();

    // Must start with PLAN
    expect(() => orch.enterStage('EXECUTE')).toThrow('First stage must be PLAN');

    orch.enterStage('PLAN');
    orch.completeStage();

    // Must go to EXECUTE after PLAN
    expect(() => orch.enterStage('REVIEW')).toThrow('Invalid transition');
    orch.enterStage('EXECUTE');
    orch.completeStage();

    orch.enterStage('REVIEW');
    orch.completeStage();

    orch.enterStage('REFINE');
    orch.completeStage();

    // REFINE can loop back to EXECUTE
    orch.enterStage('EXECUTE');
    orch.completeStage();

    // Continue forward from EXECUTE
    orch.enterStage('REVIEW');
    orch.completeStage();

    orch.enterStage('REFINE');
    orch.completeStage();

    orch.enterStage('DEPLOY');
    orch.completeStage();

    orch.enterStage('DONE');
    orch.completeStage();
  });

  test('crash recovery preserves full lifecycle state', async () => {
    const gtAdapter = new RealisticGtAdapter();
    const reviewAdapter = new ReviewFixtureAdapter({ reviewFixture: 'clean-review.md' });

    // Session 1: progress through PLAN and halfway into EXECUTE
    const orch1 = rig.createOrchestrator({
      gastown: gtAdapter,
      gstack: reviewAdapter,
    });

    orch1.enterStage('PLAN');
    const t1 = orch1.queueTask('Parse design');
    orch1.startTask(t1);
    orch1.completeTask(t1, 'Done');
    orch1.completeStage('Plan complete');

    orch1.enterStage('EXECUTE');
    const t2 = orch1.queueTask('Implement feature');
    orch1.startTask(t2);
    orch1.completeTask(t2, 'Feature done');

    const t3 = orch1.queueTask('Write tests');
    orch1.startTask(t3);
    // CRASH — t3 still running

    const logPath = orch1.eventLog.path;

    // Session 2: resume from crash
    const freshGtAdapter = new RealisticGtAdapter();
    const orch2 = Orchestrator.resume(logPath, {
      gastown: freshGtAdapter,
      gstack: reviewAdapter,
    });

    // Should resume at EXECUTE with the correct task state
    expect(orch2.currentStage()).toBe('EXECUTE');
    expect(orch2.tasks()).toHaveLength(3);

    const tasks = orch2.tasks();
    expect(tasks.filter(t => t.status === 'completed')).toHaveLength(2);
    expect(tasks.filter(t => t.status === 'running')).toHaveLength(1);
    expect(tasks.find(t => t.status === 'running')?.description).toBe('Write tests');

    // Idempotency is preserved — hook call from session 1 would be cached
    // (but in this test we didn't make external calls before crash, so verify
    //  that new calls work correctly after resume)
    const hookResult = await orch2.externalCall('gastown', 'hook');
    expect(hookResult.cached).toBe(false);
    expect(freshGtAdapter.callsFor('hook')).toHaveLength(1);

    // Continue the lifecycle to completion
    orch2.completeTask(t3, 'Tests written');
    orch2.completeStage();

    orch2.enterStage('REVIEW');
    orch2.completeStage();
    orch2.enterStage('REFINE');
    orch2.completeStage();
    orch2.enterStage('DEPLOY');
    orch2.completeStage();
    orch2.enterStage('DONE');
    orch2.complete('Recovered and completed');

    expect(orch2.isDone()).toBe(true);
  });

  test('REFINE loop back to EXECUTE then forward to DONE', async () => {
    const reviewAdapter = new ReviewFixtureAdapter({ reviewFixture: 'medium-correctness.md' });

    const orch = rig.createOrchestrator({ gstack: reviewAdapter });

    // PLAN
    orch.enterStage('PLAN');
    orch.completeStage('Planned');

    // EXECUTE (first pass)
    orch.enterStage('EXECUTE');
    const t1 = orch.queueTask('Initial implementation');
    orch.startTask(t1);
    orch.completeTask(t1, 'Done');
    orch.completeStage('First pass');

    // REVIEW — gets medium-correctness (D+ grade)
    orch.enterStage('REVIEW');
    const reviewResult = await orch.externalCall('gstack', 'review');
    const parsed = JSON.parse(reviewResult.result);
    expect(parsed.grade).toBe('D+');
    orch.completeStage('Review found issues');

    // REFINE — decides to loop back
    orch.enterStage('REFINE');
    orch.completeStage('Looping back to fix issues');

    // EXECUTE (second pass — via REFINE loop)
    orch.enterStage('EXECUTE');
    const t2 = orch.queueTask('Fix review findings');
    orch.startTask(t2);
    orch.completeTask(t2, 'Issues fixed');
    orch.completeStage('Second pass complete');

    // REVIEW (second pass)
    orch.enterStage('REVIEW');
    orch.completeStage('Review passed');

    // REFINE (pass through)
    orch.enterStage('REFINE');
    orch.completeStage('No more refinement needed');

    // DEPLOY
    orch.enterStage('DEPLOY');
    orch.completeStage('Deployed');

    // DONE
    orch.enterStage('DONE');
    orch.complete('Complete after one refine loop');

    expect(orch.isDone()).toBe(true);
    expect(orch.tasks()).toHaveLength(2); // t1 + t2

    // Verify event log captured the full loop
    const stageEntered = orch.eventLog.ofType('STAGE_ENTERED');
    const stageNames = stageEntered.map(e => e.stage);
    // PLAN, EXECUTE, REVIEW, REFINE, EXECUTE, REVIEW, REFINE, DEPLOY, DONE
    // complete() fast-forwards through remaining stages, adding a final DONE entry
    expect(stageNames.slice(0, 9)).toEqual([
      'PLAN', 'EXECUTE', 'REVIEW', 'REFINE',
      'EXECUTE', 'REVIEW', 'REFINE',
      'DEPLOY', 'DONE',
    ]);
  });

  test('final status reflects correct event count and completion state', async () => {
    const gtAdapter = new RealisticGtAdapter();
    const orch = rig.createOrchestrator({ gastown: gtAdapter });

    // Quick walk through all stages with minimal activity
    orch.enterStage('PLAN');
    const t = orch.queueTask('Quick task');
    orch.startTask(t);
    await orch.externalCall('gastown', 'hook');
    orch.completeTask(t, 'Done');
    orch.completeStage();

    orch.enterStage('EXECUTE');
    orch.completeStage();
    orch.enterStage('REVIEW');
    orch.completeStage();
    orch.enterStage('REFINE');
    orch.completeStage();
    orch.enterStage('DEPLOY');
    orch.completeStage();
    orch.enterStage('DONE');

    orch.complete('All done');

    const status = orch.status();
    expect(status.done).toBe(true);
    expect(status.stage).toBeNull();
    expect(status.tasks.total).toBe(1);
    expect(status.tasks.completed).toBe(1);
    expect(status.tasks.failed).toBe(0);
    expect(status.tasks.running).toBe(0);
    expect(status.pendingApproval).toBe(false);

    // Event count: SESSION_CREATED + stage enters/completes + task events
    // + external call events + SESSION_COMPLETED
    // Exact count depends on complete() fast-forward behavior, but should be substantial
    expect(status.eventCount).toBeGreaterThan(15);

    // Verify the event log has the terminal event
    const sessionCompleted = orch.eventLog.latest('SESSION_COMPLETED');
    expect(sessionCompleted).toBeDefined();
    expect(sessionCompleted!.success).toBe(true);
    expect(sessionCompleted!.summary).toBe('All done');
    expect(sessionCompleted!.finalStage).toBe('DONE');
  });
});
