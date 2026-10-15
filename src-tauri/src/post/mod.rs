//! Pet Post (docs/INTERACTIONS.md, "Pet Post"): files and text between devices on the
//! local network, with the LocalSend protocol v2, so ePet works with the LocalSend apps.
//! The protocol's plain logic is in `desktoppet_core::post`; here are the network parts:
//! the HTTPS server (server.rs), discovery (discovery.rs) and sending (client.rs).
//!
//! Off until the user turns it on (Settings → Pet Post): only then does ePet listen on the
//! network. The pet window sends the settings (`post_configure`) and shows what happens
//! (the `post-*` events).

mod client;
mod discovery;
mod server;
#[cfg(test)]
mod tests;
mod tls;

use std::collections::{HashMap, HashSet};
use std::net::IpAddr;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard};

use desktoppet_core::post::{DeviceInfo, PinGuard, ReceiveSession, PROTOCOL_VERSION};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;
use tokio::sync::{oneshot, watch};

use crate::state::now_ms;

type CmdResult<T> = Result<T, String>;

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

/// Settings → Pet Post, as the pet window sends them.
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Config {
    pub enabled: bool,
    /// The name other devices see.
    pub alias: String,
    /// Asked of senders when set.
    pub pin: String,
    /// Deliveries from a trusted device are taken without asking.
    pub auto_accept_trusted: bool,
    /// Fingerprints of trusted devices.
    pub trusted: Vec<String>,
    /// Where received files go (empty: Downloads/ePet).
    pub save_dir: String,
    /// The port to listen on (0: LocalSend's, 53317). Tests use another.
    pub port: u16,
}

/// A device found on the network.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    pub fingerprint: String,
    pub alias: String,
    pub device_model: Option<String>,
    pub device_type: String,
    pub ip: IpAddr,
    pub port: u16,
    pub https: bool,
    pub last_seen: i64,
}

impl Device {
    fn from_info(info: &DeviceInfo, ip: IpAddr) -> Self {
        let device_type = match info.device_type.as_deref() {
            Some(t @ ("mobile" | "desktop" | "web" | "headless" | "server")) => t.to_string(),
            _ => "desktop".into(),
        };
        Device {
            fingerprint: info.fingerprint.to_ascii_uppercase(),
            alias: info.alias.chars().take(64).collect(),
            device_model: info.device_model.clone(),
            device_type,
            ip,
            port: info.port.unwrap_or(desktoppet_core::post::DEFAULT_PORT),
            https: info.protocol.as_deref() != Some("http"),
            last_seen: now_ms(),
        }
    }
}

/// Is Pet Post listening, and where.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub running: bool,
    pub port: u16,
    pub alias: String,
    pub fingerprint: String,
    /// Why it isn't running although it's on.
    pub error: Option<String>,
    /// Where received files go.
    pub save_dir: String,
    /// This computer's name (for the default name others see).
    pub computer: String,
}

/// A delivery or transfer's progress ("post-transfer").
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Transfer {
    /// "in" (receiving) or "out" (sending).
    pub direction: &'static str,
    /// waiting | receiving | sending | done | declined | busy | pin | tooMany | failed | cancelled
    pub state: &'static str,
    /// The other device's name.
    pub peer: String,
    pub done: u64,
    pub total: u64,
    pub files: usize,
    /// Received: the save folder and the first file.
    pub folder: Option<String>,
    pub first: Option<String>,
    pub error: Option<String>,
}

/// Someone wants to send files ("post-offer"): the pet asks, `post_answer` answers.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Offer {
    pub id: String,
    pub alias: String,
    pub device_model: Option<String>,
    /// Proven by its certificate (empty when not: then it can't be trusted).
    pub fingerprint: String,
    pub files: usize,
    pub bytes: u64,
    /// The first few names.
    pub names: Vec<String>,
}

/// A text message ("post-text").
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextMessage {
    pub alias: String,
    pub text: String,
}

/// What's being received: one delivery at a time (as in LocalSend).
pub(crate) enum Receive {
    Idle,
    /// Waiting for the user's answer.
    Offered {
        id: String,
        ip: IpAddr,
        answer: Option<oneshot::Sender<bool>>,
        cancel: Option<oneshot::Sender<()>>,
    },
    Active(Box<Active>),
}

