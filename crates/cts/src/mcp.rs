use cts_core::{NewTodo, Status, TodoPatch};

use crate::orchestra;
use rmcp::{
    handler::server::{router::tool::ToolRouter, wrapper::Parameters},
    model::{ServerCapabilities, ServerConfig},
    tool, tool_handler, tool_router, ServerHandler, ServiceExt,
};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

const INSTRUCTIONS: &str = "Manage todos linked to Claude Code sessions, and orchestrate a parent todo's subtasks \
(set_plan, start_subtask, reply_to_subtask, fix_subtask, escalate, log_progress). \
The current session_id is given in the session context by the SessionStart hook.";

#[derive(Deserialize, JsonSchema)]
struct ListArgs {
    /// Filter by status: backlog, todo, doing, review, pending or done.
    status: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
struct IdArgs {
    id: i64,
}

#[derive(Deserialize, JsonSchema)]
struct CreateArgs {
    title: String,
    /// GitHub issue or PR URL.
    issue_url: Option<String>,
    /// Working directory for sessions started from this todo.
    cwd: Option<String>,
    /// Markdown memo.
    memo: Option<String>,
    /// Repositories as owner/repo; the first is the main one.
    repos: Option<Vec<String>>,
    /// The parent todo this one is a subtask of (an orchestrator, or any todo).
    parent_id: Option<i64>,
}

#[derive(Deserialize, JsonSchema)]
struct UpdateArgs {
    id: i64,
    title: Option<String>,
    /// backlog, todo, doing, review, pending or done.
    status: Option<String>,
    memo: Option<String>,
    cwd: Option<String>,
    /// Repositories as owner/repo; an empty list clears them.
    repos: Option<Vec<String>>,
    /// First prompt for sessions started from this todo (after the [todo:N] marker); blank resets to the title.
    prompt: Option<String>,
    /// The pull request this todo ships as; blank unlinks it.
    pr_url: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
struct LinkArgs {
    session_id: String,
    todo_id: i64,
}

#[derive(Deserialize, JsonSchema)]
struct SessionArgs {
    session_id: String,
}

#[derive(Deserialize, JsonSchema)]
struct PlanArgs {
    /// The parent todo.
    todo_id: i64,
    /// The plan in Markdown: the approach, what was decided, when it is done.
    plan: String,
}

#[derive(Deserialize, JsonSchema)]
struct StartArgs {
    /// The subtask to start.
    todo_id: i64,
    /// true: on Cloud, false: in herdr on this Mac. Default: Cloud when the
    /// subtask has a GitHub repository, else herdr. Codex runs in herdr only.
    cloud: Option<bool>,
    /// claude (default) or codex.
    agent: Option<String>,
    /// Model and effort; blank keeps the default.
    model: Option<String>,
    effort: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
struct TextArgs {
    /// The subtask (or, for log_progress, the parent) todo.
    todo_id: i64,
    text: String,
}

#[derive(Serialize)]
struct TodoWithSessions {
    #[serde(flatten)]
    todo: cts_core::Todo,
    sessions: Vec<cts_core::Session>,
}

fn parse_status(s: Option<String>) -> Result<Option<Status>, String> {
    s.map(|s| {
        serde_json::from_value(serde_json::Value::String(s.clone()))
            .map_err(|_| format!("invalid status {s:?}: expected backlog, todo, doing, review, pending or done"))
    })
    .transpose()
}

fn json<T: Serialize>(v: &T) -> Result<String, String> {
    serde_json::to_string_pretty(v).map_err(|e| e.to_string())
}

fn db() -> Result<cts_core::Db, String> {
    crate::open_db()
}

#[derive(Clone)]
struct Server {
    tool_router: ToolRouter<Self>,
}

#[tool_router]
impl Server {
    fn new() -> Self {
        Self { tool_router: Self::tool_router() }
    }

    #[tool(description = "List todos, newest first.")]
    async fn list_todos(&self, Parameters(a): Parameters<ListArgs>) -> Result<String, String> {
        json(&db()?.list_todos(parse_status(a.status)?).map_err(|e| e.to_string())?)
    }

    #[tool(description = "Get a todo with its linked sessions.")]
    async fn get_todo(&self, Parameters(a): Parameters<IdArgs>) -> Result<String, String> {
        let db = db()?;
        let todo = db
            .get_todo(a.id)
            .map_err(|e| e.to_string())?
            .ok_or(format!("todo {} not found", a.id))?;
        let sessions = db.sessions_for_todo(a.id).map_err(|e| e.to_string())?;
        json(&TodoWithSessions { todo, sessions })
    }

