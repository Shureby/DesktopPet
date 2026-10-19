/**
 * Pet Post (src-tauri/src/post/, src/pet/courier.ts): off until turned on; a LocalSend
 * device (e2e/localsend-peer.mjs) found by multicast; files it sends asked about by the pet
 * and saved; declined, with a PIN, from a trusted device; a text message; sending to it.
 * Then beyond this network: Verify, extra networks, Tailscale (pretended), a device added
 * by address, one that calls from behind a router, stops answering, or is someone else.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before } from "node:test";
import { check, useApp } from "./harness.mjs";
import { LOCALSEND_PORT, Peer } from "./localsend-peer.mjs";

// The extra networks and the tailnet are asked on the pretend device's port; Tailscale's
// answer is this file (none: not installed).
const tailnetFile = join(mkdtempSync(join(tmpdir(), "epet-tailnet-")), "status.json");
writeFileSync(tailnetFile, JSON.stringify({ BackendState: "NeedsLogin", Peer: {} }));
process.env.EPET_TAILSCALE_STATUS = tailnetFile;
process.env.EPET_POST_PEER_PORT = "53318";

const ctx = useApp(import.meta.filename);
const peer = new Peer();
const inbox = mkdtempSync(join(tmpdir(), "epet-inbox-"));
let fingerprint = "";

before(() => peer.start());
after(() => peer.stop());

/** Whether something listens on localhost:port. */
const listening = (port) =>
  new Promise((resolve) => {
    const s = net.connect({ host: "127.0.0.1", port, timeout: 1500 });
    s.on("connect", () => (s.destroy(), resolve(true)));
    s.on("error", () => resolve(false));
    s.on("timeout", () => (s.destroy(), resolve(false)));
  });

/** The Pet Post window, on one of its tabs ("receive" | "send" | "history"). */
async function postTab(name) {
  const app = ctx.app;
  await app.toWindow("post.html");
  await app.until(() => document.querySelector(".post-tab"));
  await app.click(`.post-tab[data-tab="${name}"]`);
  await app.until((n) => document.querySelector(`.post-tab[data-tab="${n}"]`)?.classList.contains("active"), [name]);
}

/** A port nothing listens on. */
const freePort = () =>
  new Promise((resolve) => {
    const srv = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });

/** Verify as LocalSend works it out (app/lib/pages/verify_page.dart): its icons' names and text. */
const ICON_NAMES = [...readFileSync(new URL("../src/features/post/verifyIcons.ts", import.meta.url), "utf8").matchAll(/^\s*\["(\w+)",/gm)].map((m) => m[1]);
function verifyCode(a, b) {
  const text = [a, b].sort().join("");
  let v = BigInt(`0x${createHash("sha256").update(text).digest("hex").slice(0, 32)}`);
  const icons = [];
  for (let i = 0; i < 16; i++) {
    icons.unshift(ICON_NAMES[Number(v % 260n)]);
    v /= 260n;
  }
  return { text, icons };
}

const until = async (what, fn, timeout = 15_000) => {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 250));
  }
};

check("post.off", "Pet Post is off until turned on: ePet doesn't listen on the network", async () => {
  const app = ctx.app;
  assert.equal((await app.invoke("post_status")).running, false);
  assert.equal(await listening(LOCALSEND_PORT), false);
  await app.panel("settings");
  await app.waitText(".post-settings", "Send and receive files on this network");
  await app.waitText(".post-settings .post-state", "Off: ePet doesn't listen on the network.");
});

check("post.enable", "ticking it in Settings → Pet Post starts it on LocalSend's port, named after the pet", async () => {
  const app = ctx.app;
  await app.panel("settings");
  await app.click(".post-settings .post-enabled");
  await app.waitText(".post-settings .post-state", "On: others see this computer as “Cat on");
  const status = await until("running", async () => {
    const s = await app.invoke("post_status");
    return s.running && s;
  });
  assert.equal(status.port, LOCALSEND_PORT);
  assert.match(status.fingerprint, /^[0-9A-F]{64}$/);
  fingerprint = status.fingerprint;
  assert.equal(await listening(LOCALSEND_PORT), true);
  await app.setSettings((s) => ({ ...s, post: { ...s.post, saveDir: inbox } }));
});

