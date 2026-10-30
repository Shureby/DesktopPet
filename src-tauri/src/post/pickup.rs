//! Collecting deliveries, between ePets where one can't be reached (behind another router):
//! it keeps asking the other ("anything for me?", a request that waits), and what the other
//! would have sent it is told then, asked about there as usual, and fetched by it.
//!
//! The one that can't be reached (`collect`): asks each ePet it reaches on another network.
//! The other one (`deliver`, and the server's `asked`, `answered`, `file`): when a delivery
//! can't get to a device that has asked lately, it waits for it to be collected.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use bytes::Bytes;
use desktoppet_core::post::{random_id, text_message, DeviceInfo, FileInfo};
use http_body_util::combinators::BoxBody;
use http_body_util::{BodyExt, Full, StreamBody};
use hyper::body::{Frame, Incoming};
use hyper::{Request, Response, StatusCode};
use serde::{Deserialize, Serialize};
use tokio::io::AsyncReadExt;
use tokio::sync::{oneshot, watch};

use super::client::{self, Peer, Source};
use super::{lock, share, Device, Inner, Offer, Receive, Received, TextMessage};
use crate::state::now_ms;

/// Where an ePet asks for deliveries to collect (waits up to `WAIT`), answers about one,
/// and fetches its files.
pub(crate) const ASK: &str = "/api/epet/v1/pickup";
pub(crate) const ANSWER: &str = "/api/epet/v1/pickup-answer";
pub(crate) const FILE: &str = "/api/epet/v1/pickup-file";

/// How long an ask waits for something to collect.
const WAIT: Duration = Duration::from_secs(25);

/// A device that asked within this long collects what's sent to it.
const LATELY_MS: i64 = 60_000;

/// How long a delivery waits to be collected and answered.
const ANSWER_WAIT: Duration = Duration::from_secs(90);

type Body = BoxBody<Bytes, std::io::Error>;

/// Collecting's state, on both sides.
#[derive(Default)]
pub(crate) struct State {
    /// (Delivering) devices (fingerprints) asking now: woken when there's something.
    waiters: Mutex<HashMap<String, oneshot::Sender<()>>>,
    /// (Delivering) what waits to be collected, by session id.
    out: Mutex<HashMap<String, Outgoing>>,
    /// (Collecting) devices being asked now.
    asking: Mutex<HashSet<String>>,
}

/// A delivery waiting to be collected.
struct Outgoing {
    to: String,
    told: bool,
    files: BTreeMap<String, FileInfo>,
    sources: HashMap<String, Arc<Source>>,
    answer: Option<oneshot::Sender<bool>>,
    sent: Arc<AtomicU64>,
    done_files: Arc<AtomicUsize>,
}

/// What's to collect (the answer to an ask).
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Notice {
    session_id: String,
    info: DeviceInfo,
    files: BTreeMap<String, FileInfo>,
}

fn status(code: u16) -> Response<Body> {
    let mut res = Response::new(Full::new(Bytes::new()).map_err(|never| match never {}).boxed());
    *res.status_mut() = StatusCode::from_u16(code).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    res
}

fn json(value: &impl Serialize) -> Response<Body> {
    let body = serde_json::to_vec(value).unwrap_or_default();
    let mut res = Response::new(Full::new(Bytes::from(body)).map_err(|never| match never {}).boxed());
    res.headers_mut().insert(hyper::header::CONTENT_TYPE, hyper::header::HeaderValue::from_static("application/json"));
    res
}

/// Whether a device asked for deliveries lately (so what's sent to it waits for it).
pub(crate) fn collects(inner: &Inner, fingerprint: &str) -> bool {
    lock(&inner.devices).get(fingerprint).is_some_and(|d| now_ms() - d.collects_at < LATELY_MS)
}

// --- Delivering ---------------------------------------------------------------------

