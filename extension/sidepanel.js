/**
 * gstack browse — Side Panel
 *
 * Chat tab: two-way messaging with Claude Code via file queue.
 * Debug tabs: activity feed (SSE) + refs (REST).
 * Polls /sidebar-chat for new messages every 1s.
 */

const NAV_COMMANDS = new Set(['goto', 'back', 'forward', 'reload']);
const INTERACTION_COMMANDS = new Set(['click', 'fill', 'select', 'hover', 'type', 'press', 'scroll', 'wait', 'upload']);
const OBSERVE_COMMANDS = new Set(['snapshot', 'screenshot', 'diff', 'console', 'network', 'text', 'html', 'links', 'forms', 'accessibility', 'cookies', 'storage', 'perf']);

let lastId = 0;
let eventSource = null;
let serverUrl = null;
let chatLineCount = 0;
let chatPollInterval = null;

// ─── Chat ───────────────────────────────────────────────────────

const chatMessages = document.getElementById('chat-messages');
const commandInput = document.getElementById('command-input');
const sendBtn = document.getElementById('send-btn');
const commandHistory = [];
let historyIndex = -1;

function formatChatTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' });
}

function addChatBubble(entry) {
  // Remove welcome message on first real message
  const welcome = chatMessages.querySelector('.chat-welcome');
  if (welcome) welcome.remove();

  const bubble = document.createElement('div');
  bubble.className = `chat-bubble ${entry.role}`;

  let content = escapeHtml(entry.message);
  // Simple markdown-ish: wrap ```...``` in <pre>
  content = content.replace(/```([\s\S]*?)```/g, '<pre>$1</pre>');
  // Bold **text**
  content = content.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
  // Line breaks
  content = content.replace(/\n/g, '<br>');

  bubble.innerHTML = `${content}<span class="chat-time">${formatChatTime(entry.ts)}</span>`;
  chatMessages.appendChild(bubble);
  bubble.scrollIntoView({ behavior: 'smooth', block: 'end' });
}

async function sendMessage() {
  const msg = commandInput.value.trim();
  if (!msg) return;

  commandHistory.push(msg);
  historyIndex = commandHistory.length;
  commandInput.value = '';
  commandInput.disabled = true;
  sendBtn.disabled = true;

  const result = await new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'sidebar-command', message: msg }, resolve);
  });

  commandInput.disabled = false;
  sendBtn.disabled = false;
  commandInput.focus();

  if (result?.ok) {
    // Immediately poll to show the user's own message
    pollChat();
  } else {
    commandInput.classList.add('error');
    commandInput.placeholder = result?.error || 'Failed to send';
    setTimeout(() => {
      commandInput.classList.remove('error');
      commandInput.placeholder = 'Message Claude Code...';
    }, 2000);
  }
}

commandInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); sendMessage(); }
  if (e.key === 'ArrowUp') {
    e.preventDefault();
    if (historyIndex > 0) { historyIndex--; commandInput.value = commandHistory[historyIndex]; }
  }
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    if (historyIndex < commandHistory.length - 1) { historyIndex++; commandInput.value = commandHistory[historyIndex]; }
    else { historyIndex = commandHistory.length; commandInput.value = ''; }
  }
});

sendBtn.addEventListener('click', sendMessage);

// Poll for new chat messages
async function pollChat() {
  if (!serverUrl) return;
  try {
    const resp = await fetch(`${serverUrl}/sidebar-chat?after=${chatLineCount}`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!resp.ok) return;
    const data = await resp.json();
    if (data.entries && data.entries.length > 0) {
      for (const entry of data.entries) {
        addChatBubble(entry);
      }
      chatLineCount = data.total;
    }
  } catch {}
}

// ─── Debug Tabs ─────────────────────────────────────────────────

const debugToggle = document.getElementById('debug-toggle');
const debugTabs = document.getElementById('debug-tabs');
const closeDebug = document.getElementById('close-debug');
let debugOpen = false;

debugToggle.addEventListener('click', () => {
  debugOpen = !debugOpen;
  debugToggle.classList.toggle('active', debugOpen);
  debugTabs.style.display = debugOpen ? 'flex' : 'none';
  if (!debugOpen) {
    // Close debug panels, show chat
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    document.getElementById('tab-chat').classList.add('active');
    document.querySelectorAll('.debug-tabs .tab').forEach(t => t.classList.remove('active'));
  }
});

closeDebug.addEventListener('click', () => {
  debugOpen = false;
  debugToggle.classList.remove('active');
  debugTabs.style.display = 'none';
  document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
  document.getElementById('tab-chat').classList.add('active');
});

document.querySelectorAll('.debug-tabs .tab:not(.close-debug)').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.debug-tabs .tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(`tab-${tab.dataset.tab}`).classList.add('active');

    if (tab.dataset.tab === 'refs') fetchRefs();
  });
});

// ─── Activity Feed ──────────────────────────────────────────────

function getEntryClass(entry) {
  if (entry.status === 'error') return 'error';
  if (entry.type === 'command_start') return 'pending';
  const cmd = entry.command || '';
  if (NAV_COMMANDS.has(cmd)) return 'nav';
  if (INTERACTION_COMMANDS.has(cmd)) return 'interaction';
  if (OBSERVE_COMMANDS.has(cmd)) return 'observe';
  return '';
}

function formatTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

let pendingEntries = new Map();

