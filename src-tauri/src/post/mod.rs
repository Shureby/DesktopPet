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
mod tailscale;
#[cfg(test)]
mod tests;
mod tls;

use std::collections::{HashMap, HashSet};
use std::net::{IpAddr, Ipv4Addr};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard};

use desktoppet_core::post::{DeviceInfo, PinGuard, ReceiveSession, Tailnet, DEFAULT_PORT, PROTOCOL_VERSION};
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
    /// Devices added by address (beyond this network: behind another router, Tailscale).
    pub devices: Vec<Saved>,
    /// Extra networks to look in, such as "192.168.8.0/24".
    pub networks: Vec<String>,
    /// Lists the devices of the Tailscale network (if Tailscale is installed).
    pub tailscale: bool,
    /// Fingerprints of blocked devices (Verify: the icons didn't match): not listed, nothing
    /// sent to them, and whatever they ask is refused.
    pub blocked: Vec<String>,
}

/// A device added by address, as remembered in the settings.
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Saved {
    /// An IP address or a host name (a Tailscale MagicDNS name, say).
    pub address: String,
    pub port: u16,
    /// Its certificate's, when it was added: another one there is another device.
    pub fingerprint: String,
    pub alias: String,
    pub device_type: String,
    /// "address" (added by address) or "favorite" (♥ on a device found): a favorite keeps
    /// the way it was found ("lan", "tailnet"…) as its source.
    pub via: String,
}

impl Saved {
    fn favorite(&self) -> bool {
        self.via == "favorite"
    }
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
    /// How it was found: "lan" | "address" | "network" | "tailnet".
    pub source: &'static str,
    /// We reached it at `ip` ourselves. Otherwise it only reached us, and `ip` may be a
    /// router's (one it's behind, NAT), where it can't be reached.
    pub reached: bool,
    /// Added by address: that address (as typed).
    pub address: Option<String>,
    /// Added by address and not answering now.
    pub online: bool,
    /// Added by address, and what answers there now has another certificate: that one's
    /// fingerprint. Nothing is sent to it until the user trusts the new one.
    pub changed_to: Option<String>,
    /// It has reached this computer itself (introduced itself, sent something). Reached by
    /// us but never this: it may be unable to (another router, a firewall).
    pub came_in: bool,
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
            source: "lan",
            reached: false,
            address: None,
            online: true,
            changed_to: None,
            came_in: false,
        }
    }

    /// A device added by address, before (or without) an answer from it.
    fn saved(s: &Saved) -> Self {
        Device {
            fingerprint: s.fingerprint.to_ascii_uppercase(),
            alias: if s.alias.is_empty() { s.address.clone() } else { s.alias.clone() },
            device_model: None,
            device_type: if s.device_type.is_empty() { "desktop".into() } else { s.device_type.clone() },
            ip: IpAddr::V4(Ipv4Addr::UNSPECIFIED),
            port: if s.port == 0 { DEFAULT_PORT } else { s.port },
            https: true,
            last_seen: 0,
            source: if s.favorite() { "lan" } else { "address" },
            reached: false,
            address: Some(s.address.clone()),
            online: false,
            changed_to: None,
            came_in: false,
        }
    }
}

/// Which way of finding a device says more about it (kept when another one finds it too).
fn rank(source: &str) -> u8 {
    match source {
        "address" => 3,
        "tailnet" | "network" => 2,
        _ => 1,
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
    /// Where others can reach it (to add it by address), with `port`.
    pub addresses: Vec<Address>,
}

/// One of this computer's addresses.
#[derive(Debug, Clone, Default, Serialize)]
pub struct Address {
    pub ip: String,
    /// Its adapter, as the system names it.
    pub name: String,
    /// "ethernet" | "wifi" | "lan" | "tailscale" | "virtual" (desktoppet_core::post::network_kind).
    pub kind: &'static str,
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
    /// Its fingerprint (receiving: only when its certificate proves it).
    pub fingerprint: String,
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
    /// When it's declined if nobody answers (ms).
    pub until: i64,
}

/// Something received, as the Pet Post window lists it ("post-history"; kept, the latest
/// first, in the app's data folder).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Received {
    pub id: String,
    pub at: i64,
    /// Who sent it.
    pub from: String,
    /// Its fingerprint, proven by its certificate (empty when not): Receive → Recent
    /// senders, with Verify.
    pub fingerprint: String,
    pub device_model: Option<String>,
    /// "mobile" | "desktop" | … (as `Device`).
    pub device_type: String,
    /// A text message (else files).
    pub text: Option<String>,
    pub files: usize,
    pub bytes: u64,
    /// Where they were saved (the first 20).
    pub paths: Vec<String>,
    pub folder: Option<String>,
}

