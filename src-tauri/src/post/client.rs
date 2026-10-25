//! Pet Post's client: introducing ourselves to a device (`register`) and sending it
//! files or a text (`prepare-upload`, then each file's `upload`; `cancel` to stop).

use std::collections::{BTreeMap, HashMap};
use std::net::IpAddr;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use bytes::Bytes;
use desktoppet_core::post::{mime_type, random_id, DeviceInfo, FileInfo, PrepareUpload, PrepareUploadResponse, API};
use futures_util::StreamExt as _;
use http_body_util::combinators::BoxBody;
use http_body_util::{BodyExt, Full, Limited, StreamBody};
use hyper::body::Frame;
use hyper::{Method, Request};
use hyper_util::rt::TokioIo;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite};
use tokio::net::TcpStream;
use tokio_rustls::TlsConnector;

use super::items::{Item, Items, Shared};
use super::{lock, tls, Device, Inner, Transfer};
use crate::state::now_ms;

type ReqBody = BoxBody<Bytes, std::io::Error>;

/// At most this many files in one delivery (a folder of a whole drive is a mistake).
const MAX_FILES: usize = 10_000;

/// Files uploaded at the same time (as LocalSend does).
const UPLOADS_AT_ONCE: usize = 2;

/// How much of a file is read at a time.
const READ_SIZE: usize = 1024 * 1024;

/// The delivery being sent.
pub(crate) struct Sending {
    task: tauri::async_runtime::JoinHandle<()>,
    device: Device,
    /// Known once the receiver accepted.
    session: Arc<Mutex<Option<String>>>,
    /// Set just before the last word on it (done, declined…), so the next one may start.
    over: Arc<AtomicBool>,
}

/// Where a file's data comes from.
pub(crate) enum Source {
    File(PathBuf),
    Text(Bytes),
}

pub(crate) struct Reply {
    pub status: u16,
    pub body: Bytes,
    /// The server certificate's fingerprint (HTTPS).
    pub cert: Option<String>,
}

pub(crate) fn json_body(value: &impl serde::Serialize) -> ReqBody {
    let bytes = serde_json::to_vec(value).unwrap_or_default();
    Full::new(Bytes::from(bytes)).map_err(|never| match never {}).boxed()
}

/// Where a request goes. `expected`: the fingerprint its certificate must have (HTTPS).
#[derive(Clone)]
pub(crate) struct Peer {
    pub ip: IpAddr,
    pub port: u16,
    pub https: bool,
    pub expected: Option<String>,
}

impl Peer {
    pub(crate) fn of(d: &Device) -> Self {
        Peer { ip: d.ip, port: d.port, https: d.https, expected: d.https.then(|| d.fingerprint.clone()) }
    }
}

/// One request to a device.
pub(crate) async fn request(
    inner: &Inner,
    peer: &Peer,
    path: &str,
    body: ReqBody,
    length: Option<u64>,
    connect: Duration,
) -> Result<Reply, String> {
    let (ip, port) = (peer.ip, peer.port);
    let stream = tokio::time::timeout(connect, TcpStream::connect((ip, port)))
        .await
        .map_err(|_| format!("{UNREACHABLE}: timeout"))?
        .map_err(|e| format!("{UNREACHABLE}: {e}"))?;
    if !peer.https {
        return exchange(TokioIo::new(stream), ip, port, path, body, length, None).await;
    }
    let id = inner.identity().ok_or("Pet Post is off")?;
    let seen = tls::SeenCert::default();
    let config = tls::client_config(&id, peer.expected.clone(), seen.clone())?;
    let name = rustls::pki_types::ServerName::IpAddress(ip.into());
    let tls = tokio::time::timeout(Duration::from_secs(10), TlsConnector::from(Arc::new(config)).connect(name, stream))
        .await
        .map_err(|_| "timeout".to_string())?
        .map_err(|e| e.to_string())?;
    let cert = lock(&seen).clone();
    exchange(TokioIo::new(tls), ip, port, path, body, length, cert).await
}

