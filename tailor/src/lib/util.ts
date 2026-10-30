export const uid = (prefix = '') =>
  `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^\w\s-]/g, '')
      .replace(/[\s_]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40) || 'app'
  );
}

/**
 * An app's address name. A random ending means a new app never reuses a deleted app's address,
 * and so never sees the data that app saved.
 */
export function uniqueSlug(name: string, taken: Set<string>): string {
  const base = slugify(name);
  for (;;) {
    const bytes = crypto.getRandomValues(new Uint8Array(4));
    const tail = Array.from(bytes, (b) => 'abcdefghijkmnpqrstuvwxyz23456789'[b % 32]).join('');
    const slug = `${base}-${tail}`;
    if (!taken.has(slug)) return slug;
  }
}

/** Stable short hash, for pattern ids derived from signal ids. */
export function hash(text: string): string {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

export function timeAgo(ts: number, now = Date.now()): string {
  const s = Math.round((ts - now) / 1000);
  const abs = Math.abs(s);
  if (abs < 45) return 'just now';
  if (abs < 3600) return rtf.format(Math.round(s / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(s / 3600), 'hour');
  if (abs < 86400 * 30) return rtf.format(Math.round(s / 86400), 'day');
  return new Date(ts).toLocaleDateString();
}

export function formatDuration(ms: number): string {
  const m = Math.round(ms / 60000);
  if (m < 1) return `${Math.max(1, Math.round(ms / 1000))}s`;
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest ? `${h}h ${rest}m` : `${h}h`;
}

export const clockTime = (ts: number) =>
  new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

export const shortDate = (ts: number) =>
  new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric' });

export function plural(n: number, one: string, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

export function errorText(e: unknown): string {
  if (typeof e === 'string') return e;
  if (e instanceof Error) return e.message;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}
