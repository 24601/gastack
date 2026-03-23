import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const ROOT = path.resolve(import.meta.dir, '..');
const BIN = path.join(ROOT, 'bin');

let tmpDir: string;

function run(cmd: string, env: Record<string, string> = {}): string {
  try {
    return execSync(cmd, {
      cwd: ROOT,
      env: { ...process.env, GSTACK_STATE_DIR: tmpDir, GSTACK_DIR: ROOT, ...env },
      encoding: 'utf-8',
      timeout: 10000,
    }).trim();
  } catch (e: any) {
    return e.stdout?.toString() || e.message;
  }
}

function setConfig(key: string, value: string) {
  run(`${BIN}/gstack-config set ${key} ${value}`);
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-comm-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('gstack-auth', () => {
  test('status shows not authenticated when no token file', () => {
    const output = run(`${BIN}/gstack-auth status`);
    expect(output).toContain('Not authenticated');
  });

  test('logout removes token file', () => {
    const authFile = path.join(tmpDir, 'auth-token.json');
    fs.writeFileSync(authFile, '{"access_token":"test"}');
    expect(fs.existsSync(authFile)).toBe(true);

    run(`${BIN}/gstack-auth logout`);
    expect(fs.existsSync(authFile)).toBe(false);
  });
});

describe('gstack-auth-refresh', () => {
  test('--check fails when not authenticated', () => {
    // execSync throws on non-zero exit code
    try {
      execSync(`${BIN}/gstack-auth-refresh --check`, {
        env: { ...process.env, GSTACK_STATE_DIR: tmpDir, GSTACK_DIR: ROOT }
      });
      expect(false).toBe(true); // Should not reach here
    } catch (e: any) {
      expect(e.status).toBe(1);
    }
  });

  test('--check succeeds when authenticated', () => {
    const authFile = path.join(tmpDir, 'auth-token.json');
    const expiresAt = Math.floor(Date.now() / 1000) + 3600;
    fs.writeFileSync(authFile, JSON.stringify({
      access_token: 'valid',
      refresh_token: 'refresh',
      expires_at: expiresAt,
      email: 'test@example.com',
      user_id: 'user-123'
    }));

    const status = execSync(`${BIN}/gstack-auth-refresh --check`, {
      env: { ...process.env, GSTACK_STATE_DIR: tmpDir, GSTACK_DIR: ROOT }
    });
    // Should not throw
  });
});

describe('gstack-community-backup', () => {
  test('exits early if not community tier', () => {
    setConfig('telemetry', 'anonymous');
    const output = run(`${BIN}/gstack-community-backup`);
    expect(output).toBe('');
  });

  test('exits early if not authenticated', () => {
    setConfig('telemetry', 'community');
    const output = run(`${BIN}/gstack-community-backup`);
    expect(output).toBe('');
  });

  test('snapshot generation (dry run/mock check)', () => {
    setConfig('telemetry', 'community');
    const authFile = path.join(tmpDir, 'auth-token.json');
    fs.writeFileSync(authFile, JSON.stringify({
      access_token: 'valid',
      refresh_token: 'refresh',
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      email: 'test@example.com',
      user_id: 'user-123'
    }));

    // Create some data to backup
    fs.writeFileSync(path.join(tmpDir, 'config.yaml'), 'key: "value with \\"quotes\\""\n');
    const analyticsDir = path.join(tmpDir, 'analytics');
    fs.mkdirSync(analyticsDir);
    fs.writeFileSync(path.join(analyticsDir, 'skill-usage.jsonl'), '{"skill":"qa","duration_s":10,"outcome":"success"}\n');

    // We can't easily test the Supabase POST without mocking curl or the endpoint
    // but we can verify it doesn't crash and respects the rate limit marker.
    run(`${BIN}/gstack-community-backup`, { GSTACK_TELEMETRY_ENDPOINT: 'http://localhost:9999' });
    
    // It should NOT have created the rate limit marker because the POST failed (HTTP 000)
    expect(fs.existsSync(path.join(analyticsDir, '.last-backup-time'))).toBe(false);
  });
});

describe('gstack-community-benchmarks', () => {
  test('shows no data message when no local analytics', () => {
    const output = run(`${BIN}/gstack-community-benchmarks`);
    expect(output).toContain('No local analytics data');
  });

  test('renders comparison table with local data', () => {
    const analyticsDir = path.join(tmpDir, 'analytics');
    fs.mkdirSync(analyticsDir);
    fs.writeFileSync(path.join(analyticsDir, 'skill-usage.jsonl'), '{"skill":"qa","duration_s":120,"outcome":"success"}\n');
    
    const output = run(`${BIN}/gstack-community-benchmarks`);
    expect(output).toContain('/qa');
    expect(output).toContain('2m 0s');
  });
});
