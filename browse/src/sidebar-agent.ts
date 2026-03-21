/**
 * Sidebar Agent — watches sidebar-commands.jsonl, spawns claude -p for each
 * message, streams live events back to the sidebar.
 *
 * Usage: BROWSE_BIN=/path/to/browse bun run browse/src/sidebar-agent.ts
 */

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const QUEUE = path.join(process.env.HOME || '/tmp', '.gstack', 'sidebar-commands.jsonl');
const SERVER_URL = 'http://127.0.0.1:34567';
const POLL_MS = 1500;
const B = process.env.BROWSE_BIN || path.resolve(__dirname, '../../.claude/skills/gstack/browse/dist/browse');

let lastLine = 0;
let authToken: string | null = null;

// ─── Auth ────────────────────────────────────────────────────────

async function refreshToken(): Promise<string | null> {
  try {
    const resp = await fetch(`${SERVER_URL}/health`, { signal: AbortSignal.timeout(3000) });
    if (!resp.ok) return null;
    const data = await resp.json() as any;
    authToken = data.token || null;
    return authToken;
  } catch {
    return null;
  }
}

// ─── Event streaming to sidebar ──────────────────────────────────

async function sendEvent(event: Record<string, any>): Promise<void> {
  if (!authToken) await refreshToken();
  if (!authToken) return;

  try {
    await fetch(`${SERVER_URL}/sidebar-event`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}`,
      },
      body: JSON.stringify(event),
    });
  } catch (err) {
    console.error('[sidebar-agent] Failed to send event:', err);
  }
}

// ─── Claude subprocess with live streaming ───────────────────────

async function askClaude(userMessage: string): Promise<void> {
  // Get current page context
  let pageContext = '';
  try {
    const statusResp = await fetch(`${SERVER_URL}/health`, { signal: AbortSignal.timeout(3000) });
    if (statusResp.ok) {
      const status = await statusResp.json() as any;
      pageContext = `Current browser: ${status.currentUrl || 'about:blank'} (${status.tabs || 1} tabs, mode: ${status.mode})`;
    }
  } catch {}

  const systemPrompt = [
    'You are a browser assistant running in a Chrome sidebar.',
    'You control a browser via the browse CLI.',
    '',
    `Browse binary: ${B}`,
    pageContext,
    '',
    'Available commands (run via bash):',
    `  ${B} goto <url>       — navigate`,
    `  ${B} click <@ref>     — click element`,
    `  ${B} fill <@ref> <text> — fill input`,
    `  ${B} snapshot -i      — get element refs`,
    `  ${B} text             — page text`,
    `  ${B} screenshot       — screenshot`,
    `  ${B} back / forward / reload`,
    `  ${B} status           — current URL`,
    '',
    'Rules:',
    '- Before clicking, run snapshot -i to get fresh refs.',
    '- Keep responses SHORT — narrow sidebar.',
    '- You can also read/write files, run git, etc.',
  ].join('\n');

  const prompt = `${systemPrompt}\n\nUser: ${userMessage}`;

  // Signal that Claude is starting
  await sendEvent({ type: 'agent_start' });

  return new Promise((resolve) => {
    const proc = spawn('claude', [
      '-p', prompt,
      '--output-format', 'stream-json',
      '--verbose',
      '--allowedTools', 'Bash,Read,Glob,Grep',
    ], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    let buffer = '';

    // Close stdin immediately so claude doesn't wait for input
    proc.stdin.end();

    proc.stdout.on('data', (data: Buffer) => {
      buffer += data.toString();
      const lines = buffer.split('\n');
      // Keep last potentially incomplete line in buffer
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          handleStreamEvent(event);
        } catch {
          // Not JSON
        }
      }
    });

    proc.stderr.on('data', (data: Buffer) => {
      console.error('[sidebar-agent] stderr:', data.toString().slice(0, 200));
    });

    proc.on('close', (code) => {
      console.log(`[sidebar-agent] claude exited with code ${code}`);
      // Process any remaining buffer
      if (buffer.trim()) {
        try {
          handleStreamEvent(JSON.parse(buffer));
        } catch {}
      }
      sendEvent({ type: 'agent_done' }).then(resolve);
    });

    proc.on('error', (err) => {
      sendEvent({ type: 'agent_error', error: err.message }).then(resolve);
    });

    // Timeout after 90 seconds
    setTimeout(() => {
      proc.kill();
      sendEvent({ type: 'agent_error', error: 'Timed out after 90s' }).then(resolve);
    }, 90000);
  });
}

async function handleStreamEvent(event: any): Promise<void> {
  console.log(`[sidebar-agent] event: ${event.type}`, event.type === 'result' ? event.result?.slice(0, 80) : '');
  // claude stream-json event types:
  // - { type: "assistant", message: { content: [{ type: "text", text: "..." }, { type: "tool_use", name: "...", input: {...} }] } }
  // - { type: "content_block_start", content_block: { type: "tool_use", name: "Bash", ... } }
  // - { type: "content_block_delta", delta: { type: "text_delta", text: "..." } }
  // - { type: "result", result: "final text", ... }

  if (event.type === 'assistant' && event.message?.content) {
    for (const block of event.message.content) {
      if (block.type === 'tool_use') {
        // Tool call starting
        await sendEvent({
          type: 'tool_use',
          tool: block.name,
          input: summarizeToolInput(block.name, block.input),
        });
      } else if (block.type === 'text' && block.text) {
        await sendEvent({
          type: 'text',
          text: block.text,
        });
      }
    }
  }

  if (event.type === 'content_block_start' && event.content_block) {
    if (event.content_block.type === 'tool_use') {
      await sendEvent({
        type: 'tool_use',
        tool: event.content_block.name,
        input: summarizeToolInput(event.content_block.name, event.content_block.input),
      });
    }
  }

  if (event.type === 'content_block_delta' && event.delta) {
    if (event.delta.type === 'text_delta' && event.delta.text) {
      await sendEvent({
        type: 'text_delta',
        text: event.delta.text,
      });
    }
  }

  if (event.type === 'result') {
    await sendEvent({
      type: 'result',
      text: event.result || '',
    });
  }
}

function shorten(str: string): string {
  return str
    .replace(new RegExp(B.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '$B')
    .replace(/\/Users\/[^/]+/g, '~')
    .replace(/\/conductor\/workspaces\/[^/]+\/[^/]+/g, '')
    .replace(/\.claude\/skills\/gstack\//g, '')
    .replace(/browse\/dist\/browse/g, '$B');
}

function summarizeToolInput(tool: string, input: any): string {
  if (!input) return '';
  if (tool === 'Bash' && input.command) {
    let cmd = shorten(input.command);
    return cmd.length > 80 ? cmd.slice(0, 80) + '…' : cmd;
  }
  if (tool === 'Read' && input.file_path) return shorten(input.file_path);
  if (tool === 'Edit' && input.file_path) return shorten(input.file_path);
  if (tool === 'Write' && input.file_path) return shorten(input.file_path);
  if (tool === 'Grep' && input.pattern) return `/${input.pattern}/`;
  if (tool === 'Glob' && input.pattern) return input.pattern;
  try { return shorten(JSON.stringify(input)).slice(0, 60); } catch { return ''; }
}

// ─── Poll loop ───────────────────────────────────────────────────

function countLines(): number {
  try {
    const content = fs.readFileSync(QUEUE, 'utf-8');
    return content.split('\n').filter(Boolean).length;
  } catch {
    return 0;
  }
}

function readLine(n: number): string | null {
  try {
    const lines = fs.readFileSync(QUEUE, 'utf-8').split('\n').filter(Boolean);
    return lines[n - 1] || null;
  } catch {
    return null;
  }
}

async function poll() {
  const current = countLines();
  if (current <= lastLine) return;

  while (lastLine < current) {
    lastLine++;
    const line = readLine(lastLine);
    if (!line) continue;

    let message: string;
    try {
      const parsed = JSON.parse(line);
      message = parsed.message;
    } catch {
      continue;
    }

    if (!message) continue;

    console.log(`[sidebar-agent] Processing: "${message}"`);

    try {
      await askClaude(message);
    } catch (err) {
      console.error(`[sidebar-agent] Error:`, err);
      await sendEvent({ type: 'agent_error', error: String(err) });
    }
  }
}

// ─── Main ────────────────────────────────────────────────────────

async function ensureStateFile(): Promise<string | null> {
  // Write a state file pointing to the CDP server so claude -p's $B commands
  // connect to the right browser (not a stale headless server).
  try {
    const resp = await fetch(`${SERVER_URL}/health`, { signal: AbortSignal.timeout(3000) });
    if (!resp.ok) return null;
    const data = await resp.json() as any;
    if (!data.token) return null;

    const stateDir = path.join(process.env.HOME || '/tmp', '.gstack', 'sidebar-agent');
    fs.mkdirSync(stateDir, { recursive: true });
    const stateFile = path.join(stateDir, 'browse.json');
    fs.writeFileSync(stateFile, JSON.stringify({
      pid: process.pid,
      port: 34567,
      token: data.token,
      startedAt: new Date().toISOString(),
      mode: 'cdp',
    }, null, 2));
    return stateFile;
  } catch {
    return null;
  }
}

async function main() {
  const dir = path.dirname(QUEUE);
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(QUEUE)) fs.writeFileSync(QUEUE, '');

  lastLine = countLines();
  await refreshToken();

  // Write a state file that points claude -p at the CDP server
  const stateFile = await ensureStateFile();
  if (stateFile) {
    // Set env so all claude -p subprocesses find the right browse server
    process.env.BROWSE_STATE_FILE = stateFile;
    console.log(`[sidebar-agent] State file: ${stateFile}`);
  }

  console.log(`[sidebar-agent] Started. Watching ${QUEUE} from line ${lastLine}`);
  console.log(`[sidebar-agent] Browse binary: ${B}`);
  console.log(`[sidebar-agent] Server: ${SERVER_URL}`);

  setInterval(poll, POLL_MS);
}

main().catch(console.error);
