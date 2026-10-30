import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { Eye, Hammer, LayoutGrid, Lightbulb, Settings2, Target } from 'lucide-react';
import { analyze } from './agents/observer';
import { ensureWorkspace, reportRuntime } from './agents/builder';
import { reportTestMessage } from './agents/tester';
import { appUrl } from './lib/api';
import { api } from './lib/api';
import { checkSession, getState, go, save, setState, useStore } from './lib/store';
import type { View } from './lib/types';
import { Switch, Toasts } from './components/ui';
import { TitleBar } from './components/TitleBar';
import { applyTheme } from './lib/theme';
import Auth from './views/Auth';
import Onboarding from './views/Onboarding';
import Discover from './views/Discover';
import Workshop from './views/Workshop';
import Deck from './views/Deck';
import Memory from './views/Memory';
import Settings from './views/Settings';
import Goals from './views/Goals';

const NAV: { id: View; label: string; icon: typeof Eye }[] = [
  { id: 'discover', label: 'Ideas', icon: Lightbulb },
  { id: 'goals', label: 'Goals', icon: Target },
  { id: 'workshop', label: 'Building', icon: Hammer },
  { id: 'deck', label: 'My apps', icon: LayoutGrid },
  { id: 'memory', label: 'Learning', icon: Eye },
  { id: 'settings', label: 'Settings', icon: Settings2 },
];

const ANALYZE_EVERY_MS = 30 * 60_000;
const MIN_NEW_EVENTS = 40;

function LearningCard() {
  const learning = useStore((s) => s.learning);
  return (
    <div className="learning-card" data-on={learning.enabled}>
      <div>
        <strong>Learning</strong>
        <span>{learning.enabled ? 'On' : 'Off'}</span>
      </div>
      <Switch
        checked={learning.enabled}
        label="Learning"
        onChange={(enabled) =>
          save.learning({
            ...learning,
            enabled,
            // Turning learning on with every method off would do nothing; switch the methods back on.
            ...(enabled && !learning.extension && !learning.desktop ? { extension: true, desktop: true } : {}),
          })
        }
      />
    </div>
  );
}

/** A hidden, full-size copy of an app that the Tester agent uses. */
function TestFrame() {
  const frame = useStore((s) => s.testFrame);
  if (!frame) return null;
  return (
    <iframe
      id="tailor-test-frame"
      key={frame.nonce}
      title="Testing"
      aria-hidden="true"
      tabIndex={-1}
      src={`${appUrl(frame.appId)}?test=${frame.nonce}`}
      sandbox="allow-scripts allow-same-origin allow-forms"
      className="test-frame"
    />
  );
}

function Rail() {
  const view = useStore((s) => s.view);
  const apps = useStore((s) => s.apps);
  const job = useStore((s) => s.job);
  const unseen = useStore((s) => s.unseenSuggestions);
  const installed = apps.filter((a) => a.status === 'installed').length;
  const drafts = apps.filter((a) => a.status === 'draft').length;
  const navRef = useRef<HTMLDivElement>(null);
  const [pill, setPill] = useState<React.CSSProperties>({ opacity: 0 });

  // Glide the glass pill to the current page.
  useLayoutEffect(() => {
    const el = navRef.current?.querySelector<HTMLElement>(`[data-view="${view}"]`);
    if (el) setPill({ transform: `translateY(${el.offsetTop}px)`, height: el.offsetHeight, opacity: 1 });
  }, [view]);

  return (
    <nav className="rail" aria-label="Main">
      <div className="nav" ref={navRef}>
        <span className="nav-pill" style={pill} aria-hidden="true" />
        {NAV.map(({ id, label, icon: Icon }) => (
          <button key={id} data-view={id} className="nav-item" aria-current={view === id ? 'page' : undefined} onClick={() => go(id)}>
            <Icon strokeWidth={1.9} />
            {label}
            {id === 'discover' && unseen > 0 && <span className="nav-count nav-count--new">{unseen}</span>}
            {id === 'workshop' && job?.busy && <span className="nav-dot" aria-label="Building now" />}
            {id === 'workshop' && !job?.busy && drafts > 0 && <span className="nav-count">{drafts}</span>}
            {id === 'deck' && installed > 0 && <span className="nav-count">{installed}</span>}
          </button>
        ))}
      </div>
      <div className="rail-foot">
        <LearningCard />
      </div>
    </nav>
  );
}

