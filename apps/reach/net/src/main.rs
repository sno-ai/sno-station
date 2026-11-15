use std::{collections::BTreeMap, net::SocketAddr, path::PathBuf, process::Stdio};

use anyhow::{Context, Result, bail};
use iroh::{
    Endpoint, EndpointAddr, RelayMode, SecretKey,
    endpoint::{Connection, presets},
};
use serde::{Deserialize, Serialize};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::Command,
    task::JoinSet,
};

const ALPN: &[u8] = b"sno-reach/1";
const IROH_VERSION: &str = "1.4.1";

#[derive(Deserialize, Serialize)]
struct Contact {
    endpoint_id: String,
    addresses: Vec<SocketAddr>,
}

#[derive(Serialize)]
struct ServerInfo {
    pid: u32,
    #[serde(flatten)]
    contact: Contact,
    bind_addr: SocketAddr,
    iroh_version: &'static str,
    mailbox_root: Option<String>,
}

enum Args {
    Serve {
        bind: SocketAddr,
        key: PathBuf,
        info: PathBuf,
        receiver: PathBuf,
    },
    Connect {
        peer: PathBuf,
        bind: SocketAddr,
    },
    Version,
}

fn arguments() -> Result<Args> {
    let mut args = std::env::args().skip(1);
    let command = args
        .next()
        .context("expected serve, connect, or --version")?;
    if command == "--version" {
        return Ok(Args::Version);
    }
    let mut flags = BTreeMap::new();
    while let Some(flag) = args.next() {
        let value = args
            .next()
            .with_context(|| format!("missing value for {flag}"))?;
        if flags.insert(flag.clone(), value).is_some() {
            bail!("repeated option {flag}");
        }
    }
    let result = match command.as_str() {
        "serve" => Args::Serve {
            bind: required(&mut flags, "--bind")?
                .parse()
                .context("invalid bind address")?,
            key: required(&mut flags, "--key-file")?.into(),
            info: required(&mut flags, "--info-file")?.into(),
            receiver: required(&mut flags, "--receiver")?.into(),
        },
        "connect" => Args::Connect {
            peer: required(&mut flags, "--peer-file")?.into(),
            bind: flags
                .remove("--bind")
                .unwrap_or_else(|| "0.0.0.0:0".into())
                .parse()
                .context("invalid bind address")?,
        },
        _ => bail!("unknown operation {command}"),
    };
    if let Some(flag) = flags.keys().next() {
        bail!("unknown option {flag}");
    }
    Ok(result)
}

fn required(flags: &mut BTreeMap<String, String>, flag: &str) -> Result<String> {
    flags
        .remove(flag)
        .with_context(|| format!("missing {flag}"))
}

async fn endpoint(bind: SocketAddr, key: SecretKey) -> Result<Endpoint> {
    Endpoint::builder(presets::Minimal)
        .secret_key(key)
        .relay_mode(RelayMode::Disabled)
        .clear_ip_transports()
        .bind_addr(bind)?
        .alpns(vec![ALPN.to_vec()])
        .bind()
        .await
        .with_context(|| format!("bind {bind}"))
}

async fn persistent_key(path: &PathBuf) -> Result<SecretKey> {
    match tokio::fs::read(path).await {
        Ok(bytes) => Ok(SecretKey::from_bytes(&bytes.try_into().map_err(|_| {
            anyhow::anyhow!("invalid key length in {}", path.display())
        })?)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let key = SecretKey::generate();
            let mut file = tokio::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(path)
                .await
                .with_context(|| format!("create identity {}", path.display()))?;
            file.write_all(&key.to_bytes()).await?;
            file.sync_all().await?;
            Ok(key)
        }
        Err(error) => Err(error).with_context(|| format!("read identity {}", path.display())),
    }
}

// The fixed receiver is a shell command which can itself spawn programs.
// Keep its descendants in the same group so cancellation stops the whole operation.
struct ReceiverGroup(rustix::process::Pid);

impl Drop for ReceiverGroup {
    fn drop(&mut self) {
        if let Err(error) =
            rustix::process::kill_process_group(self.0, rustix::process::Signal::TERM)
            && error != rustix::io::Errno::SRCH
        {
            eprintln!("reach-net: stop receiver group {}: {error}", self.0);
        }
    }
}

