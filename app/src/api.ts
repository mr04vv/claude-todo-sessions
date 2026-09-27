import { invoke } from "@tauri-apps/api/core";

export type Status = "todo" | "doing" | "review" | "done";
export type SessionState = "running" | "needs_input" | "idle" | "ended";

export interface Session {
  session_id: string;
  title: string | null;
  todo_id: number | null;
  cwd: string;
  state: SessionState;
  state_at: number;
  /** `owner/repo` list; the first is where the session pushes. Present on inbox sessions. */
  repos?: string[];
}

export interface Todo {
  id: number;
  title: string;
  status: Status;
  issue_url: string | null;
  cwd: string | null;
  memo: string | null;
  updated_at: number;
  sessions: Session[];
  /** `owner/repo` list: the todo's own, else derived from the issue URL or the working folder. */
  repos: string[];
  /** True when `repos` was derived rather than set on the todo. */
  repos_derived: boolean;
  /** First prompt for sessions started from this todo; null means the title. */
  prompt: string | null;
  issue_state: "open" | "closed" | null;
  pr_url: string | null;
  pr_state: PrState | null;
  queue_runner: Runner | null;
  queue_error: string | null;
  queue_pos: number | null;
  kind: Kind;
  prompt_preview: string;
  parent_id: number | null;
  is_orchestrator: boolean;
}

export type PrState = "draft" | "open" | "review_requested" | "changes_requested" | "approved" | "merged" | "closed";

export type Runner = "auto" | "cloud" | "local";
export type Kind = "implementation" | "research";

export interface Board {
  todos: Todo[];
  inbox: Session[];
  sync_status: string;
  loop_enabled: boolean;
}

export interface TodoInput {
  title: string;
  issue_url?: string;
  cwd?: string;
  memo?: string;
  repos?: string[];
  kind?: Kind;
  parent_id?: number;
}

export interface TodoUpdate {
  title?: string;
  status?: Status;
  memo?: string;
  cwd?: string;
  issue_url?: string;
  repos?: string[];
  prompt?: string;
  pr_url?: string;
  kind?: Kind;
}

export interface Issue {
  number: number;
  title: string;
  url: string;
  repo: string;
  updated_at: string;
  cwd: string | null;
}

export interface IssueImport {
  title: string;
  url: string;
  cwd?: string;
}

export interface LocalRepo {
  key: string;
  path: string;
}

export const api = {
  localRepos: () => invoke<LocalRepo[]>("local_repos"),
  createIssue: (todoId: number) => invoke<Todo>("create_issue", { todoId }),
  closeIssue: (todoId: number) => invoke<void>("close_issue", { todoId }),
  enqueue: (todoId: number, runner: Runner) => invoke<void>("enqueue", { todoId, runner }),
  dequeue: (todoId: number) => invoke<void>("dequeue", { todoId }),
  moveInQueue: (todoId: number, delta: number) => invoke<void>("move_in_queue", { todoId, delta }),
  setLoopEnabled: (enabled: boolean) => invoke<void>("set_loop_enabled", { enabled }),
  ghIssues: () => invoke<Issue[]>("gh_issues"),
  importIssues: (issues: IssueImport[]) => invoke<number>("import_issues", { issues }),
  board: () => invoke<Board>("board"),
  createTodo: (input: TodoInput) => invoke<Todo>("create_todo", { input }),
  updateTodo: (id: number, update: TodoUpdate) => invoke<Todo>("update_todo", { id, update }),
  deleteTodo: (id: number) => invoke<void>("delete_todo", { id }),
  linkSession: (sessionId: string, todoId: number) => invoke<void>("link_session", { sessionId, todoId }),
  unlinkSession: (sessionId: string) => invoke<void>("unlink_session", { sessionId }),
  quickClaude: (prompt: string) => invoke<void>("quick_claude", { prompt }),
  syncNow: (todoId?: number) => invoke<void>("sync_now", { todoId: todoId ?? null }),
  openGithub: (url: string) => invoke<void>("open_github", { url }),
  openSession: (sessionId: string, target?: "desktop" | "herdr") => invoke<void>("open_session", { sessionId, target }),
  startDesktop: (todoId: number) => invoke<void>("start_desktop", { todoId }),
  startTerminal: (todoId: number) => invoke<void>("start_terminal", { todoId }),
  startCloud: (todoId: number) => invoke<void>("start_cloud", { todoId }),
};

export const isCloud = (s: Session) => s.session_id.startsWith("cse_");

/** `owner/repo#123` from a GitHub issue or PR URL, or null. */
export function issueRef(url: string | null): string | null {
  const m = url?.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/(?:issues|pull)\/(\d+)/);
  return m ? `${m[1]}#${m[2]}` : null;
}

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Relative time like "3分前" for a unix timestamp in seconds. */
export function ago(unixSeconds: number): string {
  const s = Math.max(0, Math.floor(Date.now() / 1000) - unixSeconds);
  if (s < MINUTE) return "たった今";
  if (s < HOUR) return `${Math.floor(s / MINUTE)}分前`;
  if (s < DAY) return `${Math.floor(s / HOUR)}時間前`;
  return `${Math.floor(s / DAY)}日前`;
}