async fn exchange<S>(
    io: TokioIo<S>,
    ip: IpAddr,
    port: u16,
    path: &str,
    body: ReqBody,
    length: Option<u64>,
    cert: Option<String>,
) -> Result<Reply, String>
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let (mut sender, conn) = hyper::client::conn::http1::handshake(io).await.map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn(async move {
        let _ = conn.await;
    });
    let host = match ip {
        IpAddr::V6(v6) => format!("[{v6}]:{port}"),
        v4 => format!("{v4}:{port}"),
    };
    let mut req = Request::builder().method(Method::POST).uri(path).header(hyper::header::HOST, host);
    req = match length {
        Some(n) => {
            req.header(hyper::header::CONTENT_LENGTH, n).header(hyper::header::CONTENT_TYPE, "application/octet-stream")
        }
        None => req.header(hyper::header::CONTENT_TYPE, "application/json"),
    };
    let req = req.body(body).map_err(|e| e.to_string())?;
    let res = sender.send_request(req).await.map_err(|e| e.to_string())?;
    let status = res.status().as_u16();
    // (A list of shared files may carry small previews.)
    let body =
        Limited::new(res.into_body(), 16 * 1024 * 1024).collect().await.map(|b| b.to_bytes()).unwrap_or_default();
    Ok(Reply { status, body, cert })
}

/// A GET whose body is read as it comes (a shared file: `share.rs`). Also the server
/// certificate's fingerprint (HTTPS).
pub(crate) async fn get_stream(
    inner: &Inner,
    peer: &Peer,
    path: &str,
) -> Result<(hyper::Response<hyper::body::Incoming>, Option<String>), String> {
    let (ip, port) = (peer.ip, peer.port);
    let stream = tokio::time::timeout(Duration::from_secs(5), TcpStream::connect((ip, port)))
        .await
        .map_err(|_| format!("{UNREACHABLE}: timeout"))?
        .map_err(|e| format!("{UNREACHABLE}: {e}"))?;
    let host = match ip {
        IpAddr::V6(v6) => format!("[{v6}]:{port}"),
        v4 => format!("{v4}:{port}"),
    };
    let req = Request::builder()
        .method(Method::GET)
        .uri(path)
        .header(hyper::header::HOST, host)
        .body(Full::new(Bytes::new()).map_err(|never| match never {}).boxed())
        .map_err(|e| e.to_string())?;
    async fn send<S>(io: TokioIo<S>, req: Request<ReqBody>) -> Result<hyper::Response<hyper::body::Incoming>, String>
    where
        S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
    {
        let (mut sender, conn) = hyper::client::conn::http1::handshake(io).await.map_err(|e| e.to_string())?;
        tauri::async_runtime::spawn(async move {
            let _ = conn.await;
        });
        sender.send_request(req).await.map_err(|e| e.to_string())
    }
    if !peer.https {
        return Ok((send(TokioIo::new(stream), req).await?, None));
    }
    let id = inner.identity().ok_or("Pet Post is off")?;
    let seen = tls::SeenCert::default();
    let config = tls::client_config(&id, peer.expected.clone(), seen.clone())?;
    let name = rustls::pki_types::ServerName::IpAddress(ip.into());
    let tls = tokio::time::timeout(Duration::from_secs(10), TlsConnector::from(Arc::new(config)).connect(name, stream))
        .await
        .map_err(|_| "timeout".to_string())?
        .map_err(|e| e.to_string())?;
    let cert = lock(&seen).clone();
    Ok((send(TokioIo::new(tls), req).await?, cert))
}

/// How a request's error starts when nothing answered at that address and port.
const UNREACHABLE: &str = "unreachable";

