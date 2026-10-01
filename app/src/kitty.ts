// The kitty keyboard protocol, as far as the in-app terminal needs it: a
// program that turns it on (herdr, for its cmd+alt+[ ] and ctrl+alt+[ ])
// gets the chords of ⌥ with ⌘ or ⌃ as CSI u, which xterm.js cannot send.
// Other keys keep xterm.js's encoding, which such programs read too; ⌘
// alone stays the app's and the system's (⌘C, ⌘V, ...).

/// The key a code stands for, unshifted, for a glyph ⌥ or ⇧ changed.
const CODE_KEYS: Record<string, string> = {
  BracketLeft: "[",
  BracketRight: "]",
  Minus: "-",
  Equal: "=",
  Semicolon: ";",
  Quote: "'",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Backslash: "\\",
  Backquote: "`",
};

/// A glyph ⇧ made, as its key.
const SHIFTED: Record<string, string> = { "{": "[", "}": "]", _: "-", "+": "=", ":": ";", '"': "'", "<": ",", ">": ".", "?": "/", "|": "\\", "~": "`" };

/// `CSI <key> ; <modifiers> u` for such a chord, else null. The key is the
/// one the event names (⌘ keeps it as on the keyboard, a JIS one too), else
/// the one at its place when ⌥ turned it into another glyph.
export function kittyChord(ev: KeyboardEvent): string | null {
  if (!ev.altKey || !(ev.metaKey || ev.ctrlKey)) return null;
  const named = ev.key.length === 1 && /[\x21-\x7e]/.test(ev.key) ? (SHIFTED[ev.key] ?? ev.key.toLowerCase()) : undefined;
  const key = named ?? /^Key([A-Z])$/.exec(ev.code)?.[1]?.toLowerCase() ?? /^Digit([0-9])$/.exec(ev.code)?.[1] ?? CODE_KEYS[ev.code];
  if (!key) return null;
  const mods = 1 + (ev.shiftKey ? 1 : 0) + (ev.altKey ? 2 : 0) + (ev.ctrlKey ? 4 : 0) + (ev.metaKey ? 8 : 0);
  return `\x1b[${key.codePointAt(0)};${mods}u`;
}

/// The protocol's flags a program pushed, popped and set (`CSI > u`, `CSI < u`,
/// `CSI = u`), and its query's answer (`CSI ? u`).
export class KittyFlags {
  private stack: number[] = [];

  get current() {
    return this.stack.at(-1) ?? 0;
  }

  push(flags: number) {
    this.stack.push(flags);
  }

  pop(n: number) {
    this.stack.splice(Math.max(0, this.stack.length - Math.max(1, n)));
  }

  /// Mode 1 sets the flags, 2 adds them, 3 takes them away.
  set(flags: number, mode: number) {
    const next = mode === 2 ? this.current | flags : mode === 3 ? this.current & ~flags : flags;
    if (this.stack.length === 0) this.stack.push(next);
    else this.stack[this.stack.length - 1] = next;
  }

  answer() {
    return `\x1b[?${this.current}u`;
  }
}
