// Ctrl held on what opens a page sends it to the default browser (a file to
// its app) instead of the app's pane. macOS makes a ctrl-click a right click
// (no click follows), ⌃Return asks for the context menu (macOS 15's
// shortcut: WebKit fires a contextmenu at the focused element, without ctrl
// and with no mousedown before it), and a
// key with ctrl matches none of the app's, so each is replayed without ctrl
// while `opensOutside` is true; the openers ask it.
import { opensWithCtrl } from "./keymap";

/// Where ctrl keeps its own meaning: typing, and the terminal.
const OWN_CTRL = "input, textarea, select, [contenteditable], .xterm";

/// A right click comes right after its mousedown; a menu asked from the
/// keyboard without one.
const MOUSE_MENU_MS = 500;

let outside = false;
let ctrlHeld = false;
let lastMouseDown = -Infinity;
/// When ⌃Enter's keydown was replayed, so the menu it may also ask for is not.
let lastEnterReplay = -Infinity;

/// Whether what opens now goes to the default browser.
export const opensOutside = () => outside;

/// Runs `f` with what it opens going to the default browser.
export function asOutside(f: () => void) {
  outside = true;
  try {
    f();
  } finally {
    outside = false;
  }
}

const ours = (t: EventTarget | null): t is HTMLElement => t instanceof HTMLElement && !t.closest(OWN_CTRL);

/// Replays ctrl-clicks as clicks, and ctrl with an opening key as that key,
/// opening outside. A right click (no ctrl) keeps its menu.
export function ctrlOpensOutside() {
  window.addEventListener("mousedown", () => (lastMouseDown = performance.now()), true);
  window.addEventListener("keyup", (e) => e.key === "Control" && (ctrlHeld = false), true);
  window.addEventListener("blur", () => (ctrlHeld = false));
  window.addEventListener(
    "contextmenu",
    (e) => {
      const now = performance.now();
      if (ctrlHeld && now - lastMouseDown > MOUSE_MENU_MS) {
        // ⌃Return: Enter, opening outside (once, when its keydown came too).
        e.preventDefault();
        e.stopImmediatePropagation();
        const t = document.activeElement;
        if (now - lastEnterReplay > MOUSE_MENU_MS && ours(t)) asOutside(() => t.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
        return;
      }
      const t = e.target;
      if (!e.ctrlKey || !ours(t)) return;
      e.preventDefault();
      asOutside(() => t.click());
    },
    true,
  );
  window.addEventListener(
    "keydown",
    (e) => {
      if (e.key === "Control") ctrlHeld = true;
      const t = e.target;
      if (!opensWithCtrl(e) || !ours(t)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.key === "Enter") lastEnterReplay = performance.now();
      const plain = new KeyboardEvent("keydown", { key: e.key, code: e.code, metaKey: e.metaKey, shiftKey: e.shiftKey, altKey: e.altKey, bubbles: true, cancelable: true });
      asOutside(() => t.dispatchEvent(plain));
    },
    true,
  );
}