async fn receive(connection: Connection, receiver: PathBuf) -> Result<()> {
    let (mut send, mut recv) = connection
        .accept_bi()
        .await
        .context("accept request stream")?;
    let mut stderr = Vec::new();
    let operation = async {
        let mut child = Command::new(&receiver)
            .arg("__receive")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .process_group(0)
            .kill_on_drop(true)
            .spawn()
            .with_context(|| format!("start receiver {}", receiver.display()))?;
        let pid = child
            .id()
            .and_then(|pid| i32::try_from(pid).ok())
            .and_then(rustix::process::Pid::from_raw)
            .context("receiver exited before process identifier was available")?;
        let _group = ReceiverGroup(pid);
        let mut input = child.stdin.take().context("receiver stdin unavailable")?;
        let mut output = child.stdout.take().context("receiver stdout unavailable")?;
        let mut errors = child.stderr.take().context("receiver stderr unavailable")?;
        let input_copy = async {
            tokio::io::copy(&mut recv, &mut input)
                .await
                .context("write receiver input")?;
            input.shutdown().await.context("finish receiver input")?;
            drop(input);
            Ok::<_, anyhow::Error>(())
        };
        let run = async {
            tokio::select! {
                status = child.wait() => Ok(status.context("wait for receiver")?),
                copied = input_copy => {
                    copied?;
                    Ok::<_, anyhow::Error>(child.wait().await.context("wait for receiver")?)
                }
            }
        };
        let copy_output = async {
            tokio::io::copy(&mut output, &mut send)
                .await
                .context("send receiver output")?;
            Ok::<_, anyhow::Error>(())
        };
        let copy_errors = async {
            errors
                .read_to_end(&mut stderr)
                .await
                .context("read receiver stderr")?;
            Ok::<_, anyhow::Error>(())
        };
        let (status, (), ()) = tokio::try_join!(run, copy_output, copy_errors)?;
        use std::os::unix::process::ExitStatusExt;
        Ok::<_, anyhow::Error>(
            status
                .code()
                .unwrap_or_else(|| 128 + status.signal().unwrap_or(1)),
        )
    };
    let result = tokio::select! {
        result = operation => result,
        reason = connection.closed() => bail!("client disconnected: {reason}"),
    };
    let status = match result {
        Ok(status) => status,
        Err(error) => {
            let detail = format!("reach-net: receiver operation: {error:#}\n");
            eprint!("{detail}");
            stderr.extend_from_slice(detail.as_bytes());
            74
        }
    };
    send.finish().context("finish receiver output")?;
    let mut outcome = connection
        .open_uni()
        .await
        .context("open receiver outcome")?;
    outcome.write_all(&status.to_be_bytes()).await?;
    outcome.write_all(&stderr).await?;
    outcome.finish()?;
    outcome
        .stopped()
        .await
        .context("confirm receiver outcome")?;
    eprintln!(
        "reach-net: receiver peer={} exit={status}",
        connection.remote_id()
    );
    Ok(())
}

async fn shutdown_signal() -> Result<()> {
    let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    tokio::select! {
        result = tokio::signal::ctrl_c() => result.context("receive interrupt signal"),
        _ = terminate.recv() => Ok(()),
    }
}

