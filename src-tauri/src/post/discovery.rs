//! Finding devices: multicast announcements on LocalSend's group (224.0.0.167:53317),
//! answered with a `register` request (or, failing that, a multicast reply); and, for
//! networks that block multicast, a `register` to every address of this network.

use std::net::{IpAddr, Ipv4Addr, SocketAddr, SocketAddrV4};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use desktoppet_core::post::{Announcement, DEFAULT_PORT, MULTICAST_GROUP};
use socket2::{Domain, Protocol, SockRef, Socket, Type};
use tokio::net::UdpSocket;
use tokio::sync::{watch, Semaphore};

use super::{client, lock, Device, Inner};

fn group() -> Ipv4Addr {
    Ipv4Addr::from(MULTICAST_GROUP)
}

/// This computer's IPv4 addresses (not loopback) and their netmasks.
fn interfaces() -> Vec<(Ipv4Addr, Ipv4Addr)> {
    let Ok(list) = if_addrs::get_if_addrs() else { return Vec::new() };
    list.into_iter()
        .filter(|i| !i.is_loopback())
        .filter_map(|i| match i.addr {
            if_addrs::IfAddr::V4(v4) => Some((v4.ip, v4.netmask)),
            _ => None,
        })
        .collect()
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
            if client::register(&inner, ip, device.port, device.https, expected).await.is_none() {
                send(&inner, false).await;
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

static SCANNING: AtomicBool = AtomicBool::new(false);

/// Announces this device (three times: one message is easily lost), then asks every
/// address of this network (a /24 at most) in case multicast doesn't get through.
pub fn refresh(inner: Arc<Inner>) {
    tauri::async_runtime::spawn(async move {
        for wait in [100, 400, 1500] {
            tokio::time::sleep(Duration::from_millis(wait)).await;
            send(&inner, true).await;
        }
        // Only on LocalSend's port: another one is a test, which mustn't knock on every
        // address of the network.
        if inner.config().port != 0 || SCANNING.swap(true, Ordering::SeqCst) {
            return;
        }
        scan(&inner).await;
        SCANNING.store(false, Ordering::SeqCst);
    });
}

async fn scan(inner: &Arc<Inner>) {
    let limit = Arc::new(Semaphore::new(48));
    let mut tasks = Vec::new();
    for (own, mask) in interfaces() {
        // Link-local addresses (no DHCP) aren't a network worth scanning.
        if own.is_link_local() || u32::from(mask).count_ones() < 16 {
            continue;
        }
        let [a, b, c, _] = own.octets();
        for host in 1..=254u8 {
            let ip = Ipv4Addr::new(a, b, c, host);
            if ip == own {
                continue;
            }
            let (inner, limit) = (inner.clone(), limit.clone());
            tasks.push(tauri::async_runtime::spawn(async move {
                let Ok(_permit) = limit.acquire().await else { return };
                if lock(&inner.running).is_none() {
                    return;
                }
                if let Some(d) = client::register(&inner, IpAddr::V4(ip), DEFAULT_PORT, true, None).await {
                    inner.add_device(d);
                }
            }));
        }
    }
    for t in tasks {
        let _ = t.await;
    }
}
