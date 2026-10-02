// Runs in every page of the browser pane, which has no browser chrome of its
// own: the app's keys work here too (⌘L the address bar, ⌘T ⌘W tabs, ⌘K the
// commands, ⌃h ⌃l the typing's side, ⌘[ ⌘] ⌘R the page, j k scrolling (and
// picking a Google result), as the user set them), right-click offers translation (WKWebView has no translate item),
// ⌥ + click keeps a link as an input todo, and X shows its bookmarks only.
// It runs in the page's frames too (a doc's editor on claude.ai is one), but
// there only passes the app's keys up to the page (FRAME): a frame must not
// navigate for them, which some pages (claude.ai's viewer) take as leaving.
(() => {
  if (window.__todoSessionsPage) return;
  window.__todoSessionsPage = true;
  const FRAME = window !== window.top;

  // X (Twitter) opens its bookmarks only, with the posts they lead to and
  // signing in; anything else (the timeline) goes back to the bookmarks.
  // Its pages move without loading, so the history calls are watched too.
  const X_HOSTS = /(^|\.)(x|twitter)\.com$/;
  const X_ALLOWED = /^\/(i\/bookmarks|i\/flow\/|login|logout|[^/]+\/status\/)/;
  const X_HOME = "https://x.com/i/bookmarks";
  if (!FRAME && X_HOSTS.test(location.hostname)) {
    const guard = () => X_ALLOWED.test(location.pathname) || location.replace(X_HOME);
    for (const name of ["pushState", "replaceState"]) {
      const original = history[name];
      history[name] = function (...args) {
        const result = original.apply(this, args);
        guard();
        return result;
      };
    }
    window.addEventListener("popstate", guard);
    guard();
  }

  // The app cancels these navigations and acts on them instead.
  const FOCUS_URL = "todo-sessions://focus-url";
  const NEW_TAB = "todo-sessions://new-tab";
  const PREV_TAB = "todo-sessions://tab-prev";
  const NEXT_TAB = "todo-sessions://tab-next";
  const ARCHIVE = "todo-sessions://archive";
  const TO_INPUT = "todo-sessions://to-input";
  const PALETTE = "todo-sessions://palette";
  const SESSIONS = "todo-sessions://sessions";
  const FOCUS_APP = "todo-sessions://focus-app";
  const FOCUS_PANE = "todo-sessions://focus-pane";
  const FOCUS_EXIT = "todo-sessions://focus-exit";
  const CLOSE_TAB = "todo-sessions://close-tab";
  const ADD_INPUT = "todo-sessions://add-input";
  const TRANSLATE_TEXT = "https://translate.google.com/?sl=auto&tl=ja&op=translate&text=";
  const TRANSLATE_PAGE = "https://translate.google.com/translate?sl=auto&tl=ja&u=";

  // The app's keys (keymap.ts), which the app sets on the page as
  // __todoSessionsKeys: action → "cmd+shift+[" and the like.
  const SHIFTED = { "{": "[", "}": "]" };
  const normal = (key) => {
    const k = key.length === 1 ? key.toLowerCase() : key;
    return SHIFTED[k] ?? k;
  };
  // A symbol typed with ⇧ (?) matches a key written without ⇧, unless another
  // key matches the ⇧ too: ⌘⇧[ comes as "[" with ⇧, and is not ⌘[.
  const is = (e, action) => {
    const keys = window.__todoSessionsKeys ?? {};
    if (!keys[action]) return false;
    return isCombo(e, keys[action], true) || (isCombo(e, keys[action], false) && !Object.values(keys).some((c) => isCombo(e, c, true)));
  };
  const isCombo = (e, combo, exact) => {
    const parts = combo.split("+");
    const key = parts.pop();
    // ⇧ only makes the symbol written (?), not another one (⇧[ is "{", not ⌘[).
    const symbol = !exact && key.length === 1 && !/[a-z0-9]/.test(key) && e.key === key;
    return (
      normal(e.key) === key &&
      e.metaKey === parts.includes("cmd") &&
      e.ctrlKey === parts.includes("ctrl") &&
      e.altKey === parts.includes("alt") &&
      (e.shiftKey === parts.includes("shift") || (symbol && !parts.includes("shift")))
    );
  };
  // What each key does here: the app's actions go to the app as navigations
  // it cancels; the page's own (back, forward, reload) happen here.
  const KEY_ACTIONS = [
    ["sideApp", () => (location.href = FOCUS_APP)],
    // With text selected, it goes along (the focus mode pastes it on the right).
    ["sidePane", (text) => {
      location.href = text ? `${FOCUS_PANE}?text=${encodeURIComponent(text)}` : FOCUS_PANE;
    }],
    ["palette", () => (location.href = PALETTE)],
    ["sessions", () => (location.href = SESSIONS)],
    ["focusUrl", () => (location.href = FOCUS_URL)],
    ["newTab", () => (location.href = NEW_TAB)],
    ["closeTab", () => (location.href = CLOSE_TAB)],
    ["prevTab", () => (location.href = PREV_TAB)],
    ["nextTab", () => (location.href = NEXT_TAB)],
    ["archive", () => (location.href = ARCHIVE)],
    ["toInput", () => (location.href = TO_INPUT)],
    ["back", () => history.back()],
    ["forward", () => history.forward()],
    ["reload", () => location.reload()],
  ];
  // A frame's history is not the page's.
  const PAGE_ONLY = ["back", "forward", "reload"];
  const FRAME_KEY = "__todoSessionsKey";
  // In the focus mode the app shows which side has the keyboard; a page (or
  // one of its frames) taking it says so.
  const FOCUSED = "todo-sessions://page-focused";
  const FRAME_FOCUSED = "focused";
  const tellFocused = () => window.__todoSessionsFocusMode && (location.href = FOCUSED);
  window.addEventListener("focus", () => (FRAME ? window.top.postMessage({ [FRAME_KEY]: FRAME_FOCUSED }, "*") : tellFocused()));

  window.addEventListener(
    "keydown",
    (e) => {
      // In the focus mode (the app sets the flag) Esc asks about leaving it.
      if (window.__todoSessionsFocusMode && e.key === "Escape" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        e.stopImmediatePropagation();
        location.href = FOCUS_EXIT;
        return;
      }
      // Ahead of the page's own keys (ChatGPT's ⌘K search, say).
      const hit = KEY_ACTIONS.find(([action]) => is(e, action) && !(FRAME && PAGE_ONLY.includes(action)));
      if (!hit) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      const text = String(getSelection() ?? "").trim();
      if (FRAME) window.top.postMessage({ [FRAME_KEY]: hit[0], text }, "*");
      else hit[1](text);
    },
    true,
  );
  // A frame's key, done here.
  window.addEventListener("message", (e) => {
    const action = e.data?.[FRAME_KEY];
    if (!FRAME && e.source !== window && action === FRAME_FOCUSED) return tellFocused();
    const hit = !FRAME && e.source !== window && KEY_ACTIONS.find(([a]) => a === action && !PAGE_ONLY.includes(a));
    if (hit) hit[1](typeof e.data.text === "string" ? e.data.text : "");
  });

  // The list keys (j k) scroll the page when no field has the typing, unless
  // the page took them itself (X's own j k, say). The page's scrolling box
  // is the one under the middle of the view, or the page itself.
  const SCROLL_STEP = 80;
  const editing = (el) => el instanceof Element && (el.isContentEditable || el.closest("input, textarea, select, [role=textbox]"));
  const scroller = () => {
    for (let el = document.elementFromPoint(innerWidth / 2, innerHeight / 2); el; el = el.parentElement) {
      const y = getComputedStyle(el).overflowY;
      if ((y === "auto" || y === "scroll") && el.scrollHeight > el.clientHeight) return el;
    }
    return document.scrollingElement ?? document.documentElement;
  };
  // On a Google results page they pick a result instead: it takes the focus,
  // so Enter opens it (⌘Enter in a new tab), as a link does.
  const GOOGLE = /(^|\.)google\.[a-z.]+$/;
  const PICKED = "todo-sessions-picked";
  const onResults = () => !FRAME && GOOGLE.test(location.hostname) && location.pathname === "/search";
  const results = () =>
    [...new Set([...document.querySelectorAll("#search a h3, #rso a h3, #center_col a h3")].map((h) => h.closest("a")))].filter((a) => a && a.offsetParent !== null);
  const pickResult = (dir, smooth) => {
    const list = results();
    if (list.length === 0) return false;
    if (!document.getElementById(PICKED)) {
      const style = document.createElement("style");
      style.id = PICKED;
      style.textContent = `.${PICKED} { outline: 2px solid #5e6ad2 !important; outline-offset: 6px; border-radius: 6px; }`;
      document.head.appendChild(style);
    }
    const at = list.findIndex((a) => a.classList.contains(PICKED));
    const next = list[at === -1 ? (dir > 0 ? 0 : list.length - 1) : Math.min(Math.max(at + dir, 0), list.length - 1)];
    list.forEach((a) => a.classList.toggle(PICKED, a === next));
    next.focus({ preventScroll: true });
    next.scrollIntoView({ block: "center", behavior: smooth ? "smooth" : "auto" });
    return true;
  };
  const listDir = (e) =>
    e.isComposing || e.keyCode === 229 || editing(e.target) || editing(document.activeElement) ? 0 : is(e, "down") ? 1 : is(e, "up") ? -1 : 0;
  // Ahead of Google's own keys (a letter typed anywhere goes to its search box).
  window.addEventListener(
    "keydown",
    (e) => {
      const dir = onResults() ? listDir(e) : 0;
      if (!dir || !pickResult(dir, !e.repeat)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
    },
    true,
  );
  window.addEventListener("keydown", (e) => {
    const dir = e.defaultPrevented ? 0 : listDir(e);
    if (!dir) return;
    e.preventDefault();
    scroller().scrollBy({ top: dir * SCROLL_STEP, behavior: e.repeat ? "auto" : "smooth" });
  });

  if (FRAME) return;

  // The app asks a page (ChatGPT's) to take the typing: its prompt box, once
  // the page has drawn it, with `text` typed into it when given.
  const INPUT = '#prompt-textarea, [contenteditable="true"], textarea, input[type="text"], input:not([type])';
  const INPUT_WAIT_MS = 10000;
  const INPUT_RETRY_MS = 200;
  window.__todoSessionsFocusInput = (text) => {
    const until = Date.now() + INPUT_WAIT_MS;
    const tryFocus = () => {
      const el = document.querySelector(INPUT);
      if (!el) {
        if (Date.now() < until) setTimeout(tryFocus, INPUT_RETRY_MS);
        return;
      }
      el.focus();
      // As typing, so the page's editor (ChatGPT's) takes it.
      if (text) document.execCommand("insertText", false, text);
    };
    tryFocus();
  };

  // ⌥ + click keeps the link as an input instead of following it.
  window.addEventListener(
    "click",
    (e) => {
      const link = e.target instanceof Element ? e.target.closest("a[href]") : null;
      if (!e.altKey || e.metaKey || e.ctrlKey || !link || !/^https?:/.test(link.href)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      const text = (link.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 120);
      location.href = `${ADD_INPUT}?u=${encodeURIComponent(link.href)}&t=${encodeURIComponent(text || link.href)}`;
    },
    true,
  );

  let menu = null;
  const close = () => {
    menu?.remove();
    menu = null;
  };

  // The menu lives in a shadow root so the page's styles cannot reach it.
  const show = (x, y, items) => {
    close();
    menu = document.createElement("div");
    const root = menu.attachShadow({ mode: "closed" });
    root.innerHTML = `<style>
      .m { position: fixed; z-index: 2147483647; min-width: 220px; padding: 4px; border-radius: 8px;
           background: rgba(30, 31, 35, 0.97); border: 1px solid rgba(255, 255, 255, 0.12);
           box-shadow: 0 12px 32px rgba(0, 0, 0, 0.45); font: 13px -apple-system, "Hiragino Sans", sans-serif; }
      button { display: block; width: 100%; padding: 6px 10px; border: 0; border-radius: 5px; background: none;
               color: #e8e9ec; font: inherit; text-align: left; cursor: pointer; }
      button:hover, button:focus-visible { background: #5e6ad2; color: #fff; outline: none; }
      .hint { padding: 4px 10px 2px; color: #8b8e96; font-size: 11px; }
    </style><div class="m" role="menu"></div>`;
    const box = root.querySelector(".m");
    for (const [label, run] of items) {
      const b = document.createElement("button");
      b.setAttribute("role", "menuitem");
      b.textContent = label;
      b.addEventListener("click", () => {
        close();
        run();
      });
      box.appendChild(b);
    }
    const hint = document.createElement("div");
    hint.className = "hint";
    hint.textContent = "⌥ + 右クリックで標準のメニュー";
    box.appendChild(hint);
    document.documentElement.appendChild(menu);
    const r = box.getBoundingClientRect();
    box.style.left = `${Math.min(x, innerWidth - r.width - 4)}px`;
    box.style.top = `${Math.min(y, innerHeight - r.height - 4)}px`;
    box.querySelector("button")?.focus();
  };

  window.addEventListener(
    "contextmenu",
    (e) => {
      if (e.altKey) return;
      e.preventDefault();
      const text = String(getSelection() ?? "").trim();
      const link = e.target instanceof Element ? e.target.closest("a[href]") : null;
      const items = [];
      if (text) {
        items.push(["選択したテキストを翻訳", () => window.open(TRANSLATE_TEXT + encodeURIComponent(text))]);
        items.push(["コピー", () => document.execCommand("copy")]);
      }
      items.push(["このページを翻訳", () => window.open(TRANSLATE_PAGE + encodeURIComponent(location.href))]);
      if (link) items.push(["リンクを新しいタブで開く", () => window.open(link.href)]);
      items.push(["再読み込み", () => location.reload()]);
      show(e.clientX, e.clientY, items);
    },
    true,
  );
  window.addEventListener("mousedown", (e) => menu && !e.composedPath().includes(menu) && close(), true);
  window.addEventListener("keydown", (e) => e.key === "Escape" && close(), true);
  window.addEventListener("scroll", close, true);
  window.addEventListener("blur", close);
})();
