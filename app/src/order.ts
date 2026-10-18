// 作業's list's orders: by hand (the keys as moved), or by a time, kept
// apart from the components so they can be tested.

/// `items` as ordered by hand: those never moved first, as they come (the
/// newest work on top), then the rest by `order`.
export function arrange<T>(items: T[], keyOf: (item: T) => string, order: string[]): T[] {
  const rank = (item: T) => order.indexOf(keyOf(item));
  return [...items].sort((a, b) => rank(a) - rank(b));
}

/// `items` by a time of theirs, the latest first (as they come on a tie).
export function latestFirst<T>(items: T[], timeOf: (item: T) => number): T[] {
  return [...items].sort((a, b) => timeOf(b) - timeOf(a));
}

/// `order` with `key` moved to where `to` is among `keys` (one section as
/// arranged), which is kept whole in its new order.
export function moveTo(order: string[], keys: string[], key: string, to: string): string[] {
  const next = keys.filter((k) => k !== key);
  next.splice(keys.indexOf(to), 0, key);
  return [...order.filter((k) => !keys.includes(k)), ...next];
}

const DAY_MS = 86_400_000;
/// How far back "この1週間" and "この1ヶ月" reach, in days.
const WEEK_DAYS = 7;
const MONTH_DAYS = 30;

/// The span `time` (unix seconds) falls in, by the local date, as 作業's list heads it.
export function ageGroup(time: number, now: Date): string {
  const dayOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((dayOf(now) - dayOf(new Date(time * 1000))) / DAY_MS);
  return days <= 0 ? "今日" : days === 1 ? "昨日" : days <= WEEK_DAYS ? "この1週間" : days <= MONTH_DAYS ? "この1ヶ月" : "1ヶ月以上前";
}
