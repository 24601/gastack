/**
 * gstack browse — background service worker
 *
 * Polls /health every 10s to detect browse server.
 * Fetches /refs on snapshot completion, relays to content script.
 * Updates badge: green (connected), gray (disconnected).
 */

let serverPort = null;
let isConnected = false;
let healthInterval = null;

// ─── Port Discovery ────────────────────────────────────────────

async function loadPort() {
  const data = await chrome.storage.local.get('port');
  serverPort = data.port || null;
  return serverPort;
}

async function savePort(port) {
  serverPort = port;
  await chrome.storage.local.set({ port });
}

function getBaseUrl() {
  return serverPort ? `http://127.0.0.1:${serverPort}` : null;
}

// ─── Health Polling ────────────────────────────────────────────

async function checkHealth() {
  const base = getBaseUrl();
  if (!base) {
    setDisconnected();
    return;
  }

  try {
    const resp = await fetch(`${base}/health`, { signal: AbortSignal.timeout(3000) });
    if (!resp.ok) { setDisconnected(); return; }
    const data = await resp.json();
    if (data.status === 'healthy') {
      setConnected(data);
    } else {
      setDisconnected();
    }
  } catch {
    setDisconnected();
  }
}

function setConnected(healthData) {
  const wasDisconnected = !isConnected;
  isConnected = true;
  chrome.action.setBadgeBackgroundColor({ color: '#4ade80' });
  chrome.action.setBadgeText({ text: ' ' });

  // Broadcast health to popup and side panel
  chrome.runtime.sendMessage({ type: 'health', data: healthData }).catch(() => {});

  // Notify content scripts on connection change
  if (wasDisconnected) {
    notifyContentScripts('connected');
  }
}

function setDisconnected() {
  const wasConnected = isConnected;
  isConnected = false;
  chrome.action.setBadgeText({ text: '' });

  chrome.runtime.sendMessage({ type: 'health', data: null }).catch(() => {});

  // Notify content scripts on disconnection
  if (wasConnected) {
    notifyContentScripts('disconnected');
  }
}

async function notifyContentScripts(type) {
  try {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      if (tab.id) {
        chrome.tabs.sendMessage(tab.id, { type }).catch(() => {});
      }
    }
  } catch {}
}

// ─── Refs Relay ─────────────────────────────────────────────────

async function fetchAndRelayRefs() {
  const base = getBaseUrl();
  if (!base || !isConnected) return;

  try {
    const resp = await fetch(`${base}/refs`, { signal: AbortSignal.timeout(3000) });
    if (!resp.ok) return;
    const data = await resp.json();

    // Send to all tabs' content scripts
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      if (tab.id) {
        chrome.tabs.sendMessage(tab.id, { type: 'refs', data }).catch(() => {});
      }
    }
  } catch {}
}

// ─── Message Handling ──────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'getPort') {
    sendResponse({ port: serverPort, connected: isConnected });
    return true;
  }

  if (msg.type === 'setPort') {
    savePort(msg.port).then(() => {
      checkHealth();
      sendResponse({ ok: true });
    });
    return true;
  }

  if (msg.type === 'getServerUrl') {
    sendResponse({ url: getBaseUrl() });
    return true;
  }

  if (msg.type === 'fetchRefs') {
    fetchAndRelayRefs().then(() => sendResponse({ ok: true }));
    return true;
  }
});

// ─── Side Panel ─────────────────────────────────────────────────

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});

// ─── Startup ────────────────────────────────────────────────────

loadPort().then(() => {
  checkHealth();
  healthInterval = setInterval(checkHealth, 10000);
});
