/**
 * Pet Post (src-tauri/src/post/, src/pet/courier.ts): off until turned on; a LocalSend
 * device (e2e/localsend-peer.mjs) found by multicast; files it sends asked about by the pet
 * and saved; declined, with a PIN, from a trusted device; a text message; sending to it.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before } from "node:test";
import { check, useApp } from "./harness.mjs";
import { LOCALSEND_PORT, Peer } from "./localsend-peer.mjs";

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
  await peer.announce();
  const reg = await until("ePet answers the announcement", () => peer.registered.find((r) => r.fingerprint === fingerprint), 20_000);
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
  // Next time: no question.
  const again = await peer.prepare({ "second.txt": "2" });
  assert.equal(again.status, 200);
  await peer.upload(again.body);
  await until("saved", () => existsSync(join(inbox, "second.txt")));
  assert.equal(readFileSync(join(inbox, "second.txt"), "utf8"), "2");
});

check("post.hidden", "the hidden pet comes out to ask; hidden in Quiet mode, it declines and tells you later", async () => {
  const app = ctx.app;
  await app.setSettings((s) => ({ ...s, post: { ...s.post, trusted: [] } }));
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
  await app.toWindow("post.html");
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
});

check("post.off-again", "turned off: it stops listening", async () => {
  const app = ctx.app;
  await app.closeWindow("post");
  await app.panel("settings");
  await app.click(".post-settings .post-enabled");
  await until("stopped", async () => !(await app.invoke("post_status")).running);
  assert.equal(await listening(LOCALSEND_PORT), false);
});
