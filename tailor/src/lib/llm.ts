import { api, type ChatMessage, type ChatRequest } from './api';
import { getState } from './store';
import type { AgentRole } from './types';
import { errorText } from './util';

/** Muse is reached through Tailor's backend, so the only requirement is being signed in. */
export function modelReady(_role?: AgentRole): { ok: boolean; reason?: string } {
  return getState().user ? { ok: true } : { ok: false, reason: 'Please sign in again.' };
}

/** Technical failures become one plain sentence; the details go to the console. */
export function friendlyError(e: unknown): string {
  const msg = errorText(e);
  if (/^HTTP \d+/.test(msg) || /JSON|parse|Unexpected/i.test(msg)) {
    console.warn('Tailor:', msg);
    return 'Tailor couldn’t finish that. Please try again in a moment.';
  }
  return msg;
}

function looksLike(err: string, words: RegExp) {
  return /HTTP (400|404|415|422)/.test(err) && words.test(err);
}

export interface ChatOptions {
  json?: { name: string; schema: Record<string, unknown> };
  stream?: boolean;
  onDelta?: (chunk: string) => void;
}

/** One call to an agent, retrying without optional features the model may not support. */
export async function chat(agent: AgentRole, messages: ChatMessage[], opts: ChatOptions = {}): Promise<string> {
  const formats: (unknown | undefined)[] = opts.json
    ? [
        { type: 'json_schema', json_schema: { name: opts.json.name, strict: true, schema: opts.json.schema } },
        { type: 'json_object' },
        undefined,
      ]
    : [undefined];

  let req: ChatRequest = { agent, messages, stream: opts.stream };
  let lastError = '';
  for (let i = 0; i < formats.length; i++) {
    try {
      return await api.llmChat({ ...req, responseFormat: formats[i] }, opts.onDelta);
    } catch (e) {
      lastError = errorText(e);
      if (req.reasoning !== false && looksLike(lastError, /reasoning/i)) {
        req = { ...req, reasoning: false };
        i--;
        continue;
      }
      if (req.stream && looksLike(lastError, /stream/i)) {
        req = { ...req, stream: false };
        i--;
        continue;
      }
      const formatProblem = looksLike(lastError, /response_format|json_schema|json_object|schema|structured/i);
      if (!formatProblem || i === formats.length - 1) throw new Error(lastError);
    }
  }
  throw new Error(lastError);
}

export function parseJSON<T>(text: string): T {
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1].trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('The model did not return JSON.');
  return JSON.parse(t.slice(start, end + 1)) as T;
}

export async function chatJSON<T>(
  agent: AgentRole,
  system: string,
  user: string,
  json: { name: string; schema: Record<string, unknown> }
): Promise<T> {
  const messages: ChatMessage[] = [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
  const text = await chat(agent, messages, { json });
  try {
    return parseJSON<T>(text);
  } catch {
    const retry = await chat(
      agent,
      [...messages, { role: 'assistant', content: text }, { role: 'user', content: 'That was not valid JSON. Reply with only the JSON object that matches the schema.' }],
      { json }
    );
    return parseJSON<T>(retry);
  }
}