function createEntryElement(entry) {
  const div = document.createElement('div');
  div.className = `activity-entry ${getEntryClass(entry)}`;
  div.setAttribute('role', 'article');
  div.tabIndex = 0;

  const argsText = entry.args ? entry.args.join(' ') : '';
  const statusIcon = entry.status === 'ok' ? '\u2713' : entry.status === 'error' ? '\u2717' : '';
  const statusClass = entry.status === 'ok' ? 'ok' : entry.status === 'error' ? 'err' : '';
  const duration = entry.duration ? `${entry.duration}ms` : '';

  div.innerHTML = `
    <div class="entry-header">
      <span class="entry-time">${formatTime(entry.timestamp)}</span>
      <span class="entry-command">${entry.command || entry.type}</span>
    </div>
    ${argsText ? `<div class="entry-args">${escapeHtml(argsText)}</div>` : ''}
    ${entry.type === 'command_end' ? `
      <div class="entry-status">
        <span class="${statusClass}">${statusIcon}</span>
        <span class="duration">${duration}</span>
      </div>
    ` : ''}
    ${entry.result ? `
      <div class="entry-detail">
        <div class="entry-result">${escapeHtml(entry.result)}</div>
      </div>
    ` : ''}
  `;

  div.addEventListener('click', () => div.classList.toggle('expanded'));
  return div;
}

function addEntry(entry) {
  const feed = document.getElementById('activity-feed');
  const empty = document.getElementById('empty-state');
  if (empty) empty.style.display = 'none';

  if (entry.type === 'command_end') {
    for (const [id, el] of pendingEntries) {
      if (el.querySelector('.entry-command')?.textContent === entry.command) {
        el.remove();
        pendingEntries.delete(id);
        break;
      }
    }
  }

  const el = createEntryElement(entry);
  feed.appendChild(el);
  if (entry.type === 'command_start') pendingEntries.set(entry.id, el);
  el.scrollIntoView({ behavior: 'smooth', block: 'end' });

  if (entry.url) document.getElementById('footer-url')?.textContent && (document.getElementById('footer-url').textContent = new URL(entry.url).hostname);
  lastId = Math.max(lastId, entry.id);
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ─── SSE Connection ─────────────────────────────────────────────

function connectSSE() {
  if (!serverUrl) return;
  if (eventSource) { eventSource.close(); eventSource = null; }

  const url = `${serverUrl}/activity/stream?after=${lastId}`;
  eventSource = new EventSource(url);

  eventSource.addEventListener('activity', (e) => {
    try { addEntry(JSON.parse(e.data)); } catch {}
  });

  eventSource.addEventListener('gap', (e) => {
    try {
      const data = JSON.parse(e.data);
      const feed = document.getElementById('activity-feed');
      const banner = document.createElement('div');
      banner.className = 'gap-banner';
      banner.textContent = `Missed ${data.availableFrom - data.gapFrom} events`;
      feed.appendChild(banner);
    } catch {}
  });
}

// ─── Refs Tab ───────────────────────────────────────────────────

async function fetchRefs() {
  if (!serverUrl) return;
  try {
    const resp = await fetch(`${serverUrl}/refs`, { signal: AbortSignal.timeout(3000) });
    if (!resp.ok) return;
    const data = await resp.json();

    const list = document.getElementById('refs-list');
    const empty = document.getElementById('refs-empty');
    const footer = document.getElementById('refs-footer');

    if (!data.refs || data.refs.length === 0) {
      empty.style.display = '';
      list.innerHTML = '';
      footer.textContent = '';
      return;
    }

    empty.style.display = 'none';
    list.innerHTML = data.refs.map(r => `
      <div class="ref-row">
        <span class="ref-id">${escapeHtml(r.ref)}</span>
        <span class="ref-role">${escapeHtml(r.role)}</span>
        <span class="ref-name">"${escapeHtml(r.name)}"</span>
      </div>
    `).join('');
    footer.textContent = `${data.refs.length} refs`;
  } catch {}
}

// ─── Server Discovery ───────────────────────────────────────────

function updateConnection(url) {
  serverUrl = url;
  if (url) {
    document.getElementById('footer-dot').className = 'dot connected';
    const port = new URL(url).port;
    document.getElementById('footer-port').textContent = `:${port}`;
    connectSSE();
    // Start chat polling
    if (chatPollInterval) clearInterval(chatPollInterval);
    chatPollInterval = setInterval(pollChat, 1000);
    pollChat();  // immediate first poll
  } else {
    document.getElementById('footer-dot').className = 'dot';
    document.getElementById('footer-port').textContent = '';
    if (chatPollInterval) { clearInterval(chatPollInterval); chatPollInterval = null; }
  }
}

// ─── Port Configuration ─────────────────────────────────────────

const portLabel = document.getElementById('footer-port');
const portInput = document.getElementById('port-input');

portLabel.addEventListener('click', () => {
  portLabel.style.display = 'none';
  portInput.style.display = '';
  chrome.runtime.sendMessage({ type: 'getPort' }, (resp) => {
    portInput.value = resp?.port || '';
    portInput.focus();
    portInput.select();
  });
});

function savePort() {
  const port = parseInt(portInput.value, 10);
  if (port > 0 && port < 65536) {
    chrome.runtime.sendMessage({ type: 'setPort', port });
  }
  portInput.style.display = 'none';
  portLabel.style.display = '';
}
portInput.addEventListener('blur', savePort);
portInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') savePort();
  if (e.key === 'Escape') { portInput.style.display = 'none'; portLabel.style.display = ''; }
});

chrome.runtime.sendMessage({ type: 'getServerUrl' }, (resp) => {
  if (resp && resp.url) updateConnection(resp.url);
});

// ─── Message Listener ───────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'health') {
    chrome.runtime.sendMessage({ type: 'getServerUrl' }, (resp) => {
      updateConnection(msg.data ? resp?.url : null);
    });
  }
  if (msg.type === 'refs') {
    if (document.querySelector('.tab[data-tab="refs"].active')) {
      fetchRefs();
    }
  }
});
