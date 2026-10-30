// Tester agent: before an app reaches its person, a Muse agent role-plays that person and
// actually uses the app (reads the screen, clicks, types) in a hidden copy. It sees the app's
// description and a one-line sketch of the person; never their activity.

import { appUrl } from '../lib/api';
import { chatJSON } from '../lib/llm';
import { getState, setState } from '../lib/store';
import type { AppRecord, TestReport } from '../lib/types';

const MAX_STEPS = 14;
const REPLY_MS = 8000;

interface Control {
  ref: string;
  role: string;
  name: string;
  value?: string;
  on?: boolean;
  disabled?: boolean;
}

interface Screen {
  title: string;
  text: string;
  elements: Control[];
  errors: string[];
  notes: string[];
  smallTargets: number;
  tinyText: number;
  problem?: string;
}

// ── talking to the hidden test copy ─────────────────────────────────────────

let seq = 0;
const waiting = new Map<number, (v: unknown) => void>();
let frameReady: (() => void) | null = null;

/** Called by the app shell for messages from a generated app's own address. */
export function reportTestMessage(appId: string, kind: string, data: { id?: number; result?: unknown }) {
  const frame = getState().testFrame;
  if (!frame || frame.appId !== appId) return;
  if (kind === 'ready' && frameReady) {
    frameReady();
    frameReady = null;
  }
  if (kind === 'test-result' && typeof data.id === 'number') {
    waiting.get(data.id)?.(data.result);
    waiting.delete(data.id);
  }
}

function frameWindow(): Window | null {
  return (document.getElementById('tailor-test-frame') as HTMLIFrameElement | null)?.contentWindow ?? null;
}

function send<T>(appId: string, cmd: Record<string, unknown>): Promise<T> {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      waiting.delete(id);
      reject(new Error('The app stopped responding during the test.'));
    }, REPLY_MS);
    waiting.set(id, (v) => {
      clearTimeout(timer);
      resolve(v as T);
    });
    frameWindow()?.postMessage({ source: 'tailor-test', id, ...cmd }, appUrl(appId).replace(/\/$/, ''));
  });
}

async function openFrame(appId: string) {
  const loaded = new Promise<void>((resolve, reject) => {
    frameReady = resolve;
    setTimeout(() => reject(new Error('The app didn’t load for testing.')), 15000);
  });
  setState({ testFrame: { appId, nonce: Date.now() } });
  await loaded;
}

function closeFrame() {
  setState({ testFrame: null });
  frameReady = null;
  waiting.clear();
}

// ── the agent ───────────────────────────────────────────────────────────────

function describe(s: Screen): string {
  const controls = s.elements
    .map((c) => {
      const extras = [c.value !== undefined ? `value="${c.value}"` : '', c.on ? 'on' : '', c.disabled ? 'disabled' : ''].filter(Boolean).join(' ');
      return `[${c.ref}] ${c.role} "${c.name}"${extras ? ' ' + extras : ''}`;
    })
    .join('\n');
  return [
    `Window title: ${s.title}`,
    s.problem ? `Last action problem: ${s.problem}` : '',
    s.errors.length ? `Errors on screen: ${s.errors.join(' | ')}` : '',
    s.notes.length ? `Happened: ${s.notes.join(' | ')}` : '',
    'Visible text:',
    s.text || '(nothing)',
    'Controls you can use:',
    controls || '(none)',
  ]
    .filter(Boolean)
    .join('\n');
}

function persona(): string {
  const profile = getState().profile;
  const about = profile?.summary ? `What Tailor knows about how they work: ${profile.summary}` : 'They are a busy person.';
  return `The person this app was made for. They are not technical and may not be young. ${about}`;
}

const STEP_SYSTEM = `You are the Tester agent inside Tailor. You role-play the real person an app was made for and use the app the way they would, one action at a time, before it is handed to them.

Each turn you see the screen: visible text and the controls you can use, each with a ref like [e12]. Reply with one action:
- click: press a button, link, tab, checkbox or list item (ref required)
- type: replace the text in a field (ref and text required). Use realistic content for this person, not "test".
- select: choose an option in a dropdown (ref and the option text)
- press: press Enter in a field (ref required)
- finish: you have tried every task (or are stuck)
Work through the tasks in order. Notice what a real person would trip over: unclear words, buttons that do nothing, missing feedback, jargon, errors. Don't repeat the same failing action more than twice. Use "" for unused fields.`;

