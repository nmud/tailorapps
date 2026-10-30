import { useEffect, useRef, useState, type FormEvent } from 'react';
import { AppWindow, Check, ChevronRight, RotateCcw, Send, Trash2, X } from 'lucide-react';
import { approve, discard, openApp, requestChange, restoreVersion, retryBuild } from '../agents/builder';
import { appUrl } from '../lib/api';
import { AppGlyph } from '../lib/icons';
import { go, setState, useStore } from '../lib/store';
import type { AppRecord, BuildJob, JobPhase, TestReport } from '../lib/types';
import { clockTime, timeAgo } from '../lib/util';
import { Dialog } from '../components/ui';

const STEPS: { label: string; phases: JobPhase[] }[] = [
  { label: 'Planning', phases: ['preparing', 'writing', 'revising'] },
  { label: 'Building', phases: ['building', 'fixing'] },
  { label: 'Trying it out', phases: ['checking', 'testing'] },
  { label: 'Ready', phases: ['ready'] },
];

function stepIndex(job: BuildJob | null): number {
  if (!job) return STEPS.length - 1;
  const i = STEPS.findIndex((s) => s.phases.includes(job.phase));
  if (i >= 0) return i;
  // failed: work out how far it got from the log
  const text = job.log.map((l) => l.text).join('\n');
  if (/Loading the app/.test(text)) return 2;
  if (/Building|Rebuilding/.test(text)) return 1;
  return 0;
}

function Progress({ job, built }: { job: BuildJob | null; built: boolean }) {
  const current = job ? stepIndex(job) : built ? STEPS.length - 1 : 0;
  const failed = job?.phase === 'failed';
  const ready = !job?.busy && !failed && built;
  return (
    <ol className="progress" aria-label="Progress" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
      {STEPS.map((s, i) => {
        const state = ready || i < current ? 'done' : i === current ? (failed ? 'failed' : job?.busy ? 'active' : '') : '';
        return (
          <li key={s.label} className={`progress-step ${state}`}>
            <i aria-hidden="true">{state === 'done' ? <Check strokeWidth={3} /> : state === 'failed' ? <X strokeWidth={3} /> : null}</i>
            {s.label}
          </li>
        );
      })}
    </ol>
  );
}

/** What the Tester agent found when it used the app as its person. */
function TestCard({ report }: { report?: TestReport }) {
  if (!report) return null;
  return (
    <div className="test-card">
      <strong>Tried it the way you would</strong>
      <ul className="test-tasks">
        {report.tasks.map((t, i) => (
          <li key={i} className={t.ok ? 'ok' : 'bad'} style={{ ['--i' as string]: i }}>
            {t.ok ? <Check strokeWidth={3} /> : <X strokeWidth={3} />}
            <span>{t.task}</span>
          </li>
        ))}
      </ul>
      <p>{report.summary}</p>
      {report.fixed && <p className="test-fixed">Tailor fixed what got in the way before handing it to you.</p>}
    </div>
  );
}

function Log({ job }: { job: BuildJob | null }) {
  const ref = useRef<HTMLOListElement>(null);
  useEffect(() => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight });
  }, [job?.log.length]);
  if (!job?.log.length) return <p className="hint">Nothing to show yet.</p>;
  return (
    <ol className="log" ref={ref}>
      {job.log.map((l, i) => (
        <li key={i} className={l.tone}>
          {clockTime(l.ts)} {l.text}
        </li>
      ))}
    </ol>
  );
}

function Preview({ app, job }: { app: AppRecord; job: BuildJob | null }) {
  const [nonce, setNonce] = useState(0);
  const built = app.version > 0 || job?.phase === 'checking';
  const key = `${job?.previewNonce ?? 0}-${nonce}-${app.version}`;
  return (
    <section className="preview" aria-label={`Preview of ${app.name}`}>
      <div className="preview-bar">
        <strong>Preview</strong>
        <button className="btn btn--ghost btn--sm btn--icon" aria-label="Reload" title="Reload" disabled={!built} onClick={() => setNonce((n) => n + 1)}>
          <RotateCcw />
        </button>
        <button className="btn btn--ghost btn--sm" disabled={!built} onClick={() => openApp(app)}>
          <AppWindow /> Open in its own window
        </button>
      </div>
      {built ? (
        <iframe
          key={key}
          title={`${app.name} preview`}
          src={`${appUrl(app.id)}?v=${key}`}
          sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-downloads allow-popups"
        />
      ) : (
        <div className="preview-empty">
          <div>
            {job?.busy && <span className="spinner" />}
            <p>{job?.phase === 'failed' ? 'The app didn’t finish.' : 'Your app will appear here.'}</p>
          </div>
        </div>
      )}
    </section>
  );
}

