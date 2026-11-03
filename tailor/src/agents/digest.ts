// Turns raw events into sessions and countable signals. Every number a user ever sees
// in an explanation ("…across 6 of 7 sessions") is computed here, never by a model.

import type { ActivityEvent, Signal } from '../lib/types';
import { formatDuration, shortDate, clockTime } from '../lib/util';

const SESSION_GAP_MS = 25 * 60_000;
const PASTE_WINDOW_MS = 3 * 60_000;
const FOCUS_WINDOW_MS = 90_000;
const BROWSERS = new Set(['chrome', 'msedge', 'firefox', 'brave', 'opera', 'vivaldi', 'arc']);

const FRIENDLY: Record<string, string> = {
  code: 'VS Code',
  'code - insiders': 'VS Code',
  cursor: 'Cursor',
  obsidian: 'Obsidian',
  notion: 'Notion',
  logseq: 'Logseq',
  winword: 'Word',
  excel: 'Excel',
  powerpnt: 'PowerPoint',
  onenote: 'OneNote',
  chrome: 'Chrome',
  msedge: 'Edge',
  firefox: 'Firefox',
  brave: 'Brave',
  windowsterminal: 'Terminal',
  wt: 'Terminal',
  powershell: 'PowerShell',
  pwsh: 'PowerShell',
  cmd: 'Command Prompt',
  zotero: 'Zotero',
  mendeley: 'Mendeley',
  acrobat: 'Acrobat',
  acrord32: 'Acrobat Reader',
  sumatrapdf: 'SumatraPDF',
  figma: 'Figma',
  spotify: 'Spotify',
  slack: 'Slack',
  discord: 'Discord',
  'ms-teams': 'Teams',
  teams: 'Teams',
  olk: 'Outlook',
  outlook: 'Outlook',
  notepad: 'Notepad',
  'notepad++': 'Notepad++',
  idea64: 'IntelliJ IDEA',
  pycharm64: 'PyCharm',
  devenv: 'Visual Studio',
  rstudio: 'RStudio',
  anki: 'Anki',
  blender: 'Blender',
  robloxstudiobeta: 'Roblox Studio',
  obs64: 'OBS',
  claude: 'Claude',
  chatgpt: 'ChatGPT',
  warp: 'Warp',
  alacritty: 'Alacritty',
  wezterm: 'WezTerm',
  'wezterm-gui': 'WezTerm',
};

export function friendlyApp(exe: string): string {
  const key = exe.toLowerCase();
  return FRIENDLY[key] ?? key.charAt(0).toUpperCase() + key.slice(1);
}

export function contextOf(e: Pick<ActivityEvent, 'domain' | 'app' | 'title'>): string | null {
  if (e.domain) {
    if (e.domain === 'docs.google.com') {
      const t = e.title ?? '';
      if (/Google Sheets/i.test(t)) return 'Google Sheets';
      if (/Google Docs/i.test(t)) return 'Google Docs';
      if (/Google Slides/i.test(t)) return 'Google Slides';
      return 'Google Docs';
    }
    return e.domain;
  }
  if (e.app) return friendlyApp(e.app);
  return null;
}

export interface Session {
  index: number;
  start: number;
  end: number;
  events: ActivityEvent[];
  dwell: Map<string, number>;
  titles: Map<string, Set<string>>;
}

export interface Digest {
  sessions: Session[];
  signals: Signal[];
  dwellTotals: { context: string; ms: number; sessions: number }[];
  activeMs: number;
  from: number;
  to: number;
  sourceCounts: Record<string, number>;
  text: string;
}

function sessionize(events: ActivityEvent[]): Session[] {
  const sorted = [...events].sort((a, b) => a.ts - b.ts);
  const sessions: Session[] = [];
  let cur: ActivityEvent[] = [];
  let lastEnd = -Infinity;
  for (const e of sorted) {
    if (cur.length && e.ts - lastEnd > SESSION_GAP_MS) {
      sessions.push(makeSession(sessions.length, cur));
      cur = [];
    }
    cur.push(e);
    lastEnd = Math.max(lastEnd, e.ts + (e.durationMs || 0));
  }
  if (cur.length) sessions.push(makeSession(sessions.length, cur));
  return sessions;
}

