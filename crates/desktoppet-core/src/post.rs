//! Pet Post (docs/INTERACTIONS.md, "Pet Post"): sending files on the local network with
//! the LocalSend protocol v2 (https://github.com/localsend/protocol), so ePet works with
//! the LocalSend apps as well as with another ePet.
//!
//! This module is the protocol's plain logic: its messages, the receiving session, PIN
//! attempts and safe file names. The network (HTTPS server, multicast, client) lives in
//! the app (src-tauri/src/post/).

use std::collections::{BTreeMap, HashMap};
use std::net::IpAddr;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// The protocol version ePet speaks.
pub const PROTOCOL_VERSION: &str = "2.1";
/// LocalSend's port (HTTP(S) and multicast) and multicast group.
pub const DEFAULT_PORT: u16 = 53317;
pub const MULTICAST_GROUP: [u8; 4] = [224, 0, 0, 167];
pub const API: &str = "/api/localsend/v2";

/// Who a device says it is: in multicast announcements, `register` and `prepare-upload`.
/// Unknown fields are ignored and most are optional: other apps fill in what they have.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DeviceInfo {
    pub alias: String,
    #[serde(default = "default_version")]
    pub version: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device_model: Option<String>,
    /// mobile | desktop | web | headless | server (others are shown as desktop).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device_type: Option<String>,
    /// In HTTPS mode the SHA-256 of the device's certificate (upper-case hex).
    #[serde(default)]
    pub fingerprint: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
    /// http | https
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub protocol: Option<String>,
    #[serde(default)]
    pub download: bool,
}

fn default_version() -> String {
    "2.0".into()
}

/// A multicast message: a device announcing itself (`announce: true`), or answering one.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Announcement {
    #[serde(flatten)]
    pub info: DeviceInfo,
    /// Older apps call it `announcement`.
    #[serde(default, alias = "announcement")]
    pub announce: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileInfo {
    pub id: String,
    /// May contain a relative folder path ("Photos/2026/a.jpg") when a folder is sent.
    pub file_name: String,
    pub size: u64,
    pub file_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
    /// A text message's text (LocalSend sends a message as one text/plain "file").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preview: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PrepareUpload {
    pub info: DeviceInfo,
    pub files: BTreeMap<String, FileInfo>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrepareUploadResponse {
    pub session_id: String,
    /// File id → the token its upload must carry.
    pub files: BTreeMap<String, String>,
}

/// How a request fails, with the protocol's HTTP status.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PostError {
    /// 400
    BadRequest,
    /// 401: PIN missing or wrong.
    Pin,
    /// 403: declined, or a wrong token / sender.
    Rejected,
    /// 409: receiving from someone else.
    Busy,
    /// 413-ish, sent as 400: more data than announced.
    TooLarge,
    /// 422: the data doesn't match its sha256.
    Checksum,
    /// 429: too many wrong PINs.
    TooMany,
    /// 500
    Internal,
}

impl PostError {
    pub fn status(self) -> u16 {
        match self {
            PostError::BadRequest | PostError::TooLarge => 400,
            PostError::Pin => 401,
            PostError::Rejected => 403,
            PostError::Busy => 409,
            PostError::Checksum => 422,
            PostError::TooMany => 429,
            PostError::Internal => 500,
        }
    }
}

/// A certificate's fingerprint as LocalSend writes it: SHA-256 of its DER, upper-case hex.
pub fn fingerprint(cert_der: &[u8]) -> String {
    hex_upper(&Sha256::digest(cert_der))
}

pub fn hex_upper(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02X}")).collect()
}

