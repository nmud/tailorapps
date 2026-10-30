import { getCurrentWindow, Effect } from '@tauri-apps/api/window';
import { api } from './api';

export type ThemeName = 'system' | 'light' | 'dark' | 'ocean' | 'midnight';

export const THEMES: { id: ThemeName; label: string; dark: boolean | null }[] = [
  { id: 'system', label: 'Match Windows', dark: null },
  { id: 'light', label: 'Linen', dark: false },
  { id: 'dark', label: 'Graphite', dark: true },
  { id: 'ocean', label: 'Ocean', dark: false },
  { id: 'midnight', label: 'Midnight', dark: true },
];

const systemDark = () => window.matchMedia('(prefers-color-scheme: dark)').matches;

/** The theme actually shown, after resolving "Match Windows". */
export function resolveTheme(name: ThemeName): Exclude<ThemeName, 'system'> {
  if (name !== 'system') return name;
  return systemDark() ? 'dark' : 'light';
}

export function isDark(name: ThemeName): boolean {
  const resolved = resolveTheme(name);
  return THEMES.find((t) => t.id === resolved)?.dark ?? false;
}

let current: ThemeName = 'light';
let lastEffective = '';
let latest = 0;

/** Apply a theme to Tailor's window, its glass material, and the apps it made. */
export async function applyTheme(name: ThemeName) {
  current = name;
  const call = ++latest;
  const win = getCurrentWindow();
  // Let the window follow Windows first, so "Match Windows" reads the real system setting.
  if (name === 'system') await win.setTheme(null).catch(() => {});
  // At startup the default ("Match Windows") and the saved theme are applied back to back; the
  // older call must not finish last and paint over the saved one.
  if (call !== latest) return;
  const resolved = resolveTheme(name);
  const dark = isDark(name);
  const root = document.documentElement;
  root.classList.add('theme-switching');
  root.dataset.theme = resolved;
  root.style.colorScheme = dark ? 'dark' : 'light';
  requestAnimationFrame(() => setTimeout(() => root.classList.remove('theme-switching'), 400));
  // The JS enum lacks the explicit light/dark Mica variants; the Rust side supports them.
  await win.setEffects({ effects: [(dark ? 'micaDark' : 'micaLight') as Effect] }).catch(() => {});
  if (call !== latest) return;
  if (name !== 'system') await win.setTheme(dark ? 'dark' : 'light').catch(() => {});
  const effective = dark ? 'dark' : 'light';
  if (effective !== lastEffective) {
    lastEffective = effective;
    await api.kvSet('theme_effective', effective).catch(() => {});
  }
}

/** Follow Windows when the theme is "Match Windows". */
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (current === 'system') applyTheme('system');
});
