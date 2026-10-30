// A labelled, synthetic research workflow for demos: seven sessions over nine days of a
// student reading retrieval papers, taking notes in Obsidian and logging citations in a
// spreadsheet, plus some coding. Stored with source "demo" and removable at any time.

import { api } from './api';
import type { ActivityEvent } from './types';

type NewEvent = Omit<ActivityEvent, 'id'>;

const PAPERS = [
  '[2005.11401] Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks',
  '[2002.08909] REALM: Retrieval-Augmented Language Model Pre-Training',
  '[2004.04906] Dense Passage Retrieval for Open-Domain Question Answering',
  '[2007.01282] Leveraging Passage Retrieval with Generative Models for Open Domain Question Answering',
  '[2112.04426] Improving language models by retrieving from trillions of tokens',
  '[2208.03299] Atlas: Few-shot Learning with Retrieval Augmented Language Models',
  '[2310.11511] Self-RAG: Learning to Retrieve, Generate, and Critique through Self-Reflection',
  '[2312.10997] Retrieval-Augmented Generation for Large Language Models: A Survey',
];

const NOTES = [
  'Literature notes - RAG - thesis-vault - Obsidian',
  'Chapter 2 - Related work - thesis-vault - Obsidian',
  'Reading queue - thesis-vault - Obsidian',
];

const SHEET = 'Paper tracker - Google Sheets';