/// Introduces this device to the one at `ip:port` and learns who it is. Over HTTPS its
/// fingerprint is its certificate's (and must be the one it announced, if `expected`).
/// Quick: for scanning a network.
pub(crate) async fn register(
    inner: &Inner,
    ip: IpAddr,
    port: u16,
    https: bool,
    expected: Option<String>,
) -> Option<Device> {
    let peer = Peer { ip, port, https, expected };
    introduce(inner, &peer, Duration::from_millis(800), Duration::from_secs(3)).await.ok()
}

/// Why a device added by address didn't answer as one.
#[derive(Debug, PartialEq)]
pub(crate) enum Probe {
    /// Nothing listens there (or a firewall drops it).
    Unreachable,
    /// Something answers, but not LocalSend or ePet.
    NotPet,
}

impl std::fmt::Display for Probe {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Probe::Unreachable => "unreachable",
            Probe::NotPet => "notPet",
        })
    }
}

/// Introduces this device to one added by address (more patient than a scan: it may be
/// far, over Tailscale); over HTTPS, or plain HTTP (LocalSend with encryption off).
pub(crate) async fn probe(inner: &Inner, ip: IpAddr, port: u16, expected: Option<String>) -> Result<Device, Probe> {
    let (connect, total) = (Duration::from_secs(4), Duration::from_secs(8));
    let https = Peer { ip, port, https: true, expected };
    match introduce(inner, &https, connect, total).await {
        Ok(d) => Ok(d),
        Err(e) if e.starts_with(UNREACHABLE) => Err(Probe::Unreachable),
        Err(_) => {
            let http = Peer { https: false, expected: None, ..https };
            introduce(inner, &http, connect, total).await.map_err(|_| Probe::NotPet)
        }
    }
}

async fn introduce(inner: &Inner, peer: &Peer, connect: Duration, total: Duration) -> Result<Device, String> {
    let path = format!("{API}/register");
    // Behind a router from there: the port of its door (door.rs).
    let mut info = inner.info(true);
    info.port = Some(inner.port_for(peer.ip));
    let call = request(inner, peer, &path, json_body(&info), None, connect);
    let reply = tokio::time::timeout(total, call).await.map_err(|_| "timeout".to_string())??;
    if reply.status != 200 {
        return Err(format!("HTTP {}", reply.status));
    }
    let mut info: DeviceInfo = serde_json::from_slice(&reply.body).map_err(|e| e.to_string())?;
    if let Some(cert) = reply.cert {
        if !info.fingerprint.is_empty() && !info.fingerprint.eq_ignore_ascii_case(&cert) {
            return Err("fingerprint".into());
        }
        info.fingerprint = cert;
    }
    if info.fingerprint.is_empty() {
        return Err("no fingerprint".into());
    }
    info.port = Some(peer.port);
    info.protocol = Some(if peer.https { "https" } else { "http" }.into());
    let mut d = Device::from_info(&info, peer.ip);
    d.reached = true;
    Ok(d)
}

/// Asks a device (by fingerprint) to show Verify too, and waits for its user (a minute):
/// see `post_verify_ask` for what it says. LocalSend doesn't know the request (404).
/// Only over HTTPS, where both certificates are known.
pub(crate) async fn ask_verify(inner: &Inner, fingerprint: &str) -> String {
    let fp = fingerprint.to_ascii_uppercase();
    // A new round: what this side decided before doesn't count.
    inner.decided(&fp).send_replace(None);
    let Some(device) = lock(&inner.devices).get(&fp).cloned() else {
        return "unreachable".into();
    };
    if !device.https {
        return "unsupported".into();
    }
    if device.ip.is_unspecified() {
        return "unreachable".into();
    }
    let peer = Peer::of(&device);
    let call =
        request(inner, &peer, super::server::VERIFY_ASK, json_body(&inner.info(true)), None, Duration::from_secs(4));
    let reply = match tokio::time::timeout(Duration::from_secs(75), call).await {
        Ok(Ok(r)) => r,
        _ => return "unreachable".into(),
    };
    let answer = serde_json::from_slice::<serde_json::Value>(&reply.body)
        .ok()
        .and_then(|v| v["answer"].as_str().map(str::to_string))
        .unwrap_or_default();
    match reply.status {
        200 if answer == "shown" => "shown",
        403 if answer == "declined" => "declined",
        408 => "declined",
        403 => "refused",
        404 => "unsupported",
        429 => "busy",
        _ => "unreachable",
    }
    .into()
}

