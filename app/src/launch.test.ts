import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_LAUNCH, effectiveLaunch, launchPrefsFrom, planByDefault } from "./launch.ts";

test("planning is Claude in herdr, whatever was picked", () => {
  assert.deepEqual(effectiveLaunch({ runner: "cloud", agent: "codex", model: "m", effort: "high" }, true), { runner: "herdr", agent: "claude", model: "m", effort: "high" });
});

test("Codex runs in herdr", () => {
  assert.equal(effectiveLaunch({ ...DEFAULT_LAUNCH, runner: "cloud", agent: "codex" }, false).runner, "herdr");
  assert.deepEqual(effectiveLaunch({ ...DEFAULT_LAUNCH, runner: "cloud" }, false), { ...DEFAULT_LAUNCH, runner: "cloud" });
});

test("a todo across two GitHub repositories is planned by default", () => {
  assert.ok(planByDefault({ repos: ["o/a", "o/b"] }));
  assert.ok(!planByDefault({ repos: ["o/a", "調査"] }));
  assert.ok(!planByDefault({ repos: [] }));
});

test("the last settings are kept apart for planning and not", () => {
  const saved = { plan: { ...DEFAULT_LAUNCH, model: "opus" }, direct: { ...DEFAULT_LAUNCH, runner: "herdr" as const } };
  assert.deepEqual(launchPrefsFrom(saved, null), saved);
});

test("the launch sheet's choice from before carries over", () => {
  const prefs = launchPrefsFrom(null, { target: "terminal", agent: "codex", model: "", effort: "high" });
  assert.deepEqual(prefs.direct, { runner: "herdr", agent: "codex", model: "", effort: "high" });
  assert.equal(launchPrefsFrom(null, { target: "web", model: "sonnet", effort: "" }).direct.runner, "cloud");
  assert.deepEqual(launchPrefsFrom(null, null).plan, DEFAULT_LAUNCH);
});