check("post.discover", "a LocalSend device announcing itself is answered (over HTTPS, its certificate checked) and listed", async () => {
  const app = ctx.app;
  // Announced again until answered, as LocalSend does: a multicast packet can be lost.
  let reg;
  for (let i = 0; i < 6 && !reg; i++) {
    await peer.announce();
    reg = await until("ePet answers the announcement", () => peer.registered.find((r) => r.fingerprint === fingerprint), 5000).catch(() => null);
  }
  assert.ok(reg, `no answer to 6 announcements; registered: ${JSON.stringify(peer.registered)}`);
  assert.match(reg.alias, /^Cat on /);
  assert.equal(reg.protocol, "https");
  await app.toPet();
  const devices = await until("listed", async () => {
    const list = await app.invoke("post_devices");
    return list.some((d) => d.fingerprint === peer.fingerprint) && list;
  });
  const d = devices.find((x) => x.fingerprint === peer.fingerprint);
  assert.equal(d.alias, "Mock Phone");
  assert.equal(d.deviceType, "mobile");
  // Asked directly, it introduces itself with the same fingerprint as its certificate.
  const r = await peer.register();
  assert.equal(r.status, 200);
  assert.equal(r.body.fingerprint, fingerprint);
  assert.equal(r.fingerprint, fingerprint);
});

check("post.receive", "files sent from LocalSend: the pet asks, Accept saves them (folders kept)", async () => {
  const app = ctx.app;
  const big = Buffer.alloc(300_000, 7);
  const reply = peer.prepare({ "hello.txt": "hello from the phone", "Pics/big.bin": big });
  const bubble = await app.waitBubble("Mock Phone wants to send you 2 files");
  assert.match(bubble, /hello\.txt, big\.bin/);
  await app.answer("Accept");
  const r = await reply;
  assert.equal(r.status, 200);
  assert.deepEqual(await peer.upload(r.body), [200, 200]);
  await app.waitBubble("Got 2 files from Mock Phone!");
  assert.equal(readFileSync(join(inbox, "hello.txt"), "utf8"), "hello from the phone");
  assert.deepEqual(readFileSync(join(inbox, "Pics", "big.bin")), big);
});

check("post.reject", "Decline: the sender is told no, nothing is saved", async () => {
  const app = ctx.app;
  const reply = peer.prepare({ "nope.txt": "no" });
  await app.waitBubble("Mock Phone wants to send you 1 file");
  await app.answer("Decline");
  assert.equal((await reply).status, 403);
  assert.equal(existsSync(join(inbox, "nope.txt")), false);
});

check("post.text", "a text message shows in the pet's bubble, with Copy", async () => {
  const app = ctx.app;
  const r = await peer.sendText("Dinner at 7?");
  assert.equal(r.status, 204);
  const bubble = await app.waitBubble("Mock Phone says:");
  assert.match(bubble, /Dinner at 7\?/);
  await app.answer("OK");
});

check("post.pin", "with a PIN, a sender without it (or with a wrong one) is refused", async () => {
  const app = ctx.app;
  await app.setSettings((s) => ({ ...s, post: { ...s.post, pin: "2468" } }));
  await until("PIN in force", async () => (await peer.prepare({ "x.txt": "x" })).status === 401);
  assert.equal((await peer.prepare({ "x.txt": "x" }, { pin: "1111" })).status, 401);
  const reply = peer.prepare({ "x.txt": "x" }, { pin: "2468" });
  await app.waitBubble("Mock Phone wants to send you 1 file");
  await app.answer("Decline");
  assert.equal((await reply).status, 403);
  await app.setSettings((s) => ({ ...s, post: { ...s.post, pin: "" } }));
});

check("post.trust", "Always accept: the device is trusted, and its next delivery is taken without asking", async () => {
  const app = ctx.app;
  const reply = peer.prepare({ "first.txt": "1" });
  await app.waitBubble("Mock Phone wants to send you 1 file");
  await app.answer("Always accept");
  const r = await reply;
  assert.equal(r.status, 200);
  await peer.upload(r.body);
  const s = await until("trusted", async () => {
    const st = await app.fullSettings();
    return st.post.trusted.length > 0 && st;
  });
  assert.deepEqual(s.post.trusted, [{ fingerprint: peer.fingerprint, alias: "Mock Phone" }]);
  // A favorite now: kept too.
  assert.deepEqual(s.post.devices.map((d) => [d.fingerprint, d.via]), [[peer.fingerprint, "favorite"]]);
  // Next time: no question.
  const again = await peer.prepare({ "second.txt": "2" });
  assert.equal(again.status, 200);
  await peer.upload(again.body);
  await until("saved", () => existsSync(join(inbox, "second.txt")));
  assert.equal(readFileSync(join(inbox, "second.txt"), "utf8"), "2");
});

