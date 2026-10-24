// The browser's own window: its tabs, the pinned pages and the address bar,
// apart from the main window. What the main window opens in the browser comes
// here as a tab (BROWSER_WINDOW_OPEN_EVENT, or taken once this page is up).
import { useEffect, useRef, useState } from "react";
import {
  api,
  BROWSER_ADDRESS_EVENT,
  BROWSER_CLOSE_TAB_EVENT,
  BROWSER_NEW_TAB_EVENT,
  BROWSER_OPEN_NEW_TAB_EVENT,
  BROWSER_SWITCH_TAB_EVENT,
  BROWSER_TITLE_EVENT,
  BROWSER_TRANSLATED_EVENT,
  BROWSER_URL_EVENT,
  BROWSER_WINDOW_OPEN_EVENT,
  BROWSER_ZOOM_EVENT,
  FOCUS_APP_EVENT,
  PAGE_DIALOG_EVENT,
  PAGE_FOCUSED_EVENT,
} from "./api";
import {
  BrowserSpace,
  cloudIdOfPage,
  keysToTab,
  loadJson,
  NEW_TAB_ASK,
  PageDialog,
  PANE_TABS_KEY,
  PIN_ASK,
  pinnedPages,
  pinnedUrl,
  recordVisit,
  remember,
  restoreTabs,
  saveUserPins,
  TAB_LIST_DEFAULT_W,
  TAB_LIST_W_KEY,
  tabUrls,
  userPinsNow,
  type BrowserTab,
  type PageDialogAsk,
  type SavedTabs,
} from "./App";
import { focusSoon, noteFocusRequest, takeFocusWish, userActed } from "./focus";
import { keyLabel, keyOf, matches, type Action } from "./keymap";
import { findTabFor, insertAfter, newPin, nextAfterClose } from "./tabs";
import { listenHere as listen } from "./windowEvents";

/// The main window's spaces, by their keys, which bring it forward from here.
const MAIN_SPACES: [Action, string][] = [
  ["spaceManage", "manage"],
  ["spaceWork", "work"],
  ["spaceStudy", "study"],
  ["spaceSlack", "slack"],
  ["spaceArtifacts", "artifacts"],
];

/// The number after a tab id's letter (`t12`), for the next id.
const idNumber = (id: string) => Number(/^t(\d+)$/.exec(id)?.[1] ?? 0);

