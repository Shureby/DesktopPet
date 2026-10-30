//! Pairing two ePets with a one-time code (desktoppet_core::pair has the crypto).
//!
//! A asks B (`/pair`): B's pet shows a 6-digit code for 2 minutes (or Decline). On A you
//! type it: A sends its SPAKE2 message (`/pair-finish`), B answers with its own and a proof
//! it has the key, and A, if B's proof checks out, sends its proof (`/pair-confirm`). Both
//! then remember each other as paired (the settings, in the windows). One guess per code;
//! three wrong codes from a device and its requests are refused for 10 minutes. Only over
//! HTTPS, with both certificates known: they are SPAKE2's identities.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use bytes::Bytes;
use desktoppet_core::pair::{self, Failures, Shower, CODE_MS};
use desktoppet_core::post::DeviceInfo;
use http_body_util::combinators::BoxBody;
use http_body_util::{BodyExt, Full, Limited};
use hyper::body::Incoming;
use hyper::{Request, Response, StatusCode};
use serde::{Deserialize, Serialize};
use tauri::State as TauriState;

use super::client::{json_body, request, Peer};
use super::{lock, CmdResult, Device, Inner, Post};
use crate::state::now_ms;

pub(crate) const ASK: &str = "/api/epet/v1/pair";
pub(crate) const FINISH: &str = "/api/epet/v1/pair-finish";
pub(crate) const CONFIRM: &str = "/api/epet/v1/pair-confirm";
pub(crate) const CANCEL: &str = "/api/epet/v1/pair-cancel";

/// How long B waits for A's proof once it answered.
const CONFIRM_MS: i64 = 30_000;
/// A "declined" is told to A for this long.
const DECLINED_MS: i64 = 5 * 60_000;

pub(crate) type Body = BoxBody<Bytes, std::io::Error>;

/// Pairing's state on the showing side (B): one code at a time.
#[derive(Default)]
pub(crate) struct State {
    showing: Mutex<Option<Showing>>,
    failures: Mutex<Failures>,
    /// Devices whose request the user declined (fingerprint → when).
    declined: Mutex<HashMap<String, i64>>,
}

struct Showing {
    fingerprint: String,
    alias: String,
    code: String,
    until: i64,
    /// Answered A's message: waiting for its proof.
    answered: Option<(Shower, i64)>,
}

/// A device asks this one to pair (B's pet shows the code).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairAsked {
    pub fingerprint: String,
    pub alias: String,
    pub code: String,
    pub until: i64,
}

/// What came of asking a device to pair (A).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairAsk {
    /// "shown" | "busy" | "later" | "refused" | "unsupported" | "unreachable".
    pub answer: String,
    /// Until when the code shown there can be typed (ms).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub until: Option<i64>,
}

#[derive(Deserialize)]
struct Finish {
    info: DeviceInfo,
    msg: String,
}

#[derive(Serialize, Deserialize)]
struct Answer {
    msg: String,
    confirm: String,
}

#[derive(Deserialize)]
struct Confirm {
    info: DeviceInfo,
    confirm: String,
}

pub(crate) fn status(code: u16) -> Response<Body> {
    let mut res = Response::new(Full::new(Bytes::new()).map_err(|never| match never {}).boxed());
    *res.status_mut() = StatusCode::from_u16(code).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    res
}

pub(crate) fn json(code: u16, value: &impl Serialize) -> Response<Body> {
    let body = serde_json::to_vec(value).unwrap_or_default();
    let mut res = Response::new(Full::new(Bytes::from(body)).map_err(|never| match never {}).boxed());
    *res.status_mut() = StatusCode::from_u16(code).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    res.headers_mut().insert(hyper::header::CONTENT_TYPE, hyper::header::HeaderValue::from_static("application/json"));
    res
}

pub(crate) fn answer(code: u16, word: &str) -> Response<Body> {
    json(code, &serde_json::json!({ "answer": word }))
}

async fn read<T: serde::de::DeserializeOwned>(req: Request<Incoming>) -> Option<T> {
    read_up_to(req, 64 * 1024).await
}