/// After the device showed Verify: waits for what its user decides ("match" or
/// "mismatch"); None if not within a few minutes, or it can't be asked.
pub(crate) async fn verify_result(inner: &Inner, fingerprint: &str) -> Option<String> {
    let device = lock(&inner.devices).get(&fingerprint.to_ascii_uppercase()).cloned()?;
    if !device.https || device.ip.is_unspecified() {
        return None;
    }
    let peer = Peer::of(&device);
    let call =
        request(inner, &peer, super::server::VERIFY_RESULT, json_body(&inner.info(true)), None, Duration::from_secs(4));
    let wait = Duration::from_millis(super::server::RESULT_WAIT_MS + 30_000);
    let reply = tokio::time::timeout(wait, call).await.ok()?.ok()?;
    if reply.status != 200 {
        return None;
    }
    let v: serde_json::Value = serde_json::from_slice(&reply.body).ok()?;
    v["result"].as_str().filter(|r| matches!(*r, "match" | "mismatch")).map(str::to_string)
}

/// The files to send: each path a file, or a folder sent with what's in it.
fn collect(paths: &[PathBuf]) -> Result<Vec<(FileInfo, Source)>, String> {
    let mut out = Vec::new();
    for p in paths {
        let name = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "file".into());
        walk(p, &name, 0, &mut out)?;
    }
    if out.is_empty() {
        return Err("empty".into());
    }
    Ok(out)
}

/// How many files these paths hold (folders counted through, as `collect` reads them) and
/// their size, to ask before sending a great many. Stops counting past `MAX_FILES`.
pub(crate) fn measure(paths: &[PathBuf]) -> (usize, u64) {
    fn go(path: &Path, depth: u32, files: &mut usize, bytes: &mut u64) {
        if *files > MAX_FILES {
            return;
        }
        let Ok(meta) = std::fs::metadata(path) else { return };
        if meta.is_dir() {
            if depth > 32 {
                return;
            }
            for e in std::fs::read_dir(path).into_iter().flatten().flatten() {
                go(&e.path(), depth + 1, files, bytes);
            }
        } else {
            *files += 1;
            *bytes += meta.len();
        }
    }
    let (mut files, mut bytes) = (0, 0);
    for p in paths {
        go(p, 0, &mut files, &mut bytes);
    }
    (files, bytes)
}

fn walk(path: &Path, rel: &str, depth: u32, out: &mut Vec<(FileInfo, Source)>) -> Result<(), String> {
    let meta = std::fs::metadata(path).map_err(|e| e.to_string())?;
    if meta.is_dir() {
        if depth > 32 {
            return Ok(());
        }
        let mut entries: Vec<_> = std::fs::read_dir(path).map_err(|e| e.to_string())?.flatten().collect();
        entries.sort_by_key(|e| e.file_name());
        for e in entries {
            let name = e.file_name().to_string_lossy().into_owned();
            walk(&e.path(), &format!("{rel}/{name}"), depth + 1, out)?;
        }
        return Ok(());
    }
    if out.len() >= MAX_FILES {
        return Err("too many files".into());
    }
    let modified = meta.modified().ok().map(|t| chrono::DateTime::<chrono::Utc>::from(t).to_rfc3339());
    let id = random_id();
    let info = FileInfo {
        id: id.clone(),
        file_name: rel.to_string(),
        size: meta.len(),
        file_type: mime_type(rel).into(),
        sha256: None,
        preview: None,
        metadata: modified.map(|m| serde_json::json!({ "modified": m })),
    };
    out.push((info, Source::File(path.to_path_buf())));
    Ok(())
}

