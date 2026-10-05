// The in-app terminal pane: a tab in the browser pane that runs a command in a
// pseudo-terminal (`app/src-tauri/src/terminal.rs`) and draws it with xterm.js.
// An experiment next to herdr in Ghostty; to drop it, remove this file,
// terminal.rs and the places in App.tsx that use them.
import { createContext, useContext, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Terminal, type IBufferLine, type ITerminalOptions, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import "@xterm/xterm/css/xterm.css";
import { allKeys, matches, matchesCombo } from "./keymap";
import { KittyFlags, kittyChord } from "./kitty";
import { findUrls } from "./links";

/// A command to run, where, and what to call its tab (`TerminalRun` in main.rs).
export interface TerminalRun {
  cwd: string;
  title: string;
  command: string;
  /// The Claude session it runs, when known.
  session: string | null;
  /// The herdr session it attaches to, for a session running in herdr.
  herdr: string | null;
}

export const terminalApi = {
  /// Registers a session for the todo and returns the command that starts it.
  start: (todoId: number, options?: { model?: string; effort?: string }) =>
    invoke<TerminalRun>("terminal_start", { todoId, options: options ?? null }),
  /// `agent` "codex" runs Codex instead of Claude (a PR review).
  quick: (prompt: string, cwd?: string, title?: string, agent?: "claude" | "codex", options?: { model?: string; effort?: string }) =>
    invoke<TerminalRun>("terminal_quick", { prompt, cwd: cwd ?? null, title: title ?? null, agent: agent ?? null, options: options ?? null }),
  /// A session running in herdr comes back as attaching herdr (its pane
  /// focused); null when (with `desktop`) Claude Desktop knows it and opens it.
  resume: (sessionId: string, desktop: boolean) => invoke<TerminalRun | null>("terminal_resume", { sessionId, desktop }),
  /// Lets the menu bar and notifications open local sessions through the page.
  setInApp: (on: boolean) => invoke<void>("set_in_app_terminal", { on }),
  /// The Claude session a herdr session shows (its focused pane), if any.
  herdrFocused: (name: string) => invoke<string | null>("herdr_focused", { name }),
};

/// Names a session as the app's lists do (null: no name known), for a terminal's title.
export const SessionTitleContext = createContext<(sessionId: string) => string | null>(() => null);

/// `{session_id}` from the menu bar or a notification, for a local session.
export const OPEN_LOCAL_EVENT = "open-local";

/// Where "herdr" targets run: herdr in Ghostty, or a tab of this app.
export type TerminalTarget = "ghostty" | "app";
export const TERMINAL_TARGET_KEY = "terminalTarget";

const OUTPUT_EVENT = "term-output";
const EXIT_EVENT = "term-exit";
const FONT_SIZE = 14;
const FALLBACK_FONTS = "ui-monospace, Menlo, monospace";
/// Ghostty's palette numbers 0–15 as xterm.js names them.
const PALETTE: (keyof ITheme)[] = [
  "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
  "brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan", "brightWhite",
];
const GHOSTTY_COLORS: Record<string, keyof ITheme> = {
  background: "background",
  foreground: "foreground",
  "cursor-color": "cursor",
  "cursor-text": "cursorAccent",
  "selection-background": "selectionBackground",
  "selection-foreground": "selectionForeground",
};
const SCROLLBACK_LINES = 5000;
/// Ghostty's key names that differ from a key event's `key`.
const GHOSTTY_KEYS: Record<string, string> = {
  arrow_left: "ArrowLeft", arrow_right: "ArrowRight", arrow_up: "ArrowUp", arrow_down: "ArrowDown",
  backspace: "Backspace", delete: "Delete", enter: "Enter", tab: "Tab", escape: "Escape", space: " ",
  home: "Home", end: "End", page_up: "PageUp", page_down: "PageDown",
};
const MODS = { meta: ["super", "cmd", "command"], alt: ["alt", "opt", "option"], ctrl: ["ctrl", "control"], shift: ["shift"] };
/// Ghostty sends ⌥ + an arrow with no keybind as xterm's modified arrow.
const ALT_ARROWS: Record<string, string> = { ArrowUp: "\x1b[1;3A", ArrowDown: "\x1b[1;3B", ArrowRight: "\x1b[1;3C", ArrowLeft: "\x1b[1;3D" };
/// Ghostty scrolls a trackpad by its pixels; the terminal does the same.
const WHEEL_LINE_PX = 16;
/// Characters a terminal draws two cells wide (East Asian wide and full-width, and emoji).
const WIDE = /[\u1100-\u115f\u2e80-\u303e\u3041-\u33ff\u3400-\u4dbf\u4e00-\u9fff\ua000-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]|[\u{1f300}-\u{1faff}\u{20000}-\u{3fffd}]/u;

/// Lays out text being converted (IME) on the terminal's cells, a wide
/// character over two, as Ghostty does; xterm.js sets it in the font's own
/// spacing, which packs Japanese tight.
function gridComposition(term: Terminal) {
  const view = term.element?.querySelector<HTMLElement>(".composition-view");
  const screen = term.element?.querySelector<HTMLElement>(".xterm-screen");
  if (!view || !screen) return;
  new MutationObserver(() => {
    // xterm.js writes plain text; the cells laid out here are elements.
    if (![...view.childNodes].some((n) => n.nodeType === Node.TEXT_NODE)) return;
    const cell = screen.clientWidth / term.cols;
    const cells = [...(view.textContent ?? "")].map((ch) => {
      const span = document.createElement("span");
      span.textContent = ch;
      span.style.width = `${(WIDE.test(ch) ? 2 : 1) * cell}px`;
      return span;
    });
    view.replaceChildren(...cells);
  }).observe(view, { childList: true, characterData: true, subtree: true });
}

/// Big enough for xterm.js to take a replayed step as one whole row.
const WHEEL_STEP_PX = 1000;
const EXITED_NOTE = "\r\n\x1b[2m[終了しました]\x1b[0m\r\n";

/// Each terminal outlives its view, so switching tabs or hiding the pane
/// keeps what it printed; output that arrives meanwhile is written anyway.
interface Entry {
  term: Terminal;
  fit: FitAddon;
  host: HTMLDivElement;
  started: boolean;
  look: Look;
  /// The window title the program set (OSC 0 / 2), as Ghostty shows it.
  title: string;
}
const entries = new Map<string, Entry>();

/// Opens a link from a terminal in the browser, in front (`front`) or behind.
let linkOpener: ((url: string, front: boolean) => void) | null = null;
export const setTerminalLinkOpener = (open: typeof linkOpener) => void (linkOpener = open);
/// ⌘-click opens a link in a new tab behind, ⌘⇧-click in front, as a browser does.
const openClicked = (ev: MouseEvent, url: string) => ev.metaKey && linkOpener?.(url, ev.shiftKey);

/// A row's text, and the column each of its characters is in (a wide one takes two).
function rowText(line: IBufferLine) {
  let text = "";
  const cols: number[] = [];
  for (let x = 0; x < line.length; x++) {
    const cell = line.getCell(x);
    if (!cell || cell.getWidth() === 0) continue;
    const chars = cell.getChars() || " ";
    text += chars;
    for (let i = 0; i < chars.length; i++) cols.push(x);
  }
  return { text, cols };
}

/// The addresses terminal `id` shows now, the lowest (latest) first.
export function terminalLinks(id: string): string[] {
  const term = entries.get(id)?.term;
  if (!term) return [];
  const buffer = term.buffer.active;
  const urls: string[] = [];
  for (let y = buffer.viewportY + term.rows - 1; y >= buffer.viewportY; y--) {
    const line = buffer.getLine(y);
    if (line) urls.push(...findUrls(rowText(line).text).map((l) => l.url).reverse());
  }
  return [...new Set(urls)];
}

const decode = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
void listen<{ id: string; data: string }>(OUTPUT_EVENT, ({ payload }) => entries.get(payload.id)?.term.write(decode(payload.data)));
void listen<{ id: string }>(EXIT_EVENT, ({ payload }) => entries.get(payload.id)?.term.write(EXITED_NOTE));

const cssVar = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/// Looks like the user's Ghostty: its fonts, size, padding, theme and cursor.
interface Look {
  options: ITerminalOptions;
  padding: { x: number; y: number };
  /// Ghostty's font families, first choice first.
  fonts: string[];
  /// Ghostty's keybinds that type something, like ⌘← sending ^A.
  keys: Keybind[];
}

interface Keybind {
  meta: boolean;
  alt: boolean;
  ctrl: boolean;
  shift: boolean;
  key: string;
  sends: string;
}
/// `super+arrow_left` and what it sends; null for a trigger it cannot read.
function keybindFrom([trigger, sends]: [string, string]): Keybind | null {
  const parts = trigger.split("+");
  const name = parts.pop() ?? "";
  if (!name || parts.some((m) => !Object.values(MODS).flat().includes(m))) return null;
  const has = (names: string[]) => parts.some((m) => names.includes(m));
  return { meta: has(MODS.meta), alt: has(MODS.alt), ctrl: has(MODS.ctrl), shift: has(MODS.shift), key: GHOSTTY_KEYS[name] ?? name, sends };
}
/// What Ghostty would send for the key, when that differs from xterm.js.
function sendsFor(keys: Keybind[], ev: KeyboardEvent): string | null {
  const bound = keys.find(
    (b) =>
      b.meta === ev.metaKey && b.alt === ev.altKey && b.ctrl === ev.ctrlKey && b.shift === ev.shiftKey &&
      // A letter by its key cap, which ⌥ turns into another character.
      (b.key.length === 1 && /[a-z]/.test(b.key) ? ev.code === `Key${b.key.toUpperCase()}` : ev.key === b.key),
  );
  if (bound) return bound.sends;
  const altOnly = ev.altKey && !ev.metaKey && !ev.ctrlKey && !ev.shiftKey;
  return altOnly ? (ALT_ARROWS[ev.key] ?? null) : null;
}
function lookFrom(config: [string, string][]): Look {
  const theme: ITheme = { background: cssVar("--surface"), foreground: cssVar("--text"), cursor: cssVar("--accent"), selectionBackground: cssVar("--accent-soft") };
  let fonts: string[] = [];
  const options: ITerminalOptions = { fontSize: FONT_SIZE, cursorBlink: true, cursorStyle: "block", cursorInactiveStyle: "outline" };
  const padding = { x: 0, y: 0 };
  for (const [key, value] of config) {
    if (key === "font-family") fonts = value ? [...fonts, value] : [];
    else if (key === "font-size" && Number(value) > 0) options.fontSize = Number(value);
    else if (key === "window-padding-x") padding.x = Number(value.split(",")[0]) || 0;
    else if (key === "window-padding-y") padding.y = Number(value.split(",")[0]) || 0;
    else if (key === "cursor-style-blink") options.cursorBlink = value !== "false";
    else if (key === "cursor-style" && ["block", "underline", "bar"].includes(value)) options.cursorStyle = value as ITerminalOptions["cursorStyle"];
    else if (key === "palette") {
      const [n, color] = value.split("=");
      const name = PALETTE[Number(n)];
      if (name && color) Object.assign(theme, { [name]: color.trim() });
    } else if (key in GHOSTTY_COLORS) Object.assign(theme, { [GHOSTTY_COLORS[key]]: value.startsWith("#") ? value : `#${value}` });
  }
  options.fontFamily = [...fonts.map((f) => `"${f}"`), FALLBACK_FONTS].join(", ");
  options.theme = theme;
  return { options, padding, fonts, keys: [] };
}
/// WebKit gives pages only the system's fonts, so fonts the user installed
/// are loaded from their files; a system font simply has no file to load.
async function loadFonts(families: string[]) {
  const faces = families.flatMap((family) =>
    [false, true].map((bold) =>
      invoke<ArrayBuffer>("user_font", { family, bold })
        .then((data) => new FontFace(family, data, { weight: bold ? "bold" : "normal" }).load())
        .then((face) => void document.fonts.add(face))
        .catch(() => {}),
    ),
  );
  await Promise.all(faces);
}
/// Read once, fonts loaded before a terminal measures them; without
/// Ghostty's config the app's own colors are used.
const look: Promise<Look> = invoke<[string, string][]>("ghostty_config")
  .then(lookFrom, () => lookFrom([]))
  .then(async (l) => {
    const [keys] = await Promise.all([invoke<[string, string][]>("ghostty_keybinds").catch(() => []), loadFonts(l.fonts)]);
    return { ...l, keys: keys.map(keybindFrom).filter((k): k is Keybind => k !== null) };
  });

function entryFor(id: string, look: Look): Entry {
  let e = entries.get(id);
  if (!e) {
    // Links a program marks (OSC 8, as Claude Code's) and addresses in the text open on ⌘-click.
    // allowProposedApi: the Unicode 11 widths (below) go through xterm.js's proposed unicode API.
    const term = new Terminal({ ...look.options, scrollback: SCROLLBACK_LINES, macOptionIsMeta: true, linkHandler: { activate: openClicked }, allowProposedApi: true });
    term.registerLinkProvider({
      provideLinks(y, callback) {
        const line = term.buffer.active.getLine(y - 1);
        const { text, cols } = line ? rowText(line) : { text: "", cols: [] };
        const links = findUrls(text).map(({ url, index }) => ({
          text: url,
          range: { start: { x: cols[index] + 1, y }, end: { x: cols[index + url.length - 1] + 1, y } },
          activate: (ev: MouseEvent) => openClicked(ev, url),
        }));
        callback(links.length > 0 ? links : undefined);
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    // Character widths as programs (Claude Code) and herdr (Ghostty's) count
    // them: with xterm.js's default (Unicode 6) a symbol or emoji counted
    // narrow here but wide there shifts the line a program redraws.
    term.loadAddon(new Unicode11Addon());
    term.unicode.activeVersion = "11";
    const write = (data: string) => void invoke("term_write", { id, data }).catch(() => {});
    term.onData(write);
    const kitty = new KittyFlags();
    const first = (params: (number | number[])[], fallback: number) => (typeof params[0] === "number" && params[0]) || fallback;
    term.parser.registerCsiHandler({ prefix: "?", final: "u" }, () => (write(kitty.answer()), true));
    term.parser.registerCsiHandler({ prefix: ">", final: "u" }, (p) => (kitty.push(first(p, 0)), true));
    term.parser.registerCsiHandler({ prefix: "<", final: "u" }, (p) => (kitty.pop(first(p, 1)), true));
    term.parser.registerCsiHandler({ prefix: "=", final: "u" }, (p) => (kitty.set(first(p, 0), typeof p[1] === "number" ? p[1] : 1), true));
    // Keys type what they do in Ghostty: ⌘← ⌘→ to the line's ends, ⌘⌫
    // clears the line, ⇧Enter a new line (from the user's keybind), ...
    term.attachCustomKeyEventHandler((ev) => {
      // The keys moving the typing between the app's sides (App.tsx) stay out of the program.
      if (matches(ev, "sideApp") || matches(ev, "sidePane")) return false;
      const sends = ev.isComposing ? null : sendsFor(look.keys, ev);
      const chord =
        sends === null && kitty.current && !ev.isComposing && !Object.values(allKeys()).some((c) => matchesCombo(ev, c, true)) ? kittyChord(ev) : null;
      if (sends === null && chord === null) return true;
      if (ev.type === "keydown") write(sends ?? chord ?? "");
      return false;
    });
    // The wheel moves a row per row's height scrolled, as in Ghostty.
    // xterm.js damps small trackpad steps and, for an app that takes the
    // wheel (Claude Code, herdr), sends one step per event however far it
    // went, which crawls; each row here is handed back to it as one step.
    let partial = 0;
    let replaying = false;
    term.attachCustomWheelEventHandler((ev) => {
      if (replaying) return true;
      const rowPx = (term.element?.querySelector(".xterm-screen")?.clientHeight ?? 0) / term.rows || WHEEL_LINE_PX;
      partial += ev.deltaMode === WheelEvent.DOM_DELTA_LINE ? ev.deltaY : ev.deltaY / rowPx;
      const rows = Math.trunc(partial);
      partial -= rows;
      ev.preventDefault();
      if (term.modes.mouseTrackingMode === "none" && term.buffer.active.type === "normal") {
        if (rows) term.scrollLines(rows);
        return false;
      }
      replaying = true;
      for (let i = 0; i < Math.abs(rows); i++) {
        const step = new WheelEvent("wheel", { deltaY: Math.sign(rows) * WHEEL_STEP_PX, clientX: ev.clientX, clientY: ev.clientY, bubbles: true, cancelable: true });
        ev.target?.dispatchEvent(step);
      }
      replaying = false;
      return false;
    });
    term.onResize(({ cols, rows }) => void invoke("term_resize", { id, cols, rows }).catch(() => {}));
    const host = document.createElement("div");
    host.className = "terminal-host";
    host.dataset.terminal = id;
    e = { term, fit, host, started: false, look, title: "" };
    const entry = e;
    term.onTitleChange((title) => (entry.title = title));
    entries.set(id, e);
  }
  return e;
}

/// Gives terminal `id` the keyboard, as when its tab is brought up again
/// (a new one takes it as it is first shown).
export function focusTerminal(id: string) {
  const term = entries.get(id)?.term;
  if (!term?.element) return;
  invoke("term_focus").catch(() => {}).finally(() => term.focus());
}

/// What is selected in terminal `id`, if anything.
export const terminalSelection = (id: string) => entries.get(id)?.term.getSelection().trim() || undefined;

/// Ends the program and forgets the terminal (closing its tab).
export function closeTerminal(id: string) {
  entries.get(id)?.term.dispose();
  entries.delete(id);
  invoke("term_close", { id }).catch(() => {});
}

/// Terminal `id` running `run`; the program starts the first time it is shown,
/// at the size it has then.
/// How often the session a herdr terminal shows is looked up (its focused pane changes with ⌥⌘[ ]).
const HERDR_FOCUS_EVERY_MS = 2000;

export function TerminalView({ id, run, report }: { id: string; run: TerminalRun; report: (e: unknown) => void }) {
  const slot = useRef<HTMLDivElement>(null);
  const sessionTitle = useContext(SessionTitleContext);
  // The title the program sets (Claude Code: what it is doing), over the terminal as Ghostty shows it.
  const [title, setTitle] = useState(() => entries.get(id)?.title ?? "");
  // The session it runs, or the one its herdr session shows: named as the session list names it.
  const [herdrSession, setHerdrSession] = useState<string | null>(null);
  useEffect(() => {
    const name = run.herdr;
    if (!name) return;
    const look = () => void terminalApi.herdrFocused(name).then(setHerdrSession, () => {});
    look();
    const timer = setInterval(look, HERDR_FOCUS_EVERY_MS);
    return () => clearInterval(timer);
  }, [run.herdr]);
  const session = run.session ?? herdrSession;
  const named = session ? sessionTitle(session) : null;
  useEffect(() => {
    let e: Entry | null = null;
    let ro: ResizeObserver | null = null;
    let off: { dispose: () => void } | null = null;
    let gone = false;
    look.then((l) => {
      if (gone || !slot.current) return;
      e = show(entryFor(id, l), slot.current);
      setTitle(e.title);
      off = e.term.onTitleChange(setTitle);
      const fit = e.fit;
      ro = new ResizeObserver(() => fit.fit());
      ro.observe(slot.current);
    });
    return () => {
      gone = true;
      ro?.disconnect();
      off?.dispose();
      e?.host.remove();
    };
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  /// Puts the terminal in the slot, starting its program the first time.
  const show = (e: Entry, into: HTMLElement) => {
    // Padded outside the terminal, which the fit addon sizes to its parent.
    into.style.padding = `${e.look.padding.y}px ${e.look.padding.x}px`;
    into.style.background = e.look.options.theme?.background ?? "";
    into.appendChild(e.host);
    if (!e.term.element) {
      e.term.open(e.host);
      gridComposition(e.term);
      const theme = e.look.options.theme;
      e.host.style.setProperty("--term-bg", theme?.background ?? "");
      e.host.style.setProperty("--term-fg", theme?.foreground ?? "");
    }
    e.fit.fit();
    // The page may not have the keyboard when a browser tab had it.
    invoke("term_focus").catch(() => {}).finally(() => e.term.focus());
    if (!e.started) {
      e.started = true;
      invoke("term_open", { id, command: run.command, cwd: run.cwd, cols: e.term.cols, rows: e.term.rows }).catch((err) => {
        e.term.write(`\r\n${String(err)}\r\n`);
        report(err);
      });
    }
    return e;
  };
  return (
    <>
      <div className="browser-bar terminal-title" title={`${run.cwd} $ ${run.command}`}>
        <span className="ellipsis">{named || title || run.title}</span>
      </div>
      <div className="terminal-slot" ref={slot} />
    </>
  );
}
