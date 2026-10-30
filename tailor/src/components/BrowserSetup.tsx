import { useEffect, useState } from 'react';
import { CircleCheck, FolderOpen } from 'lucide-react';
import { api } from '../lib/api';
import { setState, useStore } from '../lib/store';

const LIVE_MS = 5 * 60_000;

/** True when the browser add-on has talked to Tailor recently. */
export function useBrowserConnected(): boolean {
  const runtime = useStore((s) => s.runtime);
  useEffect(() => {
    const t = setInterval(async () => setState({ runtime: await api.runtimeStatus() }), 3000);
    return () => clearInterval(t);
  }, []);
  return !!runtime && Date.now() - runtime.extensionLastSeen < LIVE_MS;
}

/** Steps for adding the Tailor add-on to Chrome or Edge. */
export function BrowserSetup() {
  const connected = useBrowserConnected();
  const [opened, setOpened] = useState(false);

  return (
    <div className="panel" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-md)' }}>
      {connected ? (
        <div className="row" role="status">
          <CircleCheck color="var(--color-accent)" />
          <strong>Your browser is connected.</strong>
        </div>
      ) : (
        <>
          <ol className="steps-list">
            <li>
              In Chrome or Edge, type <strong>chrome://extensions</strong> (or <strong>edge://extensions</strong>) in the address bar.
            </li>
            <li>
              Turn on <strong>Developer mode</strong>, then click <strong>Load unpacked</strong>.
            </li>
            <li>Choose the Tailor add-on folder.</li>
          </ol>
          <div className="row">
            <button
              className="btn"
              onClick={async () => {
                await api.extensionReveal().catch(() => {});
                setOpened(true);
              }}
            >
              <FolderOpen /> Show the add-on folder
            </button>
            <span className="hint" role="status">
              {opened ? 'Waiting for your browser…' : 'This page updates when it connects.'}
            </span>
          </div>
        </>
      )}
    </div>
  );
}
