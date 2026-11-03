// Builder agent: writes, builds, checks and revises one app. It receives only the approved
// spec (never activity, patterns or profile) and can write only inside the app's src/ folder.

import { api, type ChatMessage } from '../lib/api';
import { chat, friendlyError, modelReady } from '../lib/llm';
import { getState, recordFeedback, save, setState, toast } from '../lib/store';
import type { AppRecord, BuildJob, JobLogLine, JobPhase, SourceFile, Suggestion, TestReport } from '../lib/types';
import { testApp } from './tester';
import { makeAppIcon } from '../lib/appIcon';
import { planApp } from './designer';
import { errorText, uniqueSlug } from '../lib/util';

const MAX_BUILD_FIXES = 3;
const MAX_RUNTIME_FIXES = 2;
const RUNTIME_CHECK_MS = 9000;

const KIT = `Tailor app kit (src/tailor.css, already imported):
Variables: --t-paper (page bg), --t-surface (cards), --t-surface-2 (sunken/hover), --t-line, --t-line-strong, --t-ink, --t-ink-2, --t-muted, --t-accent, --t-accent-strong, --t-accent-soft (tinted bg), --t-accent-ink (text on accent), --t-danger, --t-ok, --t-warn; spacing --t-1..--t-8 (4,8,12,16,24,32,48,64px); --t-radius-sm/--t-radius/--t-radius-lg; --t-shadow; fonts --t-font, --t-font-display, --t-font-mono; sizes --t-text-xs/sm/md/lg/xl/2xl.
Layout: .t-app (root wrapper, full height column) · .t-header (sticky top bar; put .t-title + actions inside) · .t-main (centred content, padded) · .t-split (sidebar + content grid) with .t-sidebar · .t-stack / .t-stack--lg (vertical gap) · .t-row / .t-row--between (horizontal, wraps) · .t-spacer · .t-grid (auto-fill cards) · .t-toolbar · .t-divider · .t-muted · .t-small
Controls: .t-btn (+ .t-btn--primary | --ghost | --danger | --sm | --icon; lucide icons size automatically) · .t-input · .t-textarea · .t-select · .t-field (wraps .t-label + control + .t-hint) · .t-check (label wrapping a checkbox)
Surfaces: .t-card (+ --flat | --interactive | --selected) · .t-list > .t-list-item (aria-current="true" or .is-active marks selection) · .t-chip (+ --accent; as <button aria-pressed> for filters) · .t-badge · .t-empty (dashed empty state with h3 + p + button) · .t-table (th/td styled, sticky header) · .t-tabs > .t-tab[aria-selected] · .t-kbd · .t-progress > span (width %) · dialog.t-dialog (native <dialog>, use showModal())
Headings h1–h3 are styled. Body uses tabular numbers.
The kit switches to a dark palette automatically when Tailor is in a dark theme, so never hard-code colours: always use the variables above.`;

const FEED_DOCS: Record<string, string> = {
  'open-tabs':
    "readFeed<OpenTab>('open-tabs'): the browser tabs open right now ({ title, url, domain, windowId, active, lastAccessed }). Titles are null for private sites like email.",
  'open-windows': "readFeed<OpenWindow>('open-windows'): windows open on this computer ({ app, title }); app is the program name such as \"code\" or \"windowsterminal\".",
  'ai-tools':
    "readFeed<AiTool>('ai-tools'): what the person's AI tools have set up ({ app, kind: 'mcp-server' | 'connector' | 'plugin' | 'skill', name, scope, project }). Names only.",
};

function feedText(app: AppRecord): string {
  const feeds = app.feeds ?? [];
  if (!feeds.length) return '- Live data: none. The app only knows what the person puts into it.';
  return [
    "- Live data from this computer: the person allowed this app to read the feeds below. Import from './tailor' (managed by Tailor, already exists): import { readFeed, openLink, type OpenTab, type OpenWindow, type AiTool } from './tailor'.",
    ...feeds.map((f) => `  - ${FEED_DOCS[f]}`),
    "  - readFeed is async: always `const feed = await readFeed<...>('<name>')` inside an async function (in React, an async helper called from useEffect and from the Refresh button). Without await you get a Promise, not the data, and the app shows nothing.",
    '  - It resolves to { available: boolean, reason?: string, updatedAt?: number (milliseconds since 1970; show it with new Date(updatedAt)), items: T[] }. When available is false, show `reason` in a friendly empty state. Refresh every 10 seconds and offer a Refresh button. The data is read-only.',
    '  - To open a web address in the browser, call openLink(url). Do not use window.open or target="_blank".',
    '  - Let the person add their own notes, names, groups or pins on top of the live data, saved in localStorage.',
  ].join('\n');
}