check("post.hidden", "the hidden pet comes out to ask; hidden in Quiet mode, it declines and tells you later", async () => {
  const app = ctx.app;
  // ("Always accept" made it a favorite: no longer, nor kept; and as if never told.)
  await app.setSettings((s) => ({ ...s, post: { ...s.post, trusted: [], devices: [], favoriteNoticeSeen: false } }));
  await app.run("tray", "Hide pet");
  await app.b.waitUntil(async () => !(await app.visible("pet")), { timeout: 5000 });
  const reply = peer.prepare({ "while-hidden.txt": "h" });
  await app.b.waitUntil(async () => app.visible("pet"), { timeout: 10_000 });
  await app.waitBubble("Mock Phone wants to send you 1 file");
  await app.answer("Decline");
  assert.equal((await reply).status, 403);
  // Quiet: not now.
  await app.invoke("clear_unseen");
  await app.setSettings((s) => ({ ...s, modes: { ...s.modes, choice: "quiet", override: null } }));
  await app.b.waitUntil(async () => (await app.pet()).mode === "quiet", { timeout: 5000 });
  await until("hidden again", async () => !(await app.visible("pet")), 20_000);
  assert.equal((await peer.prepare({ "quiet.txt": "q" })).status, 403);
  const unseen = await until("told later", async () => {
    const list = await app.invoke("list_unseen");
    return list.length > 0 && list;
  });
  assert.equal(unseen[0].kind, "post");
  assert.equal(unseen[0].title, "Mock Phone: 1 file");
  await app.setSettings((s) => ({ ...s, modes: { ...s.modes, choice: "normal" } }));
  await app.invoke("e2e_tray", { id: "show" });
  await app.answer("Done").catch(() => {});
});

check("post.send", "the Pet Post window lists the device; a file and a text reach it", async () => {
  const app = ctx.app;
  const file = join(mkdtempSync(join(tmpdir(), "epet-out-")), "report.pdf");
  writeFileSync(file, "PDF?");
  await app.toPet();
  await app.invoke("open_post_window");
  await postTab("send");
  await app.waitText(".post-device", "Mock Phone");
  // (The file dialog can't be driven: the command it leads to.)
  await app.invoke("post_send", { to: peer.fingerprint, paths: [file], text: null, pin: null });
  await until("file arrived", () => peer.files.get("report.pdf"));
  assert.equal(peer.files.get("report.pdf").toString(), "PDF?");
  await app.until(() => !document.querySelector(".post-send-text")?.disabled);
  await app.type(".post-text", "sent from ePet");
  await app.click(".post-send-text");
  await until("text arrived", () => peer.texts?.includes("sent from ePet"));
  await app.waitText(".post-progress", "Delivered to Mock Phone!");
  // Paste: the clipboard's text goes in at once (read by the app: no "Paste" asked on a Mac).
  await app.invoke("e2e_set_clipboard", { text: "from the clipboard" });
  await app.until(() => document.querySelector(".post-text")?.value === "");
  await app.click(".post-paste");
  await app.until(() => document.querySelector(".post-text")?.value === "from the clipboard");
  await app.b.execute(() => {
    const box = document.querySelector(".post-text");
    box.value = "";
    box.dispatchEvent(new Event("input"));
  });
  // Delivered: the box is emptied. Declined: the text stays, to send again.
  await app.until(() => document.querySelector(".post-text")?.value === "");
  peer.answer = "decline";
  try {
    await app.until(() => !document.querySelector(".post-send-text")?.disabled);
    await app.type(".post-text", "not wanted");
    await app.click(".post-send-text");
    await app.waitText(".post-progress", "Mock Phone didn't accept it.");
    assert.equal(await app.b.execute(() => document.querySelector(".post-text").value), "not wanted");
    await app.b.execute(() => {
      const box = document.querySelector(".post-text");
      box.value = "";
      box.dispatchEvent(new Event("input"));
    });
  } finally {
    peer.answer = "accept";
  }
});

check("post.tabs", "the Pet Post window's tabs: opened on the one asked for (Send from the pet), else the one left last", async () => {
  const app = ctx.app;
  const active = () => app.until(() => document.querySelector(".post-tab.active")?.dataset.tab);
  await app.toPet();
  await app.invoke("open_post_window", { verify: null, tab: "history" });
  await app.toWindow("post.html");
  assert.equal(await active(), "history");
  await app.toPet();
  await app.invoke("open_post_window", { verify: null, tab: "send" });
  await app.toWindow("post.html");
  await app.until(() => document.querySelector(".post-tab.active")?.dataset.tab === "send");
  // Closed and opened again: where it was left.
  await app.closeWindow("post");
  await app.invoke("open_post_window", { verify: null, tab: null });
  await app.toWindow("post.html");
  assert.equal(await active(), "send");
  await app.click('.post-tab[data-tab="receive"]');
  assert.equal(await active(), "receive");
});

