// Managed by Tailor. Do not edit.
// Reads live data from this computer that the person allowed this app to see, and opens links.

export type FeedName = 'open-tabs' | 'open-windows' | 'ai-tools';

export interface Feed<T> {
  available: boolean;
  /** A sentence to show the person when the data isn't available. */
  reason?: string;
  updatedAt?: number;
  items: T[];
}

/** A browser tab that is open right now. */
export interface OpenTab {
  title: string | null;
  url: string | null;
  domain: string;
  windowId: number;
  active: boolean;
  lastAccessed: number;
}

/** A window open on this computer. `app` is the program name, e.g. "code", "windowsterminal". */
export interface OpenWindow {
  app: string;
  title: string;
}

/** One thing set up in an AI tool: an MCP server, connector, plugin or skill. Names only. */
export interface AiTool {
  app: string;
  kind: 'mcp-server' | 'connector' | 'plugin' | 'skill';
  name: string;
  scope: 'user' | 'project' | 'plugin' | 'cloud';
  project: string | null;
}

export async function readFeed<T>(name: FeedName): Promise<Feed<T>> {
  try {
    const res = await fetch(`/__tailor/feeds/${name}`, { cache: 'no-store' });
    return (await res.json()) as Feed<T>;
  } catch {
    return { available: false, reason: 'Tailor isn’t running right now.', items: [] };
  }
}

/** Open a web address in the person's browser. Does nothing while Tailor is test-driving the app. */
export function openLink(url: string): void {
  if ((window as unknown as { __tailorTesting?: boolean }).__tailorTesting) return;
  fetch('/__tailor/open', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url }),
  }).catch(() => {});
}