/// A JSON body of at most `max` bytes.
pub(crate) async fn read_up_to<T: serde::de::DeserializeOwned>(req: Request<Incoming>, max: usize) -> Option<T> {
    let bytes = Limited::new(req.into_body(), max).collect().await.ok()?.to_bytes();
    serde_json::from_slice(&bytes).ok()
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn unhex(s: &str) -> Option<Vec<u8>> {
    if !s.len().is_multiple_of(2) || s.len() > 512 {
        return None;
    }
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(s.get(i..i + 2)?, 16).ok()).collect()
}

/// The fingerprint its certificate proves (and the one it claims), or None.
pub(crate) fn proven(inner: &Inner, info: &DeviceInfo, cert: &Option<String>) -> Option<String> {
    let cert = cert.as_ref()?;
    (cert.eq_ignore_ascii_case(&info.fingerprint) && !inner.blocked(cert)).then(|| cert.to_ascii_uppercase())
}

/// Whether this is one of the pairing requests.
pub(crate) fn handles(req: &Request<Incoming>) -> bool {
    req.method() == hyper::Method::POST && matches!(req.uri().path(), ASK | FINISH | CONFIRM | CANCEL)
}

/// Answers a pairing request (`handles` said it is one).
pub(crate) async fn route(
    inner: &Arc<Inner>,
    req: Request<Incoming>,
    ip: std::net::IpAddr,
    cert: Option<String>,
) -> Response<Body> {
    match req.uri().path() {
        ASK => asked(inner, req, ip, cert).await,
        FINISH => finish(inner, req, cert).await,
        CONFIRM => confirm(inner, req, cert).await,
        _ => cancelled(inner, req, cert).await,
    }
}

/// A asks: a new code, shown by the pet (`post-pair-asked`) for 2 minutes.
async fn asked(
    inner: &Arc<Inner>,
    req: Request<Incoming>,
    ip: std::net::IpAddr,
    cert: Option<String>,
) -> Response<Body> {
    if !inner.config().enabled {
        return status(403);
    }
    let Some(info) = read::<DeviceInfo>(req).await else { return status(400) };
    let Some(fp) = proven(inner, &info, &cert) else { return answer(403, "refused") };
    let now = now_ms();
    if lock(&inner.pair.failures).locked(&fp, now) {
        return answer(429, "later");
    }
    let alias: String = info.alias.chars().take(64).collect();
    let code = pair::new_code();
    let until = now + CODE_MS;
    {
        let mut showing = lock(&inner.pair.showing);
        if showing.as_ref().is_some_and(|s| s.fingerprint != fp && s.until > now) {
            return answer(429, "busy");
        }
        *showing =
            Some(Showing { fingerprint: fp.clone(), alias: alias.clone(), code: code.clone(), until, answered: None });
    }
    lock(&inner.pair.declined).remove(&fp);
    inner.add_came_in(Device::from_info(&info, ip));
    inner.emit("post-pair-asked", PairAsked { fingerprint: fp.clone(), alias, code: code.clone(), until });
    // Not typed in time: the code goes.
    let inner2 = inner.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(CODE_MS as u64 + 500)).await;
        let expired = {
            let mut showing = lock(&inner2.pair.showing);
            let same = showing.as_ref().is_some_and(|s| s.code == code && s.answered.is_none());
            if same {
                *showing = None;
            }
            same
        };
        if expired {
            closed(&inner2, &fp, "expired");
        }
    });
    json(200, &PairAsk { answer: "shown".into(), until: Some(until) })
}

fn closed(inner: &Inner, fingerprint: &str, reason: &str) {
    inner.emit("post-pair-closed", serde_json::json!({ "fingerprint": fingerprint, "reason": reason }));
}

