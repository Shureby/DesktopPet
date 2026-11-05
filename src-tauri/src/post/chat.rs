//! Chat / Records (docs/INTERACTIONS.md, "Chat / Records"): everything sent to or received
//! from each device — texts, files, reminders — kept for good in the app's data folder
//! (post-chat.json; the window shows them device by device). What was sent and didn't get
//! there (the device away, not answering) waits and goes again by itself when the device
//! is back, until it gets there or the user cancels it.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use desktoppet_core::post::random_id;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};
use tauri_plugin_opener::OpenerExt;
use tokio::sync::watch;

use super::{client, err, lock, CmdResult, Inner, Post, Received};
use crate::state::now_ms;

/// One line in Chat / Records.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Entry {
    pub id: String,
    pub at: i64,
    /// "in" | "out".
    pub dir: String,
    /// The device's fingerprint ("" when it wasn't proven: then its name tells it apart).
    pub fingerprint: String,
    /// Its name then.
    pub alias: String,
    pub device_type: String,
    /// "text" | "files" | "share" (an alarm, to-do or anniversary between paired ePets).
    pub kind: String,
    /// The text; a share's title.
    pub text: Option<String>,
    pub files: usize,
    pub bytes: u64,
    /// Received: where they were saved (the first 20). Sent: what was sent (to send again).
    pub paths: Vec<String>,
    pub folder: Option<String>,
    /// A share's kind: "alarm" | "todo" | "anniversary", and its uid.
    pub share: Option<String>,
    pub uid: Option<String>,
    /// Sent: "sending" | "done" | "waiting" (goes again when the device is back) |
    /// "declined" | "failed" | "cancelled". Received: "done". A share: its answer ("added",
    /// "asked", "declined"…).
    pub state: String,
    pub error: Option<String>,
    /// Received and not looked at yet in Chat / Records.
    pub unread: bool,
    /// "waiting": not tried again before this (ms).
    pub retry_at: i64,
    pub tries: u32,
}

impl Entry {
    /// The conversation it's in: its device, by fingerprint, else by name.
    pub fn key(&self) -> String {
        if self.fingerprint.is_empty() {
            format!("~{}", self.alias)
        } else {
            self.fingerprint.clone()
        }
    }
}

impl From<&Received> for Entry {
    fn from(r: &Received) -> Self {
        Entry {
            id: r.id.clone(),
            at: r.at,
            dir: "in".into(),
            fingerprint: r.fingerprint.clone(),
            alias: r.from.clone(),
            device_type: r.device_type.clone(),
            kind: if r.text.is_some() { "text" } else { "files" }.into(),
            text: r.text.clone(),
            files: r.files,
            bytes: r.bytes,
            paths: r.paths.clone(),
            folder: r.folder.clone(),
            state: "done".into(),
            ..Default::default()
        }
    }
}

/// Waits before trying again: 10 s, 20 s… up to 10 minutes.
fn backoff(tries: u32) -> i64 {
    (10_000i64 << tries.min(6)).min(600_000)
}

impl Inner {
    fn chat_file(&self) -> PathBuf {
        self.data_dir.join("post-chat.json")
    }

    /// All of it, the oldest first. The first time, what History kept (received) comes in.
    pub(crate) fn chat(&self) -> Vec<Entry> {
        let mut c = lock(&self.chat);
        c.get_or_insert_with(|| match std::fs::read(self.chat_file()) {
            Ok(b) => serde_json::from_slice(&b).unwrap_or_default(),
            Err(_) => {
                let mut list: Vec<Entry> = self.history().iter().map(Entry::from).collect();
                list.reverse();
                list
            }
        })
        .clone()
    }

    fn save_chat(&self, list: &[Entry]) {
        if let Ok(bytes) = serde_json::to_vec(list) {
            let _ = std::fs::create_dir_all(&self.data_dir);
            if let Err(e) = std::fs::write(self.chat_file(), bytes) {
                log::warn!("Pet Post: can't keep Chat / Records: {e}");
            }
        }
    }

    /// Adds a line (and tells the windows).
    pub(crate) fn chat_add(&self, entry: Entry) {
        let mut list = self.chat();
        list.push(entry.clone());
        self.save_chat(&list);
        *lock(&self.chat) = Some(list);
        self.emit("post-chat", entry);
    }

    /// Changes a line (and tells the windows); its new state.
    pub(crate) fn chat_change(&self, id: &str, change: impl FnOnce(&mut Entry)) -> Option<Entry> {
        let mut list = self.chat();
        let e = list.iter_mut().find(|e| e.id == id)?;
        change(e);
        let e = e.clone();
        self.save_chat(&list);
        *lock(&self.chat) = Some(list);
        self.emit("post-chat", e.clone());
        Some(e)
    }

