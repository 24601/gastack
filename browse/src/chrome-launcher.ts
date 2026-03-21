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
  userDataDir: string;  // required for --remote-debugging-port
}

const HOME = process.env.HOME || '/tmp';
const APP_SUPPORT = `${HOME}/Library/Application Support`;

export const BROWSER_BINARIES: BrowserBinary[] = [
  { name: 'Comet',  binary: '/Applications/Comet.app/Contents/MacOS/Comet',                      appName: 'Comet',            aliases: ['comet', 'perplexity'],  userDataDir: `${APP_SUPPORT}/Comet` },
  { name: 'Chrome', binary: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',       appName: 'Google Chrome',    aliases: ['chrome', 'google-chrome'], userDataDir: `${APP_SUPPORT}/Google/Chrome` },
  { name: 'Arc',    binary: '/Applications/Arc.app/Contents/MacOS/Arc',                           appName: 'Arc',              aliases: ['arc'],                  userDataDir: `${APP_SUPPORT}/Arc/User Data` },
  { name: 'Brave',  binary: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',      appName: 'Brave Browser',    aliases: ['brave'],                userDataDir: `${APP_SUPPORT}/BraveSoftware/Brave-Browser` },
  { name: 'Edge',   binary: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',    appName: 'Microsoft Edge',   aliases: ['edge'],                 userDataDir: `${APP_SUPPORT}/Microsoft Edge` },
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

// ─── Runtime Detection ─────────────────────────────────────────

export type RuntimeEnv = 'conductor' | 'claude-code' | 'codex' | 'terminal';

/**
 * Detect the parent runtime environment.
 * Conductor and other Electron apps can't use osascript to quit other apps
 * due to macOS App Management security restrictions.
 */
export function detectRuntime(): RuntimeEnv {
  // Conductor detection — check FIRST because Conductor also has ANTHROPIC_API_KEY
  if (
    process.env.CONDUCTOR_WORKSPACE_NAME ||
    process.env.CONDUCTOR_BIN_DIR ||
    process.env.CONDUCTOR_PORT ||
    process.env.__CFBundleIdentifier === 'com.conductor.app'
  ) return 'conductor';
  // Claude Code terminal detection
  if (process.env.CLAUDE_CODE || process.env.ANTHROPIC_API_KEY) return 'claude-code';
  // Codex CLI detection
  if (process.env.CODEX_SESSION || process.env.OPENAI_API_KEY) return 'codex';
  return 'terminal';
}

/**
 * Whether the current runtime can safely quit/relaunch other macOS apps.
 * Electron apps (Conductor) trigger macOS App Management dialogs.
 * Terminal apps (iTerm, Terminal, Claude Code CLI) can do it freely.
 */
export function canManageApps(): boolean {
  const runtime = detectRuntime();
  // Terminal-based runtimes can use osascript freely
  // Electron-based runtimes (Conductor) trigger App Management dialogs
  return runtime === 'terminal' || runtime === 'claude-code' || runtime === 'codex';
}

// ─── Browser Launch with CDP ───────────────────────────────────

export interface LaunchResult {
  wsUrl: string;
  port: number;
}

export interface ManualRestartNeeded {
  needsManualRestart: true;
  browser: BrowserBinary;
  port: number;
  reason: string;
  command: string;  // The command the user needs to run
}

export type LaunchOutcome = LaunchResult | ManualRestartNeeded;

function isManualRestart(outcome: LaunchOutcome): outcome is ManualRestartNeeded {
  return 'needsManualRestart' in outcome;
}

/**
 * Launch or connect to a browser with CDP enabled.
 *
 * Three paths:
 * 1. Browser not running → launch with --remote-debugging-port (works everywhere)
 * 2. Browser running + runtime CAN manage apps → quit and relaunch (terminal/CLI)
 * 3. Browser running + runtime CANNOT manage apps → return ManualRestartNeeded
 *    with instructions for the user (Conductor/Electron)
 */
export async function launchWithCdp(
  browser: BrowserBinary,
  port: number = 9222,
): Promise<LaunchOutcome> {
  const wasRunning = isBrowserRunning(browser);

  if (wasRunning) {
    if (!canManageApps()) {
      // Can't quit Chrome from Conductor — macOS App Management blocks it
      const runtime = detectRuntime();
      return {
        needsManualRestart: true,
        browser,
        port,
        reason: runtime === 'conductor'
          ? `Conductor can't restart ${browser.name} due to macOS App Management security. You need to restart it manually.`
          : `This runtime can't restart ${browser.name}. You need to restart it manually.`,
        command: `"${browser.binary}" --remote-debugging-port=${port} --user-data-dir="${browser.userDataDir}" --restore-last-session`,
      };
    }

    // Terminal/CLI runtime — can quit and relaunch
    try {
      execSync(`osascript -e 'tell application "${browser.appName}" to quit'`, {
        stdio: 'pipe',
        timeout: 10000,
      });
    } catch {
      // osascript failed even from terminal — fall back to manual
      return {
        needsManualRestart: true,
        browser,
        port,
        reason: `Failed to quit ${browser.name} via osascript. You need to restart it manually.`,
        command: `"${browser.binary}" --remote-debugging-port=${port} --user-data-dir="${browser.userDataDir}" --restore-last-session`,
      };
    }

    // Wait for clean shutdown (Chrome with many tabs can take a while)
    await new Promise(resolve => setTimeout(resolve, 3000));

    // Verify it actually quit — wait up to 10s for processes to exit
    const quitStart = Date.now();
    while (Date.now() - quitStart < 10000) {
      if (!isBrowserRunning(browser)) break;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }

  // Launch with CDP flag + explicit user-data-dir (Chrome requires this for remote debugging)
  const child = spawn(browser.binary, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${browser.userDataDir}`,
    '--restore-last-session',
  ], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  // Poll for CDP availability (up to 30s — Chrome with many tabs takes time)
  const startTime = Date.now();
  while (Date.now() - startTime < 30000) {
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
    `CDP endpoint not available after 30s. ${browser.name} may not support --remote-debugging-port, ` +
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
export { isManualRestart };
export type { ManualRestartNeeded };

export async function discoverAndConnect(
  preferredBrowser?: string,
  port: number = 9222,
): Promise<{ wsUrl: string; port: number; browser: string } | ManualRestartNeeded> {
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

  // Step 3: Launch with CDP (may return ManualRestartNeeded)
  const result = await launchWithCdp(browser, port);
  if (isManualRestart(result)) {
    return result;  // Caller must handle manual restart flow
  }
  return { ...result, browser: browser.name };
}
