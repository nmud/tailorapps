// Tailor backend. Two routes:
//   POST /tailor/signup  create an account that can sign in right away
//   POST /tailor/chat    call Muse for a signed-in user (the Muse key never leaves the server)
// Sign-in, refresh and password reset go straight to Supabase Auth from the app.

import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'npm:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const MUSE_BASE_URL = (Deno.env.get('MUSE_BASE_URL') ?? 'https://api.meta.ai/v1').replace(/\/+$/, '');
const DAILY_LIMIT = Number(Deno.env.get('TAILOR_DAILY_LIMIT') ?? 300);
// Spend-limit alerts don't stop billing, so cap everyone's total too.
const GLOBAL_DAILY_LIMIT = Number(Deno.env.get('TAILOR_GLOBAL_DAILY_LIMIT') ?? 3000);
// Requests from one network address per day, so throwaway accounts can't use up everyone's share.
const IP_DAILY_LIMIT = Number(Deno.env.get('TAILOR_IP_DAILY_LIMIT') ?? 1000);
const IP_SIGNUP_LIMIT = Number(Deno.env.get('TAILOR_IP_SIGNUP_LIMIT') ?? 20);
// Dollars. Meta's spend alerts don't stop billing, so Tailor stops itself before the budget runs out.
const BUDGET_TOTAL_USD = Number(Deno.env.get('TAILOR_BUDGET_USD') ?? 140);
const BUDGET_DAY_USD = Number(Deno.env.get('TAILOR_BUDGET_DAY_USD') ?? 40);
const BUDGET_USER_DAY_USD = Number(Deno.env.get('TAILOR_BUDGET_USER_DAY_USD') ?? 5);
// Meta's prices in dollars per million tokens, which is millionths of a dollar per token
// (dev.meta.ai/docs/pricing-rate-limits, October 2026). Reasoning is counted as output.
const PRICES: Record<string, { input: number; output: number }> = {
  'muse-spark-1.3': { input: 1.25, output: 4.25 },
  'muse-wonder-1.0': { input: 4, output: 20 },
};
// A model missing from the list is priced like the most expensive one.
const priceOf = (model: string) => PRICES[model] ?? { input: 4, output: 20 };
const micros = (usd: number) => Math.round(usd * 1_000_000);
// The largest request the app sends is a Builder fix with every file of one small app.
const MAX_BODY_CHARS = 400_000;
const ROLES = new Set(['system', 'user', 'assistant']);

// The Meta model for each job. People never choose; override with secrets if needed.
// maxTokens caps each reply (reasoning included), so one request can never run up a large bill.
const AGENTS: Record<string, { model: string; reasoning: string; maxTokens: number }> = {
  // Frequent, structured summarizing of counted activity: fast and cheap.
  observer: { model: Deno.env.get('MUSE_MODEL_OBSERVER') ?? 'muse-spark-1.3', reasoning: 'low', maxTokens: 12_000 },
  // Quick idea cards the person is waiting on: fast model, light reasoning (~10s for three).
  ideas: { model: Deno.env.get('MUSE_MODEL_IDEAS') ?? 'muse-spark-1.3', reasoning: 'low', maxTokens: 8_000 },
  // The full plan for the one idea being built: the most capable model.
  designer: { model: Deno.env.get('MUSE_MODEL_DESIGNER') ?? 'muse-wonder-1.0', reasoning: 'high', maxTokens: 20_000 },
  // Writing and fixing software: Muse Wonder is Meta's model for complex engineering.
  builder: { model: Deno.env.get('MUSE_MODEL_BUILDER') ?? 'muse-wonder-1.0', reasoning: 'high', maxTokens: 64_000 },
  // Using the app like its intended person would, step by step: many quick turns.
  tester: { model: Deno.env.get('MUSE_MODEL_TESTER') ?? 'muse-spark-1.3', reasoning: 'medium', maxTokens: 8_000 },
};

const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function fail(status: number, code: string, message: string) {
  return json({ error: { code, message } }, status);
}

interface Usage {
  prompt_tokens?: number;
  completion_tokens?: number;
}

