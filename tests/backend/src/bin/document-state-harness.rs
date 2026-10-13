//! Browser-only harness for the production Core/server/state modules without a WebView.
use axum::{
    body::Body,
    extract::{Query, State},
    http::{header, Request, Response, StatusCode},
    middleware::{self, Next},
    response::Html,
    routing::get,
    Router,
};
use my_knowledge_backend_tests::{
    core::Core,
    document_server,
    document_state::DocumentState,
    state_inspection::live::Context,
    storage_limits,
    tree_mutations::{self, Mutation},
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    io::{BufRead, Write},
    path::PathBuf,
    sync::{Arc, Mutex},
};

#[derive(Clone)]
struct Grant {
    entry: String,
    url: String,
    request: u64,
}
struct Harness {
    core: Arc<Core>,
    workspace: String,
    view: String,
    shell_origin: String,
    grants: Mutex<HashMap<String, Grant>>,
}

impl Harness {
    fn open(&self, entry: &str) -> Result<Value, String> {
        let tab = self.core.create_tab(&self.workspace, &self.view, entry)?;
        let url = self.core.open(&self.workspace, &self.view, &tab, 1)?;
        self.grants.lock().unwrap().insert(
            tab.clone(),
            Grant {
                entry: entry.into(),
                url: url.clone(),
                request: 1,
            },
        );
        Ok(self.urls(&tab, &url))
    }
    fn urls(&self, tab: &str, url: &str) -> Value {
        json!({"documentUrl":url,"shellUrl":format!("{}/?tab={tab}",self.shell_origin),"origin":self.core.origin,"tab":tab})
    }
    fn command(&self, value: &Value) -> Result<Value, String> {
        let op = value["op"].as_str().ok_or("Missing op")?;
        if op == "open" {
            return self.open(value["entry"].as_str().ok_or("Missing entry")?);
        }
        if op == "get-limits" || op == "set-limits" {
            // Harness-only stdin commands exercise production settings on the
            // current Core, without adding an HTML endpoint or requiring a tab.
            let snapshot = self.core.snapshot();
            let context = Context {
                view_id: snapshot.view_id,
                workspace_id: snapshot.workspace_id,
            };
            let result = if op == "get-limits" {
                storage_limits::get(&self.core, &context)
            } else {
                let request = serde_json::from_value(json!({
                    "context": {"viewId": context.view_id, "workspaceId": context.workspace_id},
                    "expectedRevision": value["expectedRevision"],
                    "expectedGeneration": value["expectedGeneration"],
                    "documentMiB": value["documentMiB"],
                    "totalMiB": value["totalMiB"],
                    "acknowledgeCompatibility": value["acknowledgeCompatibility"],
                }))
                .map_err(|error| error.to_string())?;
                storage_limits::set(&self.core, &request)
            };
            return match result {
                Ok(snapshot) => serde_json::to_value(snapshot).map_err(|error| error.to_string()),
                Err(error) => Ok(json!({"limitsError": error})),
            };
        }
        let tab = value["tab"].as_str().ok_or("Missing tab")?;
        let current = self
            .grants
            .lock()
            .unwrap()
            .get(tab)
            .cloned()
            .ok_or("Unknown tab")?;
        match op {
            "reload" => {
                let request = current.request + 1;
                let url = self.core.open(&self.workspace, &self.view, tab, request)?;
                self.grants.lock().unwrap().insert(
                    tab.into(),
                    Grant {
                        url: url.clone(),
                        request,
                        ..current
                    },
                );
                Ok(self.urls(tab, &url))
            }
            "close" | "close-reopen" => {
                self.core.close_tab(&self.workspace, &self.view, tab)?;
                self.grants.lock().unwrap().remove(tab);
                if op == "close-reopen" {
                    self.open(&current.entry)
                } else {
                    Ok(json!({"closed":true}))
                }
            }
            "rename" => {
                let name = value["name"].as_str().ok_or("Missing name")?;
                let result = tree_mutations::perform(
                    &self.core,
                    &self.workspace,
                    &self.view,
                    Mutation::RenameHtml {
                        source: current.entry.clone(),
                        name: name.into(),
                    },
                )?;
                self.grants.lock().unwrap().remove(tab);
                let next = result
                    .moves
                    .into_iter()
                    .find(|movement| movement.from == current.entry)
                    .map(|movement| movement.to)
                    .unwrap_or(current.entry);
                self.open(&next)
            }
            _ => Err("Unsupported command".into()),
        }
    }
}