pub(crate) struct Active {
    pub session: ReceiveSession,
    pub save_dir: PathBuf,
    /// Final paths taken by files of this delivery (two may have the same name).
    pub reserved: HashSet<PathBuf>,
    pub done_bytes: u64,
    pub last_activity: i64,
    pub last_emit: i64,
}

pub(crate) struct Running {
    pub port: u16,
    pub stop: watch::Sender<bool>,
    pub udp: Option<Arc<tokio::net::UdpSocket>>,
}

/// Sends an event (name, JSON payload) to the windows.
pub(crate) type EmitFn = Box<dyn Fn(&str, serde_json::Value) + Send + Sync>;

pub struct Inner {
    /// Sends an event to the windows (`post-*`).
    emit: EmitFn,
    /// Where the identity is kept.
    data_dir: PathBuf,
    /// Received files go to `<downloads>/ePet` unless set otherwise.
    downloads: PathBuf,
    pub(crate) config: Mutex<Config>,
    pub(crate) identity: Mutex<Option<tls::Identity>>,
    pub(crate) running: Mutex<Option<Running>>,
    pub(crate) error: Mutex<Option<String>>,
    pub(crate) devices: Mutex<HashMap<String, Device>>,
    pub(crate) pins: Mutex<PinGuard>,
    pub(crate) receive: Mutex<Receive>,
    /// The delivery being sent: its task, and where to say it's cancelled.
    pub(crate) sending: Mutex<Option<client::Sending>>,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

impl Inner {
    pub(crate) fn emit(&self, event: &str, payload: impl Serialize) {
        if let Ok(v) = serde_json::to_value(payload) {
            (self.emit)(event, v);
        }
    }

    pub(crate) fn config(&self) -> Config {
        lock(&self.config).clone()
    }

    pub(crate) fn identity(&self) -> Option<tls::Identity> {
        lock(&self.identity).clone()
    }

    pub(crate) fn port(&self) -> u16 {
        lock(&self.running).as_ref().map_or(0, |r| r.port)
    }

    /// Who this device is, as told to others.
    pub(crate) fn info(&self, with_address: bool) -> DeviceInfo {
        let config = self.config();
        let fingerprint = self.identity().map(|i| i.fingerprint).unwrap_or_default();
        DeviceInfo {
            alias: if config.alias.trim().is_empty() { crate::backup::device().name } else { config.alias },
            version: PROTOCOL_VERSION.into(),
            device_model: Some(
                match std::env::consts::OS {
                    "macos" => "macOS",
                    "windows" => "Windows",
                    _ => "Linux",
                }
                .into(),
            ),
            device_type: Some("desktop".into()),
            fingerprint,
            port: with_address.then(|| self.port()),
            protocol: with_address.then(|| "https".into()),
            download: false,
        }
    }

    pub(crate) fn save_dir(&self) -> PathBuf {
        let set = self.config().save_dir;
        if !set.trim().is_empty() {
            return PathBuf::from(set);
        }
        self.downloads.join("ePet")
    }

    pub(crate) fn add_device(&self, device: Device) {
        let own = self.identity().map(|i| i.fingerprint).unwrap_or_default();
        if device.fingerprint.is_empty() || device.fingerprint == own {
            return;
        }
        let list = {
            let mut devices = lock(&self.devices);
            devices.insert(device.fingerprint.clone(), device);
            sorted(&devices)
        };
        self.emit("post-devices", list);
    }

    pub(crate) fn devices(&self) -> Vec<Device> {
        sorted(&lock(&self.devices))
    }

    pub(crate) fn transfer(&self, t: Transfer) {
        self.emit("post-transfer", t);
    }

    pub(crate) fn status(&self) -> Status {
        let running = lock(&self.running).is_some();
        let info = self.info(false);
        Status {
            running,
            port: self.port(),
            alias: info.alias,
            fingerprint: info.fingerprint,
            error: lock(&self.error).clone(),
            save_dir: self.save_dir().to_string_lossy().into_owned(),
            computer: crate::backup::device().name,
        }
    }

