// Runs in every page of the browser pane, which has no browser chrome of its
// own: ⌘L moves to the app's address bar, ⌘T opens a new tab, ⌘R reloads,
// ⌘[ ⌘] go back and forward, ⌘⇧[ ⌘⇧] switch tabs, and right-click offers
// translation (WKWebView has no translate item).
(() => {
  if (window.__todoSessionsPage) return;
  window.__todoSessionsPage = true;

  // The app cancels these navigations and acts on them instead.
  const FOCUS_URL = "todo-sessions://focus-url";
  const NEW_TAB = "todo-sessions://new-tab";
  const PREV_TAB = "todo-sessions://tab-prev";
  const NEXT_TAB = "todo-sessions://tab-next";
  const TRANSLATE_TEXT = "https://translate.google.com/?sl=auto&tl=ja&op=translate&text=";
  const TRANSLATE_PAGE = "https://translate.google.com/translate?sl=auto&tl=ja&u=";

  window.addEventListener(
    "keydown",
    (e) => {
      if (!e.metaKey || e.altKey || e.ctrlKey) return;
      // With ⇧ a JIS or US keyboard gives { and } for the bracket keys.
      const back = e.key === "[" || e.key === "{";
      const forward = e.key === "]" || e.key === "}";
      if (back || forward) {
        e.preventDefault();
        e.stopPropagation();
        if (e.shiftKey) location.href = back ? PREV_TAB : NEXT_TAB;
        else if (back) history.back();
        else history.forward();
        return;
      }
      if (e.shiftKey) return;
      const key = e.key.toLowerCase();
      if (key === "r") {
        e.preventDefault();
        location.reload();
      } else if (key === "l" || key === "t") {
        e.preventDefault();
        e.stopPropagation();
        location.href = key === "l" ? FOCUS_URL : NEW_TAB;
      }
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
