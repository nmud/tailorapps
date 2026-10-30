export type View = 'discover' | 'workshop' | 'deck' | 'memory' | 'settings';

export type EventSource = 'extension' | 'desktop' | 'demo';
export type EventKind = 'focus' | 'copy' | 'paste' | 'search' | 'download' | 'navigate' | 'tabs' | 'windows' | 'setup';

export interface ActivityEvent {
  id: number;
  ts: number;
  source: EventSource;
  kind: EventKind;
  app?: string | null;
  domain?: string | null;
  title?: string | null;
  url?: string | null;
  durationMs: number;
  meta?: Record<string, unknown> | null;
}

export interface LearningCfg {
  enabled: boolean;
  extension: boolean;
  desktop: boolean;
  includeSearchTerms: boolean;
  includePaths: boolean;
  denyApps: string[];
  denyDomains: string[];
  retentionDays: number;
}

/** A deterministic, countable observation computed from events (never invented by a model). */
export interface Signal {
  id: string;
  kind: 'flow' | 'chain' | 'pingpong' | 'dwell' | 'search' | 'tabs' | 'windows' | 'setup';
  label: string;
  contexts: string[];
  occurrences: number;
  sessions: number;
  totalSessions: number;
  lastSeen: number;
  /** Every contributing event came from the demo session. */
  demo: boolean;
  /** A few page or window titles, for context. */
  examples?: string[];
}

export type PatternKind =
  | 'information-transfer'
  | 'context-switching'
  | 'repetition'
  | 'lookup'
  | 'tracking'
  | 'organizing'
  | 'other';

/** The Observer's interpretation of one or more signals. */
export interface Pattern {
  id: string;
  signalIds: string[];
  title: string;
  description: string;
  friction: string;
  kind: PatternKind;
  contexts: string[];
  occurrences: number;
  sessions: number;
  totalSessions: number;
  evidence: string;
  confidence: number;
  firstSeen: number;
  lastSeen: number;
  status: 'active' | 'dismissed';
  demo: boolean;
}

export interface Profile {
  summary: string;
  focusAreas: string[];
  tools: string[];
  rhythms: string[];
  updatedAt: number;
  demo: boolean;
}

/** Live data from this computer an app may be allowed to read. */
export type FeedName = 'open-tabs' | 'open-windows' | 'ai-tools';

export type AccentName = 'moss' | 'ink' | 'clay' | 'tide' | 'plum' | 'ochre';

export interface AppSpec {
  summary: string;
  screens: { name: string; purpose: string }[];
  dataModel: string;
  interactions: string[];
  persistence: string;
  outOfScope: string[];
}

export interface Suggestion {
  id: string;
  createdAt: number;
  updatedAt: number;
  name: string;
  tagline: string;
  rationale: string;
  patternIds: string[];
  features: string[];
  dataIn: string;
  network: string[];
  feeds: FeedName[];
  icon: string;
  accent: AccentName;
  spec: AppSpec;
  builderNotes: string;
  status: 'new' | 'denied' | 'building' | 'built';
  origin: 'auto' | 'ask';
  ask?: string;
  denyReason?: string;
  appId?: string;
  edited: boolean;
  demo: boolean;
}

export interface SourceFile {
  path: string;
  content: string;
}

export interface AppRecord {
  id: string;
  suggestionId: string;
  name: string;
  tagline: string;
  rationale: string;
  evidence: string;
  icon: string;
  accent: AccentName;
  network: string[];
  feeds: FeedName[];
  spec: AppSpec;
  builderNotes: string;
  status: 'draft' | 'installed';
  version: number;
  builderLabel: string;
  createdAt: number;
  updatedAt: number;
  installedAt?: number;
  opens: number;
  lastOpenedAt?: number;
  lastTest?: TestReport;
  /** Start menu shortcut, once installed. */
  shortcut?: string;
}

export interface AppVersion {
  id: string;
  appId: string;
  version: number;
  createdAt: number;
  note: string;
  files: SourceFile[];
}

export type FeedbackKind = 'deny' | 'edit' | 'change' | 'approve' | 'remove' | 'discard' | 'pattern-wrong';

export interface FeedbackEntry {
  id: string;
  ts: number;
  kind: FeedbackKind;
  subject: string;
  detail: string;
  suggestionId?: string;
  appId?: string;
  patternId?: string;
}

export type AgentRole = 'observer' | 'designer' | 'builder' | 'tester';

/** What the Tester agent found when it used the app as its intended person. */
export interface TestReport {
  persona: string;
  tasks: { task: string; ok: boolean; note: string }[];
  problems: { severity: 'blocker' | 'major' | 'minor'; what: string; fix: string }[];
  summary: string;
  fixed: boolean;
  at: number;
}

export interface User {
  id: string;
  email: string;
  name: string;
}

export interface Settings {
  /** Look for patterns in the background. */
  autoAnalyze: boolean;
  /** Suggest ideas on its own when it finds something new. */
  autoSuggest: boolean;
  theme: 'system' | 'light' | 'dark' | 'ocean' | 'midnight';
  /** Put each app in the Start menu so it can be searched for and pinned. */
  startMenu: boolean;
}

export type JobPhase =
  | 'preparing'
  | 'writing'
  | 'building'
  | 'fixing'
  | 'checking'
  | 'testing'
  | 'revising'
  | 'ready'
  | 'failed';

export interface JobLogLine {
  ts: number;
  tone: 'info' | 'ok' | 'warn' | 'error';
  text: string;
}

export interface BuildJob {
  appId: string;
  phase: JobPhase;
  log: JobLogLine[];
  currentFile?: string;
  streamedChars: number;
  previewNonce: number;
  error?: string;
  busy: boolean;
  testReport?: TestReport;
}