/// How many things received are kept.
const HISTORY: usize = 50;

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
        /// For a window opened meanwhile (`post_pending_offer`).
        offer: Box<Offer>,
    },
    Active(Box<Active>),
}

pub(crate) struct Active {
    pub session: ReceiveSession,
    /// The sender's fingerprint, proven by its certificate (empty when not).
    pub fingerprint: String,
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
    /// What Tailscale said last.
    pub(crate) tailnet: Mutex<Tailnet>,
    /// What was received (read from its file when first needed).
    pub(crate) history: Mutex<Option<Vec<Received>>>,
    /// Devices that asked to compare Verify (fingerprint → who, when, and the answer to give).
    pub(crate) verify_asked: Mutex<HashMap<String, Asked>>,
    /// What the user decided on Verify for a device (fingerprint → match or not), for its
    /// asking ("verify-result").
    pub(crate) verify_decided: Mutex<HashMap<String, watch::Sender<Option<bool>>>>,
    /// Devices (fingerprints) that reached this computer themselves.
    pub(crate) came_in: Mutex<HashSet<String>>,
}

/// A device asked to compare Verify.
pub(crate) struct Asked {
    pub alias: String,
    pub at: i64,
    /// Show (true) or Decline (false), while it waits.
    pub answer: Option<oneshot::Sender<bool>>,
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

    /// Lists a device found (or updates it). An address we reached it at is kept when it
    /// then reaches us from another one: that's a router it's behind (NAT).
    pub(crate) fn add_device(&self, mut device: Device) {
        let own = self.identity().map(|i| i.fingerprint).unwrap_or_default();
        if device.fingerprint.is_empty() || device.fingerprint == own || self.blocked(&device.fingerprint) {
            return;
        }
        device.came_in |= lock(&self.came_in).contains(&device.fingerprint);
        let list = {
            let mut devices = lock(&self.devices);
            if let Some(old) = devices.get(&device.fingerprint) {
                device.came_in |= old.came_in;
                if old.reached && !device.reached && old.online {
                    device.ip = old.ip;
                    device.port = old.port;
                    device.https = old.https;
                    device.reached = true;
                }
                if rank(old.source) > rank(device.source) {
                    device.source = old.source;
                }
                if device.address.is_none() {
                    device.address = old.address.clone();
                }
            }
            devices.insert(device.fingerprint.clone(), device);
            sorted(&devices)
        };
        self.emit("post-devices", list);
    }

    /// A device reached this computer itself (by its own request): listed as such.
    pub(crate) fn add_came_in(&self, mut device: Device) {
        lock(&self.came_in).insert(device.fingerprint.clone());
        device.came_in = true;
        self.add_device(device);
    }

    /// Whether the device (by fingerprint) is blocked.
    pub(crate) fn blocked(&self, fingerprint: &str) -> bool {
        lock(&self.config).blocked.iter().any(|b| b.eq_ignore_ascii_case(fingerprint))
    }

    /// Where the user's Verify decision on a device is told (and waited for).
    pub(crate) fn decided(&self, fingerprint: &str) -> watch::Sender<Option<bool>> {
        lock(&self.verify_decided)
            .entry(fingerprint.to_ascii_uppercase())
            .or_insert_with(|| watch::channel(None).0)
            .clone()
    }

