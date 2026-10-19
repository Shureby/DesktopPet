//! Files shared by link (LocalSend's Share via link, its "download API"): this computer
//! fetches them, so it works where the other device can't reach this one (this computer
//! behind another router). The list first (`prepare-download`: the other device may ask its
//! user, or a PIN), then each file chosen (`download`), saved like files received.

use std::collections::BTreeMap;
use std::net::IpAddr;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use bytes::Bytes;
use desktoppet_core::post::{
    checksum_matches, random_id, safe_relative_path, unique_path, DeviceInfo, FileInfo, API, DEFAULT_PORT,
};
use http_body_util::{BodyExt, Full};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::State;
use tokio::io::AsyncWriteExt;

use super::client::{self, Peer};
use super::items::{Item, Items, Shared};
use super::{discovery, lock, CmdResult, Device, Inner, Post, Received, Transfer};
use crate::state::now_ms;

/// The files a device shares, as asked for (`post_share_open`); or a delivery collected
/// (pickup.rs).
pub(crate) struct Session {
    pub(crate) peer: Peer,
    pub(crate) alias: String,
    /// Proven by its certificate ("" over plain HTTP).
    pub(crate) fingerprint: String,
    pub(crate) device_model: Option<String>,
    pub(crate) device_type: String,
    pub(crate) session_id: String,
    pub(crate) files: BTreeMap<String, FileInfo>,
    /// The file being written now (removed if it's stopped).
    pub(crate) part: Arc<Mutex<Option<PathBuf>>>,
    /// Collected from an ePet (pickup.rs) rather than shared by link.
    pub(crate) pickup: bool,
}

