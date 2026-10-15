//! Two Pet Posts in one process, talking over localhost: discovery by `register`,
//! deliveries accepted, declined, cancelled, with a PIN and from a trusted device, folders
//! and text messages.

use std::net::{IpAddr, Ipv4Addr, TcpListener};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{channel, Receiver};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::Value;

use super::{add_device, answer, client, configure, discovery, Config, Device, Inner, Post, Saved};

const LOCALHOST: IpAddr = IpAddr::V4(Ipv4Addr::LOCALHOST);

struct Peer {
    inner: Arc<Inner>,
    events: Receiver<(String, Value)>,
    dir: PathBuf,
    port: u16,
}

fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port()
}

fn peer(name: &str, tweak: impl FnOnce(&mut Config)) -> Peer {
    let dir = std::env::temp_dir().join(format!("epet-post-{name}-{}", desktoppet_core::post::random_id()));
    std::fs::create_dir_all(&dir).unwrap();
    let (tx, events) = channel();
    let tx = Mutex::new(tx);
    let emit = move |e: &str, v: Value| {
        let _ = tx.lock().unwrap().send((e.to_string(), v));
    };
    let inner = Post::with(Box::new(emit), dir.join("data"), dir.join("downloads")).0;
    let port = free_port();
    let mut config =
        Config { enabled: true, alias: name.into(), auto_accept_trusted: true, port, ..Default::default() };
    tweak(&mut config);
    let wanted = config.port;
    let status = tauri::async_runtime::block_on(configure(&inner, config));
    assert!(status.running, "{name} isn't running: {:?}", status.error);
    if wanted != 0 {
        assert_eq!(status.port, wanted);
    }
    Peer { inner, events, dir, port: status.port }
}

impl Drop for Peer {
    fn drop(&mut self) {
        tauri::async_runtime::block_on(configure(&self.inner, Config::default()));
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

impl Peer {
    /// The next event `name` that `pred` likes (others are skipped).
    fn wait(&self, name: &str, pred: impl Fn(&Value) -> bool) -> Value {
        let end = Instant::now() + Duration::from_secs(20);
        while let Some(left) = end.checked_duration_since(Instant::now()) {
            match self.events.recv_timeout(left) {
                Ok((e, v)) if e == name && pred(&v) => return v,
                Ok((e, v)) => eprintln!("(skipped {e} {v})"),
                Err(_) => break,
            }
        }
        panic!("no {name} event");
    }

    fn transfer(&self, state: &str) -> Value {
        self.wait("post-transfer", |v| v["state"] == state)
    }

    /// Finds `other` by introducing itself (as a scan or an answer to an announcement does).
    fn find(&self, other: &Peer) -> Device {
        let d = tauri::async_runtime::block_on(client::register(&self.inner, LOCALHOST, other.port, true, None))
            .expect("register");
        self.inner.add_device(d.clone());
        d
    }

    fn fingerprint(&self) -> String {
        self.inner.identity().unwrap().fingerprint
    }

    fn saved(&self, rel: &str) -> PathBuf {
        self.dir.join("downloads").join("ePet").join(rel)
    }
}

fn write(path: &Path, data: &[u8]) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, data).unwrap();
}

#[test]
fn two_pets_find_each_other_and_deliver_a_file() {
    let (a, b) = (peer("Alice", |_| {}), peer("Bob", |_| {}));
    let to_b = a.find(&b);
    assert_eq!(to_b.alias, "Bob");
    assert_eq!(to_b.fingerprint, b.fingerprint());
    assert!(to_b.https);
    // Bob learnt about Alice too (her certificate proves who she is).
    assert!(b.inner.devices().iter().any(|d| d.fingerprint == a.fingerprint() && d.alias == "Alice"));

    let data: Vec<u8> = (0..300_000u32).map(|i| (i % 251) as u8).collect();
    let file = a.dir.join("out").join("photo.jpg");
    write(&file, &data);
    client::send(a.inner.clone(), to_b, vec![file], None, None).unwrap();
    a.transfer("waiting");
    let offer = b.wait("post-offer", |_| true);
    assert_eq!(offer["alias"], "Alice");
    assert_eq!(offer["files"], 1);
    assert_eq!(offer["bytes"], 300_000);
    assert_eq!(offer["names"][0], "photo.jpg");
    assert_eq!(offer["fingerprint"], Value::String(a.fingerprint()));
    answer(&b.inner, offer["id"].as_str().unwrap(), true);
    let done = b.transfer("done");
    assert_eq!(done["files"], 1);
    assert_eq!(std::fs::read(b.saved("photo.jpg")).unwrap(), data);
    assert_eq!(done["first"], Value::String(b.saved("photo.jpg").to_string_lossy().into_owned()));
    a.transfer("done");

    // The same name again: a second copy beside the first.
    let small = a.dir.join("out").join("photo.jpg");
    write(&small, b"again");
    client::send(a.inner.clone(), a.find(&b), vec![small], None, None).unwrap();
    let offer = b.wait("post-offer", |_| true);
    answer(&b.inner, offer["id"].as_str().unwrap(), true);
    a.transfer("done");
    b.transfer("done");
    assert_eq!(std::fs::read(b.saved("photo (2).jpg")).unwrap(), b"again");
}