/// Delivers to a device that collects: waits for it to ask, its user's answer, and its
/// fetching every file. `report` says how it goes ("post-transfer", direction out).
pub(crate) async fn deliver(
    inner: &Arc<Inner>,
    d: &Device,
    files: BTreeMap<String, FileInfo>,
    sources: HashMap<String, (u64, Source)>,
    report: &(dyn Fn(&'static str, u64, u64, usize, Option<String>) + Sync),
) {
    let total: u64 = files.values().map(|f| f.size).sum();
    let count = files.len();
    let id = random_id();
    let (tx, rx) = oneshot::channel();
    let sent = Arc::new(AtomicU64::new(0));
    let done_files = Arc::new(AtomicUsize::new(0));
    lock(&inner.pickup.out).insert(
        id.clone(),
        Outgoing {
            to: d.fingerprint.clone(),
            told: false,
            files,
            sources: sources.into_iter().map(|(k, (_, s))| (k, Arc::new(s))).collect(),
            answer: Some(tx),
            sent: sent.clone(),
            done_files: done_files.clone(),
        },
    );
    // Gone however it ends.
    struct Drop_<'a>(&'a Inner, String);
    impl Drop for Drop_<'_> {
        fn drop(&mut self) {
            lock(&self.0.pickup.out).remove(&self.1);
        }
    }
    let _gone = Drop_(inner, id.clone());
    // It's asking now: told at once (else when it next asks).
    if let Some(w) = lock(&inner.pickup.waiters).remove(&d.fingerprint) {
        let _ = w.send(());
    }
    let accepted = match tokio::time::timeout(ANSWER_WAIT, rx).await {
        Ok(Ok(a)) => a,
        _ => return report("failed", 0, total, count, Some("unreachable: not collected".into())),
    };
    if !accepted {
        return report("declined", 0, total, count, None);
    }
    // Its fetching, file by file (stopped if nothing comes for two minutes).
    let mut last = (0u64, now_ms());
    loop {
        let (s, n) = (sent.load(Ordering::Relaxed), done_files.load(Ordering::Relaxed));
        if n >= count {
            return report("done", total, total, count, None);
        }
        if s != last.0 {
            last = (s, now_ms());
            report("sending", s, total, count, None);
        } else if now_ms() - last.1 > 120_000 {
            return report("failed", s, total, count, Some("timeout".into()));
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

/// The certificate's device, if it's the one the request says it is.
fn proven(cert: &Option<String>, info: &DeviceInfo) -> Option<String> {
    cert.as_ref().filter(|c| c.eq_ignore_ascii_case(&info.fingerprint)).map(|c| c.to_ascii_uppercase())
}

/// An ePet asks for what it can collect (and waits a while for it): 200 with a notice, or
/// 204. Only from a device its certificate proves, not blocked.
pub(crate) async fn asked(
    inner: Arc<Inner>,
    req: Request<Incoming>,
    ip: std::net::IpAddr,
    cert: Option<String>,
) -> Response<Body> {
    if !inner.config().enabled {
        return status(403);
    }
    let Ok(bytes) = http_body_util::Limited::new(req.into_body(), 64 * 1024).collect().await.map(|b| b.to_bytes())
    else {
        return status(400);
    };
    let Ok(info) = serde_json::from_slice::<DeviceInfo>(&bytes) else { return status(400) };
    let Some(fp) = proven(&cert, &info) else { return status(403) };
    if inner.blocked(&fp) {
        return status(403);
    }
    let mut device = Device::from_info(&info, ip);
    device.collects_at = now_ms();
    inner.add_came_in(device);
    let notice = |inner: &Inner| -> Option<Notice> {
        let mut out = lock(&inner.pickup.out);
        let (id, o) = out.iter_mut().find(|(_, o)| o.to == fp && !o.told)?;
        o.told = true;
        Some(Notice { session_id: id.clone(), info: inner.info(true), files: o.files.clone() })
    };
    if let Some(n) = notice(&inner) {
        return json(&n);
    }
    let (tx, rx) = oneshot::channel();
    lock(&inner.pickup.waiters).insert(fp.clone(), tx);
    let _ = tokio::time::timeout(WAIT, rx).await;
    lock(&inner.pickup.waiters).remove(&fp);
    // Asked till now: still collecting.
    inner.update_device(&fp, |d| d.collects_at = now_ms());
    match notice(&inner) {
        Some(n) => json(&n),
        None => status(204),
    }
}

/// Its user's answer about a delivery to collect (`?sessionId=…&accept=true|false`).
pub(crate) async fn answered(inner: Arc<Inner>, req: Request<Incoming>, cert: Option<String>) -> Response<Body> {
    let q = query(&req);
    let id = q.get("sessionId").cloned().unwrap_or_default();
    let accept = q.get("accept").is_some_and(|a| a == "true");
    let mut out = lock(&inner.pickup.out);
    let Some(o) = out.get_mut(&id) else { return status(404) };
    if !cert.as_ref().is_some_and(|c| c.eq_ignore_ascii_case(&o.to)) {
        return status(403);
    }
    if let Some(tx) = o.answer.take() {
        let _ = tx.send(accept);
    }
    status(204)
}

/// A file of a delivery being collected (`?sessionId=…&fileId=…`), as it's read.
pub(crate) async fn file(inner: Arc<Inner>, req: Request<Incoming>, cert: Option<String>) -> Response<Body> {
    let q = query(&req);
    let (id, file_id) = (q.get("sessionId").cloned().unwrap_or_default(), q.get("fileId").cloned().unwrap_or_default());
    let (source, sent, done_files) = {
        let out = lock(&inner.pickup.out);
        let Some(o) = out.get(&id) else { return status(404) };
        if !cert.as_ref().is_some_and(|c| c.eq_ignore_ascii_case(&o.to)) || o.answer.is_some() {
            return status(403);
        }
        let Some(s) = o.sources.get(&file_id) else { return status(404) };
        (s.clone(), o.sent.clone(), o.done_files.clone())
    };
    match &*source {
        Source::Text(b) => {
            sent.fetch_add(b.len() as u64, Ordering::Relaxed);
            done_files.fetch_add(1, Ordering::Relaxed);
            let mut res = Response::new(Full::new(b.clone()).map_err(|never| match never {}).boxed());
            *res.status_mut() = StatusCode::OK;
            res
        }
        Source::File(p) => {
            let Ok(f) = tokio::fs::File::open(p).await else { return status(500) };
            let stream = futures_util::stream::unfold(Some(f), move |file| {
                let (sent, done_files) = (sent.clone(), done_files.clone());
                async move {
                    let mut f = file?;
                    let mut buf = vec![0u8; 1024 * 1024];
                    match f.read(&mut buf).await {
                        Ok(0) => {
                            done_files.fetch_add(1, Ordering::Relaxed);
                            None
                        }
                        Ok(n) => {
                            buf.truncate(n);
                            sent.fetch_add(n as u64, Ordering::Relaxed);
                            Some((Ok(Frame::data(Bytes::from(buf))), Some(f)))
                        }
                        Err(e) => Some((Err(e), None)),
                    }
                }
            });
            Response::new(BodyExt::boxed(StreamBody::new(stream)))
        }
    }
}

fn query(req: &Request<Incoming>) -> HashMap<String, String> {
    let mut out = HashMap::new();
    for pair in req.uri().query().unwrap_or("").split('&') {
        if let Some((k, v)) = pair.split_once('=') {
            out.insert(k.to_string(), v.to_string());
        }
    }
    out
}

// --- Collecting ---------------------------------------------------------------------

/// Whether this computer should ask a device for deliveries: an ePet it reached, over
/// HTTPS, on another network (one that may be unable to reach this computer).
fn worth_asking(inner: &Inner, d: &Device) -> bool {
    if !(d.epet && d.reached && d.online && d.https) || d.ip.is_unspecified() || inner.blocked(&d.fingerprint) {
        return false;
    }
    if crate::commands::e2e_enabled() && std::env::var("EPET_POST_COLLECT_ALL").is_ok() {
        return true;
    }
    let std::net::IpAddr::V4(v4) = d.ip else { return false };
    let [a, b, c, _] = v4.octets();
    !super::discovery::own_addresses().iter().any(|(own, _, _)| own.octets()[..3] == [a, b, c])
}

/// Keeps asking the ePets worth asking (one waiting request each) while Pet Post runs.
pub fn collect(inner: Arc<Inner>, mut stop: watch::Receiver<bool>) {
    tauri::async_runtime::spawn(async move {
        loop {
            let devices: Vec<Device> = lock(&inner.devices).values().cloned().collect();
            for d in devices {
                if worth_asking(&inner, &d) && lock(&inner.pickup.asking).insert(d.fingerprint.clone()) {
                    let (inner, stop) = (inner.clone(), stop.clone());
                    tauri::async_runtime::spawn(async move {
                        keep_asking(&inner, &d.fingerprint, stop).await;
                        lock(&inner.pickup.asking).remove(&d.fingerprint);
                    });
                }
            }
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_secs(3)) => {}
                _ = stop.changed() => return,
            }
            if *stop.borrow() {
                return;
            }
        }
    });
}

async fn keep_asking(inner: &Arc<Inner>, fingerprint: &str, stop: watch::Receiver<bool>) {
    loop {
        if *stop.borrow() {
            return;
        }
        let Some(d) = lock(&inner.devices).get(fingerprint).cloned().filter(|d| worth_asking(inner, d)) else { return };
        match ask_once(inner, &d).await {
            Ok(true) => {}
            Ok(false) => {}
            Err(_) => tokio::time::sleep(Duration::from_secs(15)).await,
        }
    }
}

/// Asks once (waiting a while); collects what there is. Whether there was something.
pub(crate) async fn ask_once(inner: &Arc<Inner>, d: &Device) -> Result<bool, String> {
    let peer = Peer::of(d);
    let body = Full::new(Bytes::from(serde_json::to_vec(&inner.info(true)).unwrap_or_default()))
        .map_err(|never| match never {})
        .boxed();
    let call = client::request(inner, &peer, ASK, body, None, Duration::from_secs(5));
    let reply = tokio::time::timeout(WAIT + Duration::from_secs(10), call).await.map_err(|_| "timeout")??;
    match reply.status {
        200 => {}
        204 => return Ok(false),
        s => return Err(format!("HTTP {s}")),
    }
    let notice: Notice = serde_json::from_slice(&reply.body).map_err(|e| e.to_string())?;
    take(inner, d, peer, notice).await;
    Ok(true)
}

/// Something to collect: asked about as a delivery is (a text: shown), then fetched.
async fn take(inner: &Arc<Inner>, d: &Device, peer: Peer, n: Notice) {
    let answer = |accept: bool| {
        let (inner, peer, id) = (inner.clone(), peer.clone(), n.session_id.clone());
        async move {
            let path = format!("{ANSWER}?sessionId={id}&accept={accept}");
            let body = Full::new(Bytes::new()).map_err(|never| match never {}).boxed();
            let _ = client::request(&inner, &peer, &path, body, None, Duration::from_secs(5)).await;
        }
    };
    let alias: String = n.info.alias.chars().take(64).collect();
    if inner.blocked(&d.fingerprint) || !inner.config().enabled {
        return answer(false).await;
    }
    if let Some(text) = text_message(&n.files) {
        let text: String = text.chars().take(10_000).collect();
        inner.remember(Received {
            id: random_id(),
            at: now_ms(),
            from: alias.clone(),
            fingerprint: d.fingerprint.clone(),
            device_model: n.info.device_model.clone(),
            device_type: d.device_type.clone(),
            text: Some(text.clone()),
            ..Default::default()
        });
        inner.emit("post-text", TextMessage { alias, text });
        answer(true).await;
        // (Its text is fetched so the sender sees it done.)
        if let Some(id) = n.files.keys().next() {
            let path = format!("{FILE}?sessionId={}&fileId={id}", n.session_id);
            let _ = client::get_stream(inner, &peer, &path).await;
        }
        return;
    }
    // Asked as a delivery is: the pet's question, the Pet Post window's card.
    let id = random_id();
    let (tx, rx) = oneshot::channel();
    let offer = Offer {
        id: id.clone(),
        alias: alias.clone(),
        device_model: n.info.device_model.clone(),
        fingerprint: d.fingerprint.clone(),
        files: n.files.len(),
        bytes: n.files.values().map(|f| f.size).sum(),
        names: n.files.values().take(3).map(|f| f.file_name.clone()).collect(),
        until: now_ms() + super::server::ANSWER_SECONDS as i64 * 1000,
    };
    let busy = {
        let mut receive = lock(&inner.receive);
        let busy = !matches!(*receive, Receive::Idle);
        if !busy {
            *receive = Receive::Offered {
                id: id.clone(),
                ip: d.ip,
                answer: Some(tx),
                cancel: None,
                offer: Box::new(offer.clone()),
            };
        }
        busy
    };
    if busy {
        return answer(false).await;
    }
    let config = inner.config();
    let trusted = config.auto_accept_trusted && config.trusted.iter().any(|t| t.eq_ignore_ascii_case(&d.fingerprint));
    let accepted = trusted || {
        inner.emit("post-offer", offer);
        match tokio::time::timeout(Duration::from_secs(super::server::ANSWER_SECONDS), rx).await {
            Ok(Ok(a)) => a,
            _ => {
                inner.emit("post-offer-closed", serde_json::json!({ "id": id, "reason": "timeout" }));
                false
            }
        }
    };
    {
        let mut receive = lock(&inner.receive);
        if matches!(&*receive, Receive::Offered { id: o, .. } if *o == id) {
            *receive = Receive::Idle;
        }
    }
    answer(accepted).await;
    if !accepted {
        return;
    }
    let files: Vec<FileInfo> = n.files.values().cloned().collect();
    let session = share::Session {
        peer,
        alias,
        fingerprint: d.fingerprint.clone(),
        device_model: n.info.device_model.clone(),
        device_type: d.device_type.clone(),
        session_id: n.session_id.clone(),
        files: n.files,
        part: Arc::new(Mutex::new(None)),
        pickup: true,
    };
    share::fetch(inner.clone(), session, files).await;
}
