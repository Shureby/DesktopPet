//! Finding devices: multicast announcements on LocalSend's group (224.0.0.167:53317),
//! answered with a `register` request (or, failing that, a multicast reply); and, for
//! networks that block multicast, a `register` to every address of this network. Beyond
//! it: the devices added by address, the extra networks of the settings, and the devices
//! of the Tailscale network (tailscale.rs).

use std::net::{IpAddr, Ipv4Addr, SocketAddr, SocketAddrV4};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use desktoppet_core::post::{network_hosts, network_kind, network_rank, Announcement, DEFAULT_PORT, MULTICAST_GROUP};
use socket2::{Domain, Protocol, SockRef, Socket, Type};
use tokio::net::UdpSocket;
use tokio::sync::{watch, Semaphore};

use super::{client, lock, tailscale, Device, Inner};

fn group() -> Ipv4Addr {
    Ipv4Addr::from(MULTICAST_GROUP)
}

/// This computer's IPv4 addresses (not loopback) and their netmasks.
pub(crate) fn interfaces() -> Vec<(Ipv4Addr, Ipv4Addr)> {
    let Ok(list) = if_addrs::get_if_addrs() else { return Vec::new() };
    list.into_iter()
        .filter(|i| !i.is_loopback())
        .filter_map(|i| match i.addr {
            if_addrs::IfAddr::V4(v4) => Some((v4.ip, v4.netmask)),
            _ => None,
        })
        .collect()
}

/// On another network than this computer's own (behind a router from here, or this
/// computer behind one from there): not this computer's networks (a /24 of its addresses),
/// loopback, link-local or Tailscale's (reached directly).
pub(crate) fn elsewhere(ip: IpAddr) -> bool {
    let IpAddr::V4(v4) = ip else { return false };
    if v4.is_loopback() || v4.is_unspecified() || v4.is_link_local() {
        return false;
    }
    let [a, b, c, _] = v4.octets();
    if a == 100 && (64..128).contains(&b) {
        return false;
    }
    !own_addresses().iter().any(|(own, _, _)| own.octets()[..3] == [a, b, c])
}

/// This computer's addresses others can reach it at (IPv4, not loopback or link-local):
/// each with its adapter's name and what kind of network it is (`network_kind`), the one
/// to give others first first.
pub fn own_addresses() -> Vec<(Ipv4Addr, String, &'static str)> {
    let Ok(list) = if_addrs::get_if_addrs() else { return Vec::new() };
    let mut out: Vec<(Ipv4Addr, String, &'static str)> = list
        .into_iter()
        .filter(|i| !i.is_loopback())
        .filter_map(|i| match i.addr {
            if_addrs::IfAddr::V4(v4) if !v4.ip.is_link_local() => Some((v4.ip, i.name)),
            _ => None,
        })
        .map(|(ip, name)| {
            let kind = network_kind(&name, ip);
            (ip, name, kind)
        })
        .collect();
    out.sort_by_key(|(ip, _, kind)| (network_rank(kind), *ip));
    out.dedup_by_key(|(ip, _, _)| *ip);
    out
}

/// Joins the multicast group on every network and listens for announcements.
pub async fn spawn(inner: Arc<Inner>, mut stop: watch::Receiver<bool>) -> Result<Arc<UdpSocket>, String> {
    let e = |e: std::io::Error| e.to_string();
    let socket = Socket::new(Domain::IPV4, Type::DGRAM, Some(Protocol::UDP)).map_err(e)?;
    // Shared with LocalSend running on the same computer.
    socket.set_reuse_address(true).map_err(e)?;
    #[cfg(unix)]
    socket.set_reuse_port(true).map_err(e)?;
    socket.bind(&SocketAddrV4::new(Ipv4Addr::UNSPECIFIED, DEFAULT_PORT).into()).map_err(e)?;
    // Also heard by LocalSend on this computer (our own come back too, and are skipped).
    socket.set_multicast_loop_v4(true).map_err(e)?;
    let mut joined = 0;
    for (ip, _) in interfaces() {
        if socket.join_multicast_v4(&group(), &ip).is_ok() {
            joined += 1;
        }
    }
    if joined == 0 {
        socket.join_multicast_v4(&group(), &Ipv4Addr::UNSPECIFIED).map_err(e)?;
    }
    socket.set_nonblocking(true).map_err(e)?;
    let udp = Arc::new(UdpSocket::from_std(socket.into()).map_err(e)?);
    let listening = udp.clone();
    tauri::async_runtime::spawn(async move {
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            tokio::select! {
                _ = stop.changed() => break,
                got = listening.recv_from(&mut buf) => {
                    // Windows reports an earlier send's ICMP error on the next receive.
                    let Ok((n, from)) = got else { continue };
                    heard(&inner, &buf[..n], from);
                }
            }
        }
    });
    Ok(udp)
}

