/**
 * Chrome/Comet browser discovery + CDP connection
 *
 * Discovery flow (macOS only):
 *   1. Probe localhost:9222 for existing CDP endpoint
 *   2. If occupied by non-Chrome, try 9223-9225
 *   3. If no CDP: find browser binary, quit gracefully, relaunch with --remote-debugging-port
 *   4. On attach failure: rollback — relaunch browser WITHOUT debug flag
 *
 * Reuses the browser registry pattern from cookie-import-browser.ts
 */

import { execSync, spawn } from 'child_process';

// ─── Browser Binary Registry (macOS) ───────────────────────────

export interface BrowserBinary {
  name: string;
  binary: string;
  appName: string;  // for osascript 'tell application "X"'
  aliases: string[];
}

export const BROWSER_BINARIES: BrowserBinary[] = [
  { name: 'Comet',  binary: '/Applications/Comet.app/Contents/MacOS/Comet',                      appName: 'Comet',            aliases: ['comet', 'perplexity'] },
  { name: 'Chrome', binary: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',       appName: 'Google Chrome',    aliases: ['chrome', 'google-chrome'] },
  { name: 'Arc',    binary: '/Applications/Arc.app/Contents/MacOS/Arc',                           appName: 'Arc',              aliases: ['arc'] },
  { name: 'Brave',  binary: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',      appName: 'Brave Browser',    aliases: ['brave'] },
  { name: 'Edge',   binary: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',    appName: 'Microsoft Edge',   aliases: ['edge'] },
];

// ─── CDP Probe ─────────────────────────────────────────────────

export interface CdpProbeResult {
  available: boolean;
  wsUrl?: string;
  browser?: string;
}

/**
 * Check if a CDP endpoint is available at the given port.
 * Returns the WebSocket debugger URL if found.
 */
export async function isCdpAvailable(port: number): Promise<CdpProbeResult> {
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!resp.ok) return { available: false };
    const data = await resp.json() as Record<string, string>;
    const wsUrl = data.webSocketDebuggerUrl;
    if (!wsUrl) return { available: false };
    return { available: true, wsUrl, browser: data.Browser };
  } catch {
    return { available: false };
  }
}

/**
 * Get the WebSocket debugger URL from a CDP port.
 * Throws if not available.
 */
export async function getCdpWebSocketUrl(port: number): Promise<string> {
  const result = await isCdpAvailable(port);
  if (!result.available || !result.wsUrl) {
    throw new Error(`No CDP endpoint at port ${port}`);
  }
  return result.wsUrl;
}

/**
 * Try ports 9222-9225 to find an available CDP endpoint.
 */
export async function findCdpPort(): Promise<{ port: number; wsUrl: string; browser?: string } | null> {
  for (const port of [9222, 9223, 9224, 9225]) {
    const result = await isCdpAvailable(port);
    if (result.available && result.wsUrl) {
      return { port, wsUrl: result.wsUrl, browser: result.browser };
    }
  }
  return null;
}

// ─── Browser Binary Discovery ──────────────────────────────────

import * as fs from 'fs';

/**
 * Find the binary path for a browser by name or alias.
 */
export function findBrowserBinary(nameOrAlias: string): BrowserBinary | null {
  const needle = nameOrAlias.toLowerCase();
  return BROWSER_BINARIES.find(b =>
    b.aliases.includes(needle) || b.name.toLowerCase() === needle
  ) ?? null;
}

/**
 * Find installed browsers (binary exists on disk).
 */
export function findInstalledBrowsers(): BrowserBinary[] {
  return BROWSER_BINARIES.filter(b => {
    try { return fs.existsSync(b.binary); } catch { return false; }
  });
}

/**
 * Check if a browser is currently running (macOS: pgrep).
 */
export function isBrowserRunning(browser: BrowserBinary): boolean {
  try {
    // Use the app name to find the process
    execSync(`pgrep -f "${browser.appName}"`, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

// ─── Browser Launch with CDP ───────────────────────────────────

/**
 * Quit a browser gracefully via osascript and relaunch with --remote-debugging-port.
 * Returns the CDP WebSocket URL on success.
 *
 * If the user's browser is running, this will:
 * 1. Quit it gracefully (tabs restored on relaunch)
 * 2. Wait 2s for clean shutdown
 * 3. Relaunch with --remote-debugging-port
 * 4. Poll for CDP availability (up to 15s)
 *
 * On failure: attempt to relaunch WITHOUT debug flag (rollback).
 */
export async function launchWithCdp(
  browser: BrowserBinary,
  port: number = 9222,
): Promise<{ wsUrl: string; port: number }> {
  const wasRunning = isBrowserRunning(browser);

  if (wasRunning) {
    // Quit gracefully via osascript
    try {
      execSync(`osascript -e 'tell application "${browser.appName}" to quit'`, {
        stdio: 'pipe',
        timeout: 10000,
      });
    } catch {
      throw new Error(`Failed to quit ${browser.name}. Close it manually and try again.`);
    }
    // Wait for clean shutdown
    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  // Relaunch with CDP flag
  const child = spawn(browser.binary, [
    `--remote-debugging-port=${port}`,
    '--restore-last-session',
  ], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  // Poll for CDP availability (up to 15s)
  const startTime = Date.now();
  while (Date.now() - startTime < 15000) {
    const result = await isCdpAvailable(port);
    if (result.available && result.wsUrl) {
      return { wsUrl: result.wsUrl, port };
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  // Rollback: relaunch without debug flag so user gets their browser back
  if (wasRunning) {
    try {
      const rollback = spawn(browser.binary, ['--restore-last-session'], {
        detached: true,
        stdio: 'ignore',
      });
      rollback.unref();
    } catch {}
  }

  throw new Error(
    `CDP endpoint not available after 15s. ${browser.name} may not support --remote-debugging-port, ` +
    `or port ${port} is blocked. Browser has been relaunched without debug flag.`
  );
}

/**
 * Full discovery algorithm:
 * 1. Check for existing CDP on ports 9222-9225
 * 2. Find an installed browser (priority order)
 * 3. Launch/relaunch with CDP
 *
 * @param preferredBrowser - Optional browser name (e.g., 'chrome', 'comet')
 * @param port - CDP port (default 9222)
 */
export async function discoverAndConnect(
  preferredBrowser?: string,
  port: number = 9222,
): Promise<{ wsUrl: string; port: number; browser: string }> {
  // Step 1: Check for existing CDP
  const existing = await findCdpPort();
  if (existing) {
    return {
      wsUrl: existing.wsUrl,
      port: existing.port,
      browser: existing.browser || 'Unknown',
    };
  }

  // Step 2: Find browser binary
  let browser: BrowserBinary | null = null;

  if (preferredBrowser) {
    browser = findBrowserBinary(preferredBrowser);
    if (!browser) {
      const installed = findInstalledBrowsers();
      const names = installed.map(b => b.name.toLowerCase()).join(', ');
      throw new Error(
        `Browser '${preferredBrowser}' not found. Installed: ${names || 'none'}`
      );
    }
  } else {
    // Auto-detect: first installed browser in priority order
    const installed = findInstalledBrowsers();
    if (installed.length === 0) {
      throw new Error('No supported browser found. Install Chrome, Comet, Arc, Brave, or Edge.');
    }
    browser = installed[0];
  }

  // Step 3: Launch with CDP
  const result = await launchWithCdp(browser, port);
  return { ...result, browser: browser.name };
}