function systemPrompt(app: AppRecord): string {
  const net = app.network.length
    ? `Allowed only to these HTTPS hosts: ${app.network.join(', ')}. Handle failures and offline gracefully.`
    : 'None. Do not call fetch/XMLHttpRequest/WebSocket to other sites; a Content-Security-Policy blocks it.';
  return `You are the Builder agent inside Tailor. Tailor builds small personal tools for one person. You write complete, working, polished single-page apps.

Runtime and constraints:
- React 19 + TypeScript, bundled by Vite. The entry src/main.tsx already exists and is managed by Tailor: it imports './tailor.css' and './app.css' and renders the default export of './App' (src/App.tsx) inside an error boundary.
- You may import ONLY 'react', 'react-dom', 'lucide-react' (icons, e.g. import { Plus, Trash2 } from 'lucide-react'), and your own relative files. No other packages exist.
- No backend. Persist all user data in localStorage under keys starting with "${app.id}:". Write a small typed usePersistentState hook. Data must survive reloads.
- Network: ${net}
${feedText(app)}
- No routing library (use state). No external fonts, images or CDNs. No inline <script>.
- The app opens in its own ~1100x780 window and must also work at 480px wide.
- Getting data in: prefer paste, drag-and-drop files (FileReader), and manual entry. If the app holds user data, offer "Back up" (download a file) and "Restore" (load that file) buttons.
- Use the app kit classes and variables below for a calm, consistent look. Put app-specific layout in src/app.css using the kit variables. Do not restyle kit classes globally.
- The person using it may be any age and not technical. Use plain everyday words in the UI (no jargon like JSON, ID, or localStorage; say Save, Back up, Restore), readable text (at least 15px), and large, clearly labelled buttons.
- Quality bar: every control works; empty states explain the first step; keyboard and screen-reader friendly (labels, real buttons); no lorem ipsum, no fake sample data unless the spec asks for an example; no console errors; no TODOs. Small and excellent beats sprawling.
- Write correct, strict TypeScript (the build does not type-check, but syntax errors fail it). Avoid any.

${KIT}

Output format. Return ONLY file blocks, then optionally one final line starting with NOTES:
<<<FILE src/App.tsx>>>
(full file contents)
<<<END>>>
Required: src/App.tsx (default export) and src/app.css. You may add files under src/ (e.g. src/components/Board.tsx, src/lib/store.ts). Never output src/main.tsx, src/tailor.css or src/tailor.ts. Do not wrap contents in markdown fences.`;
}

function specText(app: AppRecord): string {
  const s = app.spec;
  return [
    `Name: ${app.name}`,
    `Purpose: ${app.tagline}`,
    `Storage key prefix: "${app.id}:"`,
    '',
    `Summary: ${s.summary}`,
    'Screens:',
    ...s.screens.map((x) => `- ${x.name}: ${x.purpose}`),
    `Data model: ${s.dataModel}`,
    'Key interactions:',
    ...s.interactions.map((x) => `- ${x}`),
    `Persistence: ${s.persistence}`,
    'Out of scope:',
    ...s.outOfScope.map((x) => `- ${x}`),
    app.builderNotes ? `\nNotes from the user: ${app.builderNotes}` : '',
  ].join('\n');
}

function filesText(files: SourceFile[]): string {
  return files.map((f) => `<<<FILE ${f.path}>>>\n${f.content}\n<<<END>>>`).join('\n\n');
}

