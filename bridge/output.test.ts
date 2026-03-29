/**
 * Tests for the output adapter — adaptive output calibration.
 *
 * Unit tests cover:
 *   - calibrate: heuristic progression, adjustments, CLI overrides
 *   - readSignals: filesystem signal reading
 *   - incrementRunCount: counter persistence
 *   - OutputAdapter: command routing, caching, flag overrides
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  calibrate,
  readSignals,
  incrementRunCount,
  OutputAdapter,
  PROFILES,
  type UserSignals,
  type OutputFlags,
  type OutputProfile,
  type DetailLevel,
  type StyleLevel,
} from './output.js';

// --- Test helpers ---

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'output-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function baseSignals(overrides?: Partial<UserSignals>): UserSignals {
  return {
    runCount: 0,
    hasMemory: false,
    sessionCount: 0,
    feedbackCount: 0,
    ...overrides,
  };
}

// --- PROFILES constant ---

describe('PROFILES', () => {
  test('contains exactly 9 variants', () => {
    expect(PROFILES).toHaveLength(9);
  });

  test('covers all detail × style combinations', () => {
    const details: DetailLevel[] = ['minimal', 'standard', 'detailed'];
    const styles: StyleLevel[] = ['terse', 'balanced', 'expressive'];
    for (const detail of details) {
      for (const style of styles) {
        const found = PROFILES.find((p) => p.detail === detail && p.style === style);
        expect(found).toBeDefined();
      }
    }
  });
});

// --- calibrate: heuristic baseline ---

describe('calibrate — heuristic baseline', () => {
  test('new user (runCount 0) gets detailed + expressive', () => {
    const profile = calibrate(baseSignals({ runCount: 0 }));
    expect(profile.detail).toBe('detailed');
    expect(profile.style).toBe('expressive');
  });

  test('new user (runCount 2) still gets detailed + expressive', () => {
    const profile = calibrate(baseSignals({ runCount: 2 }));
    expect(profile.detail).toBe('detailed');
    expect(profile.style).toBe('expressive');
  });

  test('early user (runCount 3) gets standard + balanced', () => {
    const profile = calibrate(baseSignals({ runCount: 3 }));
    expect(profile.detail).toBe('standard');
    expect(profile.style).toBe('balanced');
  });

  test('early user (runCount 9) still gets standard + balanced', () => {
    const profile = calibrate(baseSignals({ runCount: 9 }));
    expect(profile.detail).toBe('standard');
    expect(profile.style).toBe('balanced');
  });

  test('experienced user (runCount 10) gets minimal + terse', () => {
    const profile = calibrate(baseSignals({ runCount: 10 }));
    expect(profile.detail).toBe('minimal');
    expect(profile.style).toBe('terse');
  });

  test('experienced user (runCount 100) gets minimal + terse', () => {
    const profile = calibrate(baseSignals({ runCount: 100 }));
    expect(profile.detail).toBe('minimal');
    expect(profile.style).toBe('terse');
  });
});

// --- calibrate: adjustments ---

describe('calibrate — adjustments', () => {
  test('feedback investment bumps detail up one level', () => {
    // Experienced user would be minimal, but feedback bumps to standard
    const profile = calibrate(baseSignals({ runCount: 50, feedbackCount: 5 }));
    expect(profile.detail).toBe('standard');
  });

  test('feedback bumps standard to detailed', () => {
    const profile = calibrate(baseSignals({ runCount: 5, feedbackCount: 3 }));
    expect(profile.detail).toBe('detailed');
  });

  test('feedback does not bump beyond detailed', () => {
    const profile = calibrate(baseSignals({ runCount: 0, feedbackCount: 10 }));
    expect(profile.detail).toBe('detailed');
  });

  test('fewer than 3 feedback entries does not bump', () => {
    const profile = calibrate(baseSignals({ runCount: 50, feedbackCount: 2 }));
    expect(profile.detail).toBe('minimal');
  });

  test('memory presence pulls style toward balanced', () => {
    // New user would be expressive, but memory pulls to balanced
    const profile = calibrate(baseSignals({ runCount: 0, hasMemory: true }));
    expect(profile.style).toBe('balanced');
  });

  test('memory pulls terse to balanced', () => {
    const profile = calibrate(baseSignals({ runCount: 50, hasMemory: true }));
    expect(profile.style).toBe('balanced');
  });

  test('memory does not change already-balanced style', () => {
    const profile = calibrate(baseSignals({ runCount: 5, hasMemory: true }));
    expect(profile.style).toBe('balanced');
  });
});

// --- calibrate: explicit preferences ---

describe('calibrate — explicit preferences', () => {
  test('preferredDetail overrides heuristic', () => {
    const profile = calibrate(baseSignals({
      runCount: 0,
      preferredDetail: 'minimal',
    }));
    expect(profile.detail).toBe('minimal');
  });

  test('preferredStyle overrides heuristic', () => {
    const profile = calibrate(baseSignals({
      runCount: 50,
      preferredStyle: 'expressive',
    }));
    expect(profile.style).toBe('expressive');
  });

  test('both preferences override together', () => {
    const profile = calibrate(baseSignals({
      runCount: 5,
      preferredDetail: 'detailed',
      preferredStyle: 'terse',
    }));
    expect(profile.detail).toBe('detailed');
    expect(profile.style).toBe('terse');
  });
});

// --- calibrate: CLI flag overrides ---

describe('calibrate — CLI flags', () => {
  test('--verbose overrides to detailed + expressive', () => {
    const profile = calibrate(
      baseSignals({ runCount: 100 }),
      { verbose: true },
    );
    expect(profile.detail).toBe('detailed');
    expect(profile.style).toBe('expressive');
  });

  test('--quiet overrides to minimal + terse', () => {
    const profile = calibrate(
      baseSignals({ runCount: 0 }),
      { quiet: true },
    );
    expect(profile.detail).toBe('minimal');
    expect(profile.style).toBe('terse');
  });

  test('--verbose takes precedence over --quiet', () => {
    const profile = calibrate(
      baseSignals(),
      { verbose: true, quiet: true },
    );
    expect(profile.detail).toBe('detailed');
    expect(profile.style).toBe('expressive');
  });

  test('--verbose ignores explicit preferences', () => {
    const profile = calibrate(
      baseSignals({ preferredDetail: 'minimal', preferredStyle: 'terse' }),
      { verbose: true },
    );
    expect(profile.detail).toBe('detailed');
    expect(profile.style).toBe('expressive');
  });

  test('no flags does not override', () => {
    const profile = calibrate(baseSignals({ runCount: 5 }), {});
    expect(profile.detail).toBe('standard');
    expect(profile.style).toBe('balanced');
  });
});

// --- readSignals ---

describe('readSignals', () => {
  test('returns zeros for empty project', async () => {
    const signals = await readSignals({ projectDir: tmpDir });
    expect(signals.runCount).toBe(0);
    expect(signals.hasMemory).toBe(false);
    expect(signals.sessionCount).toBe(0);
    expect(signals.feedbackCount).toBe(0);
  });

  test('reads run count from state file', async () => {
    const stateDir = path.join(tmpDir, '.bridge', 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'run-count'), '42');

    const signals = await readSignals({ projectDir: tmpDir });
    expect(signals.runCount).toBe(42);
  });

  test('detects memory files', async () => {
    const memDir = path.join(tmpDir, 'memory');
    fs.mkdirSync(memDir, { recursive: true });
    fs.writeFileSync(path.join(memDir, 'user_role.md'), '---\nname: role\n---\n');
    fs.writeFileSync(path.join(memDir, 'MEMORY.md'), '# index');

    const signals = await readSignals({ projectDir: tmpDir, memoryDir: memDir });
    expect(signals.hasMemory).toBe(true);
  });

  test('MEMORY.md alone does not count as memory', async () => {
    const memDir = path.join(tmpDir, 'memory');
    fs.mkdirSync(memDir, { recursive: true });
    fs.writeFileSync(path.join(memDir, 'MEMORY.md'), '# index');

    const signals = await readSignals({ projectDir: tmpDir, memoryDir: memDir });
    expect(signals.hasMemory).toBe(false);
  });

  test('counts session log files', async () => {
    const sessDir = path.join(tmpDir, 'sessions');
    fs.mkdirSync(sessDir, { recursive: true });
    fs.writeFileSync(path.join(sessDir, 'a.jsonl'), '{}');
    fs.writeFileSync(path.join(sessDir, 'b.jsonl'), '{}');
    fs.writeFileSync(path.join(sessDir, 'c.txt'), 'not a log');

    const signals = await readSignals({ projectDir: tmpDir, sessionDir: sessDir });
    expect(signals.sessionCount).toBe(2);
  });

  test('counts feedback files', async () => {
    const fbDir = path.join(tmpDir, 'feedback');
    fs.mkdirSync(fbDir, { recursive: true });
    fs.writeFileSync(path.join(fbDir, 'fb1.md'), 'some feedback');
    fs.writeFileSync(path.join(fbDir, 'fb2.md'), 'more feedback');

    const signals = await readSignals({ projectDir: tmpDir, feedbackDir: fbDir });
    expect(signals.feedbackCount).toBe(2);
  });

  test('extracts preferred detail from feedback', async () => {
    const fbDir = path.join(tmpDir, 'feedback');
    fs.mkdirSync(fbDir, { recursive: true });
    fs.writeFileSync(path.join(fbDir, 'prefs.md'), 'preferred_detail: minimal\npreferred_style: terse');

    const signals = await readSignals({ projectDir: tmpDir, feedbackDir: fbDir });
    expect(signals.preferredDetail).toBe('minimal');
    expect(signals.preferredStyle).toBe('terse');
  });

  test('handles missing directories gracefully', async () => {
    const signals = await readSignals({
      projectDir: tmpDir,
      memoryDir: '/nonexistent/memory',
      sessionDir: '/nonexistent/sessions',
      feedbackDir: '/nonexistent/feedback',
    });
    expect(signals.runCount).toBe(0);
    expect(signals.hasMemory).toBe(false);
    expect(signals.sessionCount).toBe(0);
    expect(signals.feedbackCount).toBe(0);
  });
});

// --- incrementRunCount ---

describe('incrementRunCount', () => {
  test('starts at 1 on first call', async () => {
    const count = await incrementRunCount(tmpDir);
    expect(count).toBe(1);
  });

  test('increments on subsequent calls', async () => {
    await incrementRunCount(tmpDir);
    await incrementRunCount(tmpDir);
    const count = await incrementRunCount(tmpDir);
    expect(count).toBe(3);
  });

  test('creates state directory if missing', async () => {
    const projectDir = path.join(tmpDir, 'nested', 'project');
    const count = await incrementRunCount(projectDir);
    expect(count).toBe(1);
    expect(fs.existsSync(path.join(projectDir, '.bridge', 'state', 'run-count'))).toBe(true);
  });
});

// --- OutputAdapter ---

describe('OutputAdapter', () => {
  test('implements Adapter interface', () => {
    const adapter = new OutputAdapter({ projectDir: tmpDir });
    expect(adapter.name).toBe('output');
    expect(typeof adapter.execute).toBe('function');
  });

  test('calibrate returns profile and signals', async () => {
    const adapter = new OutputAdapter({ projectDir: tmpDir });
    const result = JSON.parse(await adapter.execute('calibrate'));
    expect(result.profile).toBeDefined();
    expect(result.profile.detail).toBeDefined();
    expect(result.profile.style).toBeDefined();
    expect(result.signals).toBeDefined();
    expect(result.signals.runCount).toBe(0);
  });

  test('calibrate with verbose flag', async () => {
    const adapter = new OutputAdapter({ projectDir: tmpDir, flags: { verbose: true } });
    const result = JSON.parse(await adapter.execute('calibrate'));
    expect(result.profile.detail).toBe('detailed');
    expect(result.profile.style).toBe('expressive');
  });

  test('calibrate with quiet flag', async () => {
    const adapter = new OutputAdapter({ projectDir: tmpDir, flags: { quiet: true } });
    const result = JSON.parse(await adapter.execute('calibrate'));
    expect(result.profile.detail).toBe('minimal');
    expect(result.profile.style).toBe('terse');
  });

  test('calibrate with per-call verbose arg', async () => {
    const adapter = new OutputAdapter({ projectDir: tmpDir });
    const result = JSON.parse(await adapter.execute('calibrate', { verbose: true }));
    expect(result.profile.detail).toBe('detailed');
    expect(result.profile.style).toBe('expressive');
  });

  test('profile returns default when no calibration done', async () => {
    const adapter = new OutputAdapter({ projectDir: tmpDir });
    const result = JSON.parse(await adapter.execute('profile'));
    expect(result.profile.detail).toBe('standard');
    expect(result.profile.style).toBe('balanced');
  });

  test('profile returns last calibrated profile', async () => {
    const adapter = new OutputAdapter({ projectDir: tmpDir, flags: { quiet: true } });
    await adapter.execute('calibrate');
    const result = JSON.parse(await adapter.execute('profile'));
    expect(result.profile.detail).toBe('minimal');
    expect(result.profile.style).toBe('terse');
  });

  test('override updates flags and re-calibrates', async () => {
    const adapter = new OutputAdapter({ projectDir: tmpDir });
    const result = JSON.parse(
      await adapter.execute('override', { verbose: true }),
    );
    expect(result.flags.verbose).toBe(true);
    expect(result.profile.detail).toBe('detailed');
    expect(result.profile.style).toBe('expressive');
  });

  test('increment bumps run counter', async () => {
    const adapter = new OutputAdapter({ projectDir: tmpDir });
    const r1 = JSON.parse(await adapter.execute('increment'));
    expect(r1.runCount).toBe(1);
    const r2 = JSON.parse(await adapter.execute('increment'));
    expect(r2.runCount).toBe(2);
  });

  test('unknown command throws', async () => {
    const adapter = new OutputAdapter({ projectDir: tmpDir });
    await expect(adapter.execute('nonexistent')).rejects.toThrow(
      'Unknown output command',
    );
  });

  test('integrates with orchestrator as adapter', async () => {
    const adapter = new OutputAdapter({ projectDir: tmpDir });
    expect(adapter.name).toBe('output');
    const result = await adapter.execute('calibrate');
    expect(typeof result).toBe('string');
    const parsed = JSON.parse(result);
    expect(parsed.profile).toBeDefined();
  });
});