#[test]
fn folders_keep_their_shape_and_text_is_a_message() {
    let (a, b) = (peer("A", |_| {}), peer("B", |_| {}));
    let to_b = a.find(&b);
    let folder = a.dir.join("Trip");
    write(&folder.join("day1").join("a.txt"), b"one");
    write(&folder.join("b.txt"), b"two");
    write(&folder.join("empty.bin"), b"");
    client::send(a.inner.clone(), to_b.clone(), vec![folder], None, None).unwrap();
    let offer = b.wait("post-offer", |_| true);
    assert_eq!(offer["files"], 3);
    answer(&b.inner, offer["id"].as_str().unwrap(), true);
    b.transfer("done");
    assert_eq!(std::fs::read(b.saved("Trip/day1/a.txt")).unwrap(), b"one");
    assert_eq!(std::fs::read(b.saved("Trip/b.txt")).unwrap(), b"two");
    assert_eq!(std::fs::read(b.saved("Trip/empty.bin")).unwrap(), b"");
    a.transfer("done");

    client::send(a.inner.clone(), to_b, vec![], Some("Dinner at 7? 🍜".into()), None).unwrap();
    let text = b.wait("post-text", |_| true);
    assert_eq!(text["alias"], "A");
    assert_eq!(text["text"], "Dinner at 7? 🍜");
    a.transfer("done");
}

#[test]
fn declined_cancelled_and_busy() {
    let (a, b) = (peer("A", |_| {}), peer("B", |_| {}));
    let to_b = a.find(&b);
    let file = a.dir.join("x.bin");
    write(&file, b"data");

    client::send(a.inner.clone(), to_b.clone(), vec![file.clone()], None, None).unwrap();
    let offer = b.wait("post-offer", |_| true);
    // A second delivery can't start while one is under way.
    assert!(client::send(a.inner.clone(), to_b.clone(), vec![file.clone()], None, None).is_err());
    answer(&b.inner, offer["id"].as_str().unwrap(), false);
    a.transfer("declined");
    assert!(!b.saved("x.bin").exists());

    // The sender gives up while the pet is still asking: the question goes.
    client::send(a.inner.clone(), to_b.clone(), vec![file.clone()], None, None).unwrap();
    let offer = b.wait("post-offer", |_| true);
    client::cancel(a.inner.clone());
    a.transfer("cancelled");
    let closed = b.wait("post-offer-closed", |_| true);
    assert_eq!(closed["id"], offer["id"]);

    // A third device finds the receiver busy.
    let c = peer("C", |_| {});
    let c_to_b = c.find(&b);
    client::send(a.inner.clone(), to_b, vec![file.clone()], None, None).unwrap();
    b.wait("post-offer", |_| true);
    client::send(c.inner.clone(), c_to_b, vec![file], None, None).unwrap();
    c.transfer("busy");
}

