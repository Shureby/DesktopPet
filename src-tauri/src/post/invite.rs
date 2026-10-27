//! Alarms, to-dos and anniversaries sent to a paired ePet (docs/INTERACTIONS.md, "Sending
//! reminders and anniversaries"; the items and their file: desktoppet_core::share and ::ics).
//!
//! The sender posts a calendar file (`/schedule`). The receiver, by its rules for that device
//! (Settings → Pet Post → a paired ePet), adds it, keeps it for the user to answer (the
//! inbox), or declines it, and says so at once; what the user answers later goes back as a
//! receipt (`/schedule-receipt`). Only between paired ePets, so only over HTTPS with both
//! certificates known.

use std::sync::Arc;
use std::time::Duration;

use chrono::Local;
use desktoppet_core::ics;
use desktoppet_core::post::DeviceInfo;
use desktoppet_core::share::{InboxEntry, Item, Match, Origin, Take};
use hyper::body::Incoming;
use hyper::{Request, Response};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;

use super::client::{json_body, request};
use super::pair::{json, peer_of, proven, read_up_to, status, Body};
use super::{lock, CmdResult, Device, Inner, Post};
use crate::state::{now_ms, AppState};

pub(crate) const SEND: &str = "/api/epet/v1/schedule";
pub(crate) const RECEIPT: &str = "/api/epet/v1/schedule-receipt";

/// How many sent items' answers are kept.
const SENT_MAX: usize = 200;

/// What became of one item: "added" | "updated" | "have" | "kept" | "declined" | "asked" |
/// "expired" (from the receiver); "sending" | "unreachable" | "unsupported" | "refused" |
/// "unpaired" (here).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Answer {
    pub uid: String,
    pub answer: String,
}

/// Takes in what a paired ePet sent (fingerprint, its name, the file): an answer for each.
pub(crate) type InviteFn = Arc<dyn Fn(&str, &str, ics::Parsed) -> Vec<Answer> + Send + Sync>;

/// Something sent from here, and how it went ("post-schedule-sent").
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SentItem {
    pub fingerprint: String,
    pub kind: String,
    pub id: i64,
    pub uid: String,
    pub answer: String,
    pub at: i64,
}

#[derive(Deserialize)]
struct Sent {
    info: DeviceInfo,
    ics: String,
}

#[derive(Deserialize)]
struct Receipt {
    info: DeviceInfo,
    uid: String,
    answer: String,
}

/// Something taken in (the pet's bubble, "post-schedule"): `what` is "asked" (waits in the
/// inbox: `inbox`), "added" / "updated" (without asking: `id`, for Undo) or "have".
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Taken {
    pub what: &'static str,
    pub fingerprint: String,
    pub name: String,
    pub kind: &'static str,
    pub title: String,
    pub id: Option<i64>,
    pub inbox: Option<i64>,
}

pub(crate) fn handles(req: &Request<Incoming>) -> bool {
    req.method() == hyper::Method::POST && matches!(req.uri().path(), SEND | RECEIPT)
}

pub(crate) async fn route(
    inner: &Arc<Inner>,
    req: Request<Incoming>,
    ip: std::net::IpAddr,
    cert: Option<String>,
) -> Response<Body> {
    if !inner.config().enabled {
        return status(403);
    }
    if req.uri().path() == RECEIPT {
        return receipt(inner, req, cert).await;
    }
    let Some(sent) = read_up_to::<Sent>(req, ics::MAX_BYTES + 64 * 1024).await else { return status(400) };
    let Some(fp) = proven(inner, &sent.info, &cert) else {
        return json(403, &serde_json::json!({ "answer": "refused" }));
    };
    if !inner.paired(&fp) {
        return json(403, &serde_json::json!({ "answer": "unpaired" }));
    }
    inner.add_came_in(Device::from_info(&sent.info, ip));
    let Some(parsed) = ics::read(&Local, &sent.ics, now_ms()) else { return status(400) };
    let Some(take) = lock(&inner.invites).clone() else { return status(503) };
    let alias: String = sent.info.alias.chars().take(64).collect();
    let answers = take(&fp, &alias, parsed);
    json(200, &serde_json::json!({ "answers": answers }))
}

/// The other side's answer, once its user decided.
async fn receipt(inner: &Arc<Inner>, req: Request<Incoming>, cert: Option<String>) -> Response<Body> {
    let Some(r) = read_up_to::<Receipt>(req, 16 * 1024).await else { return status(400) };
    let Some(fp) = proven(inner, &r.info, &cert) else { return status(403) };
    if !inner.paired(&fp) {
        return status(403);
    }
    let answer: String = r.answer.chars().take(16).collect();
    inner.record_sent(|list| {
        for s in list.iter_mut().filter(|s| s.fingerprint == fp && s.uid == r.uid) {
            s.answer = answer.clone();
        }
    });
    status(204)
}

