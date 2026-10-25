import { test } from "node:test";
import assert from "node:assert/strict";
import { osc52Text } from "./osc52.ts";

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

test("an OSC 52 write gives its text, multibyte included", () => {
  assert.equal(osc52Text(`c;${b64("こんにちは herdr")}`), "こんにちは herdr");
  assert.equal(osc52Text(`;${b64("x")}`), "x");
});

test("a query, a malformed write or no target gives nothing", () => {
  assert.equal(osc52Text("c;?"), null);
  assert.equal(osc52Text("c;not base64!"), null);
  assert.equal(osc52Text("nosemicolon"), null);
});
