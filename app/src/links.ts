// Web addresses in a terminal's text: what ⌘-click opens there, and the
// list of them ⌘⇧L offers.

/// Up to a space, a quote, or a Japanese bracket or mark.
const URL_RE = /https?:\/\/[^\s<>"'`、。「」『』（）【】]+/g;
/// What a sentence puts after an address, not the address's.
const TRAILING = /[.,;:!?]+$/;
const BRACKETS: [string, string][] = [
  ["(", ")"],
  ["[", "]"],
  ["{", "}"],
];

const count = (s: string, c: string) => s.split(c).length - 1;

/// A closing bracket ends an address unless the address opened it (a
/// Wikipedia page's "Foo_(bar)").
function trimUrl(url: string) {
  let u = url.replace(TRAILING, "");
  for (const [open, close] of BRACKETS) {
    while (u.endsWith(close) && count(u, open) < count(u, close)) u = u.slice(0, -1).replace(TRAILING, "");
  }
  return u;
}

/// The addresses in `text`, with where each starts.
export function findUrls(text: string): { url: string; index: number }[] {
  return [...text.matchAll(URL_RE)].map((m) => ({ url: trimUrl(m[0]), index: m.index }));
}