impl Inner {
    /// Changes the sent list and tells the windows.
    pub(crate) fn record_sent(&self, change: impl FnOnce(&mut Vec<SentItem>)) {
        let list = {
            let mut sent = lock(&self.sent);
            change(&mut sent);
            let n = sent.len();
            if n > SENT_MAX {
                sent.drain(..n - SENT_MAX);
            }
            sent.clone()
        };
        self.emit("post-schedule-sent", list);
    }
}

/// Sends the file to a paired ePet: its answers, or why it couldn't.
pub(crate) async fn send_to(inner: &Inner, fingerprint: &str, text: &str) -> Result<Vec<Answer>, &'static str> {
    if !inner.paired(fingerprint) {
        return Err("unpaired");
    }
    let peer = peer_of(inner, fingerprint)?;
    let body = serde_json::json!({ "info": inner.info(true), "ics": text });
    let reply =
        request(inner, &peer, SEND, json_body(&body), None, Duration::from_secs(4)).await.map_err(|_| "unreachable")?;
    match reply.status {
        200 => serde_json::from_slice::<serde_json::Value>(&reply.body)
            .ok()
            .and_then(|v| serde_json::from_value(v["answers"].clone()).ok())
            .ok_or("unreachable"),
        404 => Err("unsupported"),
        403 if super::pair::word(&reply.body) == "unpaired" => Err("unpaired"),
        403 => Err("refused"),
        _ => Err("unreachable"),
    }
}

/// Tells the sender what the user decided (if it can be reached now).
pub(crate) fn send_receipt(inner: Arc<Inner>, fingerprint: String, uid: String, answer: &'static str) {
    if fingerprint.is_empty() {
        return;
    }
    tauri::async_runtime::spawn(async move {
        let Ok(peer) = peer_of(&inner, &fingerprint) else { return };
        let body = serde_json::json!({ "info": inner.info(true), "uid": uid, "answer": answer });
        let _ = request(&inner, &peer, RECEIPT, json_body(&body), None, Duration::from_secs(4)).await;
    });
}

/// The windows reload what changed.
fn changed(app: &AppHandle, kind: &str) {
    let event = match kind {
        "alarm" => "alarms-changed",
        "todo" => "todos-changed",
        _ => "anniversaries-changed",
    };
    let _ = app.emit(event, ());
}

/// What a paired ePet sent, taken in by the rules for it (installed by `Post::new`).
pub(crate) fn take_in(app: &AppHandle, from: &str, name: &str, parsed: ics::Parsed) -> Vec<Answer> {
    let state = app.state::<AppState>();
    let post = app.state::<Post>();
    let config = post.0.config();
    let now = now_ms();
    let mut out = vec![];
    for s in parsed.items {
        let kind = s.item.kind();
        let title = s.item.title().to_string();
        let rule = config.rule(from, kind);
        let tell = |what: &'static str, id: Option<i64>, inbox: Option<i64>| {
            let _ = app.emit(
                "post-schedule",
                Taken { what, fingerprint: from.into(), name: name.into(), kind, title: title.clone(), id, inbox },
            );
        };
        let answer: &str = if rule == "refuse" {
            "declined"
        } else {
            let store = state.store();
            let auto = rule == "auto";
            match store.share_match(&Local, from, &s) {
                Err(_) => "declined",
                Ok(m) => {
                    let without_asking = matches!(m, Match::Same { .. })
                        || (auto && matches!(m, Match::New | Match::Changed { edited: false, .. }));
                    let taken = without_asking
                        .then(|| store.share_take(&Local, from, &s, Take::Add, None, parsed.offset, now).ok())
                        .flatten();
                    match taken {
                        Some(t) => {
                            if t.answer != "have" {
                                changed(app, kind);
                            }
                            tell(t.answer, t.id, None);
                            t.answer
                        }
                        // To answer (or it couldn't be added: a time already past, shown so).
                        None => match store.inbox_add(
                            from,
                            name,
                            &s,
                            parsed.tz.as_deref().unwrap_or(""),
                            parsed.offset,
                            now,
                        ) {
                            Ok(inbox) => {
                                tell("asked", None, Some(inbox));
                                "asked"
                            }
                            Err(_) => "declined",
                        },
                    }
                }
            }
        };
        out.push(Answer { uid: s.uid, answer: answer.into() });
    }
    out
}

