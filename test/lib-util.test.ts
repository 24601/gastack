/**
 * Tests for lib/util.ts — shared utilities.
 */

import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  atomicWriteSync,
  atomicWriteJSON,
  readJSON,
  getGitRoot,
  getGitInfo,
  getRemoteSlug,
  getVersion,
  sanitizeForFilename,
} from '../lib/util';

function tmpDir(): string {
  const dir = path.join(os.tmpdir(), `gstack-util-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

describe('lib/util', () => {
  describe('atomicWriteSync', () => {
    test('writes a file atomically', () => {
      const dir = tmpDir();
      const filePath = path.join(dir, 'test.txt');
      atomicWriteSync(filePath, 'hello world');
      expect(fs.readFileSync(filePath, 'utf-8')).toBe('hello world');
      expect(fs.existsSync(filePath + '.tmp')).toBe(false);
      fs.rmSync(dir, { recursive: true, force: true });
    });

    test('overwrites existing file', () => {
      const dir = tmpDir();
      const filePath = path.join(dir, 'test.txt');
      fs.writeFileSync(filePath, 'old');
      atomicWriteSync(filePath, 'new');
      expect(fs.readFileSync(filePath, 'utf-8')).toBe('new');
      fs.rmSync(dir, { recursive: true, force: true });
    });
  });

  describe('atomicWriteJSON', () => {
    test('writes JSON with pretty formatting', () => {
      const dir = tmpDir();
      const filePath = path.join(dir, 'test.json');
      atomicWriteJSON(filePath, { key: 'value', num: 42 });
      const content = fs.readFileSync(filePath, 'utf-8');
      expect(content).toContain('"key": "value"');
      expect(content).toContain('"num": 42');
      expect(content.endsWith('\n')).toBe(true);
      fs.rmSync(dir, { recursive: true, force: true });
    });

    test('creates parent directories', () => {
      const dir = tmpDir();
      const filePath = path.join(dir, 'sub', 'dir', 'test.json');
      atomicWriteJSON(filePath, { ok: true });
      expect(fs.existsSync(filePath)).toBe(true);
      fs.rmSync(dir, { recursive: true, force: true });
    });

    test('sets file mode when provided', () => {
      const dir = tmpDir();
      const filePath = path.join(dir, 'secret.json');
      atomicWriteJSON(filePath, { token: 'abc' }, 0o600);
      const stat = fs.statSync(filePath);
      // Check owner-only read/write (mask out file type bits)
      expect(stat.mode & 0o777).toBe(0o600);
      fs.rmSync(dir, { recursive: true, force: true });
    });
  });

  describe('readJSON', () => {
    test('reads and parses JSON file', () => {
      const dir = tmpDir();
      const filePath = path.join(dir, 'data.json');
      fs.writeFileSync(filePath, '{"a": 1, "b": "two"}');
      const result = readJSON<{ a: number; b: string }>(filePath);
      expect(result).toEqual({ a: 1, b: 'two' });
      fs.rmSync(dir, { recursive: true, force: true });
    });

    test('returns null for missing file', () => {
      expect(readJSON('/nonexistent/path.json')).toBeNull();
    });

    test('returns null for invalid JSON', () => {
      const dir = tmpDir();
      const filePath = path.join(dir, 'bad.json');
      fs.writeFileSync(filePath, 'not json');
      expect(readJSON(filePath)).toBeNull();
      fs.rmSync(dir, { recursive: true, force: true });
    });
  });

  describe('getGitRoot', () => {
    test('returns a path when in a git repo', () => {
      const root = getGitRoot();
      expect(root).not.toBeNull();
      expect(fs.existsSync(path.join(root!, '.git'))).toBe(true);
    });
  });

  describe('getGitInfo', () => {
    test('returns branch and sha', () => {
      const info = getGitInfo();
      expect(info.branch).toBeTruthy();
      expect(info.sha).toBeTruthy();
      expect(info.sha).not.toBe('unknown');
    });
  });

  describe('getRemoteSlug', () => {
    test('returns owner-repo format', () => {
      const slug = getRemoteSlug();
      expect(slug).toBeTruthy();
      expect(slug).toMatch(/^[a-zA-Z0-9._-]+-[a-zA-Z0-9._-]+$/);
    });
  });

  describe('getVersion', () => {
    test('returns a version string', () => {
      const version = getVersion();
      expect(version).toBeTruthy();
      expect(version).not.toBe('unknown');
    });
  });

  describe('sanitizeForFilename', () => {
    test('strips leading slashes', () => {
      expect(sanitizeForFilename('/review')).toBe('review');
      expect(sanitizeForFilename('///multi')).toBe('multi');
    });

    test('replaces slashes with dashes', () => {
      expect(sanitizeForFilename('a/b/c')).toBe('a-b-c');
    });

    test('handles clean names unchanged', () => {
      expect(sanitizeForFilename('simple')).toBe('simple');
    });
  });
});
