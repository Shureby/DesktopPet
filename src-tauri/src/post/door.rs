//! The router door: asks the router in front of this computer to pass Pet Post's port on
//! to it, so devices on the network outside that router (this computer behind a second
//! router) can reach it. UPnP (IGD), then NAT-PMP, then PCP. Only on its own when the
//! router's outside address is private (still a home network); when it's the internet,
//! only once the user said so (`door_public`). Renewed while Pet Post runs; closed when it
//! stops (or the setting is turned off).

use std::net::{IpAddr, Ipv4Addr, SocketAddrV4};
use std::sync::Arc;
use std::time::Duration;

use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper_util::rt::TokioIo;
use serde::Serialize;
use tokio::net::{TcpStream, UdpSocket};
use tokio::sync::watch;

use super::{lock, Inner};

/// NAT-PMP's and PCP's port on the router.
const NATPMP_PORT: u16 = 5351;
/// Where SSDP searches go.
const SSDP: SocketAddrV4 = SocketAddrV4::new(Ipv4Addr::new(239, 255, 255, 250), 1900);
/// How long a door is asked for (renewed well before).
const LEASE: u32 = 3600;
const RENEW: Duration = Duration::from_secs(30 * 60);
/// Asked again this often while no router answers (or it said no): it may be switched on.
const RETRY: Duration = Duration::from_secs(10 * 60);
const NAME: &str = "ePet Pet Post";

/// The door, as Settings shows it ("post-door").
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Door {
    /// "off" (the setting is off, or Pet Post) | "trying" | "open" | "none" (no router
    /// answered) | "public" (its outside is the internet: not opened without the user's
    /// say) | "refused" (the router said no: `error`).
    pub state: &'static str,
    /// "upnp" | "natpmp" | "pcp".
    pub via: Option<&'static str>,
    /// The router asked (this computer's gateway).
    pub router: Option<String>,
    /// Where others reach this computer through it (with `external_port`).
    pub external_ip: Option<String>,
    pub external_port: u16,
    pub error: Option<String>,
}

impl Default for Door {
    fn default() -> Self {
        Door { state: "off", via: None, router: None, external_ip: None, external_port: 0, error: None }
    }
}

/// Where to ask: the router in front of this computer.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct Router {
    pub gateway: Ipv4Addr,
    /// This computer's address on the router's network.
    pub local: Ipv4Addr,
    /// NAT-PMP and PCP's port (tests: where the pretend router listens, SSDP too).
    pub port: u16,
    /// Where SSDP searches go (multicast; tests: the pretend router).
    pub ssdp: SocketAddrV4,
}

/// A door opened (to renew and close).
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Mapping {
    pub via: Via,
    pub router: Router,
    pub internal_port: u16,
    pub external_port: u16,
    pub external_ip: Ipv4Addr,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Via {
    Upnp { control: String, service: String },
    NatPmp,
    Pcp { nonce: [u8; 12] },
}

impl Via {
    fn name(&self) -> &'static str {
        match self {
            Via::Upnp { .. } => "upnp",
            Via::NatPmp => "natpmp",
            Via::Pcp { .. } => "pcp",
        }
    }
}

