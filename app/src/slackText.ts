// Slack's message markup (mrkdwn) as blocks and inline pieces for the page
// to render: mentions, channels and links from Slack's angle brackets,
// bold / italic / strike / code, code blocks and quotes, and emoji names as
// emoji (the standard ones from gemoji, whose names are Slack's; the
// workspace's own are pictures the page looks up by name).

import { nameToEmoji } from "gemoji";

export type Inline =
  | { t: "text"; v: string }
  | { t: "mention"; v: string; me: boolean }
  | { t: "channel"; v: string }
  | { t: "link"; url: string; label: string }
  | { t: "code"; v: string }
  | { t: "b" | "i" | "s"; c: Inline[] }
  /// `v` is the emoji, or `:name:` for one of the workspace's own.
  | { t: "emoji"; v: string; name: string };

export type Block = { t: "p"; c: Inline[] } | { t: "pre"; v: string } | { t: "quote"; c: Inline[] };

/// Slack's skin tones, 2 to 6, as the modifiers that follow an emoji.
const SKIN_TONES: Record<string, string> = { "2": "🏻", "3": "🏼", "4": "🏽", "5": "🏾", "6": "🏿" };

/// The emoji names matching `query`: those starting with it first, then
/// those holding it; at most `limit`.
export function emojiNames(query: string, limit = 8): { name: string; emoji: string }[] {
  const q = query.toLowerCase();
  const all = Object.keys(nameToEmoji);
  const starting = all.filter((n) => n.startsWith(q));
  const holding = all.filter((n) => !n.startsWith(q) && n.includes(q));
  return [...starting, ...holding].slice(0, limit).map((name) => ({ name, emoji: nameToEmoji[name] }));
}

const decode = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

/// Appends, joining a text to the text before it.
function push(out: Inline[], piece: Inline) {
  const last = out[out.length - 1];
  if (piece.t === "text") {
    if (!piece.v) return;
    if (last?.t === "text") {
      last.v += piece.v;
      return;
    }
  }
  out.push(piece);
}

/// What one `<…>` stands for.
function entity(inner: string, me: string | undefined): Inline {
  const [target, label] = inner.includes("|") ? [inner.slice(0, inner.indexOf("|")), inner.slice(inner.indexOf("|") + 1)] : [inner, ""];
  if (target.startsWith("@")) return { t: "mention", v: label || target.slice(1), me: target.slice(1) === me };
  if (target.startsWith("!subteam^")) return { t: "mention", v: (label || target.slice("!subteam^".length)).replace(/^@/, ""), me: false };
  if (["!here", "!channel", "!everyone"].includes(target)) return { t: "mention", v: target.slice(1), me: false };
  if (target.startsWith("#")) return { t: "channel", v: label || target.slice(1) };
  if (/^(https?:|mailto:)/.test(target)) return { t: "link", url: target, label: decode(label || target) };
  if (target.startsWith("!") && label) return { t: "text", v: decode(label) };
  return { t: "text", v: `<${decode(inner)}>` };
}

/// Emoji names in plain text: a name with a letter (not a time like 10:30:45).
function emoji(text: string, out: Inline[]) {
  const re = /(?<![0-9]):([a-z0-9_+'-]*[a-z+][a-z0-9_+'-]*):/g;
  let at = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const start = m.index;
    push(out, { t: "text", v: text.slice(at, start) });
    const tone = /^skin-tone-([2-6])$/.exec(m[1]);
    const last = out[out.length - 1];
    if (tone && last?.t === "emoji" && start === at) last.v += SKIN_TONES[tone[1]];
    else if (!tone) push(out, { t: "emoji", v: nameToEmoji[m[1]] ?? `:${m[1]}:`, name: m[1] });
    at = start + m[1].length + 2;
    re.lastIndex = at;
  }
  push(out, { t: "text", v: text.slice(at) });
}

/// Bold, italic and strike, whose marks stand apart from letters and digits.
function formatting(text: string, out: Inline[]) {
  const re = /(^|[^A-Za-z0-9])([*_~])([^\s*_~](?:[^\n]*?[^\s])?)\2(?=$|[^A-Za-z0-9])/g;
  const kind = { "*": "b", _: "i", "~": "s" } as const;
  let at = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const start = m.index + m[1].length;
    emoji(text.slice(at, start), out);
    const inner: Inline[] = [];
    formatting(m[3], inner);
    push(out, { t: kind[m[2] as "*" | "_" | "~"], c: inner });
    at = start + m[3].length + 2;
    re.lastIndex = at;
  }
  emoji(text.slice(at), out);
}

function inline(text: string, me: string | undefined): Inline[] {
  const out: Inline[] = [];
  const re = /<([^<>\n]+)>|`([^`\n]+)`/g;
  let at = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    formatting(decode(text.slice(at, m.index)), out);
    push(out, m[1] !== undefined ? entity(m[1], me) : { t: "code", v: decode(m[2]) });
    at = m.index + m[0].length;
  }
  formatting(decode(text.slice(at)), out);
  return out;
}

const QUOTE = /^(&gt;|>) ?/;

/// A message's markup as blocks; `me` (the user's id) marks their mentions.
export function parseSlack(text: string, me?: string): Block[] {
  const blocks: Block[] = [];
  text.split("```").forEach((part, i) => {
    if (i % 2 === 1) {
      blocks.push({ t: "pre", v: decode(part.replace(/^\n/, "").replace(/\n$/, "")) });
      return;
    }
    let lines: string[] = [];
    let quoting = false;
    const flush = () => {
      const body = lines.join("\n").replace(/^\n+|\n+$/g, "");
      if (body) blocks.push({ t: quoting ? "quote" : "p", c: inline(body, me) });
      lines = [];
    };
    for (const line of part.split("\n")) {
      const quoted = QUOTE.test(line);
      if (quoted !== quoting) {
        flush();
        quoting = quoted;
      }
      lines.push(quoted ? line.replace(QUOTE, "") : line);
    }
    flush();
  });
  return blocks;
}

/// A message's markup as plain text (for a memo): mentions as @name, links
/// as their label and address, quotes marked with "> ".
export function slackPlain(text: string): string {
  const flat = (pieces: Inline[]): string =>
    pieces
      .map((p) => {
        switch (p.t) {
          case "text":
          case "code":
          case "emoji":
            return p.v;
          case "mention":
            return `@${p.v}`;
          case "channel":
            return `#${p.v}`;
          case "link":
            return p.label === p.url ? p.url : `${p.label} (${p.url})`;
          default:
            return flat(p.c);
        }
      })
      .join("");
  return parseSlack(text)
    .map((b) => (b.t === "pre" ? b.v : b.t === "quote" ? flat(b.c).split("\n").map((l) => `> ${l}`).join("\n") : flat(b.c)))
    .join("\n");
}
