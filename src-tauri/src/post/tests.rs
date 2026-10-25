//! Two Pet Posts in one process, talking over localhost: discovery by `register`,
//! deliveries accepted, declined, cancelled, with a PIN and from a trusted device, folders
//! and text messages.

use std::net::{IpAddr, Ipv4Addr, TcpListener};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{channel, Receiver};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::Value;

use super::{
    add_device, answer, client, configure, discovery, verify, verify_answer, Config, Device, Inner, Post, Saved,
};

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

    /// As `wait`, for as long as a big file takes.
    fn wait_long(&self, name: &str, pred: impl Fn(&Value) -> bool) -> Value {
        let end = Instant::now() + Duration::from_secs(600);
        while let Some(left) = end.checked_duration_since(Instant::now()) {
            match self.events.recv_timeout(left) {
                Ok((e, v)) if e == name && pred(&v) => return v,
                Ok(_) => {}
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
    // Alice reached Bob herself; Bob hasn't reached Alice (yet): maybe he can't.
    assert!(b.inner.devices().iter().any(|d| d.fingerprint == a.fingerprint() && d.came_in));
    assert!(!to_b.came_in);

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
    let closed = b.wait("post-offer-closed", |_| true);
    assert_eq!(
        (closed["id"].clone(), closed["reason"].as_str(), closed["accept"].as_bool()),
        (offer["id"].clone(), Some("answered"), Some(true))
    );
    let done = b.transfer("done");
    assert_eq!(done["files"], 1);
    assert_eq!(std::fs::read(b.saved("photo.jpg")).unwrap(), data);
    // Kept in what was received (and in its file, for next time).
    let history = b.inner.history();
    assert_eq!(history.len(), 1);
    assert_eq!((history[0].from.as_str(), history[0].files, history[0].bytes), ("Alice", 1, 300_000));
    // Who it was, proven by her certificate (Receive → Recent senders).
    assert_eq!(
        (history[0].fingerprint.as_str(), history[0].device_type.as_str()),
        (a.fingerprint().as_str(), "desktop")
    );
    assert_eq!(history[0].paths, vec![b.saved("photo.jpg").to_string_lossy().into_owned()]);
    let kept: Vec<super::Received> =
        serde_json::from_slice(&std::fs::read(b.dir.join("data").join("post-history.json")).unwrap()).unwrap();
    assert_eq!(kept[0].id, history[0].id);
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

/// `client::ask_verify` from `from` to `to`, on its own thread (it waits for the answer).
fn ask(from: &Peer, to: &Peer) -> std::thread::JoinHandle<String> {
    let (inner, fp) = (from.inner.clone(), to.fingerprint());
    std::thread::spawn(move || tauri::async_runtime::block_on(client::ask_verify(&inner, &fp)))
}

#[test]
fn verify_is_asked_answered_and_decided() {
    let (a, b) = (peer("Alice", |_| {}), peer("Bob", |_| {}));
    // Not found yet: nobody to ask.
    assert_eq!(ask(&a, &b).join().unwrap(), "unreachable");
    a.find(&b);
    let asking = ask(&a, &b);
    let asked = b.wait("post-verify-asked", |_| true);
    assert_eq!(
        (asked["fingerprint"].as_str(), asked["alias"].as_str()),
        (Some(a.fingerprint().as_str()), Some("Alice"))
    );
    verify_answer(&b.inner, &a.fingerprint(), true);
    assert_eq!(asking.join().unwrap(), "shown");
    // Bob's Verify for Alice: the same icons, and asked by her (so not asked back).
    let (on_a, on_b) = (verify(&a.inner, &b.fingerprint()).unwrap(), verify(&b.inner, &a.fingerprint()).unwrap());
    assert_eq!((on_a.text, on_a.icons), (on_b.text, on_b.icons));
    assert_eq!((on_a.asked_by, on_b.asked_by.as_deref()), (None, Some("Alice")));
    // Alice waits for what Bob decides: they don't match.
    let (inner, fp) = (a.inner.clone(), b.fingerprint());
    let result = std::thread::spawn(move || tauri::async_runtime::block_on(client::verify_result(&inner, &fp)));
    std::thread::sleep(Duration::from_millis(300));
    b.inner.decided(&a.fingerprint()).send_replace(Some(false));
    assert_eq!(result.join().unwrap().as_deref(), Some("mismatch"));
    // Not again straight away.
    assert_eq!(ask(&a, &b).join().unwrap(), "busy");

    // Declined: said so.
    let c = peer("Carol", |_| {});
    c.find(&b);
    let asking = ask(&c, &b);
    b.wait("post-verify-asked", |v| v["alias"] == "Carol");
    verify_answer(&b.inner, &c.fingerprint(), false);
    assert_eq!(asking.join().unwrap(), "declined");
}

#[test]
fn a_pet_that_cant_be_reached_collects_what_is_sent_to_it() {
    let (alice, bob) = (peer("Alice", |_| {}), peer("Bob", |_| {}));
    // Bob reached Alice (he's behind a router she can't get through).
    let to_alice = bob.find(&alice);
    assert!(to_alice.epet);
    // Bob asks Alice for deliveries (a request that waits).
    let (inner, d) = (bob.inner.clone(), to_alice.clone());
    let asking = std::thread::spawn(move || tauri::async_runtime::block_on(super::pickup::ask_once(&inner, &d)));
    std::thread::sleep(Duration::from_millis(400));
    // Alice can't reach Bob where she sees him.
    let fp = bob.fingerprint();
    alice.inner.update_device(&fp, |d| d.port = free_port());
    let to_bob = alice.inner.devices().into_iter().find(|d| d.fingerprint == fp).unwrap();
    assert!(super::pickup::collects(&alice.inner, &fp));
    let file = alice.dir.join("out").join("collected.txt");
    write(&file, b"collect me");
    client::send(alice.inner.clone(), to_bob, vec![file], None, None).unwrap();
    let waiting = alice.wait("post-transfer", |v| v["state"] == "waiting" && v["collect"] == true);
    assert_eq!(waiting["files"], 1);
    // Asked about at Bob's as any delivery is; accepted, fetched.
    let offer = bob.wait("post-offer", |_| true);
    assert_eq!(
        (offer["alias"].as_str(), offer["fingerprint"].as_str()),
        (Some("Alice"), Some(alice.fingerprint().as_str()))
    );
    answer(&bob.inner, offer["id"].as_str().unwrap(), true);
    bob.transfer("done");
    alice.transfer("done");
    assert_eq!(asking.join().unwrap(), Ok(true));
    assert_eq!(std::fs::read(bob.saved("collected.txt")).unwrap(), b"collect me");
    assert_eq!(bob.inner.history()[0].fingerprint, alice.fingerprint());
}

#[test]
fn a_blocked_device_is_refused_everywhere() {
    let (a, b) = (peer("Alice", |_| {}), peer("Mallory", |_| {}));
    a.find(&b);
    assert!(a.inner.devices().iter().any(|d| d.fingerprint == b.fingerprint()));
    // Alice blocks Mallory: no longer listed, not found again, and refused.
    let mut config = a.inner.config();
    config.blocked = vec![b.fingerprint().to_ascii_lowercase()];
    tauri::async_runtime::block_on(configure(&a.inner, config));
    assert!(!a.inner.devices().iter().any(|d| d.fingerprint == b.fingerprint()));
    let to_a = tauri::async_runtime::block_on(client::register(&b.inner, LOCALHOST, a.port, true, None));
    assert!(to_a.is_none(), "a blocked device's register is refused");
    assert!(!a.inner.devices().iter().any(|d| d.fingerprint == b.fingerprint()));
    // Mallory still knows where Alice is (found before): what it sends is refused.
    let to_a = b.inner.devices().into_iter().find(|d| d.fingerprint == a.fingerprint()).unwrap();
    let file = b.dir.join("out").join("x.txt");
    write(&file, b"x");
    client::send(b.inner.clone(), to_a, vec![file], None, None).unwrap();
    b.transfer("declined");
    assert_eq!(ask(&b, &a).join().unwrap(), "refused");
    assert!(a.inner.history().is_empty());
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
    let history = b.inner.history();
    assert_eq!(history[0].text.as_deref(), Some("Dinner at 7? 🍜"));
    assert_eq!(history[1].files, 3);
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

    // Stopped by the receiver while it comes: the sender is told.
    let big = a.dir.join("big.bin");
    // (Big enough that it's still coming when stopped.)
    write(&big, &vec![1u8; 100 * 1024 * 1024]);
    client::send(a.inner.clone(), to_b.clone(), vec![big], None, None).unwrap();
    let offer = b.wait("post-offer", |_| true);
    answer(&b.inner, offer["id"].as_str().unwrap(), true);
    b.wait("post-transfer", |v| v["state"] == "receiving" && v["done"].as_u64().unwrap_or(0) > 0);
    super::stop_receiving(&b.inner);
    b.transfer("stopped");
    a.transfer("failed");
    assert!(b.inner.history().is_empty());

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

    // Found just now at another address (its own address changed, DHCP): that one stands.
    let mut moved = listed(&b_fp);
    moved.changed_to = None;
    moved.online = true;
    moved.reached = true;
    moved.ip = "127.0.0.9".parse().unwrap();
    moved.last_seen = crate::state::now_ms();
    a.inner.devices.lock().unwrap().insert(b_fp.clone(), moved);
    tauri::async_runtime::block_on(discovery::ask_saved(&a.inner));
    let d = listed(&b_fp);
    assert!(d.online && d.changed_to.is_none() && d.ip.to_string() == "127.0.0.9", "{d:?}");

    // Removed from the settings: no longer listed (not found otherwise lately).
    a.inner.devices.lock().unwrap().get_mut(&b_fp).unwrap().last_seen = 0;
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

#[test]
fn a_taken_port_moves_to_the_next_free_one() {
    tauri::async_runtime::block_on(async {
        // Two free ports in a row: the first taken by "another app".
        let (taken, base) = loop {
            let a = std::net::TcpListener::bind("0.0.0.0:0").unwrap();
            let p = a.local_addr().unwrap().port();
            if p < 65000 && std::net::TcpListener::bind(("0.0.0.0", p + 1)).is_ok() {
                break (a, p);
            }
        };
        let l = super::server::bind_first(base..=base + 3).await.expect("a free one");
        assert_eq!(l.local_addr().unwrap().port(), base + 1);
        drop(taken);
    });
}

/// How fast a big file goes between two pets on this computer (run by hand, release:
/// `EPET_POST_BENCH_MB=1024 cargo test --release -p desktoppet post_speed -- --ignored --nocapture`).
#[test]
#[ignore]
fn post_speed() {
    let mb: u64 = std::env::var("EPET_POST_BENCH_MB").ok().and_then(|v| v.parse().ok()).unwrap_or(512);
    let (a, b) = (peer("A", |_| {}), peer("B", |c| c.trusted = vec![]));
    let to_b = a.find(&b);
    let file = a.dir.join("big.bin");
    {
        use std::io::Write;
        let mut f = std::io::BufWriter::new(std::fs::File::create(&file).unwrap());
        let block: Vec<u8> = (0..1024 * 1024u32).map(|i| (i % 251) as u8).collect();
        for _ in 0..mb {
            f.write_all(&block).unwrap();
        }
    }
    let start = Instant::now();
    client::send(a.inner.clone(), to_b, vec![file], None, None).unwrap();
    let offer = b.wait("post-offer", |_| true);
    answer(&b.inner, offer["id"].as_str().unwrap(), true);
    let t0 = Instant::now();
    b.wait_long("post-transfer", |v| v["state"] == "done");
    let secs = t0.elapsed().as_secs_f64();
    eprintln!(
        "POST SPEED: {mb} MB in {secs:.2} s = {:.0} MB/s (with the question: {:.2} s)",
        mb as f64 / secs,
        start.elapsed().as_secs_f64()
    );
    assert_eq!(std::fs::metadata(b.saved("big.bin")).unwrap().len(), mb * 1024 * 1024);
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

/// Pairing (pair.rs) from `from` to `to`: asks, and returns the code `to` shows.
fn pair_ask(from: &Peer, to: &Peer) -> (super::pair::PairAsk, Option<String>) {
    let asked = tauri::async_runtime::block_on(super::pair::ask(&from.inner, &to.fingerprint()));
    if asked.answer != "shown" {
        return (asked, None);
    }
    let shown = to.wait("post-pair-asked", |v| v["fingerprint"] == Value::String(from.fingerprint()));
    (asked, shown["code"].as_str().map(str::to_string))
}

fn pair_finish(from: &Peer, to: &Peer, code: &str) -> String {
    tauri::async_runtime::block_on(super::pair::finish_with(&from.inner, &to.fingerprint(), code))
}

#[test]
fn pairing_with_the_right_code_pairs_both() {
    let (a, b) = (peer("Alice", |_| {}), peer("Bob", |_| {}));
    a.find(&b);
    let (asked, code) = pair_ask(&a, &b);
    assert_eq!(asked.answer, "shown");
    assert!(asked.until.unwrap() > crate::state::now_ms());
    let code = code.unwrap();
    // Typed with a space, as shown ("482 913").
    let typed = format!("{} {}", &code[..3], &code[3..]);
    assert_eq!(pair_finish(&a, &b, &typed), "paired");
    let paired = b.wait("post-paired", |_| true);
    assert_eq!(
        (paired["fingerprint"].as_str(), paired["alias"].as_str()),
        (Some(a.fingerprint().as_str()), Some("Alice"))
    );
    b.wait("post-pair-closed", |v| v["reason"] == "paired");
    // Used up: the same code again is too late.
    assert_eq!(pair_finish(&a, &b, &code), "expired");
}

#[test]
fn a_wrong_code_ends_the_pairing_and_three_lock_the_device_out() {
    let (a, b) = (peer("Alice", |_| {}), peer("Bob", |_| {}));
    a.find(&b);
    for round in 0..3 {
        let (_, code) = pair_ask(&a, &b);
        let wrong = format!("{:06}", (code.unwrap().parse::<u32>().unwrap() + 1) % 1_000_000);
        assert_eq!(pair_finish(&a, &b, &wrong), "wrong", "round {round}");
        b.wait("post-pair-closed", |v| v["reason"] == "wrong");
    }
    assert_eq!(pair_ask(&a, &b).0.answer, "later");
    // Others still may.
    let c = peer("Carol", |_| {});
    c.find(&b);
    assert_eq!(pair_ask(&c, &b).0.answer, "shown");
    // ...but one code at a time: Alice's turn would be "busy" even if she weren't locked.
    let d = peer("Dave", |_| {});
    d.find(&b);
    assert_eq!(pair_ask(&d, &b).0.answer, "busy");
}

#[test]
fn declined_and_cancelled_pairing() {
    let (a, b) = (peer("Alice", |_| {}), peer("Bob", |_| {}));
    a.find(&b);
    let (_, code) = pair_ask(&a, &b);
    super::pair::decline(&b.inner, &a.fingerprint());
    b.wait("post-pair-closed", |v| v["reason"] == "declined");
    assert_eq!(pair_finish(&a, &b, &code.unwrap()), "declined");
    // Alice gives up: Bob's code goes.
    pair_ask(&a, &b);
    let peer_b =
        super::client::Peer::of(&a.inner.devices().into_iter().find(|d| d.fingerprint == b.fingerprint()).unwrap());
    let body = super::client::json_body(&a.inner.info(true));
    tauri::async_runtime::block_on(super::client::request(
        &a.inner,
        &peer_b,
        super::pair::CANCEL,
        body,
        None,
        Duration::from_secs(3),
    ))
    .unwrap();
    b.wait("post-pair-closed", |v| v["reason"] == "cancelled");
    // Not an ePet that pairs (LocalSend, an older ePet): said so.
    assert_eq!(pair_finish(&a, &b, "12345"), "invalid");
}

#[test]
fn a_paired_epet_must_prove_itself() {
    let (a, b, m) = (peer("Alice", |_| {}), peer("Bob", |_| {}), peer("Mallory", |_| {}));
    let mut config = a.inner.config();
    config.paired = vec![b.fingerprint()];
    tauri::async_runtime::block_on(configure(&a.inner, config));
    // Mallory claims to be Bob (his fingerprint, her certificate): refused, not listed.
    let mut info = m.inner.info(true);
    info.fingerprint = b.fingerprint();
    m.find(&a);
    let to_a = super::client::Peer { ip: LOCALHOST, port: a.port, https: true, expected: Some(a.fingerprint()) };
    let files = serde_json::json!({ "f": { "id": "f", "fileName": "x.txt", "size": 1, "fileType": "text/plain" } });
    let body = super::client::json_body(&serde_json::json!({ "info": info, "files": files }));
    let path = "/api/localsend/v2/prepare-upload";
    let reply = tauri::async_runtime::block_on(super::client::request(
        &m.inner,
        &to_a,
        path,
        body,
        None,
        Duration::from_secs(3),
    ))
    .unwrap();
    assert_eq!(reply.status, 403);
    let body = super::client::json_body(&info);
    let reply = tauri::async_runtime::block_on(super::client::request(
        &m.inner,
        &to_a,
        "/api/localsend/v2/register",
        body,
        None,
        Duration::from_secs(3),
    ))
    .unwrap();
    assert_eq!(reply.status, 403);
    // Bob himself is fine.
    b.find(&a);
    assert!(a.inner.devices().iter().any(|d| d.fingerprint == b.fingerprint()));
}