fn heard(inner: &Arc<Inner>, data: &[u8], from: SocketAddr) {
    let Ok(a) = serde_json::from_slice::<Announcement>(data) else { return };
    let own = inner.identity().map(|i| i.fingerprint).unwrap_or_default();
    if a.info.fingerprint.is_empty() || a.info.fingerprint.eq_ignore_ascii_case(&own) {
        return;
    }
    let ip = from.ip();
    let device = Device::from_info(&a.info, ip);
    inner.add_device(device.clone());
    if a.announce {
        // Answer with our own introduction; multicast if that fails.
        let inner = inner.clone();
        tauri::async_runtime::spawn(async move {
            let expected = device.https.then(|| device.fingerprint.clone());
            match client::register(&inner, ip, device.port, device.https, expected).await {
                Some(d) => inner.add_device(d),
                None => send(&inner, false).await,
            }
        });
    }
}

/// Sends our announcement (or reply) to the group on every network.
async fn send(inner: &Inner, announce: bool) {
    let Some(udp) = lock(&inner.running).as_ref().and_then(|r| r.udp.clone()) else { return };
    let message = Announcement { info: inner.info(true), announce };
    let Ok(bytes) = serde_json::to_vec(&message) else { return };
    let to = SocketAddr::from((group(), DEFAULT_PORT));
    let ifaces = interfaces();
    if ifaces.is_empty() {
        let _ = udp.send_to(&bytes, to).await;
    }
    for (ip, _) in ifaces {
        if SockRef::from(udp.as_ref()).set_multicast_if_v4(&ip).is_ok() {
            let _ = udp.send_to(&bytes, to).await;
        }
    }
}

/// A scan of this network, or of the extra networks, under way (Look again meanwhile
/// doesn't start another).
static SCANNING: AtomicBool = AtomicBool::new(false);
static SCANNING_NETWORKS: AtomicBool = AtomicBool::new(false);

/// The port the extra networks and the tailnet are asked on: LocalSend's. (The end-to-end
/// tests' pretend device listens on another, `EPET_POST_PEER_PORT`.)
fn peer_port() -> u16 {
    if crate::commands::e2e_enabled() {
        if let Some(p) = std::env::var("EPET_POST_PEER_PORT").ok().and_then(|p| p.parse().ok()) {
            return p;
        }
    }
    DEFAULT_PORT
}

/// An address as typed (an IP address, `[v6]`, or a host name): where it is now (a name
/// may move). IPv4 preferred: ePet listens on IPv4.
pub async fn resolve(address: &str, port: u16) -> Option<IpAddr> {
    let address = address.trim().trim_start_matches('[').trim_end_matches(']');
    if address.is_empty() {
        return None;
    }
    if let Ok(ip) = address.parse::<IpAddr>() {
        return Some(ip);
    }
    let found =
        tokio::time::timeout(Duration::from_secs(5), tokio::net::lookup_host((address, port))).await.ok()?.ok()?;
    let list: Vec<SocketAddr> = found.collect();
    list.iter().find(|a| a.is_ipv4()).or(list.first()).map(|a| a.ip())
}

/// Announces this device (three times: one message is easily lost), then asks every
/// address of this network (a /24 at most) in case multicast doesn't get through.
/// Meanwhile, asks the devices added by address, the extra networks and the tailnet.
pub fn refresh(inner: Arc<Inner>) {
    refresh_with(inner, Vec::new());
}