    #[tool(description = "Create a todo.")]
    async fn create_todo(&self, Parameters(a): Parameters<CreateArgs>) -> Result<String, String> {
        let t = NewTodo { parent_id: a.parent_id, title: a.title, issue_url: a.issue_url, cwd: a.cwd, memo: a.memo, repos: a.repos.unwrap_or_default() };
        json(&db()?.create_todo(t).map_err(|e| e.to_string())?)
    }

    #[tool(description = "Update a todo's title, status, memo or cwd. Omitted fields are unchanged.")]
    async fn update_todo(&self, Parameters(a): Parameters<UpdateArgs>) -> Result<String, String> {
        let p = TodoPatch { title: a.title, status: parse_status(a.status)?, memo: a.memo, cwd: a.cwd, issue_url: None, repos: a.repos, prompt: a.prompt, pr_url: a.pr_url };
        json(&db()?.update_todo(a.id, p).map_err(|e| e.to_string())?)
    }

    #[tool(description = "Link a session to a todo and mark the todo doing.")]
    async fn link_session(&self, Parameters(a): Parameters<LinkArgs>) -> Result<String, String> {
        db()?.link_session(&a.session_id, a.todo_id).map_err(|e| e.to_string())?;
        Ok(format!("linked session {} to todo {}", a.session_id, a.todo_id))
    }

    #[tool(description = "Unlink a session from its todo.")]
    async fn unlink_session(&self, Parameters(a): Parameters<SessionArgs>) -> Result<String, String> {
        db()?.unlink_session(&a.session_id).map_err(|e| e.to_string())?;
        Ok(format!("unlinked session {}", a.session_id))
    }

    #[tool(description = "Keep a parent todo's plan (shared memory): every subtask's session starts knowing it, and the user sees and edits it. Blank clears it.")]
    async fn set_plan(&self, Parameters(a): Parameters<PlanArgs>) -> Result<String, String> {
        let db = db()?;
        db.set_plan(a.todo_id, &a.plan).map_err(|e| e.to_string())?;
        db.add_event(a.todo_id, "計画を書きました").map_err(|e| e.to_string())?;
        Ok(format!("kept the plan of todo {}", a.todo_id))
    }

    #[tool(description = "Start a subtask's session, behind (nothing comes forward): on Cloud or in a new herdr workspace on this Mac, linked to the subtask. Ask the user where (AskUserQuestion) before starting.")]
    async fn start_subtask(&self, Parameters(a): Parameters<StartArgs>) -> Result<String, String> {
        orchestra::start_subtask(a.todo_id, a.cloud, a.agent.as_deref(), a.model, a.effort)
    }

    #[tool(description = "Send text into a subtask's herdr pane, as if typed and sent with Enter (an answer, or something to tell it). Read its pane first when it shows a question with choices. A Cloud subtask cannot be sent anything: escalate instead, with the answer you propose.")]
    async fn reply_to_subtask(&self, Parameters(a): Parameters<TextArgs>) -> Result<String, String> {
        orchestra::reply(a.todo_id, &a.text)
    }

    #[tool(description = "Have a subtask's session fix its PR (the CI's failed checks, the changes a reviewer asked for). After two fixes the CI still failing goes to the user instead.")]
    async fn fix_subtask(&self, Parameters(a): Parameters<IdArgs>) -> Result<String, String> {
        orchestra::fix(a.id)
    }

    #[tool(description = "Hand a subtask to the user (it waits on them, and they are notified), with why: a choice the plan does not cover, money, permissions or deleting data, a CI still failing after two fixes, or an answer you propose for a Cloud subtask.")]
    async fn escalate(&self, Parameters(a): Parameters<TextArgs>) -> Result<String, String> {
        orchestra::escalate(a.todo_id, &a.text)
    }

    #[tool(description = "Write what you did or decided in the parent todo's 経過 (the user reads it there).")]
    async fn log_progress(&self, Parameters(a): Parameters<TextArgs>) -> Result<String, String> {
        db()?.add_event(a.todo_id, &a.text).map_err(|e| e.to_string())?;
        Ok("logged".into())
    }
}

#[tool_handler(router = self.tool_router)]
impl ServerHandler for Server {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build())
            .with_instructions(INSTRUCTIONS)
    }
}

pub fn run() -> Result<(), String> {
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| e.to_string())?;
    rt.block_on(async {
        let service = Server::new()
            .serve(rmcp::transport::stdio())
            .await
            .map_err(|e| e.to_string())?;
        service.waiting().await.map_err(|e| e.to_string())?;
        Ok(())
    })
}