/// Why no door was opened.
#[derive(Debug, PartialEq)]
pub(crate) enum NotOpened {
    /// No router answered (none of the three ways).
    Nobody,
    /// Its outside address is a public one (the internet), and that wasn't allowed.
    Public { ip: Ipv4Addr, via: &'static str },
    /// The router answered, and said no.
    Refused { error: String, via: &'static str },
}

/// A private (home or office) address: 10/8, 172.16/12, 192.168/16. Carrier-grade NAT
/// (100.64/10) isn't: other customers of the carrier are out there.
pub(crate) fn private(ip: Ipv4Addr) -> bool {
    ip.is_private()
}

// --- The router in front ---------------------------------------------------------------

/// The default gateway in `route print -4 0.0.0.0` (Windows): the lowest metric.
pub(crate) fn gateway_windows(out: &str) -> Option<Ipv4Addr> {
    out.lines()
        .filter_map(|l| {
            let t: Vec<&str> = l.split_whitespace().collect();
            if t.len() == 5 && t[0] == "0.0.0.0" && t[1] == "0.0.0.0" {
                Some((t[2].parse::<Ipv4Addr>().ok()?, t[4].parse::<u32>().ok()?))
            } else {
                None
            }
        })
        .min_by_key(|(_, metric)| *metric)
        .map(|(gw, _)| gw)
}

/// The default gateway in `route -n get default` (macOS).
pub(crate) fn gateway_macos(out: &str) -> Option<Ipv4Addr> {
    out.lines().find_map(|l| l.trim().strip_prefix("gateway:").and_then(|g| g.trim().parse().ok()))
}

/// The default gateway in /proc/net/route (Linux).
pub(crate) fn gateway_linux(table: &str) -> Option<Ipv4Addr> {
    table.lines().skip(1).find_map(|l| {
        let t: Vec<&str> = l.split_whitespace().collect();
        if t.len() > 2 && t[1] == "00000000" && t[2] != "00000000" {
            u32::from_str_radix(t[2], 16).ok().map(|g| Ipv4Addr::from(g.to_le_bytes()))
        } else {
            None
        }
    })
}

async fn output(program: &str, args: &[&str]) -> Option<String> {
    let mut cmd = tokio::process::Command::new(program);
    cmd.args(args).kill_on_drop(true).stdin(std::process::Stdio::null());
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let out = tokio::time::timeout(Duration::from_secs(5), cmd.output()).await.ok()?.ok()?;
    Some(String::from_utf8_lossy(&out.stdout).into_owned())
}

async fn default_gateway() -> Option<Ipv4Addr> {
    match std::env::consts::OS {
        "windows" => gateway_windows(&output("route", &["print", "-4", "0.0.0.0"]).await?),
        "macos" => gateway_macos(&output("route", &["-n", "get", "default"]).await?),
        _ => gateway_linux(&tokio::fs::read_to_string("/proc/net/route").await.ok()?),
    }
}

/// The router in front of this computer, and this computer's address on its network.
/// (Tests: `EPET_POST_ROUTER=127.0.0.1:port`, a pretend router.)
pub(crate) async fn router() -> Option<Router> {
    if crate::commands::e2e_enabled() {
        if let Some(addr) = std::env::var("EPET_POST_ROUTER").ok().and_then(|v| v.parse::<SocketAddrV4>().ok()) {
            return Some(Router { gateway: *addr.ip(), local: *addr.ip(), port: addr.port(), ssdp: addr });
        }
    }
    let gateway = default_gateway().await?;
    let local = super::discovery::interfaces().into_iter().find_map(|(ip, mask)| {
        let m = u32::from(mask);
        (m != 0 && u32::from(ip) & m == u32::from(gateway) & m).then_some(ip)
    })?;
    Some(Router { gateway, local, port: NATPMP_PORT, ssdp: SSDP })
}

// --- Opening, renewing, closing --------------------------------------------------------

/// Opens a door to `internal_port` (`wanted`: the outside port asked for; another if it's
/// taken), or renews it (`renew`: the door open now, asked again the same way).
pub(crate) async fn open(
    router: Router,
    internal_port: u16,
    wanted: u16,
    allow_public: bool,
    renew: Option<&Mapping>,
) -> Result<Mapping, NotOpened> {
    if let Some(m) = renew {
        let again = match &m.via {
            Via::Upnp { control, service } => upnp_map(&router, control, service, internal_port, wanted, allow_public).await,
            Via::NatPmp => natpmp_map(&router, internal_port, wanted, allow_public).await,
            Via::Pcp { nonce } => pcp_map(&router, internal_port, wanted, allow_public, *nonce).await,
        };
        // Answered (yes or no): that's the answer. Silent: asked every way below.
        if !matches!(again, Err(NotOpened::Nobody)) {
            return again;
        }
    }
    if let Some((control, service)) = upnp_find(&router).await {
        let r = upnp_map(&router, &control, &service, internal_port, wanted, allow_public).await;
        if !matches!(r, Err(NotOpened::Nobody)) {
            return r;
        }
    }
    let r = natpmp_map(&router, internal_port, wanted, allow_public).await;
    if !matches!(r, Err(NotOpened::Nobody)) {
        return r;
    }
    pcp_map(&router, internal_port, wanted, allow_public, rand_nonce()).await
}

/// Closes a door (best effort: it would end with its lease anyway).
pub(crate) async fn close(m: &Mapping) {
    match &m.via {
        Via::Upnp { control, service } => {
            let args = [
                ("NewRemoteHost", String::new()),
                ("NewExternalPort", m.external_port.to_string()),
                ("NewProtocol", "TCP".into()),
            ];
            let _ = soap(control, service, "DeletePortMapping", &args).await;
        }
        Via::NatPmp => {
            let _ = natpmp_ask(&m.router, &natpmp_request(m.internal_port, 0, 0), 2).await;
        }
        Via::Pcp { nonce } => {
            let _ = natpmp_ask(&m.router, &pcp_request(&m.router, m.internal_port, 0, 0, *nonce), 2).await;
        }
    }
}

fn rand_nonce() -> [u8; 12] {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(desktoppet_core::post::random_id().as_bytes());
    let mut n = [0u8; 12];
    n.copy_from_slice(&digest[..12]);
    n
}

// --- UPnP (Internet Gateway Device) ----------------------------------------------------

/// Looks for the router's UPnP service: its control URL and service type.
async fn upnp_find(router: &Router) -> Option<(String, String)> {
    let socket = UdpSocket::bind((router.local, 0)).await.ok()?;
    let _ = socket.set_multicast_ttl_v4(2);
    for st in ["urn:schemas-upnp-org:device:InternetGatewayDevice:1", "urn:schemas-upnp-org:device:InternetGatewayDevice:2"] {
        let msg = format!(
            "M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nST: {st}\r\nMAN: \"ssdp:discover\"\r\nMX: 2\r\n\r\n"
        );
        let _ = socket.send_to(msg.as_bytes(), router.ssdp).await;
    }
    let deadline = tokio::time::Instant::now() + Duration::from_millis(2500);
    let mut buf = [0u8; 2048];
    let mut tried = Vec::new();
    loop {
        let (n, from) = tokio::time::timeout_at(deadline, socket.recv_from(&mut buf)).await.ok()?.ok()?;
        // Only the router in front.
        if from.ip() != IpAddr::V4(router.gateway) {
            continue;
        }
        let text = String::from_utf8_lossy(&buf[..n]);
        let Some(location) = header(&text, "location") else { continue };
        if tried.contains(&location) {
            continue;
        }
        tried.push(location.clone());
        let Ok((200, body)) = http(&location, "GET", None, "").await else { continue };
        if let Some(found) = wan_service(&body, &location) {
            return Some(found);
        }
    }
}

/// A header of an SSDP answer (any case).
pub(crate) fn header(text: &str, name: &str) -> Option<String> {
    text.lines().find_map(|l| {
        let (k, v) = l.split_once(':')?;
        k.trim().eq_ignore_ascii_case(name).then(|| v.trim().to_string())
    })
}

/// The WAN connection service in a device description: its control URL (made whole
/// against where the description came from) and service type.
pub(crate) fn wan_service(xml: &str, location: &str) -> Option<(String, String)> {
    let base = tag(xml, "URLBase").filter(|b| b.starts_with("http://")).unwrap_or_else(|| location.to_string());
    for block in xml.split("<service>").skip(1) {
        let block = block.split("</service>").next().unwrap_or(block);
        let Some(service) = tag(block, "serviceType") else { continue };
        if !(service.contains(":WANIPConnection:") || service.contains(":WANPPPConnection:")) {
            continue;
        }
        let Some(control) = tag(block, "controlURL") else { continue };
        return Some((join_url(&base, &control)?, service));
    }
    None
}

/// `path` made whole against `base` ("http://host:port/…").
pub(crate) fn join_url(base: &str, path: &str) -> Option<String> {
    if path.starts_with("http://") {
        return Some(path.to_string());
    }
    let rest = base.strip_prefix("http://")?;
    let host = rest.split('/').next()?;
    Some(format!("http://{host}{}{path}", if path.starts_with('/') { "" } else { "/" }))
}

/// The text of the first `<name>` (with or without a namespace prefix).
pub(crate) fn tag(xml: &str, name: &str) -> Option<String> {
    let mut from = 0;
    while let Some(i) = xml[from..].find(&format!("{name}>")) {
        let at = from + i;
        from = at + name.len() + 1;
        // Its opening: "<name>" or "<p:name>" (not "</name>").
        let before = &xml[..at];
        let Some(lt) = before.rfind('<') else { continue };
        let prefix = &before[lt + 1..];
        if prefix.starts_with('/') || !(prefix.is_empty() || (prefix.ends_with(':') && !prefix.contains(' '))) {
            continue;
        }
        let rest = &xml[from..];
        let end = rest.find("</")?;
        return Some(rest[..end].trim().to_string());
    }
    None
}

fn escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

/// A SOAP call: its answer, or the UPnP error (code, description).
async fn soap(control: &str, service: &str, action: &str, args: &[(&str, String)]) -> Result<String, (u32, String)> {
    let inner: String = args.iter().map(|(k, v)| format!("<{k}>{}</{k}>", escape(v))).collect();
    let body = format!(
        "<?xml version=\"1.0\"?>\r\n<s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\" s:encodingStyle=\"http://schemas.xmlsoap.org/soap/encoding/\"><s:Body><u:{action} xmlns:u=\"{service}\">{inner}</u:{action}></s:Body></s:Envelope>\r\n"
    );
    let soap_action = format!("\"{service}#{action}\"");
    match http(control, "POST", Some(&soap_action), &body).await {
        Ok((200, answer)) => Ok(answer),
        Ok((status, answer)) => {
            let code = tag(&answer, "errorCode").and_then(|c| c.parse().ok()).unwrap_or(0);
            let text = tag(&answer, "errorDescription").unwrap_or_else(|| format!("HTTP {status}"));
            Err((code, text))
        }
        Err(e) => Err((0, e)),
    }
}

/// One plain HTTP request (the router's UPnP server): status and body.
async fn http(url: &str, method: &str, soap_action: Option<&str>, body: &str) -> Result<(u16, String), String> {
    let rest = url.strip_prefix("http://").ok_or("not http")?;
    let (host, path) = match rest.find('/') {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, "/"),
    };
    let addr = if host.contains(':') { host.to_string() } else { format!("{host}:80") };
    let call = async {
        let stream = TcpStream::connect(&addr).await.map_err(|e| e.to_string())?;
        let (mut sender, conn) =
            hyper::client::conn::http1::handshake(TokioIo::new(stream)).await.map_err(|e| e.to_string())?;
        tokio::spawn(async move {
            let _ = conn.await;
        });
        let mut req = hyper::Request::builder()
            .method(method)
            .uri(path)
            .header("host", host)
            .header("connection", "close")
            .header("content-length", body.len());
        if let Some(a) = soap_action {
            req = req.header("content-type", "text/xml; charset=\"utf-8\"").header("soapaction", a);
        }
        let req = req.body(Full::new(Bytes::from(body.to_string()))).map_err(|e| e.to_string())?;
        let res = sender.send_request(req).await.map_err(|e| e.to_string())?;
        let status = res.status().as_u16();
        let limited = http_body_util::Limited::new(res.into_body(), 256 * 1024);
        let bytes = limited.collect().await.map_err(|e| e.to_string())?.to_bytes();
        Ok::<_, String>((status, String::from_utf8_lossy(&bytes).into_owned()))
    };
    tokio::time::timeout(Duration::from_secs(5), call).await.map_err(|_| "timeout".to_string())?
}

async fn upnp_map(
    router: &Router,
    control: &str,
    service: &str,
    internal_port: u16,
    wanted: u16,
    allow_public: bool,
) -> Result<Mapping, NotOpened> {
    let refused = |error: String| NotOpened::Refused { error, via: "upnp" };
    let answer = match soap(control, service, "GetExternalIPAddress", &[]).await {
        Ok(a) => a,
        Err((0, _)) => return Err(NotOpened::Nobody),
        Err((_, e)) => return Err(refused(e)),
    };
    let ip = tag(&answer, "NewExternalIPAddress")
        .and_then(|a| a.parse::<Ipv4Addr>().ok())
        .filter(|ip| !ip.is_unspecified())
        .ok_or_else(|| refused("no outside address".into()))?;
    if !private(ip) && !allow_public {
        return Err(NotOpened::Public { ip, via: "upnp" });
    }
    let mut last = String::new();
    for port in (0..10u16).map(|i| wanted.wrapping_add(i)).filter(|p| *p != 0) {
        let add = |lease: u32| {
            let args = [
                ("NewRemoteHost", String::new()),
                ("NewExternalPort", port.to_string()),
                ("NewProtocol", "TCP".into()),
                ("NewInternalPort", internal_port.to_string()),
                ("NewInternalClient", router.local.to_string()),
                ("NewEnabled", "1".into()),
                ("NewPortMappingDescription", NAME.into()),
                ("NewLeaseDuration", lease.to_string()),
            ];
            async move { soap(control, service, "AddPortMapping", &args).await }
        };
        let mut r = add(LEASE).await;
        // OnlyPermanentLeasesSupported.
        if matches!(r, Err((725, _))) {
            r = add(0).await;
        }
        let ours = || Mapping {
            via: Via::Upnp { control: control.to_string(), service: service.to_string() },
            router: *router,
            internal_port,
            external_port: port,
            external_ip: ip,
        };
        match r {
            Ok(_) => return Ok(ours()),
            // ConflictInMappingEntry: ours already (a renewal, or left from before), or
            // another computer's: then the next port.
            Err((718, e)) => {
                let args = [
                    ("NewRemoteHost", String::new()),
                    ("NewExternalPort", port.to_string()),
                    ("NewProtocol", "TCP".into()),
                ];
                if let Ok(entry) = soap(control, service, "GetSpecificPortMappingEntry", &args).await {
                    let client = tag(&entry, "NewInternalClient").unwrap_or_default();
                    let to = tag(&entry, "NewInternalPort").and_then(|p| p.parse::<u16>().ok());
                    if client == router.local.to_string() && to == Some(internal_port) {
                        return Ok(ours());
                    }
                }
                last = e;
            }
            Err((0, _)) => return Err(NotOpened::Nobody),
            Err((code, e)) => return Err(refused(format!("{e} ({code})"))),
        }
    }
    Err(refused(if last.is_empty() { "ports taken".into() } else { last }))
}

// --- NAT-PMP (RFC 6886) and PCP (RFC 6887), on the router's port 5351 -------------------

/// Sends a request and waits for its answer (250 ms, then twice as long each time).
async fn natpmp_ask(router: &Router, request: &[u8], tries: u32) -> Option<Vec<u8>> {
    let socket = UdpSocket::bind((router.local, 0)).await.ok()?;
    let to = SocketAddrV4::new(router.gateway, router.port);
    let mut wait = Duration::from_millis(250);
    let mut buf = [0u8; 1100];
    for _ in 0..tries {
        socket.send_to(request, to).await.ok()?;
        let deadline = tokio::time::Instant::now() + wait;
        loop {
            match tokio::time::timeout_at(deadline, socket.recv_from(&mut buf)).await {
                Ok(Ok((n, from))) if from.ip() == IpAddr::V4(router.gateway) && n >= 4 => return Some(buf[..n].to_vec()),
                Ok(Ok(_)) => continue,
                _ => break,
            }
        }
        wait *= 2;
    }
    None
}

/// A NAT-PMP request for a TCP door (`lifetime` 0: close it).
fn natpmp_request(internal: u16, external: u16, lifetime: u32) -> Vec<u8> {
    let mut r = vec![0, 2, 0, 0];
    r.extend_from_slice(&internal.to_be_bytes());
    r.extend_from_slice(&external.to_be_bytes());
    r.extend_from_slice(&lifetime.to_be_bytes());
    r
}

async fn natpmp_map(router: &Router, internal_port: u16, wanted: u16, allow_public: bool) -> Result<Mapping, NotOpened> {
    let refused = |error: String| NotOpened::Refused { error, via: "natpmp" };
    // Its outside address first.
    let a = natpmp_ask(router, &[0, 0], 3).await.ok_or(NotOpened::Nobody)?;
    if a[0] != 0 || a.len() < 12 || a[1] != 128 {
        return Err(NotOpened::Nobody);
    }
    let code = u16::from_be_bytes([a[2], a[3]]);
    if code != 0 {
        return Err(refused(natpmp_error(code)));
    }
    let ip = Ipv4Addr::new(a[8], a[9], a[10], a[11]);
    if !private(ip) && !allow_public {
        return Err(NotOpened::Public { ip, via: "natpmp" });
    }
    let a = natpmp_ask(router, &natpmp_request(internal_port, wanted, LEASE), 3).await.ok_or(NotOpened::Nobody)?;
    if a.len() < 16 || a[1] != 130 {
        return Err(refused("unexpected answer".into()));
    }
    let code = u16::from_be_bytes([a[2], a[3]]);
    if code != 0 {
        return Err(refused(natpmp_error(code)));
    }
    let external_port = u16::from_be_bytes([a[10], a[11]]);
    Ok(Mapping { via: Via::NatPmp, router: *router, internal_port, external_port, external_ip: ip })
}

fn natpmp_error(code: u16) -> String {
    match code {
        1 => "unsupported version".into(),
        2 => "not authorized (switched off on the router)".into(),
        3 => "network failure".into(),
        4 => "out of resources".into(),
        _ => format!("error {code}"),
    }
}

fn mapped(ip: Ipv4Addr) -> [u8; 16] {
    let mut a = [0u8; 16];
    a[10] = 0xff;
    a[11] = 0xff;
    a[12..].copy_from_slice(&ip.octets());
    a
}

/// A PCP MAP request for a TCP door (`lifetime` 0: close it).
fn pcp_request(router: &Router, internal: u16, external: u16, lifetime: u32, nonce: [u8; 12]) -> Vec<u8> {
    let mut r = vec![2, 1, 0, 0];
    r.extend_from_slice(&lifetime.to_be_bytes());
    r.extend_from_slice(&mapped(router.local));
    r.extend_from_slice(&nonce);
    r.extend_from_slice(&[6, 0, 0, 0]);
    r.extend_from_slice(&internal.to_be_bytes());
    r.extend_from_slice(&external.to_be_bytes());
    r.extend_from_slice(&mapped(Ipv4Addr::UNSPECIFIED));
    r
}

async fn pcp_map(
    router: &Router,
    internal_port: u16,
    wanted: u16,
    allow_public: bool,
    nonce: [u8; 12],
) -> Result<Mapping, NotOpened> {
    let refused = |error: String| NotOpened::Refused { error, via: "pcp" };
    let a = natpmp_ask(router, &pcp_request(router, internal_port, wanted, LEASE, nonce), 3)
        .await
        .ok_or(NotOpened::Nobody)?;
    // A NAT-PMP router saying it doesn't know this version: no PCP there.
    if a[0] != 2 || a.len() < 60 || a[1] != 0x81 {
        return Err(NotOpened::Nobody);
    }
    if a[3] != 0 {
        return Err(refused(format!("error {}", a[3])));
    }
    let external_port = u16::from_be_bytes([a[42], a[43]]);
    let ip = Ipv4Addr::new(a[56], a[57], a[58], a[59]);
    let m = Mapping { via: Via::Pcp { nonce }, router: *router, internal_port, external_port, external_ip: ip };
    if !private(ip) && !allow_public {
        close(&m).await;
        return Err(NotOpened::Public { ip, via: "pcp" });
    }
    Ok(m)
}

// --- Kept while Pet Post runs -----------------------------------------------------------

impl Inner {
    pub(crate) fn door(&self) -> Door {
        lock(&self.door).clone()
    }

