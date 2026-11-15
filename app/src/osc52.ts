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

/** What is known of the pane a copy came from; without it the copy's widest line stands in for the width. */
export interface PaneGeometry {
  /** The pane's width in columns. */
  width?: number;
  /** The columns of the first line's start left out of the copy, when the selection began mid-line. */
  startCol?: number;
  /** The whole row the selection ended on, the pane's part of it: the last line may be cut short of its first word. */
  endRowText?: string;
}

/** Claude Code keeps the pane's last column empty. */
const PANE_MARGIN = 1;

/** What goes between two lines when they are one wrapped line ("" or " "), null when they are not. */
type Join = string | null;

/** Without the pane's width: a line ending near the widest is wrapped. */
function joinByWidest(prev: string, rest: string, prevWidth: number, widest: number): Join {
  if (prevWidth < widest - WRAP_SLACK) return null;
  return isAscii(prev.at(-1)) && isAscii(rest[0]) ? " " : "";
}

/**
 * With it: Claude Code wraps at spaces, so a line is wrapped when the next line's first
 * word would not have fit after it (a long Japanese run with no space is one word). The
 * space it broke at is put back unless both sides are Japanese.
 */
function joinByPane(prev: string, rest: string, prevWidth: number, wrapAt: number, row?: string): Join {
  const own = rest.split(" ")[0];
  // The selection may end inside the word; its row, when it begins with what was copied, has all of it.
  const whole = row?.trimStart().split(" ")[0];
  const word = whole?.startsWith(own) ? whole : own;
  if (prevWidth + 1 + textWidth(word) <= wrapAt) return null;
  return isAscii(prev.at(-1)) || isAscii(rest[0]) ? " " : "";
}

/**
 * A copy with the lines Claude Code wrapped at the pane's width joined back.
 * It wraps them itself (a newline and the indent), so the terminal cannot tell
 * them from real ones; a line ending near the widest is taken as wrapped.
 */
// ponytail: the widest line stands in for the pane's width, so a real line that
// happens to fill the pane gets joined too; ask herdr (`pane layout`) for the width if that bites.
export function unwrapCopied(text: string, pane: PaneGeometry = {}): string {
  const lines = text.split("\n");
  const widths = lines.map((l) => textWidth(l.trimEnd()));
  // A selection started mid-line holds only the end of its first line.
  widths[0] += pane.startCol ?? 0;
  const widest = pane.width ?? Math.max(...widths);
  if (pane.width === undefined && widest < MIN_WRAP_WIDTH) return text;
  const out = [lines[0]];
  for (let i = 1; i < lines.length; i++) {
    const next = lines[i];
    const prev = out[out.length - 1].trimEnd();
    const rest = next.trimStart();
    if (next.trim() === "" || STARTS_OWN_LINE.test(next)) {
      out.push(next);
      continue;
    }
    const row = i === lines.length - 1 ? pane.endRowText : undefined;
    const join = pane.width === undefined ? joinByWidest(prev, rest, widths[i - 1], widest) : joinByPane(prev, rest, widths[i - 1], pane.width - PANE_MARGIN, row);
    if (join === null) out.push(next);
    else out[out.length - 1] = prev + join + rest;
  }
  return out.join("\n");
}

/** A cell of the terminal, from zero. */
export interface Cell {
  col: number;
  row: number;
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A herdr tab's layout, from `herdr api snapshot`: the panes' rects within its area. */
export interface HerdrLayout {
  area: Rect;
  panes: { rect: Rect }[];
}

/** Two cells of a selection, the one it starts at first. */
export function inOrder(a: Cell, b: Cell): [Cell, Cell] {
  return a.row < b.row || (a.row === b.row && a.col <= b.col) ? [a, b] : [b, a];
}

// ponytail: herdr draws a sidebar left of its area and a tab bar above it; those widths are
// taken as what the client's size leaves over, so a sidebar on the right or a bottom tab bar is off.
/**
 * The geometry of the pane a selection started in, for `unwrapCopied`: the pane's
 * width and the column the selection began at, counted from the pane's left.
 * Undefined when the start is outside every pane.
 */
export function paneGeometry(layout: HerdrLayout, client: { cols: number; rows: number }, a: Cell, b: Cell): PaneGeometry | undefined {
  const [start] = inOrder(a, b);
  const col = start.col - (client.cols - layout.area.width) - layout.area.x;
  const row = start.row - (client.rows - layout.area.height) - layout.area.y;
  const pane = layout.panes.find(({ rect: r }) => col >= r.x && col < r.x + r.width && row >= r.y && row < r.y + r.height);
  return pane && { width: pane.rect.width, startCol: col - pane.rect.x };
}
