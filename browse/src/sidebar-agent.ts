/**
 * Sidebar Agent — watches sidebar-commands.jsonl, spawns claude -p for each
 * message, streams responses back to the sidebar via /sidebar-response.
 *
 * Usage: bun run browse/src/sidebar-agent.ts
 */

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const QUEUE = path.join(process.env.HOME || '/tmp', '.gstack', 'sidebar-commands.jsonl');
const CHAT = path.join(process.env.HOME || '/tmp', '.gstack', 'sidebar-chat.jsonl');
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

async function sendResponse(message: string): Promise<void> {
  if (!authToken) await refreshToken();
  if (!authToken) return;

  try {
    await fetch(`${SERVER_URL}/sidebar-response`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}`,
      },
      body: JSON.stringify({ message }),
    });
  } catch (err) {
    console.error('[sidebar-agent] Failed to send response:', err);
  }
}

// ─── Claude subprocess ───────────────────────────────────────────

async function askClaude(userMessage: string): Promise<string> {
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
    'You control a headless browser via the browse CLI.',
    '',
    `Browse binary: ${B}`,
    `${pageContext}`,
    '',
    'Available commands (run via bash):',
    `  ${B} goto <url>       — navigate to a URL`,
    `  ${B} click <@ref>     — click an element by ref`,
    `  ${B} fill <@ref> <text> — fill an input`,
    `  ${B} snapshot -i      — get interactive element refs`,
    `  ${B} text             — get page text content`,
    `  ${B} screenshot       — take a screenshot`,
    `  ${B} back / forward / reload`,
    `  ${B} status           — current URL and tab info`,
    '',
    'IMPORTANT:',
    '- Before clicking, always run snapshot -i first to get fresh refs.',
    '- Keep responses SHORT — they show in a narrow sidebar chat bubble.',
    '- Use markdown sparingly. No headers. Brief bullet points are ok.',
    '- If the user asks about page content, use `text` command.',
    '- You can also read/write files, run git commands, etc.',
  ].join('\n');

  const prompt = `${systemPrompt}\n\nUser says: ${userMessage}`;

  return new Promise((resolve, reject) => {
    const chunks: string[] = [];
    let fullText = '';

    const proc = spawn('claude', [
      '-p', prompt,
      '--output-format', 'stream-json',
      '--verbose',
    ], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    let currentAssistantText = '';

    proc.stdout.on('data', (data: Buffer) => {
      const lines = data.toString().split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const event = JSON.parse(line);
          // Collect assistant text from the stream
          if (event.type === 'assistant' && event.message?.content) {
            for (const block of event.message.content) {
              if (block.type === 'text') {
                currentAssistantText = block.text;
              }
            }
          }
          // Result event has the final text
          if (event.type === 'result' && event.result) {
            fullText = event.result;
          }
        } catch {
          // Not JSON, skip
        }
      }
    });

    proc.stderr.on('data', (data: Buffer) => {
      // Claude logs to stderr, ignore
    });

    proc.on('close', (code) => {
      resolve(fullText || currentAssistantText || '(no response)');
    });

    proc.on('error', (err) => {
      reject(err);
    });

    // Timeout after 60 seconds
    setTimeout(() => {
      proc.kill();
      resolve(fullText || currentAssistantText || '(timed out)');
    }, 60000);
  });
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
      const response = await askClaude(message);
      console.log(`[sidebar-agent] Response: "${response.slice(0, 100)}..."`);
      await sendResponse(response);
    } catch (err) {
      console.error(`[sidebar-agent] Error:`, err);
      await sendResponse(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

// ─── Main ────────────────────────────────────────────────────────

async function main() {
  // Ensure queue file exists
  const dir = path.dirname(QUEUE);
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(QUEUE)) fs.writeFileSync(QUEUE, '');

  // Start from current end of file
  lastLine = countLines();
  await refreshToken();

  console.log(`[sidebar-agent] Started. Watching ${QUEUE} from line ${lastLine}`);
  console.log(`[sidebar-agent] Browse binary: ${B}`);
  console.log(`[sidebar-agent] Server: ${SERVER_URL}`);

  // Poll loop
  setInterval(poll, POLL_MS);
}

main().catch(console.error);
