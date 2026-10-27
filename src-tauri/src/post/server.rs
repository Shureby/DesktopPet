//! Pet Post's server: the LocalSend API (`/api/localsend/v2/…`) over HTTPS, and over
//! plain HTTP for the few apps that only speak that (the first byte tells them apart).

use std::collections::HashMap;
use std::convert::Infallible;
use std::ffi::OsString;
use std::net::{IpAddr, SocketAddr};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use bytes::Bytes;
use desktoppet_core::post::{
    checksum_matches, fingerprint, random_id, safe_relative_path, text_message, unique_path, DeviceInfo, PostError,
    PrepareUpload, ReceiveSession, API, DEFAULT_PORT,
};
use http_body_util::{BodyExt, Full, Limited};
use hyper::body::Incoming;
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use serde::de::DeserializeOwned;
use sha2::{Digest, Sha256};
use tokio::io::{AsyncRead, AsyncWrite, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{oneshot, watch};
use tokio_rustls::TlsAcceptor;

use super::items::{Item, Items};
use super::{lock, Active, Asked, Device, Inner, Offer, Receive, Received, TextMessage, Transfer};
use crate::state::now_ms;

type Body = http_body_util::combinators::BoxBody<Bytes, std::io::Error>;

/// How long the pet waits for an answer to a delivery before declining it.
pub const ANSWER_SECONDS: u64 = 60;
/// How much of a file being received is gathered before it's written.
const WRITE_BUFFER: usize = 512 * 1024;

/// A delivery with no data for this long is given up.
const IDLE_MS: i64 = 120_000;

/// Starts listening on `port` (0: LocalSend's or, if another app holds it (LocalSend on
/// this computer), the next free one of the ten after it, so the same one each time; any
/// free one as a last resort). Returns the port.
/// Listens on the first of `ports` that's free.
pub(crate) async fn bind_first(ports: impl IntoIterator<Item = u16>) -> Option<TcpListener> {
    for p in ports {
        match TcpListener::bind(("0.0.0.0", p)).await {
            Ok(l) => return Some(l),
            Err(e) => log::warn!("Pet Post: port {p} is taken ({e})"),
        }
    }
    None
}

pub async fn spawn(
    inner: Arc<Inner>,
    port: u16,
    tls: Arc<rustls::ServerConfig>,
    mut stop: watch::Receiver<bool>,
) -> Result<u16, String> {
    // Turned off and on again: the last listener may take a moment to let its port go.
    let wanted = if port == 0 { DEFAULT_PORT } else { port };
    let mut listener = None;
    let mut error = String::new();
    for _ in 0..10 {
        match TcpListener::bind(("0.0.0.0", wanted)).await {
            Ok(l) => {
                listener = Some(l);
                break;
            }
            Err(e) => {
                error = e.to_string();
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        }
    }
    let listener = match listener {
        Some(l) => l,
        None if port != 0 => return Err(error),
        None => match bind_first(DEFAULT_PORT + 1..=DEFAULT_PORT + 10).await {
            Some(l) => l,
            None => TcpListener::bind(("0.0.0.0", 0)).await.map_err(|e| e.to_string())?,
        },
    };
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let acceptor = TlsAcceptor::from(tls);
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::select! {
                _ = stop.changed() => break,
                accepted = listener.accept() => {
                    if let Ok((stream, addr)) = accepted {
                        tauri::async_runtime::spawn(connection(inner.clone(), acceptor.clone(), stream, addr));
                    }
                }
            }
        }
    });
    Ok(port)
}

/// An IPv4 address seen through IPv6 is still the same sender.
fn plain_ip(ip: IpAddr) -> IpAddr {
    match ip {
        IpAddr::V6(v6) => v6.to_ipv4_mapped().map(IpAddr::V4).unwrap_or(ip),
        v4 => v4,
    }
}

