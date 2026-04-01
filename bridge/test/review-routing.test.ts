/**
 * Review routing tests — decision tree for inline vs review-only polecat.
 *
 * Verifies:
 *   1. Security-sensitive paths → always review-only
 *   2. Multi-file >50 lines → review-only
 *   3. Single file ≤50 lines → inline
 *   4. isSecuritySensitivePath matches expected patterns
 *   5. sling.review adapter command construction
 *   6. Orchestrator.dispatchReview routes correctly
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
  isSecuritySensitivePath,
  routeReview,
  SECURITY_SENSITIVE_PATTERNS,
} from '../quality.js';
import { TestableGasTownAdapter } from './cli-capture.js';
import { createTestRig, type TestRig } from './test-rig.js';
import { ReviewFixtureAdapter, RecordingAdapter } from './test-adapters.js';

// --- T: Security-sensitive path detection ---

describe('isSecuritySensitivePath', () => {
  const sensitivePaths = [
    'src/auth/login.ts',
    'lib/session-manager.ts',
    'pkg/token/refresh.go',
    'src/credentials.ts',
    'internal/crypto/aes.go',
    'src/payments/stripe.ts',
    'lib/billing/checkout.ts',
    'src/middleware/auth.ts',
    'config/secrets.yaml',
    'src/oauth/callback.ts',
    'lib/jwt/verify.ts',
    'src/api-key-manager.ts',
    'internal/signing/hmac.go',
    'certs/tls-config.ts',
    '.env',
    '.env.production',
    'src/password-reset.ts',
    'lib/encrypt.ts',
    'src/decrypt-payload.ts',
    'src/access-control/rbac.ts',
    'src/permissions/check.ts',
    'ssl/certificates.pem',
  ];

  for (const p of sensitivePaths) {
    test(`detects: ${p}`, () => {
      expect(isSecuritySensitivePath(p)).toBe(true);
    });
  }

  const safePaths = [
    'src/components/Button.tsx',
    'lib/utils/format.ts',
    'test/snapshot.test.ts',
    'README.md',
    'package.json',
    'src/index.ts',
    'docs/architecture.md',
    'src/logger.ts',
    'src/database/migrations/001.sql',
    'styles/global.css',
  ];

  for (const p of safePaths) {
    test(`ignores: ${p}`, () => {
      expect(isSecuritySensitivePath(p)).toBe(false);
    });
  }
});

// --- T: Review routing decision tree ---

describe('routeReview decision tree', () => {
  test('security-sensitive single file → review-only', () => {
    const result = routeReview({
      changedFiles: ['src/auth/login.ts'],
      totalChangedLines: 10,
    });
    expect(result.mode).toBe('review-only');
    expect(result.reason).toContain('Security-sensitive');
  });

  test('security-sensitive among many files → review-only', () => {
    const result = routeReview({
      changedFiles: ['src/utils.ts', 'src/auth/session.ts', 'src/index.ts'],
      totalChangedLines: 200,
    });
    expect(result.mode).toBe('review-only');
    expect(result.reason).toContain('session.ts');
  });

  test('multi-file >50 lines (no security paths) → review-only', () => {
    const result = routeReview({
      changedFiles: ['src/a.ts', 'src/b.ts', 'src/c.ts'],
      totalChangedLines: 120,
    });
    expect(result.mode).toBe('review-only');
    expect(result.reason).toContain('3 files');
    expect(result.reason).toContain('120 lines');
  });

  test('multi-file ≤50 lines → inline', () => {
    const result = routeReview({
      changedFiles: ['src/a.ts', 'src/b.ts'],
      totalChangedLines: 30,
    });
    expect(result.mode).toBe('inline');
    expect(result.reason).toContain('under threshold');
  });

  test('single file ≤50 lines → inline', () => {
    const result = routeReview({
      changedFiles: ['src/utils.ts'],
      totalChangedLines: 25,
    });
    expect(result.mode).toBe('inline');
    expect(result.reason).toContain('Single file');
  });

  test('single file >50 lines (no security) → inline', () => {
    const result = routeReview({
      changedFiles: ['src/big-refactor.ts'],
      totalChangedLines: 200,
    });
    expect(result.mode).toBe('inline');
    expect(result.reason).toContain('Single file');
  });

  test('empty changeset → inline', () => {
    const result = routeReview({
      changedFiles: [],
      totalChangedLines: 0,
    });
    expect(result.mode).toBe('inline');
  });

  test('security-sensitive reason truncates long path lists', () => {
    const result = routeReview({
      changedFiles: [
        'src/auth/a.ts', 'src/auth/b.ts', 'src/auth/c.ts',
        'src/auth/d.ts', 'src/auth/e.ts',
      ],
      totalChangedLines: 10,
    });
    expect(result.mode).toBe('review-only');
    expect(result.reason).toContain('+2 more');
  });
});

// --- T: sling.review adapter arg construction ---

describe('sling.review adapter command', () => {
  let adapter: TestableGasTownAdapter;

  beforeEach(() => {
    adapter = new TestableGasTownAdapter();
  });

  test('sling.review with beadId and rig produces correct args', async () => {
    await adapter.execute('sling.review', {
      beadId: 'gt-t1x',
      rig: 'gastack',
    });
    const args = adapter.lastCliArgsFor('sling.review')!;

    expect(args).toContain('--review-only');
    expect(args).toContain('--formula');
    expect(args).toContain('mol-polecat-work');
    expect(args).toContain('--args');
    expect(args[2]).toBe('gt-t1x');
    expect(args[3]).toBe('gastack');
  });

  test('sling.review with agent flag', async () => {
    await adapter.execute('sling.review', {
      beadId: 'gt-t1x',
      rig: 'gastack',
      agent: 'gemini',
    });
    const args = adapter.lastCliArgsFor('sling.review')!;

    expect(args).toContain('--agent');
    const agentIdx = args.indexOf('--agent');
    expect(args[agentIdx + 1]).toBe('gemini');
    expect(args).toContain('--review-only');
  });

  test('sling.review with merge strategy', async () => {
    await adapter.execute('sling.review', {
      beadId: 'gt-t1x',
      rig: 'gastack',
      merge: 'mr',
    });
    const args = adapter.lastCliArgsFor('sling.review')!;

    expect(args).toContain('--merge');
    const mergeIdx = args.indexOf('--merge');
    expect(args[mergeIdx + 1]).toBe('mr');
  });

  test('sling.review with custom formulaArgs', async () => {
    await adapter.execute('sling.review', {
      beadId: 'gt-t1x',
      rig: 'gastack',
      formulaArgs: 'Run /review --branch feature-x only',
    });
    const args = adapter.lastCliArgsFor('sling.review')!;

    const argsIdx = args.indexOf('--args');
    expect(args[argsIdx + 1]).toBe('Run /review --branch feature-x only');
  });

  test('sling.review default formulaArgs mentions /review and /cso', async () => {
    await adapter.execute('sling.review', {
      beadId: 'gt-t1x',
      rig: 'gastack',
    });
    const args = adapter.lastCliArgsFor('sling.review')!;

    const argsIdx = args.indexOf('--args');
    const formulaArgs = args[argsIdx + 1];
    expect(formulaArgs).toContain('/review');
    expect(formulaArgs).toContain('/cso');
    expect(formulaArgs).toContain('bead');
  });

  test('sling.review with injection payload stays literal', async () => {
    await adapter.execute('sling.review', {
      beadId: '$(id)',
      rig: 'gastack; rm -rf /',
      agent: '`whoami`',
    });
    const args = adapter.lastCliArgsFor('sling.review')!;

    expect(args[2]).toBe('$(id)');
    expect(args[3]).toBe('gastack; rm -rf /');
    const agentIdx = args.indexOf('--agent');
    expect(args[agentIdx + 1]).toBe('`whoami`');
  });
});

// --- T: Orchestrator.dispatchReview routing ---

describe('Orchestrator.dispatchReview', () => {
  let rig: TestRig;

  beforeEach(() => {
    rig = createTestRig();
  });

  afterEach(() => {
    rig.cleanup();
  });

  test('routes security-sensitive change to review-only polecat', async () => {
    const gastown = new RecordingAdapter('gastown');
    const gstack = new ReviewFixtureAdapter({ reviewFixture: 'clean-review.md' });
    const orch = rig.createOrchestrator({ gastown, gstack });

    orch.enterStage('PLAN');
    orch.completeStage();
    orch.enterStage('EXECUTE');
    orch.completeStage();
    orch.enterStage('REVIEW');

    const result = await orch.dispatchReview(
      { changedFiles: ['src/auth/login.ts'], totalChangedLines: 20 },
      { beadId: 'gt-t1x', rig: 'gastack' },
    );

    expect(result.mode).toBe('review-only');
    expect(result.reason).toContain('Security-sensitive');

    // Verify gastown sling.review was called, not gstack review-suite
    expect(gastown.calls.some((c) => c.command === 'sling.review')).toBe(true);
    expect(gstack.calls.some((c) => c.command === 'review-suite')).toBe(false);
  });

  test('routes large multi-file change to review-only polecat', async () => {
    const gastown = new RecordingAdapter('gastown');
    const gstack = new ReviewFixtureAdapter({ reviewFixture: 'clean-review.md' });
    const orch = rig.createOrchestrator({ gastown, gstack });

    orch.enterStage('PLAN');
    orch.completeStage();
    orch.enterStage('EXECUTE');
    orch.completeStage();
    orch.enterStage('REVIEW');

    const result = await orch.dispatchReview(
      { changedFiles: ['src/a.ts', 'src/b.ts', 'src/c.ts'], totalChangedLines: 120 },
      { beadId: 'gt-t1x', rig: 'gastack' },
    );

    expect(result.mode).toBe('review-only');
    expect(gastown.calls.some((c) => c.command === 'sling.review')).toBe(true);
  });

  test('routes small single-file change through sling with inline mode label', async () => {
    const gastown = new RecordingAdapter('gastown');
    const gstack = new RecordingAdapter('gstack');
    const orch = rig.createOrchestrator({ gastown, gstack });

    orch.enterStage('PLAN');
    orch.completeStage();
    orch.enterStage('EXECUTE');
    orch.completeStage();
    orch.enterStage('REVIEW');

    const result = await orch.dispatchReview(
      { changedFiles: ['src/utils.ts'], totalChangedLines: 15 },
    );

    expect(result.mode).toBe('inline');

    // All review dispatch now routes through gastown sling.review with --agent
    // for proper lifecycle management (GASTOWN-BRIDGE-REVIEW.md #4)
    expect(gastown.calls.some((c) => c.command === 'sling.review')).toBe(true);
    expect(gstack.calls.some((c) => c.command === 'review-suite')).toBe(false);

    // Default agent should come from multiModelConfig.primary
    const slingCall = gastown.calls.find((c) => c.command === 'sling.review');
    expect(slingCall!.args?.agent).toBe('claude');
  });

  test('passes agent option to sling.review', async () => {
    const gastown = new RecordingAdapter('gastown');
    const gstack = new ReviewFixtureAdapter({ reviewFixture: 'clean-review.md' });
    const orch = rig.createOrchestrator({ gastown, gstack });

    orch.enterStage('PLAN');
    orch.completeStage();
    orch.enterStage('EXECUTE');
    orch.completeStage();
    orch.enterStage('REVIEW');

    await orch.dispatchReview(
      { changedFiles: ['src/auth/token.ts'], totalChangedLines: 10 },
      { beadId: 'gt-t1x', rig: 'gastack', agent: 'gemini' },
    );

    const slingCall = gastown.calls.find((c) => c.command === 'sling.review');
    expect(slingCall).toBeDefined();
    expect(slingCall!.args?.agent).toBe('gemini');
  });
});