/// As `refresh`, also asking these devices (dropped from the list as not heard from lately).
pub fn refresh_with(inner: Arc<Inner>, stale: Vec<Device>) {
    tauri::async_runtime::spawn(async move {
        let announce_then_scan = async {
            for wait in [100, 400, 1500] {
                tokio::time::sleep(Duration::from_millis(wait)).await;
                send(&inner, true).await;
            }
            if !SCANNING.swap(true, Ordering::SeqCst) {
                scan(&inner, this_network(&inner)).await;
                SCANNING.store(false, Ordering::SeqCst);
            }
        };
        let networks = async {
            if !SCANNING_NETWORKS.swap(true, Ordering::SeqCst) {
                scan(&inner, extra_networks(&inner)).await;
                SCANNING_NETWORKS.store(false, Ordering::SeqCst);
            }
        };
        tokio::join!(announce_then_scan, ask_saved(&inner), networks, ask_tailnet(&inner), ask_listed(&inner, stale));
    });
}

/// How often the devices listed are asked again (whether they share files by link now).
const WATCH_MS: u64 = 20_000;

/// Asks the devices listed again every little while: LocalSend's Share via link shows in
/// its answer (`download`), and a device behind another router can't tell us by multicast.
pub fn watch(inner: Arc<Inner>, mut stop: watch::Receiver<bool>) {
    let every = std::env::var("EPET_POST_WATCH_MS")
        .ok()
        .and_then(|v| v.parse().ok())
        .filter(|_| crate::commands::e2e_enabled())
        .unwrap_or(WATCH_MS);
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_millis(every)) => {}
                _ = stop.changed() => return,
            }
            if *stop.borrow() {
                return;
            }
            ask_listed(&inner, Vec::new()).await;
        }
    });
}

/// Asks each device listed who it is now: whether it shares files by
/// link, and, when its server came back as plain HTTP for that (LocalSend's Share via link
/// without encryption), lists it so.
pub(crate) async fn ask_listed(inner: &Arc<Inner>, stale: Vec<Device>) {
    let mut listed: Vec<Device> =
        lock(&inner.devices).values().filter(|d| d.online && !d.ip.is_unspecified()).cloned().collect();
    listed.extend(stale.into_iter().filter(|d| d.online && !d.ip.is_unspecified() && d.address.is_none()));
    let asks = listed.into_iter().map(|d| {
        let inner = inner.clone();
        async move {
            let expected = d.https.then(|| d.fingerprint.clone());
            let mut found = client::register(&inner, d.ip, d.port, d.https, expected).await;
            // Its server may have switched (LocalSend's Share via link with Encryption
            // unchecked serves plain HTTP; checked again, HTTPS).
            if found.is_none() {
                found = client::register(&inner, d.ip, d.port, !d.https, None).await;
            }
            match found {
                Some(mut f) if f.fingerprint == d.fingerprint => {
                    if lock(&inner.devices).contains_key(&d.fingerprint) {
                        let (sharing, epet, https, port) = (f.sharing, f.epet, f.https, f.port);
                        inner.update_device(&d.fingerprint, |x| {
                            x.sharing = sharing;
                            x.epet = epet;
                            // How it answers now (asked so, it would fail).
                            x.https = https;
                            x.port = port;
                            // Reached just now, where it's listed.
                            x.reached = true;
                            x.last_seen = crate::state::now_ms();
                        });
                    } else {
                        // Dropped as not heard from lately, but still there.
                        f.source = d.source;
                        f.came_in = d.came_in;
                        inner.add_device(f);
                    }
                }
                Some(mut other) => {
                    other.source = d.source;
                    other.address = d.address.clone();
                    if d.sharing {
                        inner.update_device(&d.fingerprint, |x| x.sharing = false);
                    }
                    inner.add_device(other);
                }
                None if d.sharing => inner.update_device(&d.fingerprint, |x| x.sharing = false),
                None => {}
            }
        }
    });
    futures_util::future::join_all(asks).await;
}