export function parseFileBlocks(text: string): { files: SourceFile[]; deletes: string[]; notes?: string } {
  const files: SourceFile[] = [];
  const strip = (c: string) => c.replace(/^\s*```[\w-]*\s*\n/, '').replace(/\n```\s*$/, '');
  for (const m of text.matchAll(/<<<FILE\s+([^\s>]+)\s*>>>[ \t]*\r?\n([\s\S]*?)\r?\n?<<<END>>>/g)) {
    files.push({ path: m[1].trim(), content: strip(m[2]) + '\n' });
  }
  if (!files.length) {
    // Fallback: a filename line followed by a fenced block.
    const re = /(?:^|\n)[#*`\s]*(src\/[\w/.-]+\.(?:tsx|ts|css|json))[`*:\s]*\n```[\w-]*\n([\s\S]*?)\n```/g;
    for (const m of text.matchAll(re)) files.push({ path: m[1], content: m[2] + '\n' });
  }
  const deletes = [...text.matchAll(/<<<DELETE\s+([^\s>]+)\s*>>>/g)].map((m) => m[1]);
  const notes = text.match(/^NOTES:\s*(.+)$/m)?.[1]?.trim();
  const unique = new Map(files.map((f) => [f.path.replace(/^\.\//, ''), { ...f, path: f.path.replace(/^\.\//, '') }]));
  return { files: [...unique.values()], deletes, notes };
}

// ── job state ───────────────────────────────────────────────────────────────

function job(): BuildJob | null {
  return getState().job;
}

function patchJob(patch: Partial<BuildJob>) {
  const j = job();
  if (j) setState({ job: { ...j, ...patch } });
}

function log(text: string, tone: JobLogLine['tone'] = 'info') {
  const j = job();
  if (j) setState({ job: { ...j, log: [...j.log, { ts: Date.now(), tone, text }] } });
}

function phase(p: JobPhase, text?: string) {
  patchJob({ phase: p, currentFile: undefined, streamedChars: 0 });
  if (text) log(text);
}

function streamTracker() {
  let buffer = '';
  let seen = 0;
  return (chunk: string) => {
    buffer += chunk;
    const j = job();
    if (!j) return;
    const marks = [...buffer.matchAll(/<<<FILE\s+([^\s>]+)\s*>>>/g)].map((m) => m[1]);
    const fresh = marks.slice(seen).map((path): JobLogLine => ({ ts: Date.now(), tone: 'info', text: `Writing ${path}` }));
    seen = marks.length;
    setState({
      job: { ...j, currentFile: marks[marks.length - 1] ?? j.currentFile, streamedChars: buffer.length, log: fresh.length ? [...j.log, ...fresh] : j.log },
    });
  };
}

async function generate(messages: ChatMessage[]): Promise<string> {
  return chat('builder', messages, { stream: true, onDelta: streamTracker() });
}

// ── runtime check (preview iframe reports via postMessage) ──────────────────

let pendingCheck: { appId: string; resolve: (r: { ok: boolean; message?: string }) => void } | null = null;

export function reportRuntime(appId: string, kind: string, message: string) {
  if (!pendingCheck || pendingCheck.appId !== appId) return;
  if (kind === 'error') pendingCheck.resolve({ ok: false, message });
  else if (kind === 'ready') pendingCheck.resolve(message === 'empty' ? { ok: false, message: 'The app rendered nothing (the root element stayed empty).' } : { ok: true });
}

function waitForRuntime(appId: string): Promise<{ ok: boolean; message?: string; unchecked?: boolean }> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingCheck = null;
      resolve({ ok: true, unchecked: true });
    }, RUNTIME_CHECK_MS);
    pendingCheck = {
      appId,
      resolve: (r) => {
        clearTimeout(timer);
        pendingCheck = null;
        resolve(r);
      },
    };
  });
}

// ── workspace ───────────────────────────────────────────────────────────────

let preparing: Promise<void> | null = null;