function makeSession(index: number, raw: ActivityEvent[]): Session {
  // When the extension reported browser detail, drop the coarser desktop view of the same browser.
  const hasExtension = raw.some((e) => e.source === 'extension' || (e.source === 'demo' && e.domain));
  const events = hasExtension
    ? raw.filter((e) => !(e.source === 'desktop' && e.app && BROWSERS.has(e.app)))
    : raw;
  const dwell = new Map<string, number>();
  const titles = new Map<string, Set<string>>();
  let end = 0;
  for (const e of events) {
    end = Math.max(end, e.ts + (e.durationMs || 0));
    const ctx = contextOf(e);
    if (!ctx) continue;
    if (e.kind === 'focus') dwell.set(ctx, (dwell.get(ctx) ?? 0) + e.durationMs);
    if (e.title && e.kind !== 'search') {
      if (!titles.has(ctx)) titles.set(ctx, new Set());
      titles.get(ctx)!.add(e.title);
    }
  }
  return { index, start: events[0]?.ts ?? 0, end, events, dwell, titles };
}

interface Tally {
  occurrences: number;
  sessions: Set<number>;
  lastSeen: number;
  allDemo: boolean;
  contexts: string[];
}

function bump(map: Map<string, Tally>, key: string, contexts: string[], session: number, ts: number, demo: boolean, n = 1) {
  const t = map.get(key) ?? { occurrences: 0, sessions: new Set<number>(), lastSeen: 0, allDemo: true, contexts };
  t.occurrences += n;
  t.sessions.add(session);
  t.lastSeen = Math.max(t.lastSeen, ts);
  t.allDemo = t.allDemo && demo;
  map.set(key, t);
}

const SNAPSHOT_KINDS = new Set(['tabs', 'windows', 'setup']);
const TAB_CLUTTER = 5;
const WINDOW_CLUTTER = 3;
const SETUP_CLUTTER = 5;

/** "Lots of things open or set up at once": tab and window snapshots, and AI tool setup. */
function clutterSignals(snapshots: ActivityEvent[], sessions: Session[]): Signal[] {
  const total = sessions.length;
  const near = (ts: number) => sessions.find((s) => ts >= s.start - 5 * 60_000 && ts <= s.end + 5 * 60_000);
  const groups = new Map<string, { kind: 'tabs' | 'windows'; ctx: string; max: number; sessions: Map<number, number>; last: number; demo: boolean; titles: Set<string> }>();

  for (const e of snapshots) {
    if (e.kind !== 'tabs' && e.kind !== 'windows') continue;
    const ctx = contextOf(e);
    const count = Number(e.meta?.[e.kind === 'tabs' ? 'tabCount' : 'windowCount'] ?? 0);
    if (!ctx || !count) continue;
    const key = `${e.kind}:${ctx}`;
    const g = groups.get(key) ?? { kind: e.kind, ctx, max: 0, sessions: new Map(), last: 0, demo: true, titles: new Set<string>() };
    g.max = Math.max(g.max, count);
    g.last = Math.max(g.last, e.ts);
    g.demo = g.demo && e.source === 'demo';
    for (const t of (e.title ?? '').split(' · ').filter(Boolean)) if (g.titles.size < 6) g.titles.add(t);
    const s = near(e.ts);
    if (s) g.sessions.set(s.index, Math.max(g.sessions.get(s.index) ?? 0, count));
    groups.set(key, g);
  }

  const out: Signal[] = [];
  for (const [id, g] of groups) {
    const threshold = g.kind === 'tabs' ? TAB_CLUTTER : WINDOW_CLUTTER;
    const busy = [...g.sessions.values()].filter((n) => n >= threshold).length;
    if (busy < 2 && g.max < threshold * 2) continue;
    out.push({
      id,
      kind: g.kind,
      label: `${g.kind === 'tabs' ? 'Tabs' : 'Windows'} open on ${g.ctx}`,
      contexts: [g.ctx],
      occurrences: g.max,
      sessions: busy,
      totalSessions: total,
      lastSeen: g.last,
      demo: g.demo,
      examples: [...g.titles],
    });
  }

  // Tool setup isn't tied to sessions: use the latest scan for each app.
  const latest = new Map<string, ActivityEvent>();
  for (const e of snapshots) {
    if (e.kind === 'setup' && e.app && (!latest.has(e.app) || latest.get(e.app)!.ts < e.ts)) latest.set(e.app, e);
  }
  for (const [app, e] of latest) {
    const count = Number(e.meta?.count ?? 0);
    if (count < SETUP_CLUTTER) continue;
    out.push({
      id: `setup:${app}`,
      kind: 'setup',
      label: `${app} has ${e.title ?? `${count} tools`} set up`,
      contexts: [app],
      occurrences: count,
      sessions: total,
      totalSessions: total,
      lastSeen: e.ts,
      demo: e.source === 'demo',
    });
  }
  return out;
}