#[test]
fn a_pin_is_asked_and_trusted_devices_need_no_answer() {
    let a = peer("A", |_| {});
    let a_fingerprint = a.fingerprint();
    let b = peer("B", |c| c.pin = "4321".into());
    let to_b = a.find(&b);
    let file = a.dir.join("note.txt");
    write(&file, b"hello");
    client::send(a.inner.clone(), to_b.clone(), vec![file.clone()], None, None).unwrap();
    a.transfer("pin");
    client::send(a.inner.clone(), to_b.clone(), vec![file.clone()], None, Some("0000".into())).unwrap();
    a.transfer("pin");
    client::send(a.inner.clone(), to_b, vec![file.clone()], None, Some("4321".into())).unwrap();
    let offer = b.wait("post-offer", |_| true);
    answer(&b.inner, offer["id"].as_str().unwrap(), true);
    b.transfer("done");

    // Trusted (by the fingerprint its certificate proves): taken without asking.
    let c = peer("C", |c| c.trusted = vec![a_fingerprint.clone()]);
    let to_c = a.find(&c);
    client::send(a.inner.clone(), to_c, vec![file], None, None).unwrap();
    let done = c.transfer("done");
    assert_eq!(done["peer"], "A");
    assert!(c.events.try_iter().all(|(e, _)| e != "post-offer"));
    assert_eq!(std::fs::read(c.saved("note.txt")).unwrap(), b"hello");
}

