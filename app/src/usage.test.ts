import { test } from "node:test";
import assert from "node:assert/strict";
import { jevBalance, shortMoney } from "./usage.ts";

test("Jev's credit left is what the console left, less what this app spent since", () => {
  const credit = { credit: 5, spent: 0.1727, base_usd: 0.01, at: 0 };
  assert.equal(jevBalance(credit, 0.05).toFixed(4), "4.7873");
  assert.equal(jevBalance(credit, 0.01).toFixed(4), "4.8273", "nothing spent since: as the console left it");
});

test("money in the rail is short: whole dollars from a hundred, cents below", () => {
  assert.equal(shortMoney(8000, "USD"), "$8,000");
  assert.equal(shortMoney(110.87, "USD"), "$111");
  assert.equal(shortMoney(12.3, "USD"), "$12.30");
});
