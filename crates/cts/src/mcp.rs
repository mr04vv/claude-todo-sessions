use cts_core::{NewTodo, Status, TodoPatch};
use rmcp::{
    handler::server::{router::tool::ToolRouter, wrapper::Parameters},
    model::{ServerCapabilities, ServerConfig},
    tool, tool_handler, tool_router, ServerHandler, ServiceExt,
};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

const INSTRUCTIONS: &str = "Manage todos linked to Claude Code sessions. \
The current session_id is given in the session context by the SessionStart hook.";

#[derive(Deserialize, JsonSchema)]
struct ListArgs {
    /// Filter by status: todo, doing, review or done.
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
    /// True for a research task (asks for completion/output conditions); default is implementation.
    research: Option<bool>,
    /// The orchestrator todo this one implements a part of.
    parent_id: Option<i64>,
}

#[derive(Deserialize, JsonSchema)]
struct UpdateArgs {
    id: i64,
    title: Option<String>,
    /// todo, doing, review or done.
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

#[derive(Serialize)]
struct TodoWithSessions {
    #[serde(flatten)]
    todo: cts_core::Todo,
    sessions: Vec<cts_core::Session>,
}

fn parse_status(s: Option<String>) -> Result<Option<Status>, String> {
    s.map(|s| {
        serde_json::from_value(serde_json::Value::String(s.clone()))
            .map_err(|_| format!("invalid status {s:?}: expected todo, doing, review or done"))
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
        let kind = if a.research.unwrap_or(false) { cts_core::Kind::Research } else { cts_core::Kind::Implementation };
        let t = NewTodo { kind, parent_id: a.parent_id, title: a.title, issue_url: a.issue_url, cwd: a.cwd, memo: a.memo, repos: a.repos.unwrap_or_default() };
        json(&db()?.create_todo(t).map_err(|e| e.to_string())?)
    }

    #[tool(description = "Update a todo's title, status, memo or cwd. Omitted fields are unchanged.")]
    async fn update_todo(&self, Parameters(a): Parameters<UpdateArgs>) -> Result<String, String> {
        let p = TodoPatch { title: a.title, status: parse_status(a.status)?, memo: a.memo, cwd: a.cwd, issue_url: None, repos: a.repos, prompt: a.prompt, pr_url: a.pr_url, kind: None };
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