check("post.own-address", "the Pet Post window shows this computer's addresses and port, to add it by address elsewhere", async () => {
  const app = ctx.app;
  const status = await app.invoke("post_status");
  assert.ok(status.addresses.length > 0, "no address");
  for (const a of status.addresses) assert.match(a.kind, /^(ethernet|wifi|lan|tailscale|virtual)$/);
  await postTab("receive");
  // The likeliest one shown; the others in the list, by kind (local network, Tailscale, virtual).
  await app.waitText(".post-address", `${status.addresses[0].ip}:53317`);
  if (status.addresses.length > 1) {
    await app.click(".post-address-pick");
    const listed = await app.until(() => {
      const l = [...document.querySelectorAll(".post-address-option code")].map((e) => e.textContent);
      return l.length && l;
    });
    assert.deepEqual([...listed].sort(), status.addresses.map((a) => `${a.ip}:53317`).sort());
    await app.click(".post-address-option:last-child");
    const last = await app.text(".post-address");
    assert.ok(listed.includes(last), last);
  }
  assert.equal(await app.b.execute(() => !!document.querySelector(".post-port-moved")), false);
  // Where received files go, with Change… right there.
  await app.waitText(".post-save-dir", inbox);
  await app.until(() => !!document.querySelector(".post-change-dir"));
});

check("post.window-receive", "with the Pet Post window open, it asks too: answered there, the pet's question goes; then a sound, and it's in Received", async () => {
  const app = ctx.app;
  await app.toPet();
  const since = await app.b.execute(() => Date.now());
  const reply = peer.prepare({ "from-window.txt": "w" });
  await app.waitBubble("Mock Phone wants to send you 1 file");
  await app.toWindow("post.html");
  await app.waitText(".post-offer", "Mock Phone wants to send you 1 file");
  await app.waitText(".post-offer-countdown", "if you don't answer");
  await app.click(".post-accept");
  const r = await reply;
  assert.equal(r.status, 200);
  // The pet doesn't ask any more.
  await app.toPet();
  await app.b.waitUntil(async () => !/wants to send you/.test((await app.bubble()) ?? ""), { timeout: 5000 });
  assert.deepEqual(await peer.upload(r.body), [200]);
  await app.toWindow("post.html");
  await app.waitText(".post-incoming", "Got 1 file from Mock Phone!");
  await app.waitText(".post-received-item", "1 file from Mock Phone");
  await app.toPet();
  const played = await app.sounds(since);
  assert.ok(played.some((p) => p.kind === "received"), JSON.stringify(played));
  const history = await app.invoke("post_history");
  assert.equal(history[0].from, "Mock Phone");
  assert.match(history[0].paths[0], /from-window\.txt$/);
});

check("post.window-hidden", "the hidden pet stays hidden while the Pet Post window is open: the window asks", async () => {
  const app = ctx.app;
  await app.run("tray", "Hide pet");
  await app.b.waitUntil(async () => !(await app.visible("pet")), { timeout: 5000 });
  await app.invoke("open_post_window");
  const reply = peer.prepare({ "while-hidden-2.txt": "h" });
  await app.toWindow("post.html");
  await app.waitText(".post-offer", "Mock Phone wants to send you 1 file");
  await new Promise((res) => setTimeout(res, 1500));
  assert.equal(await app.visible("pet"), false);
  await app.click(".post-decline");
  assert.equal((await reply).status, 403);
  await app.until(() => !document.querySelector(".post-offer"));
  await app.invoke("e2e_tray", { id: "show" });
  await app.b.waitUntil(async () => app.visible("pet"), { timeout: 10_000 });
  await app.answer("Done").catch(() => {});
});

check("post.stop-receiving", "Stop receiving: what's coming stops, and the sender is told no", async () => {
  const app = ctx.app;
  await app.toWindow("post.html");
  const reply = peer.prepare({ "stopped.bin": Buffer.alloc(1000, 1) });
  await app.waitText(".post-offer", "Mock Phone wants to send you 1 file");
  await app.click(".post-accept");
  const r = await reply;
  assert.equal(r.status, 200);
  await app.click(".post-stop-receiving");
  await app.waitText(".post-incoming", "Stopped receiving from Mock Phone.");
  assert.deepEqual(await peer.upload(r.body), [403]);
  assert.equal(existsSync(join(inbox, "stopped.bin")), false);
});

check("post.history", "Received keeps what came (files and texts) across restarts of the window; Clear empties it", async () => {
  const app = ctx.app;
  await app.closeWindow("post");
  await app.invoke("open_post_window");
  await postTab("history");
  await app.waitText(".post-received-item", "1 file from Mock Phone");
  await app.waitText(".post-received-item", "Dinner at 7?");
  await app.click(".post-clear-history");
  await app.until(() => !document.querySelector(".post-received-item"));
  assert.deepEqual(await app.invoke("post_history"), []);
});

/** The pretend device as the app lists it now. */
const listed = async (fp = peer.fingerprint) => (await ctx.app.invoke("post_devices")).find((d) => d.fingerprint === fp);