fn text_file(text: &str) -> (FileInfo, Source) {
    let id = random_id();
    let bytes = Bytes::from(text.as_bytes().to_vec());
    let info = FileInfo {
        id: id.clone(),
        file_name: format!("{id}.txt"),
        size: bytes.len() as u64,
        file_type: "text/plain".into(),
        sha256: None,
        preview: Some(text.to_string()),
        metadata: None,
    };
    (info, Source::Text(bytes))
}

/// Starts sending to `device`; "post-transfer" events say how it goes.
pub(crate) fn send(
    inner: Arc<Inner>,
    device: Device,
    paths: Vec<PathBuf>,
    text: Option<String>,
    pin: Option<String>,
) -> Result<(), String> {
    let mut sending = lock(&inner.sending);
    if sending.as_ref().is_some_and(|s| !s.over.load(Ordering::SeqCst)) {
        return Err("busy".into());
    }
    let session = Arc::new(Mutex::new(None));
    let over = Arc::new(AtomicBool::new(false));
    let job = Job { device: device.clone(), session: session.clone(), over: over.clone() };
    let task = tauri::async_runtime::spawn(run(inner.clone(), job, paths, text, pin));
    *sending = Some(Sending { task, device, session, over });
    Ok(())
}

/// Stops sending, and tells the receiver.
pub(crate) fn cancel(inner: Arc<Inner>) {
    let Some(s) = lock(&inner.sending).take() else { return };
    if s.over.swap(true, Ordering::SeqCst) {
        return;
    }
    s.task.abort();
    let session = lock(&s.session).clone().unwrap_or_default();
    let peer = s.device.alias.clone();
    let fingerprint = s.device.fingerprint.clone();
    inner.transfer(Transfer { direction: "out", state: "cancelled", peer, fingerprint, ..Default::default() });
    tauri::async_runtime::spawn(async move {
        let d = s.device;
        let path = format!("{API}/cancel?sessionId={session}");
        let _ = request(&inner, &Peer::of(&d), &path, json_body(&()), Some(0), Duration::from_secs(3)).await;
    });
}

pub(crate) fn pin_query(pin: &Option<String>) -> String {
    match pin.as_deref().filter(|p| !p.is_empty()) {
        Some(p) => format!(
            "?pin={}",
            p.bytes()
                .map(|b| if b.is_ascii_alphanumeric() { (b as char).to_string() } else { format!("%{b:02X}") })
                .collect::<String>()
        ),
        None => String::new(),
    }
}

/// What `run` shares with `cancel`.
struct Job {
    device: Device,
    session: Arc<Mutex<Option<String>>>,
    over: Arc<AtomicBool>,
}

