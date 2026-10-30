import { useEffect, useMemo, useState } from 'react';
import { ChevronRight, Globe, Lock, Monitor, RotateCcw, X } from 'lucide-react';
import { analyze, dismissPattern } from '../agents/observer';
import { contextOf } from '../agents/digest';
import { api } from '../lib/api';
import { clearDemoSession, loadDemoSession } from '../lib/demo';
import { friendlyError } from '../lib/llm';
import { forgetFeedback, recordFeedback, save, toast, useStore } from '../lib/store';
import type { ActivityEvent } from '../lib/types';
import { clockTime, shortDate, timeAgo } from '../lib/util';
import { BrowserSetup, useBrowserConnected } from '../components/BrowserSetup';
import { DemoTag, Dialog, Notice, SessionDots, Switch } from '../components/ui';

const KIND_WORDS: Record<string, string> = {
  focus: 'Used',
  copy: 'Copied',
  paste: 'Pasted',
  search: 'Searched',
  download: 'Downloaded',
  navigate: 'Visited',
  tabs: 'Had open',
  windows: 'Had open',
  setup: 'Set up',
};

export default function Memory() {
  const learning = useStore((s) => s.learning);
  const patterns = useStore((s) => s.patterns);
  const profile = useStore((s) => s.profile);
  const observer = useStore((s) => s.observer);
  const feedback = useStore((s) => s.feedback);
  const tick = useStore((s) => s.activityTick);
  const connected = useBrowserConnected();
  const [recent, setRecent] = useState<ActivityEvent[]>([]);
  const [hasSample, setHasSample] = useState(false);
  const [reload, setReload] = useState(0);
  const [showSetup, setShowSetup] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busySample, setBusySample] = useState(false);

  useEffect(() => {
    let alive = true;
    const t = setTimeout(async () => {
      const [r, lastTwoWeeks] = await Promise.all([
        api.eventsQuery(0, { limit: 100, newestFirst: true }),
        api.eventsQuery(Date.now() - 14 * 86_400_000, { limit: 5000 }),
      ]);
      const sample = lastTwoWeeks.some((e) => e.source === 'demo');
      if (alive) {
        setRecent(r);
        setHasSample(sample);
      }
    }, 250);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [tick, reload]);

  const active = useMemo(() => patterns.filter((p) => p.status === 'active').sort((a, b) => b.confidence - a.confidence), [patterns]);
  const dismissed = useMemo(() => patterns.filter((p) => p.status === 'dismissed'), [patterns]);
  const set = (patch: Partial<typeof learning>) => save.learning({ ...learning, ...patch });

  async function sample(load: boolean) {
    setBusySample(true);
    try {
      if (load) {
        await loadDemoSession();
        await analyze();
      } else {
        await clearDemoSession();
      }
      setReload((x) => x + 1);
    } catch (e) {
      toast(friendlyError(e), { tone: 'error' });
    } finally {
      setBusySample(false);
    }
  }

  return (
    <div className="page">
      <div className="page-head">
        <header>
          <h1 className="page-title">Learning</h1>
          <p className="page-sub">What Tailor notices stays on this computer.</p>
        </header>
        <button className={`btn btn--primary${observer.running ? ' is-loading' : ''}`} onClick={() => analyze()}>
          Look for patterns now
        </button>
      </div>

      {observer.running && <Notice icon={<span className="spinner" />}>{observer.phase ?? 'Looking at how you work'}…</Notice>}
      {!observer.running && observer.error && <Notice tone="error">{observer.error}</Notice>}
      {!observer.running && !observer.error && observer.note && <Notice>{observer.note}</Notice>}

      <section className="section" aria-labelledby="how">
        <div className="section-head">
          <h2 className="section-title" id="how">How Tailor learns</h2>
          <div className="row">
            <span className="muted">Learning</span>
            <Switch label="Learning" checked={learning.enabled} onChange={(enabled) => set({ enabled })} />
          </div>
        </div>
        <div className="sources stagger">
          <div className="card source">
            <div className="source-head">
              <Globe />
              <h3>Websites you visit</h3>
              <Switch label="Websites you visit" checked={learning.extension} disabled={!learning.enabled} onChange={(extension) => set({ extension })} />
            </div>
            <p>Which sites you use, and for how long.</p>
            {learning.extension && (
              <div className="status-line">
                <span className={`status-dot${connected ? ' status-dot--on' : ''}`} />
                {connected ? 'Browser connected' : 'Browser not connected yet'}
                {!connected && (
                  <button className="link-btn" onClick={() => setShowSetup((v) => !v)}>
                    {showSetup ? 'Hide steps' : 'Set it up'}
                  </button>
                )}
              </div>
            )}
          </div>
          <div className="card source">
            <div className="source-head">
              <Monitor />
              <h3>Apps on this computer</h3>
              <Switch label="Apps on this computer" checked={learning.desktop} disabled={!learning.enabled} onChange={(desktop) => set({ desktop })} />
            </div>
            <p>Which apps you use, and for how long.</p>
          </div>
        </div>
        {showSetup && !connected && <BrowserSetup />}
        <p className="promise">
          <Lock />
          Tailor never reads what you type, copy or write in messages. To come up with ideas, it sends a short summary (like "used a spreadsheet for 40 minutes") to Tailor's AI.
        </p>
      </section>

      <section className="section" aria-labelledby="noticed">
        <h2 className="section-title" id="noticed">What Tailor noticed</h2>
        {active.length ? (
          <div className="card list">
            {active.map((p) => (
              <div className="pattern-row list-row" key={p.id}>
                <div>
                  <strong>
                    {p.title} <DemoTag show={p.demo} />
                  </strong>
                  <span>{p.evidence}</span>
                  <SessionDots sessions={p.sessions} total={p.totalSessions} />
                </div>
                <button
                  className="btn btn--ghost btn--sm"
                  onClick={async () => {
                    await dismissPattern(p);
                    await recordFeedback('pattern-wrong', p.title, 'Said this is not right', { patternId: p.id });
                  }}
                >
                  That's not right
                </button>
              </div>
            ))}
          </div>
        ) : (
          <p className="muted">Nothing yet. Keep working as usual and check back later.</p>
        )}
        {dismissed.length > 0 && (
          <details className="more">
            <summary>
              <ChevronRight /> Things you said weren't right ({dismissed.length})
            </summary>
            <div className="list">
              {dismissed.map((p) => (
                <div className="list-row" key={p.id}>
                  <span className="grow">{p.title}</span>
                  <button className="btn btn--ghost btn--sm" onClick={() => save.pattern({ ...p, status: 'active' })}>
                    <RotateCcw /> Bring back
                  </button>
                </div>
              ))}
            </div>
          </details>
        )}
      </section>

      {profile && (
        <section className="section" aria-labelledby="about">
          <h2 className="section-title" id="about">About how you work</h2>
          <div className="panel" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-sm)' }}>
            <p style={{ fontSize: 'var(--text-lg)' }}>
              {profile.summary} <DemoTag show={profile.demo} />
            </p>
            <div className="row">
              <span className="muted">Updated {timeAgo(profile.updatedAt)}</span>
              <button className="btn btn--ghost btn--sm" onClick={() => save.profile(null)}>
                Forget this
              </button>
            </div>
          </div>
        </section>
      )}

      <section className="section" aria-labelledby="sample">
        <h2 className="section-title" id="sample">Try it with a sample week</h2>
        <div className="panel row" style={{ justifyContent: 'space-between' }}>
          <p>See how Tailor works using a made-up week of someone reading research papers, taking notes and juggling lots of AI chats.</p>
          <div className="row">
            <button className={`btn${busySample ? ' is-loading' : ''}`} onClick={() => sample(true)}>
              {hasSample ? 'Load it again' : 'Load the sample'}
            </button>
            {hasSample && (
              <button className="btn btn--ghost" disabled={busySample} onClick={() => sample(false)}>
                Remove it
              </button>
            )}
          </div>
        </div>
      </section>

      <details className="more">
        <summary>
          <ChevronRight /> Recent activity
        </summary>
        <div className="section">
          {recent.length ? (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>What</th>
                    <th>Where</th>
                    <th>Page or window</th>
                    <th>
                      <span className="sr-only">Delete</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {recent.map((e) => (
                    <tr key={e.id}>
                      <td>
                        {shortDate(e.ts)}, {clockTime(e.ts)}
                      </td>
                      <td>{KIND_WORDS[e.kind] ?? e.kind}</td>
                      <td>
                        {contextOf(e)} {e.source === 'demo' && <DemoTag />}
                      </td>
                      <td className="clip" title={e.title ?? ''}>
                        {e.title ?? <span className="muted">Hidden</span>}
                      </td>
                      <td>
                        <button
                          className="btn btn--ghost btn--sm btn--icon"
                          aria-label="Delete this"
                          onClick={async () => {
                            await api.eventsDelete([e.id]);
                            setRecent((r) => r.filter((x) => x.id !== e.id));
                          }}
                        >
                          <X />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="muted">Nothing recorded yet.</p>
          )}
          <div className="row">
            <button className="btn btn--danger" onClick={() => setConfirmDelete(true)}>
              Delete all activity
            </button>
          </div>
        </div>
      </details>

      {feedback.length > 0 && (
        <details className="more">
          <summary>
            <ChevronRight /> Things you've told Tailor ({feedback.length})
          </summary>
          <div className="list">
            {feedback.slice(0, 40).map((f) => (
              <div className="list-row" key={f.id}>
                <span className="grow">
                  <strong>{f.subject}</strong> <span className="muted">· {f.detail}</span>
                </span>
                <button className="btn btn--ghost btn--sm btn--icon" aria-label="Forget this" title="Forget this" onClick={() => forgetFeedback(f.id)}>
                  <X />
                </button>
              </div>
            ))}
          </div>
        </details>
      )}

      {confirmDelete && (
        <Dialog
          title="Delete all activity?"
          onClose={() => setConfirmDelete(false)}
          actions={
            <>
              <button className="btn btn--ghost" onClick={() => setConfirmDelete(false)}>
                Cancel
              </button>
              <button
                className="btn btn--danger"
                onClick={async () => {
                  setConfirmDelete(false);
                  await api.eventsClear();
                  setReload((x) => x + 1);
                }}
              >
                Delete
              </button>
            </>
          }
        >
          <p>This removes everything Tailor has recorded on this computer. Your apps and ideas stay.</p>
        </Dialog>
      )}
    </div>
  );
}
