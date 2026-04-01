/**
 * Multi-model dispatch tests (ga-fvf).
 *
 * Verifies:
 *   1. dispatchMultiModelReview dispatches to both primary and review agents
 *   2. Secondary review always uses sling.review (separate context)
 *   3. Disagreement (PASS vs BLOCK) triggers approval request
 *   4. Agreement (both PASS) does not trigger approval
 *   5. Agent configuration is respected and overridable
 *   6. Config loading and defaults
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { createTestRig, type TestRig } from './test-rig.js';
import { RecordingAdapter, ReviewFixtureAdapter } from './test-adapters.js';
import type { ReviewSuiteResult, ReviewResult } from '../adapters/gstack.js';
import {
  loadBridgeConfig,
  mergeBridgeConfig,
  DEFAULT_MULTI_MODEL,
  DEFAULT_BRIDGE_CONFIG,
} from '../config.js';
import * as fs from 'fs';
import * as path from 'path';

// --- T: Config loading ---

describe('BridgeConfig loading', () => {
  let rig: TestRig;

  beforeEach(() => {
    rig = createTestRig();
  });

  afterEach(() => {
    rig.cleanup();
  });

  test('returns defaults when no bridge.json exists', () => {
    const config = loadBridgeConfig(rig.projectDir);
    expect(config.multiModel.enabled).toBe(true);
    expect(config.multiModel.primary).toBe('claude');
    expect(config.multiModel.review).toBe('codex');
    expect(config.multiModel.maxReviewIterations).toBe(3);
  });

  test('loads config from bridge.json', () => {
    fs.writeFileSync(
      path.join(rig.projectDir, 'bridge.json'),
      JSON.stringify({
        multiModel: {
          review: 'gemini',
          maxReviewIterations: 5,
        },
      }),
    );

    const config = loadBridgeConfig(rig.projectDir);
    expect(config.multiModel.review).toBe('gemini');
    expect(config.multiModel.maxReviewIterations).toBe(5);
    // Defaults preserved for unspecified fields
    expect(config.multiModel.primary).toBe('claude');
    expect(config.multiModel.enabled).toBe(true);
  });

  test('malformed bridge.json returns defaults', () => {
    fs.writeFileSync(
      path.join(rig.projectDir, 'bridge.json'),
      'not json {{{',
    );
    const config = loadBridgeConfig(rig.projectDir);
    expect(config).toEqual(DEFAULT_BRIDGE_CONFIG);
  });

  test('mergeBridgeConfig preserves defaults for missing fields', () => {
    const config = mergeBridgeConfig({ multiModel: { enabled: false } as any });
    expect(config.multiModel.enabled).toBe(false);
    expect(config.multiModel.primary).toBe('claude');
    expect(config.multiModel.review).toBe('codex');
  });
});

// --- T: Multi-model dispatch ---

describe('Orchestrator.dispatchMultiModelReview', () => {
  let rig: TestRig;

  beforeEach(() => {
    rig = createTestRig();
  });

  afterEach(() => {
    rig.cleanup();
  });

  /** Make a review suite JSON result. */
  function makeReviewSuiteJson(
    grade: string,
    findings: Array<{ severity: string; description: string }> = [],
  ): string {
    const review: ReviewResult = { grade, findings: findings as any, raw: `Grade: ${grade}` };
    const cso: ReviewResult = { grade: null, findings: [], raw: 'No security findings' };
    const suite: ReviewSuiteResult = { review, cso };
    return JSON.stringify(suite);
  }

  test('dispatches both primary and secondary through sling.review with --agent', async () => {
    const gastown = new RecordingAdapter('gastown', {
      commandResponses: {
        'sling.review': makeReviewSuiteJson('A'),
      },
    });
    const gstack = new RecordingAdapter('gstack');
    const orch = rig.createOrchestrator({ gastown, gstack });

    orch.enterStage('PLAN');
    orch.completeStage();
    orch.enterStage('EXECUTE');
    orch.completeStage();
    orch.enterStage('REVIEW');

    await orch.dispatchMultiModelReview(
      { changedFiles: ['src/utils.ts'], totalChangedLines: 15 },
      { beadId: 'gt-t1x', rig: 'gastack' },
    );

    // Both primary and secondary go through sling.review with --agent
    const slingCalls = gastown.calls.filter((c) => c.command === 'sling.review');
    expect(slingCalls.length).toBe(2);

    // Primary uses config.primary agent (claude by default)
    const primaryCall = slingCalls.find((c) => c.args?.agent === 'claude');
    expect(primaryCall).toBeDefined();

    // Secondary uses config.review agent (codex by default)
    const secondaryCall = slingCalls.find((c) => c.args?.agent === 'codex');
    expect(secondaryCall).toBeDefined();

    // gstack adapter is NOT used for review-suite (all through sling now)
    expect(gstack.calls.some((c) => c.command === 'review-suite')).toBe(false);
  });

  test('agreement (both PASS) does not trigger approval', async () => {
    // Both agents return passing grades; gastown handles both via sling.review
    // The adapter returns the same response for all sling.review calls, so
    // we use the same grade for both primary and secondary in this test.
    const gastown = new RecordingAdapter('gastown', {
      commandResponses: {
        'sling.review': makeReviewSuiteJson('A'),
      },
    });
    const gstack = new RecordingAdapter('gstack');
    const orch = rig.createOrchestrator({ gastown, gstack });

    orch.enterStage('PLAN');
    orch.completeStage();
    orch.enterStage('EXECUTE');
    orch.completeStage();
    orch.enterStage('REVIEW');

    const result = await orch.dispatchMultiModelReview(
      { changedFiles: ['src/utils.ts'], totalChangedLines: 15 },
      { beadId: 'gt-t1x', rig: 'gastack' },
    );

    expect(result.reconciliation.outcome).toBe('agree_pass');
    expect(result.reconciliation.disagreement).toBe(false);
    expect(result.approvalId).toBeUndefined();
    expect(orch.pendingApproval()).toBeNull();
  });

  test('disagreement (PASS vs BLOCKED) triggers human review approval', async () => {
    // Primary returns clean A, secondary returns failing D with MAJOR findings
    const passSuite = makeReviewSuiteJson('A');
    const blockSuite = makeReviewSuiteJson('D', [
      { severity: 'MAJOR', description: 'Race condition in concurrent handler' },
    ]);

    // Both go through gastown sling.review — primary first, secondary second
    const gastown = new RecordingAdapter('gastown', {
      commandSequences: {
        'sling.review': [passSuite, blockSuite],
      },
    });
    const gstack = new RecordingAdapter('gstack');
    const orch = rig.createOrchestrator({ gastown, gstack });

    orch.enterStage('PLAN');
    orch.completeStage();
    orch.enterStage('EXECUTE');
    orch.completeStage();
    orch.enterStage('REVIEW');

    const result = await orch.dispatchMultiModelReview(
      { changedFiles: ['src/utils.ts'], totalChangedLines: 15 },
      { beadId: 'gt-t1x', rig: 'gastack' },
    );

    expect(result.reconciliation.outcome).toBe('human_review');
    expect(result.reconciliation.disagreement).toBe(true);
    expect(result.approvalId).toBeDefined();

    // Approval should be pending
    const pending = orch.pendingApproval();
    expect(pending).not.toBeNull();
    expect(pending!.description).toContain('disagree');
  });

  test('respects custom agent configuration', async () => {
    const gastown = new RecordingAdapter('gastown', {
      commandResponses: {
        'sling.review': makeReviewSuiteJson('B+'),
      },
    });
    const gstack = new RecordingAdapter('gstack');
    const orch = rig.createOrchestrator({ gastown, gstack });

    orch.setMultiModelConfig({
      primary: 'claude',
      review: 'gemini',
    });

    orch.enterStage('PLAN');
    orch.completeStage();
    orch.enterStage('EXECUTE');
    orch.completeStage();
    orch.enterStage('REVIEW');

    await orch.dispatchMultiModelReview(
      { changedFiles: ['src/utils.ts'], totalChangedLines: 15 },
      { beadId: 'gt-t1x', rig: 'gastack' },
    );

    // Secondary should use gemini instead of default codex
    const slingCalls = gastown.calls.filter((c) => c.command === 'sling.review');
    const geminiCall = slingCalls.find((c) => c.args?.agent === 'gemini');
    expect(geminiCall).toBeDefined();
  });

  test('per-call agent override takes precedence over config', async () => {
    const gastown = new RecordingAdapter('gastown', {
      commandResponses: {
        'sling.review': makeReviewSuiteJson('A'),
      },
    });
    const gstack = new RecordingAdapter('gstack');
    const orch = rig.createOrchestrator({ gastown, gstack });

    // Config says codex
    orch.setMultiModelConfig({ review: 'codex' });

    orch.enterStage('PLAN');
    orch.completeStage();
    orch.enterStage('EXECUTE');
    orch.completeStage();
    orch.enterStage('REVIEW');

    // But call overrides to gemini
    await orch.dispatchMultiModelReview(
      { changedFiles: ['src/utils.ts'], totalChangedLines: 15 },
      { beadId: 'gt-t1x', rig: 'gastack', reviewAgent: 'gemini' },
    );

    const slingCalls = gastown.calls.filter((c) => c.command === 'sling.review');
    const geminiCall = slingCalls.find((c) => c.args?.agent === 'gemini');
    expect(geminiCall).toBeDefined();
    // No codex call
    const codexCall = slingCalls.find((c) => c.args?.agent === 'codex');
    expect(codexCall).toBeUndefined();
  });

  test('WARN vs PASS takes stricter without approval', async () => {
    // Primary passes with minor findings (WARN), secondary clean (PASS)
    const warnSuite: ReviewSuiteResult = {
      review: {
        grade: 'B',
        findings: [{ severity: 'MINOR', description: 'Could use const' }],
        raw: 'Grade: B\n**MINOR**: Could use const',
      },
      cso: { grade: null, findings: [], raw: 'No findings' },
    };

    const passSuite = makeReviewSuiteJson('A');

    // Primary returns WARN (B with MINOR findings), secondary returns PASS (A)
    const gastown = new RecordingAdapter('gastown', {
      commandSequences: {
        'sling.review': [JSON.stringify(warnSuite), passSuite],
      },
    });
    const gstack = new RecordingAdapter('gstack');
    const orch = rig.createOrchestrator({ gastown, gstack });

    orch.enterStage('PLAN');
    orch.completeStage();
    orch.enterStage('EXECUTE');
    orch.completeStage();
    orch.enterStage('REVIEW');

    const result = await orch.dispatchMultiModelReview(
      { changedFiles: ['src/utils.ts'], totalChangedLines: 15 },
      { beadId: 'gt-t1x', rig: 'gastack' },
    );

    expect(result.reconciliation.outcome).toBe('stricter');
    expect(result.reconciliation.finalVerdict).toBe('WARN');
    expect(result.approvalId).toBeUndefined();
  });

  test('getMultiModelConfig returns current config', () => {
    const orch = rig.createOrchestrator({});
    const config = orch.getMultiModelConfig();
    expect(config.primary).toBe('claude');
    expect(config.review).toBe('codex');
    expect(config.enabled).toBe(true);
  });

  test('setMultiModelConfig updates config', () => {
    const orch = rig.createOrchestrator({});
    orch.setMultiModelConfig({ review: 'gemini', maxReviewIterations: 5 });
    const config = orch.getMultiModelConfig();
    expect(config.review).toBe('gemini');
    expect(config.maxReviewIterations).toBe(5);
    expect(config.primary).toBe('claude'); // unchanged
  });
});
