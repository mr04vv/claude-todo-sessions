/// The text of an OSC 52 clipboard write ("targets;base64", as herdr's copy
/// sends it), or null for a query ("?") or anything malformed.
export function osc52Text(data: string): string | null {
  const at = data.indexOf(";");
  const payload = at < 0 ? "" : data.slice(at + 1);
  if (!payload || payload === "?") return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(atob(payload), (c) => c.charCodeAt(0)));
  } catch {
    return null;
  }
}

/** Below this, a copy is too narrow to have been wrapped by Claude Code. */
const MIN_WRAP_WIDTH = 80;
/** How far short of the widest line a wrapped line may end (English wraps a word early). */
const WRAP_SLACK = 12;
/** A line that starts something of its own: a list item, a table row (box-drawn too), a fence, Claude Code's marks. */
const STARTS_OWN_LINE = /^\s*([-*+•]\s|\d+[.)]\s|\||```|⏺|⎿|[\u2500-\u257f])/;

/** Columns a character takes in the terminal: two for East Asian wide ones. */
function charWidth(code: number): number {
  const wide =
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1faff) ||
    (code >= 0x20000 && code <= 0x3fffd);
  return wide ? 2 : 1;
}

const textWidth = (s: string) => [...s].reduce((w, c) => w + charWidth(c.codePointAt(0) ?? 0), 0);
const isAscii = (c: string | undefined) => c !== undefined && c.charCodeAt(0) < 0x80;

/**
 * A copy with the lines Claude Code wrapped at the pane's width joined back.
 * It wraps them itself (a newline and the indent), so the terminal cannot tell
 * them from real ones; a line ending near the widest is taken as wrapped.
 */
// ponytail: the widest line stands in for the pane's width, so a real line that
// happens to fill the pane gets joined too; ask herdr (`pane layout`) for the width if that bites.
export function unwrapCopied(text: string): string {
  const lines = text.split("\n");
  const widths = lines.map((l) => textWidth(l.trimEnd()));
  const widest = Math.max(...widths);
  if (widest < MIN_WRAP_WIDTH) return text;
  const out = [lines[0]];
  for (let i = 1; i < lines.length; i++) {
    const next = lines[i];
    if (widths[i - 1] >= widest - WRAP_SLACK && next.trim() !== "" && !STARTS_OWN_LINE.test(next)) {
      const prev = out[out.length - 1].trimEnd();
      const rest = next.trimStart();
      out[out.length - 1] = prev + (isAscii(prev.at(-1)) && isAscii(rest[0]) ? " " : "") + rest;
    } else {
      out.push(next);
    }
  }
  return out.join("\n");
}
