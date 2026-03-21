/**
 * gstack browse — Side Panel
 *
 * Connects to browse server SSE stream for live activity.
 * Fetches /refs for the Refs tab.
 * Cursor-based replay ensures no missed events on reconnect.
 */

const NAV_COMMANDS = new Set(['goto', 'back', 'forward', 'reload']);
const INTERACTION_COMMANDS = new Set(['click', 'fill', 'select', 'hover', 'type', 'press', 'scroll', 'wait', 'upload']);
const OBSERVE_COMMANDS = new Set(['snapshot', 'screenshot', 'diff', 'console', 'network', 'text', 'html', 'links', 'forms', 'accessibility', 'cookies', 'storage', 'perf']);

let lastId = 0;
let eventSource = null;
let serverUrl = null;
let pendingEntries = new Map(); // id → entry element (for command_start without command_end)

// ─── Tab Switching ─────────────────────────────────────────────

document.querySelectorAll('.tab:not(.disabled)').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => { t.classList.remove('active'); t.setAttribute('aria-selected', 'false'); });
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    tab.classList.add('active');
    tab.setAttribute('aria-selected', 'true');
    document.getElementById(`tab-${tab.dataset.tab}`).classList.add('active');

    if (tab.dataset.tab === 'refs') fetchRefs();
  });
});

// ─── Activity Feed ─────────────────────────────────────────────

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

  // Click to expand/collapse
  div.addEventListener('click', () => div.classList.toggle('expanded'));
  div.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') div.classList.toggle('expanded');
    if (e.key === 'Escape') div.classList.remove('expanded');
  });

  // Screen reader label
  const srLabel = `${entry.command || entry.type} ${argsText} ${statusIcon ? (entry.status === 'ok' ? 'succeeded' : 'failed') : 'in progress'} ${duration ? 'in ' + duration : ''}`;
  div.setAttribute('aria-label', srLabel);

  return div;
}

function addEntry(entry) {
  const feed = document.getElementById('activity-feed');
  const empty = document.getElementById('empty-state');
  if (empty) empty.style.display = 'none';

  // If command_end, update the matching pending entry
  if (entry.type === 'command_end') {
    // Remove the pending command_start for this command
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

  if (entry.type === 'command_start') {
    pendingEntries.set(entry.id, el);
  }

  // Auto-scroll
  el.scrollIntoView({ behavior: 'smooth', block: 'end' });

  // Update footer
  if (entry.url) document.getElementById('footer-url').textContent = new URL(entry.url).hostname;
  const parts = [];
  if (entry.tabs) parts.push(`${entry.tabs} tabs`);
  if (entry.mode) parts.push(entry.mode);
  if (parts.length) document.getElementById('footer-info').textContent = parts.join(' \u00b7 ');

  lastId = Math.max(lastId, entry.id);
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ─── SSE Connection ────────────────────────────────────────────

function connectSSE() {
  if (!serverUrl) return;

  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }

  const url = `${serverUrl}/activity/stream?after=${lastId}`;
  eventSource = new EventSource(url);

  eventSource.addEventListener('activity', (e) => {
    try {
      const entry = JSON.parse(e.data);
      addEntry(entry);
    } catch {}
  });

  eventSource.addEventListener('gap', (e) => {
    try {
      const data = JSON.parse(e.data);
      const feed = document.getElementById('activity-feed');
      const banner = document.createElement('div');
      banner.className = 'gap-banner';
      banner.textContent = `Missed ${data.availableFrom - data.gapFrom} events (buffer overflow)`;
      feed.appendChild(banner);
    } catch {}
  });

  eventSource.onerror = () => {
    // EventSource auto-reconnects
  };
}

// ─── Refs Tab ──────────────────────────────────────────────────

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
    footer.textContent = `${data.refs.length} refs \u00b7 ${data.url ? new URL(data.url).hostname : ''}`;
  } catch {}
}

// ─── Server Discovery ──────────────────────────────────────────

function updateConnection(url) {
  serverUrl = url;
  if (url) {
    document.getElementById('header-dot').className = 'dot connected';
    const port = new URL(url).port;
    document.getElementById('header-port').textContent = `:${port}`;
    connectSSE();
  } else {
    document.getElementById('header-dot').className = 'dot';
    document.getElementById('header-port').textContent = '';
  }
}

chrome.runtime.sendMessage({ type: 'getServerUrl' }, (resp) => {
  if (resp && resp.url) updateConnection(resp.url);
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'health') {
    chrome.runtime.sendMessage({ type: 'getServerUrl' }, (resp) => {
      updateConnection(msg.data ? resp?.url : null);
    });
  }
  if (msg.type === 'refs') {
    // Auto-refresh refs tab if visible
    if (document.querySelector('.tab[data-tab="refs"].active')) {
      fetchRefs();
    }
  }
});