async fn connection(inner: Arc<Inner>, acceptor: TlsAcceptor, stream: TcpStream, addr: SocketAddr) {
    let ip = plain_ip(addr.ip());
    let mut first = [0u8; 1];
    let Ok(Ok(1)) = tokio::time::timeout(Duration::from_secs(10), stream.peek(&mut first)).await else {
        return;
    };
    // 0x16: a TLS handshake.
    if first[0] == 0x16 {
        let Ok(Ok(tls)) = tokio::time::timeout(Duration::from_secs(10), acceptor.accept(stream)).await else {
            return;
        };
        let cert = tls.get_ref().1.peer_certificates().and_then(|c| c.first()).map(|c| fingerprint(c.as_ref()));
        serve(inner, tls, ip, cert).await;
    } else {
        serve(inner, stream, ip, None).await;
    }
}

async fn serve<S>(inner: Arc<Inner>, io: S, ip: IpAddr, cert: Option<String>)
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let service = hyper::service::service_fn(move |req| {
        let (inner, cert) = (inner.clone(), cert.clone());
        async move { Ok::<_, Infallible>(route(inner, req, ip, cert).await) }
    });
    let _ = hyper::server::conn::http1::Builder::new().serve_connection(TokioIo::new(io), service).await;
}

fn status(code: u16) -> Response<Body> {
    let mut res = Response::new(Full::new(Bytes::new()).map_err(|never| match never {}).boxed());
    *res.status_mut() = StatusCode::from_u16(code).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    res
}

fn json(value: &impl serde::Serialize) -> Response<Body> {
    let body = serde_json::to_vec(value).unwrap_or_default();
    let mut res = Response::new(Full::new(Bytes::from(body)).map_err(|never| match never {}).boxed());
    res.headers_mut().insert(hyper::header::CONTENT_TYPE, hyper::header::HeaderValue::from_static("application/json"));
    res
}