/// A random id (session ids, file ids, tokens; the fingerprint in plain-HTTP mode).
pub fn random_id() -> String {
    let mut b = [0u8; 16];
    // getrandom only fails without an OS source of randomness; the time is a poor but
    // harmless fallback (ids only need to be unguessable for the length of a session).
    if getrandom::getrandom(&mut b).is_err() {
        let t = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos();
        b = t.to_le_bytes();
    }
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// The text of a text message: one text/plain "file" with its text in `preview`.
pub fn text_message(files: &BTreeMap<String, FileInfo>) -> Option<&str> {
    let mut it = files.values();
    let f = it.next()?;
    if it.next().is_some() {
        return None;
    }
    let text = f.file_type == "text" || f.file_type.starts_with("text/plain");
    f.preview.as_deref().filter(|_| text)
}

/// A received file's place under the save folder, from the name the sender gave: folders
/// are kept ("Photos/a.jpg"), but never `..`, a drive or an absolute path; characters
/// Windows can't store and its reserved names (CON, NUL…) are replaced.
pub fn safe_relative_path(name: &str) -> PathBuf {
    let mut out = PathBuf::new();
    for part in name.split(['/', '\\']) {
        let clean = safe_component(part);
        if let Some(c) = clean {
            out.push(c);
        }
    }
    if out.as_os_str().is_empty() {
        out.push("file");
    }
    out
}

fn safe_component(part: &str) -> Option<String> {
    let mut s: String = part.chars().map(|c| if c.is_control() || "<>:\"|?*".contains(c) { '_' } else { c }).collect();
    // Windows drops trailing dots and spaces; "." and ".." are never names.
    while s.ends_with('.') || s.ends_with(' ') {
        s.pop();
    }
    let s = s.trim_start().to_string();
    if s.is_empty() {
        return None;
    }
    let stem = s.split('.').next().unwrap_or("").to_ascii_uppercase();
    let reserved = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || ((stem.starts_with("COM") || stem.starts_with("LPT"))
            && stem.len() == 4
            && stem.as_bytes()[3].is_ascii_digit());
    let s = if reserved { format!("_{s}") } else { s };
    Some(truncate_name(&s, 200))
}

/// At most `max` bytes, keeping the extension.
fn truncate_name(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    let (stem, ext) = match s.rfind('.') {
        Some(i) if s.len() - i <= 16 && i > 0 => (&s[..i], &s[i..]),
        _ => (s, ""),
    };
    let mut cut = max.saturating_sub(ext.len());
    while !stem.is_char_boundary(cut) {
        cut -= 1;
    }
    format!("{}{}", &stem[..cut], ext)
}

/// `dir/rel`, or `name (2).ext`, `name (3).ext`… if that's taken. The first folder of a
/// sent folder is renamed the same way, so a second copy lands beside the first.
pub fn unique_path(dir: &Path, rel: &Path, exists: impl Fn(&Path) -> bool) -> PathBuf {
    let first = dir.join(rel);
    if !exists(&first) {
        return first;
    }
    let mut parts = rel.components();
    let head = parts.next().map(|c| c.as_os_str().to_string_lossy().into_owned()).unwrap_or_default();
    let rest: PathBuf = parts.collect();
    let is_file = rest.as_os_str().is_empty();
    let (stem, ext) = match head.rfind('.') {
        Some(i) if is_file && i > 0 => (head[..i].to_string(), head[i..].to_string()),
        _ => (head.clone(), String::new()),
    };
    for n in 2.. {
        let renamed = dir.join(format!("{stem} ({n}){ext}"));
        // (Joining an empty path would add a trailing separator.)
        let candidate = if is_file { renamed } else { renamed.join(&rest) };
        if !exists(&candidate) {
            return candidate;
        }
    }
    unreachable!()
}

/// A MIME type from a file name's extension (what LocalSend shows an icon for).
pub fn mime_type(name: &str) -> &'static str {
    let ext = name.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase()).unwrap_or_default();
    match ext.as_str() {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "heic" => "image/heic",
        "bmp" => "image/bmp",
        "svg" => "image/svg+xml",
        "mp4" => "video/mp4",
        "mov" => "video/quicktime",
        "mkv" => "video/x-matroska",
        "webm" => "video/webm",
        "mp3" => "audio/mpeg",
        "m4a" => "audio/mp4",
        "wav" => "audio/wav",
        "flac" => "audio/flac",
        "ogg" => "audio/ogg",
        "pdf" => "application/pdf",
        "txt" | "md" | "log" => "text/plain",
        "html" | "htm" => "text/html",
        "json" => "application/json",
        "zip" => "application/zip",
        "7z" => "application/x-7z-compressed",
        "rar" => "application/vnd.rar",
        "apk" => "application/vnd.android.package-archive",
        "doc" => "application/msword",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xls" => "application/vnd.ms-excel",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "ppt" => "application/vnd.ms-powerpoint",
        "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        _ => "application/octet-stream",
    }
}

