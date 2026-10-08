// Runs in every page of the browser pane, which has no browser chrome of its
// own: the app's keys work here too (⌘L the address bar, ⌘T ⌘W tabs, ⌘K the
// commands, ⌃h ⌃l the typing's side, ⌘[ ⌘] ⌘R the page, j k scrolling (and
// picking a Google result), as the user set them), right-click offers translation (a Chromium view has no translate item),
// and ⌥ + click keeps a link as an input todo.
// It runs in the page's frames too (a doc's editor on claude.ai is one), which
// get the app's keys as the page does and tell the app themselves (FRAME), but
// for the page's own history keys.
// The helper binary (bin/helper.rs) runs this as each page's context is made.
(() => {
  if (window.__todoSessionsPage) return;
  window.__todoSessionsPage = true;
  const FRAME = window !== window.top;

  // The app hears a page through the console: a message that is one of these
  // URLs (todo-sessions://...) is acted on, and kept out of the console.
  // The console as it is now, before the page can change it.
  const tell = console.debug.bind(console);
  // This run's token (the helper puts it in; see cef_browser.rs's page_token):
  // the app acts only on messages that carry it, which the page's own scripts
  // cannot read, so they cannot pass themselves off as this script.
  const TOKEN = "__TODO_SESSIONS_TOKEN__";
  const send = (url) => tell(url.replace(/^(todo-sessions:\/\/[^/?]+)/, `$1/${TOKEN}`));
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
  const NEW_TODO = "todo-sessions://new-todo";
  const ZOOM_IN = "todo-sessions://zoom-in";
  const ZOOM_OUT = "todo-sessions://zoom-out";
  const ZOOM_RESET = "todo-sessions://zoom-reset";
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
  // What each key does here: the app's actions go to the app as messages
  // on the console (see `send`); the page's own (back, forward, reload) happen here.
  const KEY_ACTIONS = [
    ["sideApp", () => send(FOCUS_APP)],
    // With text selected, it goes along (the focus mode pastes it on the right).
    ["sidePane", (text) => {
      send(text ? `${FOCUS_PANE}?text=${encodeURIComponent(text)}` : FOCUS_PANE);
    }],
    ["palette", () => send(PALETTE)],
    ["sessions", () => send(SESSIONS)],
    ["focusUrl", () => send(FOCUS_URL)],
    ["newTab", () => send(NEW_TAB)],
    ["newTodo", () => send(NEW_TODO)],
    ["closeTab", () => send(CLOSE_TAB)],
    ["prevTab", () => send(PREV_TAB)],
    ["nextTab", () => send(NEXT_TAB)],
    ["archive", () => send(ARCHIVE)],
    ["toInput", () => send(TO_INPUT)],
    ["zoomIn", () => send(ZOOM_IN)],
    ["zoomOut", () => send(ZOOM_OUT)],
    ["zoomReset", () => send(ZOOM_RESET)],
    ["back", () => history.back()],
    ["forward", () => history.forward()],
    ["reload", () => location.reload()],
  ];
  // A frame's history is not the page's; and a frame (another site's, an
  // artifact's) does not archive the session the page shows.
  const PAGE_ONLY = ["back", "forward", "reload", "archive"];
  // ⌘⇧A archives the Cloud session a claude.ai page shows; elsewhere the key is the page's.
  const SESSION_PAGE = /^https:\/\/claude\.ai\/code\/session_/;
  const appliesHere = (action) => action !== "archive" || SESSION_PAGE.test(location.href);
  // In the focus mode the app shows which side has the keyboard; a page (or
  // one of its frames) taking it says so.
  const FOCUSED = "todo-sessions://page-focused";
  window.addEventListener("focus", () => window.__todoSessionsFocusMode && send(FOCUSED));

  window.addEventListener(
    "keydown",
    (e) => {
      // In the focus mode (the app sets the flag) Esc asks about leaving it.
      if (window.__todoSessionsFocusMode && e.key === "Escape" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        e.stopImmediatePropagation();
        send(FOCUS_EXIT);
        return;
      }
      // Ahead of the page's own keys (ChatGPT's ⌘K search, say).
      const hit = KEY_ACTIONS.find(([action]) => is(e, action) && appliesHere(action) && !(FRAME && PAGE_ONLY.includes(action)));
      if (!hit) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      hit[1](String(getSelection() ?? "").trim());
    },
    true,
  );

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

  // Logins: one a form sends is offered to the app to keep (in the Keychain,
  // asked first; the app ignores the one it keeps), and a kept one is filled
  // in and sent as the app asks (__todoSessionsFill). Sites asking for the
  // user and the password in steps of their own (OneLogin) are followed
  // through the steps.
  const LOGIN_CAPTURED = "todo-sessions://login-captured";
  const USER_FIELDS =
    'input[type=email], input[autocomplete~=username], input[name*=user i], input[name*=email i], input[name*=login i], input[id*=user i], input[id*=email i]';
  const shown = (el) => el && el.offsetParent !== null && !el.disabled && !el.readOnly;
  const userField = () => [...document.querySelectorAll(USER_FIELDS)].find((el) => shown(el) && el.type !== "password" && el.type !== "hidden");
  const passField = () => [...document.querySelectorAll("input[type=password]")].find(shown);
  /// The user typed in a step before the password's.
  const LOGIN_USER_KEY = "__todoSessionsLoginUser";
  /// The user a site remembers, kept in a hidden field beside the password (OneLogin's).
  const hiddenUser = () => [...document.querySelectorAll(USER_FIELDS)].find((el) => el.type !== "password" && el.value)?.value;
  const offerLogin = () => {
    const user = userField()?.value;
    if (user) sessionStorage.setItem(LOGIN_USER_KEY, user);
    const pass = passField()?.value;
    const who = user || sessionStorage.getItem(LOGIN_USER_KEY) || hiddenUser();
    if (!pass || !who) return;
    send(`${LOGIN_CAPTURED}?u=${encodeURIComponent(who)}&p=${encodeURIComponent(pass)}`);
  };
  window.addEventListener("submit", offerLogin, true);
  window.addEventListener(
    "keydown",
    (e) => e.key === "Enter" && !e.isComposing && e.target instanceof HTMLInputElement && (e.target.type === "password" || e.target === userField()) && offerLogin(),
    true,
  );
  window.addEventListener("click", (e) => e.target instanceof Element && e.target.closest('button, input[type=submit], [role=button]') && (passField() || userField()) && offerLogin(), true);

  const LOGIN_SENT_KEY = "__todoSessionsLoginSent";
  /// A login sent again this soon (the site asking once more: a wrong password) is only filled in.
  const RESEND_AFTER_MS = 60000;
  const FILL_EVERY_MS = 400;
  const FILL_FOR_MS = 30000;
  /// As typing would: the page's own handlers (React's) see it.
  const type = (el, value) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  };
  const sendFrom = (el) => {
    const scope = el.form ?? document;
    const button = [...scope.querySelectorAll('button[type=submit], input[type=submit], button:not([type])')].find(shown);
    if (button) button.click();
    else if (el.form) el.form.requestSubmit();
  };
  window.__todoSessionsFill = (host, user, password) => {
    if (location.hostname !== host) return;
    const resent = Date.now() - Number(sessionStorage.getItem(LOGIN_SENT_KEY) || 0) < RESEND_AFTER_MS;
    let userDone = false;
    let passDone = false;
    const fill = () => {
      const p = passField();
      const u = userField();
      if (p && !passDone) {
        passDone = true;
        if (u && !u.value) type(u, user);
        if (!p.value) type(p, password);
        if (!resent) {
          sessionStorage.setItem(LOGIN_SENT_KEY, String(Date.now()));
          setTimeout(() => sendFrom(p), FILL_EVERY_MS);
        }
      } else if (u && !p && !userDone && !u.value) {
        userDone = true;
        type(u, user);
        if (!resent) setTimeout(() => sendFrom(u), FILL_EVERY_MS);
      }
    };
    fill();
    const timer = setInterval(fill, FILL_EVERY_MS);
    setTimeout(() => clearInterval(timer), FILL_FOR_MS);
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
      send(`${ADD_INPUT}?u=${encodeURIComponent(link.href)}&t=${encodeURIComponent(text || link.href)}`);
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