fn query(req: &Request<Incoming>) -> HashMap<String, String> {
    let mut out = HashMap::new();
    for pair in req.uri().query().unwrap_or("").split('&') {
        if let Some((k, v)) = pair.split_once('=') {
            out.insert(k.to_string(), percent_decode(v));
        }
    }
    out
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'%' if i + 2 < b.len() => {
                match u8::from_str_radix(std::str::from_utf8(&b[i + 1..i + 3]).unwrap_or("zz"), 16) {
                    Ok(v) => {
                        out.push(v);
                        i += 3;
                        continue;
                    }
                    Err(_) => out.push(b'%'),
                }
            }
            b'+' => out.push(b' '),
            c => out.push(c),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

async fn read_json<T: DeserializeOwned>(req: Request<Incoming>, max: usize) -> Option<T> {
    let bytes = Limited::new(req.into_body(), max).collect().await.ok()?.to_bytes();
    serde_json::from_slice(&bytes).ok()
}

async fn route(inner: Arc<Inner>, req: Request<Incoming>, ip: IpAddr, cert: Option<String>) -> Response<Body> {
    if super::pair::handles(&req) {
        return super::pair::route(&inner, req, ip, cert).await;
    }
    if super::invite::handles(&req) {
        return super::invite::route(&inner, req, ip, cert).await;
    }
    let path = req.uri().path().to_string();
    if req.method() == Method::POST && path == VERIFY_ASK {
        return verify_asked(inner, req, ip, cert).await;
    }
    if req.method() == Method::POST && path == VERIFY_RESULT {
        return verify_result(inner, req, cert).await;
    }
    match (req.method().clone(), path.as_str()) {
        (Method::POST, super::pickup::ASK) => return super::pickup::asked(inner, req, ip, cert).await,
        (Method::POST, super::pickup::ANSWER) => return super::pickup::answered(inner, req, cert).await,
        (Method::GET, super::pickup::FILE) => return super::pickup::file(inner, req, cert).await,
        _ => {}
    }
    let Some(endpoint) = path.strip_prefix(API) else {
        return status(404);
    };
    match (req.method().clone(), endpoint) {
        (Method::POST, "/register") => register(inner, req, ip, cert).await,
        (Method::GET | Method::POST, "/info") => json(&inner.info(false)),
        (Method::POST, "/prepare-upload") => prepare_upload(inner, req, ip, cert).await,
        (Method::POST, "/upload") => upload(inner, req, ip).await,
        (Method::POST, "/cancel") => cancel(inner, req, ip),
        _ => status(404),
    }
}

/// A device introduces itself (answering our announcement, or scanning): it's listed,
/// and told who we are.
async fn register(inner: Arc<Inner>, req: Request<Incoming>, ip: IpAddr, cert: Option<String>) -> Response<Body> {
    let Some(info) = read_json::<DeviceInfo>(req, 64 * 1024).await else {
        return status(400);
    };
    if inner.blocked(&info.fingerprint) || cert.as_ref().is_some_and(|c| inner.blocked(c)) {
        return status(403);
    }
    // Claiming to be a paired ePet without its certificate: not it.
    if inner.unproven_paired(&info.fingerprint, &cert) {
        return status(403);
    }
    // Over TLS with a certificate, the fingerprint it claims must be its certificate's.
    if cert.as_ref().is_none_or(|c| c.eq_ignore_ascii_case(&info.fingerprint)) {
        inner.add_came_in(Device::from_info(&info, ip));
    }
    json(&inner.info(false))
}

/// Another ePet asks to compare Verify (`client::ask_verify`): the pet offers to show it,
/// and the request waits for the answer (so this device never has to reach that one):
/// 200 {"answer":"shown"}, 403 {"answer":"declined"}, 408 (no answer). Only from a
/// device its certificate proves and that isn't blocked; once in a while per device.
async fn verify_asked(inner: Arc<Inner>, req: Request<Incoming>, ip: IpAddr, cert: Option<String>) -> Response<Body> {
    if !inner.config().enabled {
        return status(403);
    }
    let Some(info) = read_json::<DeviceInfo>(req, 64 * 1024).await else {
        return status(400);
    };
    if !cert.as_ref().is_some_and(|c| c.eq_ignore_ascii_case(&info.fingerprint)) || inner.blocked(&info.fingerprint) {
        return status(403);
    }
    let device = Device::from_info(&info, ip);
    let fp = device.fingerprint.clone();
    let now = now_ms();
    let (tx, rx) = oneshot::channel();
    {
        let mut asked = lock(&inner.verify_asked);
        asked.retain(|_, a| now - a.at < super::ASKED_MS);
        if asked.get(&fp).is_some_and(|a| a.answer.is_some() || now - a.at < ASK_AGAIN_MS) {
            return status(429);
        }
        asked.insert(fp.clone(), Asked { alias: device.alias.clone(), at: now, answer: Some(tx) });
    }
    // A new round: what was decided before doesn't count.
    inner.decided(&fp).send_replace(None);
    let payload = serde_json::json!({ "fingerprint": fp, "alias": device.alias });
    inner.add_came_in(device);
    let guard = AskGuard { inner: inner.clone(), fingerprint: fp.clone() };
    inner.emit("post-verify-asked", payload);
    let answer = tokio::time::timeout(Duration::from_secs(ANSWER_SECONDS), rx).await;
    drop(guard);
    match answer {
        Ok(Ok(true)) => json(&serde_json::json!({ "answer": "shown" })),
        Ok(Ok(false)) => {
            let mut res = json(&serde_json::json!({ "answer": "declined" }));
            *res.status_mut() = StatusCode::FORBIDDEN;
            res
        }
        _ => status(408),
    }
}

/// The question about Verify is over (answered, timed out, the asker gone): the pet stops
/// asking.
struct AskGuard {
    inner: Arc<Inner>,
    fingerprint: String,
}

impl Drop for AskGuard {
    fn drop(&mut self) {
        let unanswered =
            lock(&self.inner.verify_asked).get_mut(&self.fingerprint).and_then(|a| a.answer.take()).is_some();
        if unanswered {
            self.inner.emit("post-verify-ask-closed", serde_json::json!({ "fingerprint": self.fingerprint }));
        }
    }
}

/// Another ePet that compared Verify with this one asks what this side's user decided,
/// and waits for it: 200 {"result":"match"|"mismatch"}, 408 (not within a few minutes).
async fn verify_result(inner: Arc<Inner>, req: Request<Incoming>, cert: Option<String>) -> Response<Body> {
    if !inner.config().enabled {
        return status(403);
    }
    let Some(info) = read_json::<DeviceInfo>(req, 64 * 1024).await else {
        return status(400);
    };
    if !cert.as_ref().is_some_and(|c| c.eq_ignore_ascii_case(&info.fingerprint)) || inner.blocked(&info.fingerprint) {
        return status(403);
    }
    let mut decided = inner.decided(&info.fingerprint).subscribe();
    let wait = async { decided.wait_for(Option::is_some).await.map(|v| v.unwrap_or(false)) };
    let result = tokio::time::timeout(Duration::from_millis(RESULT_WAIT_MS), wait).await;
    match result {
        Ok(Ok(matched)) => json(&serde_json::json!({ "result": if matched { "match" } else { "mismatch" } })),
        _ => status(408),
    }
}

/// Where another ePet asks to compare Verify, and then what was decided (not LocalSend's
/// API: LocalSend says 404).
pub(crate) const VERIFY_ASK: &str = "/api/epet/v1/verify";
pub(crate) const VERIFY_RESULT: &str = "/api/epet/v1/verify-result";

/// How soon the same device may ask again.
const ASK_AGAIN_MS: i64 = 10_000;

/// How long a "verify-result" waits for the user to decide.
pub(crate) const RESULT_WAIT_MS: u64 = 5 * 60_000;

/// Puts the receiving slot back to idle if the offer `id` still holds it: when the
/// request ends without the delivery starting (declined, timed out, sender gone).
struct OfferGuard {
    inner: Arc<Inner>,
    id: String,
    armed: bool,
}

impl Drop for OfferGuard {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        let mut receive = lock(&self.inner.receive);
        if let Receive::Offered { id, answer, .. } = &*receive {
            if *id == self.id {
                // Answered: that was said already ("answered").
                let unanswered = answer.is_some();
                *receive = Receive::Idle;
                drop(receive);
                if unanswered {
                    self.inner.emit("post-offer-closed", serde_json::json!({ "id": self.id, "reason": "cancelled" }));
                }
            }
        }
    }
}