/// A's message: B answers with its own and its proof. One go per code: a wrong one counts.
async fn finish(inner: &Arc<Inner>, req: Request<Incoming>, cert: Option<String>) -> Response<Body> {
    let Some(f) = read::<Finish>(req).await else { return status(400) };
    let Some(fp) = proven(inner, &f.info, &cert) else { return answer(403, "refused") };
    let Some(a_msg) = unhex(&f.msg) else { return status(400) };
    let own = inner.identity().map(|i| i.fingerprint).unwrap_or_default();
    let now = now_ms();
    let mut showing = lock(&inner.pair.showing);
    let Some(s) = showing.as_mut().filter(|s| s.fingerprint == fp) else {
        drop(showing);
        let declined = lock(&inner.pair.declined).get(&fp).is_some_and(|t| now - t < DECLINED_MS);
        return answer(403, if declined { "declined" } else { "expired" });
    };
    if s.until < now {
        *showing = None;
        drop(showing);
        closed(inner, &fp, "expired");
        return answer(403, "expired");
    }
    if s.answered.is_some() {
        return status(409);
    }
    let Some((shower, b_msg, proof)) = pair::answer(&s.code, &fp, &own, &a_msg) else {
        return status(400);
    };
    // Counted as wrong until its proof says otherwise.
    lock(&inner.pair.failures).add(&fp, now);
    s.answered = Some((shower, now));
    drop(showing);
    let inner2 = inner.clone();
    let fp2 = fp.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(CONFIRM_MS as u64 + 500)).await;
        let gone = {
            let mut showing = lock(&inner2.pair.showing);
            let stale = showing
                .as_ref()
                .is_some_and(|s| s.fingerprint == fp2 && s.answered.as_ref().is_some_and(|(_, at)| *at == now));
            if stale {
                *showing = None;
            }
            stale
        };
        if gone {
            closed(&inner2, &fp2, "wrong");
        }
    });
    json(200, &Answer { msg: hex(&b_msg), confirm: hex(&proof) })
}

/// A's proof: paired, or the code was wrong (or someone is in between).
async fn confirm(inner: &Arc<Inner>, req: Request<Incoming>, cert: Option<String>) -> Response<Body> {
    let Some(c) = read::<Confirm>(req).await else { return status(400) };
    let Some(fp) = proven(inner, &c.info, &cert) else { return answer(403, "refused") };
    let taken = {
        let mut showing = lock(&inner.pair.showing);
        if showing.as_ref().is_some_and(|s| s.fingerprint == fp && s.answered.is_some()) {
            showing.take()
        } else {
            None
        }
    };
    let Some(s) = taken else { return answer(403, "expired") };
    let ok = unhex(&c.confirm).is_some_and(|proof| s.answered.as_ref().is_some_and(|(shower, _)| shower.check(&proof)));
    if !ok {
        closed(inner, &fp, "wrong");
        return answer(403, "wrong");
    }
    lock(&inner.pair.failures).clear(&fp);
    inner.emit("post-paired", serde_json::json!({ "fingerprint": fp, "alias": s.alias }));
    closed(inner, &fp, "paired");
    status(204)
}

/// A gave up: the code goes.
async fn cancelled(inner: &Arc<Inner>, req: Request<Incoming>, cert: Option<String>) -> Response<Body> {
    let Some(info) = read::<DeviceInfo>(req).await else { return status(400) };
    let Some(fp) = proven(inner, &info, &cert) else { return status(403) };
    let was = {
        let mut showing = lock(&inner.pair.showing);
        let ours = showing.as_ref().is_some_and(|s| s.fingerprint == fp && s.answered.is_none());
        if ours {
            *showing = None;
        }
        ours
    };
    if was {
        closed(inner, &fp, "cancelled");
    }
    status(204)
}

// --- The asking side (A) --------------------------------------------------------------

pub(crate) fn peer_of(inner: &Inner, fingerprint: &str) -> Result<Peer, &'static str> {
    let d = lock(&inner.devices).get(&fingerprint.to_ascii_uppercase()).cloned().ok_or("unreachable")?;
    if !d.https || !d.epet {
        return Err("unsupported");
    }
    if !d.online || d.ip.is_unspecified() {
        return Err("unreachable");
    }
    Ok(Peer::of(&d))
}

pub(crate) fn word(body: &[u8]) -> String {
    serde_json::from_slice::<serde_json::Value>(body)
        .ok()
        .and_then(|v| v["answer"].as_str().map(str::to_string))
        .unwrap_or_default()
}

pub(crate) async fn ask(inner: &Inner, fingerprint: &str) -> PairAsk {
    let peer = match peer_of(inner, fingerprint) {
        Ok(p) => p,
        Err(e) => return PairAsk { answer: e.into(), until: None },
    };
    let reply = match request(inner, &peer, ASK, json_body(&inner.info(true)), None, Duration::from_secs(4)).await {
        Ok(r) => r,
        Err(_) => return PairAsk { answer: "unreachable".into(), until: None },
    };
    match reply.status {
        200 => serde_json::from_slice(&reply.body).unwrap_or(PairAsk { answer: "unreachable".into(), until: None }),
        404 => PairAsk { answer: "unsupported".into(), until: None },
        429 if word(&reply.body) == "later" => PairAsk { answer: "later".into(), until: None },
        429 => PairAsk { answer: "busy".into(), until: None },
        403 => PairAsk { answer: "refused".into(), until: None },
        _ => PairAsk { answer: "unreachable".into(), until: None },
    }
}