const CHATS = [
  'Summarize the RAG survey - Claude',
  'Compare DPR and REALM - Claude',
  'Fix eval_retrieval.py - Claude',
  'Chapter 2 outline - Claude',
  'Explain fusion-in-decoder - Claude',
  'Atlas few-shot results - Claude',
];

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function generateDemoEvents(now = Date.now()): NewEvent[] {
  const rand = rng(20261104);
  const between = (a: number, b: number) => a + rand() * (b - a);
  const min = 60_000;
  const events: NewEvent[] = [];

  const focusWeb = (ts: number, domain: string, title: string, ms: number) =>
    events.push({ ts, source: 'demo', kind: 'focus', domain, title, durationMs: Math.round(ms) });
  const focusApp = (ts: number, app: string, title: string, ms: number) =>
    events.push({ ts, source: 'demo', kind: 'focus', app, title, durationMs: Math.round(ms) });
  const copyWeb = (ts: number, domain: string, title: string, chars: number) =>
    events.push({ ts, source: 'demo', kind: 'copy', domain, title, durationMs: 0, meta: { chars } });
  const pasteWeb = (ts: number, domain: string, title: string, chars: number) =>
    events.push({ ts, source: 'demo', kind: 'paste', domain, title, durationMs: 0, meta: { chars, target: 'editor' } });

  // Days ago and start hour for each session. Sessions 2 and 5 include coding.
  const plan: [number, number, boolean][] = [
    [9, 14.1, false],
    [8, 10.4, true],
    [6, 15.0, false],
    [5, 20.2, false],
    [3, 13.3, true],
    [2, 9.6, false],
    [1, 16.1, false],
  ];

  let paper = 0;
  for (const [daysAgo, hour, coding] of plan) {
    const day = new Date(now - daysAgo * 86_400_000);
    day.setHours(Math.floor(hour), Math.round((hour % 1) * 60), 0, 0);
    let t = day.getTime();

    if (coding) {
      for (let i = 0; i < 4; i++) {
        const code = between(6, 14) * min;
        focusApp(t, 'code', 'eval_retrieval.py - thesis-experiments - Visual Studio Code', code);
        t += code;
        const so = between(1.5, 4) * min;
        focusWeb(t, 'stackoverflow.com', 'python - Batch cosine similarity with numpy - Stack Overflow', so);
        copyWeb(t + so * 0.7, 'stackoverflow.com', 'python - Batch cosine similarity with numpy - Stack Overflow', Math.round(between(80, 300)));
        t += so + 8_000;
      }
      focusWeb(t, 'github.com', 'facebookresearch/atlas: Code repository for supporting the paper "Atlas"', between(4, 8) * min);
      t += 9 * min;
    }

    const papersThisSession = 3 + Math.floor(rand() * 2);
    for (let p = 0; p < papersThisSession; p++) {
      const title = PAPERS[paper % PAPERS.length];
      paper++;
      focusWeb(t, 'scholar.google.com', 'Google Scholar', between(1, 2.5) * min);
      events.push({ ts: t + 20_000, source: 'demo', kind: 'search', domain: 'scholar.google.com', title: 'retrieval augmented generation evaluation', durationMs: 0 });
      t += between(1.2, 2.6) * min;

      // read → copy a passage → paste into notes, a few times per paper
      const rounds = 2 + Math.floor(rand() * 2);
      for (let r = 0; r < rounds; r++) {
        const read = between(4, 9) * min;
        focusWeb(t, 'arxiv.org', title, read);
        copyWeb(t + read - 15_000, 'arxiv.org', title, Math.round(between(220, 900)));
        t += read + 4_000;
        const note = between(1.5, 4) * min;
        focusApp(t, 'obsidian', NOTES[r === 0 ? 0 : 1], note);
        t += note + 3_000;
      }

      // citation → spreadsheet row
      const cite = between(0.5, 1.2) * min;
      focusWeb(t, 'arxiv.org', title, cite);
      copyWeb(t + cite - 6_000, 'arxiv.org', title, Math.round(between(140, 260)));
      t += cite + 3_000;
      const sheet = between(1, 2.2) * min;
      focusWeb(t, 'docs.google.com', SHEET, sheet);
      pasteWeb(t + 20_000, 'docs.google.com', SHEET, Math.round(between(140, 260)));
      t += sheet + 3_000;

      // the same title gets typed again into the notes' reading queue
      const queue = between(0.6, 1.4) * min;
      focusApp(t, 'obsidian', NOTES[2], queue);
      t += queue + 5_000;
    }

    // Asking Claude about each paper, in a new chat each time: the tabs pile up.
    const sessionStart = day.getTime();
    const chats = 6 + Math.floor(rand() * 9);
    for (let c = 0; c < 2; c++) {
      const ask = between(2, 5) * min;
      focusWeb(t, 'claude.ai', CHATS[(paper + c) % CHATS.length], ask);
      t += ask + 4_000;
    }
    for (let at = sessionStart + 15 * min, n = 0; at < t; at += 20 * min, n++) {
      const open = Math.min(chats, 4 + n * 2);
      events.push({
        ts: at,
        source: 'demo',
        kind: 'tabs',
        domain: 'claude.ai',
        title: CHATS.slice(n % 3, (n % 3) + 3).join(' · '),
        durationMs: 0,
        meta: { tabCount: open },
      });
    }
    if (coding) {
      events.push({
        ts: sessionStart + 10 * min,
        source: 'demo',
        kind: 'windows',
        app: 'windowsterminal',
        title: 'claude · claude · npm run eval',
        durationMs: 0,
        meta: { windowCount: 3 + Math.floor(rand() * 3) },
      });
    }

    if (rand() > 0.5) {
      focusWeb(t, 'youtube.com', 'lofi hip hop radio - beats to relax/study to', between(3, 7) * min);
    }
  }

  events.push({
    ts: now - 2 * 3_600_000,
    source: 'demo',
    kind: 'setup',
    app: 'Claude Code',
    title: '7 MCP servers, 4 connectors, 3 plugins, 12 skills',
    durationMs: 0,
    meta: { count: 26 },
  });

  return events
    .map((e) => ({ ...e, ts: Math.round(e.ts), durationMs: Math.round(e.durationMs) }))
    .filter((e) => e.ts < now);
}

export async function loadDemoSession(): Promise<number> {
  await api.eventsClear('demo');
  return api.eventsInsert(generateDemoEvents());
}

export async function clearDemoSession(): Promise<number> {
  return api.eventsClear('demo');
}
