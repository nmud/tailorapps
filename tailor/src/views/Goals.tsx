import { useEffect, useState, type FormEvent } from 'react';
import { Lightbulb, RefreshCw, Target, X } from 'lucide-react';
import { suggest } from '../agents/designer';
import { goalProgress, measureGoal, type GoalProgress } from '../agents/goals';
import { friendlyError } from '../lib/llm';
import { go, save, toast, useStore } from '../lib/store';
import type { Goal, GoalKind } from '../lib/types';
import { formatDuration, uid } from '../lib/util';
import { Switch } from '../components/ui';

const KINDS: { id: GoalKind; label: string }[] = [
  { id: 'less', label: 'Do less' },
  { id: 'more', label: 'Do more' },
  { id: 'habit', label: 'Make it a habit' },
];

const EXAMPLES: { text: string; kind: GoalKind }[] = [
  { text: 'Game less on school nights', kind: 'less' },
  { text: 'Practise guitar every day', kind: 'habit' },
  { text: 'Get more done in the mornings', kind: 'more' },
];

const time = (ms: number) => (ms < 60_000 ? '0m' : formatDuration(ms));

function Progress({ g, p, measuring }: { g: Goal; p?: GoalProgress; measuring: boolean }) {
  const m = g.measure;
  if (!m) return <p className="hint">{measuring ? 'Working out what to count…' : 'Not measured yet.'}</p>;
  if (!m.contexts.length) return <p className="hint">Tailor can't see this on your computer, but ideas will still aim at it.</p>;
  if (!p) return null;

  if (g.kind === 'habit' && m.daysPerWeek) {
    return (
      <div className="goal-progress">
        <div className="goal-meter" data-state={p.days >= m.daysPerWeek ? 'met' : undefined}>
          <i style={{ width: `${Math.min(100, (p.days / m.daysPerWeek) * 100)}%` }} />
        </div>
        <span>
          {p.days} of {m.daysPerWeek} days this week
        </span>
      </div>
    );
  }
  if (m.minutesPerDay) {
    const limit = m.minutesPerDay * 60_000;
    const over = g.kind === 'less' && p.todayMs > limit;
    const met = g.kind !== 'less' && p.todayMs >= limit;
    return (
      <div className="goal-progress">
        <div className="goal-meter" data-state={over ? 'over' : met ? 'met' : undefined}>
          <i style={{ width: `${Math.min(100, (p.todayMs / limit) * 100)}%` }} />
        </div>
        <span>
          Today {time(p.todayMs)} of {time(limit)}
          {over ? ' · over your limit' : met ? ' · done for today' : ''}
        </span>
      </div>
    );
  }
  return <p className="hint">This week: {time(p.weekMs)}</p>;
}

export default function Goals() {
  const goals = useStore((s) => s.goals);
  const [text, setText] = useState('');
  const [kind, setKind] = useState<GoalKind>('less');
  const [strict, setStrict] = useState(false);
  const [progress, setProgress] = useState<Record<string, GoalProgress>>({});
  const [measuring, setMeasuring] = useState<Set<string>>(new Set());

  // Recount every minute while this page is open.
  useEffect(() => {
    const count = () => goalProgress(goals).then(setProgress, () => {});
    count();
    const timer = setInterval(count, 60_000);
    return () => clearInterval(timer);
  }, [goals]);

  async function measure(g: Goal) {
    setMeasuring((s) => new Set(s).add(g.id));
    try {
      await measureGoal(g);
    } catch (e) {
      toast(friendlyError(e), { tone: 'error' });
    } finally {
      setMeasuring((s) => {
        const next = new Set(s);
        next.delete(g.id);
        return next;
      });
    }
  }

  async function add(e: FormEvent) {
    e.preventDefault();
    const t = text.trim();
    if (!t) return;
    const now = Date.now();
    const g: Goal = { id: uid('g_'), text: t.slice(0, 200), kind, strict, createdAt: now, updatedAt: now };
    await save.goal(g);
    setText('');
    setStrict(false);
    void measure(g);
  }

  function ideasFor(g: Goal) {
    go('discover');
    void suggest({ ask: `Help me with my goal: ${g.text}`, origin: 'ask', count: 3 });
  }

  return (
    <div className="page">
      <header>
        <h1 className="page-title">Goals</h1>
        <p className="page-sub">What you're working toward. Ideas will aim at it.</p>
      </header>

      <section className="section">
        <form className="goal-form panel" onSubmit={add}>
          <label className="sr-only" htmlFor="goal">
            Your goal
          </label>
          <input id="goal" className="input" placeholder="What do you want to change?" value={text} onChange={(e) => setText(e.target.value)} maxLength={200} />
          <div className="goal-options">
            <div className="seg" role="radiogroup" aria-label="Kind of goal">
              {KINDS.map((k) => (
                <button key={k.id} type="button" role="radio" aria-checked={kind === k.id} className="seg-item" onClick={() => setKind(k.id)}>
                  {k.label}
                </button>
              ))}
            </div>
            <label className="goal-strict">
              <Switch label="Hold me to it" checked={strict} onChange={setStrict} />
              <span>Hold me to it</span>
            </label>
            <button className="btn btn--primary" disabled={!text.trim()}>
              Add goal
            </button>
          </div>
        </form>
        {!goals.length && (
          <div className="chips">
            {EXAMPLES.map((x) => (
              <button
                key={x.text}
                type="button"
                className="chip"
                onClick={() => {
                  setText(x.text);
                  setKind(x.kind);
                }}
              >
                {x.text}
              </button>
            ))}
          </div>
        )}
      </section>

      <section className="section" aria-label="Your goals">
        {goals.length ? (
          <div className="goals stagger">
            {goals.map((g) => (
              <article className="goal panel" key={g.id}>
                <div className="goal-head">
                  <Target />
                  <div>
                    <strong>{g.text}</strong>
                    <span className="goal-tags">
                      <span className="tag">{KINDS.find((k) => k.id === g.kind)?.label}</span>
                      {g.strict && <span className="tag tag--ok">Hold me to it</span>}
                    </span>
                  </div>
                  <button className="btn btn--ghost btn--icon" aria-label={`Remove “${g.text}”`} onClick={() => save.removeGoal(g.id)}>
                    <X />
                  </button>
                </div>
                {g.measure?.summary && <p className="goal-target">{g.measure.summary}</p>}
                <Progress g={g} p={progress[g.id]} measuring={measuring.has(g.id)} />
                <div className="row">
                  <button className="btn btn--sm" onClick={() => ideasFor(g)}>
                    <Lightbulb /> Ideas for this
                  </button>
                  {(!g.measure || !g.measure.contexts.length) && !measuring.has(g.id) && (
                    <button className="btn btn--sm btn--ghost" onClick={() => measure(g)}>
                      <RefreshCw /> Check again
                    </button>
                  )}
                </div>
              </article>
            ))}
          </div>
        ) : (
          <div className="empty">
            <h3>No goals yet</h3>
            <p>Add one above, or tap an example. Tailor counts your progress from what it learns, and ideas aim at your goals.</p>
          </div>
        )}
      </section>
    </div>
  );
}
