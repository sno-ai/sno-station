use std::{path::PathBuf, process::Stdio, time::Duration};

use anyhow::{Context, Result, bail};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::{
    io::Join,
    process::{ChildStdin, ChildStdout, Command},
};
use tokio_websockets::{ClientBuilder, Message, WebSocketStream};

type Connection = WebSocketStream<Join<ChildStdout, ChildStdin>>;

fn arguments() -> Result<(PathBuf, String)> {
    let mut args = std::env::args().skip(1);
    let mut codex = None;
    let mut thread = None;
    while let Some(flag) = args.next() {
        let value = args
            .next()
            .with_context(|| format!("missing value for {flag}"))?;
        match flag.as_str() {
            "--codex" if codex.is_none() => codex = Some(PathBuf::from(value)),
            "--thread" if thread.is_none() => thread = Some(value),
            _ => bail!("unknown or repeated option {flag}"),
        }
    }
    Ok((
        codex.context("missing --codex")?,
        thread.context("missing --thread")?,
    ))
}

async fn request(
    connection: &mut Connection,
    id: u32,
    method: &str,
    params: Value,
) -> Result<Value> {
    connection
        .send(Message::text(
            json!({"id":id,"method":method,"params":params}).to_string(),
        ))
        .await
        .with_context(|| format!("send {method}"))?;
    while let Some(message) = connection.next().await {
        let message = message.with_context(|| format!("receive {method}"))?;
        let Some(text) = message.as_text() else {
            continue;
        };
        let response: Value = serde_json::from_str(text).context("decode Codex response")?;
        if response.get("id") != Some(&json!(id)) {
            continue;
        }
        if let Some(error) = response.get("error") {
            bail!("{method}: {error}");
        }
        return response
            .get("result")
            .cloned()
            .with_context(|| format!("{method} returned no result"));
    }
    bail!("Codex disconnected while waiting for {method}")
}

async fn wake(connection: &mut Connection, thread: &str) -> Result<Value> {
    request(
        connection,
        1,
        "initialize",
        json!({
            "clientInfo":{"name":"sno_reach","version":env!("CARGO_PKG_VERSION")},
            "capabilities":{"experimentalApi":true}
        }),
    )
    .await?;
    connection
        .send(Message::text(json!({"method":"initialized"}).to_string()))
        .await?;
    let state = request(
        connection,
        2,
        "thread/read",
        json!({"threadId":thread,"includeTurns":false}),
    )
    .await?;
    match state.pointer("/thread/status/type").and_then(Value::as_str) {
        Some("active") => return Ok(json!({"state":"queued","reason":"thread-active"})),
        Some("idle") => {}
        status => bail!("thread {thread} cannot start queued input in state {status:?}"),
    }
    let queue = request(
        connection,
        3,
        "thread/queue/list",
        json!({"threadId":thread}),
    )
    .await?;
    let items = queue
        .get("data")
        .and_then(Value::as_array)
        .context("queue/list returned no data array")?;
    let Some(first) = items.first() else {
        return Ok(json!({"state":"empty"}));
    };
    let queued_id = first
        .get("id")
        .and_then(Value::as_str)
        .context("queued input has no identifier")?;
    let started = request(
        connection,
        4,
        "thread/queue/start",
        json!({
            "threadId":thread,"queuedSubmissionId":queued_id
        }),
    )
    .await?;
    let turn = started
        .get("turn")
        .context("queue/start returned no turn")?;
    let turn_id = turn
        .get("id")
        .and_then(Value::as_str)
        .context("started turn has no identifier")?;
    match turn.get("status").and_then(Value::as_str) {
        Some("inProgress" | "completed") => Ok(json!({"state":"started","turn_id":turn_id})),
        status => bail!(
            "queued turn {turn_id} did not start: {status:?}; {}",
            turn.get("error").unwrap_or(&Value::Null)
        ),
    }
}

async fn run() -> Result<Value> {
    let (codex, thread) = arguments()?;
    let mut proxy = Command::new(&codex)
        .args(["app-server", "proxy"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .kill_on_drop(true)
        .spawn()
        .with_context(|| format!("start Codex proxy {}", codex.display()))?;
    let stdout = proxy
        .stdout
        .take()
        .context("Codex proxy stdout unavailable")?;
    let stdin = proxy
        .stdin
        .take()
        .context("Codex proxy stdin unavailable")?;
    let result = tokio::time::timeout(Duration::from_secs(10), async {
        let (mut connection, _) = ClientBuilder::from_uri("ws://localhost/rpc".parse()?)
            .connect_on(tokio::io::join(stdout, stdin))
            .await
            .context("connect Codex control socket")?;
        wake(&mut connection, &thread).await
    })
    .await
    .context("Codex queue wake timed out")
    .and_then(|result| result);
    if let Err(error) = proxy.kill().await.context("stop Codex proxy") {
        eprintln!("reach-codex-wake: {error:#}");
    }
    result
}

#[tokio::main]
async fn main() -> std::process::ExitCode {
    match run().await {
        Ok(result) => {
            println!("{result}");
            std::process::ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("reach-codex-wake: {error:#}");
            std::process::ExitCode::from(74)
        }
    }
}
