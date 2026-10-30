import { Channel, invoke } from '@tauri-apps/api/core';
import type { ActivityEvent, AgentRole, LearningCfg, SourceFile, User } from './types';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatRequest {
  agent: AgentRole;
  messages: ChatMessage[];
  responseFormat?: unknown;
  stream?: boolean;
  /** false drops the reasoning setting (for models that reject it). */
  reasoning?: boolean;
}

export interface RuntimeStatus {
  ingestPort: number;
  appsPort: number;
  extensionLastSeen: number;
  desktopLastSeen: number;
  platform: string;
}

export interface WorkspaceStatus {
  ready: boolean;
  nodeVersion: string | null;
  path: string;
}

export interface BuildResult {
  ok: boolean;
  errors: string[];
  durationMs: number;
  /** The build tooling failed, not the app's code. */
  crashed: boolean;
}

export const api = {
  eventsQuery: (since: number, opts: { until?: number; limit?: number; newestFirst?: boolean } = {}) =>
    invoke<ActivityEvent[]>('events_query', { since, ...opts }),
  eventsInsert: (events: Omit<ActivityEvent, 'id'>[]) => invoke<number>('events_insert', { events }),
  eventsDelete: (ids: number[]) => invoke<number>('events_delete', { ids }),
  eventsClear: (source?: string) => invoke<number>('events_clear', { source }),

  kvGet: <T>(key: string) => invoke<T | null>('kv_get', { key }),
  kvSet: (key: string, value: unknown) => invoke<void>('kv_set', { key, value }),
  docsList: <T>(collection: string) => invoke<T[]>('docs_list', { collection }),
  docsPut: (collection: string, id: string, data: unknown) => invoke<void>('docs_put', { collection, id, data }),
  docsDelete: (collection: string, id: string) => invoke<void>('docs_delete', { collection, id }),

  learningGet: () => invoke<LearningCfg>('learning_get'),
  learningSet: (cfg: LearningCfg) => invoke<LearningCfg>('learning_set', { cfg }),
  runtimeStatus: () => invoke<RuntimeStatus>('runtime_status'),

  authCurrent: () => invoke<User | null>('auth_current'),
  authLogin: (email: string, password: string) => invoke<User>('auth_login', { email, password }),
  authSignup: (name: string, email: string, password: string) => invoke<User>('auth_signup', { name, email, password }),
  authLogout: () => invoke<void>('auth_logout'),
  authSendReset: (email: string) => invoke<void>('auth_send_reset', { email }),
  authConfirmReset: (email: string, code: string, password: string) =>
    invoke<User>('auth_confirm_reset', { email, code, password }),
  extensionReveal: () => invoke<string>('extension_reveal'),

  llmChat: (req: ChatRequest, onDelta?: (chunk: string) => void) => {
    const ch = new Channel<string>();
    if (onDelta) ch.onmessage = onDelta;
    return invoke<string>('llm_chat', { req, onDelta: ch });
  },

  workspaceStatus: () => invoke<WorkspaceStatus>('workspace_status'),
  workspacePrepare: (onLog: (line: string) => void) => {
    const ch = new Channel<string>();
    ch.onmessage = onLog;
    return invoke<WorkspaceStatus>('workspace_prepare', { onLog: ch });
  },

  appCreate: (id: string, manifest: unknown) => invoke<string>('app_create', { id, manifest }),
  appWriteFiles: (id: string, files: SourceFile[], opts: { delete?: string[]; replace?: boolean } = {}) =>
    invoke<string[]>('app_write_files', { id, files, ...opts }),
  appReadFiles: (id: string) => invoke<SourceFile[]>('app_read_files', { id }),
  appBuild: (id: string) => invoke<BuildResult>('app_build', { id }),
  appDelete: (id: string) => invoke<void>('app_delete', { id }),
  appOpenWindow: (id: string) => invoke<void>('app_open_window', { id }),
  appSetIcon: (id: string, png: number[]) => invoke<void>('app_set_icon', { id, png }),
  appInstall: (id: string, name: string, description: string) => invoke<string>('app_install', { id, name, description }),
  appUninstall: (id: string, shortcut?: string) => invoke<void>('app_uninstall', { id, shortcut }),
  appCloseWindow: (id: string) => invoke<void>('app_close_window', { id }),
};

export const APPS_PORT = 48100;
export const INGEST_PORT = 47821;
export const appUrl = (id: string) => `http://${id}.localhost:${APPS_PORT}/`;
export const appHost = (id: string) => `${id}.localhost:${APPS_PORT}`;
