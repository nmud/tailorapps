// Observer agent: reads the deterministic digest (never raw events) and turns signals into
// named workflow patterns plus a short, evidence-based profile. It has no code access.

import { api } from '../lib/api';
import { chatJSON, friendlyError, modelReady } from '../lib/llm';
import { getState, save, setState, toast } from '../lib/store';
import type { Pattern, PatternKind, Profile } from '../lib/types';
import { hash } from '../lib/util';
import { buildDigest, evidenceLine, type Digest } from './digest';
import { suggest } from './designer';

const WINDOW_MS = 14 * 86_400_000;
const KINDS: PatternKind[] = ['information-transfer', 'context-switching', 'repetition', 'lookup', 'tracking', 'organizing', 'other'];

const SYSTEM = `You are the Observer agent inside Tailor, a desktop app that learns how one person works so it can later suggest small personal tools.

You receive a digest of permissioned activity: deterministic signals with ids and counts, time per context, and a few window/page titles per session. Content (what was typed or copied) is never collected.

Your job:
1. Group related signals into workflow patterns that describe repeated friction a small tool could remove (e.g. manually moving information between two places, constant switching between a reference and an editor, repeated lookups, manual tracking). Clutter counts too (kind "organizing"): many tabs open on one site such as lots of AI chats, many windows of one app such as several terminals running coding agents, or many tools set up in an AI app (MCP servers, connectors, plugins, skills).
2. Write a short profile of the person's work, strictly from evidence.

Rules:
- Every pattern must list the ids of the signals it is based on (signalIds), using only ids from the digest.
- Do not invent numbers. Counts are attached automatically from the signals.
- Describe behaviour, not personality. No guesses about identity, mood, health, or anything not shown.
- Skip noise: breaks, entertainment, one-off visits. Prefer 2–5 strong patterns over many weak ones.
- "friction" names the manual effort in one sentence ("Citations are retyped by hand into a spreadsheet").
- confidence is 0–1: how sure you are that this is a real, repeated workflow worth a tool.
- Do not re-propose patterns the user marked as inaccurate (listed below the digest).
- Write for a non-technical person of any age: plain everyday words, no jargon. Titles under 7 words (e.g. "Copying paper details by hand"), descriptions one short sentence. The profile summary is one or two short sentences.`;

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['profile', 'patterns'],
  properties: {
    profile: {
      type: 'object',
      additionalProperties: false,
      required: ['summary', 'focusAreas', 'tools', 'rhythms'],
      properties: {
        summary: { type: 'string' },
        focusAreas: { type: 'array', items: { type: 'string' } },
        tools: { type: 'array', items: { type: 'string' } },
        rhythms: { type: 'array', items: { type: 'string' } },
      },
    },
    patterns: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['signalIds', 'title', 'description', 'friction', 'kind', 'confidence'],
        properties: {
          signalIds: { type: 'array', items: { type: 'string' } },
          title: { type: 'string' },
          description: { type: 'string' },
          friction: { type: 'string' },
          kind: { type: 'string', enum: KINDS },
          confidence: { type: 'number' },
        },
      },
    },
  },
};

interface ObserverOutput {
  profile: Omit<Profile, 'updatedAt' | 'demo'>;
  patterns: { signalIds: string[]; title: string; description: string; friction: string; kind: PatternKind; confidence: number }[];
}

export async function loadDigest(): Promise<Digest> {
  const events = await api.eventsQuery(Date.now() - WINDOW_MS, { limit: 40_000 });
  return buildDigest(events);
}