    /// A send starting: a new line, or the one sent again.
    pub(crate) fn chat_sending(&self, again: Option<&str>, entry: impl FnOnce() -> Entry) -> String {
        if let Some(id) = again {
            if self.chat_change(id, |e| e.state = "sending".into()).is_some() {
                return id.to_string();
            }
        }
        let e = entry();
        let id = e.id.clone();
        self.chat_add(e);
        id
    }

    /// How a send ended. `reached`: the receiver answered (else it wasn't there: it waits
    /// and goes again).
    pub(crate) fn chat_sent(&self, id: &str, state: &str, reached: bool, total: u64, error: Option<String>) {
        let state = match state {
            "done" | "declined" | "cancelled" => state,
            "busy" | "tooMany" => "waiting",
            "failed" if !reached => "waiting",
            _ => "failed",
        };
        self.chat_change(id, |e| {
            if total > 0 {
                e.bytes = total;
            }
            e.state = state.into();
            e.error = error;
            if state == "waiting" {
                e.tries += 1;
                e.retry_at = now_ms() + backoff(e.tries);
            }
        });
    }
}

impl Inner {
    /// An alarm, to-do or anniversary sent or received (`dir`), and its answer so far.
    /// `who`: the device's fingerprint and name ("": the name it last had).
    pub(crate) fn chat_share(&self, dir: &str, who: (&str, &str), kind: &str, title: &str, uid: &str, answer: &str) {
        let (fingerprint, alias) = who;
        let alias = if alias.is_empty() {
            self.chat().iter().rev().find(|e| e.fingerprint == fingerprint).map(|e| e.alias.clone()).unwrap_or_default()
        } else {
            alias.to_string()
        };
        let alias = if alias.is_empty() {
            lock(&self.devices).get(fingerprint).map(|d| d.alias.clone()).unwrap_or_default()
        } else {
            alias
        };
        self.chat_add(Entry {
            id: random_id(),
            at: now_ms(),
            dir: dir.into(),
            fingerprint: fingerprint.into(),
            alias,
            kind: "share".into(),
            text: Some(title.into()),
            share: Some(kind.into()),
            uid: Some(uid.into()),
            state: answer.into(),
            unread: dir == "in",
            ..Default::default()
        });
    }

    /// Its answer changed (the user answered, or the other side did): the latest line of it.
    pub(crate) fn chat_share_answer(&self, dir: &str, fingerprint: &str, uid: &str, answer: &str) {
        let id = self
            .chat()
            .iter()
            .rev()
            .find(|e| {
                e.kind == "share" && e.dir == dir && e.fingerprint == fingerprint && e.uid.as_deref() == Some(uid)
            })
            .map(|e| e.id.clone());
        if let Some(id) = id {
            self.chat_change(&id, |e| e.state = answer.into());
        }
    }
}

/// Sends what's waiting, one at a time, to devices that are there now.
pub(crate) fn resend(inner: &Arc<Inner>) {
    if lock(&inner.sending).as_ref().is_some_and(|s| !s.is_over()) {
        return;
    }
    let now = now_ms();
    let waiting: Vec<Entry> =
        inner.chat().into_iter().filter(|e| e.dir == "out" && e.state == "waiting" && e.retry_at <= now).collect();
    for e in waiting {
        let Some(device) = lock(&inner.devices).get(&e.fingerprint).cloned() else { continue };
        if !device.online || device.ip.is_unspecified() {
            continue;
        }
        // A paired ePet only over HTTPS, where its certificate proves it.
        if device.changed_to.is_some() || (inner.paired(&device.fingerprint) && !device.https) {
            continue;
        }
        let paths: Vec<PathBuf> = e.paths.iter().map(PathBuf::from).collect();
        if e.kind == "files" && !paths.iter().all(|p| p.exists()) {
            inner.chat_change(&e.id, |x| {
                x.state = "failed".into();
                x.error = Some("gone".into());
            });
            continue;
        }
        let text = if e.kind == "text" { e.text.clone() } else { None };
        if client::send(inner.clone(), device, paths, text, None, Some(e.id.clone())).is_ok() {
            return;
        }
    }
}

/// Keeps trying what's waiting (every few seconds, while Pet Post is on).
pub(crate) fn watch(inner: Arc<Inner>, mut stop: watch::Receiver<bool>) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_secs(5)) => resend(&inner),
                _ = stop.changed() => return,
            }
        }
    });
}

// --- Commands ----------------------------------------------------------------------------

