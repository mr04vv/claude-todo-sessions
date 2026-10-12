// Ctrl held on what opens a page sends it to the default browser (a file to
// its app) instead of the app's pane. macOS makes a ctrl-click a right click
// (no click follows), and a key with ctrl matches none of the app's, so both
// are replayed without ctrl while `opensOutside` is true; the openers ask it.
import { opensWithCtrl } from "./keymap";

/// Where ctrl keeps its own meaning: typing, and the terminal.
const OWN_CTRL = "input, textarea, select, [contenteditable], .xterm";

let outside = false;

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
  window.addEventListener(
    "contextmenu",
    (e) => {
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
      const t = e.target;
      if (!opensWithCtrl(e) || !ours(t)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      const plain = new KeyboardEvent("keydown", { key: e.key, code: e.code, metaKey: e.metaKey, shiftKey: e.shiftKey, altKey: e.altKey, bubbles: true, cancelable: true });
      asOutside(() => t.dispatchEvent(plain));
    },
    true,
  );
}