/** Looks again (now and then) until `fn` is satisfied. */
async function lookUntil(what, fn, timeout = 30_000) {
  let last = 0;
  return until(
    what,
    async () => {
      if (Date.now() - last > 5000) {
        last = Date.now();
        await ctx.app.invoke("post_refresh");
      }
      return fn();
    },
    timeout,
  );
}

check("post.verify", "Verify in Pet Post shows the same icons (and text) LocalSend shows for these two devices", async () => {
  const app = ctx.app;
  assert.equal(ICON_NAMES.length, 260);
  const want = verifyCode(fingerprint, peer.fingerprint);
  await postTab("send");
  await app.b.execute((name) => {
    const row = [...document.querySelectorAll(".post-device")].find((e) => e.textContent.includes(name));
    row.querySelector(".post-verify").click();
  }, "Mock Phone");
  const shown = await app.until(() => {
    const icons = [...document.querySelectorAll(".post-verify-grid svg")].map((e) => e.dataset.icon);
    return icons.length === 16 && icons;
  });
  assert.deepEqual(shown, want.icons);
  await app.waitText(".post-verify-view", "With Mock Phone");
  await app.click(".post-verify-text");
  await app.waitText(".post-verify-code", want.text);
  await app.click(".post-verify-done");
  await app.waitText(".post-device", "Mock Phone");
});

check("post.verify-offer", "Verify… in the pet's question opens it in Pet Post, and the question stays", async () => {
  const app = ctx.app;
  const reply = peer.prepare({ "v.txt": "v" });
  await app.waitBubble("Mock Phone wants to send you 1 file");
  await app.answer("Verify…");
  await app.toWindow("post.html");
  const shown = await app.until(() => {
    const icons = [...document.querySelectorAll(".post-verify-grid svg")].map((e) => e.dataset.icon);
    return icons.length === 16 && icons;
  });
  assert.deepEqual(shown, verifyCode(fingerprint, peer.fingerprint).icons);
  await app.click(".post-verify-done");
  assert.match(await app.bubble(), /Mock Phone wants to send you 1 file/);
  await app.answer("Decline");
  assert.equal((await reply).status, 403);
});

/** Opens Verify for `name` from Send. */
async function verifyFromSend(name) {
  await postTab("send");
  await ctx.app.b.execute((n) => {
    const row = [...document.querySelectorAll(".post-device")].find((e) => e.textContent.includes(n));
    row.querySelector(".post-verify").click();
  }, name);
}

/** The settings as the app has them now. */
const postSettings = async () => (await ctx.app.invoke("get_settings")).post;

check("post.verify-ask", "Verify for another ePet: request sent, it shows them, They match → Verified badge", async () => {
  const app = ctx.app;
  Object.assign(peer, { epet: true, verifyAsks: [], verifyAnswer: "shown", verifyResult: null });
  try {
    await verifyFromSend("Mock Phone");
    await app.waitText(".post-verify-shown", "Mock Phone shows them too");
    assert.equal(peer.verifyAsks.length, 1);
    assert.equal(peer.verifyAsks[0].fingerprint, fingerprint);
    // The Done button stays in sight at the bottom, even in a short window.
    assert.ok(await app.b.execute(() => {
      const r = document.querySelector(".post-verify-done").getBoundingClientRect();
      return r.bottom <= window.innerHeight && r.top >= 0;
    }));
    // They match: back to the list at once, the badge by its name.
    await app.click(".post-verify-match");
    await app.until(() => !document.querySelector(".post-verify-view"));
    assert.ok((await postSettings()).verified.some((d) => d.fingerprint === peer.fingerprint));
    await app.until((n) => [...document.querySelectorAll(".post-device")].some((e) => e.textContent.includes(n) && e.querySelector(".post-verified")), ["Mock Phone"]);
  } finally {
    peer.epet = false;
  }
});

check("post.verify-declined", "the other ePet declines: said so, and nothing is sent to it this time", async () => {
  const app = ctx.app;
  Object.assign(peer, { epet: true, verifyAsks: [], verifyAnswer: "declined", verifyResult: null });
  try {
    await verifyFromSend("Mock Phone");
    await app.waitText(".post-verify-declined", "Mock Phone declined to verify");
    assert.equal(await app.b.execute(() => !!document.querySelector(".post-verify-match")), false);
    // Not blocked.
    assert.equal((await postSettings()).blocked.length, 0);
    await app.click(".post-verify-done");
  } finally {
    peer.epet = false;
  }
});