/// All of Chat / Records, the oldest first.
#[tauri::command]
pub fn post_chat(post: State<'_, Post>) -> Vec<Entry> {
    post.0.chat()
}

/// Sends a text or files from Chat / Records. The device away or busy: it waits, and goes
/// when it can.
#[tauri::command]
pub fn post_chat_send(
    post: State<'_, Post>,
    to: String,
    text: Option<String>,
    paths: Vec<String>,
) -> CmdResult<String> {
    let inner = post.0.clone();
    let fp = to.to_ascii_uppercase();
    let text = text.map(|t| t.chars().take(10_000).collect::<String>()).filter(|t| !t.trim().is_empty());
    if text.is_none() && paths.is_empty() {
        return Err("nothing".into());
    }
    let alias = lock(&inner.devices)
        .get(&fp)
        .map(|d| d.alias.clone())
        .or_else(|| inner.chat().iter().rev().find(|e| e.fingerprint == fp).map(|e| e.alias.clone()))
        .ok_or("That device is gone.")?;
    let device_type = lock(&inner.devices).get(&fp).map(|d| d.device_type.clone()).unwrap_or_default();
    let (files, bytes) = client::measure(&paths.iter().map(PathBuf::from).collect::<Vec<_>>());
    let entry = Entry {
        id: random_id(),
        at: now_ms(),
        dir: "out".into(),
        fingerprint: fp,
        alias,
        device_type,
        kind: if text.is_some() { "text" } else { "files" }.into(),
        files: if text.is_some() { 0 } else { files },
        bytes: if text.is_some() { 0 } else { bytes },
        paths: if text.is_some() { Vec::new() } else { paths },
        text,
        state: "waiting".into(),
        ..Default::default()
    };
    let id = entry.id.clone();
    inner.chat_add(entry);
    resend(&inner);
    Ok(id)
}

/// Stops one: being sent (the receiver is told) or waiting to go again.
#[tauri::command]
pub fn post_chat_cancel(post: State<'_, Post>, id: String) {
    let inner = post.0.clone();
    let current = lock(&inner.sending).as_ref().is_some_and(|s| !s.is_over() && s.entry.as_deref() == Some(&id));
    if current {
        client::cancel(inner);
    } else {
        inner.chat_change(&id, |e| {
            if matches!(e.state.as_str(), "waiting" | "sending") {
                e.state = "cancelled".into();
            }
        });
    }
}

/// Sends one again (declined, failed or cancelled): it waits for the device as a new one would.
#[tauri::command]
pub fn post_chat_retry(post: State<'_, Post>, id: String) {
    let inner = post.0.clone();
    inner.chat_change(&id, |e| {
        if e.dir == "out" && e.kind != "share" && !matches!(e.state.as_str(), "sending" | "done") {
            e.state = "waiting".into();
            e.error = None;
            e.tries = 0;
            e.retry_at = 0;
        }
    });
    resend(&inner);
}

/// A conversation looked at: nothing in it is new any more.
#[tauri::command]
pub fn post_chat_read(post: State<'_, Post>, key: String) {
    let inner = &post.0;
    let mut list = inner.chat();
    let mut changed = vec![];
    for e in list.iter_mut().filter(|e| e.unread && e.key() == key) {
        e.unread = false;
        changed.push(e.clone());
    }
    if changed.is_empty() {
        return;
    }
    inner.save_chat(&list);
    *lock(&inner.chat) = Some(list);
    for e in changed {
        inner.emit("post-chat", e);
    }
}

/// Clears one conversation (`key`), or all of Chat / Records. What's being sent stays.
#[tauri::command]
pub fn post_chat_clear(post: State<'_, Post>, key: Option<String>) {
    let inner = &post.0;
    let mut list = inner.chat();
    list.retain(|e| e.state == "sending" || key.as_ref().is_some_and(|k| &e.key() != k));
    inner.save_chat(&list);
    *lock(&inner.chat) = Some(list);
    inner.emit("post-chat-cleared", serde_json::json!({ "key": key }));
}

/// Opens what a line received or sent: its folder (`reveal`, or several files), or the file.
#[tauri::command]
pub fn post_chat_open(app: AppHandle, post: State<'_, Post>, id: String, reveal: bool) -> CmdResult<()> {
    let entry = post.0.chat().into_iter().find(|e| e.id == id).ok_or("gone")?;
    let first = entry.paths.first().map(PathBuf::from).filter(|p| p.exists()).ok_or("gone")?;
    if reveal || entry.files > 1 || first.is_dir() {
        app.opener().reveal_item_in_dir(&first).map_err(err)
    } else {
        app.opener().open_path(first.to_string_lossy(), None::<&str>).map_err(err)
    }
}