async fn run(inner: Arc<Inner>, job: Job, paths: Vec<PathBuf>, text: Option<String>, pin: Option<String>) {
    let Job { device: d, session, over } = job;
    // Each file and how far it is.
    let tracker: Shared = Default::default();
    let report = |state: &'static str, done: u64, total: u64, files: usize, error: Option<String>| {
        if !matches!(state, "waiting" | "sending") && over.swap(true, Ordering::SeqCst) {
            // Cancelled meanwhile: that was the last word.
            return;
        }
        match state {
            "done" => lock(&tracker).finish_all(),
            "failed" | "cancelled" => lock(&tracker).stop_moving(),
            _ => {}
        }
        let t = Transfer {
            direction: "out",
            state,
            peer: d.alias.clone(),
            fingerprint: d.fingerprint.clone(),
            done,
            total,
            files,
            error,
            ..Default::default()
        };
        // Over and not all there: every file (what didn't get there can be sent again).
        let t =
            if matches!(state, "failed" | "cancelled") { t.listing_all(&tracker) } else { t.listing_shared(&tracker) };
        inner.transfer(t);
    };
    let items = match text.as_deref() {
        Some(t) => Ok(vec![text_file(t)]),
        None => {
            tauri::async_runtime::spawn_blocking(move || collect(&paths)).await.unwrap_or_else(|e| Err(e.to_string()))
        }
    };
    let items = match items {
        Ok(items) => items,
        Err(e) => return report("failed", 0, 0, 0, Some(e)),
    };
    let total: u64 = items.iter().map(|(f, _)| f.size).sum();
    let count = items.len();
    *lock(&tracker) = Items::new(
        items
            .iter()
            .map(|(f, s)| {
                let path = match s {
                    Source::File(p) => Some(p.to_string_lossy().into_owned()),
                    Source::Text(_) => None,
                };
                Item::new(&f.id, &f.file_name, f.size, path)
            })
            .collect(),
    );
    report("waiting", 0, total, count, None);
    let files: BTreeMap<String, FileInfo> = items.iter().map(|(f, _)| (f.id.clone(), f.clone())).collect();
    let mut sources: HashMap<String, (u64, Source)> = items.into_iter().map(|(f, s)| (f.id, (f.size, s))).collect();
    let body = json_body(&PrepareUpload { info: inner.info(true), files: files.clone() });
    let path = format!("{API}/prepare-upload{}", pin_query(&pin));
    let peer = Peer::of(&d);
    // The receiver's owner decides meanwhile (LocalSend waits as long as it takes).
    let reply = tokio::time::timeout(
        Duration::from_secs(600),
        request(&inner, &peer, &path, body, None, Duration::from_secs(5)),
    )
    .await
    .unwrap_or_else(|_| Err("timeout".into()));
    let reply = match reply {
        Ok(r) => r,
        // It can't be reached, but it collects deliveries (an ePet behind another router):
        // this one waits for it to.
        Err(e) if e.starts_with(UNREACHABLE) && super::pickup::collects(&inner, &d.fingerprint) => {
            inner.transfer(Transfer {
                direction: "out",
                state: "waiting",
                peer: d.alias.clone(),
                fingerprint: d.fingerprint.clone(),
                total,
                files: count,
                collect: true,
                ..Default::default()
            });
            return super::pickup::deliver(&inner, &d, files, sources, &report).await;
        }
        Err(e) => return report("failed", 0, total, count, Some(e)),
    };
    let state = match reply.status {
        200 => "",
        204 => "done",
        401 => "pin",
        403 => "declined",
        409 => "busy",
        429 => "tooMany",
        _ => "failed",
    };
    if !state.is_empty() {
        let error = (state == "failed").then(|| format!("HTTP {}", reply.status));
        return report(state, if state == "done" { total } else { 0 }, total, count, error);
    }
    let Ok(accepted) = serde_json::from_slice::<PrepareUploadResponse>(&reply.body) else {
        return report("failed", 0, total, count, Some("bad answer".into()));
    };
    *lock(&session) = Some(accepted.session_id.clone());
    for id in files.keys().filter(|id| !accepted.files.contains_key(*id)) {
        lock(&tracker).skip(id);
    }
    // Only the files the receiver wants (it may have skipped some).
    let total: u64 = accepted.files.keys().filter_map(|id| sources.get(id).map(|(n, _)| *n)).sum();
    let sent = Arc::new(AtomicU64::new(0));
    let last_emit = Arc::new(AtomicI64::new(0));
    report("sending", 0, total, count, None);
    // Two files at a time, as LocalSend does (a small file needn't wait behind a big one).
    let mut jobs: Vec<(String, String, u64, Source)> = Vec::new();
    for (file_id, token) in &accepted.files {
        if let Some((size, source)) = sources.remove(file_id) {
            jobs.push((
                file_id.clone(),
                format!("{API}/upload?sessionId={}&fileId={}&token={}", accepted.session_id, file_id, token),
                size,
                source,
            ));
        }
    }
    let uploads = jobs.into_iter().map(|(id, path, size, source)| {
        let (inner, peer, alias, sent, last_emit, tracker) = (
            inner.clone(),
            peer.clone(),
            (d.alias.clone(), d.fingerprint.clone()),
            sent.clone(),
            last_emit.clone(),
            tracker.clone(),
        );
        async move {
            lock(&tracker).start(&id);
            let is_text = matches!(source, Source::Text(_));
            let result = async {
                let body: ReqBody = match source {
                    Source::Text(b) => Full::new(b).map_err(|never| match never {}).boxed(),
                    Source::File(p) => {
                        let f = tokio::fs::File::open(&p).await.map_err(|e| e.to_string())?;
                        let progress = Progress { alias, sent: sent.clone(), last_emit, total, files: count };
                        file_body(f, inner.clone(), progress, (tracker.clone(), id.clone()))
                    }
                };
                match request(&inner, &peer, &path, body, Some(size), Duration::from_secs(5)).await {
                    Ok(r) if r.status == 200 || r.status == 204 => Ok(()),
                    Ok(r) => Err(format!("HTTP {}", r.status)),
                    Err(e) => Err(e),
                }
            }
            .await;
            match &result {
                Ok(()) => {
                    if is_text {
                        sent.fetch_add(size, Ordering::Relaxed);
                    }
                    lock(&tracker).finish(&id);
                }
                Err(e) => lock(&tracker).fail(&id, Some(e.clone())),
            }
            result
        }
    });
    let mut uploads = futures_util::stream::iter(uploads).buffer_unordered(UPLOADS_AT_ONCE);
    while let Some(result) = uploads.next().await {
        if let Err(error) = result {
            drop(uploads);
            let cancel = format!("{API}/cancel?sessionId={}", accepted.session_id);
            let _ = request(&inner, &peer, &cancel, json_body(&()), Some(0), Duration::from_secs(3)).await;
            return report("failed", sent.load(Ordering::Relaxed), total, count, Some(error));
        }
    }
    report("done", total, total, count, None);
}