// --- Commands ----------------------------------------------------------------------------

/// How a send went, for each device.
#[derive(Debug, Clone, Serialize)]
pub struct Result1 {
    pub fingerprint: String,
    pub answer: String,
}

/// Sends an alarm, to-do or anniversary to paired ePets. `tz`: this computer's time zone's
/// name (the window knows it).
#[tauri::command]
pub async fn post_schedule_send(
    app: AppHandle,
    post: State<'_, Post>,
    fingerprints: Vec<String>,
    kind: String,
    id: i64,
    tz: String,
) -> CmdResult<Vec<Result1>> {
    let shared = app.state::<AppState>().store().shared(&Local, &kind, id).map_err(|e| e.to_string())?;
    let Some(shared) = shared else { return Err("this can't be sent".into()) };
    let text = ics::write(&Local, &tz, std::slice::from_ref(&shared), now_ms());
    let inner = post.0.clone();
    let mut out = vec![];
    for fp in fingerprints.iter().map(|f| f.to_ascii_uppercase()) {
        let mark = |answer: &str| {
            let (fp, kind, uid) = (fp.clone(), kind.clone(), shared.uid.clone());
            let answer = answer.to_string();
            inner.record_sent(move |list| {
                list.retain(|s| !(s.fingerprint == fp && s.uid == uid));
                list.push(SentItem { fingerprint: fp, kind, id, uid, answer, at: now_ms() });
            });
        };
        mark("sending");
        let answer = match send_to(&inner, &fp, &text).await {
            Ok(answers) => answers.into_iter().find(|a| a.uid == shared.uid).map_or("unreachable".into(), |a| a.answer),
            Err(e) => e.to_string(),
        };
        mark(&answer);
        out.push(Result1 { fingerprint: fp, answer });
    }
    Ok(out)
}

/// What was sent from here, and how it went.
#[tauri::command]
pub fn post_schedule_sent(post: State<'_, Post>) -> Vec<SentItem> {
    lock(&post.0.sent).clone()
}

/// "Save as .ics…": the calendar file for one item. End-to-end tests pass `path`.
#[tauri::command]
pub async fn post_schedule_save(
    app: AppHandle,
    kind: String,
    id: i64,
    tz: String,
    title: String,
    path: Option<String>,
) -> CmdResult<Option<String>> {
    let shared = app.state::<AppState>().store().shared(&Local, &kind, id).map_err(|e| e.to_string())?;
    let Some(shared) = shared else { return Err("this can't be sent".into()) };
    let path = match path.filter(|_| crate::commands::e2e_enabled()) {
        Some(p) => std::path::PathBuf::from(p),
        None => {
            let name: String = shared
                .item
                .title()
                .chars()
                .map(|c| if "\\/:*?\"<>|".contains(c) || c.is_control() { '_' } else { c })
                .take(60)
                .collect();
            let (tx, rx) = tokio::sync::oneshot::channel();
            app.dialog()
                .file()
                .set_title(title)
                .set_file_name(format!("{}.ics", if name.trim().is_empty() { "ePet" } else { name.trim() }))
                .add_filter("iCalendar", &["ics"])
                .save_file(move |p| {
                    let _ = tx.send(p);
                });
            match rx.await.ok().flatten().and_then(|p| p.into_path().ok()) {
                Some(p) => p,
                None => return Ok(None),
            }
        }
    };
    std::fs::write(&path, ics::write(&Local, &tz, &[shared], now_ms())).map_err(|e| e.to_string())?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

/// What came of reading a calendar file.
#[derive(Debug, Clone, Serialize)]
pub struct Imported {
    /// "ok" | "cancelled" | "notCalendar".
    pub status: &'static str,
    /// Put in the inbox to answer.
    pub items: usize,
    pub skipped: usize,
}

/// Reads a calendar file (asks which, unless `path`: one received) into the inbox.
#[tauri::command]
pub async fn post_schedule_import(app: AppHandle, path: Option<String>, title: String) -> CmdResult<Imported> {
    let path = match path {
        Some(p) => std::path::PathBuf::from(p),
        None => {
            let (tx, rx) = tokio::sync::oneshot::channel();
            app.dialog()
                .file()
                .set_title(title)
                .add_filter("iCalendar", &["ics", "ical", "ifb", "icalendar"])
                .pick_file(move |p| {
                    let _ = tx.send(p);
                });
            match rx.await.ok().flatten().and_then(|p| p.into_path().ok()) {
                Some(p) => p,
                None => return Ok(Imported { status: "cancelled", items: 0, skipped: 0 }),
            }
        }
    };
    let size = std::fs::metadata(&path).map_err(|e| e.to_string())?.len();
    if size as usize > ics::MAX_BYTES {
        return Ok(Imported { status: "notCalendar", items: 0, skipped: 0 });
    }
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&bytes);
    let now = now_ms();
    let Some(parsed) = ics::read(&Local, &text, now) else {
        return Ok(Imported { status: "notCalendar", items: 0, skipped: 0 });
    };
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let state = app.state::<AppState>();
    let store = state.store();
    let mut items = 0;
    for s in &parsed.items {
        // Already here, the same: nothing to ask.
        if matches!(store.share_match(&Local, "", s), Ok(Match::Same { .. })) {
            continue;
        }
        store
            .inbox_add("", &name, s, parsed.tz.as_deref().unwrap_or(""), parsed.offset, now)
            .map_err(|e| e.to_string())?;
        items += 1;
    }
    drop(store);
    let _ = app.emit("post-schedule-inbox", ());
    Ok(Imported { status: "ok", items, skipped: parsed.skipped })
}

