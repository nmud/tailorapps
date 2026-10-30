// Tailor Observer: turns tab focus into time segments and forwards them, with copy/paste
// counts, to the Tailor desktop app at 127.0.0.1:47821. Nothing leaves this computer.

const ENDPOINT = 'http://127.0.0.1:47821/v1';
const HEADERS = { 'content-type': 'application/json', 'x-tailor-client': 'extension' };
const MIN_SEGMENT_MS = 3000;
const SLICE_MS = 5 * 60_000;
const MAX_QUEUE = 2000;

const SEARCH_ENGINES = [
  { host: /^scholar\.google\.[a-z.]+$/, path: /^\/scholar/, param: 'q' },
  { host: /(^|\.)google\.[a-z.]+$/, path: /^\/search/, param: 'q' },
  { host: /(^|\.)bing\.com$/, path: /^\/search/, param: 'q' },
  { host: /(^|\.)duckduckgo\.com$/, path: /^\/$/, param: 'q' },
  { host: /(^|\.)github\.com$/, path: /^\/search/, param: 'q' },
  { host: /(^|\.)stackoverflow\.com$/, path: /^\/search/, param: 'q' },
];

// Service workers sleep; keep state in session storage so nothing is lost between wakes.
async function getSession() {
  const s = await chrome.storage.session.get(['current', 'queue']);
  return { current: s.current ?? null, queue: s.queue ?? [] };
}

async function getConfig() {
  const c = await chrome.storage.local.get(['paused', 'server', 'sentToday', 'sentDay']);
  return { paused: !!c.paused, server: c.server ?? null, sentToday: c.sentToday ?? 0, sentDay: c.sentDay ?? '' };
}

function parse(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u : null;
  } catch {
    return null;
  }
}

const hostOf = (u) => u.hostname.replace(/^www\./, '');

async function enqueue(events) {
  const { paused, server } = await getConfig();
  if (paused || (server && server.connected && server.learning === false)) return;
  const { queue } = await getSession();
  const next = [...queue, ...events].slice(-MAX_QUEUE);
  await chrome.storage.session.set({ queue: next });
  if (next.length >= 25) flush();
}

async function closeCurrent(now = Date.now()) {
  const { current } = await getSession();
  if (!current) return;
  await chrome.storage.session.set({ current: null });
  const durationMs = now - current.start;
  if (durationMs >= MIN_SEGMENT_MS) {
    await enqueue([{ ts: current.start, kind: 'focus', domain: current.domain, title: current.title, url: current.url, durationMs }]);
  }
}

async function focusTab(tab) {
  const now = Date.now();
  await closeCurrent(now);
  if (!tab || tab.incognito || !tab.url) return;
  const u = parse(tab.url);
  if (!u) return;
  await chrome.storage.session.set({
    current: { tabId: tab.id, domain: hostOf(u), title: tab.title ?? '', url: u.origin + u.pathname, start: now },
  });
}

async function maybeSearch(tab) {
  const u = parse(tab.url ?? '');
  if (!u) return;
  const engine = SEARCH_ENGINES.find((e) => e.host.test(u.hostname) && e.path.test(u.pathname));
  const q = engine && u.searchParams.get(engine.param);
  if (!q) return;
  const { server } = await getConfig();
  await enqueue([{ ts: Date.now(), kind: 'search', domain: hostOf(u), title: server?.includeSearchTerms ? q : null, durationMs: 0 }]);
}

async function refocusActive() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tab) await focusTab(tab);
}

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    await focusTab(await chrome.tabs.get(tabId));
  } catch {
    // tab already closed
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (!tab.active) return;
  if (info.url) {
    await focusTab(tab);
    await maybeSearch(tab);
  } else if (info.title) {
    const { current } = await getSession();
    if (current && current.tabId === tabId) await chrome.storage.session.set({ current: { ...current, title: info.title } });
  }
});

chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) await closeCurrent();
  else await refocusActive();
});

chrome.idle.setDetectionInterval(120);
chrome.idle.onStateChanged.addListener(async (state) => {
  if (state === 'active') await refocusActive();
  else await closeCurrent();
});