async fn prepare_upload(inner: Arc<Inner>, req: Request<Incoming>, ip: IpAddr, cert: Option<String>) -> Response<Body> {
    let config = inner.config();
    if !config.enabled {
        return status(PostError::Rejected.status());
    }
    let q = query(&req);
    if let Err(e) = lock(&inner.pins).check(Some(&config.pin), q.get("pin").map(String::as_str), ip, now_ms()) {
        return status(e.status());
    }
    let Some(PrepareUpload { info, files }) = read_json::<PrepareUpload>(req, 8 * 1024 * 1024).await else {
        return status(400);
    };
    if files.is_empty() {
        return status(400);
    }
    // Blocked (Verify: the icons didn't match): refused, and not remembered. So is a claim
    // to be a paired ePet without its certificate.
    if inner.blocked(&info.fingerprint)
        || cert.as_ref().is_some_and(|c| inner.blocked(c))
        || inner.unproven_paired(&info.fingerprint, &cert)
    {
        return status(PostError::Rejected.status());
    }
    let verified = cert.as_ref().is_some_and(|c| c.eq_ignore_ascii_case(&info.fingerprint));
    if verified || cert.is_none() {
        inner.add_came_in(Device::from_info(&info, ip));
    }
    let alias: String = info.alias.chars().take(64).collect();
    if let Some(text) = text_message(&files) {
        let text: String = text.chars().take(10_000).collect();
        inner.remember(Received {
            id: random_id(),
            at: now_ms(),
            from: alias.clone(),
            fingerprint: if verified { info.fingerprint.to_ascii_uppercase() } else { String::new() },
            device_model: info.device_model.clone(),
            device_type: Device::from_info(&info, ip).device_type,
            text: Some(text.clone()),
            ..Default::default()
        });
        inner.emit("post-text", TextMessage { alias, text });
        return status(204);
    }

    let id = random_id();
    let (answer_tx, answer_rx) = oneshot::channel();
    let (cancel_tx, cancel_rx) = oneshot::channel();
    let fingerprint = if verified { info.fingerprint.to_ascii_uppercase() } else { String::new() };
    let offer = Offer {
        id: id.clone(),
        alias: alias.clone(),
        device_model: info.device_model.clone(),
        fingerprint: fingerprint.clone(),
        files: files.len(),
        bytes: files.values().map(|f| f.size).sum(),
        names: files.values().take(3).map(|f| f.file_name.clone()).collect(),
        until: now_ms() + ANSWER_SECONDS as i64 * 1000,
    };
    {
        let mut receive = lock(&inner.receive);
        if !matches!(*receive, Receive::Idle) {
            return status(PostError::Busy.status());
        }
        *receive = Receive::Offered {
            id: id.clone(),
            ip,
            answer: Some(answer_tx),
            cancel: Some(cancel_tx),
            offer: Box::new(offer.clone()),
        };
    }
    let mut guard = OfferGuard { inner: inner.clone(), id: id.clone(), armed: true };
    let trusted =
        verified && config.auto_accept_trusted && config.trusted.iter().any(|t| t.eq_ignore_ascii_case(&fingerprint));
    let accepted = trusted || {
        inner.emit("post-offer", offer);
        tokio::select! {
            a = answer_rx => a.unwrap_or(false),
            _ = cancel_rx => false,
            _ = tokio::time::sleep(Duration::from_secs(ANSWER_SECONDS)) => {
                inner.emit("post-offer-closed", serde_json::json!({ "id": id, "reason": "timeout" }));
                false
            }
        }
    };
    if !accepted {
        return status(PostError::Rejected.status());
    }

    let save_dir = inner.save_dir();
    if let Err(e) = std::fs::create_dir_all(&save_dir) {
        log::error!("Pet Post: can't make {}: {e}", save_dir.display());
        inner.transfer(Transfer {
            direction: "in",
            state: "failed",
            peer: alias,
            fingerprint: fingerprint.clone(),
            error: Some(e.to_string()),
            ..Default::default()
        });
        return status(500);
    }
    let session = ReceiveSession::new(ip, info, files);
    let items =
        Items::new(session.files.iter().map(|(id, f)| Item::new(id, &f.info.file_name, f.info.size, None)).collect());
    let response = session.response();
    let (total, count, session_id) = (session.total_bytes(), session.files.len(), session.id.clone());
    {
        let mut receive = lock(&inner.receive);
        if !matches!(&*receive, Receive::Offered { id: o, .. } if *o == id) {
            return status(PostError::Rejected.status());
        }
        *receive = Receive::Active(Box::new(Active {
            session,
            fingerprint: fingerprint.clone(),
            save_dir,
            reserved: Default::default(),
            done_bytes: 0,
            last_activity: now_ms(),
            last_emit: 0,
            items,
        }));
    }
    guard.armed = false;
    let t = Transfer {
        direction: "in",
        state: "receiving",
        peer: alias,
        fingerprint: fingerprint.clone(),
        total,
        files: count,
        ..Default::default()
    };
    let t = match &*lock(&inner.receive) {
        Receive::Active(a) => t.listing(&a.items),
        _ => t,
    };
    inner.transfer(t);
    watch_idle(inner, session_id);
    json(&response)
}