/// The code typed: "paired" | "wrong" | "declined" | "expired" | "invalid" | "unsupported"
/// | "unreachable".
pub(crate) async fn finish_with(inner: &Inner, fingerprint: &str, code: &str) -> String {
    let Some(code) = pair::normalize_code(code) else { return "invalid".into() };
    let peer = match peer_of(inner, fingerprint) {
        Ok(p) => p,
        Err(e) => return e.into(),
    };
    let own = inner.identity().map(|i| i.fingerprint).unwrap_or_default();
    let (asker, msg) = pair::ask(&code, &own, &fingerprint.to_ascii_uppercase());
    let body = serde_json::json!({ "info": inner.info(true), "msg": hex(&msg) });
    let reply = match request(inner, &peer, FINISH, json_body(&body), None, Duration::from_secs(4)).await {
        Ok(r) => r,
        Err(_) => return "unreachable".into(),
    };
    if reply.status != 200 {
        return match (reply.status, word(&reply.body).as_str()) {
            (403, "declined") => "declined",
            (403, "refused") => "unreachable",
            (403, _) | (409, _) => "expired",
            (404, _) => "unsupported",
            _ => "unreachable",
        }
        .into();
    }
    let Some(a) = serde_json::from_slice::<Answer>(&reply.body).ok() else { return "unreachable".into() };
    let proof = match (unhex(&a.msg), unhex(&a.confirm)) {
        (Some(m), Some(c)) => asker.finish(&m, &c),
        _ => None,
    };
    let sent = proof.as_deref().map(hex).unwrap_or_default();
    let body = serde_json::json!({ "info": inner.info(true), "confirm": sent });
    let reply = request(inner, &peer, CONFIRM, json_body(&body), None, Duration::from_secs(4)).await;
    match (proof, reply) {
        (Some(_), Ok(r)) if r.status == 204 => "paired",
        (Some(_), Ok(_)) => "wrong",
        (Some(_), Err(_)) => "unreachable",
        (None, _) => "wrong",
    }
    .into()
}

// --- Commands ----------------------------------------------------------------------------

/// Asks a device to show a pairing code.
#[tauri::command]
pub async fn post_pair_ask(post: TauriState<'_, Post>, fingerprint: String) -> CmdResult<PairAsk> {
    Ok(ask(&post.0, &fingerprint).await)
}

/// The code shown there, typed here.
#[tauri::command]
pub async fn post_pair_finish(post: TauriState<'_, Post>, fingerprint: String, code: String) -> CmdResult<String> {
    Ok(finish_with(&post.0, &fingerprint, &code).await)
}

/// Gave up typing: the code there goes.
#[tauri::command]
pub async fn post_pair_cancel(post: TauriState<'_, Post>, fingerprint: String) -> CmdResult<()> {
    let inner = post.0.clone();
    if let Ok(peer) = peer_of(&inner, &fingerprint) {
        let _ = request(&inner, &peer, CANCEL, json_body(&inner.info(true)), None, Duration::from_secs(3)).await;
    }
    Ok(())
}

/// Declined here (the pet's Decline): the code goes; the asker is told when it tries it.
#[tauri::command]
pub fn post_pair_decline(post: TauriState<'_, Post>, fingerprint: String) {
    decline(&post.0, &fingerprint);
}

pub(crate) fn decline(inner: &Inner, fingerprint: &str) {
    let fp = fingerprint.to_ascii_uppercase();
    let was = {
        let mut showing = lock(&inner.pair.showing);
        let ours = showing.as_ref().is_some_and(|s| s.fingerprint == fp);
        if ours {
            *showing = None;
        }
        ours
    };
    lock(&inner.pair.declined).insert(fp.clone(), now_ms());
    if was {
        closed(inner, &fp, "declined");
    }
}
