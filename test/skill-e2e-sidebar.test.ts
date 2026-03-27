/**
 * Layer 4: E2E tests for the sidebar agent with real Claude.
 * Starts browse server + fixture server + sidebar-agent, POSTs to /sidebar-command
 * (simulating what the Chrome extension does), and verifies Claude actually processes
 * the request and responds through the chat buffer.
 *
 * These tests cost ~$0.80 total and run as periodic tier.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { spawn, type Subprocess } from 'bun';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  ROOT, evalsEnabled,
  describeIfSelected, testConcurrentIfSelected,
  logCost, recordE2E,
  createEvalCollector, finalizeEvalCollector,
} from './helpers/e2e-helpers';
import { startTestServer } from '../browse/test/test-server';

const evalCollector = createEvalCollector('e2e-sidebar');

// --- Sidebar Agent E2E ---

describeIfSelected('Sidebar agent E2E', ['sidebar-navigate', 'sidebar-url-accuracy'], () => {
  let serverProc: Subprocess | null = null;
  let agentProc: Subprocess | null = null;
  let fixtureServer: { server: ReturnType<typeof Bun.serve>; url: string } | null = null;
  let serverPort: number = 0;
  let authToken: string = '';
  let tmpDir: string = '';
  let stateFile: string = '';
  let queueFile: string = '';

  async function api(pathname: string, opts: RequestInit = {}): Promise<Response> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(opts.headers as Record<string, string> || {}),
    };
    if (!headers['Authorization'] && authToken) {
      headers['Authorization'] = `Bearer ${authToken}`;
    }
    return fetch(`http://127.0.0.1:${serverPort}${pathname}`, { ...opts, headers });
  }

  async function resetState() {
    await api('/sidebar-session/new', { method: 'POST' });
    fs.writeFileSync(queueFile, '');
  }

  async function pollChatUntil(
    predicate: (entries: any[]) => boolean,
    timeoutMs = 60000,
  ): Promise<any[]> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const resp = await api('/sidebar-chat?after=0');
      const data = await resp.json();
      if (predicate(data.entries)) return data.entries;
      await new Promise(r => setTimeout(r, 2000));
    }
    const resp = await api('/sidebar-chat?after=0');
    return (await resp.json()).entries;
  }

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidebar-e2e-'));
    stateFile = path.join(tmpDir, 'browse.json');
    queueFile = path.join(tmpDir, 'sidebar-queue.jsonl');
    fs.mkdirSync(path.dirname(queueFile), { recursive: true });

    // Start fixture server for test pages
    fixtureServer = startTestServer(0);

    // Start browse server (no browser — sidebar agent uses `browse` commands
    // which will fail without a browser, but we're testing the message flow)
    const serverScript = path.resolve(ROOT, 'browse', 'src', 'server.ts');
    serverProc = spawn(['bun', 'run', serverScript], {
      env: {
        ...process.env,
        BROWSE_STATE_FILE: stateFile,
        BROWSE_HEADLESS_SKIP: '1',
        BROWSE_PORT: '0',
        SIDEBAR_QUEUE_PATH: queueFile,
        BROWSE_IDLE_TIMEOUT: '300',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // Wait for server
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (fs.existsSync(stateFile)) {
        try {
          const state = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
          if (state.port && state.token) {
            serverPort = state.port;
            authToken = state.token;
            break;
          }
        } catch {}
      }
      await new Promise(r => setTimeout(r, 100));
    }
    if (!serverPort) throw new Error('Server did not start in time');

    // Start sidebar-agent with real claude
    const agentScript = path.resolve(ROOT, 'browse', 'src', 'sidebar-agent.ts');
    const browseBin = path.resolve(ROOT, 'browse', 'dist', 'browse');
    agentProc = spawn(['bun', 'run', agentScript], {
      env: {
        ...process.env,
        BROWSE_SERVER_PORT: String(serverPort),
        BROWSE_STATE_FILE: stateFile,
        SIDEBAR_QUEUE_PATH: queueFile,
        SIDEBAR_AGENT_TIMEOUT: '120000',
        BROWSE_BIN: fs.existsSync(browseBin) ? browseBin : 'browse',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    await new Promise(r => setTimeout(r, 1500));
  }, 25000);

  afterAll(async () => {
    if (agentProc) { try { agentProc.kill(); } catch {} }
    if (serverProc) { try { serverProc.kill(); } catch {} }
    if (fixtureServer) { try { fixtureServer.server.stop(); } catch {} }
    finalizeEvalCollector(evalCollector);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  testConcurrentIfSelected('sidebar-navigate', async () => {
    await resetState();
    const startTime = Date.now();

    // Ask Claude to describe the page at the fixture URL
    const fixtureUrl = `${fixtureServer!.url}/basic.html`;
    const resp = await api('/sidebar-command', {
      method: 'POST',
      body: JSON.stringify({
        message: `What is the title of the page at ${fixtureUrl}? Just tell me the title text, nothing else.`,
        activeTabUrl: fixtureUrl,
      }),
    });
    expect(resp.status).toBe(200);

    // Wait for Claude to finish (agent_done)
    const entries = await pollChatUntil(
      (entries) => entries.some((e: any) => e.type === 'agent_done'),
      90000,
    );

    const duration = Date.now() - startTime;
    const doneEntry = entries.find((e: any) => e.type === 'agent_done');
    expect(doneEntry).toBeDefined();

    // Claude should have responded with something about the page
    const agentEntries = entries.filter((e: any) => e.role === 'agent' && (e.type === 'text' || e.type === 'result'));
    expect(agentEntries.length).toBeGreaterThan(0);

    // Check that Claude mentioned the page title or content
    const allText = agentEntries.map((e: any) => e.text || '').join(' ').toLowerCase();
    const mentionsPage = allText.includes('test page') || allText.includes('basic') || allText.includes('hello');

    recordE2E(evalCollector, 'sidebar-navigate', 'Sidebar agent E2E', {
      exitReason: doneEntry ? 'success' : 'timeout',
      durationMs: duration,
      toolCalls: entries.filter((e: any) => e.type === 'tool_use').length,
      cost: 0, // we can't easily measure cost from chat entries
    } as any);

    expect(mentionsPage).toBe(true);
  }, 120_000);

  testConcurrentIfSelected('sidebar-url-accuracy', async () => {
    await resetState();

    // POST with an activeTabUrl that differs from any Playwright URL
    const fakeExtensionUrl = `${fixtureServer!.url}/forms.html`;
    const resp = await api('/sidebar-command', {
      method: 'POST',
      body: JSON.stringify({
        message: 'What URL am I on?',
        activeTabUrl: fakeExtensionUrl,
      }),
    });
    expect(resp.status).toBe(200);

    // Verify the queue entry has the extension URL, not the Playwright URL
    await new Promise(r => setTimeout(r, 200));
    const queueContent = fs.readFileSync(queueFile, 'utf-8').trim();
    const lines = queueContent.split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    const lastEntry = JSON.parse(lines[lines.length - 1]);

    // The prompt should contain the extension URL
    expect(lastEntry.pageUrl).toBe(fakeExtensionUrl);
    expect(lastEntry.prompt).toContain(fakeExtensionUrl);
    // Should NOT contain 'about:blank' (the no-browser fallback)
    expect(lastEntry.pageUrl).not.toBe('about:blank');

    recordE2E(evalCollector, 'sidebar-url-accuracy', 'Sidebar agent E2E', {
      exitReason: 'success',
      durationMs: 0,
      toolCalls: 0,
      cost: 0,
    } as any);

    // Kill the agent so it doesn't keep running
    await api('/sidebar-agent/kill', { method: 'POST' });
  }, 30_000);
});