/// Gives up a delivery the sender stopped sending (no data for two minutes).
fn watch_idle(inner: Arc<Inner>, session_id: String) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(10)).await;
            let mut receive = lock(&inner.receive);
            let Receive::Active(a) = &*receive else { return };
            if a.session.id != session_id {
                return;
            }
            if now_ms() - a.last_activity > IDLE_MS {
                let peer = a.session.from.alias.clone();
                *receive = Receive::Idle;
                drop(receive);
                inner.transfer(Transfer {
                    direction: "in",
                    state: "failed",
                    peer,
                    error: Some("timeout".into()),
                    ..Default::default()
                });
                return;
            }
        }
    });
}

fn part_path(path: &Path) -> PathBuf {
    let mut s: OsString = path.as_os_str().to_owned();
    s.push(".part");
    PathBuf::from(s)
}

/// Counts received bytes (and says how far it is, a few times a second). False once the
/// delivery is over (cancelled).
fn received(inner: &Inner, session_id: &str, file_id: &str, n: u64) -> bool {
    let mut receive = lock(&inner.receive);
    let Receive::Active(a) = &mut *receive else { return false };
    if a.session.id != session_id {
        return false;
    }
    a.done_bytes += n;
    a.items.add(file_id, n);
    let now = now_ms();
    a.last_activity = now;
    if now - a.last_emit >= 200 {
        a.last_emit = now;
        let t = Transfer {
            direction: "in",
            state: "receiving",
            peer: a.session.from.alias.clone(),
            fingerprint: a.fingerprint.clone(),
            done: a.done_bytes,
            total: a.session.total_bytes(),
            files: a.session.files.len(),
            ..Default::default()
        }
        .listing(&a.items);
        drop(receive);
        inner.transfer(t);
    }
    true
}