/** Refresh Tailor-owned template files and install the shared runtime if needed. */
export function ensureWorkspace(force = false): Promise<void> {
  if (preparing) return preparing;
  if (getState().workspace.ready && !force) return Promise.resolve();
  setState({ workspace: { ...getState().workspace, preparing: true, error: undefined } });
  preparing = (async () => {
    try {
      const status = await api.workspacePrepare((line) => {
        const cur = getState().workspace;
        setState({ workspace: { ...cur, log: [...cur.log.slice(-40), line] } });
        if (job()?.busy) log(line);
      });
      setState({ workspace: { ...getState().workspace, ready: status.ready, preparing: false, node: status.nodeVersion } });
      if (!status.ready) throw new Error('The builder runtime did not finish installing.');
    } catch (e) {
      const error = errorText(e);
      setState({ workspace: { ...getState().workspace, preparing: false, error } });
      throw new Error(error);
    } finally {
      preparing = null;
    }
  })();
  return preparing;
}

// ── build loop ──────────────────────────────────────────────────────────────

function manifest(app: AppRecord) {
  return { id: app.id, name: app.name, accent: app.accent, network: app.network, feeds: app.feeds ?? [], version: app.version };
}

async function snapshot(app: AppRecord, note: string): Promise<AppRecord> {
  const files = await api.appReadFiles(app.id);
  const version = app.version + 1;
  await save.version({ id: `${app.id}@${version}`, appId: app.id, version, createdAt: Date.now(), note, files });
  const next = { ...app, version };
  await save.app(next);
  return next;
}

async function applyOutput(appId: string, text: string, requireApp: boolean): Promise<number> {
  const { files, deletes, notes } = parseFileBlocks(text);
  const writable = files.filter((f) => f.path.startsWith('src/') && !['src/main.tsx', 'src/tailor.css', 'src/tailor.ts'].includes(f.path));
  if (!writable.length && !deletes.length) throw new Error('The Builder returned no files.');
  if (requireApp && !writable.some((f) => f.path === 'src/App.tsx')) throw new Error('The Builder did not write src/App.tsx.');
  const written = await api.appWriteFiles(appId, writable, { delete: deletes });
  log(`Wrote ${written.length} file${written.length === 1 ? '' : 's'}: ${written.join(', ')}`, 'ok');
  if (notes) log(`Builder notes: ${notes}`);
  return written.length;
}

/**
 * Mistakes the build can't see because it doesn't type-check. Today: reading live data without
 * waiting for it, which builds fine and then always shows an empty list.
 */