    /// Changes a listed device (and says so).
    pub(crate) fn update_device(&self, fingerprint: &str, change: impl FnOnce(&mut Device)) {
        let list = {
            let mut devices = lock(&self.devices);
            let Some(d) = devices.get_mut(fingerprint) else { return };
            change(d);
            sorted(&devices)
        };
        self.emit("post-devices", list);
    }

    /// Lists the devices added by address (not answering until they do), and drops the
    /// ones removed from the settings.
    fn sync_saved(&self) {
        let config = self.config();
        let saved: Vec<&Saved> = config
            .devices
            .iter()
            .filter(|s| !config.blocked.iter().any(|b| b.eq_ignore_ascii_case(&s.fingerprint)))
            .collect();
        let list = {
            let mut devices = lock(&self.devices);
            devices.retain(|fp, _| !config.blocked.iter().any(|b| b.eq_ignore_ascii_case(fp)));
            // No longer kept: gone, unless found just now (then listed as found, until it isn't).
            let now = now_ms();
            devices.retain(|fp, d| {
                if d.address.is_none() || saved.iter().any(|s| s.fingerprint.eq_ignore_ascii_case(fp)) {
                    return true;
                }
                let found = d.reached && d.online && d.changed_to.is_none() && now - d.last_seen < 60_000;
                if found {
                    d.address = None;
                    if d.source == "address" {
                        d.source = "lan";
                    }
                }
                found
            });
            for s in &saved {
                let fp = s.fingerprint.to_ascii_uppercase();
                if fp.is_empty() {
                    continue;
                }
                match devices.get_mut(&fp) {
                    Some(d) => {
                        d.address = Some(s.address.clone());
                        if !s.favorite() {
                            d.source = "address";
                        }
                    }
                    None => {
                        devices.insert(fp, Device::saved(s));
                    }
                }
            }
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
            addresses: if running {
                discovery::own_addresses()
                    .into_iter()
                    .map(|(ip, name, kind)| Address { ip: ip.to_string(), name, kind })
                    .collect()
            } else {
                Vec::new()
            },
        }
    }

    fn history_file(&self) -> PathBuf {
        self.data_dir.join("post-history.json")
    }

    /// What was received, the latest first.
    pub(crate) fn history(&self) -> Vec<Received> {
        let mut h = lock(&self.history);
        h.get_or_insert_with(|| {
            std::fs::read(self.history_file()).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
        })
        .clone()
    }

    fn set_history(&self, list: Vec<Received>) {
        if let Ok(bytes) = serde_json::to_vec(&list) {
            let _ = std::fs::create_dir_all(&self.data_dir);
            if let Err(e) = std::fs::write(self.history_file(), bytes) {
                log::warn!("Pet Post: can't keep what was received: {e}");
            }
        }
        *lock(&self.history) = Some(list.clone());
        self.emit("post-history", list);
    }

    /// Keeps something received (the latest first, at most HISTORY).
    pub(crate) fn remember(&self, entry: Received) {
        let mut list = self.history();
        list.insert(0, entry);
        list.truncate(HISTORY);
        self.set_history(list);
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
            tailnet: Mutex::new(Tailnet::default()),
            history: Mutex::new(None),
            verify_asked: Mutex::new(HashMap::new()),
            verify_decided: Mutex::new(HashMap::new()),
            came_in: Mutex::new(HashSet::new()),
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
            inner.sync_saved();
            discovery::refresh(inner.clone());
        }
    } else {
        if before.devices != config.devices || before.blocked != config.blocked {
            inner.sync_saved();
        }
        if before.tailscale && !config.tailscale {
            lock(&inner.devices).retain(|_, d| d.source != "tailnet" || d.address.is_some());
            *lock(&inner.tailnet) = Tailnet::default();
            inner.emit("post-devices", inner.devices());
        }
        // Tell the others the new name; look where it's now told to.
        let look = (!before.tailscale && config.tailscale) || before.networks != config.networks;
        if before.alias != config.alias || look {
            discovery::refresh(inner.clone());
        }
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
        inner.sync_saved();
        discovery::refresh(inner);
    }
}

