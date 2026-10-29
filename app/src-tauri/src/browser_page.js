// Runs in every page of the browser pane, which has no browser chrome of its
// own: the app's keys work here too (⌘L the address bar, ⌘T ⌘W tabs, ⌘K the
// commands, ⌃h ⌃l the typing's side, ⌘[ ⌘] ⌘R the page, j k scrolling (and
// picking a Google result), as the user set them), the page translates where it is (Claude, through the app),
// and what is worth reading is kept (読みもの): the page (⌘⇧D; an O'Reilly
// book's page as the book, with its contents), a link ⌥-clicked, a post
// bookmarked on X. A book's chapter read to its end is marked read. Posts on
// X's home timeline not about engineering fold away (Jev, through the app).
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
  const PALETTE = "todo-sessions://palette";
  const SESSIONS = "todo-sessions://sessions";
  const FOCUS_APP = "todo-sessions://focus-app";
  const FOCUS_PANE = "todo-sessions://focus-pane";
  const SPACE = "todo-sessions://space";
  const CLOSE_TAB = "todo-sessions://close-tab";
  const WORK_RIGHT = "todo-sessions://work-right";
  const BOOKMARK = "todo-sessions://bookmark";
  const ASK_CHATGPT = "todo-sessions://ask-chatgpt";
  const CHAPTER_READ = "todo-sessions://chapter-read";
  const X_POST = "todo-sessions://x-post";
  const X_VIDEO = "todo-sessions://x-video";
  const X_VIDEO_HIDE = "todo-sessions://x-video-hide";
  const X_VIDEO_AHEAD = "todo-sessions://x-video-ahead";
  const NEW_TODO = "todo-sessions://new-todo";
  const ZOOM_IN = "todo-sessions://zoom-in";
  const ZOOM_OUT = "todo-sessions://zoom-out";
  const ZOOM_RESET = "todo-sessions://zoom-reset";
  const TRANSLATE = "todo-sessions://translate";
  const OPEN_OUTSIDE = "todo-sessions://open-outside";
  const TRANSLATED = "todo-sessions://translated";
  const TRANSLATE_SELECTION = "todo-sessions://translate-selection";
  const PAGE_LINKS = "todo-sessions://page-links";

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
  // The links the view shows (⌘⇧L, as a terminal's), in the page's order,
  // each once, with their text, for the app to offer in ⌘K's box.
  const MAX_LINKS = 200;
  const LINK_TEXT_MAX = 120;
  const shownLinks = () => {
    const links = new Map();
    for (const a of document.querySelectorAll("a[href]")) {
      if (links.size >= MAX_LINKS) break;
      if (!/^https?:/.test(a.href) || links.has(a.href)) continue;
      const r = a.getBoundingClientRect();
      if (r.width === 0 || r.height === 0 || r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) continue;
      const text = (a.innerText || a.getAttribute("aria-label") || a.title || "").replace(/\s+/g, " ").trim().slice(0, LINK_TEXT_MAX);
      links.set(a.href, { url: a.href, text: text || undefined });
    }
    return [...links.values()];
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
    ["spaceManage", () => send(`${SPACE}?s=manage`)],
    ["spaceWork", () => send(`${SPACE}?s=work`)],
    ["spaceStudy", () => send(`${SPACE}?s=study`)],
    ["spaceBrowser", () => send(`${SPACE}?s=browser`)],
    ["spaceSlack", () => send(`${SPACE}?s=slack`)],
    ["spaceArtifacts", () => send(`${SPACE}?s=artifacts`)],
    ["sessions", () => send(SESSIONS)],
    ["focusUrl", () => send(FOCUS_URL)],
    ["terminalLinks", () => send(`${PAGE_LINKS}?l=${encodeURIComponent(JSON.stringify(shownLinks()))}`)],
    ["newTab", () => send(NEW_TAB)],
    ["newTodo", () => send(NEW_TODO)],
    ["closeTab", () => send(CLOSE_TAB)],
    ["workRight", () => send(WORK_RIGHT)],
    ["prevTab", () => send(PREV_TAB)],
    ["nextTab", () => send(NEXT_TAB)],
    ["archive", () => send(ARCHIVE)],
    ["bookmark", () => window.__todoSessionsBookmark?.()],
    ["studyThis", () => window.__todoSessionsBookmark?.(true)],
    ["askChatGpt", (selected) => window.__todoSessionsAskChatgpt?.(selected)],
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
  // In a split view (作業・学習) the app shows which side has the keyboard; a
  // page (or one of its frames) taking it says so.
  const FOCUSED = "todo-sessions://page-focused";
  // The browser's own window marks it always, so it is said always.
  window.addEventListener("focus", () => send(FOCUSED));

  window.addEventListener(
    "keydown",
    (e) => {
      // Ahead of the page's own keys (ChatGPT's ⌘K search, say).
      const hit = KEY_ACTIONS.find(([action]) => is(e, action) && appliesHere(action) && !(FRAME && PAGE_ONLY.includes(action)));
      if (!hit) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      hit[1](String(getSelection() ?? "").trim());
    },
    true,
  );

  // ⇧j ⇧k scroll the page when no field has the typing, unless the page took
  // them itself; j k pick (a Google result), else are the page's own (X's j k).
  // The page's scrolling box is the one under the middle of the view, or the page itself.
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
  const typingHere = (e) => e.isComposing || e.keyCode === 229 || editing(e.target) || editing(document.activeElement);
  const listDir = (e) => (typingHere(e) ? 0 : is(e, "down") ? 1 : is(e, "up") ? -1 : 0);
  const scrollDir = (e) => (typingHere(e) ? 0 : is(e, "scrollDown") ? 1 : is(e, "scrollUp") ? -1 : 0);
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
    const dir = e.defaultPrevented ? 0 : scrollDir(e);
    if (!dir) return;
    e.preventDefault();
    scroller().scrollBy({ top: dir * SCROLL_STEP, behavior: e.repeat ? "auto" : "smooth" });
  });

  if (FRAME) return;

  // The app asks a page (ChatGPT's, Claude's, NotebookLM's) to take the
  // typing: its prompt box, once the page has drawn it, with `text` typed
  // into it when given. The first kind shown wins, not the first in the page
  // (Claude's sidebar has a search field ahead of its prompt box).
  const INPUTS = ['#prompt-textarea', '[contenteditable="true"][role="textbox"]', '[contenteditable="true"]', "textarea", 'input[type="text"]', "input:not([type])"];
  const INPUT_WAIT_MS = 10000;
  const INPUT_RETRY_MS = 200;
  const drawn = (el) => el.getClientRects().length > 0;
  window.__todoSessionsFocusInput = (text) => {
    const until = Date.now() + INPUT_WAIT_MS;
    const tryFocus = () => {
      const el = INPUTS.flatMap((kind) => [...document.querySelectorAll(kind)]).find(drawn);
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
  const passField = () => [...document.querySelectorAll("input[type=password]")].find(drawn);
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
    const button = [...scope.querySelectorAll('button[type=submit], input[type=submit], button:not([type])')].find(drawn);
    if (button) button.click();
    else if (el.form) el.form.requestSubmit();
  };
  // `site` is the page's host with its port, as the app keeps logins.
  window.__todoSessionsFill = (site, user, password) => {
    if (location.host !== site) return;
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

  // Readings (読みもの) the app keeps: a kind (article, post, book), the page,
  // its title, what it says (for its tags) and a book's chapters ([title, page]).
  const TEXT_MAX = 2000;
  const TITLE_MAX = 120;
  const enc = encodeURIComponent;
  const oneLine = (text) => (text ?? "").trim().replace(/\s+/g, " ");
  const keep = (kind, url, title, text, chapters, links, study) =>
    send(
      `${BOOKMARK}?${study ? "s=1&" : ""}k=${kind}&u=${enc(url)}&t=${enc(title || url)}&x=${enc((text ?? "").slice(0, TEXT_MAX))}${chapters ? `&c=${enc(JSON.stringify(chapters))}` : ""}${links?.length ? `&l=${enc(JSON.stringify(links))}` : ""}`,
    );
  const meta = (name) => document.querySelector(`meta[property="${name}"], meta[name="${name}"]`)?.content?.trim() ?? "";
  // An O'Reilly book's pages are under its own (…/library/view/<book>/<isbn>/).
  const OREILLY_BOOK = /^https:\/\/learning\.oreilly\.com\/library\/view\/[^/]+\/[^/]+\//;
  const X_HOST = /(^|\.)(x|twitter)\.com$/;
  const X_STATUS = /^\/([^/]+)\/status\/\d+/;
  /// A post on X: its own page, its author, its text and the links in it
  /// (its text's and its card's; X gives them as t.co, the app follows them).
  const POST_LINKS = '[data-testid="tweetText"] a[href^="https://t.co/"], [data-testid="card.wrapper"] a[href]';
  const linksOf = (post) => [...new Set([...(post?.querySelectorAll(POST_LINKS) ?? [])].map((a) => a.href))];
  const keepPost = (url, user, text, post, study) => keep("post", url, `@${user}: ${oneLine(text).slice(0, TITLE_MAX) || url}`, text, null, linksOf(post), study);
  // ⌘⇧D (here, or from the app's side): the page shown; ⌘⇧S (`study`) also
  // reads it in 学習. A book's page keeps the book with the chapters it links
  // to (its table of contents).
  window.__todoSessionsBookmark = (study = false) => {
    const book = location.href.match(OREILLY_BOOK);
    if (book) {
      const root = book[0];
      const seen = new Set();
      const chapters = [];
      for (const a of document.querySelectorAll("a[href]")) {
        const url = a.href.split("#")[0];
        const title = oneLine(a.textContent);
        if (!url.startsWith(root) || !/\.x?html$/.test(url) || !title || seen.has(url)) continue;
        seen.add(url);
        chapters.push([title, url]);
      }
      return keep("book", root, meta("og:title") || document.title.split("|").pop().trim(), meta("og:description") || meta("description"), chapters, null, study);
    }
    const status = X_HOST.test(location.hostname) && location.pathname.match(X_STATUS);
    if (status) return keepPost(location.href.split("?")[0], status[1], document.querySelector('article [data-testid="tweetText"]')?.innerText, document.querySelector("article"), study);
    keep("article", location.href, document.title, meta("og:description") || meta("description"), null, null, study);
  };
  // ⌘⇧G (here, or from the app's side): the page (or what is selected in it)
  // goes to the app, for ChatGPT on the right to explain.
  const ASK_TEXT_MAX = 6000;
  window.__todoSessionsAskChatgpt = (selected) => {
    const text = (selected || document.body?.innerText || "").replace(/\n{3,}/g, "\n\n").slice(0, ASK_TEXT_MAX);
    send(`${ASK_CHATGPT}?u=${enc(location.href)}&t=${enc(document.title)}&s=${selected ? 1 : 0}&x=${enc(text)}`);
  };
  // In ChatGPT's page: `text` typed into its prompt box and sent (its send
  // button, once it takes it; left typed if the button never comes).
  const SEND_BUTTON = 'button[data-testid="send-button"], #composer-submit-button';
  const SEND_WAIT_MS = 5000;
  window.__todoSessionsAsk = (text) => {
    window.__todoSessionsFocusInput(text);
    const until = Date.now() + INPUT_WAIT_MS + SEND_WAIT_MS;
    const trySend = () => {
      const button = document.querySelector(SEND_BUTTON);
      if (button && !button.disabled && document.querySelector(INPUTS[0])?.textContent?.trim()) return button.click();
      if (Date.now() < until) setTimeout(trySend, INPUT_RETRY_MS);
    };
    setTimeout(trySend, INPUT_RETRY_MS);
  };
  // ⌥ + click keeps the link to read instead of following it.
  window.addEventListener(
    "click",
    (e) => {
      const link = e.target instanceof Element ? e.target.closest("a[href]") : null;
      if (!e.altKey || e.metaKey || e.ctrlKey || !link || !/^https?:/.test(link.href)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      keep("article", link.href, oneLine(link.textContent).slice(0, TITLE_MAX));
    },
    true,
  );
  // X's own bookmark button keeps the post here too (X bookmarks it as well).
  window.addEventListener(
    "click",
    (e) => {
      if (!X_HOST.test(location.hostname)) return;
      const button = e.target instanceof Element ? e.target.closest('[data-testid="bookmark"]') : null;
      const post = button?.closest("article");
      const link = post && [...post.querySelectorAll('a[href*="/status/"]')].find((a) => a.querySelector("time"));
      const status = link?.pathname.match(X_STATUS);
      if (!status) return;
      keepPost(link.href.split("?")[0], status[1], post.querySelector('[data-testid="tweetText"]')?.innerText, post);
    },
    true,
  );
  // X's videos (and GIFs) are H.264, which this browser cannot play: the app
  // lays a player that can (x_video.rs) over the one nearest the middle of
  // the view once the scrolling stops, and moves it with the page as it
  // scrolls, until it leaves the view. The videos coming are found ahead.
  const VIDEO_PLAYER = '[data-testid="videoPlayer"]';
  const VIDEO_SETTLE_MS = 250;
  const VIDEO_CHECK_MS = 150;
  let videoSent = X_VIDEO_HIDE;
  let playing = null;
  let lastScroll = 0;
  let following = false;
  const videosAhead = new Set();
  const tellVideo = (message) => {
    if (message === videoSent) return;
    videoSent = message;
    send(message);
  };
  const videoIdOf = (player) => {
    const post = player.closest("article");
    return (post && postIdOf(post)) ?? location.pathname.match(/\/status\/(\d+)/)?.[1];
  };
  // The bottom of what stays at the top of the page over the video (X's header).
  const headerBottom = (r) => {
    for (let e = document.elementFromPoint(r.x + r.width / 2, 1); e && e !== document.body; e = e.parentElement) {
      if (/sticky|fixed/.test(getComputedStyle(e).position)) return Math.max(0, e.getBoundingClientRect().bottom);
    }
    return 0;
  };
  const videoAt = (id, player) => {
    const r = player.getBoundingClientRect();
    const top = headerBottom(r);
    if (r.bottom <= top || r.top >= innerHeight) return null;
    return `${X_VIDEO}?i=${id}&x=${r.x}&y=${r.y}&w=${r.width}&h=${r.height}&vw=${innerWidth}&t=${top}`;
  };
  // As the page scrolls: the player with its video (X reuses a post's cell for another).
  const followVideo = () => {
    following = false;
    const message = playing && videoIdOf(playing.player) === playing.id && videoAt(playing.id, playing.player);
    if (!message) playing = null;
    tellVideo(message || X_VIDEO_HIDE);
  };
  const videoMoved = () => {
    lastScroll = Date.now();
    if (!following) {
      following = true;
      requestAnimationFrame(followVideo);
    }
  };
  // Once settled: the video nearest the middle; and the ones in view or next, found ahead.
  const checkVideos = () => {
    let nearest = null;
    let distance = Infinity;
    for (const player of document.querySelectorAll(VIDEO_PLAYER)) {
      const r = player.getBoundingClientRect();
      if (!r.width || r.top > innerHeight * 2 || r.bottom < 0) continue;
      const id = videoIdOf(player);
      if (id && !videosAhead.has(id)) {
        videosAhead.add(id);
        send(`${X_VIDEO_AHEAD}?i=${id}`);
      }
      const d = Math.abs((r.top + r.bottom) / 2 - innerHeight / 2);
      if (id && r.top < innerHeight && d < distance) [nearest, distance] = [{ id, player }, d];
    }
    if (Date.now() - lastScroll < VIDEO_SETTLE_MS) return;
    const message = nearest && videoAt(nearest.id, nearest.player);
    playing = message ? nearest : null;
    tellVideo(message || X_VIDEO_HIDE);
  };
  if (!FRAME && X_HOST.test(location.hostname)) {
    window.addEventListener("scroll", videoMoved, { capture: true, passive: true });
    window.addEventListener("resize", videoMoved);
    // Checked over and over: X's posts come in, and its pages change, without a load.
    setInterval(checkVideos, VIDEO_CHECK_MS);
  }
  // On X's home timeline, a post not about engineering folds away to a line
  // saying so (a click shows it): the app asks TypeSafe's Jev about each one
  // and answers with __todoSessionsPostVerdict. A post without text stays.
  const X_HOME = "/home";
  const ENGINEERING_MIN = 0.5;
  const postIdOf = (post) => [...post.querySelectorAll('a[href*="/status/"]')].find((a) => a.querySelector("time"))?.pathname.match(/\/status\/(\d+)/)?.[1];
  const askPosts = () => {
    if (location.pathname !== X_HOME) return;
    for (const post of document.querySelectorAll('article[data-testid="tweet"]')) {
      // X reuses a post's cell for another as the timeline scrolls.
      const cell = post.closest('[data-testid="cellInnerDiv"]') ?? post;
      const id = postIdOf(post);
      if (!id || cell.dataset.tsPost === id) continue;
      cell.dataset.tsPost = id;
      delete cell.dataset.tsFold;
      const text = post.querySelector('[data-testid="tweetText"]')?.innerText.trim();
      if (!text) continue;
      cell.dataset.tsFold = "asking";
      send(`${X_POST}?i=${id}&t=${enc(text.slice(0, TEXT_MAX))}`);
    }
  };
  /// How likely post `id` is about engineering (null: not known, it stays).
  window.__todoSessionsPostVerdict = (id, probability) => {
    for (const cell of document.querySelectorAll(`[data-ts-post="${id}"][data-ts-fold="asking"]`)) {
      if (probability === null || probability >= ENGINEERING_MIN) {
        delete cell.dataset.tsFold;
        continue;
      }
      cell.dataset.tsFold = "folded";
      cell.dataset.tsFoldLabel = `エンジニアリング以外の投稿を隠しています（${Math.round(probability * 100)}%）· クリックで表示`;
    }
  };
  const watchPosts = () => {
    const style = document.createElement("style");
    style.textContent = `
      [data-ts-fold="asking"] article { opacity: 0.35; }
      [data-ts-fold="folded"] article { display: none !important; }
      [data-ts-fold="folded"]::before { content: attr(data-ts-fold-label); display: block; padding: 10px 16px; font-size: 13px;
        color: rgb(113, 118, 123); border-bottom: 1px solid rgb(47, 51, 54); cursor: pointer; }`;
    document.head.appendChild(style);
    let scheduled = false;
    new MutationObserver(() => {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        askPosts();
      });
    }).observe(document.body, { childList: true, subtree: true });
    askPosts();
    window.addEventListener(
      "click",
      (e) => {
        const cell = e.target instanceof Element ? e.target.closest('[data-ts-fold="folded"]') : null;
        if (!cell) return;
        e.preventDefault();
        e.stopPropagation();
        cell.dataset.tsFold = "shown";
      },
      true,
    );
  };
  if (X_HOST.test(location.hostname)) {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", watchPosts);
    else watchPosts();
  }
  // A book's chapter scrolled to its end is read (once per page).
  const END_SLACK_PX = 80;
  const readChapters = new Set();
  window.addEventListener(
    "scroll",
    (e) => {
      const page = location.href.split("#")[0];
      if (!OREILLY_BOOK.test(page) || !/\.x?html$/.test(page) || readChapters.has(page)) return;
      const el = e.target instanceof Element ? e.target : document.scrollingElement;
      if (!el || el.scrollTop + el.clientHeight < el.scrollHeight - END_SLACK_PX) return;
      readChapters.add(page);
      send(`${CHAPTER_READ}?u=${enc(page)}`);
    },
    true,
  );

  // Translating the page where it is (the app asks Claude): its innermost
  // blocks of text, the ones on screen first and the rest as they come into
  // view, a batch at a time; each one's own markup is kept to put back.
  const BLOCKS = "p, li, h1, h2, h3, h4, h5, h6, td, th, blockquote, figcaption, dt, dd, summary";
  const BATCH = 12;
  const FLUSH_MS = 400;
  const SCAN_MS = 800;
  const originals = new Map();
  const blocks = new Map();
  let translating = false;
  let nextBlock = 1;
  let queue = [];
  let seen = null;
  let scanTimer = 0;
  const scan = () => {
    for (const el of document.querySelectorAll(BLOCKS)) {
      if (el.dataset.tsId || el.querySelector(BLOCKS) || !el.innerText?.trim()) continue;
      el.dataset.tsId = String(nextBlock++);
      blocks.set(el.dataset.tsId, el);
      seen.observe(el);
    }
  };
  const growing = new MutationObserver(() => {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(() => translating && scan(), SCAN_MS);
  });
  window.__todoSessionsTranslate = (on) => {
    if (FRAME || on === translating) return;
    translating = on;
    send(`${TRANSLATED}?on=${on ? 1 : 0}`);
    if (!on) {
      seen?.disconnect();
      growing.disconnect();
      queue = [];
      for (const [el, html] of originals) el.innerHTML = html;
      originals.clear();
      for (const el of blocks.values()) delete el.dataset.tsAsked;
      return;
    }
    seen = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting || e.target.dataset.tsAsked) continue;
          e.target.dataset.tsAsked = "1";
          queue.push(e.target);
        }
      },
      { rootMargin: "300px" },
    );
    for (const el of blocks.values()) seen.observe(el);
    scan();
    growing.observe(document.body, { childList: true, subtree: true });
  };
  setInterval(() => {
    if (!translating || queue.length === 0) return;
    const batch = queue.splice(0, BATCH).map((el) => [el.dataset.tsId, el.innerText.trim()]);
    send(`${TRANSLATE}?b=${encodeURIComponent(JSON.stringify(batch))}`);
  }, FLUSH_MS);
  /// The app's translations: [[block, text], ...].
  window.__todoSessionsTranslated = (pairs) => {
    if (!translating) return;
    for (const [id, text] of pairs) {
      const el = blocks.get(id);
      if (!el || originals.has(el)) continue;
      originals.set(el, el.innerHTML);
      el.textContent = text;
    }
  };

  // A selection's translation, in a bubble under it.
  let bubble = null;
  let bubbleId = 0;
  const closeBubble = () => {
    bubble?.remove();
    bubble = null;
  };
  const translateSelection = (text) => {
    const range = getSelection()?.rangeCount ? getSelection().getRangeAt(0).getBoundingClientRect() : null;
    closeBubble();
    bubble = document.createElement("div");
    const root = bubble.attachShadow({ mode: "closed" });
    root.innerHTML = `<style>
      .b { position: fixed; z-index: 2147483647; max-width: 420px; padding: 10px 12px; border-radius: 8px;
           background: rgba(30, 31, 35, 0.97); border: 1px solid rgba(255, 255, 255, 0.12); color: #e8e9ec;
           box-shadow: 0 12px 32px rgba(0, 0, 0, 0.45); font: 13px/1.6 -apple-system, "Hiragino Sans", sans-serif; white-space: pre-wrap; }
    </style><div class="b">訳しています…</div>`;
    const box = root.querySelector(".b");
    document.documentElement.appendChild(bubble);
    box.style.left = `${Math.max(4, Math.min(range?.left ?? 20, innerWidth - 430))}px`;
    box.style.top = `${Math.min((range?.bottom ?? 20) + 6, innerHeight - 60)}px`;
    const id = ++bubbleId;
    window.__todoSessionsSelectionTranslated = (asked, translation) => asked === id && bubble && (box.textContent = translation);
    send(`${TRANSLATE_SELECTION}?i=${id}&t=${encodeURIComponent(text)}`);
  };
  window.addEventListener("mousedown", (e) => bubble && !e.composedPath().includes(bubble) && closeBubble(), true);

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

  // ⌃Return asks for the context menu (macOS 15's shortcut), with no
  // mousedown before it as a right click has: a focused link opens in the
  // default browser, as a ctrl-click on it does, and no menu shows.
  const MOUSE_MENU_MS = 500;
  let ctrlHeld = false;
  let lastMouseDown = -Infinity;
  window.addEventListener("mousedown", () => (lastMouseDown = performance.now()), true);
  window.addEventListener("keydown", (e) => e.key === "Control" && (ctrlHeld = true), true);
  window.addEventListener("keyup", (e) => e.key === "Control" && (ctrlHeld = false), true);
  window.addEventListener("blur", () => (ctrlHeld = false));
  window.addEventListener(
    "contextmenu",
    (e) => {
      if (e.altKey) return;
      e.preventDefault();
      if (ctrlHeld && performance.now() - lastMouseDown > MOUSE_MENU_MS) {
        const focused = document.activeElement?.closest?.("a[href]");
        if (focused) send(`${OPEN_OUTSIDE}?u=${encodeURIComponent(focused.href)}`);
        return;
      }
      const text = String(getSelection() ?? "").trim();
      const link = e.target instanceof Element ? e.target.closest("a[href]") : null;
      // A ctrl-click (macOS makes it a right click) on a link opens it in the default browser.
      if (e.ctrlKey && link) return send(`${OPEN_OUTSIDE}?u=${encodeURIComponent(link.href)}`);
      const items = [];
      if (text) {
        items.push(["選択したテキストを日本語に訳す", () => translateSelection(text)]);
        items.push(["コピー", () => document.execCommand("copy")]);
      }
      if (!FRAME) items.push([translating ? "原文に戻す" : "このページを日本語に訳す", () => window.__todoSessionsTranslate(!translating)]);
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
