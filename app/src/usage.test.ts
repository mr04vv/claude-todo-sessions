import { test } from "node:test";
import assert from "node:assert/strict";
import { shortMoney } from "./usage.ts";

test("money in the rail is short: whole dollars from a hundred, cents below", () => {
  assert.equal(shortMoney(8000, "USD"), "$8,000");
  assert.equal(shortMoney(110.87, "USD"), "$111");
  assert.equal(shortMoney(12.3, "USD"), "$12.30");
});
