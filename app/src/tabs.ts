// The browser pane's tab rules, kept apart from the components so they can be tested.

export const SEARCH_URL = "https://www.google.com/search?q=";

/// Hosts served from this Mac, opened over plain http.
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])$/;

/// What the address bar opens: a URL as typed, a host (with a port or a path)
/// as a page, and anything else as a search.
export function addressToUrl(text: string): string | null {
  const t = text.trim();
  if (!t) return null;
  if (/^https?:\/\//i.test(t)) return t;
  const host = t.match(/^([^\s/:]+)(:\d+)?(\/\S*)?$/);
  if (host && (LOCAL_HOST.test(host[1]) || host[2] || host[1].includes("."))) {
    return `${LOCAL_HOST.test(host[1]) ? "http" : "https"}://${t}`;
  }
  return SEARCH_URL + encodeURIComponent(t);
}

/// An address without its fragment or a trailing slash, to tell whether two
/// addresses are the same page.
const normal = (url: string) => url.replace(/#.*$/, "").replace(/\/+$/, "");

/// Whether two addresses are the same page (a fragment or a trailing slash aside).
export const sameObject = (a: string, b: string) => normal(a) === normal(b);

/// The tab opened for `url` (by the address it was opened for, which stays
/// though the page moves on), else one showing it.
export function findTabFor<T extends { url: string; openedFor?: string }>(tabs: T[], url: string): T | undefined {
  return tabs.find((t) => sameObject(t.openedFor ?? t.url, url));
}

/// The tab to show when `closed` closes: its right neighbour, else its left one.
export function nextAfterClose<T extends { id: string }>(tabs: T[], closed: string): T | null {
  const i = tabs.findIndex((t) => t.id === closed);
  if (i < 0) return null;
  return tabs[i + 1] ?? tabs[i - 1] ?? null;
}

/// `tabs` with `tab` put right after `after` (the tab it was opened from), or last.
export function insertAfter<T extends { id: string }>(tabs: T[], tab: T, after: string | null): T[] {
  const i = after === null ? -1 : tabs.findIndex((t) => t.id === after);
  if (i < 0) return [...tabs, tab];
  return [...tabs.slice(0, i + 1), tab, ...tabs.slice(i + 1)];
}