chrome.runtime.onMessage.addListener((msg, sender) => {
  const tab = sender.tab;
  if (!tab || tab.incognito || !['copy', 'paste'].includes(msg?.type)) return;
  const u = parse(tab.url ?? '');
  if (!u) return;
  const meta = { chars: Math.min(Number(msg.chars) || 0, 1_000_000) };
  if (msg.type === 'paste' && typeof msg.target === 'string') meta.target = msg.target.slice(0, 12);
  enqueue([{ ts: Date.now(), kind: msg.type, domain: hostOf(u), title: tab.title ?? '', durationMs: 0, meta }]);
});

// ── open tabs ───────────────────────────────────────────────────────────────
// Tailor keeps the live list in memory only, for apps the person allowed to see it.
// Every few minutes of active use it also notes sites with many tabs open (counts and a few titles).

const TAB_NOTE_MS = 5 * 60_000;
const TAB_CLUTTER = 3;

async function openTabs() {
  return (await chrome.tabs.query({})).filter((t) => !t.incognito && parse(t.url ?? ''));
}

async function sendLiveTabs() {
  const { paused, server } = await getConfig();
  if (paused || !server?.connected || !server.learning) return;
  const tabs = await openTabs();
  await fetch(`${ENDPOINT}/tabs`, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify({
      tabs: tabs.map((t) => ({ title: t.title ?? null, url: t.url, windowId: t.windowId, active: t.active, lastAccessed: t.lastAccessed ?? 0 })),
    }),
  }).catch(() => {});
}

let liveTimer = null;
function liveTabsSoon() {
  clearTimeout(liveTimer);
  liveTimer = setTimeout(sendLiveTabs, 1500);
}
chrome.tabs.onCreated.addListener(liveTabsSoon);
chrome.tabs.onRemoved.addListener(liveTabsSoon);
chrome.tabs.onUpdated.addListener((_id, info) => {
  if (info.url || info.title) liveTabsSoon();
});

async function noteTabClutter() {
  if ((await chrome.idle.queryState(120)) !== 'active') return;
  const { lastTabNote = 0 } = await chrome.storage.session.get('lastTabNote');
  if (Date.now() - lastTabNote < TAB_NOTE_MS) return;
  await chrome.storage.session.set({ lastTabNote: Date.now() });
  const bySite = new Map();
  for (const t of await openTabs()) {
    const site = hostOf(parse(t.url));
    if (!bySite.has(site)) bySite.set(site, []);
    bySite.get(site).push(t.title ?? '');
  }
  const events = [...bySite]
    .filter(([, titles]) => titles.length >= TAB_CLUTTER)
    .map(([domain, titles]) => ({
      ts: Date.now(),
      kind: 'tabs',
      domain,
      title: titles.filter(Boolean).slice(0, 3).join(' · '),
      durationMs: 0,
      meta: { tabCount: titles.length },
    }));
  if (events.length) await enqueue(events);
}

let flushing = false;

async function flush() {
  if (flushing) return;
  flushing = true;
  try {
    await noteTabClutter();
    sendLiveTabs();
    // Report long focus in slices so the app sees ongoing work.
    const { current } = await getSession();
    if (current && Date.now() - current.start > SLICE_MS) {
      await closeCurrent();
      await refocusActive();
    }
    const { queue } = await getSession();
    const batch = queue.slice(0, 500);
    const res = batch.length
      ? await fetch(`${ENDPOINT}/events`, { method: 'POST', headers: HEADERS, body: JSON.stringify({ events: batch }) })
      : await fetch(`${ENDPOINT}/status`, { headers: HEADERS });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const server = await res.json();
    if (batch.length) {
      const { queue: latest } = await getSession();
      await chrome.storage.session.set({ queue: latest.slice(batch.length) });
    }
    const c = await getConfig();
    const today = new Date().toDateString();
    const sentToday = (c.sentDay === today ? c.sentToday : 0) + (server.accepted ?? 0);
    await chrome.storage.local.set({ server: { ...server, connected: true, lastOk: Date.now() }, sentToday, sentDay: today });
  } catch {
    const c = await getConfig();
    await chrome.storage.local.set({ server: { ...(c.server ?? {}), connected: false } });
  } finally {
    flushing = false;
  }
}

chrome.alarms.create('flush', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'flush') flush();
});
chrome.runtime.onStartup.addListener(() => flush());
chrome.runtime.onInstalled.addListener(() => {
  refocusActive();
  flush();
});