/// An invitation as the window shows it: what it is to what's here, an anniversary's next
/// day, a one-off already past, and this computer's offset from UTC (minutes, for "their time").
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InboxView {
    #[serde(flatten)]
    pub entry: InboxEntry,
    #[serde(rename = "match")]
    pub matched: Match,
    pub next: Option<String>,
    pub past: bool,
    pub here_offset: i32,
}

#[tauri::command]
pub fn post_schedule_inbox(state: State<'_, AppState>) -> CmdResult<Vec<InboxView>> {
    let store = state.store();
    let now = now_ms();
    let entries = store.inbox().map_err(|e| e.to_string())?;
    Ok(entries
        .into_iter()
        .map(|entry| {
            let matched = store.share_match(&Local, &entry.from, &entry.shared).unwrap_or(Match::New);
            let next = match &entry.shared.item {
                Item::Anniversary(a) => ics::next_day(&Local, a, now).map(|d| d.format("%Y-%m-%d").to_string()),
                _ => None,
            };
            let past =
                matches!(&entry.shared.item, Item::Alarm(a) if a.time.is_none() && a.at.is_none_or(|at| at <= now));
            InboxView { entry, matched, next, past, here_offset: ics::offset_minutes(&Local, now) }
        })
        .collect())
}

/// The user's answer to an invitation: take it (add, or update) or not (decline, or keep
/// mine). `their_time`: a repeating alarm at the sender's clock time. The answer, as told
/// to the sender.
#[tauri::command]
pub fn post_schedule_answer(
    app: AppHandle,
    state: State<'_, AppState>,
    post: State<'_, Post>,
    id: i64,
    take: bool,
    their_time: Option<bool>,
) -> CmdResult<String> {
    let store = state.store();
    let Some(e) = store.inbox_entry(id).map_err(|e| e.to_string())? else { return Err("gone".into()) };
    let how = if take { Take::Add } else { Take::Keep };
    let t =
        store.share_take(&Local, &e.from, &e.shared, how, their_time, e.offset, now_ms()).map_err(|e| e.to_string())?;
    store.inbox_remove(id).map_err(|e| e.to_string())?;
    drop(store);
    if matches!(t.answer, "added" | "updated") {
        changed(&app, e.shared.item.kind());
    }
    let _ = app.emit("post-schedule-inbox", ());
    send_receipt(post.0.clone(), e.from, e.shared.uid, t.answer);
    Ok(t.answer.into())
}

/// Undo after one was added without asking: it goes, and the sender is told it was declined.
#[tauri::command]
pub fn post_schedule_undo(
    app: AppHandle,
    state: State<'_, AppState>,
    post: State<'_, Post>,
    kind: String,
    id: i64,
) -> CmdResult<()> {
    let store = state.store();
    let origin = store.share_origin_of(&kind, id).map_err(|e| e.to_string())?;
    store.share_forget(&kind, id).map_err(|e| e.to_string())?;
    drop(store);
    changed(&app, &kind);
    if let Some((from, uid)) = origin {
        send_receipt(post.0.clone(), from, uid, "declined");
    }
    Ok(())
}

/// Where what's here came from (the windows show the sender's name by it).
#[tauri::command]
pub fn post_schedule_origins(state: State<'_, AppState>) -> CmdResult<Vec<Origin>> {
    state.store().share_origins().map_err(|e| e.to_string())
}
