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
