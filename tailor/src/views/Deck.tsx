import { useEffect, useState } from 'react';
import { openUrl } from '@tauri-apps/plugin-opener';
import { ExternalLink, Info, Pencil, Trash2 } from 'lucide-react';
import { openApp, reviseApp } from '../agents/builder';
import { api, appUrl } from '../lib/api';
import { AppGlyph } from '../lib/icons';
import { go, recordFeedback, save, setState, toast, useStore } from '../lib/store';
import type { AppRecord } from '../lib/types';

function Tile({ app, highlight }: { app: AppRecord; highlight: boolean }) {
  const [why, setWhy] = useState(false);

  function remove() {
    // Hide it now; only delete for good if the person doesn't undo.
    let undone = false;
    setState((s) => ({ apps: s.apps.filter((a) => a.id !== app.id) }));
    api.appCloseWindow(app.id).catch(() => {});
    toast(`Removed ${app.name}`, {
      action: {
        label: 'Undo',
        run: () => {
          undone = true;
          setState((s) => ({ apps: [app, ...s.apps] }));
        },
      },
    });
    setTimeout(async () => {
      if (undone) return;
      await save.removeApp(app.id);
      await api.appUninstall(app.id, app.shortcut).catch(() => {});
      await api.appDelete(app.id).catch(() => {});
      await recordFeedback('remove', app.name, 'Removed the app', { appId: app.id, suggestionId: app.suggestionId });
    }, 8500);
  }

  return (
    <article className={`card tile shine${highlight ? ' is-new' : ''}`}>
      <div className="tile-head">
        <AppGlyph icon={app.icon} accent={app.accent} size="lg" />
        <div style={{ minWidth: 0 }}>
          <h2>{app.name}</h2>
          <p>{app.tagline}</p>
        </div>
      </div>
      {why && <p className="tile-why">{app.rationale}</p>}
      <div className="tile-actions">
        <button className="btn btn--primary" onClick={() => openApp(app)}>
          Open
        </button>
        <button className="btn" onClick={() => reviseApp(app.id)}>
          <Pencil /> Change it
        </button>
      </div>
      <div className="tile-links">
        <button className="btn btn--ghost btn--sm" aria-pressed={why} onClick={() => setWhy((w) => !w)}>
          <Info /> Why it was made
        </button>
        <button className="btn btn--ghost btn--sm" onClick={() => openUrl(appUrl(app.id))}>
          <ExternalLink /> In browser
        </button>
        <button className="btn btn--ghost btn--sm btn--danger" onClick={remove}>
          <Trash2 /> Remove
        </button>
      </div>
    </article>
  );
}

export default function Deck() {
  const apps = useStore((s) => s.apps);
  const highlight = useStore((s) => s.highlightAppId);
  const installed = apps.filter((a) => a.status === 'installed').sort((a, b) => (b.installedAt ?? 0) - (a.installedAt ?? 0));

  useEffect(() => {
    if (!highlight) return;
    const t = setTimeout(() => setState({ highlightAppId: null }), 4000);
    return () => clearTimeout(t);
  }, [highlight]);

  return (
    <div className="page">
      <header>
        <h1 className="page-title">My apps</h1>
        <p className="page-sub">Each one opens in its own window.</p>
      </header>
      {installed.length ? (
        <div className="deck-grid stagger">
          {installed.map((a) => (
            <Tile key={a.id} app={a} highlight={a.id === highlight} />
          ))}
        </div>
      ) : (
        <div className="empty">
          <h3>No apps yet</h3>
          <p>Pick an idea to make your first one.</p>
          <button className="btn btn--primary" onClick={() => go('discover')}>
            See ideas
          </button>
        </div>
      )}
    </div>
  );
}