export function buildDigest(events: ActivityEvent[]): Digest {
  const snapshots = events.filter((e) => SNAPSHOT_KINDS.has(e.kind));
  const sessions = sessionize(events.filter((e) => !SNAPSHOT_KINDS.has(e.kind) && contextOf(e)));
  const flows = new Map<string, Tally>();
  const pingpongs = new Map<string, Tally>();
  const searches = new Map<string, Tally>();
  const chains = new Map<string, Tally>();
  const sourceCounts: Record<string, number> = {};

  for (const s of sessions) {
    const ev = s.events;
    for (const e of ev) sourceCounts[e.source] = (sourceCounts[e.source] ?? 0) + 1;

    // copy → paste (or copy → next distinct focus) transfers
    const sessionFlows = new Map<string, number>();
    for (let i = 0; i < ev.length; i++) {
      const e = ev[i];
      if (e.kind !== 'copy') continue;
      const from = contextOf(e)!;
      let to: string | null = null;
      let target: ActivityEvent | null = null;
      for (let j = i + 1; j < ev.length; j++) {
        const n = ev[j];
        if (n.ts - e.ts > PASTE_WINDOW_MS || n.kind === 'copy') break;
        const ctx = contextOf(n);
        if (n.kind === 'paste' && ctx && ctx !== from) {
          to = ctx;
          target = n;
          break;
        }
      }
      if (!to) {
        for (let j = i + 1; j < ev.length; j++) {
          const n = ev[j];
          if (n.ts - e.ts > FOCUS_WINDOW_MS || n.kind === 'copy') break;
          const ctx = contextOf(n);
          if (n.kind === 'focus' && ctx && ctx !== from) {
            to = ctx;
            target = n;
            break;
          }
        }
      }
      if (to && target) {
        const key = `flow:${from}>${to}`;
        bump(flows, key, [from, to], s.index, target.ts, e.source === 'demo' && target.source === 'demo');
        sessionFlows.set(`${from}>${to}`, (sessionFlows.get(`${from}>${to}`) ?? 0) + 1);
      }
    }

    // A ⇒ B ⇒ C pipelines within one session
    const pairs = [...sessionFlows.keys()].map((k) => k.split('>'));
    for (const [a, b] of pairs) {
      for (const [b2, c] of pairs) {
        if (b2 !== b || c === a || c === b) continue;
        const n = Math.min(sessionFlows.get(`${a}>${b}`)!, sessionFlows.get(`${b}>${c}`)!);
        const demo = ev.every((e) => e.source === 'demo');
        bump(chains, `chain:${a}>${b}>${c}`, [a, b, c], s.index, s.end, demo, n);
      }
    }

    // back-and-forth switching (A → B → A)
    const focusSeq = ev.filter((e) => e.kind === 'focus').map((e) => ({ ctx: contextOf(e)!, e }));
    const collapsed = focusSeq.filter((x, i) => i === 0 || x.ctx !== focusSeq[i - 1].ctx);
    const local = new Map<string, number>();
    for (let i = 2; i < collapsed.length; i++) {
      const a = collapsed[i - 2].ctx;
      const b = collapsed[i - 1].ctx;
      if (collapsed[i].ctx === a && a !== b) {
        const key = [a, b].sort().join('|');
        local.set(key, (local.get(key) ?? 0) + 1);
      }
    }
    for (const [key, n] of local) {
      if (n < 3) continue;
      const demo = ev.every((e) => e.source === 'demo');
      bump(pingpongs, `pingpong:${key}`, key.split('|'), s.index, s.end, demo, n);
    }

    for (const e of ev) {
      if (e.kind !== 'search') continue;
      const ctx = contextOf(e)!;
      bump(searches, `search:${ctx}`, [ctx], s.index, e.ts, e.source === 'demo');
    }
  }

  const total = sessions.length;
  const toSignal = (kind: Signal['kind'], label: (t: Tally) => string) => (entry: [string, Tally]): Signal & { demo: boolean } => {
    const [id, t] = entry;
    return {
      id,
      kind,
      label: label(t),
      contexts: t.contexts,
      occurrences: t.occurrences,
      sessions: t.sessions.size,
      totalSessions: total,
      lastSeen: t.lastSeen,
      demo: t.allDemo,
    };
  };

  const dwellAgg = new Map<string, { ms: number; sessions: number }>();
  for (const s of sessions) {
    for (const [ctx, ms] of s.dwell) {
      const d = dwellAgg.get(ctx) ?? { ms: 0, sessions: 0 };
      d.ms += ms;
      d.sessions += 1;
      dwellAgg.set(ctx, d);
    }
  }
  const dwellTotals = [...dwellAgg.entries()]
    .map(([context, d]) => ({ context, ...d }))
    .sort((a, b) => b.ms - a.ms);

  const dwellSignals: (Signal & { demo: boolean })[] = dwellTotals
    .filter((d) => d.ms >= 20 * 60_000 && d.sessions >= 2)
    .slice(0, 6)
    .map((d) => {
      const contributing = sessions.filter((s) => s.dwell.has(d.context));
      return {
        id: `dwell:${d.context}`,
        kind: 'dwell',
        label: `Spent ${formatDuration(d.ms)} in ${d.context}`,
        contexts: [d.context],
        occurrences: Math.round(d.ms / 60_000),
        sessions: d.sessions,
        totalSessions: total,
        lastSeen: Math.max(...contributing.map((s) => s.end)),
        demo: contributing.every((s) => s.events.every((e) => e.source === 'demo')),
      };
    });

  const signals = [
    ...[...chains].map(toSignal('chain', (t) => `Moved information ${t.contexts.join(' → ')}`)),
    ...[...flows].map(toSignal('flow', (t) => `Copied from ${t.contexts[0]} into ${t.contexts[1]}`)),
    ...[...pingpongs].map(toSignal('pingpong', (t) => `Switched back and forth between ${t.contexts[0]} and ${t.contexts[1]}`)),
    ...[...searches].map(toSignal('search', (t) => `Searched on ${t.contexts[0]}`)),
    ...dwellSignals,
  ]
    .filter((s) => s.sessions >= 2 || s.occurrences >= 6)
    .concat(clutterSignals(snapshots, sessions))
    .sort((a, b) => rank(b) - rank(a))
    .slice(0, 24);

  const activeMs = dwellTotals.reduce((n, d) => n + d.ms, 0);
  const from = sessions[0]?.start ?? 0;
  const to = sessions[sessions.length - 1]?.end ?? 0;

  return {
    sessions,
    signals,
    dwellTotals,
    activeMs,
    from,
    to,
    sourceCounts,
    text: renderDigest({ sessions, signals, dwellTotals, activeMs, from, to, sourceCounts }),
  };
}

