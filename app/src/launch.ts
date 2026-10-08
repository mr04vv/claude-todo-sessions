// How a todo's session starts: where it runs (Cloud, or herdr on the Mac),
// what runs it, with which model and effort. The last settings are kept,
// apart for planning (splitting into subtasks) and for implementing.
import type { Agent } from "./api";

export type LaunchRunner = "cloud" | "herdr";

export interface Launch {
  runner: LaunchRunner;
  agent: Agent;
  /// Blank keeps the default.
  model: string;
  effort: string;
}

export interface LaunchPrefs {
  plan: Launch;
  direct: Launch;
}

export const DEFAULT_LAUNCH: Launch = { runner: "cloud", agent: "claude", model: "", effort: "" };

/// What a start really uses: planning is Claude in herdr (it makes the
/// subtasks through the Mac's MCP server, asking with AskUserQuestion), and
/// Codex runs in herdr only.
export function effectiveLaunch(l: Launch, plan: boolean): Launch {
  if (plan) return { ...l, runner: "herdr", agent: "claude" };
  if (l.agent === "codex") return { ...l, runner: "herdr" };
  return l;
}

/// A todo across several GitHub repositories is planned unless told otherwise.
export const planByDefault = (todo: { repos: string[] }) => todo.repos.filter((r) => r.includes("/")).length > 1;

/// The launch sheet's choice before the settings were kept apart: where (a
/// target) and with what.
interface OldChoice {
  target?: string;
  agent?: Agent;
  model?: string;
  effort?: string;
}

/// The kept settings, else the old launch sheet's choice as the implementing one.
export function launchPrefsFrom(saved: Partial<LaunchPrefs> | null, old: OldChoice | null): LaunchPrefs {
  if (saved) return { plan: { ...DEFAULT_LAUNCH, ...saved.plan }, direct: { ...DEFAULT_LAUNCH, ...saved.direct } };
  const direct: Launch = old
    ? { runner: old.target === "terminal" || old.target === "desktop" ? "herdr" : "cloud", agent: old.agent ?? "claude", model: old.model ?? "", effort: old.effort ?? "" }
    : DEFAULT_LAUNCH;
  return { plan: DEFAULT_LAUNCH, direct };
}
