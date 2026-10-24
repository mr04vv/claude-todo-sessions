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

/// A page opened beside a session in 作業 (a terminal's link): a tab of
/// 作業's that is no session's page or terminal.
export const isWorkPage = (t: { area?: string; session?: string; term?: unknown }) => t.area === "work" && !t.session && !t.term;

/// Whether tab `id` is a split view's right: one of `rights` (学習's pages to
/// ask), a page of `rightSession` (the session on 作業's right), or a page
/// opened beside a session in 作業.
export function isSplitRight<T extends { id: string; area?: string; session?: string; term?: unknown }>(tabs: T[], id: string, rights: string[], rightSession: string | undefined): boolean {
  if (rights.includes(id)) return true;
  const tab = tabs.find((t) => t.id === id);
  return !!tab && ((rightSession !== undefined && tab.session === rightSession) || isWorkPage(tab));
}

/// `tabs` with `tab` put right after `after` (the tab it was opened from), or last.
/// 作業's right: the subtasks not closed there, and the one shown: the one
/// asked for, else one asking, else one at work, else the first.
export function rightChildren<T extends { id: number }>(children: T[], closed: number[], asked: number | null, asks: (c: T) => boolean, runs: (c: T) => boolean) {
  const shown = children.filter((c) => !closed.includes(c.id));
  return { children: shown, child: shown.find((c) => c.id === asked) ?? shown.find(asks) ?? shown.find(runs) ?? shown[0] };
}

export function insertAfter<T extends { id: string }>(tabs: T[], tab: T, after: string | null): T[] {
  const i = after === null ? -1 : tabs.findIndex((t) => t.id === after);
  if (i < 0) return [...tabs, tab];
  return [...tabs.slice(0, i + 1), tab, ...tabs.slice(i + 1)];
}

/// A file on the Mac as a page to open (its path's parts escaped).
export const fileUrl = (path: string) => `file://${path.split("/").map(encodeURIComponent).join("/")}`;

/// The path a file URL stands for (null for any other URL).
export const pathOfFileUrl = (url: string) => (url.startsWith("file://") ? decodeURIComponent(url.slice("file://".length)) : null);

/// Letters a pinned page's mark shows.
const PIN_MARK_LETTERS = 2;
/// The prefix of the ids of pages the user pinned (the app's own are `pin<name>`).
const USER_PIN = "pinu";

/// A page the user pins (a tab dragged onto the pins): an id not taken, its
/// title for a name (else its site), and the name's first letters for a mark.
export function newPin(pins: { id: string }[], url: string, title: string | null) {
  const taken = new Set(pins.map((p) => p.id));
  let n = 1;
  while (taken.has(`${USER_PIN}${n}`)) n++;
  const label = title?.trim() || new URL(url).hostname.replace(/^www\./, "");
  const short = label.slice(0, PIN_MARK_LETTERS);
  return { id: `${USER_PIN}${n}`, label, short: short.charAt(0).toUpperCase() + short.slice(1), url };
}