    fn emit_status(&self) {
        self.emit("post-status", self.status());
    }
}

fn sorted(devices: &HashMap<String, Device>) -> Vec<Device> {
    let mut list: Vec<Device> = devices.values().cloned().collect();
    list.sort_by(|a, b| a.alias.to_lowercase().cmp(&b.alias.to_lowercase()).then(a.fingerprint.cmp(&b.fingerprint)));
    list
}

/// Pet Post's state (managed by Tauri).
pub struct Post(pub(crate) Arc<Inner>);

impl Post {
    pub fn new(app: AppHandle) -> Self {
        let data_dir = app.path().app_data_dir().unwrap_or_default();
        let downloads = app.path().download_dir().or_else(|_| app.path().home_dir()).unwrap_or_default();
        let emitter = app.clone();
        let emit = move |event: &str, payload: serde_json::Value| {
            let _ = emitter.emit(event, payload);
        };
        Post::with(Box::new(emit), data_dir, downloads)
    }

    pub(crate) fn with(emit: EmitFn, data_dir: PathBuf, downloads: PathBuf) -> Self {
        Post(Arc::new(Inner {
            emit,
            data_dir,
            downloads,
            config: Mutex::new(Config::default()),
            identity: Mutex::new(None),
            running: Mutex::new(None),
            error: Mutex::new(None),
            devices: Mutex::new(HashMap::new()),
            pins: Mutex::new(PinGuard::default()),
            receive: Mutex::new(Receive::Idle),
            sending: Mutex::new(None),
        }))
    }
}

/// Stops listening (and drops what's found and what's being received).
fn stop(inner: &Inner) {
    if let Some(r) = lock(&inner.running).take() {
        let _ = r.stop.send(true);
    }
    lock(&inner.devices).clear();
    *lock(&inner.receive) = Receive::Idle;
    inner.emit("post-devices", Vec::<Device>::new());
}

async fn start(inner: &Arc<Inner>, port: u16) -> Result<(), String> {
    if lock(&inner.identity).is_none() {
        let dir = inner.data_dir.clone();
        let id =
            tauri::async_runtime::spawn_blocking(move || tls::Identity::load_or_create(&dir)).await.map_err(err)??;
        *lock(&inner.identity) = Some(id);
    }
    let id = inner.identity().ok_or("no identity")?;
    let tls = tls::server_config(&id)?;
    let (stop_tx, stop_rx) = watch::channel(false);
    let port = server::spawn(inner.clone(), port, tls, stop_rx.clone()).await?;
    // Discovery listens on LocalSend's port whatever port the server got (another app
    // may hold the TCP port; the UDP one is shared).
    let udp = match discovery::spawn(inner.clone(), stop_rx).await {
        Ok(udp) => Some(udp),
        Err(e) => {
            log::warn!("Pet Post: no multicast discovery: {e}");
            None
        }
    };
    *lock(&inner.running) = Some(Running { port, stop: stop_tx, udp });
    Ok(())
}

// --- Commands ---------------------------------------------------------------------

/// The pet window sends Settings → Pet Post (at start and whenever they change).
#[tauri::command]
pub async fn post_configure(post: State<'_, Post>, config: Config) -> CmdResult<Status> {
    Ok(configure(&post.0, config).await)
}

pub(crate) async fn configure(inner: &Arc<Inner>, config: Config) -> Status {
    let before = std::mem::replace(&mut *lock(&inner.config), config.clone());
    let running = lock(&inner.running).is_some();
    let restart = before.port != config.port;
    if !config.enabled {
        if running {
            stop(inner);
        }
        *lock(&inner.error) = None;
    } else if !running || restart {
        if running {
            stop(inner);
        }
        let result = start(inner, config.port).await;
        *lock(&inner.error) = result.as_ref().err().cloned();
        if let Err(e) = &result {
            log::error!("Pet Post could not start: {e}");
        } else {
            discovery::refresh(inner.clone());
        }
    } else if before.alias != config.alias {
        // Tell the others the new name.
        discovery::refresh(inner.clone());
    }
    inner.emit_status();
    inner.status()
}

#[tauri::command]
pub fn post_status(post: State<'_, Post>) -> Status {
    post.0.status()
}

#[tauri::command]
pub fn post_devices(post: State<'_, Post>) -> Vec<Device> {
    post.0.devices()
}

/// Looks for devices again (multicast, then every address of this network).
#[tauri::command]
pub fn post_refresh(post: State<'_, Post>) {
    let inner = post.0.clone();
    if lock(&inner.running).is_some() {
        lock(&inner.devices).retain(|_, d| now_ms() - d.last_seen < 10_000);
        inner.emit("post-devices", inner.devices());
        discovery::refresh(inner);
    }
}

/// Sends files and folders (`paths`), or a text, to a device found (by fingerprint).
#[tauri::command]
pub fn post_send(
    post: State<'_, Post>,
    to: String,
    paths: Vec<String>,
    text: Option<String>,
    pin: Option<String>,
) -> CmdResult<()> {
    let inner = post.0.clone();
    let device = lock(&inner.devices).get(&to.to_ascii_uppercase()).cloned().ok_or("That device is gone.")?;
    client::send(inner, device, paths.into_iter().map(PathBuf::from).collect(), text, pin)
}

#[tauri::command]
pub fn post_cancel_send(post: State<'_, Post>) {
    client::cancel(post.0.clone());
}

/// The user's answer to a "post-offer".
#[tauri::command]
pub fn post_answer(post: State<'_, Post>, id: String, accept: bool) {
    answer(&post.0, &id, accept);
}

pub(crate) fn answer(inner: &Inner, id: &str, accept: bool) {
    let mut receive = lock(&inner.receive);
    if let Receive::Offered { id: offered, answer, .. } = &mut *receive {
        if *offered == id {
            if let Some(tx) = answer.take() {
                let _ = tx.send(accept);
            }
        }
    }
}

/// Picks files (or a folder) to send.
#[tauri::command]
pub async fn post_pick(app: AppHandle, folder: bool) -> Option<Vec<String>> {
    let (tx, rx) = oneshot::channel();
    let dialog = app.dialog().file();
    if folder {
        dialog.pick_folders(move |p| {
            let _ = tx.send(p);
        });
    } else {
        dialog.pick_files(move |p| {
            let _ = tx.send(p);
        });
    }
    let picked = rx.await.ok().flatten()?;
    Some(picked.into_iter().filter_map(|p| p.into_path().ok()).map(|p| p.to_string_lossy().into_owned()).collect())
}

/// Picks the folder received files go to.
#[tauri::command]
pub async fn post_pick_save_dir(app: AppHandle, post: State<'_, Post>) -> CmdResult<Option<String>> {
    let (tx, rx) = oneshot::channel();
    app.dialog().file().set_directory(post.0.save_dir()).pick_folder(move |p| {
        let _ = tx.send(p);
    });
    let picked = rx.await.ok().flatten();
    Ok(picked.and_then(|p| p.into_path().ok()).map(|p| p.to_string_lossy().into_owned()))
}

/// Opens a received file's folder (showing the file), or the save folder.
#[tauri::command]
pub fn post_open(app: AppHandle, post: State<'_, Post>, path: Option<String>) -> CmdResult<()> {
    match path.map(PathBuf::from).filter(|p| p.exists()) {
        Some(p) if p.is_file() => app.opener().reveal_item_in_dir(&p).map_err(err),
        Some(p) => app.opener().open_path(p.to_string_lossy(), None::<&str>).map_err(err),
        None => {
            let dir = post.0.save_dir();
            std::fs::create_dir_all(&dir).map_err(err)?;
            app.opener().open_path(dir.to_string_lossy(), None::<&str>).map_err(err)
        }
    }
}

/// The hidden pet (or one that stepped aside) comes out to ask about a delivery or show
/// a message. Whether it's out of sight (and so now out for it).
#[tauri::command]
pub fn post_peek(app: AppHandle) -> bool {
    crate::app_windows::peek(&app)
}

#[tauri::command]
pub fn open_post_window(app: AppHandle) -> CmdResult<()> {
    crate::app_windows::open_post(&app).map_err(err)
}
