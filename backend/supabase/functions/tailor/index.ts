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
const MAX_BODY_CHARS = 1_500_000;

// The Meta model for each job. People never choose; override with secrets if needed.
const AGENTS: Record<string, { model: string; reasoning: string }> = {
  // Frequent, structured summarizing of counted activity: fast and cheap.
  observer: { model: Deno.env.get('MUSE_MODEL_OBSERVER') ?? 'muse-spark-1.3', reasoning: 'low' },
  // Ideation from patterns and feedback: rare, so use the most capable model.
  designer: { model: Deno.env.get('MUSE_MODEL_DESIGNER') ?? 'muse-wonder-1.0', reasoning: 'high' },
  // Writing and fixing software: Muse Wonder is Meta's model for complex engineering.
  builder: { model: Deno.env.get('MUSE_MODEL_BUILDER') ?? 'muse-wonder-1.0', reasoning: 'high' },
  // Using the app like its intended person would, step by step: many quick turns.
  tester: { model: Deno.env.get('MUSE_MODEL_TESTER') ?? 'muse-spark-1.3', reasoning: 'medium' },
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

async function signup(req: Request) {
  const { name, email, password } = await req.json().catch(() => ({}));
  const cleanEmail = String(email ?? '').trim().toLowerCase();
  const cleanName = String(name ?? '').trim().slice(0, 60);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) return fail(400, 'bad_email', 'Please enter a valid email address.');
  if (String(password ?? '').length < 8) return fail(400, 'weak_password', 'Your password needs at least 8 characters.');
  if (!cleanName) return fail(400, 'no_name', 'Please enter your name.');

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
    return fail(400, 'signup_failed', error.message);
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
  let body: { agent?: string; messages?: unknown[]; response_format?: unknown; stream?: boolean; reasoning?: boolean };
  try {
    body = JSON.parse(raw);
  } catch {
    return fail(400, 'bad_request', 'Malformed request.');
  }
  const agent = AGENTS[body.agent ?? ''];
  if (!agent) return fail(400, 'bad_agent', 'Unknown agent.');
  if (!Array.isArray(body.messages) || body.messages.length === 0 || body.messages.length > 40) {
    return fail(400, 'bad_messages', 'Malformed request.');
  }

  const { data: total } = await admin.rpc('tailor_usage_today');
  if (Number(total) >= GLOBAL_DAILY_LIMIT) {
    return fail(429, 'daily_limit', 'Tailor is very busy today. Please try again tomorrow.');
  }
  const { data: count, error: usageError } = await admin.rpc('tailor_bump_usage', { p_user: data.user.id });
  if (usageError) return fail(500, 'usage_failed', 'Something went wrong. Please try again.');
  if (Number(count) > DAILY_LIMIT) {
    return fail(429, 'daily_limit', "You've reached today's limit. Please try again tomorrow.");
  }

  const upstreamBody: Record<string, unknown> = { model: agent.model, messages: body.messages };
  if (body.reasoning !== false) upstreamBody.reasoning_effort = agent.reasoning;
  if (body.response_format) upstreamBody.response_format = body.response_format;
  if (body.stream) upstreamBody.stream = true;

  const upstream = await fetch(`${MUSE_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(upstreamBody),
  });

  // Pass Muse's response (or its error, so the app can adapt) straight through.
  const contentType = upstream.headers.get('content-type') ?? (body.stream ? 'text/event-stream' : 'application/json');
  return new Response(upstream.body, {
    status: upstream.status,
    headers: { 'content-type': contentType, 'cache-control': 'no-store' },
  });
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