#[derive(Deserialize)]
struct ShellQuery {
    tab: String,
}
async fn shell(
    State(harness): State<Arc<Harness>>,
    Query(query): Query<ShellQuery>,
) -> Response<Body> {
    let url = harness
        .grants
        .lock()
        .unwrap()
        .get(&query.tab)
        .map(|grant| grant.url.clone());
    let Some(url) = url else {
        return Response::builder()
            .status(StatusCode::NOT_FOUND)
            .body(Body::empty())
            .unwrap();
    };
    let mut response = axum::response::IntoResponse::into_response(Html(format!(
        "<!doctype html><html><body><iframe id='document' sandbox='allow-scripts' src='{url}'></iframe></body></html>"
    )));
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    response
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args = std::env::args_os().skip(1).collect::<Vec<_>>();
    if args.len() != 3 {
        return Err(
            "Usage: document-state-harness <root> <state-directory-or-dash> <entry>".into(),
        );
    }
    let document_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let shell_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let core = Core::new(document_listener.local_addr()?.port());
    if args[1] != "-" {
        core.document_state
            .set(DocumentState::new(PathBuf::from(&args[1])).map_err(|error| error.code())?)
            .map_err(|_| "State already initialized")?;
    }
    let snapshot = core.select(&PathBuf::from(&args[0]), false)?;
    // Tests explicitly control lifecycle; no filesystem watcher races are needed.
    core.watcher.lock().unwrap().take();
    let harness = Arc::new(Harness {
        core: core.clone(),
        workspace: snapshot.workspace_id.ok_or("No workspace")?,
        view: snapshot.view_id,
        shell_origin: format!("http://127.0.0.1:{}", shell_listener.local_addr()?.port()),
        grants: Mutex::new(HashMap::new()),
    });
    let first = harness.open(args[2].to_str().ok_or("Invalid entry")?)?;
    let shell_origin = harness.shell_origin.clone();
    let documents = document_server::router(core).layer(middleware::from_fn(
        move |request: Request<Body>, next: Next| {
            let origin = shell_origin.clone();
            async move {
                let mut response = next.run(request).await;
                if let Some(policy) = response
                    .headers()
                    .get("Content-Security-Policy")
                    .and_then(|value| value.to_str().ok())
                {
                    // Harness-only shell origin; all production sandbox/token restrictions remain.
                    if let Some((prefix, _)) = policy.split_once("; frame-ancestors ") {
                        let policy = format!("{prefix}; frame-ancestors {origin}");
                        response
                            .headers_mut()
                            .insert("Content-Security-Policy", policy.parse().unwrap());
                    }
                }
                response
            }
        },
    ));
    tokio::spawn(async move { axum::serve(document_listener, documents).await.unwrap() });
    let shells = Router::new()
        .route("/", get(shell))
        .with_state(harness.clone());
    tokio::spawn(async move { axum::serve(shell_listener, shells).await.unwrap() });
    println!("{first}");
    std::io::stdout().flush()?;
    std::thread::spawn(move || {
        for line in std::io::stdin().lock().lines() {
            let result = match line {
                Ok(line) => serde_json::from_str::<Value>(&line)
                    .map_err(|error| error.to_string())
                    .and_then(|value| harness.command(&value)),
                Err(error) => Err(error.to_string()),
            };
            println!("{}", result.unwrap_or_else(|error| json!({"error":error})));
            std::io::stdout().flush().unwrap();
        }
    });
    std::future::pending::<()>().await;
    Ok(())
}