    fn set_door(&self, d: Door) {
        let changed = *lock(&self.door) != d;
        *lock(&self.door) = d.clone();
        if changed {
            self.emit("post-door", d);
        }
    }

    /// The port to tell a device at `ip`: through the door when it's on the network
    /// outside the router (not this computer's own), where this computer is reached at the
    /// router's address; else the one Pet Post listens on.
    pub(crate) fn port_for(&self, ip: IpAddr) -> u16 {
        let d = self.door();
        if d.state == "open" && d.external_port != 0 && super::discovery::elsewhere(ip) {
            d.external_port
        } else {
            self.port()
        }
    }
}

/// Opens the door (when the setting says so) and keeps it open while Pet Post runs; asked
/// again when the settings change (`door_wake`), closed when it stops.
pub fn keep(inner: Arc<Inner>, mut stop: watch::Receiver<bool>) {
    tauri::async_runtime::spawn(async move {
        let mut mapping: Option<Mapping> = None;
        loop {
            let config = inner.config();
            let wait = if !config.door {
                if let Some(m) = mapping.take() {
                    close(&m).await;
                }
                inner.set_door(Door::default());
                None
            } else {
                if mapping.is_none() {
                    inner.set_door(Door { state: "trying", ..Door::default() });
                }
                let port = inner.port();
                match router().await {
                    None => {
                        inner.set_door(Door { state: "none", ..Door::default() });
                        Some(RETRY)
                    }
                    Some(r) => {
                        let router_ip = Some(r.gateway.to_string());
                        let renew = mapping.as_ref().filter(|m| m.router == r);
                        let wanted = renew.map_or(port, |m| m.external_port);
                        match open(r, port, wanted, config.door_public, renew).await {
                            Ok(m) => {
                                let first = mapping.as_ref().map(|o| o.external_port) != Some(m.external_port);
                                inner.set_door(Door {
                                    state: "open",
                                    via: Some(m.via.name()),
                                    router: router_ip,
                                    external_ip: Some(m.external_ip.to_string()),
                                    external_port: m.external_port,
                                    error: None,
                                });
                                mapping = Some(m);
                                // Tell the devices out there where this computer is now.
                                if first {
                                    super::discovery::refresh(inner.clone());
                                }
                                Some(RENEW)
                            }
                            Err(why) => {
                                if let Some(m) = mapping.take() {
                                    close(&m).await;
                                }
                                inner.set_door(match why {
                                    NotOpened::Nobody => Door { state: "none", router: router_ip, ..Door::default() },
                                    NotOpened::Public { ip, via } => Door {
                                        state: "public",
                                        via: Some(via),
                                        router: router_ip,
                                        external_ip: Some(ip.to_string()),
                                        ..Door::default()
                                    },
                                    NotOpened::Refused { error, via } => Door {
                                        state: "refused",
                                        via: Some(via),
                                        router: router_ip,
                                        error: Some(error),
                                        ..Door::default()
                                    },
                                });
                                Some(RETRY)
                            }
                        }
                    }
                }
            };
            let sleep = tokio::time::sleep(wait.unwrap_or(Duration::from_secs(86_400)));
            tokio::select! {
                _ = stop.changed() => break,
                _ = inner.door_wake.notified() => {}
                _ = sleep => {}
            }
            if *stop.borrow() {
                break;
            }
        }
        if let Some(m) = mapping.take() {
            close(&m).await;
        }
        inner.set_door(Door::default());
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_default_gateway_as_each_system_tells_it() {
        let windows = "===========================================================================\r\n\
            IPv4 Route Table\r\n\
            Active Routes:\r\n\
            Network Destination        Netmask          Gateway       Interface  Metric\r\n\
                      0.0.0.0          0.0.0.0      192.168.8.1    192.168.8.192     35\r\n\
                      0.0.0.0          0.0.0.0         10.0.0.1       10.0.0.7     50\r\n\
            Persistent Routes:\r\n\
                      0.0.0.0          0.0.0.0     192.168.1.1  Default\r\n";
        assert_eq!(gateway_windows(windows), Some(Ipv4Addr::new(192, 168, 8, 1)));
        let mac = "   route to: default\ndestination: default\n       mask: default\n    gateway: 192.168.8.1\n  interface: en0\n";
        assert_eq!(gateway_macos(mac), Some(Ipv4Addr::new(192, 168, 8, 1)));
        let linux = "Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\n\
            eth0\t0008A8C0\t00000000\t0001\t0\t0\t0\t00FFFFFF\n\
            eth0\t00000000\t0108A8C0\t0003\t0\t0\t0\t00000000\n";
        assert_eq!(gateway_linux(linux), Some(Ipv4Addr::new(192, 168, 8, 1)));
        assert_eq!(gateway_windows("nothing"), None);
    }

    #[test]
    fn only_home_networks_are_private() {
        assert!(private(Ipv4Addr::new(192, 168, 31, 178)));
        assert!(private(Ipv4Addr::new(10, 1, 2, 3)));
        assert!(private(Ipv4Addr::new(172, 20, 0, 1)));
        assert!(!private(Ipv4Addr::new(100, 64, 0, 1)));
        assert!(!private(Ipv4Addr::new(203, 0, 113, 7)));
    }

    #[test]
    fn device_descriptions_and_answers() {
        let xml = r#"<?xml version="1.0"?><root><device><serviceList>
            <service><serviceType>urn:schemas-upnp-org:service:Layer3Forwarding:1</serviceType><controlURL>/l3f</controlURL></service>
            </serviceList><deviceList><device><serviceList>
            <service><serviceType>urn:schemas-upnp-org:service:WANIPConnection:1</serviceType>
            <controlURL>ctl/IPConn</controlURL></service></serviceList></device></deviceList></device></root>"#;
        assert_eq!(
            wan_service(xml, "http://192.168.8.1:5000/rootDesc.xml"),
            Some(("http://192.168.8.1:5000/ctl/IPConn".into(), "urn:schemas-upnp-org:service:WANIPConnection:1".into()))
        );
        let answer = "<s:Envelope><s:Body><u:GetExternalIPAddressResponse xmlns:u=\"x\"><NewExternalIPAddress>192.168.31.178</NewExternalIPAddress></u:GetExternalIPAddressResponse></s:Body></s:Envelope>";
        assert_eq!(tag(answer, "NewExternalIPAddress").as_deref(), Some("192.168.31.178"));
        let fault = "<s:Fault><detail><UPnPError xmlns=\"urn:schemas-upnp-org:control-1-0\"><errorCode>718</errorCode><errorDescription>ConflictInMappingEntry</errorDescription></UPnPError></detail></s:Fault>";
        assert_eq!(tag(fault, "errorCode").as_deref(), Some("718"));
        assert_eq!(header("HTTP/1.1 200 OK\r\nLOCATION: http://192.168.8.1:5000/d.xml\r\n", "location").as_deref(), Some("http://192.168.8.1:5000/d.xml"));
    }

    // --- A pretend router ---------------------------------------------------------------

    use std::sync::Mutex;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    #[derive(Default)]
    struct Fake {
        /// Answers UPnP (SSDP and SOAP).
        upnp: bool,
        /// Answers NAT-PMP; else PCP (when `pcp`), else nothing.
        natpmp: bool,
        pcp: bool,
        outside: Option<Ipv4Addr>,
        /// UPnP: outside ports held by another computer.
        taken: Vec<u16>,
        /// NAT-PMP / PCP: the outside port it gives.
        gives: u16,
        /// What it was asked: "add 53317 lease 3600", "delete 53317", "natpmp 53317 0"…
        log: Vec<String>,
        /// UPnP doors: outside port → (client, inside port).
        doors: Vec<(u16, String, u16)>,
    }

    async fn pretend(fake: Fake) -> (Router, Arc<Mutex<Fake>>) {
        let fake = Arc::new(Mutex::new(fake));
        let udp = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let tcp = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let (udp_port, tcp_port) = (udp.local_addr().unwrap().port(), tcp.local_addr().unwrap().port());
        let f = fake.clone();
        tokio::spawn(async move {
            let mut buf = [0u8; 2048];
            while let Ok((n, from)) = udp.recv_from(&mut buf).await {
                let m = buf[..n].to_vec();
                let reply: Option<Vec<u8>> = {
                    let mut f = f.lock().unwrap();
                    if m.starts_with(b"M-SEARCH") {
                        f.upnp.then(|| format!("HTTP/1.1 200 OK\r\nST: x\r\nLocation: http://127.0.0.1:{tcp_port}/desc.xml\r\n\r\n").into_bytes())
                    } else if m[0] == 0 && f.natpmp {
                        let ip = f.outside.unwrap().octets();
                        if m[1] == 0 {
                            Some([&[0u8, 128, 0, 0, 0, 0, 0, 1][..], &ip[..]].concat())
                        } else {
                            let internal = u16::from_be_bytes([m[4], m[5]]);
                            let lifetime = u32::from_be_bytes([m[8], m[9], m[10], m[11]]);
                            f.log.push(format!("natpmp {internal} {lifetime}"));
                            let mut r = vec![0u8, 130, 0, 0, 0, 0, 0, 1];
                            r.extend_from_slice(&internal.to_be_bytes());
                            r.extend_from_slice(&(if lifetime == 0 { 0 } else { f.gives }).to_be_bytes());
                            r.extend_from_slice(&lifetime.to_be_bytes());
                            Some(r)
                        }
                    } else if m[0] == 0 && f.pcp {
                        // PCP only: NAT-PMP's version isn't known.
                        Some(vec![2, 0x80, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])
                    } else if m[0] == 2 && f.pcp && m.len() >= 60 {
                        let lifetime = u32::from_be_bytes([m[4], m[5], m[6], m[7]]);
                        let internal = u16::from_be_bytes([m[40], m[41]]);
                        f.log.push(format!("pcp {internal} {lifetime}"));
                        let mut r = vec![2u8, 0x81, 0, 0];
                        r.extend_from_slice(&lifetime.to_be_bytes());
                        r.extend_from_slice(&[0u8; 16]);
                        r.extend_from_slice(&m[24..42]);
                        r.extend_from_slice(&f.gives.to_be_bytes());
                        r.extend_from_slice(&mapped(f.outside.unwrap()));
                        Some(r)
                    } else {
                        None
                    }
                };
                if let Some(r) = reply {
                    let _ = udp.send_to(&r, from).await;
                }
            }
        });
        let f = fake.clone();
        tokio::spawn(async move {
            while let Ok((mut stream, _)) = tcp.accept().await {
                let f = f.clone();
                tokio::spawn(async move {
                    let mut data = Vec::new();
                    let mut buf = [0u8; 4096];
                    loop {
                        let n = stream.read(&mut buf).await.unwrap_or(0);
                        if n == 0 {
                            break;
                        }
                        data.extend_from_slice(&buf[..n]);
                        let text = String::from_utf8_lossy(&data).to_string();
                        if let Some(end) = text.find("\r\n\r\n") {
                            let len = header(&text[..end], "content-length").and_then(|l| l.parse().ok()).unwrap_or(0usize);
                            if data.len() >= end + 4 + len {
                                break;
                            }
                        }
                    }
                    let text = String::from_utf8_lossy(&data).to_string();
                    let (status, body) = answer(&f, &text);
                    let reply = format!("HTTP/1.1 {status} X\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
                    let _ = stream.write_all(reply.as_bytes()).await;
                });
            }
        });
        let router = Router {
            gateway: Ipv4Addr::LOCALHOST,
            local: Ipv4Addr::LOCALHOST,
            port: udp_port,
            ssdp: SocketAddrV4::new(Ipv4Addr::LOCALHOST, udp_port),
        };
        (router, fake)
    }

    fn answer(f: &Mutex<Fake>, req: &str) -> (u16, String) {
        const SERVICE: &str = "urn:schemas-upnp-org:service:WANIPConnection:1";
        if req.starts_with("GET /desc.xml") {
            return (200, format!("<root><device><serviceList><service><serviceType>{SERVICE}</serviceType><controlURL>/ctl</controlURL></service></serviceList></device></root>"));
        }
        let mut f = f.lock().unwrap();
        let action = header(req, "soapaction").unwrap_or_default();
        let get = |n: &str| tag(req, n).unwrap_or_default();
        let fault = |code: u32| (500, format!("<s:Fault><UPnPError><errorCode>{code}</errorCode><errorDescription>E{code}</errorDescription></UPnPError></s:Fault>"));
        if action.ends_with("#GetExternalIPAddress\"") {
            (200, format!("<NewExternalIPAddress>{}</NewExternalIPAddress>", f.outside.unwrap()))
        } else if action.ends_with("#AddPortMapping\"") {
            let port: u16 = get("NewExternalPort").parse().unwrap();
            let (client, to) = (get("NewInternalClient"), get("NewInternalPort").parse().unwrap());
            f.log.push(format!("add {port} lease {}", get("NewLeaseDuration")));
            if f.taken.contains(&port) || f.doors.iter().any(|d| d.0 == port) {
                return fault(718);
            }
            f.doors.push((port, client, to));
            (200, String::new())
        } else if action.ends_with("#GetSpecificPortMappingEntry\"") {
            let port: u16 = get("NewExternalPort").parse().unwrap();
            match f.doors.iter().find(|d| d.0 == port) {
                Some((_, client, to)) => (200, format!("<NewInternalPort>{to}</NewInternalPort><NewInternalClient>{client}</NewInternalClient>")),
                None => (200, "<NewInternalPort>80</NewInternalPort><NewInternalClient>192.168.8.50</NewInternalClient>".into()),
            }
        } else if action.ends_with("#DeletePortMapping\"") {
            let port: u16 = get("NewExternalPort").parse().unwrap();
            f.log.push(format!("delete {port}"));
            f.doors.retain(|d| d.0 != port);
            (200, String::new())
        } else {
            fault(401)
        }
    }

    const HOME: Ipv4Addr = Ipv4Addr::new(192, 168, 31, 178);

    #[tokio::test]
    async fn upnp_opens_renews_and_closes_the_door() {
        let (router, fake) = pretend(Fake { upnp: true, outside: Some(HOME), ..Fake::default() }).await;
        let m = open(router, 53317, 53317, false, None).await.unwrap();
        assert_eq!((m.via.name(), m.external_port, m.external_ip), ("upnp", 53317, HOME));
        // Renewed: asked again; it's there already, ours.
        let again = open(router, 53317, 53317, false, Some(&m)).await.unwrap();
        assert_eq!(again, m);
        close(&m).await;
        let f = fake.lock().unwrap();
        assert_eq!(f.log, ["add 53317 lease 3600", "add 53317 lease 3600", "delete 53317"]);
        assert!(f.doors.is_empty());
    }

    #[tokio::test]
    async fn a_port_another_computer_holds_is_skipped() {
        let (router, _) = pretend(Fake { upnp: true, outside: Some(HOME), taken: vec![53317], ..Fake::default() }).await;
        let m = open(router, 53317, 53317, false, None).await.unwrap();
        assert_eq!(m.external_port, 53318);
    }

    #[tokio::test]
    async fn a_router_facing_the_internet_is_left_alone_unless_allowed() {
        let public = Ipv4Addr::new(203, 0, 113, 7);
        let (router, fake) = pretend(Fake { upnp: true, outside: Some(public), ..Fake::default() }).await;
        assert_eq!(open(router, 53317, 53317, false, None).await, Err(NotOpened::Public { ip: public, via: "upnp" }));
        assert!(fake.lock().unwrap().log.is_empty());
        assert_eq!(open(router, 53317, 53317, true, None).await.unwrap().external_ip, public);
    }

    #[tokio::test]
    async fn nat_pmp_then_pcp() {
        let (router, fake) = pretend(Fake { natpmp: true, outside: Some(HOME), gives: 40000, ..Fake::default() }).await;
        let m = open(router, 53317, 53317, false, None).await.unwrap();
        assert_eq!((m.via.name(), m.external_port, m.external_ip), ("natpmp", 40000, HOME));
        close(&m).await;
        assert_eq!(fake.lock().unwrap().log, ["natpmp 53317 3600", "natpmp 53317 0"]);

        let (router, fake) = pretend(Fake { pcp: true, outside: Some(HOME), gives: 40001, ..Fake::default() }).await;
        let m = open(router, 53317, 53317, false, None).await.unwrap();
        assert_eq!((m.via.name(), m.external_port, m.external_ip), ("pcp", 40001, HOME));
        close(&m).await;
        assert_eq!(fake.lock().unwrap().log, ["pcp 53317 3600", "pcp 53317 0"]);
    }

    #[tokio::test]
    async fn nobody_answering_is_said_so() {
        let (router, _) = pretend(Fake::default()).await;
        assert_eq!(open(router, 53317, 53317, false, None).await, Err(NotOpened::Nobody));
    }
}