/// Wrong PINs: after 5 from one address, it must wait a minute.
#[derive(Debug, Default)]
pub struct PinGuard {
    failures: HashMap<IpAddr, (u32, i64)>,
}

impl PinGuard {
    pub const MAX_TRIES: u32 = 5;
    pub const LOCK_MS: i64 = 60_000;

    /// Checks `given` against the PIN (`None` or "": no PIN needed).
    pub fn check(&mut self, pin: Option<&str>, given: Option<&str>, ip: IpAddr, now: i64) -> Result<(), PostError> {
        let Some(pin) = pin.filter(|p| !p.is_empty()) else {
            return Ok(());
        };
        if let Some((n, at)) = self.failures.get(&ip) {
            if *n >= Self::MAX_TRIES {
                if now - at < Self::LOCK_MS {
                    return Err(PostError::TooMany);
                }
                self.failures.remove(&ip);
            }
        }
        if given == Some(pin) {
            self.failures.remove(&ip);
            return Ok(());
        }
        // No PIN given yet is the sender asking whether one is needed, not a wrong guess.
        if given.is_some() {
            let e = self.failures.entry(ip).or_insert((0, now));
            e.0 += 1;
            e.1 = now;
        }
        Err(PostError::Pin)
    }
}

/// One file being received.
#[derive(Debug, Clone)]
pub struct IncomingFile {
    pub info: FileInfo,
    pub token: String,
    pub done: bool,
    /// Where it was saved, once done.
    pub saved: Option<PathBuf>,
}

/// The accepted delivery being received (one at a time, as in LocalSend).
#[derive(Debug, Clone)]
pub struct ReceiveSession {
    pub id: String,
    pub sender: IpAddr,
    pub from: DeviceInfo,
    pub files: BTreeMap<String, IncomingFile>,
}

impl ReceiveSession {
    pub fn new(sender: IpAddr, from: DeviceInfo, files: BTreeMap<String, FileInfo>) -> Self {
        let files = files
            .into_iter()
            .map(|(id, info)| (id, IncomingFile { info, token: random_id(), done: false, saved: None }))
            .collect();
        Self { id: random_id(), sender, from, files }
    }

    pub fn response(&self) -> PrepareUploadResponse {
        PrepareUploadResponse {
            session_id: self.id.clone(),
            files: self.files.iter().map(|(id, f)| (id.clone(), f.token.clone())).collect(),
        }
    }

    /// The file an upload is for, if it comes from the sender with the right token.
    pub fn check_upload(&self, session: &str, file: &str, token: &str, ip: IpAddr) -> Result<&IncomingFile, PostError> {
        if session != self.id {
            return Err(PostError::Busy);
        }
        let f = self.files.get(file).ok_or(PostError::Rejected)?;
        if ip != self.sender || f.token != token || f.done {
            return Err(PostError::Rejected);
        }
        Ok(f)
    }

    pub fn total_bytes(&self) -> u64 {
        self.files.values().map(|f| f.info.size).sum()
    }

    pub fn finished(&self) -> bool {
        self.files.values().all(|f| f.done)
    }
}

