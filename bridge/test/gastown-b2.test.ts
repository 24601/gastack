/**
 * B2 adapter and event tests — gastown integration upgrades.
 *
 * Gate tier: no network, no LLM, no gt binary required.
 *
 * Validates:
 *   1. New B2 commands construct correct CLI arg arrays
 *   2. mail.send --from flag is properly threaded
 *   3. Identity sanitization strips sensitive env vars
 *   4. New event types serialize/deserialize correctly
 *   5. Config extensions merge with defaults
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import { TestableGasTownAdapter } from './cli-capture.js';
import { EventLog, type CheckpointSaved, type RateLimitDetected, type ScopeExpansionRequested, type SpecialistGatingUpdated } from '../events.js';
import { loadBridgeConfig, mergeBridgeConfig, DEFAULT_GASTOWN, type BridgeConfig } from '../config.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// --- B2.1: New gastown adapter commands ---

describe('B2.1: convoy.watch constructs correct args', () => {
  let adapter: TestableGasTownAdapter;

  beforeEach(() => {
    adapter = new TestableGasTownAdapter();
  });

  test('convoy.watch passes convoyId and --json', async () => {
    await adapter.execute('convoy.watch', { convoyId: 'cv-abc123' });
    const args = adapter.lastCliArgsFor('convoy.watch')!;
    expect(args).toEqual(['gt', 'convoy', 'watch', 'cv-abc123', '--json']);
  });

  test('convoy.unwatch passes convoyId without --json', async () => {
    await adapter.execute('convoy.unwatch', { convoyId: 'cv-abc123' });
    const args = adapter.lastCliArgsFor('convoy.unwatch')!;
    expect(args).toEqual(['gt', 'convoy', 'unwatch', 'cv-abc123']);
  });
});

describe('B2.1: patrol.scan constructs correct args', () => {
  test('patrol.scan uses --json', async () => {
    const adapter = new TestableGasTownAdapter();
    await adapter.execute('patrol.scan');
    const args = adapter.lastCliArgsFor('patrol.scan')!;
    expect(args).toEqual(['gt', 'patrol', 'scan', '--json']);
  });
});

describe('B2.1: checkpoint commands', () => {
  let adapter: TestableGasTownAdapter;

  beforeEach(() => {
    adapter = new TestableGasTownAdapter();
  });

  test('checkpoint.write passes stage and context', async () => {
    await adapter.execute('checkpoint.write', { stage: 'REVIEW', context: 'mid-review' });
    const args = adapter.lastCliArgsFor('checkpoint.write')!;
    expect(args).toContain('--stage');
    expect(args).toContain('REVIEW');
    expect(args).toContain('--context');
    expect(args).toContain('mid-review');
    expect(args).toContain('--json');
  });

  test('checkpoint.read passes id', async () => {
    await adapter.execute('checkpoint.read', { id: 'cp-xyz789' });
    const args = adapter.lastCliArgsFor('checkpoint.read')!;
    expect(args).toEqual(['gt', 'checkpoint', 'read', 'cp-xyz789', '--json']);
  });
});

describe('B2.1: bead.list uses --flat for beads v0.62', () => {
  test('bead.list includes --json --flat flags', async () => {
    const adapter = new TestableGasTownAdapter();
    await adapter.execute('bead.list', { status: 'open', rig: 'myrig' });
    const args = adapter.lastCliArgsFor('bead.list')!;
    expect(args).toContain('--json');
    expect(args).toContain('--flat');
    expect(args).toContain('--status');
    expect(args).toContain('open');
    expect(args).toContain('--rig');
    expect(args).toContain('myrig');
    // Uses bd, not gt
    expect(args[0]).toBe('bd');
  });
});

// --- B2.2: mail.send --from flag ---

describe('B2.2: mail.send --from flag', () => {
  test('mail.send includes --from when provided', async () => {
    const adapter = new TestableGasTownAdapter();
    await adapter.execute('mail.send', {
      target: 'gastack/witness',
      subject: 'Bridge update',
      body: 'Convoy dispatched',
      from: 'gastack/bridge/orchestrator',
    });
    const args = adapter.lastCliArgsFor('mail.send')!;
    expect(args).toContain('--from');
    expect(args).toContain('gastack/bridge/orchestrator');
  });

  test('mail.send omits --from when not provided', async () => {
    const adapter = new TestableGasTownAdapter();
    await adapter.execute('mail.send', {
      target: 'gastack/witness',
      subject: 'Test',
      body: 'No from',
    });
    const args = adapter.lastCliArgsFor('mail.send')!;
    expect(args).not.toContain('--from');
  });
});

// --- B2.3: Identity sanitization ---

describe('B2.3: Identity sanitization', () => {
  // We can't test the actual env filtering without spawning processes,
  // but we can verify the sanitizedEnv function exists and works by
  // importing it. Since it's not exported, we test it indirectly via
  // the adapter's behavior — the key invariant is that gtExec and bdExec
  // call sanitizedEnv() instead of { ...process.env }.

  test('sanitized env vars list covers known identity vars', () => {
    // This is a documentation test — ensures the list is comprehensive
    const knownIdentityVars = [
      'CLAUDE_IDENTITY',
      'CODEX_IDENTITY',
      'GEMINI_IDENTITY',
      'ANTHROPIC_API_KEY',
      'OPENAI_API_KEY',
      'GT_TOKEN',
    ];

    // Read the source to verify the constant exists with these values
    const source = fs.readFileSync(
      path.join(import.meta.dir, '../adapters/gastown.ts'),
      'utf-8',
    );

    for (const varName of knownIdentityVars) {
      expect(source).toContain(varName);
    }

    // Verify sanitizedEnv() is called in gtExec and bdExec
    expect(source).toContain('env: sanitizedEnv()');
    // Ensure old pattern is gone
    expect(source).not.toContain('env: { ...process.env }');
  });
});

// --- B2.4: New event types ---

describe('B2.4: New B2 event types', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-b2-events-'));
  });

  test('CheckpointSaved event round-trips through EventLog', () => {
    const log = new EventLog(tmpDir, 'test-checkpoint');
    const event: CheckpointSaved = {
      type: 'CHECKPOINT_SAVED',
      checkpointId: 'cp-abc123',
      stage: 'REVIEW',
    };

    const envelope = log.append(event);
    expect(envelope.event.type).toBe('CHECKPOINT_SAVED');

    const loaded = EventLog.load(log.path);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].event).toEqual(event);
  });

  test('RateLimitDetected event round-trips through EventLog', () => {
    const log = new EventLog(tmpDir, 'test-ratelimit');
    const event: RateLimitDetected = {
      type: 'RATE_LIMIT_DETECTED',
      source: 'rate-limit-watchdog',
      action: 'halt',
    };

    const envelope = log.append(event);
    expect(envelope.event.type).toBe('RATE_LIMIT_DETECTED');

    const loaded = EventLog.load(log.path);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].event).toEqual(event);
  });

  test('ScopeExpansionRequested event round-trips through EventLog', () => {
    const log = new EventLog(tmpDir, 'test-scope');
    const event: ScopeExpansionRequested = {
      type: 'SCOPE_EXPANSION_REQUESTED',
      beadId: 'gt-xyz789',
      description: 'Need to also update the API docs',
    };

    const envelope = log.append(event);
    expect(envelope.event.type).toBe('SCOPE_EXPANSION_REQUESTED');

    const loaded = EventLog.load(log.path);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].event).toEqual(event);
  });

  test('SpecialistGatingUpdated event round-trips through EventLog', () => {
    const log = new EventLog(tmpDir, 'test-gating');
    const event: SpecialistGatingUpdated = {
      type: 'SPECIALIST_GATING_UPDATED',
      gatingState: {
        performance: { runs: 12, gated: true },
        security: { runs: 12, gated: false },
      },
    };

    const envelope = log.append(event);
    expect(envelope.event.type).toBe('SPECIALIST_GATING_UPDATED');

    const loaded = EventLog.load(log.path);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].event).toEqual(event);
  });

  test('B2 events coexist with B1 events in same log', () => {
    const log = new EventLog(tmpDir, 'test-mixed');

    // B1 event
    log.append({
      type: 'SESSION_CREATED',
      sessionId: 'sess-1',
      projectDir: '/tmp/test',
      config: {},
    });

    // B2 event
    log.append({
      type: 'CHECKPOINT_SAVED',
      checkpointId: 'cp-1',
      stage: 'EXECUTE',
    });

    // Another B1 event
    log.append({
      type: 'STAGE_ENTERED',
      stage: 'EXECUTE',
    });

    // Another B2 event
    log.append({
      type: 'RATE_LIMIT_DETECTED',
      source: 'watchdog',
      action: 'halt',
    });

    const loaded = EventLog.load(log.path);
    expect(loaded).toHaveLength(4);
    expect(loaded[0].event.type).toBe('SESSION_CREATED');
    expect(loaded[1].event.type).toBe('CHECKPOINT_SAVED');
    expect(loaded[2].event.type).toBe('STAGE_ENTERED');
    expect(loaded[3].event.type).toBe('RATE_LIMIT_DETECTED');
  });
});

// --- B2.5: Config extensions ---

describe('B2.5: GasTownConfig merges with defaults', () => {
  test('empty partial uses all defaults', () => {
    const config = mergeBridgeConfig({});
    expect(config.gastown).toEqual(DEFAULT_GASTOWN);
  });

  test('partial gastown overrides specific fields', () => {
    const config = mergeBridgeConfig({
      gastown: {
        effortIdle: 'full',
        useConvoyWatch: false,
        requireReview: { myrig: true },
        scopeExpansionApproval: false,
        preVerifiedMerge: false,
      },
    });
    expect(config.gastown.effortIdle).toBe('full');
    expect(config.gastown.useConvoyWatch).toBe(false);
    expect(config.gastown.requireReview).toEqual({ myrig: true });
    expect(config.gastown.scopeExpansionApproval).toBe(false);
    expect(config.gastown.preVerifiedMerge).toBe(false);
    // multiModel should still have defaults
    expect(config.multiModel.primary).toBe('claude');
  });

  test('loadBridgeConfig returns defaults for missing file', () => {
    const config = loadBridgeConfig('/nonexistent/path');
    expect(config.gastown).toEqual(DEFAULT_GASTOWN);
    expect(config.multiModel.enabled).toBe(true);
  });

  test('default gastown config has cost-optimized values', () => {
    expect(DEFAULT_GASTOWN.effortIdle).toBe('abbreviated');
    expect(DEFAULT_GASTOWN.useConvoyWatch).toBe(true);
    expect(DEFAULT_GASTOWN.preVerifiedMerge).toBe(true);
    expect(DEFAULT_GASTOWN.scopeExpansionApproval).toBe(true);
  });
});
