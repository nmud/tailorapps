import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Check, ChevronRight, Eye, Lightbulb, Lock, Pencil, Sprout, Undo2, Wifi, WifiOff, X } from 'lucide-react';
import { suggest } from '../agents/designer';
import { analyze, dismissPattern, learningProgress, SESSIONS_NEEDED } from '../agents/observer';
import { startBuild } from '../agents/builder';
import { AppGlyph } from '../lib/icons';
import { friendlyError } from '../lib/llm';
import { loadDemoSession } from '../lib/demo';
import { recordFeedback, save, setState, toast, useStore } from '../lib/store';
import type { FeedName, Pattern, Suggestion } from '../lib/types';
import { formatDuration } from '../lib/util';
import { DemoTag, Notice, SessionDots } from '../components/ui';

const EXAMPLES = ['Keep track of what I read', 'Plan my week', 'Less copying and pasting'];

/** What each kind of live data means, in words anyone can check. */
export const FEED_WORDS: Record<FeedName, string> = {
  'open-tabs': 'the tabs open in your browser (titles and addresses)',
  'open-windows': 'the windows open on this computer',
  'ai-tools': 'the names of the tools set up in your AI apps (like Claude Code)',
};

const DENY_REASONS = [
  { id: 'not-useful', label: 'Not useful to me' },
  { id: 'have-tool', label: 'I already have something for this' },
  { id: 'wrong-pattern', label: "That's not how I work" },
  { id: 'too-much', label: 'Too complicated' },
];