/// Checks a received file's data against the sha256 the sender gave (any case).
pub fn checksum_matches(expected: Option<&str>, actual: &[u8]) -> bool {
    match expected {
        Some(e) if !e.is_empty() => e.eq_ignore_ascii_case(&hex_upper(actual)),
        _ => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn reads_the_protocol_examples() {
        // From the protocol's README (multicast announcement and prepare-upload).
        let a: Announcement = serde_json::from_str(
            r#"{"alias":"Nice Orange","version":"2.0","deviceModel":"Samsung","deviceType":"mobile",
                "fingerprint":"random string","port":53317,"protocol":"https","download":true,"announce":true}"#,
        )
        .unwrap();
        assert!(a.announce);
        assert_eq!(a.info.alias, "Nice Orange");
        assert_eq!(a.info.port, Some(53317));
        assert_eq!(a.info.protocol.as_deref(), Some("https"));
        let old: Announcement =
            serde_json::from_str(r#"{"alias":"Old","fingerprint":"x","announcement":true,"extra":1}"#).unwrap();
        assert!(old.announce);
        assert_eq!(old.info.version, "2.0");

        let p: PrepareUpload = serde_json::from_str(
            r#"{"info":{"alias":"Nice Orange","version":"2.0","deviceModel":"Samsung","deviceType":"mobile",
                "fingerprint":"random string","port":53317,"protocol":"https","download":true},
               "files":{"some file id":{"id":"some file id","fileName":"my image.png","size":324242,
                 "fileType":"image/jpeg","sha256":"*sha256 hash*","preview":"*preview data*",
                 "metadata":{"modified":"2021-01-01T12:34:56Z","accessed":"2021-01-01T12:34:56Z"}}}}"#,
        )
        .unwrap();
        assert_eq!(p.files["some file id"].size, 324242);
        assert!(text_message(&p.files).is_none());
    }

    #[test]
    fn writes_camel_case_without_empty_fields() {
        let info = DeviceInfo {
            alias: "Cat".into(),
            version: PROTOCOL_VERSION.into(),
            device_type: Some("desktop".into()),
            fingerprint: "AB".into(),
            port: Some(53317),
            protocol: Some("https".into()),
            ..Default::default()
        };
        let v = serde_json::to_value(Announcement { info, announce: true }).unwrap();
        assert_eq!(v["deviceType"], "desktop");
        assert_eq!(v["announce"], true);
        assert!(v.get("deviceModel").is_none());
        let r = PrepareUploadResponse { session_id: "s".into(), files: BTreeMap::new() };
        assert!(serde_json::to_string(&r).unwrap().contains("\"sessionId\""));
    }

    #[test]
    fn a_text_message_is_one_text_file_with_its_text() {
        let mut files = BTreeMap::new();
        let f = FileInfo {
            id: "1".into(),
            file_name: "msg.txt".into(),
            size: 5,
            file_type: "text/plain".into(),
            sha256: None,
            preview: Some("hello".into()),
            metadata: None,
        };
        files.insert("1".into(), f.clone());
        assert_eq!(text_message(&files), Some("hello"));
        files.insert("2".into(), FileInfo { id: "2".into(), ..f });
        assert_eq!(text_message(&files), None);
    }

    #[test]
    fn file_names_stay_inside_the_save_folder() {
        let p = |s: &str| safe_relative_path(s).to_string_lossy().replace('\\', "/");
        assert_eq!(p("a.jpg"), "a.jpg");
        assert_eq!(p("Photos/2026/a.jpg"), "Photos/2026/a.jpg");
        assert_eq!(p("../../etc/passwd"), "etc/passwd");
        assert_eq!(p("..\\..\\Windows\\x.dll"), "Windows/x.dll");
        assert_eq!(p("/abs/x"), "abs/x");
        assert_eq!(p("C:\\x.txt"), "C_/x.txt");
        assert_eq!(p("what?.txt"), "what_.txt");
        assert_eq!(p("CON.txt"), "_CON.txt");
        assert_eq!(p("com1"), "_com1");
        assert_eq!(p("console.txt"), "console.txt");
        assert_eq!(p("name. "), "name");
        assert_eq!(p(".."), "file");
        assert_eq!(p(""), "file");
        assert_eq!(p("照片.jpg"), "照片.jpg");
        let long = format!("{}.jpg", "猫".repeat(100));
        let cut = p(&long);
        assert!(cut.len() <= 200 && cut.ends_with(".jpg"), "{cut}");
    }

    #[test]
    fn taken_names_get_a_number() {
        let dir = Path::new("/save");
        let taken: HashSet<PathBuf> =
            ["/save/a.jpg", "/save/a (2).jpg", "/save/Photos/x.png"].iter().map(PathBuf::from).collect();
        let exists = |p: &Path| taken.contains(p);
        assert_eq!(unique_path(dir, Path::new("b.jpg"), exists), PathBuf::from("/save/b.jpg"));
        assert_eq!(unique_path(dir, Path::new("a.jpg"), exists).to_string_lossy(), "/save/a (3).jpg");
        assert_eq!(unique_path(dir, Path::new("Photos/x.png"), exists), PathBuf::from("/save/Photos (2)/x.png"));
        assert_eq!(unique_path(dir, Path::new("Photos/y.png"), exists), PathBuf::from("/save/Photos/y.png"));
    }

    #[test]
    fn five_wrong_pins_lock_for_a_minute() {
        let ip: IpAddr = "192.168.1.9".parse().unwrap();
        let other: IpAddr = "192.168.1.10".parse().unwrap();
        let mut g = PinGuard::default();
        assert_eq!(g.check(None, None, ip, 0), Ok(()));
        assert_eq!(g.check(Some(""), None, ip, 0), Ok(()));
        // Asking without a PIN isn't a wrong guess.
        for _ in 0..10 {
            assert_eq!(g.check(Some("1234"), None, ip, 0), Err(PostError::Pin));
        }
        for _ in 0..5 {
            assert_eq!(g.check(Some("1234"), Some("0000"), ip, 0), Err(PostError::Pin));
        }
        assert_eq!(g.check(Some("1234"), Some("1234"), ip, 1000), Err(PostError::TooMany));
        assert_eq!(g.check(Some("1234"), Some("1234"), other, 1000), Ok(()));
        assert_eq!(g.check(Some("1234"), Some("1234"), ip, 61_000), Ok(()));
        assert_eq!(PostError::TooMany.status(), 429);
    }

    #[test]
    fn uploads_need_the_session_the_token_and_the_sender() {
        let ip: IpAddr = "10.0.0.2".parse().unwrap();
        let mut files = BTreeMap::new();
        files.insert(
            "f".into(),
            FileInfo {
                id: "f".into(),
                file_name: "a".into(),
                size: 3,
                file_type: "application/octet-stream".into(),
                sha256: None,
                preview: None,
                metadata: None,
            },
        );
        let mut s = ReceiveSession::new(ip, DeviceInfo::default(), files);
        let r = s.response();
        let token = r.files["f"].clone();
        assert_eq!(r.session_id, s.id);
        assert!(s.check_upload(&s.id, "f", &token, ip).is_ok());
        assert_eq!(s.check_upload("other", "f", &token, ip).unwrap_err(), PostError::Busy);
        assert_eq!(s.check_upload(&s.id, "f", "bad", ip).unwrap_err(), PostError::Rejected);
        assert_eq!(s.check_upload(&s.id, "g", &token, ip).unwrap_err(), PostError::Rejected);
        assert_eq!(s.check_upload(&s.id, "f", &token, "10.0.0.3".parse().unwrap()).unwrap_err(), PostError::Rejected);
        assert_eq!(s.total_bytes(), 3);
        assert!(!s.finished());
        s.files.get_mut("f").unwrap().done = true;
        assert!(s.finished());
        let id = s.id.clone();
        assert_eq!(s.check_upload(&id, "f", &token, ip).unwrap_err(), PostError::Rejected);
    }

    #[test]
    fn fingerprints_and_checksums_are_upper_case_hex() {
        // SHA-256 of "abc".
        let abc = "BA7816BF8F01CFEA414140DE5DAE2223B00361A396177A9CB410FF61F20015AD";
        assert_eq!(fingerprint(b"abc"), abc);
        let digest = Sha256::digest(b"abc");
        assert!(checksum_matches(Some(&abc.to_lowercase()), &digest));
        assert!(!checksum_matches(Some("00"), &digest));
        assert!(checksum_matches(None, &digest));
        assert_eq!(random_id().len(), 32);
        assert_ne!(random_id(), random_id());
        assert_eq!(mime_type("A.JPG"), "image/jpeg");
        assert_eq!(mime_type("noext"), "application/octet-stream");
    }
}
