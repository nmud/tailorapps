import { useSyncExternalStore } from 'react';
import { api, type RuntimeStatus } from './api';
import { DEFAULT_SETTINGS, mergeSettings } from './settings';
import type {
  AppRecord,
  AppVersion,
  BuildJob,
  FeedbackEntry,
  FeedbackKind,
  LearningCfg,
  Pattern,
  Profile,
  Settings,
  Suggestion,
  User,
  View,
} from './types';
import { uid } from './util';

export interface Toast {
  id: string;
  text: string;
  tone: 'info' | 'error';
  action?: { label: string; run: () => void };
}

export interface ObserverState {
  running: boolean;
  phase?: string;
  error?: string;
  note?: string;
  lastRunAt?: number;
}

export interface WorkspaceState {
  ready: boolean;
  preparing: boolean;
  node: string | null;
  log: string[];
  error?: string;
}

export interface State {
  /** Session check finished (signed in or not). */
  authChecked: boolean;
  user: User | null;
  /** This user has been through the learning setup. */
  onboarded: boolean;
  loaded: boolean;
  view: View;
  settings: Settings;
  learning: LearningCfg;
  runtime: RuntimeStatus | null;
  suggestions: Suggestion[];
  patterns: Pattern[];
  profile: Profile | null;
  apps: AppRecord[];
  versions: AppVersion[];
  feedback: FeedbackEntry[];
  job: BuildJob | null;
  workshopAppId: string | null;
  /** A hidden copy of an app the Tester agent is using. */
  testFrame: { appId: string; nonce: number } | null;
  observer: ObserverState;
  designer: { running: boolean; error?: string };
  workspace: WorkspaceState;
  activityTick: number;
  selectedSuggestionId: string | null;
  highlightAppId: string | null;
  unseenSuggestions: number;
  toasts: Toast[];
}

const DEFAULT_LEARNING: LearningCfg = {
  enabled: false,
  extension: true,
  desktop: true,
  includeSearchTerms: false,
  includePaths: false,
  denyApps: [],
  denyDomains: [],
  retentionDays: 30,
};

let state: State = {
  authChecked: false,
  user: null,
  onboarded: false,
  loaded: false,
  view: 'discover',
  settings: DEFAULT_SETTINGS,
  learning: DEFAULT_LEARNING,
  runtime: null,
  suggestions: [],
  patterns: [],
  profile: null,
  apps: [],
  versions: [],
  feedback: [],
  job: null,
  workshopAppId: null,
  testFrame: null,
  observer: { running: false },
  designer: { running: false },
  workspace: { ready: false, preparing: false, node: null, log: [] },
  activityTick: 0,
  selectedSuggestionId: null,
  highlightAppId: null,
  unseenSuggestions: 0,
  toasts: [],
};

const listeners = new Set<() => void>();

export const getState = () => state;

