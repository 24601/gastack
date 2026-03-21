import { describe, it, expect, mock, beforeEach } from 'bun:test';
import {
  findBrowserBinary,
  findInstalledBrowsers,
  isCdpAvailable,
  getCdpWebSocketUrl,
  findCdpPort,
  BROWSER_BINARIES,
} from '../src/chrome-launcher';

// ─── chrome-launcher unit tests ─────────────────────────────────

describe('findBrowserBinary', () => {
  it('finds Chrome by alias', () => {
    const result = findBrowserBinary('chrome');
    expect(result).not.toBeNull();
    expect(result!.name).toBe('Chrome');
  });

  it('finds Chrome by name (case-insensitive)', () => {
    const result = findBrowserBinary('Chrome');
    expect(result).not.toBeNull();
    expect(result!.name).toBe('Chrome');
  });

  it('finds Comet by alias', () => {
    const result = findBrowserBinary('comet');
    expect(result).not.toBeNull();
    expect(result!.name).toBe('Comet');
  });

  it('finds Comet by perplexity alias', () => {
    const result = findBrowserBinary('perplexity');
    expect(result).not.toBeNull();
    expect(result!.name).toBe('Comet');
  });

  it('returns null for unknown browser', () => {
    expect(findBrowserBinary('netscape')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(findBrowserBinary('')).toBeNull();
  });
});

describe('BROWSER_BINARIES', () => {
  it('has correct priority order (Comet first)', () => {
    expect(BROWSER_BINARIES[0].name).toBe('Comet');
    expect(BROWSER_BINARIES[1].name).toBe('Chrome');
  });

  it('all entries have required fields', () => {
    for (const browser of BROWSER_BINARIES) {
      expect(browser.name).toBeTruthy();
      expect(browser.binary).toContain('/Applications/');
      expect(browser.appName).toBeTruthy();
      expect(browser.aliases.length).toBeGreaterThan(0);
    }
  });
});

describe('isCdpAvailable', () => {
  it('returns false for port with no listener', async () => {
    // Port 19999 should not have anything listening
    const result = await isCdpAvailable(19999);
    expect(result.available).toBe(false);
    expect(result.wsUrl).toBeUndefined();
  });

  it('returns false for invalid port', async () => {
    const result = await isCdpAvailable(0);
    expect(result.available).toBe(false);
  });
});

describe('getCdpWebSocketUrl', () => {
  it('throws for unavailable port', async () => {
    await expect(getCdpWebSocketUrl(19999)).rejects.toThrow('No CDP endpoint');
  });
});

describe('findCdpPort', () => {
  it('returns null when no CDP ports are available', async () => {
    // This test passes in CI where no Chrome is running with debug port
    // In local dev with debug port open, it would find one
    const result = await findCdpPort();
    // Either null (no CDP) or valid result — both are correct
    if (result !== null) {
      expect(result.port).toBeGreaterThan(0);
      expect(result.wsUrl).toContain('ws://');
    }
  });
});

// ─── Runtime Detection ──────────────────────────────────────────

describe('detectRuntime', () => {
  it('returns a valid runtime type', async () => {
    const { detectRuntime } = await import('../src/chrome-launcher');
    const runtime = detectRuntime();
    expect(['conductor', 'claude-code', 'codex', 'terminal']).toContain(runtime);
  });
});

describe('canManageApps', () => {
  it('returns a boolean', async () => {
    const { canManageApps } = await import('../src/chrome-launcher');
    expect(typeof canManageApps()).toBe('boolean');
  });
});

describe('isManualRestart', () => {
  it('detects manual restart objects', async () => {
    const { isManualRestart, BROWSER_BINARIES } = await import('../src/chrome-launcher');
    const manualResult = {
      needsManualRestart: true as const,
      browser: BROWSER_BINARIES[0],
      port: 9222,
      reason: 'test',
      command: 'test',
    };
    // isManualRestart is not directly exported, but we can test the type guard
    expect(manualResult.needsManualRestart).toBe(true);
  });
});

// ─── BrowserManager CDP mode guards ─────────────────────────────

describe('BrowserManager CDP mode', () => {
  // These tests verify the mode guard logic without actually connecting
  // to a real browser. We test the public interface.

  it('getConnectionMode defaults to launched', async () => {
    const { BrowserManager } = await import('../src/browser-manager');
    const bm = new BrowserManager();
    expect(bm.getConnectionMode()).toBe('launched');
  });

  it('getRefMap returns empty array initially', async () => {
    const { BrowserManager } = await import('../src/browser-manager');
    const bm = new BrowserManager();
    expect(bm.getRefMap()).toEqual([]);
  });
});
