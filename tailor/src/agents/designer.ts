// Designer agent: turns patterns + explicit feedback into app proposals with a buildable spec.
// It sees patterns, the evidence-based profile, installed apps and feedback. Never raw events.

import { ACCENTS, ICON_NAMES } from '../lib/icons';
import { chatJSON, friendlyError, modelReady } from '../lib/llm';
import { getState, save, setState, toast } from '../lib/store';
import type { AccentName, AppSpec, FeedName, Suggestion } from '../lib/types';

const FEEDS: FeedName[] = ['open-tabs', 'open-windows', 'ai-tools'];
import { uid } from '../lib/util';

const SYSTEM = `You are the Designer agent inside Tailor, a desktop app that builds small personal software for one person based on how they actually work.

You propose apps that remove specific, observed friction. Each app is built afterwards by a separate Builder agent as a single-page React app that runs locally in its own window, stores data in the browser (localStorage), and has no backend.

Rules:
- Ground every suggestion in the observed patterns: list their ids in patternIds and, in "rationale", say what you noticed using the evidence numbers exactly as given (e.g. "You copied from arxiv.org into Obsidian 34 times across 6 of 7 sessions"). Never invent observations or numbers.
- If the user asked for something, fit the suggestions to their request. When no pattern relates, leave patternIds empty and make the rationale say it comes from their request.
- Respect feedback. Never re-suggest a denied idea or a close variant; lean into the direction of their edits and change requests. Don't duplicate installed apps.
- Look for clutter as well as repetition: lots of tabs open on one site (e.g. many AI chats), many windows of one app (e.g. several terminals running coding agents), or many tools set up in an AI app (MCP servers, connectors, plugins, skills). These call for an organizer: one calm place that lists everything, groups it, and lets the person label and find things. Example: many claude.ai tabs plus many MCP servers in Claude Code suggests "Agent Hub: see all your AI chats and tools in one place".
- Apps can't see the person's computer by default. They can be given read-only live data, and the person sees exactly what an app can see before it is made. Request a feed in "feeds" only when the app is useless without it: "open-tabs" (browser tabs open right now: titles and addresses), "open-windows" (windows open on this computer), "ai-tools" (names of the MCP servers, connectors, plugins and skills set up in AI tools like Claude Code). Otherwise data gets in by paste, dropping a file, or typing; design for that.
- Network access is off by default. Only request it when essential, and only for specific public API hosts (e.g. "export.arxiv.org"). Never for analytics.
- The person may be any age and not technical. Write names, taglines, rationale and features in plain everyday words and short sentences. No jargon (no JSON, API, sync, metadata, dashboard, workflow). Speak to them as "you". The rationale is at most two short sentences.
- Small and excellent: 3–5 features buildable in one sitting. Be concrete; no buzzwords; no "AI-powered".
- Names: 1–3 plain words that say what it does (e.g. "Paper Ledger", "Citation Bridge"). Tagline under 70 characters.
- icon: pick from the allowed list. accent: pick one colour; vary across suggestions.
- spec is what the Builder sees. Make it complete enough to build without guessing: screens, data model (fields and types), key interactions, persistence, and what is out of scope.`;

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['suggestions'],
  properties: {
    suggestions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'tagline', 'icon', 'accent', 'patternIds', 'rationale', 'features', 'dataIn', 'network', 'feeds', 'spec'],
        properties: {
          name: { type: 'string' },
          tagline: { type: 'string' },
          icon: { type: 'string', enum: ICON_NAMES },
          accent: { type: 'string', enum: ACCENTS },
          patternIds: { type: 'array', items: { type: 'string' } },
          rationale: { type: 'string' },
          features: { type: 'array', items: { type: 'string' } },
          dataIn: { type: 'string' },
          network: { type: 'array', items: { type: 'string' } },
          feeds: { type: 'array', items: { type: 'string', enum: FEEDS } },
          spec: {
            type: 'object',
            additionalProperties: false,
            required: ['summary', 'screens', 'dataModel', 'interactions', 'persistence', 'outOfScope'],
            properties: {
              summary: { type: 'string' },
              screens: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['name', 'purpose'],
                  properties: { name: { type: 'string' }, purpose: { type: 'string' } },
                },
              },
              dataModel: { type: 'string' },
              interactions: { type: 'array', items: { type: 'string' } },
              persistence: { type: 'string' },
              outOfScope: { type: 'array', items: { type: 'string' } },
            },
          },
        },
      },
    },
  },
};

interface DesignerOutput {
  suggestions: {
    name: string;
    tagline: string;
    icon: string;
    accent: AccentName;
    patternIds: string[];
    rationale: string;
    features: string[];
    dataIn: string;
    network: string[];
    feeds: FeedName[];
    spec: AppSpec;
  }[];
}

