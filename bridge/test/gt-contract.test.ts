/**
 * GT CLI contract tests — verify adapter assumptions against real gt.
 *
 * These tests require:
 *   - `gt` on PATH (real Gas Town CLI)
 *   - `bd` on PATH (real Beads CLI)
 *   - Dolt server running (for bd create/close)
 *   - ~/gt/.events.jsonl to exist (for EventTailer)
 *
 * Periodic tier: run via `EVALS_TIER=periodic bun test` or manually.
 * NOT run on every commit — these catch gt version drift and format changes.
 *
 * Contract surface (from GasTownAdapter):
 *   T1.1 — gt hook --json returns parseable JSON with expected keys
 *   T1.2 — gt mol status --json returns parseable JSON with expected keys
 *   T1.3 — gt mail inbox --json returns parseable JSON (array or object)
 *   T1.4 — bd create returns a bead ID, bd close cleans it up
 *   T1.5 — EventTailer reads real events.jsonl with correct structure
 *
 * Note: Uses Bun.spawnSync for CLI calls because gt may keep stdout open
 * with async Bun.spawn (background Dolt watchers hold the pipe).
 */

import { describe, test, expect, afterAll, setDefaultTimeout } from 'bun:test';
import * as path from 'path';
import { EventTailer } from '../adapters/gastown.js';

// gt + bd commands hit Dolt — each call can take 10-20s in test environments
setDefaultTimeout(30_000);

// --- Helpers ---

/** Run a CLI command synchronously, return parsed result. */
function runCli(args: string[]): { stdout: string; stderr: string; exitCode: number } {
  const proc = Bun.spawnSync(args, { stdout: 'pipe', stderr: 'pipe' });
  return {
    stdout: new TextDecoder().decode(proc.stdout).trim(),
    stderr: new TextDecoder().decode(proc.stderr).trim(),
    exitCode: proc.exitCode,
  };
}

/** Run a gt command with --json flag and parse the result. */
function gtJsonSync<T = unknown>(args: string[]): { data: T; raw: string; exitCode: number } {
  const result = runCli(['gt', ...args, '--json']);
  if (result.exitCode !== 0) {
    throw new Error(`gt ${args[0]} --json failed (exit ${result.exitCode}): ${result.stderr}`);
  }
  const data = JSON.parse(result.stdout) as T;
  return { data, raw: result.stdout, exitCode: result.exitCode };
}

// --- Skip guard ---

const GT_ON_PATH = (() => {
  try {
    return runCli(['gt', '--version']).exitCode === 0;
  } catch {
    return false;
  }
})();

const BD_ON_PATH = (() => {
  try {
    return runCli(['bd', '--version']).exitCode === 0;
  } catch {
    return false;
  }
})();

const EVENTS_PATH = path.join(process.env.HOME ?? '', 'gt', '.events.jsonl');
const EVENTS_EXIST = (() => {
  try {
    return Bun.file(EVENTS_PATH).size > 0;
  } catch {
    return false;
  }
})();

// Cleanup tracker for canary beads created during tests
const canaryBeadIds: string[] = [];

afterAll(() => {
  for (const id of canaryBeadIds) {
    try {
      runCli(['bd', 'close', id, '--reason=no-changes: contract test cleanup']);
    } catch {
      // Best-effort cleanup
    }
  }
});

// --- T1.1: gt hook --json ---

describe('T1.1: gt hook --json contract', () => {
  const SKIP = !GT_ON_PATH;

  test.skipIf(SKIP)('returns valid JSON', () => {
    const { data, raw } = gtJsonSync(['hook']);
    expect(data).toBeDefined();
    expect(typeof raw).toBe('string');
  });

  test.skipIf(SKIP)('has expected top-level keys', () => {
    const { data } = gtJsonSync<Record<string, unknown>>(['hook']);

    // Keys the adapter and orchestrator rely on
    expect(data).toHaveProperty('has_work');
    expect(typeof data.has_work).toBe('boolean');

    expect(data).toHaveProperty('target');
    expect(typeof data.target).toBe('string');

    expect(data).toHaveProperty('role');
    expect(typeof data.role).toBe('string');
  });

  test.skipIf(SKIP)('pinned_bead is an object when work is hooked', () => {
    const { data } = gtJsonSync<Record<string, unknown>>(['hook']);

    if (data.has_work) {
      expect(data).toHaveProperty('pinned_bead');
      expect(typeof data.pinned_bead).toBe('object');
      expect(data.pinned_bead).not.toBeNull();

      const bead = data.pinned_bead as Record<string, unknown>;
      expect(bead).toHaveProperty('id');
      expect(typeof bead.id).toBe('string');
      expect((bead.id as string).length).toBeGreaterThan(0);

      expect(bead).toHaveProperty('title');
      expect(typeof bead.title).toBe('string');

      expect(bead).toHaveProperty('status');
      expect(typeof bead.status).toBe('string');
    }
  });

  test.skipIf(SKIP)('raw CLI returns exit 0 with non-empty stdout', () => {
    const result = runCli(['gt', 'hook', '--json']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.length).toBeGreaterThan(0);
    // Must be valid JSON
    expect(() => JSON.parse(result.stdout)).not.toThrow();
  });
});

// --- T1.2: gt mol status --json ---