export async function analyze(opts: { quiet?: boolean } = {}): Promise<void> {
  const st = getState();
  if (st.observer.running) return;
  const ready = modelReady('observer');
  if (!ready.ok) {
    setState({ observer: { ...st.observer, error: ready.reason } });
    if (!opts.quiet) toast(ready.reason!, { tone: 'error' });
    return;
  }
  setState({ observer: { ...st.observer, running: true, phase: 'Looking at your recent activity', error: undefined, note: undefined } });
  try {
    const digest = await loadDigest();
    if (digest.sessions.length < 2 || digest.signals.length === 0) {
      const note =
        digest.sessions.length < 2
          ? 'Not enough to go on yet. Keep working as usual and check back later.'
          : 'Nothing repeated stands out yet. Keep working as usual and check back later.';
      setState({ observer: { ...getState().observer, running: false, note, lastRunAt: Date.now() } });
      await save.observerMeta({ lastRunAt: Date.now() });
      return;
    }

    const dismissed = getState().patterns.filter((p) => p.status === 'dismissed');
    const user = [
      digest.text,
      '',
      dismissed.length
        ? `Patterns the user marked as inaccurate (do not repeat):\n${dismissed.map((p) => `- ${p.title} [${p.signalIds.join(', ')}]`).join('\n')}`
        : 'Patterns the user marked as inaccurate: none',
    ].join('\n');

    setState({ observer: { ...getState().observer, phase: 'Looking for things you repeat' } });
    const out = await chatJSON<ObserverOutput>('observer', SYSTEM, user, { name: 'observer_report', schema: SCHEMA });

    const signalById = new Map(digest.signals.map((s) => [s.id, s]));
    const existing = new Map(getState().patterns.map((p) => [p.id, p]));
    const fresh: Pattern[] = [];
    const now = Date.now();

    for (const raw of out.patterns ?? []) {
      const signals = (raw.signalIds ?? []).map((id) => signalById.get(id)).filter((s) => !!s);
      if (!signals.length) continue;
      const ids = [...new Set(signals.map((s) => s.id))].sort();
      const id = `p_${hash(ids.join('|'))}`;
      // Session-based signals are the most checkable evidence; tool setup counts come second.
      const ordered = [...signals].sort(
        (a, b) => Number(a.kind === 'setup') - Number(b.kind === 'setup') || b.sessions - a.sessions || b.occurrences - a.occurrences
      );
      const strongest = ordered[0];
      const prev = existing.get(id);
      const pattern: Pattern = {
        id,
        signalIds: ids,
        title: raw.title.trim(),
        description: raw.description.trim(),
        friction: raw.friction.trim(),
        kind: KINDS.includes(raw.kind) ? raw.kind : 'other',
        contexts: [...new Set(signals.flatMap((s) => s.contexts))],
        occurrences: strongest.occurrences,
        sessions: strongest.sessions,
        totalSessions: strongest.totalSessions,
        evidence: ordered.slice(0, 2).map(evidenceLine).join('. '),
        confidence: Math.max(0, Math.min(1, Number(raw.confidence) || 0)),
        firstSeen: prev?.firstSeen ?? now,
        lastSeen: Math.max(...signals.map((s) => s.lastSeen)),
        status: prev?.status ?? 'active',
        demo: signals.every((s) => s.demo),
      };
      if (pattern.status === 'dismissed') continue;
      await save.pattern(pattern);
      if (!prev) fresh.push(pattern);
    }

    const allDemo = digest.signals.every((s) => s.demo);
    await save.profile({
      summary: out.profile.summary,
      focusAreas: out.profile.focusAreas ?? [],
      tools: out.profile.tools ?? [],
      rhythms: out.profile.rhythms ?? [],
      updatedAt: now,
      demo: allDemo,
    });

    setState({
      observer: {
        running: false,
        lastRunAt: now,
        note: fresh.length ? `Tailor noticed ${fresh.length} new thing${fresh.length === 1 ? '' : 's'}.` : 'Nothing new this time.',
      },
    });
    await save.observerMeta({ lastRunAt: now });

    const worthy = fresh.filter((p) => p.confidence >= 0.55);
    if (worthy.length && getState().settings.autoSuggest) {
      await suggest({ focusPatternIds: worthy.map((p) => p.id), count: Math.min(3, worthy.length + 1), origin: 'auto' });
    }
  } catch (e) {
    const msg = friendlyError(e);
    setState({ observer: { ...getState().observer, running: false, error: msg } });
    if (!opts.quiet) toast(msg, { tone: 'error' });
  }
}

export async function dismissPattern(p: Pattern) {
  await save.pattern({ ...p, status: 'dismissed' });
}