export function setState(patch: Partial<State> | ((s: State) => Partial<State>)) {
  const next = typeof patch === 'function' ? patch(state) : patch;
  state = { ...state, ...next };
  listeners.forEach((l) => l());
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** Selectors must return existing references (slices), not new objects. */
export function useStore<T>(selector: (s: State) => T): T {
  return useSyncExternalStore(subscribe, () => selector(state));
}

function upsert<T extends { id: string }>(list: T[], item: T): T[] {
  const i = list.findIndex((x) => x.id === item.id);
  if (i < 0) return [item, ...list];
  const copy = list.slice();
  copy[i] = item;
  return copy;
}

// ── persistence ─────────────────────────────────────────────────────────────

export const save = {
  suggestion(s: Suggestion) {
    const item = { ...s, updatedAt: Date.now() };
    setState((st) => ({ suggestions: upsert(st.suggestions, item) }));
    return api.docsPut('suggestions', item.id, item);
  },
  removeSuggestion(id: string) {
    setState((st) => ({ suggestions: st.suggestions.filter((s) => s.id !== id) }));
    return api.docsDelete('suggestions', id);
  },
  pattern(p: Pattern) {
    setState((st) => ({ patterns: upsert(st.patterns, p) }));
    return api.docsPut('patterns', p.id, p);
  },
  removePattern(id: string) {
    setState((st) => ({ patterns: st.patterns.filter((p) => p.id !== id) }));
    return api.docsDelete('patterns', id);
  },
  app(a: AppRecord) {
    const item = { ...a, updatedAt: Date.now() };
    setState((st) => ({ apps: upsert(st.apps, item) }));
    return api.docsPut('apps', item.id, item);
  },
  removeApp(id: string) {
    setState((st) => ({
      apps: st.apps.filter((a) => a.id !== id),
      versions: st.versions.filter((v) => v.appId !== id),
    }));
    const versions = state.versions.filter((v) => v.appId === id);
    return Promise.all([
      api.docsDelete('apps', id),
      ...versions.map((v) => api.docsDelete('versions', v.id)),
    ]);
  },
  version(v: AppVersion) {
    setState((st) => ({ versions: upsert(st.versions, v) }));
    return api.docsPut('versions', v.id, v);
  },
  profile(p: Profile | null) {
    setState({ profile: p });
    return api.kvSet('profile', p);
  },
  settings(s: Settings) {
    setState({ settings: s });
    return api.kvSet('settings', s);
  },
  async learning(cfg: LearningCfg) {
    setState({ learning: cfg });
    const saved = await api.learningSet(cfg);
    setState({ learning: saved });
  },
  observerMeta(meta: { lastRunAt?: number }) {
    return api.kvSet('observer', meta);
  },
};

export function recordFeedback(
  kind: FeedbackKind,
  subject: string,
  detail: string,
  refs: { suggestionId?: string; appId?: string; patternId?: string } = {}
) {
  const entry: FeedbackEntry = { id: uid('f_'), ts: Date.now(), kind, subject, detail, ...refs };
  setState((st) => ({ feedback: [entry, ...st.feedback] }));
  return api.docsPut('feedback', entry.id, entry);
}

export function forgetFeedback(id: string) {
  setState((st) => ({ feedback: st.feedback.filter((f) => f.id !== id) }));
  return api.docsDelete('feedback', id);
}

// ── toasts ──────────────────────────────────────────────────────────────────

export function toast(text: string, opts: { tone?: Toast['tone']; action?: Toast['action']; ms?: number } = {}) {
  const t: Toast = { id: uid('t_'), text, tone: opts.tone ?? 'info', action: opts.action };
  setState((st) => ({ toasts: [...st.toasts.slice(-2), t] }));
  setTimeout(() => dismissToast(t.id), opts.ms ?? (opts.action ? 8000 : 4500));
}

export function dismissToast(id: string) {
  setState((st) => ({ toasts: st.toasts.filter((t) => t.id !== id) }));
}

// ── navigation ──────────────────────────────────────────────────────────────

export function go(view: View) {
  setState((st) => ({
    view,
    unseenSuggestions: view === 'discover' ? 0 : st.unseenSuggestions,
    highlightAppId: view === 'deck' ? st.highlightAppId : null,
  }));
}

// ── boot ────────────────────────────────────────────────────────────────────

/** Restore a saved session (if any) when the app starts. */
export async function checkSession() {
  // Settings first, so the sign-in screen already wears the chosen theme.
  setState({ settings: mergeSettings(await api.kvGet<Partial<Settings>>('settings').catch(() => null)) });
  let user: User | null = null;
  try {
    user = await api.authCurrent();
  } catch {
    user = null;
  }
  if (user) await signedIn(user);
  setState({ authChecked: true });
}

export async function signedIn(user: User) {
  const onboarded = !!(await api.kvGet<boolean>(`onboarded:${user.id}`));
  setState({ user, onboarded, view: 'discover' });
  await loadAll();
}

export async function finishOnboarding() {
  const user = state.user;
  if (!user) return;
  await api.kvSet(`onboarded:${user.id}`, true);
  setState({ onboarded: true });
}

export async function signOut() {
  await api.authLogout();
  setState({ user: null, onboarded: false, loaded: false, job: null, toasts: [] });
}

export async function loadAll() {
  const [settings, learning, suggestions, patterns, profile, apps, versions, feedback, observer] = await Promise.all([
    api.kvGet<Partial<Settings>>('settings'),
    api.learningGet(),
    api.docsList<Suggestion>('suggestions'),
    api.docsList<Pattern>('patterns'),
    api.kvGet<Profile>('profile'),
    api.docsList<AppRecord>('apps'),
    api.docsList<AppVersion>('versions'),
    api.docsList<FeedbackEntry>('feedback'),
    api.kvGet<{ lastRunAt?: number }>('observer'),
  ]);
  setState({
    loaded: true,
    settings: mergeSettings(settings),
    learning,
    suggestions: suggestions.map((s) => (s.status === 'building' && !apps.some((a) => a.id === s.appId) ? { ...s, status: 'new' } : s)),
    patterns,
    profile,
    apps,
    versions,
    feedback: feedback.sort((a, b) => b.ts - a.ts),
    observer: { running: false, lastRunAt: observer?.lastRunAt },
    workshopAppId: apps.find((a) => a.status === 'draft')?.id ?? null,
  });
  setState({ runtime: await api.runtimeStatus() });
}