check("post.verify-mismatch", "its user says they don't match: a warning with Block / Re-check; Block blocks it everywhere", async () => {
  const app = ctx.app;
  Object.assign(peer, { epet: true, verifyAsks: [], verifyAnswer: "shown", verifyResult: "mismatch" });
  try {
    await verifyFromSend("Mock Phone");
    await app.waitText(".post-verify-mismatch", "Mock Phone says the icons don't match", 15_000);
    // Re-check: no longer verified here, and asked again.
    await app.click(".post-verify-recheck");
    await app.until(() => document.querySelector(".post-verify-shown"));
    assert.equal(peer.verifyAsks.length, 2);
    assert.ok(!(await postSettings()).verified.some((d) => d.fingerprint === peer.fingerprint));
    await app.waitText(".post-verify-mismatch", "says the icons don't match", 15_000);
    await app.click(".post-verify-block");
    await app.waitText(".post-verify-confirm", "Block Mock Phone?");
    await app.click(".post-verify-block-yes");
    await app.until(() => !document.querySelector(".post-verify-view"));
    assert.ok((await postSettings()).blocked.some((d) => d.fingerprint === peer.fingerprint));
    // Not listed, and what it sends is refused (and not asked about).
    assert.equal(await listed(), undefined);
    assert.equal((await peer.prepare({ "blocked.txt": "x" })).status, 403);
    assert.equal((await peer.register()).status, 403);
    // Unblocked (Settings → Pet Post → Blocked devices): found again.
    await app.setSettings((st) => ({ ...st, post: { ...st.post, blocked: [] } }));
    await until("unblocked", async () => (await postSettings()).blocked.length === 0);
    assert.equal((await peer.register()).status, 200);
    await until("found again after Unblock", () => listed());
  } finally {
    peer.epet = false;
    peer.verifyResult = null;
  }
});

check("post.verify-asked", "asked by another ePet: the pet asks (Show / Decline); Show opens Verify there, not asked back; its decision goes back", async () => {
  const app = ctx.app;
  Object.assign(peer, { epet: true, verifyAsks: [], verifyAnswer: "shown", verifyResult: null });
  try {
    await app.closeWindow("post");
    await app.toPet();
    const asking = peer.askVerify();
    await app.waitBubble("Mock Phone wants to verify with you.");
    await app.answer("Show");
    const reply = await asking;
    assert.deepEqual([reply.status, reply.body?.answer], [200, "shown"]);
    // Not again straight away.
    assert.equal((await peer.askVerify()).status, 429);
    await app.toWindow("post.html");
    const shown = await app.until(() => {
      const icons = [...document.querySelectorAll(".post-verify-grid svg")].map((e) => e.dataset.icon);
      return icons.length === 16 && icons;
    });
    assert.deepEqual(shown, verifyCode(fingerprint, peer.fingerprint).icons);
    await app.waitText(".post-verify-asked-by", "Mock Phone asked to compare.");
    // What's decided here goes back when asked (They don't match → "mismatch"); Look again: not blocked.
    const result = peer.askVerifyResult();
    await new Promise((r) => setTimeout(r, 500));
    await app.click(".post-verify-mismatch-button");
    const r = await result;
    assert.deepEqual([r.status, r.body?.result], [200, "mismatch"]);
    await app.click(".post-verify-look-again");
    assert.equal((await postSettings()).blocked.length, 0);
    assert.equal(peer.verifyAsks.length, 0);
    await app.click(".post-verify-done");
  } finally {
    peer.epet = false;
  }
});

check("post.recent-senders", "Receive → Recent senders lists who sent something lately, with Verify", async () => {
  const app = ctx.app;
  await app.toPet();
  const reply = peer.prepare({ "recent.txt": "recent" });
  await app.waitBubble("Mock Phone wants to send you 1 file");
  await app.answer("Accept");
  const r = await reply;
  assert.deepEqual(await peer.upload(r.body), [200]);
  await app.waitBubble("Got 1 file from Mock Phone!");
  await postTab("receive");
  await app.waitText(".post-recent-sender", "Mock Phone");
  await app.click(".post-recent-sender .post-verify");
  const shown = await app.until(() => {
    const icons = [...document.querySelectorAll(".post-verify-grid svg")].map((e) => e.dataset.icon);
    return icons.length === 16 && icons;
  });
  assert.deepEqual(shown, verifyCode(fingerprint, peer.fingerprint).icons);
  await app.waitText(".post-verify-view", "With Mock Phone");
  await app.click(".post-verify-done");
});

check("post.networks", "an extra network in Settings → Pet Post is looked in too", async () => {
  const app = ctx.app;
  await app.setSettings((s) => ({ ...s, post: { ...s.post, networks: ["127.0.0.1/32"] } }));
  const d = await lookUntil("found in the extra network", async () => {
    const x = await listed();
    return x?.source === "network" && x;
  });
  assert.equal(d.ip, "127.0.0.1");
  assert.equal(d.port, 53318);
  await postTab("send");
  await app.waitText(".post-device", "on another network");
  await app.setSettings((s) => ({ ...s, post: { ...s.post, networks: [] } }));
});

