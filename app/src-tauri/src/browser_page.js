// Runs in every page of the browser pane, which has no browser chrome of its
// own: the app's keys work here too (⌘L the address bar, ⌘T ⌘W tabs, ⌘K the
// commands, ⌃h ⌃l the typing's side, ⌘[ ⌘] ⌘R the page, as the user set
// them), right-click offers translation (WKWebView has no translate item),
// and X shows its bookmarks only.
(() => {
  if (window.__todoSessionsPage) return;
  window.__todoSessionsPage = true;

  // X (Twitter) opens its bookmarks only, with the posts they lead to and
  // signing in; anything else (the timeline) goes back to the bookmarks.
  // Its pages move without loading, so the history calls are watched too.
  const X_HOSTS = /(^|\.)(x|twitter)\.com$/;
  const X_ALLOWED = /^\/(i\/bookmarks|i\/flow\/|login|logout|[^/]+\/status\/)/;
  const X_HOME = "https://x.com/i/bookmarks";
  if (X_HOSTS.test(location.hostname)) {
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
  const PALETTE = "todo-sessions://palette";
  const FOCUS_APP = "todo-sessions://focus-app";
  const FOCUS_PANE = "todo-sessions://focus-pane";
  const FOCUS_EXIT = "todo-sessions://focus-exit";
  const CLOSE_TAB = "todo-sessions://close-tab";
  const FOCUS_LINK = "todo-sessions://focus-link?u=";
  const TRANSLATE_TEXT = "https://translate.google.com/?sl=auto&tl=ja&op=translate&text=";
  const TRANSLATE_PAGE = "https://translate.google.com/translate?sl=auto&tl=ja&u=";

  // The app's keys (keymap.ts), which the app sets on the page as
  // __todoSessionsKeys: action → "cmd+shift+[" and the like.
  const SHIFTED = { "{": "[", "}": "]" };
  const normal = (key) => {
    const k = key.length === 1 ? key.toLowerCase() : key;
    return SHIFTED[k] ?? k;
  };
  const is = (e, action) => {
    const combo = (window.__todoSessionsKeys ?? {})[action];
    if (!combo) return false;
    const parts = combo.split("+");
    const key = parts.pop();
    const symbol = key.length === 1 && !/[a-z0-9]/.test(key);
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
    ["sidePane", () => (location.href = FOCUS_PANE)],
    ["palette", () => (location.href = PALETTE)],
    ["focusUrl", () => (location.href = FOCUS_URL)],
    ["newTab", () => (location.href = NEW_TAB)],
    ["closeTab", () => (location.href = CLOSE_TAB)],
    ["prevTab", () => (location.href = PREV_TAB)],
    ["nextTab", () => (location.href = NEXT_TAB)],
    ["archive", () => (location.href = ARCHIVE)],
    ["back", () => history.back()],
    ["forward", () => history.forward()],
    ["reload", () => location.reload()],
  ];

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
      const hit = KEY_ACTIONS.find(([action]) => is(e, action));
      if (!hit) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      hit[1]();
    },
    true,
  );

  // The app asks a page (ChatGPT's) to take the typing: its prompt box, once
  // the page has drawn it.
  const INPUT = '#prompt-textarea, [contenteditable="true"], textarea, input[type="text"], input:not([type])';
  const INPUT_WAIT_MS = 10000;
  const INPUT_RETRY_MS = 200;
  window.__todoSessionsFocusInput = () => {
    const until = Date.now() + INPUT_WAIT_MS;
    const tryFocus = () => {
      const el = document.querySelector(INPUT);
      if (el) el.focus();
      else if (Date.now() < until) setTimeout(tryFocus, INPUT_RETRY_MS);
    };
    tryFocus();
  };

  // In the focus mode the app sets __todoSessionsAllow, the addresses this
  // page may go to (as prefixes); a link to anything else asks the app first.
  const guardLink = (e) => {
    const allow = window.__todoSessionsAllow;
    const a = allow && e.target instanceof Element ? e.target.closest("a[href]") : null;
    if (!a || !/^https?:/.test(a.href) || allow.some((p) => a.href.startsWith(p))) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    location.href = FOCUS_LINK + encodeURIComponent(a.href);
  };
  window.addEventListener("click", guardLink, true);
  window.addEventListener("auxclick", guardLink, true);

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