/// A file that didn't make it (the delivery may go on with the others).
fn file_failed(inner: &Inner, session_id: &str, file_id: &str, code: u16) {
    let mut receive = lock(&inner.receive);
    let Receive::Active(a) = &mut *receive else { return };
    if a.session.id != session_id {
        return;
    }
    a.items.fail(file_id, Some(format!("HTTP {code}")));
    let t = Transfer {
        direction: "in",
        state: "receiving",
        peer: a.session.from.alias.clone(),
        fingerprint: a.fingerprint.clone(),
        done: a.done_bytes,
        total: a.session.total_bytes(),
        files: a.session.files.len(),
        ..Default::default()
    }
    .listing(&a.items);
    drop(receive);
    inner.transfer(t);
}

async fn upload(inner: Arc<Inner>, req: Request<Incoming>, ip: IpAddr) -> Response<Body> {
    let q = query(&req);
    let (Some(session_id), Some(file_id), Some(token)) = (q.get("sessionId"), q.get("fileId"), q.get("token")) else {
        return status(400);
    };
    let (info, path) = {
        let mut receive = lock(&inner.receive);
        let Receive::Active(a) = &mut *receive else {
            return status(PostError::Rejected.status());
        };
        let info = match a.session.check_upload(session_id, file_id, token, ip) {
            Ok(f) => f.info.clone(),
            Err(e) => return status(e.status()),
        };
        let rel = safe_relative_path(&info.file_name);
        let reserved = &a.reserved;
        let path = unique_path(&a.save_dir, &rel, |p| p.exists() || part_path(p).exists() || reserved.contains(p));
        a.reserved.insert(path.clone());
        a.items.start(file_id);
        a.last_activity = now_ms();
        (info, path)
    };
    if let Some(parent) = path.parent() {
        if tokio::fs::create_dir_all(parent).await.is_err() {
            return status(500);
        }
    }
    let part = part_path(&path);
    let Ok(file) = tokio::fs::File::create(&part).await else {
        return status(500);
    };
    // Written half a megabyte at a time, not one network chunk (~16 KB) at a time.
    let mut file = tokio::io::BufWriter::with_capacity(WRITE_BUFFER, file);
    let mut body = req.into_body();
    let mut got = 0u64;
    let mut hasher = info.sha256.as_ref().map(|_| Sha256::new());
    let fail = |code: u16| {
        let (part, inner) = (part.clone(), inner.clone());
        let (session_id, file_id) = (session_id.clone(), file_id.clone());
        async move {
            let _ = tokio::fs::remove_file(&part).await;
            file_failed(&inner, &session_id, &file_id, code);
            status(code)
        }
    };
    while let Some(frame) = body.frame().await {
        let Ok(frame) = frame else {
            drop(file);
            return fail(400).await;
        };
        let Ok(data) = frame.into_data() else { continue };
        got += data.len() as u64;
        if got > info.size {
            drop(file);
            return fail(PostError::TooLarge.status()).await;
        }
        if let Some(h) = hasher.as_mut() {
            h.update(&data);
        }
        if file.write_all(&data).await.is_err() {
            drop(file);
            return fail(500).await;
        }
        if !received(&inner, session_id, file_id, data.len() as u64) {
            drop(file);
            return fail(PostError::Rejected.status()).await;
        }
    }
    if file.flush().await.is_err() || got != info.size {
        drop(file);
        return fail(400).await;
    }
    drop(file);
    if let Some(h) = hasher {
        if !checksum_matches(info.sha256.as_deref(), &h.finalize()) {
            return fail(PostError::Checksum.status()).await;
        }
    }
    if tokio::fs::rename(&part, &path).await.is_err() {
        return fail(500).await;
    }
    finish_file(&inner, session_id, file_id, path);
    status(200)
}

