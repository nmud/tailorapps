import { useEffect, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';

/** A frameless window's own title bar: drag anywhere on it, double-click to maximize. */
export function TitleBar({ showBrand = true, title = 'Tailor', icon = '/tailor-128.png' }: { showBrand?: boolean; title?: string; icon?: string }) {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    const win = getCurrentWindow();
    win.isMaximized().then(setMaximized);
    const off = win.onResized(async () => setMaximized(await win.isMaximized()));
    return () => {
      off.then((f) => f());
    };
  }, []);

  const win = getCurrentWindow();
  return (
    <header className="titlebar" data-tauri-drag-region>
      {showBrand && (
        <div className="titlebar-brand" data-tauri-drag-region>
          <img src={icon} alt="" data-tauri-drag-region />
          <span data-tauri-drag-region>{title}</span>
        </div>
      )}
      <div className="titlebar-controls">
        <button className="titlebar-btn" aria-label="Minimize" title="Minimize" onClick={() => win.minimize()}>
          <svg viewBox="0 0 10 10" aria-hidden="true">
            <path d="M0 5h10" />
          </svg>
        </button>
        <button
          className="titlebar-btn"
          aria-label={maximized ? 'Restore' : 'Maximize'}
          title={maximized ? 'Restore' : 'Maximize'}
          onClick={() => win.toggleMaximize()}
        >
          {maximized ? (
            <svg viewBox="0 0 10 10" aria-hidden="true">
              <path d="M2.5 2.5V1h6.5v6.5H7.5" />
              <rect x="0.5" y="2.5" width="7" height="7" />
            </svg>
          ) : (
            <svg viewBox="0 0 10 10" aria-hidden="true">
              <rect x="0.5" y="0.5" width="9" height="9" />
            </svg>
          )}
        </button>
        <button className="titlebar-btn titlebar-btn--close" aria-label="Close" title="Close" onClick={() => win.close()}>
          <svg viewBox="0 0 10 10" aria-hidden="true">
            <path d="M0.5 0.5l9 9M9.5 0.5l-9 9" />
          </svg>
        </button>
      </div>
    </header>
  );
}
