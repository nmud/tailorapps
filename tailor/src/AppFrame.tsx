import { useEffect, useState } from 'react';
import { getCurrentWindow, type Effect } from '@tauri-apps/api/window';
import { appUrl } from './lib/api';
import { TitleBar } from './components/TitleBar';

/**
 * The window frame around a generated app: the same glass title bar and border as Tailor.
 * The app itself loads in a sealed frame at its own address and can't reach Tailor.
 */
export default function AppFrame({ slug, name, initialTheme }: { slug: string; name: string; initialTheme: string }) {
  const [theme, setTheme] = useState(initialTheme === 'dark' ? 'dark' : 'light');
  const base = appUrl(slug);

  // Follow Tailor's light or dark theme.
  useEffect(() => {
    const sync = () =>
      fetch(`${base}__tailor/theme`, { cache: 'no-store' })
        .then((r) => r.json())
        .then((t: { theme?: string }) => setTheme(t.theme === 'dark' ? 'dark' : 'light'))
        .catch(() => {});
    window.addEventListener('focus', sync);
    const timer = setInterval(sync, 15000);
    return () => {
      window.removeEventListener('focus', sync);
      clearInterval(timer);
    };
  }, [base]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    const win = getCurrentWindow();
    win.setEffects({ effects: [(theme === 'dark' ? 'micaDark' : 'micaLight') as Effect] }).catch(() => {});
    win.setTheme(theme === 'dark' ? 'dark' : 'light').catch(() => {});
  }, [theme]);

  return (
    <div className="app-frame">
      <TitleBar title={name} icon={`${base}__tailor/icon`} />
      <div className="app-body framed-app">
        <iframe
          title={name}
          src={base}
          sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-downloads allow-popups"
        />
      </div>
    </div>
  );
}