function EditForm({ s, onDone }: { s: Suggestion; onDone: () => void }) {
  const [name, setName] = useState(s.name);
  const [summary, setSummary] = useState(s.spec.summary);
  const [features, setFeatures] = useState(s.features.join('\n'));
  const [notes, setNotes] = useState(s.builderNotes);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const next = features.split('\n').map((f) => f.trim()).filter(Boolean);
    const added = next.filter((f) => !s.features.includes(f));
    const removed = s.features.filter((f) => !next.includes(f));
    const changes = [
      name !== s.name && `renamed to "${name}"`,
      added.length && `added: ${added.join('; ')}`,
      removed.length && `removed: ${removed.join('; ')}`,
      summary !== s.spec.summary && 'rewrote what it should do',
      notes.trim() && notes !== s.builderNotes && `notes: ${notes.trim()}`,
    ].filter(Boolean);
    await save.suggestion({
      ...s,
      name: name.trim() || s.name,
      features: next,
      builderNotes: notes.trim(),
      spec: { ...s.spec, summary: summary.trim() },
      edited: true,
    });
    if (changes.length) await recordFeedback('edit', s.name, changes.join(', '), { suggestionId: s.id });
    onDone();
  }

  return (
    <form className="panel detail" onSubmit={submit}>
      <h2 className="section-title">Change this idea</h2>
      <label className="field">
        <span className="label">Name</span>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="field">
        <span className="label">What should it do?</span>
        <textarea className="textarea" rows={3} value={summary} onChange={(e) => setSummary(e.target.value)} />
      </label>
      <label className="field">
        <span className="label">What it includes</span>
        <textarea className="textarea" rows={5} value={features} onChange={(e) => setFeatures(e.target.value)} />
        <span className="hint">One per line.</span>
      </label>
      <label className="field">
        <span className="label">Anything else?</span>
        <textarea className="textarea" rows={2} placeholder="For example: big buttons, a dark background" value={notes} onChange={(e) => setNotes(e.target.value)} />
      </label>
      <div className="actions">
        <button type="submit" className="btn btn--primary">
          <Check /> Save
        </button>
        <button type="button" className="btn btn--ghost" onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function Detail({ s, patterns }: { s: Suggestion; patterns: Pattern[] }) {
  const job = useStore((st) => st.job);
  const [mode, setMode] = useState<'view' | 'edit' | 'deny'>('view');
  const [reason, setReason] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const linked = patterns.filter((p) => s.patternIds.includes(p.id));

  if (mode === 'edit') return <EditForm s={s} onDone={() => setMode('view')} />;

  async function deny() {
    const label = DENY_REASONS.find((r) => r.id === reason)?.label ?? 'No reason given';
    const detail = note.trim() ? `${label}. ${note.trim()}` : label;
    await save.suggestion({ ...s, status: 'denied', denyReason: detail });
    await recordFeedback('deny', s.name, detail, { suggestionId: s.id });
    if (reason === 'wrong-pattern') {
      for (const p of linked) {
        await dismissPattern(p);
        await recordFeedback('pattern-wrong', p.title, 'Said this is not how they work', { patternId: p.id });
      }
    }
    setState({ selectedSuggestionId: null });
    toast('Got it. Tailor will remember that.', {
      action: { label: 'Undo', run: () => save.suggestion({ ...s, status: 'new', denyReason: undefined }) },
    });
  }

  return (
    <article className="panel detail" aria-labelledby="idea-name">
      <header className="detail-head">
        <AppGlyph icon={s.icon} accent={s.accent} size="lg" />
        <div>
          <h2 id="idea-name">{s.name}</h2>
          <p>{s.tagline}</p>
        </div>
      </header>

      <div className="why">
        <strong>Why Tailor thinks this will help</strong>
        <p>{s.rationale}</p>
        {linked.map((p) => (
          <div className="why-line" key={p.id}>
            <SessionDots sessions={p.sessions} total={p.totalSessions} />
            <span>{p.evidence}</span>
          </div>
        ))}
        <DemoTag show={s.demo} />
      </div>

      <div className="section">
        <h3 className="section-title">What it does</h3>
        <ul className="features">
          {s.features.map((f) => (
            <li key={f}>
              <Check strokeWidth={2.5} /> {f}
            </li>
          ))}
        </ul>
      </div>

      <div className="facts">
        {(s.feeds ?? []).map((f) => (
          <div key={f}>
            <Eye /> Can see {FEED_WORDS[f]}
          </div>
        ))}
        <div>
          {s.network.length ? <Wifi /> : <WifiOff />}
          {s.network.length ? `Uses the internet to reach ${s.network.join(', ')}` : 'Works without the internet'}
        </div>
        <div>
          <Lock /> Only you can see what you put in it
        </div>
      </div>

      <details className="more">
        <summary>
          <ChevronRight /> More details
        </summary>
        <div className="spec-body">
          <p>{s.spec.summary}</p>
          {s.spec.screens.length > 0 && (
            <ul>
              {s.spec.screens.map((x) => (
                <li key={x.name}>
                  <strong>{x.name}</strong>: {x.purpose}
                </li>
              ))}
            </ul>
          )}
          {s.builderNotes && <p>Your notes: {s.builderNotes}</p>}
          {s.specReady === false && <p className="muted">Tailor plans the rest in detail when you make it.</p>}
        </div>
      </details>

      {mode === 'deny' ? (
        <div className="deny-box">
          <strong>What's wrong with it?</strong>
          <div className="chips">
            {DENY_REASONS.map((r) => (
              <button key={r.id} type="button" className="chip" aria-pressed={reason === r.id} onClick={() => setReason(r.id)}>
                {r.label}
              </button>
            ))}
          </div>
          <input className="input" placeholder="Tell us more (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
          <div className="actions">
            <button className="btn btn--danger" onClick={deny}>
              <X /> Not for me
            </button>
            <button className="btn btn--ghost" onClick={() => setMode('view')}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="actions">
          <button className="btn btn--primary btn--lg" disabled={!!job?.busy} onClick={() => startBuild(s)}>
            Make this app
          </button>
          <button className="btn btn--lg" onClick={() => setMode('edit')}>
            <Pencil /> Change it
          </button>
          <button className="btn btn--ghost btn--lg" onClick={() => setMode('deny')}>
            Not for me
          </button>
        </div>
      )}
      {job?.busy && <p className="hint">Tailor is making another app. You can make this one when it's done.</p>}
    </article>
  );
}

export default function Discover() {
  const suggestions = useStore((s) => s.suggestions);
  const patterns = useStore((s) => s.patterns);
  const selectedId = useStore((s) => s.selectedSuggestionId);
  const designer = useStore((s) => s.designer);
  const observer = useStore((s) => s.observer);
  const learning = useStore((s) => s.learning);
  const [ask, setAsk] = useState('');
  const [loadingDemo, setLoadingDemo] = useState(false);

  const active = useMemo(
    () => patterns.filter((p) => p.status === 'active').sort((a, b) => b.confidence * b.sessions - a.confidence * a.sessions),
    [patterns]
  );
  const open = useMemo(() => suggestions.filter((s) => s.status === 'new').sort((a, b) => b.createdAt - a.createdAt), [suggestions]);
  const past = useMemo(() => suggestions.filter((s) => s.status !== 'new').sort((a, b) => b.updatedAt - a.updatedAt), [suggestions]);
  const selected = open.find((s) => s.id === selectedId) ?? open[0];

  // People who just turned learning on: say plainly that ideas need a little time, and show progress.
  const newcomer = learning.enabled && !active.length && !open.length;
  const [progress, setProgress] = useState<{ sessions: number; activeMs: number } | null>(null);
  useEffect(() => {
    if (newcomer) learningProgress().then(setProgress, () => setProgress(null));
  }, [newcomer, observer.lastRunAt]);

  async function onAsk(e?: FormEvent, text = ask) {
    e?.preventDefault();
    await suggest({ ask: text || undefined, origin: 'ask', count: 3 });
    setAsk('');
  }

  async function sampleWeek() {
    setLoadingDemo(true);
    try {
      await loadDemoSession();
      await analyze();
    } catch (e) {
      toast(friendlyError(e), { tone: 'error' });
    } finally {
      setLoadingDemo(false);
    }
  }

  return (
    <div className="page">
      <header>
        <h1 className="page-title">Ideas for you</h1>
        <p className="page-sub">Small apps based on how you work.</p>
      </header>

      <div className="section">
        <form className="ask" onSubmit={onAsk}>
          <label className="sr-only" htmlFor="ask">Describe an app you'd like</label>
          <input id="ask" className="input" placeholder="Describe an app you'd like…" value={ask} onChange={(e) => setAsk(e.target.value)} disabled={designer.running} />
          <button className={`btn btn--primary btn--lg${designer.running ? ' is-loading' : ''}`}>Get ideas</button>
        </form>
        <div className="chips">
          {EXAMPLES.map((x) => (
            <button key={x} className="chip" disabled={designer.running} onClick={() => onAsk(undefined, x)}>
              {x}
            </button>
          ))}
        </div>
      </div>

      {!learning.enabled && !active.length && (
        <Notice
          icon={<Lightbulb />}
          actions={
            <>
              <button className="btn btn--sm btn--primary" onClick={() => save.learning({ ...learning, enabled: true, extension: true, desktop: true })}>
                Turn on learning
              </button>
              <button className={`btn btn--sm${loadingDemo ? ' is-loading' : ''}`} onClick={sampleWeek}>
                Try a sample week
              </button>
            </>
          }
        >
          Turn on learning so Tailor can suggest ideas on its own.
        </Notice>
      )}
      {newcomer && !observer.running && !designer.running && (
        <Notice
          icon={<Sprout />}
          actions={
            <button className={`btn btn--sm${loadingDemo ? ' is-loading' : ''}`} onClick={sampleWeek}>
              Try a sample week
            </button>
          }
        >
          <strong>Tailor is still getting to know you.</strong> Ideas usually start after a day or two of using your computer as
          normal, and get more personal over the first week. Until then, describe an app above and Tailor will make it.
          {progress && (
            <span className="notice-progress">
              {progress.sessions < SESSIONS_NEEDED
                ? `So far: ${progress.sessions} of ${SESSIONS_NEEDED} work sessions${progress.activeMs ? ` (${formatDuration(progress.activeMs)})` : ''}. Ideas need at least two separate stretches of work, like a morning and an afternoon.`
                : `So far: ${progress.sessions} work sessions, ${formatDuration(progress.activeMs)}. Tailor looks for things you repeat every half hour or so.`}
            </span>
          )}
        </Notice>
      )}
      {(observer.running || designer.running) && (
        <Notice icon={<span className="spinner" />}>{designer.running ? 'Coming up with ideas…' : 'Looking at how you work…'}</Notice>
      )}

      {active.length > 0 && (
        <section className="section" aria-labelledby="noticed">
          <h2 className="section-title" id="noticed">What Tailor noticed</h2>
          <div className="noticed stagger">
            {active.slice(0, 3).map((p) => (
              <div className="noticed-row shine" key={p.id}>
                <div>
                  <strong>
                    {p.title} <DemoTag show={p.demo} />
                  </strong>
                  <span>{p.evidence}</span>
                </div>
                <SessionDots sessions={p.sessions} total={p.totalSessions} />
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="section" aria-labelledby="ideas">
        <div className="section-head">
          <h2 className="section-title" id="ideas">Ideas</h2>
          {active.length > 0 && !designer.running && (
            <button className="btn btn--sm" onClick={() => suggest({ origin: 'ask', count: 3 })}>
              More ideas
            </button>
          )}
        </div>
        {open.length || designer.running ? (
          <div className="ideas-grid">
            <div className="idea-list stagger">
              {open.map((s) => (
                <button key={s.id} className="idea-card shine" aria-current={s.id === selected?.id} onClick={() => setState({ selectedSuggestionId: s.id })}>
                  <AppGlyph icon={s.icon} accent={s.accent} />
                  <div>
                    <strong>{s.name}</strong>
                    <span>{s.tagline}</span>
                  </div>
                </button>
              ))}
              {designer.running &&
                Array.from({ length: Math.max(1, 3 - (open.length % 3)) }, (_, i) => (
                  <div key={`thinking-${i}`} className="idea-card idea-card--thinking" aria-hidden="true">
                    <span className="glyph glyph--md" data-accent="moss" />
                    <div>
                      <i />
                      <i />
                    </div>
                  </div>
                ))}
            </div>
            {selected ? (
              <Detail s={selected} patterns={patterns} key={selected.id} />
            ) : (
              <div className="panel detail idea-card--thinking" aria-live="polite">
                <p className="muted">Thinking of ideas for you…</p>
              </div>
            )}
          </div>
        ) : (
          <div className="empty">
            <h3>No ideas yet</h3>
            <p>As Tailor learns how you work, ideas will show up here. You can also describe an app above.</p>
          </div>
        )}
      </section>

      {past.length > 0 && (
        <section className="section" aria-labelledby="past">
          <h2 className="section-title" id="past">Earlier ideas</h2>
          <div className="panel list" style={{ paddingBlock: 0 }}>
            {past.slice(0, 10).map((s) => (
              <div className="list-row" key={s.id}>
                <AppGlyph icon={s.icon} accent={s.accent} size="sm" />
                <div className="grow">
                  <strong>{s.name}</strong>{' '}
                  <span className="muted">{s.status === 'denied' ? '· Not for me' : s.status === 'built' ? '· Made' : '· Being built'}</span>
                </div>
                {s.status === 'denied' && (
                  <button className="btn btn--ghost btn--sm" onClick={() => save.suggestion({ ...s, status: 'new', denyReason: undefined })}>
                    <Undo2 /> Bring back
                  </button>
                )}
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