export default function App() {
  const authChecked = useStore((s) => s.authChecked);
  const user = useStore((s) => s.user);
  const onboarded = useStore((s) => s.onboarded);
  const loaded = useStore((s) => s.loaded);
  const view = useStore((s) => s.view);

  useEffect(() => {
    checkSession();
    const unlisten = listen<number>('activity', () => setState((s) => ({ activityTick: s.activityTick + 1 })));

    // Previews report problems here; only messages from a generated app's own address count.
    const onMessage = (e: MessageEvent) => {
      const m = /^http:\/\/([a-z0-9-]+)\.localhost:48100$/.exec(e.origin);
      const data = e.data as { source?: string; kind?: string; message?: string; id?: number; result?: unknown } | null;
      if (!m || data?.source !== 'tailor-app') return;
      const fromTestFrame = e.source === (document.getElementById('tailor-test-frame') as HTMLIFrameElement | null)?.contentWindow;
      if (fromTestFrame) reportTestMessage(m[1], String(data.kind), data);
      else reportRuntime(m[1], String(data.kind), String(data.message ?? ''));
    };
    window.addEventListener('message', onMessage);

    // Glass surfaces catch the light where the pointer is.
    const onPointer = (e: PointerEvent) => {
      const el = (e.target as Element | null)?.closest?.('.shine') as HTMLElement | null;
      if (!el) return;
      const r = el.getBoundingClientRect();
      el.style.setProperty('--mx', `${e.clientX - r.left}px`);
      el.style.setProperty('--my', `${e.clientY - r.top}px`);
    };
    window.addEventListener('pointermove', onPointer, { passive: true });

    // Learning can be paused from the tray menu too.
    const offLearning = listen('learning-changed', async () => setState({ learning: await api.learningGet() }));

    // Look for patterns in the background when learning is on and there's enough new activity.
    const observerTimer = setInterval(async () => {
      const st = getState();
      if (!st.user || !st.loaded || !st.learning.enabled || !st.settings.autoAnalyze || st.observer.running) return;
      const last = st.observer.lastRunAt ?? 0;
      if (Date.now() - last < ANALYZE_EVERY_MS) return;
      const fresh = await api.eventsQuery(last, { limit: MIN_NEW_EVENTS });
      if (fresh.length >= MIN_NEW_EVENTS) analyze({ quiet: true });
    }, 5 * 60_000);

    return () => {
      unlisten.then((f) => f());
      window.removeEventListener('message', onMessage);
      window.removeEventListener('pointermove', onPointer);
      offLearning.then((f) => f());
      clearInterval(observerTimer);
    };
  }, []);

  const theme = useStore((s) => s.settings.theme);
  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  // Get the app-building tools ready in the background once someone is signed in.
  useEffect(() => {
    if (user) ensureWorkspace(true).catch(() => {});
  }, [user]);

  const frame = (content: React.ReactNode, showBrand = true) => (
    <div className="app-frame">
      <TitleBar showBrand={showBrand} />
      <div className="app-body">{content}</div>
      <TestFrame />
      <Toasts />
    </div>
  );

  if (!authChecked) return frame(null);
  if (!user) return frame(<Auth />, false);
  if (!onboarded) return frame(<Onboarding />);

  return frame(
    <div className="shell">
      <Rail />
      <main className="main">
        <div className="view" key={view}>
        {!loaded ? null : view === 'discover' ? (
          <Discover />
        ) : view === 'goals' ? (
          <Goals />
        ) : view === 'workshop' ? (
          <Workshop />
        ) : view === 'deck' ? (
          <Deck />
        ) : view === 'memory' ? (
          <Memory />
        ) : (
          <Settings />
        )}
        </div>
      </main>
    </div>
  );
}