export default function Workshop() {
  const apps = useStore((s) => s.apps);
  const versions = useStore((s) => s.versions);
  const job = useStore((s) => s.job);
  const workshopAppId = useStore((s) => s.workshopAppId);
  const [change, setChange] = useState('');
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  const drafts = apps.filter((a) => a.status === 'draft');
  const app = apps.find((a) => a.id === workshopAppId) ?? drafts[0];

  if (!app) {
    return (
      <div className="page">
        <h1 className="page-title">Building</h1>
        <div className="empty">
          <h3>Nothing being built</h3>
          <p>Pick an idea and Tailor will make it here. You can try it before adding it to your apps.</p>
          <button className="btn btn--primary" onClick={() => go('discover')}>
            See ideas
          </button>
        </div>
      </div>
    );
  }

  const appJob = job?.appId === app.id ? job : null;
  const busy = !!appJob?.busy;
  const failed = appJob?.phase === 'failed';
  const built = app.version > 0;
  const appVersions = versions.filter((v) => v.appId === app.id).sort((a, b) => b.version - a.version);

  const status = busy
    ? appJob?.phase === 'testing'
      ? 'Trying it out the way you would…'
      : appJob?.phase === 'revising'
      ? 'Making your change…'
      : 'Making your app. This usually takes a minute or two.'
    : failed
      ? appJob?.error ?? 'Something went wrong.'
      : built
        ? 'Ready to try. Have a look on the right.'
        : 'Not built yet.';

  async function submitChange(e: FormEvent) {
    e.preventDefault();
    const text = change.trim();
    if (!text) return;
    setChange('');
    await requestChange(app!.id, text);
  }

  return (
    <div className="page page--wide">
      <div className="bench">
        <div className="bench-side">
          {drafts.length > 1 && (
            <div className="chips">
              {drafts.map((d) => (
                <button key={d.id} className="chip" aria-pressed={d.id === app.id} onClick={() => setState({ workshopAppId: d.id })}>
                  {d.name}
                </button>
              ))}
            </div>
          )}
          <div className="bench-title">
            <AppGlyph icon={app.icon} accent={app.accent} size="md" />
            <div>
              <h1>{app.name}</h1>
              <span>{app.tagline}</span>
            </div>
          </div>

          <Progress job={appJob} built={built} />
          <p role="status" className={failed ? 'error-text' : undefined} style={{ fontSize: 'var(--text-lg)' }}>
            {status}
          </p>

          <TestCard report={appJob?.testReport ?? app.lastTest} />

          {(failed || (!appJob && !built)) && (
            <button className="btn btn--primary" disabled={!!job?.busy} onClick={() => retryBuild(app.id)}>
              <RotateCcw /> Try again
            </button>
          )}

          {built && (
            <form className="change-box" onSubmit={submitChange}>
              <label className="label" htmlFor="change">Want something different?</label>
              <textarea
                id="change"
                className="textarea"
                placeholder="For example: make the text bigger"
                value={change}
                disabled={busy}
                onChange={(e) => setChange(e.target.value)}
              />
              <div className="row">
                <button className={`btn${busy && appJob?.phase === 'revising' ? ' is-loading' : ''}`} disabled={busy || !change.trim()}>
                  <Send /> Send
                </button>
              </div>
            </form>
          )}

          <details className="more">
            <summary>
              <ChevronRight /> Show details
            </summary>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-sm)' }}>
              <Log job={appJob} />
              {appVersions.length > 1 && (
                <div className="list">
                  {appVersions.map((v) => (
                    <div className="list-row" key={v.id}>
                      <span className="grow">
                        Version {v.version}: {v.note} <span className="muted">· {timeAgo(v.createdAt)}</span>
                      </span>
                      {v.version !== app.version && (
                        <button className="btn btn--ghost btn--sm" disabled={busy} onClick={() => restoreVersion(app.id, v.version)}>
                          Go back to this
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </details>

          <div className="bench-actions">
            {app.status === 'draft' ? (
              <>
                <button className="btn btn--primary btn--lg" disabled={busy || !built} onClick={() => approve(app.id)}>
                  <Check /> Add to My apps
                </button>
                <button className="btn btn--ghost btn--danger" disabled={busy} onClick={() => setConfirmDiscard(true)}>
                  <Trash2 /> Throw it away
                </button>
              </>
            ) : (
              <>
                <button className="btn btn--primary btn--lg" onClick={() => openApp(app)}>
                  <AppWindow /> Open
                </button>
                <button className="btn btn--ghost" onClick={() => go('deck')}>
                  Back to My apps
                </button>
              </>
            )}
          </div>
        </div>
        <Preview app={app} job={appJob} />
      </div>

      {confirmDiscard && (
        <Dialog
          title={`Throw away ${app.name}?`}
          onClose={() => setConfirmDiscard(false)}
          actions={
            <>
              <button className="btn btn--ghost" onClick={() => setConfirmDiscard(false)}>
                Keep it
              </button>
              <button
                className="btn btn--danger"
                onClick={async () => {
                  setConfirmDiscard(false);
                  await discard(app.id);
                }}
              >
                Throw it away
              </button>
            </>
          }
        >
          <p>The idea goes back to your ideas list, so you can make it again later.</p>
        </Dialog>
      )}
    </div>
  );
}
