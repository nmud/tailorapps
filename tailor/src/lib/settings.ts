import type { Settings } from './types';

export const DEFAULT_SETTINGS: Settings = {
  autoAnalyze: true,
  autoSuggest: true,
  theme: 'system',
  startMenu: true,
};

/** Merge stored settings over defaults so new fields appear after upgrades. */
export function mergeSettings(stored: Partial<Settings> | null): Settings {
  return { ...DEFAULT_SETTINGS, ...(stored ?? {}) };
}