check("post.tailscale", "the devices of the Tailscale network are asked (Tailscale pretended); what Tailscale says is shown", async () => {
  const app = ctx.app;
  await app.panel("settings");
  await app.invoke("post_refresh");
  await app.waitText(".post-settings .post-tailnet", "Tailscale is installed but not signed in.", 15_000);
  writeFileSync(
    tailnetFile,
    JSON.stringify({
      BackendState: "Running",
      Self: { HostName: "this", TailscaleIPs: ["100.64.0.1"], Online: true },
      Peer: {
        "nodekey:phone": { HostName: "mock-phone", TailscaleIPs: ["127.0.0.1"], Online: true },
        "nodekey:off": { HostName: "laptop", TailscaleIPs: ["127.0.0.9"], Online: false },
      },
    }),
  );
  await lookUntil("listed via Tailscale", async () => (await listed())?.source === "tailnet");
  assert.deepEqual(await app.invoke("post_tailnet"), { state: "running", online: 1 });
  await app.panel("settings");
  await app.waitText(".post-settings .post-tailnet", "Tailscale: 1 device online, 1 with LocalSend or ePet.", 15_000);
  await postTab("send");
  await app.waitText(".post-device", "via Tailscale");
  rmSync(tailnetFile);
  await app.invoke("post_refresh");
  await app.panel("settings");
  await app.waitText(".post-settings .post-tailnet", "Tailscale isn't installed on this computer.", 15_000);
});

check("post.favorite", "♡ makes a device a favorite (said once, the first time): kept, and what it sends is accepted without asking; ♥ again undoes it", async () => {
  const app = ctx.app;
  await postTab("send");
  const row = (inner) => app.b.execute((sel) => {
    const r = [...document.querySelectorAll(".post-device")].find((e) => e.textContent.includes("Mock Phone"));
    r?.querySelector(sel)?.click();
    return !!r?.querySelector(sel);
  }, inner);
  assert.equal(await row(".post-favorite"), true);
  // The first time: what it means, before it's done.
  await app.waitText(".post-favorite-notice", "accepted without asking");
  assert.equal((await app.fullSettings()).post.trusted.length, 0);
  await app.toWindow("post.html");
  await row(".post-favorite-yes");
  const s = await until("a favorite", async () => {
    const st = await app.fullSettings();
    return st.post.trusted.length === 1 && st;
  });
  assert.equal(s.post.trusted[0].fingerprint, peer.fingerprint);
  assert.equal(s.post.favoriteNoticeSeen, true);
  assert.deepEqual(
    s.post.devices.map((d) => [d.fingerprint, d.via]),
    [[peer.fingerprint, "favorite"]],
  );
  await app.toWindow("post.html");
  await app.until(() => !!document.querySelector(".post-favorite.on"));
  // Accepted without asking.
  const r = await peer.prepare({ "from-favorite.txt": "♥" });
  assert.equal(r.status, 200);
  assert.deepEqual(await peer.upload(r.body), [200]);
  await until("saved", () => existsSync(join(inbox, "from-favorite.txt")));
  // ♥ again: no longer a favorite, nor kept; and no notice this time.
  await postTab("send");
  await row(".post-favorite.on");
  await until("not a favorite", async () => {
    const st = await app.fullSettings();
    return st.post.trusted.length === 0 && st.post.devices.length === 0;
  });
  await postTab("send");
  await row(".post-favorite");
  await until("a favorite at once", async () => (await app.fullSettings()).post.trusted.length === 1);
  await app.setSettings((x) => ({ ...x, post: { ...x.post, trusted: [], devices: [] } }));
});

check("post.add", "a device added by address (in Pet Post) is listed and kept in the settings", async () => {
  const app = ctx.app;
  await postTab("send");
  await app.click(".post-add-open");
  await app.type(".post-add-address", "127.0.0.1");
  await app.type(".post-add-port", "53318");
  await app.click(".post-add-go");
  await app.waitText(".post-add-state", "Added Mock Phone.", 20_000);
  await app.waitText(".post-device", "added by address");
  const s = await app.fullSettings();
  assert.deepEqual(s.post.devices, [{ address: "127.0.0.1", port: 53318, fingerprint: peer.fingerprint, alias: "Mock Phone", deviceType: "mobile", via: "address" }]);
  const d = await listed();
  assert.equal(d.source, "address");
  assert.equal(d.reached, true);
});

