import { test } from "node:test";
import assert from "node:assert/strict";
import { emojiNames, parseSlack, slackPlain } from "./slackText.ts";

const inlines = (text: string, me?: string) => {
  const blocks = parseSlack(text, me);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].t, "p");
  return blocks[0].t === "p" ? blocks[0].c : [];
};

test("plain text stays, its entities decoded", () => {
  assert.deepEqual(inlines("a &lt; b &amp;&amp; c &gt; d"), [{ t: "text", v: "a < b && c > d" }]);
});

test("mentions, channels and links come out of Slack's angle brackets", () => {
  assert.deepEqual(inlines("<@U1|森> と <@U2> へ", "U1"), [
    { t: "mention", v: "森", me: true },
    { t: "text", v: " と " },
    { t: "mention", v: "U2", me: false },
    { t: "text", v: " へ" },
  ]);
  assert.deepEqual(inlines("<!subteam^S1|@web-team> <!here> <!channel|@channel>"), [
    { t: "mention", v: "web-team", me: false },
    { t: "text", v: " " },
    { t: "mention", v: "here", me: false },
    { t: "text", v: " " },
    { t: "mention", v: "channel", me: false },
  ]);
  assert.deepEqual(inlines("<#C1|dev-web> <#C2|>"), [{ t: "channel", v: "dev-web" }, { t: "text", v: " " }, { t: "channel", v: "C2" }]);
  assert.deepEqual(inlines("<https://github.com/acme/web/pull/57|PR #57> と <https://example.com>"), [
    { t: "link", url: "https://github.com/acme/web/pull/57", label: "PR #57" },
    { t: "text", v: " と " },
    { t: "link", url: "https://example.com", label: "https://example.com" },
  ]);
});

test("bold, italic, strike and code are told", () => {
  assert.deepEqual(inlines("これは *大事* で _少し_ と ~古い~ と `npm test`"), [
    { t: "text", v: "これは " },
    { t: "b", c: [{ t: "text", v: "大事" }] },
    { t: "text", v: " で " },
    { t: "i", c: [{ t: "text", v: "少し" }] },
    { t: "text", v: " と " },
    { t: "s", c: [{ t: "text", v: "古い" }] },
    { t: "text", v: " と " },
    { t: "code", v: "npm test" },
  ]);
  assert.deepEqual(inlines("2*3*4 と snake_case_name"), [{ t: "text", v: "2*3*4 と snake_case_name" }], "inside words, not formatting");
});

test("emoji names become the emoji; the workspace's own keep their names", () => {
  assert.deepEqual(inlines("了解 :+1: :white_check_mark: :custom-party:"), [
    { t: "text", v: "了解 " },
    { t: "emoji", v: "👍", name: "+1" },
    { t: "text", v: " " },
    { t: "emoji", v: "✅", name: "white_check_mark" },
    { t: "text", v: " " },
    { t: "emoji", v: ":custom-party:", name: "custom-party" },
  ]);
  assert.deepEqual(inlines("10:30 から"), [{ t: "text", v: "10:30 から" }], "a time is not an emoji");
});

test("a skin tone goes on the emoji before it", () => {
  assert.deepEqual(inlines(":+1::skin-tone-3:"), [{ t: "emoji", v: "👍🏼", name: "+1" }]);
});

test("emoji names are found by what they start with, then what they hold", () => {
  const names = emojiNames("thumbs");
  assert.ok(names.length > 0 && names.every((n) => n.name.includes("thumbs")));
  assert.equal(names[0].name.startsWith("thumbs"), true);
  assert.equal(emojiNames("pray")[0].emoji, "🙏");
});

test("code blocks and quotes are blocks of their own", () => {
  assert.deepEqual(parseSlack("見てください\n```\nfn main() {}\n```\n&gt; 引用です\n&gt; 二行目\nおわり"), [
    { t: "p", c: [{ t: "text", v: "見てください" }] },
    { t: "pre", v: "fn main() {}" },
    { t: "quote", c: [{ t: "text", v: "引用です\n二行目" }] },
    { t: "p", c: [{ t: "text", v: "おわり" }] },
  ]);
});

test("a message reads as plain text for a memo", () => {
  assert.equal(
    slackPlain("<@U1|森> *確認* お願いします :pray:\n<https://github.com/acme/web/pull/57|PR #57> と `npm test`\n&gt; 引用"),
    "@森 確認 お願いします 🙏\nPR #57 (https://github.com/acme/web/pull/57) と npm test\n> 引用",
  );
  assert.equal(slackPlain("```\nfn main() {}\n```"), "fn main() {}");
  assert.equal(slackPlain("<https://example.com>"), "https://example.com", "a bare link once");
});