const STEP_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['thought', 'action', 'ref', 'text'],
  properties: {
    thought: { type: 'string' },
    action: { type: 'string', enum: ['click', 'type', 'select', 'press', 'finish'] },
    ref: { type: 'string' },
    text: { type: 'string' },
  },
};

const REPORT_SYSTEM = `You are the Tester agent inside Tailor. You just used an app as the person it was made for. Write an honest report in plain, everyday words.
- tasks: one entry per task you were given; ok only if it actually worked on screen.
- problems: what got in the way. severity "blocker" = a task can't be done; "major" = confusing or broken but there's a way around; "minor" = polish. Each has a concrete fix for the builder.
- summary: one or two sentences, written to the person ("It works well for...", "Adding a paper was confusing because...").
Only report what you saw. If everything worked, problems can be empty.`;

const REPORT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['tasks', 'problems', 'summary'],
  properties: {
    tasks: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['task', 'ok', 'note'],
        properties: { task: { type: 'string' }, ok: { type: 'boolean' }, note: { type: 'string' } },
      },
    },
    problems: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['severity', 'what', 'fix'],
        properties: {
          severity: { type: 'string', enum: ['blocker', 'major', 'minor'] },
          what: { type: 'string' },
          fix: { type: 'string' },
        },
      },
    },
    summary: { type: 'string' },
  },
};

interface Step {
  thought: string;
  action: 'click' | 'type' | 'select' | 'press' | 'finish';
  ref: string;
  text: string;
}

/** Use the app as its person would. Progress lines go to `log`. */
export async function testApp(app: AppRecord, log: (line: string) => void): Promise<TestReport> {
  const tasks = app.spec.interactions.length ? app.spec.interactions.slice(0, 4) : app.tagline ? [app.tagline] : ['Use the app'];
  const who = persona();
  const brief = [
    `App: ${app.name}. ${app.tagline}`,
    `What it should do: ${app.spec.summary}`,
    `Promised features:\n${(app.spec.interactions.length ? app.spec.interactions : [app.tagline]).map((f) => `- ${f}`).join('\n')}`,
    `You are: ${who}`,
    `Your tasks, in order:\n${tasks.map((t, i) => `${i + 1}. ${t}`).join('\n')}`,
  ].join('\n\n');

  await openFrame(app.id);
  const history: string[] = [];
  let screen: Screen;
  let lastShown = '';
  try {
    screen = await send<Screen>(app.id, { op: 'begin' });
    for (let i = 0; i < MAX_STEPS; i++) {
      const step = await chatJSON<Step>(
        'tester',
        STEP_SYSTEM,
        `${brief}\n\nWhat you've done so far:\n${history.length ? history.join('\n') : '(nothing yet)'}\n\nThe screen now:\n${describe(screen)}`,
        { name: 'tester_step', schema: STEP_SCHEMA }
      );
      if (step.action === 'finish') break;
      const control = screen.elements.find((c) => c.ref === step.ref);
      const label = control ? `${control.role} "${control.name}"` : step.ref;
      const line = step.action === 'type' ? `Typed "${step.text}" into ${label}` : step.action === 'select' ? `Chose "${step.text}" in ${label}` : step.action === 'press' ? `Pressed Enter in ${label}` : `Clicked ${label}`;
      if (line !== lastShown) log(line);
      lastShown = line;
      screen = await send<Screen>(app.id, { op: step.action, ref: step.ref, text: step.text });
      history.push(`${i + 1}. ${line}${screen.problem ? ` (problem: ${screen.problem})` : ''}${screen.errors.length ? ` (error: ${screen.errors[screen.errors.length - 1]})` : ''}`);
    }

    const report = await chatJSON<Omit<TestReport, 'persona' | 'fixed' | 'at'>>(
      'tester',
      REPORT_SYSTEM,
      `${brief}\n\nWhat you did:\n${history.join('\n') || '(nothing)'}\n\nThe final screen:\n${describe(screen)}\n\nAutomatic checks: ${screen.smallTargets} controls smaller than 28px; ${screen.tinyText} bits of text smaller than 13px.`,
      { name: 'tester_report', schema: REPORT_SCHEMA }
    );
    return { ...report, persona: who, fixed: false, at: Date.now() };
  } finally {
    await send(app.id, { op: 'end' }).catch(() => {});
    closeFrame();
  }
}