#[test]
fn off_means_not_listening() {
    let b = peer("B", |_| {});
    let port = b.port;
    tauri::async_runtime::block_on(configure(&b.inner, Config { port, ..Default::default() }));
    // (The listener goes on its task's next turn.)
    let end = Instant::now() + Duration::from_secs(5);
    while std::net::TcpStream::connect((LOCALHOST, port)).is_ok() {
        assert!(Instant::now() < end, "still listening");
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(!b.inner.status().running);
}

#[test]
fn a_device_added_by_address_is_remembered_and_checked() {
    let a = peer("A", |_| {});
    let b = peer("B", |_| {});
    let (b_port, b_fp) = (b.port, b.fingerprint());
    let added = tauri::async_runtime::block_on(add_device(&a.inner, " 127.0.0.1 ", b_port)).unwrap();
    assert_eq!((added.alias.as_str(), added.fingerprint.as_str()), ("B", b_fp.as_str()));
    assert_eq!((added.source, added.reached, added.address.as_deref()), ("address", true, Some("127.0.0.1")));
    // Nothing there, no such host.
    let nobody = tauri::async_runtime::block_on(add_device(&a.inner, "127.0.0.1", free_port()));
    assert_eq!(nobody.unwrap_err(), "unreachable");
    let unknown = tauri::async_runtime::block_on(add_device(&a.inner, "no-such-host.invalid", b_port));
    assert_eq!(unknown.unwrap_err(), "address");

    // Kept in the settings: listed (not answering yet) when Pet Post starts again.
    let saved = Saved {
        address: "127.0.0.1".into(),
        port: b_port,
        fingerprint: b_fp.clone(),
        alias: "B".into(),
        ..Default::default()
    };
    let config = Config { devices: vec![saved], ..a.inner.config() };
    tauri::async_runtime::block_on(configure(&a.inner, Config { enabled: false, ..config.clone() }));
    tauri::async_runtime::block_on(configure(&a.inner, config.clone()));
    let listed = |fp: &str| a.inner.devices().into_iter().find(|d| d.fingerprint == fp).expect("listed");
    assert_eq!(listed(&b_fp).address.as_deref(), Some("127.0.0.1"));
    tauri::async_runtime::block_on(discovery::ask_saved(&a.inner));
    let d = listed(&b_fp);
    assert!(d.online && d.reached && d.changed_to.is_none(), "{d:?}");

    // Gone: still listed, offline.
    drop(b);
    tauri::async_runtime::block_on(discovery::ask_saved(&a.inner));
    assert!(!listed(&b_fp).online);

    // Another device answers there now: not B (another certificate), so nothing goes to it.
    let c = peer("C", |c| c.port = b_port);
    tauri::async_runtime::block_on(discovery::ask_saved(&a.inner));
    assert_eq!(listed(&b_fp).changed_to, Some(c.fingerprint()));

    // Removed from the settings: no longer listed.
    tauri::async_runtime::block_on(configure(&a.inner, Config { devices: vec![], ..config }));
    assert!(a.inner.devices().iter().all(|d| d.fingerprint != b_fp));
}

#[test]
fn an_address_that_works_is_kept_when_the_device_calls_from_a_router() {
    let (a, b) = (peer("A", |_| {}), peer("B", |_| {}));
    let to_b = a.find(&b);
    assert!(to_b.reached);
    // B is behind a second router (NAT): its own requests come from the router's address.
    let mut heard = to_b.clone();
    heard.ip = "192.168.31.234".parse().unwrap();
    heard.reached = false;
    heard.alias = "B renamed".into();
    a.inner.add_device(heard);
    let d = a.inner.devices().into_iter().find(|d| d.fingerprint == to_b.fingerprint).unwrap();
    assert_eq!((d.ip, d.alias.as_str()), (LOCALHOST, "B renamed"));
    // Not reached before: the address it comes from is all there is.
    let c = peer("C", |_| {});
    let mut d = Device { reached: false, ..c.find(&a) };
    d.fingerprint = "C0FFEE".into();
    d.ip = "192.168.31.235".parse().unwrap();
    a.inner.add_device(d);
    assert_eq!(
        a.inner.devices().into_iter().find(|d| d.fingerprint == "C0FFEE").unwrap().ip.to_string(),
        "192.168.31.235"
    );
}

/// Interoperability with the LocalSend app: run with `LOCALSEND_CLI=<path to localsend-cli>`
/// (built from https://github.com/localsend/localsend, folder `cli`).
#[test]
#[ignore]
fn localsend_cli_sends_to_epet() {
    let cli = std::env::var("LOCALSEND_CLI").expect("LOCALSEND_CLI");
    let to = std::env::var("LOCALSEND_TO").unwrap_or_else(|_| "127.0.0.1".into());
    // On LocalSend's port: the CLI sends to an address there.
    let b = peer("ePet", |c| c.port = 0);
    assert_eq!(b.port, desktoppet_core::post::DEFAULT_PORT);
    let file = b.dir.join("from-localsend.txt");
    write(&file, b"sent by LocalSend");
    let mut child = std::process::Command::new(&cli)
        // LOCALSEND_TO=ePet: found by multicast instead.
        .args(["--alias", "LocalSend CLI", "--port", &free_port().to_string(), "send", "--to", &to])
        .arg(&file)
        .spawn()
        .unwrap();
    let offer = b.wait("post-offer", |_| true);
    assert_eq!(offer["alias"], "LocalSend CLI");
    answer(&b.inner, offer["id"].as_str().unwrap(), true);
    b.transfer("done");
    assert_eq!(std::fs::read(b.saved("from-localsend.txt")).unwrap(), b"sent by LocalSend");
    assert!(child.wait().unwrap().success());
    // The CLI made itself known (its certificate proves its fingerprint).
    assert!(b.inner.devices().iter().any(|d| d.alias == "LocalSend CLI"));

    let mut child = std::process::Command::new(&cli)
        .args(["--alias", "LocalSend CLI", "--port", &free_port().to_string(), "send", "--to", "127.0.0.1"])
        .args(["--text", "hello from LocalSend"])
        .spawn()
        .unwrap();
    let text = b.wait("post-text", |_| true);
    assert_eq!(text["text"], "hello from LocalSend");
    assert!(child.wait().unwrap().success());
}

/// ePet sends to the LocalSend CLI receiving on `LOCALSEND_CLI_PORT` (run interactively;
/// it must accept, e.g. `y` typed into it), saving to `LOCALSEND_CLI_DEST`.
#[test]
#[ignore]
fn epet_sends_to_localsend_cli() {
    let port: u16 = std::env::var("LOCALSEND_CLI_PORT").expect("LOCALSEND_CLI_PORT").parse().unwrap();
    let dest = PathBuf::from(std::env::var("LOCALSEND_CLI_DEST").expect("LOCALSEND_CLI_DEST"));
    let a = peer("ePet sender", |_| {});
    let cli =
        tauri::async_runtime::block_on(client::register(&a.inner, LOCALHOST, port, true, None)).expect("register");
    a.inner.add_device(cli.clone());
    let folder = a.dir.join("Pics");
    write(&folder.join("cat.txt"), b"meow");
    write(&folder.join("more").join("dog.txt"), b"woof");
    client::send(a.inner.clone(), cli.clone(), vec![folder], None, None).unwrap();
    a.transfer("done");
    // (The CLI saves a folder's files side by side; the apps keep its folders.)
    let found = |name: &str| ["", "Pics", "Pics/more"].iter().find_map(|d| std::fs::read(dest.join(d).join(name)).ok());
    assert_eq!(found("cat.txt").unwrap(), b"meow");
    assert_eq!(found("dog.txt").unwrap(), b"woof");
    client::send(a.inner.clone(), cli, vec![], Some("hi LocalSend, from ePet".into()), None).unwrap();
    a.transfer("done");
}
