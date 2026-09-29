// The in-app terminal pane: a tab in the browser pane that runs a command in a
// pseudo-terminal (`app/src-tauri/src/terminal.rs`) and draws it with xterm.js.
// An experiment next to herdr in Ghostty; to drop it, remove this file,
// terminal.rs and the places in App.tsx that use them.
import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

/// A command to run, where, and what to call its tab (`TerminalRun` in main.rs).
export interface TerminalRun {
  cwd: string;
  title: string;
  command: string;
  /// The Claude session it runs, when known.
  session: string | null;
}

export const terminalApi = {
  /// Registers a session for the todo and returns the command that starts it.
  start: (todoId: number, options?: { model?: string; effort?: string }) =>
    invoke<TerminalRun>("terminal_start", { todoId, options: options ?? null }),
  quick: (prompt: string) => invoke<TerminalRun>("terminal_quick", { prompt }),
  /// Null when the session still runs in herdr, which then has the focus, or
  /// (with `desktop`) when Claude Desktop knows it and opens it.
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
const FONT_SIZE = 12;
const SCROLLBACK_LINES = 5000;
const EXITED_NOTE = "\r\n\x1b[2m[終了しました]\x1b[0m\r\n";

/// Each terminal outlives its view, so switching tabs or hiding the pane
/// keeps what it printed; output that arrives meanwhile is written anyway.
interface Entry {
  term: Terminal;
  fit: FitAddon;
  host: HTMLDivElement;
  started: boolean;
}
const entries = new Map<string, Entry>();

const decode = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
void listen<{ id: string; data: string }>(OUTPUT_EVENT, ({ payload }) => entries.get(payload.id)?.term.write(decode(payload.data)));
void listen<{ id: string }>(EXIT_EVENT, ({ payload }) => entries.get(payload.id)?.term.write(EXITED_NOTE));

const cssVar = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function entryFor(id: string): Entry {
  let e = entries.get(id);
  if (!e) {
    const term = new Terminal({
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      fontSize: FONT_SIZE,
      scrollback: SCROLLBACK_LINES,
      cursorBlink: true,
      macOptionIsMeta: true,
      theme: { background: cssVar("--surface"), foreground: cssVar("--text"), cursor: cssVar("--accent"), selectionBackground: cssVar("--accent-soft") },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.onData((data) => void invoke("term_write", { id, data }).catch(() => {}));
    term.onResize(({ cols, rows }) => void invoke("term_resize", { id, cols, rows }).catch(() => {}));
    const host = document.createElement("div");
    host.className = "terminal-host";
    e = { term, fit, host, started: false };
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
    const e = entryFor(id);
    slot.current!.appendChild(e.host);
    if (!e.term.element) e.term.open(e.host);
    e.fit.fit();
    e.term.focus();
    if (!e.started) {
      e.started = true;
      invoke("term_open", { id, command: run.command, cwd: run.cwd, cols: e.term.cols, rows: e.term.rows }).catch((err) => {
        e.term.write(`\r\n${String(err)}\r\n`);
        report(err);
      });
    }
    const ro = new ResizeObserver(() => e.fit.fit());
    ro.observe(slot.current!);
    return () => {
      ro.disconnect();
      e.host.remove();
    };
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
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
