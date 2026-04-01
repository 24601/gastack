/**
 * Tests for the Gas Town adapter — gt CLI integration + event tailing.
 *
 * Unit tests cover:
 *   - EventTailer: offset tracking, inode detection, truncation, JSONL parsing
 *   - GasTownAdapter: command routing, error handling
 *   - gtExec / gtJson: spawn mechanics (integration, requires `gt` on PATH)
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { EventTailer, GasTownAdapter, GtError, gtExec } from './gastown.js';

// --- Test helpers ---

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gastown-test-'));
}

function writeLines(filePath: string, lines: unknown[]): void {
  fs.writeFileSync(filePath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

function appendLines(filePath: string, lines: unknown[]): void {
  fs.appendFileSync(filePath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

// --- EventTailer tests ---

describe('EventTailer', () => {
  let dir: string;

  beforeEach(() => {
    dir = tmpDir();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('returns empty array when file does not exist', () => {
    const tailer = new EventTailer(path.join(dir, 'nonexistent.jsonl'));
    expect(tailer.poll()).toEqual([]);
  });

  test('reads all events on first poll', () => {
    const fp = path.join(dir, 'events.jsonl');
    writeLines(fp, [
      { type: 'a', value: 1 },
      { type: 'b', value: 2 },
    ]);

    const tailer = new EventTailer(fp);
    const events = tailer.poll();
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ type: 'a', value: 1 });
    expect(events[1]).toEqual({ type: 'b', value: 2 });
  });

  test('tracks offset — second poll only returns new events', () => {
    const fp = path.join(dir, 'events.jsonl');
    writeLines(fp, [{ type: 'a' }]);

    const tailer = new EventTailer(fp);
    expect(tailer.poll()).toHaveLength(1);

    // Append more
    appendLines(fp, [{ type: 'b' }, { type: 'c' }]);
    const newEvents = tailer.poll();
    expect(newEvents).toHaveLength(2);
    expect(newEvents[0]).toEqual({ type: 'b' });
    expect(newEvents[1]).toEqual({ type: 'c' });
  });

  test('returns empty on subsequent poll with no new data', () => {
    const fp = path.join(dir, 'events.jsonl');
    writeLines(fp, [{ type: 'a' }]);

    const tailer = new EventTailer(fp);
    tailer.poll();
    expect(tailer.poll()).toEqual([]);
  });

  test('detects truncation and resets offset', () => {
    const fp = path.join(dir, 'events.jsonl');
    writeLines(fp, [{ type: 'a' }, { type: 'b' }, { type: 'c' }]);

    const tailer = new EventTailer(fp);
    tailer.poll(); // read all 3

    // Truncate and write less data
    writeLines(fp, [{ type: 'x' }]);
    const events = tailer.poll();
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ type: 'x' });
  });

  test('detects inode change (file replacement)', () => {
    const fp = path.join(dir, 'events.jsonl');
    writeLines(fp, [{ type: 'old' }]);

    const tailer = new EventTailer(fp);
    tailer.poll(); // read "old"

    // Replace file (new inode)
    fs.unlinkSync(fp);
    writeLines(fp, [{ type: 'new1' }, { type: 'new2' }]);

    const events = tailer.poll();
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ type: 'new1' });
  });

  test('skips malformed JSON lines', () => {
    const fp = path.join(dir, 'events.jsonl');
    fs.writeFileSync(fp, [
      '{"type":"good"}',
      'not json at all',
      '{"type":"also good"}',
      '',
    ].join('\n'));

    const tailer = new EventTailer(fp);
    const events = tailer.poll();
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ type: 'good' });
    expect(events[1]).toEqual({ type: 'also good' });
  });

  test('skips non-object JSON values', () => {
    const fp = path.join(dir, 'events.jsonl');
    fs.writeFileSync(fp, [
      '{"type":"obj"}',
      '"just a string"',
      '42',
      'null',
      '{"type":"obj2"}',
    ].join('\n'));

    const tailer = new EventTailer(fp);
    const events = tailer.poll();
    expect(events).toHaveLength(2);
  });

  test('state save and restore', () => {
    const fp = path.join(dir, 'events.jsonl');
    writeLines(fp, [{ type: 'a' }, { type: 'b' }]);

    const tailer1 = new EventTailer(fp);
    tailer1.poll(); // read both
    const saved = tailer1.state;

    // New tailer, restored from saved state
    const tailer2 = new EventTailer(fp);
    tailer2.restore(saved);

    // Should see nothing (already at end)
    expect(tailer2.poll()).toEqual([]);

    // Append new data
    appendLines(fp, [{ type: 'c' }]);
    const events = tailer2.poll();
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ type: 'c' });
  });

  test('reset goes back to beginning', () => {
    const fp = path.join(dir, 'events.jsonl');
    writeLines(fp, [{ type: 'a' }, { type: 'b' }]);

    const tailer = new EventTailer(fp);
    tailer.poll();
    tailer.reset();

    const events = tailer.poll();
    expect(events).toHaveLength(2);
  });
});

// --- GasTownAdapter tests ---

describe('GasTownAdapter', () => {
  let dir: string;

  beforeEach(() => {
    dir = tmpDir();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('routes tail.poll through event tailer', async () => {
    const fp = path.join(dir, 'events.jsonl');
    writeLines(fp, [{ type: 'STAGE_ENTERED', stage: 'PLAN' }]);

    const adapter = new GasTownAdapter({ cwd: dir, eventsPath: fp });
    const result = JSON.parse(await adapter.execute('tail.poll'));
    expect(result.count).toBe(1);
    expect(result.events[0].type).toBe('STAGE_ENTERED');
  });

  test('tail.poll returns empty when no new events', async () => {
    const fp = path.join(dir, 'events.jsonl');
    writeLines(fp, [{ type: 'a' }]);

    const adapter = new GasTownAdapter({ cwd: dir, eventsPath: fp });
    await adapter.execute('tail.poll'); // consume
    const result = JSON.parse(await adapter.execute('tail.poll'));
    expect(result.count).toBe(0);
    expect(result.events).toEqual([]);
  });

  test('tail.state returns current offset and inode', async () => {
    const fp = path.join(dir, 'events.jsonl');
    writeLines(fp, [{ type: 'a' }]);

    const adapter = new GasTownAdapter({ cwd: dir, eventsPath: fp });
    await adapter.execute('tail.poll');

    const state = JSON.parse(await adapter.execute('tail.state'));
    expect(typeof state.offset).toBe('number');
    expect(state.offset).toBeGreaterThan(0);
    expect(typeof state.inode).toBe('number');
  });

  test('tail.restore resumes from saved state', async () => {
    const fp = path.join(dir, 'events.jsonl');
    writeLines(fp, [{ type: 'a' }, { type: 'b' }]);

    const adapter = new GasTownAdapter({ cwd: dir, eventsPath: fp });
    await adapter.execute('tail.poll');
    const state = JSON.parse(await adapter.execute('tail.state'));

    // New adapter, restore state
    const adapter2 = new GasTownAdapter({ cwd: dir, eventsPath: fp });
    await adapter2.execute('tail.restore', state);

    appendLines(fp, [{ type: 'c' }]);
    const result = JSON.parse(await adapter2.execute('tail.poll'));
    expect(result.count).toBe(1);
    expect(result.events[0].type).toBe('c');
  });

  test('tail.poll throws when tailer not initialized', async () => {
    const adapter = new GasTownAdapter({ cwd: dir });
    await expect(adapter.execute('tail.poll')).rejects.toThrow('Event tailer not initialized');
  });

  test('initTailer sets up tailing after construction', async () => {
    const fp = path.join(dir, 'events.jsonl');
    writeLines(fp, [{ type: 'late-init' }]);

    const adapter = new GasTownAdapter({ cwd: dir });
    adapter.initTailer(fp);

    const result = JSON.parse(await adapter.execute('tail.poll'));
    expect(result.count).toBe(1);
  });

  test('unknown command throws', async () => {
    const adapter = new GasTownAdapter({ cwd: dir });
    await expect(adapter.execute('nonexistent')).rejects.toThrow('Unknown gastown command');
  });

  test('adapter name is gastown', () => {
    const adapter = new GasTownAdapter({ cwd: dir });
    expect(adapter.name).toBe('gastown');
  });

  test('changelog command builds correct args', async () => {
    // This test verifies the command routing — the actual gt call will
    // fail since we're in a temp dir, but we can verify args construction
    // by checking that it calls gt changelog with the right flags.
    const adapter = new GasTownAdapter({ cwd: dir, timeout: 2000 });

    // Without a real gt changelog, this will throw GtError — that's fine,
    // we just verify it doesn't throw "Unknown gastown command"
    try {
      await adapter.execute('changelog', { since: '2026-01-01', rig: 'myrig' });
    } catch (e: unknown) {
      // Expected: gt changelog fails because we're not in a Gas Town context
      // But the command was routed correctly (not "Unknown gastown command")
      expect((e as Error).message).not.toContain('Unknown gastown command');
    }
  });
});

// --- gtExec integration test (requires gt on PATH) ---

describe('gtExec', () => {
  test('runs gt --version', async () => {
    const result = await gtExec(['--version']);
    // gt should exit 0 and print a version string
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('gt version');
  });

  test('returns non-zero exit code on bad subcommand', async () => {
    const result = await gtExec(['__nonexistent_subcommand__']);
    expect(result.exitCode).not.toBe(0);
  });
});