export default function BrowserWindow() {
  const [tabs, setTabs] = useState<BrowserTab[]>(() => restoreTabs().tabs);
  const [activeId, setActiveId] = useState<string | null>(() => restoreTabs().active);
  const [newTab, setNewTab] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ask, setAsk] = useState<PageDialogAsk | null>(null);
  // Whether the keyboard is this page's (the tab list's cursor shows) or a tab's.
  const [typing, setTyping] = useState<"app" | "pane">("app");
  const [listW, setListWState] = useState(() => loadJson<number>(TAB_LIST_W_KEY, TAB_LIST_DEFAULT_W));
  const setListW = (w: number) => {
    remember(TAB_LIST_W_KEY, String(w));
    setListWState(w);
  };
  // The user's pins live outside React; a change shows by this.
  const [, setPinsVersion] = useState(0);
  const next = useRef(1 + Math.max(0, ...tabs.map((t) => idNumber(t.id))));
  const report = (e: unknown) => setError(String(e));

  const normal = tabs.filter((t) => !t.pinned);
  const active = newTab ? null : (tabs.find((t) => t.id === activeId) ?? normal[normal.length - 1] ?? null);
  const show = (id: string | null) => {
    setNewTab(id === null);
    setActiveId(id);
  };

  // The tabs are kept across restarts: their pages (not the pages' state), the pinned pages' too.
  const saved = JSON.stringify({
    tabs: tabs.map((t): SavedTabs["tabs"][number] => ({ url: t.url, openedFor: t.openedFor, title: t.title, pinned: t.pinned ? t.id : undefined })),
    active: tabs.findIndex((t) => t.id === active?.id),
  });
  useEffect(() => remember(PANE_TABS_KEY, saved), [saved]);

  /// A pinned page, opened the first time, shown with its text box ready.
  const showPinned = (id: string) => {
    if (!pinnedPages().some((p) => p.id === id)) return;
    focusSoon(id, true);
    setTabs((prev) => (prev.some((t) => t.id === id) ? prev : [{ id, url: pinnedUrl(id), title: pinnedPages().find((p) => p.id === id)?.label ?? null, loading: true, nav: 0, pinned: true }, ...prev]));
    show(id);
  };
  /// Opens `url` (or one of the main window's asks): the tab opened for it, else a new tab after the one shown.
  const open = (url: string, after: string | null = active?.id ?? null, behind = false) => {
    if (url === NEW_TAB_ASK) return show(null);
    if (url.startsWith(PIN_ASK)) return showPinned(url.slice(PIN_ASK.length));
    const there = findTabFor(normal, url);
    if (there) {
      if (behind) return;
      keysToTab(there, active?.id, report);
      return show(there.id);
    }
    const id = `t${next.current++}`;
    if (!behind) focusSoon(id);
    setTabs((prev) => insertAfter(prev, { id, url, openedFor: url, title: null, loading: true, nav: 0 }, after));
    if (!behind) show(id);
  };
  const close = (id: string) => {
    api.browserClose(id).catch(report);
    const after = nextAfterClose(normal, id);
    setTabs((prev) => prev.filter((t) => t.id !== id));
    if (id !== active?.id) return;
    show(after?.id ?? null);
    if (typing === "pane") keysToTab(after ?? null, undefined, report);
  };
  /// The previous (-1) or next (1) tab, wrapping: the pinned pages, then the others.
  const step = (delta: number) => {
    const order = [...pinnedPages().map((p) => p.id), ...normal.map((t) => t.id)];
    const at = active ? order.indexOf(active.id) : delta > 0 ? -1 : order.length;
    const to = order[(at + delta + order.length) % order.length];
    if (pinnedPages().some((p) => p.id === to)) return showPinned(to);
    keysToTab(tabs.find((t) => t.id === to) ?? null, active?.id, report);
    show(to);
  };
  const move = (id: string, to: string) =>
    setTabs((prev) => {
      const from = prev.findIndex((t) => t.id === id);
      const target = prev.findIndex((t) => t.id === to);
      if (from < 0 || target < 0) return prev;
      const moved = [...prev];
      moved.splice(target, 0, ...moved.splice(from, 1));
      return moved;
    });
  /// Pins tab `id` (dragged onto the pins): it becomes a pinned page, shown.
  const pin = (id: string) => {
    const tab = normal.find((t) => t.id === id);
    if (!tab || !/^https?:\/\//.test(tab.url)) return;
    const made = newPin(pinnedPages(), tab.url, tab.title);
    saveUserPins([...userPinsNow(), made]);
    setPinsVersion((n) => n + 1);
    close(id);
    showPinned(made.id);
  };
  /// Takes a page the user pinned off the pins (its page closes).
  const unpin = (id: string) => {
    saveUserPins(userPinsNow().filter((p) => p.id !== id));
    setPinsVersion((n) => n + 1);
    if (!tabs.some((t) => t.id === id)) return;
    api.browserClose(id).catch(report);
    setTabs((prev) => prev.filter((t) => t.id !== id));
    if (active?.id === id) show(null);
  };
  const setUrl = (id: string, url: string) => setTabs((prev) => prev.map((t) => (t.id === id && t.url !== url ? { ...t, url } : t)));

  // The handlers the listeners call, as they are now.
  const now = useRef({ open, close, step, setUrl, active });
  now.current = { open, close, step, setUrl, active };

  useEffect(() => {
    // What was asked before this page was up.
    api.browserWindowTake().then((urls) => urls.forEach((u) => now.current.open(u)), report);
    const update = (id: string, f: (t: BrowserTab) => BrowserTab) => setTabs((prev) => prev.map((t) => (t.id === id ? f(t) : t)));
    const offs = [
      listen<string>(BROWSER_WINDOW_OPEN_EVENT, ({ payload }) => now.current.open(payload)),
      listen<{ tab: string; url: string; loading: boolean }>(BROWSER_URL_EVENT, ({ payload }) => {
        const wish = payload.loading ? takeFocusWish(payload.tab) : null;
        if (wish) api.browserFocus(payload.tab, wish.input || undefined, wish.text).catch(report);
        if (!payload.loading) {
          tabUrls.set(payload.tab, payload.url);
          recordVisit(payload.url, null, true);
        }
        update(payload.tab, (t) => ({ ...t, url: payload.url, loading: payload.loading, translated: payload.loading ? false : t.translated }));
      }),
      listen<{ tab: string; url: string }>(BROWSER_ADDRESS_EVENT, ({ payload }) => now.current.setUrl(payload.tab, payload.url)),
      listen<{ tab: string; title: string }>(BROWSER_TITLE_EVENT, ({ payload }) => {
        const url = tabUrls.get(payload.tab);
        if (url) recordVisit(url, payload.title, false);
        update(payload.tab, (t) => ({ ...t, title: payload.title }));
      }),
      listen<{ tab: string; zoom: number }>(BROWSER_ZOOM_EVENT, ({ payload }) => update(payload.tab, (t) => ({ ...t, zoom: payload.zoom }))),
      listen<{ tab: string; on: boolean }>(BROWSER_TRANSLATED_EVENT, ({ payload }) => update(payload.tab, (t) => ({ ...t, translated: payload.on }))),
      // A page's link to a new window: a tab next to it.
      listen<{ url: string; tab: string; behind: boolean }>(BROWSER_NEW_TAB_EVENT, ({ payload }) => now.current.open(payload.url, payload.tab, payload.behind)),
      listen(BROWSER_OPEN_NEW_TAB_EVENT, () => now.current.open(NEW_TAB_ASK)),
      listen<{ tab: string; delta: number }>(BROWSER_SWITCH_TAB_EVENT, ({ payload }) => now.current.step(payload.delta)),
      listen<{ tab: string }>(BROWSER_CLOSE_TAB_EVENT, () => now.current.active && !now.current.active.pinned && now.current.close(now.current.active.id)),
      listen<PageDialogAsk>(PAGE_DIALOG_EVENT, ({ payload }) => setAsk(payload)),
      listen<{ tab: string }>(PAGE_FOCUSED_EVENT, () => {
        userActed();
        setTyping("pane");
      }),
      // ⌃h from a page: the tab list takes the keyboard.
      listen(FOCUS_APP_EVENT, () => {
        setTyping("app");
        noteFocusRequest();
        api.focusAppPage().catch(report);
      }),
    ];
    return () => offs.forEach((off) => off.then((f) => f()));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // This page's keys (the tab list's, the address bar's): ⌘T ⌘W ⌘⇧[ ⌘⇧] ⌃l.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      setTyping("app");
      const { open, close, step, active } = now.current;
      const hit: [boolean, () => void][] = [
        [matches(e, "newTab"), () => open(NEW_TAB_ASK)],
        [matches(e, "closeTab"), () => active && !active.pinned && close(active.id)],
        [matches(e, "prevTab"), () => step(-1)],
        [matches(e, "nextTab"), () => step(1)],
        [matches(e, "sidePane"), () => active && keysToTab(active, active.id, report)],
        // ⌘1–⌘6 (but ⌘4, this window): the main window, at that space.
        ...MAIN_SPACES.map(([action, space]): [boolean, () => void] => [matches(e, action), () => void api.mainWindowShow(space).catch(report)]),
      ];
      const found = hit.find(([yes]) => yes);
      if (!found) return;
      e.preventDefault();
      found[1]();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="browser-window" style={{ "--tab-list-w": `${listW}px` } as React.CSSProperties}>
      <div className="browser-window-bar">
        <button className="ghost small" title={`Shosai に戻る（${keyLabel(keyOf("spaceWork"))} で作業、${keyLabel(keyOf("spaceManage"))} で管理）`} onClick={() => api.mainWindowShow().catch(report)}>
          ← Shosai に戻る <span className="kbd">{keyLabel(keyOf("spaceManage"))}–{keyLabel(keyOf("spaceArtifacts"))}</span>
        </button>
      </div>
      {error && (
        <div className="error browser-window-error">
          <span className="grow">{error}</span>
          <button className="ghost small" onClick={() => setError(null)}>
            閉じる
          </button>
        </div>
      )}
      <BrowserSpace
        tabs={normal}
        active={active}
        covered={ask !== null}
        listKeys={typing === "app"}
        width={listW}
        report={report}
        onResize={setListW}
        onSelect={(id) => {
          keysToTab(tabs.find((t) => t.id === id) ?? null, active?.id, report);
          show(id);
        }}
        onStrip={() => active && keysToTab(active, active.id, report)}
        onPinned={showPinned}
        onPin={pin}
        onUnpin={unpin}
        // ⌘⇧A on a cloud session's page: the session archived, its tab closed.
        onArchive={() => {
          const id = active && cloudIdOfPage(active.url);
          if (!active || !id) return;
          api.archiveSessions([id]).then(() => close(active.id), report);
        }}
        onBookmark={() => active && api.browserBookmark(active.id).catch(report)}
        onClose={close}
        onNewTab={() => open(NEW_TAB_ASK)}
        onOpen={(url) => open(url)}
        onAddress={setUrl}
        onMove={move}
      />
      {ask && (
        <PageDialog
          ask={ask}
          onAnswer={(ok, text) => {
            api.answerPageDialog(ask.id, ok, text).catch(report);
            setAsk(null);
          }}
        />
      )}
    </div>
  );
}