async fn serve(bind: SocketAddr, key: PathBuf, info: PathBuf, receiver: PathBuf) -> Result<()> {
    let endpoint = endpoint(bind, persistent_key(&key).await?).await?;
    let bind_addr = endpoint
        .bound_sockets()
        .into_iter()
        .next()
        .context("no bound socket")?;
    let mut addresses: Vec<_> = endpoint.addr().ip_addrs().copied().collect();
    if !bind_addr.ip().is_unspecified() && !addresses.contains(&bind_addr) {
        addresses.push(bind_addr);
    }
    let details = ServerInfo {
        pid: std::process::id(),
        contact: Contact {
            endpoint_id: endpoint.id().to_string(),
            addresses,
        },
        bind_addr,
        iroh_version: IROH_VERSION,
        mailbox_root: std::env::var("SNO_REACH_RECEIVER_ROOT").ok(),
    };
    tokio::fs::write(&info, serde_json::to_vec(&details)?)
        .await
        .with_context(|| format!("write receiver info {}", info.display()))?;
    eprintln!(
        "reach-net: listening {bind_addr} endpoint={}",
        endpoint.id()
    );
    let mut requests = JoinSet::new();
    let signal = shutdown_signal();
    tokio::pin!(signal);
    let result = loop {
        tokio::select! {
            signal_result = &mut signal => break signal_result,
            incoming = endpoint.accept() => {
                let Some(incoming) = incoming else { break Err(anyhow::anyhow!("receiver accept loop closed")); };
                let receiver = receiver.clone();
                requests.spawn(async move {
                    receive(incoming.await.context("accept peer connection")?, receiver).await
                });
            }
            Some(result) = requests.join_next() => match result {
                Ok(Ok(())) => {},
                Ok(Err(error)) => eprintln!("reach-net: connection failed: {error:#}"),
                Err(error) => eprintln!("reach-net: connection task failed: {error}"),
            }
        }
    };
    requests.abort_all();
    while requests.join_next().await.is_some() {}
    endpoint.close().await;
    result
}

async fn connect(peer: PathBuf, bind: SocketAddr) -> Result<i32> {
    let contact: Contact = serde_json::from_slice(
        &tokio::fs::read(&peer)
            .await
            .with_context(|| format!("read contact {}", peer.display()))?,
    )
    .with_context(|| format!("parse contact {}", peer.display()))?;
    let mut address = EndpointAddr::new(
        contact
            .endpoint_id
            .parse()
            .context("invalid peer endpoint ID")?,
    );
    for addr in contact.addresses {
        address = address.with_ip_addr(addr);
    }
    let endpoint = endpoint(bind, SecretKey::generate()).await?;
    let connection = endpoint
        .connect(address, ALPN)
        .await
        .context("connect to peer")?;
    let (mut send, mut recv) = connection.open_bi().await.context("open request stream")?;
    let mut stdin = tokio::io::stdin();
    let input = async {
        tokio::io::copy(&mut stdin, &mut send)
            .await
            .context("send request")?;
        send.finish().context("finish request")?;
        Ok::<_, anyhow::Error>(())
    };
    let output = async {
        let mut stdout = tokio::io::stdout();
        tokio::io::copy(&mut recv, &mut stdout)
            .await
            .context("read response")?;
        stdout.flush().await?;
        Ok::<_, anyhow::Error>(())
    };
    let outcome = async {
        let mut stream = connection
            .accept_uni()
            .await
            .context("read receiver outcome")?;
        let mut status = [0; 4];
        stream
            .read_exact(&mut status)
            .await
            .context("read receiver exit status")?;
        let mut stderr = tokio::io::stderr();
        tokio::io::copy(&mut stream, &mut stderr)
            .await
            .context("read receiver stderr")?;
        stderr.flush().await?;
        Ok::<_, anyhow::Error>(i32::from_be_bytes(status))
    };
    let response = async {
        let ((), status) = tokio::try_join!(output, outcome)?;
        Ok::<_, anyhow::Error>(status)
    };
    tokio::pin!(input, response);
    let result = tokio::select! {
        result = &mut response => result,
        sent = &mut input => {
            match response.await {
                Ok(status) if status != 0 => Ok(status),
                Ok(status) => sent.map(|()| status),
                Err(error) => Err(error),
            }
        }
    };
    connection.close(0u32.into(), b"request complete");
    endpoint.close().await;
    result
}

#[tokio::main]
async fn main() {
    let result = async {
        match arguments()? {
            Args::Serve {
                bind,
                key,
                info,
                receiver,
            } => serve(bind, key, info, receiver).await.map(|()| 0),
            Args::Connect { peer, bind } => connect(peer, bind).await,
            Args::Version => {
                println!(
                    "reach-net {} iroh {IROH_VERSION}",
                    env!("CARGO_PKG_VERSION")
                );
                Ok(0)
            }
        }
    }
    .await;
    let status = match result {
        Ok(status) => status,
        Err(error) => {
            eprintln!("reach-net: {error:#}");
            74
        }
    };
    std::process::exit(status);
}