function context(focusPatternIds: string[]): string {
  const { patterns, profile, apps, suggestions, feedback } = getState();
  const active = patterns.filter((p) => p.status === 'active').sort((a, b) => b.confidence - a.confidence);
  const lines: string[] = [];

  lines.push('Profile (evidence-based):');
  lines.push(profile ? `${profile.summary}\nFocus: ${profile.focusAreas.join('; ')}\nTools: ${profile.tools.join(', ')}` : '(not built yet)');
  lines.push('');
  lines.push('Observed patterns:');
  for (const p of active.slice(0, 12)) {
    const focus = focusPatternIds.includes(p.id) ? ' (NEW, prioritise)' : '';
    lines.push(`- [${p.id}]${focus} ${p.title}: ${p.description} Friction: ${p.friction} Evidence: ${p.evidence}. Confidence ${p.confidence.toFixed(2)}.`);
  }
  if (!active.length) lines.push('- (no patterns observed yet)');
  lines.push('');
  lines.push('Installed or drafted apps (do not duplicate):');
  lines.push(apps.length ? apps.map((a) => `- ${a.name}: ${a.tagline}`).join('\n') : '- none');
  lines.push('');
  lines.push('Open suggestions already shown (do not repeat):');
  const open = suggestions.filter((s) => s.status === 'new');
  lines.push(open.length ? open.map((s) => `- ${s.name}: ${s.tagline}`).join('\n') : '- none');
  lines.push('');
  lines.push('Feedback from the user, newest first:');
  const fb = feedback.slice(0, 25);
  lines.push(fb.length ? fb.map((f) => `- ${f.kind.toUpperCase()} "${f.subject}": ${f.detail}`).join('\n') : '- none yet');
  return lines.join('\n');
}

export async function suggest(opts: { ask?: string; focusPatternIds?: string[]; count?: number; origin: 'auto' | 'ask' }) {
  const st = getState();
  if (st.designer.running) return;
  const ready = modelReady('designer');
  if (!ready.ok) {
    if (opts.origin === 'ask') toast(ready.reason!, { tone: 'error' });
    return;
  }
  setState({ designer: { running: true } });
  try {
    const count = opts.count ?? 3;
    const ask = opts.ask?.trim();
    const user = [
      context(opts.focusPatternIds ?? []),
      '',
      ask ? `The user asked: "${ask}"` : 'The user did not ask for anything specific; propose what would help most.',
      `Propose ${count} app${count === 1 ? '' : 's'}.`,
    ].join('\n');

    const out = await chatJSON<DesignerOutput>('designer', SYSTEM, user, { name: 'app_suggestions', schema: SCHEMA });
    const { patterns } = getState();
    const known = new Map(patterns.map((p) => [p.id, p]));
    const now = Date.now();
    const created: Suggestion[] = [];

    for (const [i, s] of (out.suggestions ?? []).slice(0, count).entries()) {
      const patternIds = (s.patternIds ?? []).filter((id) => known.has(id));
      const linked = patternIds.map((id) => known.get(id)!);
      const suggestion: Suggestion = {
        id: uid('s_'),
        createdAt: now - i,
        updatedAt: now,
        name: s.name.trim(),
        tagline: s.tagline.trim(),
        rationale: s.rationale.trim(),
        patternIds,
        features: (s.features ?? []).map((f) => f.trim()).filter(Boolean).slice(0, 6),
        dataIn: s.dataIn?.trim() ?? '',
        network: (s.network ?? []).map((d) => d.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '')).filter(Boolean),
        feeds: (s.feeds ?? []).filter((f) => FEEDS.includes(f)),
        icon: ICON_NAMES.includes(s.icon) ? s.icon : 'layers',
        accent: ACCENTS.includes(s.accent) ? s.accent : 'moss',
        spec: s.spec,
        builderNotes: '',
        status: 'new',
        origin: opts.origin,
        ask,
        edited: false,
        demo: linked.length > 0 && linked.every((p) => p.demo),
      };
      await save.suggestion(suggestion);
      created.push(suggestion);
    }

    setState((cur) => ({
      designer: { running: false },
      selectedSuggestionId: created[0]?.id ?? cur.selectedSuggestionId,
      unseenSuggestions: cur.view === 'discover' ? 0 : cur.unseenSuggestions + created.length,
    }));
    if (opts.origin === 'auto' && created.length && getState().view !== 'discover') {
      toast(`New idea for you: ${created[0].name}`, {
        action: { label: 'View', run: () => setState({ view: 'discover', selectedSuggestionId: created[0].id, unseenSuggestions: 0 }) },
      });
    }
    return created;
  } catch (e) {
    const msg = friendlyError(e);
    setState({ designer: { running: false, error: msg } });
    toast(msg, { tone: 'error' });
  }
}
