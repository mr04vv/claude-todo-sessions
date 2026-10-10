// Slack's message markup (mrkdwn) as blocks and inline pieces for the page
// to render: mentions, channels and links from Slack's angle brackets,
// bold / italic / strike / code, code blocks and quotes, and the common
// emoji names as emoji.

export type Inline =
  | { t: "text"; v: string }
  | { t: "mention"; v: string; me: boolean }
  | { t: "channel"; v: string }
  | { t: "link"; url: string; label: string }
  | { t: "code"; v: string }
  | { t: "b" | "i" | "s"; c: Inline[] }
  | { t: "emoji"; v: string };

export type Block = { t: "p"; c: Inline[] } | { t: "pre"; v: string } | { t: "quote"; c: Inline[] };

/// The emoji names used most at work; the rest stay as `:name:`.
// ponytail: a short list, the full emoji table if names show often.
const EMOJI: Record<string, string> = {
  "+1": "👍", thumbsup: "👍", "-1": "👎", pray: "🙏", bow: "🙇", eyes: "👀", white_check_mark: "✅", heavy_check_mark: "✔️",
  tada: "🎉", smile: "😄", smiley: "😃", grin: "😁", joy: "😂", sweat_smile: "😅", sob: "😭", cry: "😢", thinking_face: "🤔",
  ok_hand: "👌", raised_hands: "🙌", clap: "👏", muscle: "💪", fire: "🔥", rocket: "🚀", warning: "⚠️", x: "❌", heart: "❤️",
  "100": "💯", sparkles: "✨", bulb: "💡", memo: "📝", point_up: "☝️", wave: "👋", ok: "🆗", sunglasses: "😎",
  slightly_smiling_face: "🙂", innocent: "😇", rotating_light: "🚨", star: "⭐", zap: "⚡", hugging_face: "🤗",
};

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
  const re = /(^|[^0-9]):([a-z0-9_+'-]*[a-z+][a-z0-9_+'-]*):/g;
  let at = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const start = m.index + m[1].length;
    push(out, { t: "text", v: text.slice(at, start) });
    push(out, { t: "emoji", v: EMOJI[m[2]] ?? `:${m[2]}:` });
    at = start + m[2].length + 2;
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