/// Asks each device added by address whether it's there, and still itself.
pub(crate) async fn ask_saved(inner: &Arc<Inner>) {
    let saved = inner.config().devices;
    let asks = saved.into_iter().map(|s| {
        let inner = inner.clone();
        async move {
            let fp = s.fingerprint.to_ascii_uppercase();
            let port = if s.port == 0 { DEFAULT_PORT } else { s.port };
            let ip = resolve(&s.address, port).await;
            let found = match ip {
                Some(ip) => client::probe(&inner, ip, port, None).await.ok(),
                None => None,
            };
            // Found just now elsewhere (a favorite whose address on this network changed,
            // DHCP): that's where it is; what's at its old address doesn't matter.
            let elsewhere = lock(&inner.devices).get(&fp).is_some_and(|d| {
                d.online && d.reached && crate::state::now_ms() - d.last_seen < 60_000 && Some(d.ip) != ip
            });
            if elsewhere && found.as_ref().is_none_or(|d| d.fingerprint != fp) {
                return;
            }
            match found {
                Some(mut d) if d.fingerprint == fp => {
                    // (A favorite keeps how it was found: "lan" yields to that.)
                    d.source = if s.favorite() { "lan" } else { "address" };
                    d.address = Some(s.address.clone());
                    inner.add_device(d);
                }
                Some(other) => inner.update_device(&fp, |d| {
                    d.changed_to = Some(other.fingerprint.clone());
                    d.online = true;
                    d.ip = other.ip;
                }),
                None => inner.update_device(&fp, |d| {
                    if d.address.is_some() {
                        d.online = false;
                    }
                }),
            }
        }
    });
    futures_util::future::join_all(asks).await;
}

type Target = (IpAddr, u16, &'static str);

/// Not this computer's own addresses.
fn others(list: impl IntoIterator<Item = Ipv4Addr>, port: u16, source: &'static str) -> Vec<Target> {
    let own: Vec<Ipv4Addr> = interfaces().into_iter().map(|(ip, _)| ip).collect();
    let mut out: Vec<Target> = Vec::new();
    for ip in list {
        if !own.contains(&ip) && !out.iter().any(|(i, _, _)| *i == IpAddr::V4(ip)) {
            out.push((IpAddr::V4(ip), port, source));
        }
    }
    out
}

/// Every address of this network (LocalSend's port only: another one is a test, which
/// mustn't knock on every address of the network).
fn this_network(inner: &Inner) -> Vec<Target> {
    if inner.config().port != 0 {
        return Vec::new();
    }
    let mut hosts = Vec::new();
    for (own, mask) in interfaces() {
        // Link-local addresses (no DHCP) aren't a network worth scanning.
        if own.is_link_local() || u32::from(mask).count_ones() < 16 {
            continue;
        }
        let [a, b, c, _] = own.octets();
        hosts.extend((1..=254u8).map(|host| Ipv4Addr::new(a, b, c, host)));
    }
    others(hosts, DEFAULT_PORT, "lan")
}

/// Every address of the extra networks of the settings.
fn extra_networks(inner: &Inner) -> Vec<Target> {
    let hosts = inner.config().networks.iter().flat_map(|n| network_hosts(n).unwrap_or_default()).collect::<Vec<_>>();
    others(hosts, peer_port(), "network")
}

/// Asks Tailscale (if installed, and on in the settings) for the tailnet's devices online,
/// then asks them whether they run LocalSend or ePet.
async fn ask_tailnet(inner: &Arc<Inner>) {
    if !inner.config().tailscale {
        return;
    }
    let tailnet = tailscale::status().await;
    *lock(&inner.tailnet) = tailnet.clone();
    inner.emit("post-tailnet", &tailnet);
    scan(inner, others(tailnet.peers.iter().map(|(ip, _)| *ip), peer_port(), "tailnet")).await;
}

async fn scan(inner: &Arc<Inner>, targets: Vec<Target>) {
    let limit = Arc::new(Semaphore::new(48));
    let mut tasks = Vec::new();
    for (ip, port, source) in targets {
        let (inner, limit) = (inner.clone(), limit.clone());
        tasks.push(tauri::async_runtime::spawn(async move {
            let Ok(_permit) = limit.acquire().await else { return };
            if lock(&inner.running).is_none() {
                return;
            }
            if let Some(mut d) = client::register(&inner, ip, port, true, None).await {
                d.source = source;
                inner.add_device(d);
            }
        }));
    }
    for t in tasks {
        let _ = t.await;
    }
}
