// The Slack page's rows: one per thread (a message in no thread is its
// own), gathering its mentions of the user (#27) and its new replies (#28),
// shown by its latest unread message. Done or let go, a row takes them all.
import type { SlackMessage, SlackThread } from "./api";

export interface SlackItem {
  key: string;
  /// A message the user just posted shows its thread too.
  kind: "thread" | "posted";
  channel: string;
  /// The thread it opens.
  threadTs: string;
  /// The message it shows: its latest unread one (its latest, read).
  ts: string;
  channelName: string;
  userName: string;
  userImage: string | null;
  text: string;
  permalink: string;
  /// It mentions the user (or one of their groups).
  mention: boolean;
  /// The group mentioned, when only groups are.
  via: string | null;
  newReplies: number;
  read: boolean;
  /// The mentions it gathers, read or not, to read or let go together.
  mentions: { channel: string; ts: string }[];
}

/// The message a row shows: a mention, or a thread's latest reply.
interface Shown {
  ts: string;
  channelName: string;
  userName: string;
  userImage: string | null;
  text: string;
  permalink: string;
}

const newest = <T extends { ts: string }>(xs: T[]) => xs.reduce<T | undefined>((a, x) => (!a || Number(x.ts) > Number(a.ts) ? x : a), undefined);

export function slackItems(messages: SlackMessage[], threads: SlackThread[]): SlackItem[] {
  const groups = new Map<string, { channel: string; threadTs: string; mentions: SlackMessage[]; thread?: SlackThread }>();
  const groupOf = (channel: string, threadTs: string) => {
    const key = `t:${channel}:${threadTs}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { channel, threadTs, mentions: [] }));
    return g;
  };
  for (const m of messages) groupOf(m.channel, m.thread_ts ?? m.ts).mentions.push(m);
  for (const t of threads) groupOf(t.channel, t.thread_ts).thread = t;
  const items = [...groups.entries()].map(([key, g]): SlackItem => {
    const unread = g.mentions.filter((m) => !m.read);
    const reply: Shown | undefined =
      g.thread && g.thread.new_replies > 0
        ? {
            ts: g.thread.latest_ts ?? g.thread.thread_ts,
            channelName: g.thread.channel_name,
            userName: g.thread.latest_user_name ?? "",
            userImage: g.thread.latest_image,
            text: g.thread.latest_text ?? "",
            permalink: g.thread.permalink,
          }
        : undefined;
    const asShown = (m: SlackMessage): Shown => ({ ts: m.ts, channelName: m.channel_name, userName: m.user_name, userImage: m.user_image, text: m.text, permalink: m.permalink });
    const isRead = unread.length === 0 && !reply;
    const pool: Shown[] = isRead ? g.mentions.map(asShown) : [...unread.map(asShown), ...(reply ? [reply] : [])];
    const shown = newest(pool)!;
    const mentioning = isRead ? g.mentions : unread;
    return {
      key,
      kind: "thread",
      channel: g.channel,
      threadTs: g.threadTs,
      ...shown,
      mention: mentioning.length > 0,
      via: mentioning.length === 0 || mentioning.some((m) => m.via === null) ? null : (newest(mentioning)?.via ?? null),
      newReplies: g.thread?.new_replies ?? 0,
      read: isRead,
      mentions: g.mentions.map((m) => ({ channel: m.channel, ts: m.ts })),
    };
  });
  return items.sort((a, b) => Number(b.ts) - Number(a.ts));
}
