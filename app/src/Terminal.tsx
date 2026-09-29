// The in-app terminal pane: a tab in the browser pane that runs a command in a
// pseudo-terminal (`app/src-tauri/src/terminal.rs`) and draws it with xterm.js.
// An experiment next to herdr in Ghostty; to drop it, remove this file,
// terminal.rs and the places in App.tsx that use them.
import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Terminal, type ITerminalOptions, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

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
  quick: (prompt: string) => invoke<TerminalRun>("terminal_quick", { prompt }),
  /// A session running in herdr comes back as attaching herdr (its pane
  /// focused); null when (with `desktop`) Claude Desktop knows it and opens it.
  resume: (sessionId: string, desktop: boolean) => invoke<TerminalRun | null>("terminal_resume", { sessionId, desktop }),
  /// Lets the menu bar and notifications open local sessions through the page.
  setInApp: (on: boolean) => invoke<void>("set_in_app_terminal", { on }),
};

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
const EXITED_NOTE = "\r\n\x1b[2m[終了しました]\x1b[0m\r\n";

/// Each terminal outlives its view, so switching tabs or hiding the pane
/// keeps what it printed; output that arrives meanwhile is written anyway.
interface Entry {
  term: Terminal;
  fit: FitAddon;
  host: HTMLDivElement;
  started: boolean;
  look: Look;
}
const entries = new Map<string, Entry>();

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
    const term = new Terminal({ ...look.options, scrollback: SCROLLBACK_LINES, macOptionIsMeta: true });
    const fit = new FitAddon();
    term.loadAddon(fit);
    const write = (data: string) => void invoke("term_write", { id, data }).catch(() => {});
    term.onData(write);
    // Keys type what they do in Ghostty: ⌘← ⌘→ to the line's ends, ⌘⌫
    // clears the line, ⇧Enter a new line (from the user's keybind), ...
    term.attachCustomKeyEventHandler((ev) => {
      const sends = ev.isComposing ? null : sendsFor(look.keys, ev);
      if (sends === null) return true;
      if (ev.type === "keydown") write(sends);
      return false;
    });
    // Outside full-screen apps (which get the wheel themselves), a trackpad
    // scrolls by its pixels as in Ghostty rather than xterm.js's slower steps.
    let partial = 0;
    term.attachCustomWheelEventHandler((ev) => {
      if (term.modes.mouseTrackingMode !== "none" || term.buffer.active.type !== "normal") return true;
      const rowPx = (term.element?.querySelector(".xterm-screen")?.clientHeight ?? 0) / term.rows || WHEEL_LINE_PX;
      partial += ev.deltaMode === WheelEvent.DOM_DELTA_LINE ? ev.deltaY : ev.deltaY / rowPx;
      const lines = Math.trunc(partial);
      partial -= lines;
      if (lines) term.scrollLines(lines);
      ev.preventDefault();
      return false;
    });
    term.onResize(({ cols, rows }) => void invoke("term_resize", { id, cols, rows }).catch(() => {}));
    const host = document.createElement("div");
    host.className = "terminal-host";
    e = { term, fit, host, started: false, look };
    entries.set(id, e);
  }
  return e;
}

/// Ends the program and forgets the terminal (closing its tab).
export function closeTerminal(id: string) {
  entries.get(id)?.term.dispose();
  entries.delete(id);
  invoke("term_close", { id }).catch(() => {});
}

/// Terminal `id` running `run`; the program starts the first time it is shown,
/// at the size it has then.
export function TerminalView({ id, run, report }: { id: string; run: TerminalRun; report: (e: unknown) => void }) {
  const slot = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let e: Entry | null = null;
    let ro: ResizeObserver | null = null;
    let gone = false;
    look.then((l) => {
      if (gone || !slot.current) return;
      e = show(entryFor(id, l), slot.current);
      const fit = e.fit;
      ro = new ResizeObserver(() => fit.fit());
      ro.observe(slot.current);
    });
    return () => {
      gone = true;
      ro?.disconnect();
      e?.host.remove();
    };
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  /// Puts the terminal in the slot, starting its program the first time.
  const show = (e: Entry, into: HTMLElement) => {
    // Padded outside the terminal, which the fit addon sizes to its parent.
    into.style.padding = `${e.look.padding.y}px ${e.look.padding.x}px`;
    into.style.background = e.look.options.theme?.background ?? "";
    into.appendChild(e.host);
    if (!e.term.element) e.term.open(e.host);
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
      <div className="browser-bar">
        <span className="muted mono ellipsis" title={run.command}>
          {run.cwd} $ {run.command}
        </span>
      </div>
      <div className="terminal-slot" ref={slot} />
    </>
  );
}