/// How a delivery being sent goes (for `file_body` to say).
#[derive(Clone)]
struct Progress {
    /// The receiver's name and fingerprint.
    alias: (String, String),
    sent: Arc<AtomicU64>,
    last_emit: Arc<AtomicI64>,
    total: u64,
    files: usize,
}

/// A file's data for an upload, counting what's sent (and saying so a few times a second).
fn file_body(file: tokio::fs::File, inner: Arc<Inner>, progress: Progress, item: (Shared, String)) -> ReqBody {
    let stream = futures_util::stream::unfold(Some(file), move |file| {
        let (inner, p, item) = (inner.clone(), progress.clone(), item.clone());
        async move {
            let Progress { alias: peer, sent, last_emit, total, files } = p;
            let mut f = file?;
            let mut buf = vec![0u8; READ_SIZE];
            match f.read(&mut buf).await {
                Ok(0) => None,
                Ok(n) => {
                    buf.truncate(n);
                    let done = sent.fetch_add(n as u64, Ordering::Relaxed) + n as u64;
                    lock(&item.0).add(&item.1, n as u64);
                    let now = now_ms();
                    if now - last_emit.load(Ordering::Relaxed) >= 200 {
                        last_emit.store(now, Ordering::Relaxed);
                        let t = Transfer {
                            direction: "out",
                            state: "sending",
                            peer: peer.0,
                            fingerprint: peer.1,
                            done,
                            total,
                            files,
                            ..Default::default()
                        };
                        inner.transfer(t.listing_shared(&item.0));
                    }
                    Some((Ok(Frame::data(Bytes::from(buf))), Some(f)))
                }
                Err(e) => Some((Err(e), None)),
            }
        }
    });
    BodyExt::boxed(StreamBody::new(stream))
}