// Transfers and pipelines say more about friction than raw time spent.
const KIND_WEIGHT: Record<Signal['kind'], number> = {
  chain: 1.4,
  flow: 1.25,
  setup: 1.1,
  tabs: 1.1,
  windows: 1,
  pingpong: 1,
  search: 0.6,
  dwell: 0.45,
};

export function rank(s: Signal): number {
  return KIND_WEIGHT[s.kind] * s.sessions * Math.log2(2 + s.occurrences);
}

/** One plain sentence a person can check against their own memory. */
export function evidenceLine(s: Pick<Signal, 'contexts' | 'occurrences' | 'sessions' | 'totalSessions' | 'kind' | 'label'>): string {
  const [a, b, c] = s.contexts;
  const when =
    s.sessions === s.totalSessions
      ? `in all ${s.totalSessions} of your recent work sessions`
      : `in ${s.sessions} of your last ${s.totalSessions} work sessions`;
  switch (s.kind) {
    case 'flow':
      return `You copied from ${a} to ${b} ${s.occurrences} times, ${when}`;
    case 'chain':
      return `You moved things from ${a} to ${b} to ${c} ${when}`;
    case 'pingpong':
      return `You went back and forth between ${a} and ${b} ${s.occurrences} times, ${when}`;
    case 'search':
      return `You searched on ${a} ${s.occurrences} times, ${when}`;
    case 'dwell':
      return `You spent ${formatDuration(s.occurrences * 60_000)} on ${a}, ${when}`;
    case 'tabs':
      return `You had up to ${s.occurrences} ${a} tabs open at once, ${when}`;
    case 'windows':
      return `You had up to ${s.occurrences} ${a} windows open at once, ${when}`;
    case 'setup':
      return s.label;
  }
}

