import { test } from "node:test";
import assert from "node:assert/strict";
import type { SlackMessage, SlackThread } from "./api.ts";
import { slackItems } from "./slackItems.ts";

const mention = (ts: string, patch: Partial<SlackMessage> = {}): SlackMessage => ({
  channel: "C1",
  ts,
  thread_ts: "100.0",
  channel_name: "dev",
  user_name: "鈴木",
  text: `mention ${ts}`,
  permalink: `https://x/${ts}`,
  via: null,
  user_image: null,
  read: false,
  ...patch,
});

const thread = (latest: string, patch: Partial<SlackThread> = {}): SlackThread => ({
  channel: "C1",
  thread_ts: "100.0",
  channel_name: "dev",
  permalink: "https://x/100",
  latest_ts: latest,
  latest_user_name: "佐藤",
  latest_text: `reply ${latest}`,
  latest_image: null,
  new_replies: 2,
  ...patch,
});

test("two mentions in one thread make one row, the latest shown", () => {
  const items = slackItems([mention("101.0"), mention("102.0")], []);
  assert.equal(items.length, 1);
  assert.equal(items[0].ts, "102.0");
  assert.equal(items[0].text, "mention 102.0");
  assert.deepEqual(items[0].mentions.map((m) => m.ts), ["101.0", "102.0"]);
  assert.equal(items[0].read, false);
  assert.equal(items[0].mention, true);
});

test("a mention and new replies in its thread make one row", () => {
  const [item, ...rest] = slackItems([mention("101.0")], [thread("103.0")]);
  assert.equal(rest.length, 0);
  assert.equal(item.ts, "103.0", "the reply is newer");
  assert.equal(item.userName, "佐藤");
  assert.equal(item.newReplies, 2);
  assert.equal(item.mention, true, "it still mentions the user");
  assert.equal(slackItems([mention("104.0")], [thread("103.0")])[0].ts, "104.0", "the mention is newer");
});

test("a thread with replies alone is no mention", () => {
  const [item] = slackItems([], [thread("103.0")]);
  assert.equal(item.mention, false);
  assert.deepEqual(item.mentions, []);
});

test("a row shows its latest unread message, not a newer read one", () => {
  const [item] = slackItems([mention("101.0"), mention("105.0", { read: true })], []);
  assert.equal(item.ts, "101.0");
  assert.equal(item.read, false);
  assert.equal(item.mentions.length, 2, "both, to be read or let go together");
});

test("a thread read through is a read row", () => {
  const [item] = slackItems([mention("101.0", { read: true }), mention("102.0", { read: true })], []);
  assert.equal(item.read, true);
  assert.equal(item.ts, "102.0");
});

test("a mention in the channel and the replies to it share a row", () => {
  const items = slackItems([mention("100.0", { thread_ts: null })], [thread("103.0")]);
  assert.equal(items.length, 1);
  assert.equal(items[0].threadTs, "100.0");
});

test("a group's mention is told by its group, unless the user is mentioned too", () => {
  assert.equal(slackItems([mention("101.0", { via: "soc" })], [])[0].via, "soc");
  assert.equal(slackItems([mention("101.0", { via: "soc" }), mention("102.0")], [])[0].via, null);
});

test("rows of different threads stay apart, the newest first", () => {
  const items = slackItems([mention("101.0"), mention("200.0", { thread_ts: "150.0" })], [thread("103.0", { thread_ts: "90.0" })]);
  assert.deepEqual(items.map((i) => i.ts), ["200.0", "103.0", "101.0"]);
});