export function codeChecks(files: { path: string; content: string }[]): string[] {
  const problems: string[] = [];
  for (const f of files) {
    if (!f.path.startsWith('src/') || f.path === 'src/tailor.ts') continue;
    const code = f.content.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length));
    for (const m of code.matchAll(/\breadFeed\s*(?:<[^>()]*>)?\s*\(/g)) {
      const before = code.slice(0, m.index).trimEnd();
      const waited = /(?:\bawait|\breturn|=>)$/.test(before) || /\bPromise\.all(?:Settled)?\s*\(\s*\[[^;]*$/.test(before.slice(-400));
      let depth = 0;
      let end = m.index! + m[0].length - 1;
      for (; end < code.length; end++) {
        if (code[end] === '(') depth++;
        else if (code[end] === ')' && --depth === 0) break;
      }
      const chained = /^\s*\.\s*(?:then|catch|finally)\s*\(/.test(code.slice(end + 1));
      if (waited || chained) continue;
      const line = code.slice(0, m.index).split('\n').length;
      problems.push(
        `${f.path}:${line}: readFeed(...) returns a Promise, so it must be awaited: const feed = await readFeed<...>('<name>') inside an async function. Without await the app never sees the live data. Its updatedAt is a number (milliseconds), not a string.`
      );
    }
  }
  return problems;
}

async function buildUntilGreen(app: AppRecord, note: string, opts: { test?: boolean } = {}): Promise<AppRecord | null> {
  let runtimeFixes = 0;
  let tested = !opts.test;
  for (let attempt = 0; attempt <= MAX_BUILD_FIXES; attempt++) {
    phase('building', attempt === 0 ? 'Building' : `Rebuilding (attempt ${attempt + 1})`);
    const built = await api.appBuild(app.id);
    // New code only: restoring a saved version puts it back exactly as it was.
    const problems = built.ok && opts.test ? codeChecks(await api.appReadFiles(app.id)) : [];
    const res = problems.length ? { ...built, ok: false, errors: problems } : built;
    if (!res.ok) {
      log(res.errors.join('\n').slice(0, 1600), 'error');
      if (!built.ok && built.crashed) throw new Error('Tailor couldn’t build apps right now. Please restart Tailor and try again.');
      if (attempt === MAX_BUILD_FIXES) throw new Error('The build still fails after several fixes.');
      phase('fixing', 'Sending build errors back to the Builder');
      const files = await api.appReadFiles(app.id);
      const text = await generate([
        { role: 'system', content: systemPrompt(app) },
        {
          role: 'user',
          content: `The build failed. Fix it with the smallest change that works. Return only the files you change, each in full.\n\nBuild errors:\n${res.errors.join('\n\n')}\n\nSpec:\n${specText(app)}\n\nCurrent files:\n${filesText(files)}`,
        },
      ]);
      await applyOutput(app.id, text, false);
      continue;
    }

    log(`Build passed in ${(res.durationMs / 1000).toFixed(1)}s`, 'ok');
    phase('checking', 'Loading the app to check for runtime errors');
    patchJob({ previewNonce: Date.now() });
    const check = await waitForRuntime(app.id);
    if (check.ok) {
      log(check.unchecked ? 'Preview not visible; skipped the live check' : 'Rendered without errors', check.unchecked ? 'warn' : 'ok');
      if (!tested) {
        tested = true;
        const report = await humanTest(app);
        const serious = report?.problems.filter((p) => p.severity !== 'minor') ?? [];
        if (report && serious.length) {
          phase('fixing', 'Fixing what the test turned up');
          const files = await api.appReadFiles(app.id);
          const text = await generate([
            { role: 'system', content: systemPrompt(app) },
            {
              role: 'user',
              content: [
                'Before handing the app over, a tester who is the person it was made for tried it. Fix these problems with the smallest changes that work. Return only the files you change, each in full.',
                `What they tried:\n${report.tasks.map((t) => `- ${t.ok ? 'worked' : 'FAILED'}: ${t.task} (${t.note})`).join('\n')}`,
                `Problems:\n${serious.map((p) => `- [${p.severity}] ${p.what} → fix: ${p.fix}`).join('\n')}`,
                `Spec:\n${specText(app)}`,
                `Current files:\n${filesText(files)}`,
              ].join('\n\n'),
            },
          ]);
          await applyOutput(app.id, text, false);
          const fixed = { ...report, fixed: true };
          patchJob({ testReport: fixed });
          await saveTest(app.id, fixed);
          attempt = -1;
          continue;
        }
      }
      return snapshot(app, note);
    }
    log(`Runtime error: ${check.message}`, 'error');
    if (runtimeFixes >= MAX_RUNTIME_FIXES) {
      log('Keeping this version. You can describe the problem as a change.', 'warn');
      return snapshot(app, note);
    }
    runtimeFixes++;
    attempt = -1; // a runtime fix starts a fresh build cycle
    phase('fixing', 'Sending the runtime error back to the Builder');
    const files = await api.appReadFiles(app.id);
    const text = await generate([
      { role: 'system', content: systemPrompt(app) },
      {
        role: 'user',
        content: `The app builds but throws when it loads:\n${check.message}\n\nFind and fix the cause. Return only the files you change, each in full.\n\nSpec:\n${specText(app)}\n\nCurrent files:\n${filesText(files)}`,
      },
    ]);
    await applyOutput(app.id, text, false);
  }
  return null;
}

/** Let the Tester agent use the app as its person would. A failed test never blocks the build. */
async function humanTest(app: AppRecord): Promise<TestReport | null> {
  phase('testing', 'Trying the app the way you would');
  try {
    const report = await testApp(app, (line) => log(line));
    const worked = report.tasks.filter((t) => t.ok).length;
    log(`Tested: ${worked} of ${report.tasks.length} tasks worked${report.problems.length ? `, ${report.problems.length} thing${report.problems.length === 1 ? '' : 's'} to improve` : ''}`, worked === report.tasks.length ? 'ok' : 'warn');
    patchJob({ testReport: report });
    await saveTest(app.id, report);
    return report;
  } catch (e) {
    log(`Skipped the hands-on test: ${errorText(e)}`, 'warn');
    return null;
  }
}

async function saveTest(appId: string, report: TestReport) {
  const current = getState().apps.find((a) => a.id === appId);
  if (current) await save.app({ ...current, lastTest: report });
}

/** Ideas arrive as quick sketches; Muse Wonder writes the full plan for the one being made. */
async function ensurePlan(app: AppRecord): Promise<AppRecord> {
  const s = getState().suggestions.find((x) => x.id === app.suggestionId);
  if (!s || s.specReady !== false) return app;
  log('Planning the app in detail');
  const [spec] = await Promise.all([planApp(s), ensureWorkspace()]);
  const planned = { ...app, spec, updatedAt: Date.now() };
  await save.app(planned);
  await save.suggestion({ ...s, spec, specReady: true, updatedAt: Date.now() });
  log('Plan ready', 'ok');
  return planned;
}

async function run(appId: string, work: (app: AppRecord) => Promise<void>) {
  const app = getState().apps.find((a) => a.id === appId);
  if (!app) return;
  try {
    patchJob({ busy: true, error: undefined });
    await work(app);
    phase('ready', 'Ready for review');
    patchJob({ busy: false });
  } catch (e) {
    log(errorText(e), 'error');
    patchJob({ phase: 'failed', error: friendlyError(e), busy: false });
  }
}

// ── public actions ──────────────────────────────────────────────────────────

export function canBuild(): { ok: boolean; reason?: string } {
  return modelReady('builder');
}

export async function startBuild(s: Suggestion) {
  const ready = canBuild();
  if (!ready.ok) {
    toast(ready.reason!, { tone: 'error' });
    return;
  }
  if (job()?.busy) {
    toast('The Builder is already working on another app.', { tone: 'error' });
    return;
  }
  const { apps, patterns } = getState();
  const id = uniqueSlug(s.name, new Set(apps.map((a) => a.id)));
  const linked = patterns.filter((p) => s.patternIds.includes(p.id));
  const now = Date.now();
  const app: AppRecord = {
    id,
    suggestionId: s.id,
    name: s.name,
    tagline: s.tagline,
    rationale: s.rationale,
    evidence: linked.map((p) => p.evidence).join(' · '),
    icon: s.icon,
    accent: s.accent,
    network: s.network,
    feeds: s.feeds ?? [],
    spec: s.spec,
    builderNotes: s.builderNotes,
    status: 'draft',
    version: 0,
    builderLabel: 'Muse',
    createdAt: now,
    updatedAt: now,
    opens: 0,
  };
  await save.app(app);
  await save.suggestion({ ...s, status: 'building', appId: id });
  setState({
    view: 'workshop',
    workshopAppId: id,
    job: { appId: id, phase: 'preparing', log: [], streamedChars: 0, previewNonce: 0, busy: true },
  });

  await run(id, async (sketched) => {
    const current = await ensurePlan(sketched);
    log("Building with Muse. The Builder sees only this app's description, never your activity.");
    await ensureWorkspace();
    await api.appCreate(id, manifest(current));
    phase('writing', 'Writing the app from the spec');
    const text = await generate([
      { role: 'system', content: systemPrompt(current) },
      { role: 'user', content: `Build this app.\n\n${specText(current)}` },
    ]);
    await applyOutput(id, text, true);
    await buildUntilGreen(current, 'First build', { test: true });
  });
}

export async function requestChange(appId: string, request: string) {
  const ready = canBuild();
  if (!ready.ok) {
    toast(ready.reason!, { tone: 'error' });
    return;
  }
  const app = getState().apps.find((a) => a.id === appId);
  if (!app || !request.trim()) return;
  await recordFeedback('change', app.name, request.trim(), { appId, suggestionId: app.suggestionId });
  setState({
    workshopAppId: appId,
    job: { appId, phase: 'revising', log: [{ ts: Date.now(), tone: 'info', text: `Change requested: "${request.trim()}"` }], streamedChars: 0, previewNonce: job()?.previewNonce ?? 0, busy: true },
  });
  await run(appId, async (current) => {
    await ensureWorkspace();
    await api.appCreate(appId, manifest(current));
    phase('revising', 'Revising');
    const files = await api.appReadFiles(appId);
    const text = await generate([
      { role: 'system', content: systemPrompt(current) },
      {
        role: 'user',
        content: `The user reviewed the app and asked for a change:\n"${request.trim()}"\n\nApply it and keep everything else working. Return only changed or new files, each in full. To delete a file, output a line <<<DELETE src/path.tsx>>>.\n\nSpec:\n${specText(current)}\n\nCurrent files:\n${filesText(files)}`,
      },
    ]);
    await applyOutput(appId, text, false);
    await buildUntilGreen(current, request.trim(), { test: true });
  });
}

export async function retryBuild(appId: string) {
  const app = getState().apps.find((a) => a.id === appId);
  if (!app) return;
  setState({ job: { appId, phase: 'building', log: [], streamedChars: 0, previewNonce: 0, busy: true } });
  await run(appId, async (sketched) => {
    const current = await ensurePlan(sketched);
    await ensureWorkspace();
    await api.appCreate(appId, manifest(current));
    const files = await api.appReadFiles(appId);
    const hasCode = files.some((f) => f.path === 'src/App.tsx' && !f.content.includes('Being tailored'));
    if (!hasCode) {
      phase('writing', 'Writing the app from the spec');
      const text = await generate([
        { role: 'system', content: systemPrompt(current) },
        { role: 'user', content: `Build this app.\n\n${specText(current)}` },
      ]);
      await applyOutput(appId, text, true);
    }
    await buildUntilGreen(current, current.version ? 'Rebuild' : 'First build', { test: true });
  });
}

export async function restoreVersion(appId: string, version: number) {
  const v = getState().versions.find((x) => x.appId === appId && x.version === version);
  if (!v) return;
  setState({ workshopAppId: appId, job: { appId, phase: 'building', log: [{ ts: Date.now(), tone: 'info', text: `Restoring v${version}` }], streamedChars: 0, previewNonce: 0, busy: true } });
  await run(appId, async (current) => {
    await ensureWorkspace();
    await api.appCreate(appId, manifest(current));
    await api.appWriteFiles(appId, v.files, { replace: true });
    await buildUntilGreen(current, `Restored v${version}`);
  });
}

export async function approve(appId: string) {
  const { apps, suggestions } = getState();
  const app = apps.find((a) => a.id === appId);
  if (!app) return;
  // A real Windows app now: its own icon, and a Start menu entry it can be pinned from.
  await makeAppIcon(app).catch(() => {});
  let shortcut = app.shortcut;
  if (getState().settings.startMenu && !shortcut) shortcut = await api.appInstall(app.id, app.name, app.tagline).catch(() => undefined);
  await save.app({ ...app, status: 'installed', installedAt: app.installedAt ?? Date.now(), shortcut });
  const s = suggestions.find((x) => x.id === app.suggestionId);
  if (s) await save.suggestion({ ...s, status: 'built' });
  await recordFeedback('approve', app.name, `Approved v${app.version} into the deck`, { appId, suggestionId: app.suggestionId });
  setState({ job: null, workshopAppId: null, view: 'deck', highlightAppId: appId });
}

export async function discard(appId: string) {
  const { apps, suggestions } = getState();
  const app = apps.find((a) => a.id === appId);
  if (!app) return;
  await api.appDelete(appId);
  await save.removeApp(appId);
  const s = suggestions.find((x) => x.id === app.suggestionId);
  if (s) await save.suggestion({ ...s, status: 'new', appId: undefined });
  await recordFeedback('discard', app.name, 'Discarded the draft before approving', { appId, suggestionId: app.suggestionId });
  const nextDraft = getState().apps.find((a) => a.status === 'draft');
  setState({ job: null, workshopAppId: nextDraft?.id ?? null });
}

export async function openApp(app: AppRecord) {
  await makeAppIcon(app).catch(() => {});
  await api.appOpenWindow(app.id);
  await save.app({ ...app, opens: app.opens + 1, lastOpenedAt: Date.now() });
}

export async function reviseApp(appId: string) {
  setState({ view: 'workshop', workshopAppId: appId, job: getState().job?.appId === appId ? getState().job : null });
}