/// A file is in: when it was the last, the delivery is done.
fn finish_file(inner: &Inner, session_id: &str, file_id: &str, path: PathBuf) {
    let mut receive = lock(&inner.receive);
    let Receive::Active(a) = &mut *receive else { return };
    if a.session.id != session_id {
        return;
    }
    if let Some(f) = a.session.files.get_mut(file_id) {
        f.done = true;
        f.saved = Some(path);
    }
    a.items.finish(file_id);
    if !a.session.finished() {
        return;
    }
    let first = a.session.files.values().filter_map(|f| f.saved.clone()).min();
    let t = Transfer {
        direction: "in",
        state: "done",
        peer: a.session.from.alias.clone(),
        fingerprint: a.fingerprint.clone(),
        done: a.session.total_bytes(),
        total: a.session.total_bytes(),
        files: a.session.files.len(),
        folder: Some(a.save_dir.to_string_lossy().into_owned()),
        first: first.map(|p| p.to_string_lossy().into_owned()),
        error: None,
        collect: false,
        items: Vec::new(),
        tally: None,
    }
    .listing(&a.items);
    let mut paths: Vec<String> =
        a.session.files.values().filter_map(|f| f.saved.as_ref().map(|p| p.to_string_lossy().into_owned())).collect();
    paths.sort();
    let entry = Received {
        id: random_id(),
        at: now_ms(),
        from: t.peer.clone(),
        fingerprint: a.fingerprint.clone(),
        device_model: a.session.from.device_model.clone(),
        device_type: Device::from_info(&a.session.from, a.session.sender).device_type,
        text: None,
        files: t.files,
        bytes: t.total,
        paths: paths.into_iter().take(20).collect(),
        folder: t.folder.clone(),
    };
    *receive = Receive::Idle;
    drop(receive);
    // Kept first: "done" is the cue to look at what was received.
    inner.remember(entry);
    inner.transfer(t);
}

/// The sender cancels: before the answer (the pet stops asking) or while sending.
fn cancel(inner: Arc<Inner>, req: Request<Incoming>, ip: IpAddr) -> Response<Body> {
    let q = query(&req);
    let session_id = q.get("sessionId").cloned().unwrap_or_default();
    let mut receive = lock(&inner.receive);
    match &mut *receive {
        Receive::Offered { ip: from, cancel, .. } if *from == ip => {
            if let Some(tx) = cancel.take() {
                let _ = tx.send(());
            }
        }
        Receive::Active(a) if a.session.id == session_id && a.session.sender == ip => {
            let peer = a.session.from.alias.clone();
            *receive = Receive::Idle;
            drop(receive);
            inner.transfer(Transfer { direction: "in", state: "cancelled", peer, ..Default::default() });
        }
        _ => {}
    }
    status(200)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn query_values_are_decoded() {
        assert_eq!(percent_decode("a%20b+c"), "a b c");
        assert_eq!(percent_decode("%E7%8C%AB"), "猫");
        assert_eq!(percent_decode("100%"), "100%");
        assert_eq!(percent_decode("%zz"), "%zz");
    }
}