/// What a device shares, as the Pet Post window shows it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareList {
    pub alias: String,
    pub fingerprint: String,
    /// Over HTTPS (else plain HTTP: not encrypted).
    pub https: bool,
    pub files: Vec<SharedFile>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedFile {
    pub id: String,
    pub file_name: String,
    pub size: u64,
    pub file_type: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PrepareDownload {
    info: DeviceInfo,
    session_id: String,
    files: BTreeMap<String, FileInfo>,
}

/// A link as LocalSend shows it ("http://192.168.31.25:53317", maybe without the scheme or
/// with a path): HTTPS or not, the host, the port.
pub(crate) fn parse_link(link: &str) -> Option<(bool, String, u16)> {
    let link = link.trim();
    let (https, rest) = match link.split_once("://") {
        Some((scheme, rest)) if scheme.eq_ignore_ascii_case("https") => (true, rest),
        Some((scheme, rest)) if scheme.eq_ignore_ascii_case("http") => (false, rest),
        Some(_) => return None,
        None => (false, link),
    };
    let authority = rest.split(['/', '?', '#']).next()?;
    if authority.is_empty() {
        return None;
    }
    let (host, port) = if let Some(v6) = authority.strip_prefix('[') {
        let (host, after) = v6.split_once(']')?;
        let port = match after.strip_prefix(':') {
            Some(p) => p.parse().ok()?,
            None => DEFAULT_PORT,
        };
        (host.to_string(), port)
    } else {
        match authority.rsplit_once(':') {
            Some((host, port)) => (host.to_string(), port.parse().ok()?),
            None => (authority.to_string(), DEFAULT_PORT),
        }
    };
    (!host.is_empty() && port != 0).then_some((https, host, port))
}

/// Asks a device (listed, by fingerprint; or at a link) what it shares. Errors: "off",
/// "gone", "link", "blocked", "pin" (asked, or wrong), "declined" (its user said no, or
/// didn't answer), "tooMany", "notSharing", "unreachable", "failed".
#[tauri::command]
pub async fn post_share_open(
    post: State<'_, Post>,
    fingerprint: Option<String>,
    link: Option<String>,
    pin: Option<String>,
) -> CmdResult<ShareList> {
    open(&post.0, fingerprint, link, pin).await
}

pub(crate) async fn open(
    inner: &Arc<Inner>,
    fingerprint: Option<String>,
    link: Option<String>,
    pin: Option<String>,
) -> CmdResult<ShareList> {
    if lock(&inner.running).is_none() {
        return Err("off".into());
    }
    let (peer, known): (Peer, Option<Device>) = match (fingerprint, link) {
        (Some(fp), _) => {
            let d = lock(&inner.devices).get(&fp.to_ascii_uppercase()).cloned().ok_or("gone")?;
            (Peer::of(&d), Some(d))
        }
        (None, Some(link)) => {
            let (https, host, port) = parse_link(&link).ok_or("link")?;
            let ip: IpAddr = discovery::resolve(&host, port).await.ok_or("link")?;
            (Peer { ip, port, https, expected: None }, None)
        }
        (None, None) => return Err("link".into()),
    };
    if let Some(d) = &known {
        if inner.blocked(&d.fingerprint) {
            return Err("blocked".into());
        }
    }
    let path = format!("{API}/prepare-download{}", client::pin_query(&pin));
    let ask = |peer: Peer| {
        let path = path.clone();
        async move {
            let body = Full::new(Bytes::new()).map_err(|never| match never {}).boxed();
            // Its user may be asked first (unless it accepts by itself).
            let call = client::request(inner, &peer, &path, body, None, Duration::from_secs(5));
            (tokio::time::timeout(Duration::from_secs(120), call).await, peer)
        }
    };
    let (mut answer, mut peer) = ask(peer).await;
    // A listed device may have switched since (LocalSend's Share via link: Encryption
    // unchecked serves plain HTTP, checked HTTPS): asked the other way too.
    if let (Some(d), Ok(Err(_))) = (&known, &answer) {
        let other = if peer.https {
            Peer { https: false, expected: None, ..peer.clone() }
        } else {
            Peer { https: true, expected: Some(d.fingerprint.clone()), ..peer.clone() }
        };
        let (again, other) = ask(other).await;
        if !matches!(again, Ok(Err(ref e)) if e.starts_with("unreachable")) {
            (answer, peer) = (again, other);
        }
    }
    let reply = match answer {
        Ok(Ok(r)) => r,
        Ok(Err(e)) if e.starts_with("unreachable") => return Err("unreachable".into()),
        Ok(Err(e)) => {
            log::warn!("Pet Post: asking {} what it shares: {e}", peer.ip);
            return Err("failed".into());
        }
        Err(_) => return Err("declined".into()),
    };
    match reply.status {
        200 => {}
        401 => return Err("pin".into()),
        403 => return Err("declined".into()),
        404 => return Err("notSharing".into()),
        429 => return Err("tooMany".into()),
        _ => return Err("failed".into()),
    }
    let list: PrepareDownload = serde_json::from_slice(&reply.body).map_err(|_| "failed")?;
    // Proven by its certificate over HTTPS; over plain HTTP, nobody can tell.
    let fingerprint =
        if peer.https { reply.cert.clone().unwrap_or_default().to_ascii_uppercase() } else { String::new() };
    if !fingerprint.is_empty() && inner.blocked(&fingerprint) {
        return Err("blocked".into());
    }
    let device = Device::from_info(&list.info, peer.ip);
    let alias = if list.info.alias.trim().is_empty() {
        known.map(|d| d.alias).unwrap_or_else(|| peer.ip.to_string())
    } else {
        device.alias.clone()
    };
    let out = ShareList {
        alias: alias.clone(),
        fingerprint: fingerprint.clone(),
        https: peer.https,
        files: list
            .files
            .values()
            .map(|f| SharedFile {
                id: f.id.clone(),
                file_name: f.file_name.clone(),
                size: f.size,
                file_type: f.file_type.clone(),
            })
            .collect(),
    };
    *lock(&inner.share) = Some(Session {
        peer,
        alias,
        fingerprint,
        device_model: list.info.device_model.clone(),
        device_type: device.device_type,
        session_id: list.session_id,
        files: list.files,
        part: Arc::new(Mutex::new(None)),
        pickup: false,
    });
    Ok(out)
}

/// Fetches the files chosen (by id) from what was asked for last (`post_share_open`): said
/// as a delivery coming in ("post-transfer"), and kept in what was received. Errors: "none"
/// (nothing asked for), "busy" (something is being received).
#[tauri::command]
pub fn post_share_get(post: State<'_, Post>, ids: Vec<String>) -> CmdResult<()> {
    get(&post.0, ids)
}

pub(crate) fn get(inner: &Arc<Inner>, ids: Vec<String>) -> CmdResult<()> {
    let busy = !matches!(*lock(&inner.receive), super::Receive::Idle)
        || lock(&inner.fetching).as_ref().is_some_and(|h| !h.inner().is_finished());
    if busy {
        return Err("busy".into());
    }
    let session = lock(&inner.share).take().ok_or("none")?;
    let files: Vec<FileInfo> = ids.iter().filter_map(|id| session.files.get(id).cloned()).collect();
    if files.is_empty() {
        return Err("none".into());
    }
    let task = tauri::async_runtime::spawn({
        let inner = inner.clone();
        async move { fetch(inner, session, files).await }
    });
    *lock(&inner.fetching) = Some(task);
    Ok(())
}

/// Stops fetching (what's in so far stays; the file being written goes).
#[tauri::command]
pub fn post_share_cancel(post: State<'_, Post>) {
    cancel(&post.0);
}

pub(crate) fn cancel(inner: &Inner) {
    if let Some(task) = lock(&inner.fetching).take() {
        task.abort();
    }
}

pub(crate) async fn fetch(inner: Arc<Inner>, s: Session, files: Vec<FileInfo>) {
    let total: u64 = files.iter().map(|f| f.size).sum();
    let count = files.len();
    let tracker: Shared =
        Arc::new(Mutex::new(Items::new(files.iter().map(|f| Item::new(&f.id, &f.file_name, f.size, None)).collect())));
    let say = |state: &'static str, done: u64, error: Option<String>, folder: Option<String>, first: Option<String>| {
        match state {
            "done" => lock(&tracker).finish_all(),
            "failed" | "cancelled" => lock(&tracker).stop_moving(),
            _ => {}
        }
        let t = Transfer {
            direction: "in",
            state,
            peer: s.alias.clone(),
            fingerprint: s.fingerprint.clone(),
            done,
            total,
            files: count,
            folder,
            first,
            error,
            collect: false,
            items: Vec::new(),
            tally: None,
        };
        inner.transfer(t.listing_shared(&tracker))
    };
    // Stopped (the task aborted): said, and the file being written removed.
    struct Stopped<'a> {
        part: &'a Arc<Mutex<Option<PathBuf>>>,
        over: bool,
        say: &'a (dyn Fn(&'static str, u64, Option<String>, Option<String>, Option<String>) + Sync),
    }
    impl Drop for Stopped<'_> {
        fn drop(&mut self) {
            if let Some(p) = lock(self.part).take() {
                let _ = std::fs::remove_file(p);
            }
            if !self.over {
                (self.say)("cancelled", 0, None, None, None);
            }
        }
    }
    let mut stopped = Stopped { part: &s.part, over: false, say: &say };

    let dir = inner.save_dir();
    if let Err(e) = tokio::fs::create_dir_all(&dir).await {
        stopped.over = true;
        return say("failed", 0, Some(e.to_string()), None, None);
    }
    say("receiving", 0, None, None, None);
    let mut done = 0u64;
    let mut last_emit = 0i64;
    let mut saved: Vec<PathBuf> = Vec::new();
    for f in &files {
        let path = if s.pickup {
            format!("{}?sessionId={}&fileId={}", super::pickup::FILE, s.session_id, query_value(&f.id))
        } else {
            format!("{API}/download?sessionId={}&fileId={}", s.session_id, query_value(&f.id))
        };
        lock(&tracker).start(&f.id);
        let result = async {
            let (res, _) = client::get_stream(&inner, &s.peer, &path).await?;
            if res.status() != 200 {
                return Err(format!("HTTP {}", res.status().as_u16()));
            }
            let rel = safe_relative_path(&f.file_name);
            let dest = unique_path(&dir, &rel, |p| p.exists() || part_of(p).exists());
            if let Some(parent) = dest.parent() {
                tokio::fs::create_dir_all(parent).await.map_err(|e| e.to_string())?;
            }
            let part = part_of(&dest);
            *lock(&s.part) = Some(part.clone());
            let file = tokio::fs::File::create(&part).await.map_err(|e| e.to_string())?;
            let mut out = tokio::io::BufWriter::with_capacity(512 * 1024, file);
            let mut hash = Sha256::new();
            let mut body = res.into_body();
            while let Some(frame) = body.frame().await {
                let frame = frame.map_err(|e| e.to_string())?;
                if let Some(data) = frame.data_ref() {
                    out.write_all(data).await.map_err(|e| e.to_string())?;
                    hash.update(data);
                    done += data.len() as u64;
                    lock(&tracker).add(&f.id, data.len() as u64);
                    let now = now_ms();
                    if now - last_emit >= 200 {
                        last_emit = now;
                        say("receiving", done, None, None, None);
                    }
                }
            }
            out.flush().await.map_err(|e| e.to_string())?;
            drop(out);
            if !checksum_matches(f.sha256.as_deref(), &hash.finalize()) {
                let _ = tokio::fs::remove_file(&part).await;
                *lock(&s.part) = None;
                return Err("checksum".to_string());
            }
            tokio::fs::rename(&part, &dest).await.map_err(|e| e.to_string())?;
            *lock(&s.part) = None;
            Ok::<PathBuf, String>(dest)
        }
        .await;
        match result {
            Ok(p) => {
                lock(&tracker).finish(&f.id);
                saved.push(p);
            }
            Err(e) => {
                lock(&tracker).fail(&f.id, Some(e.clone()));
                stopped.over = true;
                return say("failed", done, Some(e), None, None);
            }
        }
    }
    stopped.over = true;
    saved.sort();
    let folder = Some(dir.to_string_lossy().into_owned());
    let first = saved.first().map(|p| p.to_string_lossy().into_owned());
    inner.remember(Received {
        id: random_id(),
        at: now_ms(),
        from: s.alias.clone(),
        fingerprint: s.fingerprint.clone(),
        device_model: s.device_model.clone(),
        device_type: s.device_type.clone(),
        text: None,
        files: count,
        bytes: total,
        paths: saved.iter().take(20).map(|p| p.to_string_lossy().into_owned()).collect(),
        folder: folder.clone(),
    });
    say("done", total, None, folder, first);
}

fn part_of(path: &std::path::Path) -> PathBuf {
    let mut s = path.as_os_str().to_owned();
    s.push(".part");
    PathBuf::from(s)
}

/// A value for a query string (file ids are usually plain; anything else is escaped).
fn query_value(v: &str) -> String {
    v.bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) {
                (b as char).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::parse_link;

    #[test]
    fn links_as_localsend_shows_them() {
        assert_eq!(parse_link("http://192.168.31.25:53317"), Some((false, "192.168.31.25".into(), 53317)));
        assert_eq!(parse_link(" https://192.168.8.1:53318/ "), Some((true, "192.168.8.1".into(), 53318)));
        assert_eq!(parse_link("192.168.31.25"), Some((false, "192.168.31.25".into(), 53317)));
        assert_eq!(parse_link("http://[fe80::1]:53317/x"), Some((false, "fe80::1".into(), 53317)));
        assert_eq!(parse_link("ftp://x"), None);
        assert_eq!(parse_link("http://:53317"), None);
        assert_eq!(parse_link("http://host:notaport"), None);
    }
}
