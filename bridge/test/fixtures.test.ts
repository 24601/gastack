/**
 * Tests for fixture infrastructure — validates that all fixtures load,
 * parse correctly, and that test helpers work as expected.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { createTestRig, type TestRig } from './test-rig.js';
import { RealisticGtAdapter, ReviewFixtureAdapter, RecordingAdapter } from './test-adapters.js';
import { TestableGasTownAdapter } from './cli-capture.js';
import { EventLog } from '../events.js';
import { Orchestrator } from '../orchestrate.js';
import { parseReviewOutput, parseGrade, parseFindings } from '../adapters/gstack.js';

let rig: TestRig;

beforeEach(() => {
  rig = createTestRig();
});

afterEach(() => {
  rig.cleanup();
});

// --- Test Rig ---

describe('TestRig', () => {
  test('creates isolated directories', () => {
    expect(rig.rootDir).toContain('bridge-test-');
    expect(rig.logDir).toContain('logs');
    expect(rig.projectDir).toContain('project');
  });

  test('createOrchestrator returns a working instance', () => {
    const orch = rig.createOrchestrator();
    expect(orch.id).toBeTruthy();
    expect(orch.status().done).toBe(false);
  });

  test('readFixture loads design doc', () => {
    const doc = rig.readFixture('design-docs', 'standard.md');
    expect(doc).toContain('## Tasks');
    expect(doc).toContain('Wire review-suite adapter command');
  });

  test('readFixtureJson loads gt CLI output', () => {
    const hook = rig.readFixtureJson<{ hooked: boolean }>('gt-cli-outputs', 'hook-response.json');
    expect(hook.hooked).toBe(true);
    expect(hook.bead_id).toBe('ga-b04');
  });

  test('readFixture throws on missing fixture', () => {
    expect(() => rig.readFixture('design-docs', 'nonexistent.md')).toThrow('Fixture not found');
  });

  test('loadEventLog copies fixture to log dir', () => {
    const logPath = rig.loadEventLog('mid-execute.jsonl');
    const events = EventLog.load(logPath);
    expect(events.length).toBeGreaterThan(0);
    expect(events[0].event.type).toBe('SESSION_CREATED');
  });
});

// --- Design Doc Fixtures ---

describe('Design doc fixtures', () => {
  test('standard.md has 3 tasks with acceptance criteria', () => {
    const doc = rig.readFixture('design-docs', 'standard.md');
    const taskMatches = doc.match(/^### \d+\./gm);
    expect(taskMatches).toHaveLength(3);
    expect(doc).toContain('Acceptance criteria');
    expect(doc).toContain('Next Steps');
  });

  test('no-nextsteps.md has tasks but no next steps', () => {
    const doc = rig.readFixture('design-docs', 'no-nextsteps.md');
    const taskMatches = doc.match(/^### \d+\./gm);
    expect(taskMatches).toHaveLength(2);
    expect(doc).not.toContain('Next Steps');
  });

  test('injection.md has shell metacharacters in task titles', () => {
    const doc = rig.readFixture('design-docs', 'injection.md');
    expect(doc).toContain('$(whoami)');
    expect(doc).toContain('; rm -rf /');
    expect(doc).toContain('`cat /etc/passwd`');
  });

  test('empty.md has no tasks section', () => {
    const doc = rig.readFixture('design-docs', 'empty.md');
    expect(doc).not.toMatch(/^### \d+\./m);
    expect(doc).toContain('no tasks section');
  });
});

// --- Review Output Fixtures ---

describe('Review output fixtures', () => {
  test('clean-review.md parses to grade A-', () => {
    const raw = rig.readFixture('review-outputs', 'clean-review.md');
    const result = parseReviewOutput(raw);
    expect(result.grade).toBe('A-');
    expect(result.findings).toHaveLength(0);
  });

  test('high-security.md parses to grade D with CRITICAL findings', () => {
    const raw = rig.readFixture('review-outputs', 'high-security.md');
    const result = parseReviewOutput(raw);
    expect(result.grade).toBe('D');
    const criticals = result.findings.filter((f) => f.severity === 'CRITICAL');
    expect(criticals.length).toBeGreaterThanOrEqual(2);
  });

  test('medium-correctness.md parses to grade D+ with MAJOR finding', () => {
    const raw = rig.readFixture('review-outputs', 'medium-correctness.md');
    const result = parseReviewOutput(raw);
    expect(result.grade).toBe('D+');
    const majors = result.findings.filter((f) => f.severity === 'MAJOR');
    expect(majors.length).toBeGreaterThanOrEqual(1);
  });

  test('low-design.md parses to grade B+ with MINOR findings only', () => {
    const raw = rig.readFixture('review-outputs', 'low-design.md');
    const result = parseReviewOutput(raw);
    expect(result.grade).toBe('B+');
    expect(result.findings.every((f) => f.severity === 'MINOR')).toBe(true);
  });

  test('mixed-signals.md has CRITICAL + MINOR findings', () => {
    const raw = rig.readFixture('review-outputs', 'mixed-signals.md');
    const result = parseReviewOutput(raw);
    expect(result.grade).toBe('C-');
    const criticals = result.findings.filter((f) => f.severity === 'CRITICAL');
    const minors = result.findings.filter((f) => f.severity === 'MINOR');
    expect(criticals.length).toBeGreaterThanOrEqual(1);
    expect(minors.length).toBeGreaterThanOrEqual(1);
  });

  test('multiple-medium.md has multiple MAJOR findings', () => {
    const raw = rig.readFixture('review-outputs', 'multiple-medium.md');
    const result = parseReviewOutput(raw);
    expect(result.grade).toBe('C');
    const majors = result.findings.filter((f) => f.severity === 'MAJOR');
    expect(majors.length).toBeGreaterThanOrEqual(2);
  });
});

// --- Event Log Fixtures ---

describe('Event log fixtures', () => {
  test('mid-execute.jsonl resumes to EXECUTE stage with running task', () => {
    const logPath = rig.loadEventLog('mid-execute.jsonl');
    const orch = Orchestrator.resume(logPath);
    expect(orch.status().stage).toBe('EXECUTE');

    const tasks = orch.tasks();
    const running = tasks.filter((t) => t.status === 'running');
    expect(running.length).toBe(1);
    expect(running[0].taskId).toBe('t3');
  });

  test('pending-approval.jsonl has undecided approval', () => {
    const logPath = rig.loadEventLog('pending-approval.jsonl');
    const orch = Orchestrator.resume(logPath);
    const pending = orch.pendingApproval();
    expect(pending).not.toBeNull();
    expect(pending!.approvalId).toBe('apr-001');
    expect(pending!.stage).toBe('REVIEW');
  });

  test('refine-loop.jsonl shows REFINE→EXECUTE loop', () => {
    const logPath = rig.loadEventLog('refine-loop.jsonl');
    const orch = Orchestrator.resume(logPath);
    // Should be in DEPLOY after the refine loop
    expect(orch.status().stage).toBe('DEPLOY');
  });

  test('corrupted.jsonl loads with graceful degradation', () => {
    const logPath = rig.loadEventLog('corrupted.jsonl');
    const result = EventLog.load(logPath, { diagnostics: true });
    // Should recover some valid events and report diagnostics
    expect(result.envelopes.length).toBeGreaterThan(0);
    expect(result.diagnostics.length).toBeGreaterThan(0);
  });
});

// --- GT CLI Output Fixtures ---

describe('GT CLI output fixtures', () => {
  test('hook-response.json has expected structure', () => {
    const hook = rig.readFixtureJson<{
      hooked: boolean;
      bead_id: string;
      molecule: { id: string; formula: string };
    }>('gt-cli-outputs', 'hook-response.json');
    expect(hook.hooked).toBe(true);
    expect(hook.bead_id).toBeTruthy();
    expect(hook.molecule.formula).toBe('mol-polecat-work');
  });

  test('mol-status.json has progress tracking', () => {
    const mol = rig.readFixtureJson<{
      steps_total: number;
      steps_completed: number;
      current_step: number;
    }>('gt-cli-outputs', 'mol-status.json');
    expect(mol.steps_total).toBe(8);
    expect(mol.steps_completed).toBeLessThan(mol.steps_total);
    expect(mol.current_step).toBeGreaterThan(0);
  });

  test('mail-inbox.json has messages with expected fields', () => {
    const inbox = rig.readFixtureJson<{
      messages: Array<{ id: string; from: string; subject: string }>;
      count: number;
      unread: number;
    }>('gt-cli-outputs', 'mail-inbox.json');
    expect(inbox.count).toBe(2);
    expect(inbox.unread).toBe(1);
    expect(inbox.messages[0].from).toContain('witness');
  });
});

// --- Test Adapters ---

describe('RealisticGtAdapter', () => {
  test('returns fixture responses for known commands', async () => {
    const adapter = new RealisticGtAdapter();
    const hookResult = await adapter.execute('hook');
    const parsed = JSON.parse(hookResult);
    expect(parsed.hooked).toBe(true);
  });

  test('records calls for assertion', async () => {
    const adapter = new RealisticGtAdapter();
    await adapter.execute('hook');
    await adapter.execute('mol.status');
    expect(adapter.calls).toHaveLength(2);
    expect(adapter.callsFor('hook')).toHaveLength(1);
  });

  test('throws on unknown commands', async () => {
    const adapter = new RealisticGtAdapter();
    await expect(adapter.execute('unknown-cmd')).rejects.toThrow('no fixture');
  });

  test('supports runtime response overrides', async () => {
    const adapter = new RealisticGtAdapter();
    adapter.setResponse('hook', '{"hooked":false}');
    const result = JSON.parse(await adapter.execute('hook'));
    expect(result.hooked).toBe(false);
  });
});

describe('ReviewFixtureAdapter', () => {
  test('returns parsed review output for review command', async () => {
    const adapter = new ReviewFixtureAdapter({ reviewFixture: 'clean-review.md' });
    const result = JSON.parse(await adapter.execute('review'));
    expect(result.grade).toBe('A-');
  });

  test('returns combined suite for review-suite command', async () => {
    const adapter = new ReviewFixtureAdapter({
      reviewFixture: 'clean-review.md',
      csoFixture: 'high-security.md',
    });
    const result = JSON.parse(await adapter.execute('review-suite'));
    expect(result.review.grade).toBe('A-');
    expect(result.cso.grade).toBe('D');
  });

  test('records calls', async () => {
    const adapter = new ReviewFixtureAdapter({ reviewFixture: 'clean-review.md' });
    await adapter.execute('review', { branch: 'main' });
    expect(adapter.calls).toHaveLength(1);
    expect(adapter.calls[0].args).toEqual({ branch: 'main' });
  });
});

describe('RecordingAdapter', () => {
  test('records all calls with args', async () => {
    const adapter = new RecordingAdapter('test');
    await adapter.execute('foo', { bar: 'baz' });
    await adapter.execute('qux');
    expect(adapter.calls).toHaveLength(2);
    expect(adapter.lastCall?.command).toBe('qux');
    expect(adapter.argsFor('foo')).toEqual([{ bar: 'baz' }]);
  });

  test('returns configurable responses', async () => {
    const adapter = new RecordingAdapter('test', {
      commandResponses: { hello: '"world"' },
      defaultResponse: '"default"',
    });
    expect(await adapter.execute('hello')).toBe('"world"');
    expect(await adapter.execute('other')).toBe('"default"');
  });

  test('reset clears calls', async () => {
    const adapter = new RecordingAdapter('test');
    await adapter.execute('a');
    adapter.reset();
    expect(adapter.calls).toHaveLength(0);
  });
});

// --- CLI Capture ---

describe('TestableGasTownAdapter', () => {
  test('captures hook command args', async () => {
    const adapter = new TestableGasTownAdapter();
    await adapter.execute('hook');
    const args = adapter.lastCliArgsFor('hook');
    expect(args).toEqual(['gt', 'hook', '--json']);
  });

  test('captures mail.send args as array (no shell interpolation)', async () => {
    const adapter = new TestableGasTownAdapter();
    await adapter.execute('mail.send', {
      target: 'gastack/witness',
      subject: 'HELP: $(whoami)',
      body: 'test; rm -rf /',
    });
    const args = adapter.lastCliArgsFor('mail.send');
    expect(args).toEqual([
      'gt', 'mail', 'send', 'gastack/witness',
      '-s', 'HELP: $(whoami)',
      '-m', 'test; rm -rf /',
    ]);
    // Critical: shell metacharacters are literal array elements, not interpolated
    expect(args![5]).toBe('HELP: $(whoami)');
    expect(args![7]).toBe('test; rm -rf /');
  });

  test('captures done command with flags', async () => {
    const adapter = new TestableGasTownAdapter();
    await adapter.execute('done', { preVerified: true, target: 'main' });
    const args = adapter.lastCliArgsFor('done');
    expect(args).toContain('--pre-verified');
    expect(args).toContain('--target');
    expect(args).toContain('main');
  });

  test('captures escalate with severity', async () => {
    const adapter = new TestableGasTownAdapter();
    await adapter.execute('escalate', {
      description: 'Test problem',
      severity: 'HIGH',
      message: 'Details here',
    });
    const args = adapter.lastCliArgsFor('escalate');
    expect(args).toEqual([
      'gt', 'escalate', 'Test problem',
      '-s', 'HIGH',
      '-m', 'Details here',
    ]);
  });

  test('invocationsFor filters by command', async () => {
    const adapter = new TestableGasTownAdapter();
    await adapter.execute('hook');
    await adapter.execute('mail.inbox');
    await adapter.execute('hook');
    expect(adapter.invocationsFor('hook')).toHaveLength(2);
    expect(adapter.invocationsFor('mail.inbox')).toHaveLength(1);
  });
});