/// Adds a device by address (an IP address or a host name, and a port: LocalSend's if
/// none): introduces this one there and learns who it is. The pet window then keeps it in
/// the settings. Errors: "off", "address" (no such host), "unreachable", "notPet".
#[tauri::command]
pub async fn post_add_device(post: State<'_, Post>, address: String, port: Option<u16>) -> CmdResult<Device> {
    add_device(&post.0, &address, port.unwrap_or(DEFAULT_PORT)).await
}

pub(crate) async fn add_device(inner: &Arc<Inner>, address: &str, port: u16) -> CmdResult<Device> {
    if lock(&inner.running).is_none() {
        return Err("off".into());
    }
    let address = address.trim();
    let ip = discovery::resolve(address, port).await.ok_or("address")?;
    let mut d = client::probe(inner, ip, port, None).await.map_err(|e| e.to_string())?;
    d.source = "address";
    d.address = Some(address.to_string());
    inner.add_device(d.clone());
    Ok(d)
}

/// What both sides show to check they talk to each other (LocalSend's Verify).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Verify {
    pub text: String,
    /// Numbers of the icons (src/features/post/verifyIcons.ts).
    pub icons: Vec<usize>,
    /// That device asked for it lately (its name): then it isn't asked back.
    pub asked_by: Option<String>,
}

/// How long a device's asking to compare Verify counts as "lately".
pub(crate) const ASKED_MS: i64 = 5 * 60_000;

/// Verify for a device (by its fingerprint): what it should show too.
#[tauri::command]
pub fn post_verify(post: State<'_, Post>, fingerprint: String) -> CmdResult<Verify> {
    verify(&post.0, &fingerprint)
}

pub(crate) fn verify(inner: &Inner, fingerprint: &str) -> CmdResult<Verify> {
    let mine = inner.identity().ok_or("off")?.fingerprint;
    let fingerprint = fingerprint.to_ascii_uppercase();
    let (text, icons) = desktoppet_core::post::verify_code(&mine, &fingerprint);
    let asked_by =
        lock(&inner.verify_asked).get(&fingerprint).filter(|a| now_ms() - a.at < ASKED_MS).map(|a| a.alias.clone());
    Ok(Verify { text, icons, asked_by })
}

/// Asks the device (an ePet; LocalSend can't) to show Verify too, and waits for its
/// user: "shown", "declined" (or no answer), "refused" (it doesn't take it from this
/// computer: blocked), "busy" (asked just now), "unsupported" (LocalSend, plain HTTP),
/// "unreachable".
#[tauri::command]
pub async fn post_verify_ask(post: State<'_, Post>, fingerprint: String) -> CmdResult<String> {
    Ok(client::ask_verify(&post.0, &fingerprint).await)
}

/// The user's answer to a device asking to compare Verify (`post-verify-asked`).
#[tauri::command]
pub fn post_verify_answer(post: State<'_, Post>, fingerprint: String, show: bool) {
    verify_answer(&post.0, &fingerprint, show);
}

pub(crate) fn verify_answer(inner: &Inner, fingerprint: &str, show: bool) {
    let mut asked = lock(&inner.verify_asked);
    if let Some(tx) = asked.get_mut(&fingerprint.to_ascii_uppercase()).and_then(|a| a.answer.take()) {
        let _ = tx.send(show);
    }
}

/// The user compared Verify with a device: they match, or not. Told to that device when
/// it asks ("verify-result"); it only warns there.
#[tauri::command]
pub fn post_verify_decided(post: State<'_, Post>, fingerprint: String, matched: bool) {
    post.0.decided(&fingerprint).send_replace(Some(matched));
}

/// After the device showed Verify: what its user decides ("match" | "mismatch"), when
/// they do (None: not within a few minutes, or not an ePet).
#[tauri::command]
pub async fn post_verify_result(post: State<'_, Post>, fingerprint: String) -> CmdResult<Option<String>> {
    Ok(client::verify_result(&post.0, &fingerprint).await)
}