function renderDigest(d: Omit<Digest, 'text'>): string {
  const lines: string[] = [];
  lines.push(
    `Observation window: ${shortDate(d.from)} to ${shortDate(d.to)} · ${d.sessions.length} sessions · ${formatDuration(d.activeMs)} of focused time`
  );
  lines.push(`Event sources: ${Object.entries(d.sourceCounts).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  lines.push('');
  lines.push('Signals (deterministic counts; refer to them by id):');
  for (const s of d.signals) {
    lines.push(`- [${s.id}] ${evidenceLine(s)}`);
    if (s.examples?.length) lines.push(`  for example: ${s.examples.map((x) => `"${x}"`).join(', ')}`);
  }
  if (!d.signals.length) lines.push('- (none yet)');
  lines.push('');
  lines.push('Time by context:');
  lines.push(
    d.dwellTotals
      .slice(0, 14)
      .map((x) => `${x.context} ${formatDuration(x.ms)} (${x.sessions} sessions)`)
      .join(' · ')
  );
  lines.push('');
  lines.push('Sessions:');
  for (const s of d.sessions.slice(-12)) {
    const top = [...s.dwell.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
    const sampleTitles = top
      // Titles are quoted data: no quote marks or line breaks that could pass as instructions.
      .flatMap(([ctx]) => [...(s.titles.get(ctx) ?? [])].slice(0, 2).map((t) => `${ctx}: "${t.replace(/["\r\n]/g, "'").slice(0, 100)}"`))
      .slice(0, 6);
    lines.push(
      `- S${s.index + 1} ${shortDate(s.start)} ${clockTime(s.start)}–${clockTime(s.end)}: ${top
        .map(([ctx, ms]) => `${ctx} ${formatDuration(ms)}`)
        .join(', ')}`
    );
    if (sampleTitles.length) lines.push(`  titles: ${sampleTitles.join(' | ')}`);
  }
  return lines.join('\n');
}
