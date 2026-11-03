// Keeps what Tailor noticed from doubling up. The Observer words the same habit differently from
// run to run, so patterns are matched on the signals behind them, not on their titles.
// Pure functions: no storage, no AI.

import type { Pattern, PatternKind, Signal } from '../lib/types';
import { evidenceLine, rank } from './digest';

// What someone did (copying, switching, piling up windows) says more than how long an app was
// open, so time spent comes last; tool setup counts sit in between.
const TIER: Partial<Record<Signal['kind'], number>> = { setup: 1, dwell: 2 };

export function strongestFirst(signals: Signal[]): Signal[] {
  return [...signals].sort((a, b) => (TIER[a.kind] ?? 0) - (TIER[b.kind] ?? 0) || rank(b) - rank(a));
}

export interface Basis {
  signalIds: string[];
  lead: string;
  kind: PatternKind;
  contexts: string[];
}

export function basis(p: Pick<Pattern, 'signalIds' | 'kind' | 'contexts'>, signalById: Map<string, Signal>): Basis {
  const present = p.signalIds.map((id) => signalById.get(id)).filter((s) => !!s);
  return { signalIds: p.signalIds, lead: present.length ? strongestFirst(present)[0].id : p.signalIds[0], kind: p.kind, contexts: p.contexts };
}

const isTimeSpent = (id: string) => id.startsWith('dwell:');
const sharedCount = (a: string[], b: string[]) => a.filter((id) => b.includes(id)).length;

/** Same lead signal, the same kind of thing about the same apps, or mostly the same signals. */
export function samePattern(a: Basis, b: Basis): boolean {
  if (a.lead === b.lead) return true;
  if (a.kind === b.kind && [...a.contexts].sort().join('|') === [...b.contexts].sort().join('|')) return true;
  // Time spent shows up in many patterns, so it only links two when one rests on nothing else.
  const doneA = a.signalIds.filter((id) => !isTimeSpent(id));
  const doneB = b.signalIds.filter((id) => !isTimeSpent(id));
  if (doneA.length && doneB.length) {
    const shared = sharedCount(doneA, doneB);
    return shared > 0 && shared * 2 >= Math.min(doneA.length, doneB.length);
  }
  const timeA = a.signalIds.filter(isTimeSpent);
  const timeB = b.signalIds.filter(isTimeSpent);
  const shared = sharedCount(timeA, timeB);
  return shared > 0 && shared / new Set([...timeA, ...timeB]).size > 0.5;
}

/** Today's numbers for a pattern, from the strongest of its signals that are still around. */
export function refreshPattern(p: Pattern, signalById: Map<string, Signal>): Pattern {
  const present = strongestFirst(p.signalIds.map((id) => signalById.get(id)).filter((s) => !!s));
  if (!present.length) return p;
  const lead = present[0];
  return {
    ...p,
    evidence: evidenceLine(lead),
    occurrences: lead.occurrences,
    sessions: lead.sessions,
    totalSessions: lead.totalSessions,
    lastSeen: Math.max(p.lastSeen, ...present.map((s) => s.lastSeen)),
  };
}

/**
 * Refreshes every pattern and folds together the ones that say the same thing. A pattern the
 * person said was wrong wins its group, so "that's not right" sticks; then one backed by something
 * they did over one backed only by time spent; then the newest wording.
 */
export function foldPatterns(all: Pattern[], signalById: Map<string, Signal>): { keep: Pattern[]; movedTo: Map<string, string> } {
  const order = all
    .map((raw) => {
      const p = refreshPattern(raw, signalById);
      return { p, b: basis(p, signalById) };
    })
    .sort(
      (x, y) =>
        Number(y.p.status === 'dismissed') - Number(x.p.status === 'dismissed') ||
        Number(isTimeSpent(x.b.lead)) - Number(isTimeSpent(y.b.lead)) ||
        y.p.firstSeen - x.p.firstSeen
    );
  const keepers: { p: Pattern; b: Basis }[] = [];
  const movedTo = new Map<string, string>();
  for (const { p, b } of order) {
    const keeper = keepers.find((k) => samePattern(k.b, b));
    if (!keeper) {
      keepers.push({ p, b });
      continue;
    }
    movedTo.set(p.id, keeper.p.id);
    keeper.p = { ...keeper.p, firstSeen: Math.min(keeper.p.firstSeen, p.firstSeen), lastSeen: Math.max(keeper.p.lastSeen, p.lastSeen) };
  }
  return { keep: keepers.map((k) => k.p), movedTo };
}