/// What Tailscale said last (Settings → Pet Post shows it).
#[tauri::command]
pub fn post_tailnet(post: State<'_, Post>) -> Tailnet {
    lock(&post.0.tailnet).clone()
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
    if device.changed_to.is_some() {
        return Err("identity".into());
    }
    if !device.online || device.ip.is_unspecified() {
        return Err("offline".into());
    }
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
                drop(receive);
                // Asked in the pet's bubble and the Pet Post window: answered in one, gone from both.
                inner
                    .emit("post-offer-closed", serde_json::json!({ "id": id, "reason": "answered", "accept": accept }));
            }
        }
    }
}

/// The delivery being asked about, if any (for the Pet Post window opened meanwhile).
#[tauri::command]
pub fn post_pending_offer(post: State<'_, Post>) -> Option<Offer> {
    match &*lock(&post.0.receive) {
        Receive::Offered { offer, answer: Some(_), .. } => Some((**offer).clone()),
        _ => None,
    }
}

/// Stops receiving (the files in so far stay; the sender is told no on its next upload).
#[tauri::command]
pub fn post_stop_receiving(post: State<'_, Post>) {
    stop_receiving(&post.0);
}

pub(crate) fn stop_receiving(inner: &Inner) {
    let mut receive = lock(&inner.receive);
    if let Receive::Active(a) = &*receive {
        let peer = a.session.from.alias.clone();
        let (done, total, files) = (a.done_bytes, a.session.total_bytes(), a.session.files.len());
        let fingerprint = a.fingerprint.clone();
        *receive = Receive::Idle;
        drop(receive);
        inner.transfer(Transfer {
            direction: "in",
            state: "stopped",
            peer,
            fingerprint,
            done,
            total,
            files,
            ..Default::default()
        });
    }
}

/// What was received, the latest first.
#[tauri::command]
pub fn post_history(post: State<'_, Post>) -> Vec<Received> {
    post.0.history()
}

#[tauri::command]
pub fn post_clear_history(post: State<'_, Post>) {
    post.0.set_history(Vec::new());
}

/// Opens something received (by its id in the history): the file itself, or (`reveal`, or
/// several files) the first one in its folder. Only what's in the history.
#[tauri::command]
pub fn post_open_received(app: AppHandle, post: State<'_, Post>, id: String, reveal: bool) -> CmdResult<()> {
    let entry = post.0.history().into_iter().find(|e| e.id == id).ok_or("gone")?;
    let first = entry.paths.first().map(PathBuf::from).filter(|p| p.exists()).ok_or("gone")?;
    if reveal || entry.files > 1 {
        app.opener().reveal_item_in_dir(&first).map_err(err)
    } else {
        app.opener().open_path(first.to_string_lossy(), None::<&str>).map_err(err)
    }
}

/// The clipboard's text (Paste in the Pet Post window): read here, not by the page, so the
/// Mac doesn't ask "Paste" first.
#[tauri::command]
pub fn post_clipboard_text(app: AppHandle) -> String {
    use tauri_plugin_clipboard_manager::ClipboardExt;
    app.clipboard().read_text().unwrap_or_default()
}

/// Whether the Pet Post window is open (and not minimized): then it asks about deliveries
/// itself, and the hidden pet needn't come out.
#[tauri::command]
pub fn post_window_shown(app: AppHandle) -> bool {
    crate::app_windows::post_shown(&app)
}

/// The Pet Post window, open behind others: its taskbar button flashes (Dock icon bounces).
#[tauri::command]
pub fn post_attention(app: AppHandle) {
    crate::app_windows::post_attention(&app);
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

/// Async: a WebView2 window made from a sync command (the main thread) deadlocks on Windows.
#[tauri::command]
pub async fn open_post_window(app: AppHandle, verify: Option<String>, tab: Option<String>) -> CmdResult<()> {
    crate::app_windows::open_post(&app, verify.as_deref(), tab.as_deref()).map_err(err)
}