/** The token counts in a streamed reply (sent last, because we ask for them with stream_options). */
async function streamUsage(stream: ReadableStream<Uint8Array>): Promise<Usage | undefined> {
  const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  let usage: Usage | undefined;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith('data:') || !line.includes('"usage"')) continue;
      try {
        usage = JSON.parse(line.slice(5)).usage ?? usage;
      } catch {
        // not JSON
      }
    }
  }
  return usage;
}

/** The caller's network address, kept only as a salted hash. */
async function ipHash(req: Request): Promise<string> {
  const ip = (req.headers.get('x-forwarded-for') ?? '').split(',')[0].trim() || req.headers.get('cf-connecting-ip') || 'unknown';
  const salt = Deno.env.get('TAILOR_IP_SALT') ?? SERVICE_KEY;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${salt}:${ip}`));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

async function signup(req: Request) {
  const { name, email, password } = await req.json().catch(() => ({}));
  const cleanEmail = String(email ?? '').trim().toLowerCase();
  const cleanName = String(name ?? '').trim().slice(0, 60);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) return fail(400, 'bad_email', 'Please enter a valid email address.');
  if (String(password ?? '').length < 8) return fail(400, 'weak_password', 'Your password needs at least 8 characters.');
  if (!cleanName) return fail(400, 'no_name', 'Please enter your name.');

  const { data: attempts, error: limitError } = await admin.rpc('tailor_take_signup', { p_ip: await ipHash(req) });
  if (limitError) return fail(500, 'signup_failed', 'Something went wrong. Please try again.');
  if (Number(attempts) > IP_SIGNUP_LIMIT) {
    return fail(429, 'too_many', 'Too many new accounts from this network today. Please try again tomorrow.');
  }

  const { error } = await admin.auth.admin.createUser({
    email: cleanEmail,
    password: String(password),
    email_confirm: true,
    user_metadata: { name: cleanName },
  });
  if (error) {
    if (/already|registered|exists/i.test(error.message)) {
      return fail(409, 'exists', 'There is already an account with this email. Try signing in.');
    }
    console.error('signup failed:', error.message);
    return fail(400, 'signup_failed', "We couldn't create your account. Please check your details and try again.");
  }
  return json({ ok: true });
}

async function chat(req: Request) {
  const token = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  if (!token) return fail(401, 'signed_out', 'Please sign in again.');
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data.user) return fail(401, 'signed_out', 'Please sign in again.');

  const apiKey = Deno.env.get('MUSE_API_KEY');
  if (!apiKey) return fail(503, 'not_configured', "Tailor's AI service isn't set up yet.");

  const raw = await req.text();
  if (raw.length > MAX_BODY_CHARS) return fail(413, 'too_large', 'That request is too large.');
  let body: { agent?: string; messages?: unknown[]; response_format?: unknown; stream?: boolean; reasoning?: boolean; max_tokens?: number };
  try {
    body = JSON.parse(raw);
  } catch {
    return fail(400, 'bad_request', 'Malformed request.');
  }
  const agent = AGENTS[body.agent ?? ''];
  if (!agent) return fail(400, 'bad_agent', 'Unknown agent.');
  // Plain text chat only: Tailor never sends images, tools or other message kinds.
  const messages = body.messages;
  const wellFormed =
    Array.isArray(messages) &&
    messages.length > 0 &&
    messages.length <= 40 &&
    messages.every((m) => {
      const msg = m as { role?: unknown; content?: unknown };
      return typeof msg === 'object' && msg !== null && ROLES.has(String(msg.role)) && typeof msg.content === 'string' && Object.keys(msg).length === 2;
    });
  if (!wellFormed) return fail(400, 'bad_messages', 'Malformed request.');
  const format = body.response_format as { type?: string } | undefined;
  if (format && format.type !== 'json_schema' && format.type !== 'json_object') return fail(400, 'bad_format', 'Malformed request.');

  // Every daily cap is checked and counted in one step, so parallel requests can't slip past.
  const { data: verdict, error: usageError } = await admin.rpc('tailor_take_request', {
    p_user: data.user.id,
    p_ip: await ipHash(req),
    p_user_limit: DAILY_LIMIT,
    p_ip_limit: IP_DAILY_LIMIT,
    p_global_limit: GLOBAL_DAILY_LIMIT,
  });
  if (usageError) return fail(500, 'usage_failed', 'Something went wrong. Please try again.');
  if (verdict === 'global') return fail(429, 'daily_limit', 'Tailor is very busy today. Please try again tomorrow.');
  if (verdict !== 'ok') return fail(429, 'daily_limit', "You've reached today's limit. Please try again tomorrow.");

  const asked = Number(body.max_tokens);
  const maxTokens = Number.isFinite(asked) && asked > 0 ? Math.min(Math.floor(asked), agent.maxTokens) : agent.maxTokens;
  // Set aside the most this request could cost (three characters a token is a generous count for the
  // input, plus a full-length reply), and only go ahead if every budget has room for it.
  const price = priceOf(agent.model);
  const day = new Date().toISOString().slice(0, 10);
  const reserved = Math.ceil((raw.length / 3) * price.input + maxTokens * price.output);
  const { data: room, error: budgetError } = await admin.rpc('tailor_reserve', {
    p_user: data.user.id,
    p_day: day,
    p_micros: reserved,
    p_total_limit: micros(BUDGET_TOTAL_USD),
    p_day_limit: micros(BUDGET_DAY_USD),
    p_user_day_limit: micros(BUDGET_USER_DAY_USD),
  });
  if (budgetError) return fail(500, 'usage_failed', 'Something went wrong. Please try again.');
  if (room === 'total') return fail(429, 'daily_limit', "Tailor's AI is resting for now. Please try again later.");
  if (room === 'day') return fail(429, 'daily_limit', 'Tailor is very busy today. Please try again tomorrow.');
  if (room !== 'ok') return fail(429, 'daily_limit', "You've reached today's limit. Please try again tomorrow.");

  // Replace the set-aside amount with the real cost. Failed calls cost nothing; a reply without
  // token counts keeps the full set-aside amount, so the budget is never undercounted.
  const settle = (usage: Usage | undefined, ok: boolean) => {
    const actual = usage
      ? Math.ceil((usage.prompt_tokens ?? 0) * price.input + (usage.completion_tokens ?? 0) * price.output)
      : ok
        ? reserved
        : 0;
    return admin.rpc('tailor_settle', { p_user: data.user.id, p_day: day, p_delta: actual - reserved });
  };

  const upstreamBody: Record<string, unknown> = { model: agent.model, messages, max_completion_tokens: maxTokens };
  if (body.reasoning !== false) upstreamBody.reasoning_effort = agent.reasoning;
  if (body.response_format) upstreamBody.response_format = body.response_format;
  if (body.stream) {
    upstreamBody.stream = true;
    upstreamBody.stream_options = { include_usage: true };
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${MUSE_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(upstreamBody),
    });
  } catch (e) {
    await settle(undefined, false);
    throw e;
  }

  // Pass Muse's response (or its error, so the app can adapt) straight through.
  const contentType = upstream.headers.get('content-type') ?? (body.stream ? 'text/event-stream' : 'application/json');
  const headers = { 'content-type': contentType, 'cache-control': 'no-store' };
  if (body.stream && upstream.ok && upstream.body) {
    const [toApp, toMeter] = upstream.body.tee();
    EdgeRuntime.waitUntil(
      streamUsage(toMeter)
        .then((usage) => settle(usage, true))
        .catch((e) => console.error('settle failed', e))
    );
    return new Response(toApp, { status: upstream.status, headers });
  }
  const text = await upstream.text();
  let usage: Usage | undefined;
  try {
    usage = JSON.parse(text).usage;
  } catch {
    // an error page
  }
  await settle(usage, upstream.ok);
  return new Response(text, { status: upstream.status, headers });
}

Deno.serve(async (req) => {
  const route = new URL(req.url).pathname.split('/').filter(Boolean).pop();
  if (req.method !== 'POST') return fail(405, 'method', 'Not allowed.');
  try {
    if (route === 'signup') return await signup(req);
    if (route === 'chat') return await chat(req);
    return fail(404, 'not_found', 'Not found.');
  } catch (e) {
    console.error(e);
    return fail(500, 'server_error', 'Something went wrong. Please try again.');
  }
});