check("post.add-fail", "an address where nothing answers: said so, with a word about the firewall", async () => {
  const app = ctx.app;
  await app.toWindow("post.html");
  await app.type(".post-add-address", "127.0.0.1");
  await app.type(".post-add-port", String(await freePort()));
  await app.click(".post-add-go");
  await app.waitText(".post-add-state", "Couldn't reach it.", 20_000);
  await app.waitText(".post-firewall", "Allow an app");
  await app.type(".post-add-address", "no-such-device.invalid");
  await app.type(".post-add-port", "53318");
  await app.click(".post-add-go");
  await app.waitText(".post-add-state", "No device by that name.", 20_000);
  assert.equal((await app.fullSettings()).post.devices.length, 1);
});

check("post.nat", "a device reached at an address keeps it when it calls from another (a router it's behind)", async () => {
  const r = await peer.register(LOCALSEND_PORT, "127.0.0.2");
  assert.equal(r.status, 200);
  await new Promise((res) => setTimeout(res, 500));
  const d = await listed();
  assert.equal(d.ip, "127.0.0.1");
  assert.equal(d.port, 53318);
});

check("post.offline", "a device added by address that stops answering stays listed, as not answering", async () => {
  const app = ctx.app;
  await peer.stop();
  await lookUntil("not answering", async () => (await listed())?.online === false);
  await postTab("send");
  await app.waitText(".post-device-state", "Not answering.");
});

check("post.identity", "another device answering at that address: nothing is sent to it until you say it's yours", async () => {
  const app = ctx.app;
  const other = new Peer("Mock Phone", 53318);
  await other.start();
  try {
    await lookUntil("seen as another device", async () => (await listed())?.changedTo === other.fingerprint);
    await postTab("send");
    await app.waitText(".post-device-state", "Another device answers there now.");
    const sent = await app.b.execute(
      (fp) =>
        window.__TAURI_INTERNALS__.invoke("post_send", { to: fp, paths: [], text: "x", pin: null }).then(
          () => "sent",
          (e) => String(e),
        ),
      peer.fingerprint,
    );
    assert.equal(sent, "identity");
    await app.click(".post-trust-new");
    const s = await until("kept the new one", async () => {
      const st = await app.fullSettings();
      return st.post.devices[0]?.fingerprint === other.fingerprint && st;
    });
    assert.equal(s.post.devices.length, 1);
    await app.toWindow("post.html");
    await app.until(() => !document.querySelector(".post-trust-new"));
  } finally {
    await other.stop();
    await peer.start();
  }
});

check("post.one-way", "a device this computer reaches on another network, that never reached it: Receive says it may not get through", async () => {
  const app = ctx.app;
  const shy = new Peer("Shy Phone", await freePort());
  await shy.start();
  try {
    await app.invoke("post_add_device", { address: "127.0.0.1", port: shy.port });
    await postTab("receive");
    await app.waitText(".post-one-way", "Shy Phone");
    await app.click(".post-one-way-ok");
    await app.until(() => !document.querySelector(".post-one-way"));
    // Once it reaches this computer itself, it isn't one of them.
    assert.equal((await shy.register()).status, 200);
    const d = await until("came in", async () => (await ctx.app.invoke("post_devices")).find((x) => x.fingerprint === shy.fingerprint && x.cameIn));
    assert.equal(d.reached, true);
  } finally {
    await shy.stop();
  }
});

check("post.off-again", "turned off: it stops listening", async () => {
  const app = ctx.app;
  await app.closeWindow("post");
  await app.panel("settings");
  await app.click(".post-settings .post-enabled");
  await until("stopped", async () => !(await app.invoke("post_status")).running);
  assert.equal(await listening(LOCALSEND_PORT), false);
});

check("post.port-taken", "LocalSend's port taken by another app: the next free one, said in Pet Post and Settings", async () => {
  const app = ctx.app;
  const other = net.createServer();
  await new Promise((r) => other.listen(LOCALSEND_PORT, "0.0.0.0", r));
  try {
    await app.panel("settings");
    await app.click(".post-settings .post-enabled");
    const status = await until("running", async () => {
      const st = await app.invoke("post_status");
      return st.running && st;
    });
    // The next free one after 53317 (the pretend device holds 53318).
    assert.ok(status.port > LOCALSEND_PORT && status.port <= LOCALSEND_PORT + 10, `port ${status.port}`);
    assert.equal(await listening(status.port), true);
    await app.waitText(".post-settings .post-state", `(port ${status.port}: 53317 is taken by another app)`);
    await app.invoke("open_post_window");
    await postTab("receive");
    await app.waitText(".post-port-moved", `so this computer uses ${status.port}`);
    await app.until((p) => [...document.querySelectorAll(".post-address")].every((e) => e.textContent.endsWith(`:${p}`)), [status.port]);
    await app.closeWindow("post");
    await app.panel("settings");
    await app.click(".post-settings .post-enabled");
    await until("stopped", async () => !(await app.invoke("post_status")).running);
  } finally {
    await new Promise((r) => other.close(r));
  }
});
