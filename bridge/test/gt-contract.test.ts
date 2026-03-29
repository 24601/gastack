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
 */

import { describe, test, expect, afterAll } from 'bun:test';
import * as path from 'path';
import { gtExec, gtJson, EventTailer } from '../adapters/gastown.js';

// --- Skip guard ---

const GT_ON_PATH = (() => {
  try {
    const r = Bun.spawnSync(['gt', '--version'], { stdout: 'pipe', stderr: 'pipe' });
    return r.exitCode === 0;
  } catch {
    return false;
  }
})();

const BD_ON_PATH = (() => {
  try {
    const r = Bun.spawnSync(['bd', '--version'], { stdout: 'pipe', stderr: 'pipe' });
    return r.exitCode === 0;
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

afterAll(async () => {
  // Clean up any canary beads that weren't already closed
  for (const id of canaryBeadIds) {
    try {
      Bun.spawnSync(
        ['bd', 'close', id, '--reason=no-changes: contract test cleanup'],
        { stdout: 'pipe', stderr: 'pipe' },
      );
    } catch {
      // Best-effort cleanup
    }
  }
});

// --- T1.1: gt hook --json ---

describe('T1.1: gt hook --json contract', () => {
  const SKIP = !GT_ON_PATH;

  test.skipIf(SKIP)('returns valid JSON', async () => {
    const result = await gtJson(['hook']);
    expect(result.data).toBeDefined();
    expect(typeof result.raw).toBe('string');
  });

  test.skipIf(SKIP)('has expected top-level keys', async () => {
    const result = await gtJson<Record<string, unknown>>(['hook']);
    const data = result.data;

    // Keys the adapter and orchestrator rely on
    expect(data).toHaveProperty('has_work');
    expect(typeof data.has_work).toBe('boolean');

    expect(data).toHaveProperty('target');
    expect(typeof data.target).toBe('string');

    expect(data).toHaveProperty('role');
    expect(typeof data.role).toBe('string');
  });

  test.skipIf(SKIP)('pinned_bead is an object when work is hooked', async () => {
    const result = await gtJson<Record<string, unknown>>(['hook']);
    const data = result.data;

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

  test.skipIf(SKIP)('gtExec returns structured GtResult', async () => {
    const result = await gtExec(['hook', '--json']);
    expect(typeof result.stdout).toBe('string');
    expect(typeof result.stderr).toBe('string');
    expect(typeof result.exitCode).toBe('number');
    expect(result.exitCode).toBe(0);
  });
});

// --- T1.2: gt mol status --json ---

describe('T1.2: gt mol status --json contract', () => {
  const SKIP = !GT_ON_PATH;

  test.skipIf(SKIP)('returns valid JSON', async () => {
    const result = await gtJson(['mol', 'status']);
    expect(result.data).toBeDefined();
    expect(typeof result.raw).toBe('string');
  });

  test.skipIf(SKIP)('has expected top-level keys', async () => {
    const result = await gtJson<Record<string, unknown>>(['mol', 'status']);
    const data = result.data;

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

  test.skipIf(SKIP)('returns valid JSON', async () => {
    const result = await gtJson(['mail', 'inbox']);
    expect(result.data).toBeDefined();
    expect(typeof result.raw).toBe('string');
  });

  test.skipIf(SKIP)('returns an array or object with messages', async () => {
    const result = await gtJson<unknown>(['mail', 'inbox']);
    const data = result.data;

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

  test.skipIf(SKIP)('creates a bead and extracts ID from output', async () => {
    // Use bd directly — it's not a gt subcommand
    const proc = Bun.spawnSync(
      ['bd', 'create', '--title', 'contract-test-canary', '--type', 'task'],
      { stdout: 'pipe', stderr: 'pipe' },
    );

    const stdout = new TextDecoder().decode(proc.stdout).trim();
    const stderr = new TextDecoder().decode(proc.stderr).trim();
    const combined = `${stdout}\n${stderr}`;

    expect(proc.exitCode).toBe(0);

    // bd create outputs "✓ Created issue: <id> — <title>"
    const idMatch = combined.match(/Created issue:\s*(ga-\w+)/);
    expect(idMatch).not.toBeNull();

    const beadId = idMatch![1];
    expect(beadId).toMatch(/^ga-\w+$/);
    canaryBeadIds.push(beadId);

    // Verify the bead exists via bd show
    const showProc = Bun.spawnSync(
      ['bd', 'show', beadId],
      { stdout: 'pipe', stderr: 'pipe' },
    );
    const showOutput = new TextDecoder().decode(showProc.stdout).trim();
    expect(showProc.exitCode).toBe(0);
    expect(showOutput).toContain('contract-test-canary');

    // Clean up immediately
    const closeProc = Bun.spawnSync(
      ['bd', 'close', beadId, '--reason=no-changes: contract test canary'],
      { stdout: 'pipe', stderr: 'pipe' },
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
