// An order kept by hand (作業's list): the keys as moved, kept apart from
// the components so it can be tested.

/// `items` as ordered by hand: those never moved first, as they come (the
/// newest work on top), then the rest by `order`.
export function arrange<T>(items: T[], keyOf: (item: T) => string, order: string[]): T[] {
  const rank = (item: T) => order.indexOf(keyOf(item));
  return [...items].sort((a, b) => rank(a) - rank(b));
}

/// `order` with `key` moved to where `to` is among `keys` (one section as
/// arranged), which is kept whole in its new order.
export function moveTo(order: string[], keys: string[], key: string, to: string): string[] {
  const next = keys.filter((k) => k !== key);
  next.splice(keys.indexOf(to), 0, key);
  return [...order.filter((k) => !keys.includes(k)), ...next];
}