describe('T1.2: gt mol status --json contract', () => {
  const SKIP = !GT_ON_PATH;

  test.skipIf(SKIP)('returns valid JSON', () => {
    const { data, raw } = gtJsonSync(['mol', 'status']);
    expect(data).toBeDefined();
    expect(typeof raw).toBe('string');
  });

  test.skipIf(SKIP)('has expected top-level keys', () => {
    const { data } = gtJsonSync<Record<string, unknown>>(['mol', 'status']);

    // mol status shares the hook structure in gt
    expect(data).toHaveProperty('has_work');
    expect(typeof data.has_work).toBe('boolean');

    expect(data).toHaveProperty('target');
    expect(typeof data.target).toBe('string');
  });
});

// --- T1.3: gt mail inbox --json ---

describe('T1.3: gt mail inbox --json contract', () => {
  const SKIP = !GT_ON_PATH;

  test.skipIf(SKIP)('returns valid JSON', () => {
    const { data, raw } = gtJsonSync(['mail', 'inbox']);
    expect(data).toBeDefined();
    expect(typeof raw).toBe('string');
  });

  test.skipIf(SKIP)('returns an array or object with messages', () => {
    const { data } = gtJsonSync<unknown>(['mail', 'inbox']);

    // Real gt returns [] when empty, or an array of messages.
    // The adapter must handle both array and object-with-messages forms.
    if (Array.isArray(data)) {
      // Empty or populated array — each item should be an object
      for (const msg of data) {
        expect(typeof msg).toBe('object');
        expect(msg).not.toBeNull();
      }
    } else if (typeof data === 'object' && data !== null) {
      // Object form with messages key
      const obj = data as Record<string, unknown>;
      if ('messages' in obj) {
        expect(Array.isArray(obj.messages)).toBe(true);
      }
      if ('count' in obj) {
        expect(typeof obj.count).toBe('number');
      }
    } else {
      throw new Error(`Unexpected mail inbox type: ${typeof data}`);
    }
  });
});

// --- T1.4: bd create / close roundtrip ---

describe('T1.4: bd create returns bead ID with cleanup', () => {
  const SKIP = !BD_ON_PATH;

  test.skipIf(SKIP)('creates a bead and extracts ID from output', () => {
    const proc = runCli(
      ['bd', 'create', '--title', 'contract-test-canary', '--type', 'task'],
    );
    const combined = `${proc.stdout}\n${proc.stderr}`;

    expect(proc.exitCode).toBe(0);

    // bd create outputs "✓ Created issue: <id> — <title>"
    // Bead IDs use rig-specific prefixes (ga-, hq-, etc.) — match any prefix
    const idMatch = combined.match(/Created issue:\s*(\S+)/);
    expect(idMatch).not.toBeNull();

    const beadId = idMatch![1];
    // Bead IDs are alphanumeric with a prefix and hyphen (e.g., ga-abc, hq-xyz)
    expect(beadId).toMatch(/^\w+-\w+$/);
    canaryBeadIds.push(beadId);

    // Verify the bead exists via bd show
    const showProc = runCli(['bd', 'show', beadId]);
    expect(showProc.exitCode).toBe(0);
    expect(showProc.stdout).toContain('contract-test-canary');

    // Clean up immediately
    const closeProc = runCli(
      ['bd', 'close', beadId, '--reason=no-changes: contract test canary'],
    );
    expect(closeProc.exitCode).toBe(0);

    // Remove from cleanup tracker since we already closed it
    const idx = canaryBeadIds.indexOf(beadId);
    if (idx !== -1) canaryBeadIds.splice(idx, 1);
  });
});

// --- T1.5: EventTailer against real events.jsonl ---

describe('T1.5: EventTailer against real events.jsonl', () => {
  const SKIP = !EVENTS_EXIST;

  test.skipIf(SKIP)('reads events from real events.jsonl', () => {
    const tailer = new EventTailer(EVENTS_PATH);
    const events = tailer.poll();

    expect(events.length).toBeGreaterThan(0);

    // Every event should be a non-null object
    for (const event of events) {
      expect(typeof event).toBe('object');
      expect(event).not.toBeNull();
    }
  });

  test.skipIf(SKIP)('events have expected Gas Town structure', () => {
    const tailer = new EventTailer(EVENTS_PATH);
    const events = tailer.poll();

    expect(events.length).toBeGreaterThan(0);

    // Sample the first few events for structure validation
    const sample = events.slice(0, Math.min(10, events.length));
    for (const event of sample) {
      // Gas Town events have: ts, source, type, actor, payload
      expect(event).toHaveProperty('ts');
      expect(typeof event.ts).toBe('string');

      expect(event).toHaveProperty('source');
      expect(typeof event.source).toBe('string');

      expect(event).toHaveProperty('type');
      expect(typeof event.type).toBe('string');
    }
  });

  test.skipIf(SKIP)('second poll returns empty (no new data)', () => {
    const tailer = new EventTailer(EVENTS_PATH);
    tailer.poll(); // consume all
    const second = tailer.poll();
    expect(second).toEqual([]);
  });

  test.skipIf(SKIP)('state save/restore preserves offset', () => {
    const tailer1 = new EventTailer(EVENTS_PATH);
    tailer1.poll();
    const state = tailer1.state;

    expect(state.offset).toBeGreaterThan(0);
    expect(state.inode).toBeGreaterThan(0);

    const tailer2 = new EventTailer(EVENTS_PATH);
    tailer2.restore(state);
    const events = tailer2.poll();
    // Should see 0 events (or very few if new events arrived between polls)
    expect(events.length).toBeLessThan(5);
  });
});
