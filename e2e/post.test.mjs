/**
 * Pet Post (src-tauri/src/post/, src/pet/courier.ts): off until turned on; a LocalSend
 * device (e2e/localsend-peer.mjs) found by multicast; files it sends asked about by the pet
 * and saved; declined, with a PIN, from a trusted device; a text message; sending to it.
 * Then beyond this network: Verify, extra networks, Tailscale (pretended), a device added
 * by address, one that calls from behind a router, stops answering, or is someone else.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before } from "node:test";
import { check, useApp } from "./harness.mjs";
import { LOCALSEND_PORT, Peer } from "./localsend-peer.mjs";
import { Router } from "./mock-router.mjs";

// The extra networks and the tailnet are asked on the pretend device's port; Tailscale's
// answer is this file (none: not installed).
const tailnetFile = join(
  mkdtempSync(join(tmpdir(), "epet-tailnet-")),
  "status.json",
);
writeFileSync(
  tailnetFile,
  JSON.stringify({ BackendState: "NeedsLogin", Peer: {} }),
);
process.env.EPET_TAILSCALE_STATUS = tailnetFile;
process.env.EPET_POST_PEER_PORT = "53318";
// The router door asks this pretend router (silent until a test has it answer).
const ROUTER_PORT = 53999;
process.env.EPET_POST_ROUTER = `127.0.0.1:${ROUTER_PORT}`;
const router = new Router(ROUTER_PORT);

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

/** Pet Post: the main window, on its Pet Post tab (since 0.55.0; it was a window of its own). */
async function toPost() {
  const app = ctx.app;
  await app.toWindow("panel.html");
  await app.until(() => {
    const tab = document.querySelector('nav button[data-tab="post"]');
    if (tab && !tab.classList.contains("active")) tab.click();
    return !!document.querySelector("#post > *");
  });
}

/** The Pet Post tab, on one of its tabs ("receive" | "send" | "history"). */
async function postTab(name) {
  const app = ctx.app;
  await toPost();
  await app.until(() => document.querySelector(".post-tab"));
  await app.click(`.post-tab[data-tab="${name}"]`);
  await app.until(
    (n) =>
      document
        .querySelector(`.post-tab[data-tab="${n}"]`)
        ?.classList.contains("active"),
    [name],
  );
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
const ICON_NAMES = [
  ...readFileSync(
    new URL("../src/features/post/verifyIcons.ts", import.meta.url),
    "utf8",
  ).matchAll(/^\s*\["(\w+)",/gm),
].map((m) => m[1]);
function verifyCode(a, b) {
  const text = [a, b].sort().join("");
  let v = BigInt(
    `0x${createHash("sha256").update(text).digest("hex").slice(0, 32)}`,
  );
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

check(
  "post.off",
  "Pet Post is off until turned on: ePet doesn't listen on the network",
  async () => {
    const app = ctx.app;
    assert.equal((await app.invoke("post_status")).running, false);
    assert.equal(await listening(LOCALSEND_PORT), false);
    await app.panel("settings");
    await app.waitText(
      ".post-settings",
      "Send and receive files on this network",
    );
    await app.waitText(
      ".post-settings .post-state",
      "Off: ePet doesn't listen on the network.",
    );
  },
);

check(
  "post.enable",
  "ticking it in Settings → Pet Post starts it on LocalSend's port, named after the pet",
  async () => {
    const app = ctx.app;
    await app.panel("settings");
    await app.click(".post-settings .post-enabled");
    await app.waitText(
      ".post-settings .post-state",
      "On: others see this computer as “Cat on",
    );
    const status = await until("running", async () => {
      const s = await app.invoke("post_status");
      return s.running && s;
    });
    assert.equal(status.port, LOCALSEND_PORT);
    assert.match(status.fingerprint, /^[0-9A-F]{64}$/);
    fingerprint = status.fingerprint;
    assert.equal(await listening(LOCALSEND_PORT), true);
    await app.setSettings((s) => ({
      ...s,
      post: { ...s.post, saveDir: inbox },
    }));
  },
);

check(
  "post.discover",
  "a LocalSend device announcing itself is answered (over HTTPS, its certificate checked) and listed",
  async () => {
    const app = ctx.app;
    // Announced again until answered, as LocalSend does: a multicast packet can be lost.
    let reg;
    for (let i = 0; i < 6 && !reg; i++) {
      await peer.announce();
      reg = await until(
        "ePet answers the announcement",
        () => peer.registered.find((r) => r.fingerprint === fingerprint),
        5000,
      ).catch(() => null);
    }
    assert.ok(
      reg,
      `no answer to 6 announcements; registered: ${JSON.stringify(peer.registered)}`,
    );
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
  },
);

check(
  "post.receive",
  "files sent from LocalSend: the pet asks, Accept saves them (folders kept)",
  async () => {
    const app = ctx.app;
    const big = Buffer.alloc(300_000, 7);
    const reply = peer.prepare({
      "hello.txt": "hello from the phone",
      "Pics/big.bin": big,
    });
    const bubble = await app.waitBubble("Mock Phone wants to send you 2 files");
    assert.match(bubble, /hello\.txt, big\.bin/);
    await app.answer("Accept");
    const r = await reply;
    assert.equal(r.status, 200);
    assert.deepEqual(await peer.upload(r.body), [200, 200]);
    await app.waitBubble("Got 2 files from Mock Phone!");
    assert.equal(
      readFileSync(join(inbox, "hello.txt"), "utf8"),
      "hello from the phone",
    );
    assert.deepEqual(readFileSync(join(inbox, "Pics", "big.bin")), big);
  },
);

check(
  "post.reject",
  "Decline: the sender is told no, nothing is saved",
  async () => {
    const app = ctx.app;
    const reply = peer.prepare({ "nope.txt": "no" });
    await app.waitBubble("Mock Phone wants to send you 1 file");
    await app.answer("Decline");
    assert.equal((await reply).status, 403);
    assert.equal(existsSync(join(inbox, "nope.txt")), false);
  },
);

check(
  "post.text",
  "a text message shows in the pet's bubble, with Copy",
  async () => {
    const app = ctx.app;
    const r = await peer.sendText("Dinner at 7?");
    assert.equal(r.status, 204);
    const bubble = await app.waitBubble("Mock Phone says:");
    assert.match(bubble, /Dinner at 7\?/);
    // Copy: on the clipboard, and the pet says so.
    await app.invoke("e2e_set_clipboard", { text: "before" });
    await app.answer("Copy");
    await app.waitBubble("📋 Copied to the clipboard.");
    assert.equal(await app.invoke("post_clipboard_text"), "Dinner at 7?");
  },
);

check(
  "post.copy",
  "Copy in the Pet Post tab says it worked (✓ Copied), then goes back",
  async () => {
    const app = ctx.app;
    await app.invoke("open_post_window");
    await postTab("receive");
    await app.until(() => !!document.querySelector(".post-address-copy"));
    const address = await app.b.execute(
      () => document.querySelector(".post-address").textContent,
    );
    await app.click(".post-address-copy");
    await app.waitText(".post-address-copy", "✓ Copied");
    assert.equal(await app.invoke("post_clipboard_text"), address);
    await app.until(
      () =>
        document.querySelector(".post-address-copy")?.textContent === "Copy",
      [],
      5000,
    );
    // (Open, the hidden pet would stay hidden: the next checks need it closed.)
    await app.closeWindow("panel");
  },
);

check(
  "post.pin",
  "with a PIN, a sender without it (or with a wrong one) is refused",
  async () => {
    const app = ctx.app;
    await app.setSettings((s) => ({ ...s, post: { ...s.post, pin: "2468" } }));
    await until(
      "PIN in force",
      async () => (await peer.prepare({ "x.txt": "x" })).status === 401,
    );
    assert.equal(
      (await peer.prepare({ "x.txt": "x" }, { pin: "1111" })).status,
      401,
    );
    const reply = peer.prepare({ "x.txt": "x" }, { pin: "2468" });
    await app.waitBubble("Mock Phone wants to send you 1 file");
    await app.answer("Decline");
    assert.equal((await reply).status, 403);
    await app.setSettings((s) => ({ ...s, post: { ...s.post, pin: "" } }));
  },
);

check(
  "post.trust",
  "Always accept: the device is trusted, and its next delivery is taken without asking",
  async () => {
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
    assert.deepEqual(s.post.trusted, [
      { fingerprint: peer.fingerprint, alias: "Mock Phone" },
    ]);
    // A favorite now: kept too.
    assert.deepEqual(
      s.post.devices.map((d) => [d.fingerprint, d.via]),
      [[peer.fingerprint, "favorite"]],
    );
    // Next time: no question.
    const again = await peer.prepare({ "second.txt": "2" });
    assert.equal(again.status, 200);
    await peer.upload(again.body);
    await until("saved", () => existsSync(join(inbox, "second.txt")));
    assert.equal(readFileSync(join(inbox, "second.txt"), "utf8"), "2");
  },
);

check(
  "post.hidden",
  "the hidden pet comes out to ask; hidden in Quiet mode, it declines and tells you later",
  async () => {
    const app = ctx.app;
    // ("Always accept" made it a favorite: no longer, nor kept; and as if never told.)
    await app.setSettings((s) => ({
      ...s,
      post: { ...s.post, trusted: [], devices: [], favoriteNoticeSeen: false },
    }));
    await app.run("tray", "Hide pet");
    await app.b.waitUntil(async () => !(await app.visible("pet")), {
      timeout: 5000,
    });
    const reply = peer.prepare({ "while-hidden.txt": "h" });
    await app.b.waitUntil(async () => app.visible("pet"), { timeout: 10_000 });
    await app.waitBubble("Mock Phone wants to send you 1 file");
    await app.answer("Decline");
    assert.equal((await reply).status, 403);
    // Quiet: not now.
    await app.invoke("clear_unseen");
    await app.setSettings((s) => ({
      ...s,
      modes: { ...s.modes, choice: "quiet", override: null },
    }));
    await app.b.waitUntil(async () => (await app.pet()).mode === "quiet", {
      timeout: 5000,
    });
    await until(
      "hidden again",
      async () => !(await app.visible("pet")),
      20_000,
    );
    assert.equal((await peer.prepare({ "quiet.txt": "q" })).status, 403);
    const unseen = await until("told later", async () => {
      const list = await app.invoke("list_unseen");
      return list.length > 0 && list;
    });
    assert.equal(unseen[0].kind, "post");
    assert.equal(unseen[0].title, "Mock Phone: 1 file");
    await app.setSettings((s) => ({
      ...s,
      modes: { ...s.modes, choice: "normal" },
    }));
    await app.invoke("e2e_tray", { id: "show" });
    await app.answer("Done").catch(() => {});
  },
);

check(
  "post.send",
  "the Pet Post tab lists the device; a file and a text reach it",
  async () => {
    const app = ctx.app;
    const file = join(mkdtempSync(join(tmpdir(), "epet-out-")), "report.pdf");
    writeFileSync(file, "PDF?");
    await app.toPet();
    await app.invoke("open_post_window");
    await postTab("send");
    await app.waitText(".post-device", "Mock Phone");
    // (The file dialog can't be driven: the command it leads to.)
    await app.invoke("post_send", {
      to: peer.fingerprint,
      paths: [file],
      text: null,
      pin: null,
    });
    await until("file arrived", () => peer.files.get("report.pdf"));
    assert.equal(peer.files.get("report.pdf").toString(), "PDF?");
    // Send a message opens the box; Send text stays grey while it's empty.
    await openMessage();
    assert.equal(
      await app.b.execute(
        () => document.querySelector(".post-send-text").disabled,
      ),
      true,
    );
    await app.type(".post-text", "sent from ePet");
    await app.until(() => !document.querySelector(".post-send-text")?.disabled);
    await app.click(".post-send-text");
    await until("text arrived", () => peer.texts?.includes("sent from ePet"));
    await app.waitText(".post-progress", "Delivered to Mock Phone!");
    // Paste: the clipboard's text goes in at once (read by the app: no "Paste" asked on a Mac).
    await app.invoke("e2e_set_clipboard", { text: "from the clipboard" });
    await app.until(() => document.querySelector(".post-text")?.value === "");
    await app.click(".post-paste");
    await app.until(
      () =>
        document.querySelector(".post-text")?.value === "from the clipboard",
    );
    await app.b.execute(() => {
      const box = document.querySelector(".post-text");
      box.value = "";
      box.dispatchEvent(new Event("input"));
    });
    // Delivered: the box is emptied. Declined: the text stays, to send again.
    await app.until(() => document.querySelector(".post-text")?.value === "");
    peer.answer = "decline";
    try {
      await app.type(".post-text", "not wanted");
      await app.until(
        () => !document.querySelector(".post-send-text")?.disabled,
      );
      await app.click(".post-send-text");
      await app.waitText(".post-progress", "Mock Phone didn't accept it.");
      assert.equal(
        await app.b.execute(() => document.querySelector(".post-text").value),
        "not wanted",
      );
      await app.b.execute(() => {
        const box = document.querySelector(".post-text");
        box.value = "";
        box.dispatchEvent(new Event("input"));
      });
    } finally {
      peer.answer = "accept";
    }
  },
);

/** Opens "Send a message" (its box) in the Pet Post tab, if it isn't. */
async function openMessage() {
  await ctx.app.b.execute(() => {
    if (!document.querySelector(".post-text"))
      document.querySelector(".post-message").click();
  });
  await ctx.app.until(() => !!document.querySelector(".post-text"));
}

check(
  "post.send-files",
  "Send files… has a ▾ menu (Files… / A folder…); sending several files lists each with how far it is, then the box goes by itself",
  async () => {
    const app = ctx.app;
    const dir = mkdtempSync(join(tmpdir(), "epet-many-"));
    const names = ["one.txt", "two.txt", "three.txt"];
    for (const n of names) writeFileSync(join(dir, n), `data of ${n}`);
    await postTab("send");
    await app.waitText(".post-device", "Mock Phone");
    await app.click(".post-files-more");
    await app.waitText(".post-send-menu", "A folder…");
    await app.until(
      () => !!document.querySelector(".post-send-menu .post-folder"),
    );
    // A click elsewhere closes it.
    await app.b.execute(() =>
      document.querySelector(".post-tab-body h3").click(),
    );
    await app.until(() => !document.querySelector(".post-send-menu"));
    // (The file dialog can't be driven: what it gives is sent as it would.)
    await app.b.execute(
      (paths) => window.__post.send(paths),
      names.map((n) => join(dir, n)),
    );
    await until("files arrived", () => names.every((n) => peer.files.get(n)));
    await app.waitText(".post-progress", "Delivered to Mock Phone!");
    const rows = await app.until(() => {
      const r = [...document.querySelectorAll(".post-progress .post-item")].map(
        (e) => e.textContent,
      );
      return r.length === 3 && r;
    });
    for (const n of names)
      assert.ok(
        rows.some((r) => r.includes(n) && r.includes("Finished")),
        `${n}: ${rows}`,
      );
    // All there: the box goes by itself.
    await app.until(
      () => !document.querySelector(".post-progress"),
      [],
      15_000,
    );
  },
);

check(
  "post.drop-window",
  "Send files and Send a message: the one chosen is dark; files or folders dropped on the window are sent; text dropped goes into the message (after the draft), not sent",
  async () => {
    const app = ctx.app;
    const dir = mkdtempSync(join(tmpdir(), "epet-drop-"));
    const names = ["dropped-1.txt", "dropped-2.txt"];
    for (const n of names) writeFileSync(join(dir, n), `dropped ${n}`);
    await postTab("send");
    await app.waitText(".post-device", "Mock Phone");
    // A draft, then Files: the message box goes (the draft stays: a dot says so).
    await openMessage();
    await app.type(".post-text", "half a message");
    assert.equal(
      await app.b.execute(() =>
        document.querySelector(".post-message").classList.contains("primary"),
      ),
      true,
    );
    await app.click(".post-files-more");
    await app.b.execute(() =>
      document.querySelector(".post-tab-body h3").click(),
    );
    await app.until(
      () =>
        !document.querySelector(".post-text") &&
        !!document.querySelector(".post-draft-dot"),
    );
    assert.equal(
      await app.b.execute(() =>
        document.querySelector(".post-files").classList.contains("primary"),
      ),
      true,
    );
    await app.waitText(
      ".post-drop",
      "Drop files or folders here to send to Mock Phone",
    );
    // Dropped on the window (the app's drop, as the system gives it): sent.
    await app.b.execute(
      (paths) => window.__post.drop(paths),
      names.map((n) => join(dir, n)),
    );
    await until("dropped files arrived", () =>
      names.every((n) => peer.files.get(n)),
    );
    await app.waitText(".post-progress", "Delivered to Mock Phone!");
    await app.until(() => !!document.querySelector(".post-drop"), [], 15_000);
    // Text dropped: into the message, after the draft; not sent.
    await app.b.execute(() => {
      const dt = new DataTransfer();
      dt.setData("text/plain", "https://example.com/x");
      document.querySelector(".post-drop").dispatchEvent(
        new DragEvent("drop", {
          dataTransfer: dt,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    await app.until(
      () =>
        document.querySelector(".post-text")?.value ===
        "half a message\nhttps://example.com/x",
    );
    await app.waitText(".post-dropped-text", "The text you dropped is in");
    assert.equal(peer.texts?.includes("https://example.com/x") ?? false, false);
    await app.b.execute(() => {
      const box = document.querySelector(".post-text");
      box.value = "";
      box.dispatchEvent(new Event("input"));
    });
  },
);

check(
  "post.pin-cancel",
  "the other device asks for a PIN: no files listed, where the PIN comes from, and Cancel gives up (nothing stuck); the right PIN sends",
  async () => {
    const app = ctx.app;
    const file = join(mkdtempSync(join(tmpdir(), "epet-pin-")), "pinned.txt");
    writeFileSync(file, "pinned");
    peer.pin = "1357";
    try {
      await postTab("send");
      await app.waitText(".post-device", "Mock Phone");
      await app.click(".post-files-more");
      await app.b.execute(() =>
        document.querySelector(".post-tab-body h3").click(),
      );
      await app.b.execute((p) => window.__post.send(p), [file]);
      await app.waitText(".post-progress", "Mock Phone asks for a PIN.");
      await app.waitText(".post-pin-where", "Require PIN");
      assert.equal(
        await app.b.execute(
          () => document.querySelectorAll(".post-progress .post-item").length,
        ),
        0,
      );
      await app.click(".post-pin-cancel");
      await app.until(
        () =>
          !document.querySelector(".post-progress") &&
          !!document.querySelector(".post-drop"),
      );
      assert.equal(peer.files.has("pinned.txt"), false);
      // Again, with the PIN.
      await app.b.execute((p) => window.__post.send(p), [file]);
      await app.until(() => !!document.querySelector(".post-pin-input"));
      await app.type(".post-pin-input", "1357");
      await app.click(".post-pin-send");
      await until("sent with the PIN", () => peer.files.get("pinned.txt"));
      await app.waitText(".post-progress", "Delivered to Mock Phone!");
    } finally {
      peer.pin = null;
    }
  },
);

check(
  "post.large",
  "more than 100 files (or 1 GB) dropped: asked first (how many, how big); Cancel sends nothing, Send sends",
  async () => {
    const app = ctx.app;
    const dir = join(mkdtempSync(join(tmpdir(), "epet-large-")), "many");
    mkdirSync(dir);
    for (let i = 0; i < 101; i++) writeFileSync(join(dir, `f${i}.txt`), "x");
    await postTab("send");
    await app.waitText(".post-device", "Mock Phone");
    await app.until(
      () => !document.querySelector(".post-progress"),
      [],
      15_000,
    );
    const before = peer.offers.length;
    await app.b.execute((p) => window.__post.drop(p), [dir]);
    await app.waitText(".post-large", "Send 101 files");
    await app.click(".post-large-no");
    await app.until(
      () =>
        !document.querySelector(".post-large") &&
        !!document.querySelector(".post-drop"),
    );
    assert.equal(peer.offers.length, before);
    await app.b.execute((p) => window.__post.drop(p), [dir]);
    await app.waitText(".post-large", "Send 101 files");
    await app.click(".post-large-yes");
    await app.waitText(".post-progress", "Delivered to Mock Phone!", 30_000);
    assert.equal(peer.offers.length, before + 1);
  },
);

check(
  "post.receive-files",
  "receiving several files: the Pet Post tab lists each with how far it is",
  async () => {
    const app = ctx.app;
    await postTab("receive");
    const reply = peer.prepare({ "a-1.txt": "first", "a-2.txt": "second" });
    await app.waitText(".post-offer", "Mock Phone wants to send you 2 files");
    await app.click(".post-accept");
    const r = await reply;
    assert.equal(r.status, 200);
    assert.deepEqual(await peer.upload(r.body), [200, 200]);
    await app.waitText(".post-incoming", "Got 2 files from Mock Phone!");
    const rows = await app.until(() => {
      const x = [...document.querySelectorAll(".post-incoming .post-item")].map(
        (e) => e.textContent,
      );
      return x.length === 2 && x;
    });
    assert.ok(
      rows.every((x) => x.includes("Finished")),
      String(rows),
    );
  },
);

check(
  "post.tabs",
  "the Pet Post tab's tabs: opened on the one asked for (Send from the pet), else the one left last",
  async () => {
    const app = ctx.app;
    const active = () =>
      app.until(() => document.querySelector(".post-tab.active")?.dataset.tab);
    await app.toPet();
    await app.invoke("open_post_window", { verify: null, tab: "history" });
    await toPost();
    assert.equal(await active(), "history");
    await app.toPet();
    await app.invoke("open_post_window", { verify: null, tab: "send" });
    await toPost();
    await app.until(
      () => document.querySelector(".post-tab.active")?.dataset.tab === "send",
    );
    // Closed and opened again: where it was left.
    await app.closeWindow("panel");
    await app.invoke("open_post_window", { verify: null, tab: null });
    await toPost();
    assert.equal(await active(), "send");
    await app.click('.post-tab[data-tab="receive"]');
    assert.equal(await active(), "receive");
  },
);

check(
  "post.own-address",
  "the Pet Post tab shows this computer's addresses and port, to add it by address elsewhere",
  async () => {
    const app = ctx.app;
    const status = await app.invoke("post_status");
    assert.ok(status.addresses.length > 0, "no address");
    for (const a of status.addresses)
      assert.match(a.kind, /^(ethernet|wifi|lan|tailscale|virtual)$/);
    await postTab("receive");
    // The likeliest one shown; the others in the list, by kind (local network, Tailscale, virtual).
    await app.waitText(".post-address", `${status.addresses[0].ip}:53317`);
    if (status.addresses.length > 1) {
      await app.click(".post-address-pick");
      const listed = await app.until(() => {
        const l = [
          ...document.querySelectorAll(".post-address-option code"),
        ].map((e) => e.textContent);
        return l.length && l;
      });
      assert.deepEqual(
        [...listed].sort(),
        status.addresses.map((a) => `${a.ip}:53317`).sort(),
      );
      await app.click(".post-address-option:last-child");
      const last = await app.text(".post-address");
      assert.ok(listed.includes(last), last);
    }
    assert.equal(
      await app.b.execute(() => !!document.querySelector(".post-port-moved")),
      false,
    );
    // Where received files go, with Change… right there.
    await app.waitText(".post-save-dir", inbox);
    await app.until(() => !!document.querySelector(".post-change-dir"));
  },
);

check(
  "post.window-receive",
  "with the Pet Post tab open, it asks too: answered there, the pet's question goes; then a sound, and it's in Received",
  async () => {
    const app = ctx.app;
    await app.toPet();
    const since = await app.b.execute(() => Date.now());
    const reply = peer.prepare({ "from-window.txt": "w" });
    await app.waitBubble("Mock Phone wants to send you 1 file");
    await toPost();
    await app.waitText(".post-offer", "Mock Phone wants to send you 1 file");
    await app.waitText(".post-offer-countdown", "if you don't answer");
    await app.click(".post-accept");
    const r = await reply;
    assert.equal(r.status, 200);
    // The pet doesn't ask any more.
    await app.toPet();
    await app.b.waitUntil(
      async () => !/wants to send you/.test((await app.bubble()) ?? ""),
      { timeout: 5000 },
    );
    assert.deepEqual(await peer.upload(r.body), [200]);
    await toPost();
    await app.waitText(".post-incoming", "Got 1 file from Mock Phone!");
    await app.waitText(".post-received-item", "1 file from Mock Phone");
    await app.toPet();
    const played = await app.sounds(since);
    assert.ok(
      played.some((p) => p.kind === "received"),
      JSON.stringify(played),
    );
    const history = await app.invoke("post_history");
    assert.equal(history[0].from, "Mock Phone");
    assert.match(history[0].paths[0], /from-window\.txt$/);
  },
);

check(
  "post.window-hidden",
  "the hidden pet stays hidden while the Pet Post tab is open: the window asks",
  async () => {
    const app = ctx.app;
    await app.run("tray", "Hide pet");
    await app.b.waitUntil(async () => !(await app.visible("pet")), {
      timeout: 5000,
    });
    await app.invoke("open_post_window");
    const reply = peer.prepare({ "while-hidden-2.txt": "h" });
    await toPost();
    await app.waitText(".post-offer", "Mock Phone wants to send you 1 file");
    await new Promise((res) => setTimeout(res, 1500));
    assert.equal(await app.visible("pet"), false);
    await app.click(".post-decline");
    assert.equal((await reply).status, 403);
    await app.until(() => !document.querySelector(".post-offer"));
    await app.invoke("e2e_tray", { id: "show" });
    await app.b.waitUntil(async () => app.visible("pet"), { timeout: 10_000 });
    await app.answer("Done").catch(() => {});
  },
);

check(
  "post.stop-receiving",
  "Stop receiving: what's coming stops, and the sender is told no",
  async () => {
    const app = ctx.app;
    await toPost();
    const reply = peer.prepare({ "stopped.bin": Buffer.alloc(1000, 1) });
    await app.waitText(".post-offer", "Mock Phone wants to send you 1 file");
    await app.click(".post-accept");
    const r = await reply;
    assert.equal(r.status, 200);
    await app.click(".post-stop-receiving");
    await app.waitText(".post-incoming", "Stopped receiving from Mock Phone.");
    assert.deepEqual(await peer.upload(r.body), [403]);
    assert.equal(existsSync(join(inbox, "stopped.bin")), false);
  },
);

check(
  "post.history",
  "Received keeps what came (files and texts) across restarts of the window; Clear empties it",
  async () => {
    const app = ctx.app;
    await app.closeWindow("panel");
    await app.invoke("open_post_window");
    await postTab("history");
    await app.waitText(".post-received-item", "1 file from Mock Phone");
    await app.waitText(".post-received-item", "Dinner at 7?");
    await app.click(".post-clear-history");
    await app.until(() => !document.querySelector(".post-received-item"));
    assert.deepEqual(await app.invoke("post_history"), []);
  },
);

/** The pretend device as the app lists it now. */
const listed = async (fp = peer.fingerprint) =>
  (await ctx.app.invoke("post_devices")).find((d) => d.fingerprint === fp);

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

check(
  "post.verify",
  "Verify in Pet Post shows the same icons (and text) LocalSend shows for these two devices",
  async () => {
    const app = ctx.app;
    assert.equal(ICON_NAMES.length, 260);
    const want = verifyCode(fingerprint, peer.fingerprint);
    await postTab("send");
    await app.b.execute((name) => {
      const row = [...document.querySelectorAll(".post-device")].find((e) =>
        e.textContent.includes(name),
      );
      row.querySelector(".post-verify").click();
    }, "Mock Phone");
    const shown = await app.until(() => {
      const icons = [...document.querySelectorAll(".post-verify-grid svg")].map(
        (e) => e.dataset.icon,
      );
      return icons.length === 16 && icons;
    });
    assert.deepEqual(shown, want.icons);
    await app.waitText(".post-verify-view", "With Mock Phone");
    await app.click(".post-verify-text");
    await app.waitText(".post-verify-code", want.text);
    await app.click(".post-verify-done");
    await app.waitText(".post-device", "Mock Phone");
  },
);

check(
  "post.verify-offer",
  "Verify… in the pet's question opens it in Pet Post, and the question stays",
  async () => {
    const app = ctx.app;
    const reply = peer.prepare({ "v.txt": "v" });
    await app.waitBubble("Mock Phone wants to send you 1 file");
    await app.answer("Verify…");
    await toPost();
    const shown = await app.until(() => {
      const icons = [...document.querySelectorAll(".post-verify-grid svg")].map(
        (e) => e.dataset.icon,
      );
      return icons.length === 16 && icons;
    });
    assert.deepEqual(shown, verifyCode(fingerprint, peer.fingerprint).icons);
    await app.click(".post-verify-done");
    assert.match(await app.bubble(), /Mock Phone wants to send you 1 file/);
    await app.answer("Decline");
    assert.equal((await reply).status, 403);
  },
);

/** Opens Verify for `name` from Send. */
async function verifyFromSend(name) {
  await postTab("send");
  await ctx.app.b.execute((n) => {
    const row = [...document.querySelectorAll(".post-device")].find((e) =>
      e.textContent.includes(n),
    );
    row.querySelector(".post-verify").click();
  }, name);
}

/** The settings as the app has them now. */
const postSettings = async () => (await ctx.app.invoke("get_settings")).post;

check(
  "post.verify-ask",
  "Verify for another ePet: request sent, it shows them, They match → Verified badge",
  async () => {
    const app = ctx.app;
    Object.assign(peer, {
      epet: true,
      verifyAsks: [],
      verifyAnswer: "shown",
      verifyResult: null,
    });
    try {
      await verifyFromSend("Mock Phone");
      await app.waitText(".post-verify-shown", "Mock Phone shows them too");
      assert.equal(peer.verifyAsks.length, 1);
      assert.equal(peer.verifyAsks[0].fingerprint, fingerprint);
      // The Done button stays in sight at the bottom, even in a short window.
      assert.ok(
        await app.b.execute(() => {
          const r = document
            .querySelector(".post-verify-done")
            .getBoundingClientRect();
          return r.bottom <= window.innerHeight && r.top >= 0;
        }),
      );
      // They match: back to the list at once, the badge by its name.
      await app.click(".post-verify-match");
      await app.until(() => !document.querySelector(".post-verify-view"));
      assert.ok(
        (await postSettings()).verified.some(
          (d) => d.fingerprint === peer.fingerprint,
        ),
      );
      await app.until(
        (n) =>
          [...document.querySelectorAll(".post-device")].some(
            (e) =>
              e.textContent.includes(n) && e.querySelector(".post-verified"),
          ),
        ["Mock Phone"],
      );
    } finally {
      peer.epet = false;
    }
  },
);

check(
  "post.verify-declined",
  "the other ePet declines: said so, and nothing is sent to it this time",
  async () => {
    const app = ctx.app;
    Object.assign(peer, {
      epet: true,
      verifyAsks: [],
      verifyAnswer: "declined",
      verifyResult: null,
    });
    try {
      await verifyFromSend("Mock Phone");
      await app.waitText(
        ".post-verify-declined",
        "Mock Phone declined to verify",
      );
      assert.equal(
        await app.b.execute(
          () => !!document.querySelector(".post-verify-match"),
        ),
        false,
      );
      // Not blocked.
      assert.equal((await postSettings()).blocked.length, 0);
      await app.click(".post-verify-done");
    } finally {
      peer.epet = false;
    }
  },
);

check(
  "post.verify-mismatch",
  "its user says they don't match: a warning with Block / Re-check; Block blocks it everywhere",
  async () => {
    const app = ctx.app;
    Object.assign(peer, {
      epet: true,
      verifyAsks: [],
      verifyAnswer: "shown",
      verifyResult: "mismatch",
    });
    try {
      await verifyFromSend("Mock Phone");
      await app.waitText(
        ".post-verify-mismatch",
        "Mock Phone says the icons don't match",
        15_000,
      );
      // Re-check: no longer verified here, and asked again.
      await app.click(".post-verify-recheck");
      await app.until(() => document.querySelector(".post-verify-shown"));
      assert.equal(peer.verifyAsks.length, 2);
      assert.ok(
        !(await postSettings()).verified.some(
          (d) => d.fingerprint === peer.fingerprint,
        ),
      );
      await app.waitText(
        ".post-verify-mismatch",
        "says the icons don't match",
        15_000,
      );
      await app.click(".post-verify-block");
      await app.waitText(".post-verify-confirm", "Block Mock Phone?");
      await app.click(".post-verify-block-yes");
      await app.until(() => !document.querySelector(".post-verify-view"));
      assert.ok(
        (await postSettings()).blocked.some(
          (d) => d.fingerprint === peer.fingerprint,
        ),
      );
      // Not listed, and what it sends is refused (and not asked about).
      assert.equal(await listed(), undefined);
      assert.equal((await peer.prepare({ "blocked.txt": "x" })).status, 403);
      assert.equal((await peer.register()).status, 403);
      // Unblocked (Settings → Pet Post → Blocked devices): found again.
      await app.setSettings((st) => ({
        ...st,
        post: { ...st.post, blocked: [] },
      }));
      await until(
        "unblocked",
        async () => (await postSettings()).blocked.length === 0,
      );
      assert.equal((await peer.register()).status, 200);
      await until("found again after Unblock", () => listed());
    } finally {
      peer.epet = false;
      peer.verifyResult = null;
    }
  },
);

check(
  "post.verify-asked",
  "asked by another ePet: the pet asks (Show / Decline); Show opens Verify there, not asked back; its decision goes back",
  async () => {
    const app = ctx.app;
    Object.assign(peer, {
      epet: true,
      verifyAsks: [],
      verifyAnswer: "shown",
      verifyResult: null,
    });
    try {
      await app.closeWindow("panel");
      await app.toPet();
      const asking = peer.askVerify();
      await app.waitBubble("Mock Phone wants to verify with you.");
      await app.answer("Show");
      const reply = await asking;
      assert.deepEqual([reply.status, reply.body?.answer], [200, "shown"]);
      // Not again straight away.
      assert.equal((await peer.askVerify()).status, 429);
      await toPost();
      const shown = await app
        .until(() => {
          const icons = [
            ...document.querySelectorAll(".post-verify-grid svg"),
          ].map((e) => e.dataset.icon);
          return icons.length === 16 && icons;
        })
        .catch(async (e) => {
          const seen = await app.b.execute(
            () =>
              `${location.hash} | ${document.querySelector("#post")?.innerText.slice(0, 300)}`,
          );
          throw new Error(`${e.message}: ${seen}`);
        });
      assert.deepEqual(shown, verifyCode(fingerprint, peer.fingerprint).icons);
      await app.waitText(
        ".post-verify-asked-by",
        "Mock Phone asked to compare.",
      );
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
  },
);

check(
  "post.recent-senders",
  "Receive → Recent senders lists who sent something lately, with Verify",
  async () => {
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
      const icons = [...document.querySelectorAll(".post-verify-grid svg")].map(
        (e) => e.dataset.icon,
      );
      return icons.length === 16 && icons;
    });
    assert.deepEqual(shown, verifyCode(fingerprint, peer.fingerprint).icons);
    await app.waitText(".post-verify-view", "With Mock Phone");
    await app.click(".post-verify-done");
  },
);

/** Waits until the app sees Mock Phone sharing (or not), asking again meanwhile. */
const sharingSeen = (on) =>
  lookUntil(
    on ? "seen sharing" : "seen not sharing",
    async () => (await listed())?.sharing === on,
  );

check(
  "post.share",
  "a device sharing files by link (LocalSend's Share via link): the pet says so; Receive lists them; the ones chosen are fetched",
  async () => {
    const app = ctx.app;
    peer.share = {
      files: { "shared-photo.jpg": "JPEG!", "shared-notes.txt": "notes" },
      answer: "accept",
    };
    try {
      await app.closeWindow("panel");
      await app.toPet();
      await sharingSeen(true);
      await app.waitBubble("📤 Mock Phone is sharing files with you.");
      await app.answer("See them");
      await toPost();
      await app.waitText(".post-share", "Mock Phone is sharing files with you");
      // Nothing asked of the phone until "See what's shared".
      assert.equal(peer.shareAsks, 0);
      await app.click(".post-share-open");
      await app.until(
        () => document.querySelectorAll(".post-share-files li").length === 2,
      );
      // Only the photo.
      await app.b.execute(() => {
        const li = [...document.querySelectorAll(".post-share-files li")].find(
          (e) => e.textContent.includes("shared-notes.txt"),
        );
        li.querySelector("input").click();
      });
      await app.waitText(".post-share-get", "1 file");
      await app.click(".post-share-get");
      await until("fetched", () => existsSync(join(inbox, "shared-photo.jpg")));
      assert.equal(
        readFileSync(join(inbox, "shared-photo.jpg"), "utf8"),
        "JPEG!",
      );
      assert.equal(existsSync(join(inbox, "shared-notes.txt")), false);
      await until("kept in what was received", async () =>
        (await app.invoke("post_history"))[0]?.paths?.some((p) =>
          p.endsWith("shared-photo.jpg"),
        ),
      );
    } finally {
      peer.share = null;
    }
    await sharingSeen(false);
  },
);

check(
  "post.share-http",
  "a device sharing by link over plain HTTP (Encryption unchecked): still fetched",
  async () => {
    const app = ctx.app;
    await peer.restart(true);
    peer.share = { files: { "plain-file.txt": "plain" }, answer: "accept" };
    try {
      await sharingSeen(true);
      await lookUntil(
        "seen over HTTP",
        async () => (await listed())?.https === false,
      );
      await postTab("receive");
      await app.waitText(".post-share", "Mock Phone is sharing files with you");
      await app.click(".post-share-open");
      await app.until(
        () => document.querySelectorAll(".post-share-files li").length === 1,
      );
      await app.click(".post-share-get");
      await until("fetched over HTTP", () =>
        existsSync(join(inbox, "plain-file.txt")),
      );
      assert.equal(
        readFileSync(join(inbox, "plain-file.txt"), "utf8"),
        "plain",
      );
    } finally {
      peer.share = null;
      await peer.restart(false);
    }
    await sharingSeen(false);
    // Back on HTTPS: known that way again.
    await lookUntil(
      "seen over HTTPS",
      async () => (await listed())?.https === true,
    );
  },
);

check(
  "post.share-pin",
  "a share with a PIN: asked for it; a wrong one is said so",
  async () => {
    const app = ctx.app;
    peer.share = {
      files: { "pin-file.txt": "pin" },
      pin: "4321",
      answer: "accept",
    };
    try {
      await sharingSeen(true);
      await postTab("receive");
      await app.click(".post-share-open");
      await app.until(() => document.querySelector(".post-share-pin"));
      await app.type(".post-share-pin", "1111");
      await app.click(".post-share-pin-go");
      await app.waitText(".post-share", "Wrong PIN.");
      await app.type(".post-share-pin", "4321");
      await app.click(".post-share-pin-go");
      await app.until(
        () => document.querySelectorAll(".post-share-files li").length === 1,
      );
      await app.click(".post-share-close");
    } finally {
      peer.share = null;
    }
    await sharingSeen(false);
  },
);

check(
  "post.share-declined",
  "a share whose user doesn't allow it: said so",
  async () => {
    const app = ctx.app;
    peer.share = { files: { "no.txt": "no" }, answer: "decline" };
    try {
      await sharingSeen(true);
      await postTab("receive");
      await app.click(".post-share-open");
      await app.waitText(".post-share-error", "Mock Phone didn't allow it");
      await app.b.execute(() =>
        [...document.querySelectorAll(".post-share button")]
          .find((b) => b.textContent === "Close")
          .click(),
      );
    } finally {
      peer.share = null;
    }
    await sharingSeen(false);
  },
);

check(
  "post.share-link",
  "Get files from a link: the address LocalSend shows is typed, and its files fetched",
  async () => {
    const app = ctx.app;
    peer.share = { files: { "from-link.txt": "linked" }, answer: "accept" };
    try {
      await postTab("receive");
      await app.click(".post-share-link-open");
      await app.type(".post-share-link-input", "https://127.0.0.1:53318");
      await app.click(".post-share-link-go");
      await app.until(
        () => document.querySelectorAll(".post-share-files li").length === 1,
      );
      await app.click(".post-share-get");
      await until("fetched from the link", () =>
        existsSync(join(inbox, "from-link.txt")),
      );
      assert.equal(
        readFileSync(join(inbox, "from-link.txt"), "utf8"),
        "linked",
      );
    } finally {
      peer.share = null;
    }
    await sharingSeen(false);
  },
);

check(
  "post.collect",
  "an ePet that can't reach this computer leaves a delivery: it's collected (asked about as any delivery, then fetched)",
  async () => {
    const app = ctx.app;
    Object.assign(peer, {
      epet: true,
      pickup: { files: { "collected.txt": "picked up" } },
      pickupAnswers: [],
      pickupAsks: 0,
    });
    try {
      await app.toPet();
      // Seen as an ePet (it says so when asked again): then it's asked for deliveries.
      await lookUntil(
        "seen as an ePet",
        async () => (await listed())?.epet === true,
      );
      await app
        .waitBubble("Mock Phone wants to send you 1 file", 30_000)
        .catch(async (e) => {
          throw new Error(
            `${e.message}; asks ${peer.pickupAsks}, answers ${JSON.stringify(peer.pickupAnswers)}, told ${peer.pickup?.told}, device ${JSON.stringify(await listed())}, bubble ${await app.bubble()}`,
          );
        });
      await app.answer("Accept");
      await until("collected", () => existsSync(join(inbox, "collected.txt")));
      assert.equal(
        readFileSync(join(inbox, "collected.txt"), "utf8"),
        "picked up",
      );
      assert.deepEqual(peer.pickupAnswers, [true]);
    } finally {
      Object.assign(peer, { epet: false, pickup: null });
    }
  },
);

check(
  "post.networks",
  "an extra network in Settings → Pet Post is looked in too",
  async () => {
    const app = ctx.app;
    await app.setSettings((s) => ({
      ...s,
      post: { ...s.post, networks: ["127.0.0.1/32"] },
    }));
    const d = await lookUntil("found in the extra network", async () => {
      const x = await listed();
      return x?.source === "network" && x;
    });
    assert.equal(d.ip, "127.0.0.1");
    assert.equal(d.port, 53318);
    await postTab("send");
    await app.waitText(".post-device", "on another network");
    await app.setSettings((s) => ({ ...s, post: { ...s.post, networks: [] } }));
  },
);

check(
  "post.tailscale",
  "the devices of the Tailscale network are asked (Tailscale pretended); what Tailscale says is shown",
  async () => {
    const app = ctx.app;
    await app.panel("settings");
    await app.invoke("post_refresh");
    await app.waitText(
      ".post-settings .post-tailnet",
      "Tailscale is installed but not signed in.",
      15_000,
    );
    writeFileSync(
      tailnetFile,
      JSON.stringify({
        BackendState: "Running",
        Self: { HostName: "this", TailscaleIPs: ["100.64.0.1"], Online: true },
        Peer: {
          "nodekey:phone": {
            HostName: "mock-phone",
            TailscaleIPs: ["127.0.0.1"],
            Online: true,
          },
          "nodekey:off": {
            HostName: "laptop",
            TailscaleIPs: ["127.0.0.9"],
            Online: false,
          },
        },
      }),
    );
    await lookUntil(
      "listed via Tailscale",
      async () => (await listed())?.source === "tailnet",
    );
    assert.deepEqual(await app.invoke("post_tailnet"), {
      state: "running",
      online: 1,
    });
    await app.panel("settings");
    await app.waitText(
      ".post-settings .post-tailnet",
      "Tailscale: 1 device online, 1 with LocalSend or ePet.",
      15_000,
    );
    await postTab("send");
    await app.waitText(".post-device", "via Tailscale");
    rmSync(tailnetFile);
    await app.invoke("post_refresh");
    await app.panel("settings");
    await app.waitText(
      ".post-settings .post-tailnet",
      "Tailscale isn't installed on this computer.",
      15_000,
    );
  },
);

check(
  "post.favorite",
  "♡ makes a device a favorite (said once, the first time): kept, and what it sends is accepted without asking; ♥ again undoes it",
  async () => {
    const app = ctx.app;
    await postTab("send");
    const row = (inner) =>
      app.b.execute((sel) => {
        const r = [...document.querySelectorAll(".post-device")].find((e) =>
          e.textContent.includes("Mock Phone"),
        );
        r?.querySelector(sel)?.click();
        return !!r?.querySelector(sel);
      }, inner);
    assert.equal(await row(".post-favorite"), true);
    // The first time: what it means, before it's done.
    await app.waitText(".post-favorite-notice", "accepted without asking");
    assert.equal((await app.fullSettings()).post.trusted.length, 0);
    await toPost();
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
    await toPost();
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
    await until(
      "a favorite at once",
      async () => (await app.fullSettings()).post.trusted.length === 1,
    );
    await app.setSettings((x) => ({
      ...x,
      post: { ...x.post, trusted: [], devices: [] },
    }));
  },
);

check(
  "post.add",
  "a device added by address (in Pet Post) is listed and kept in the settings",
  async () => {
    const app = ctx.app;
    await postTab("send");
    await app.click(".post-add-open");
    await app.type(".post-add-address", "127.0.0.1");
    await app.type(".post-add-port", "53318");
    await app.click(".post-add-go");
    await app.waitText(".post-add-state", "Added Mock Phone.", 20_000);
    await app.waitText(".post-device", "added by address");
    const s = await app.fullSettings();
    assert.deepEqual(s.post.devices, [
      {
        address: "127.0.0.1",
        port: 53318,
        fingerprint: peer.fingerprint,
        alias: "Mock Phone",
        deviceType: "mobile",
        via: "address",
      },
    ]);
    const d = await listed();
    assert.equal(d.source, "address");
    assert.equal(d.reached, true);
  },
);

check(
  "post.add-fail",
  "an address where nothing answers: said so, with a word about the firewall",
  async () => {
    const app = ctx.app;
    await toPost();
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
  },
);

check(
  "post.nat",
  "a device reached at an address keeps it when it calls from another (a router it's behind)",
  async () => {
    const r = await peer.register(LOCALSEND_PORT, "127.0.0.2");
    assert.equal(r.status, 200);
    await new Promise((res) => setTimeout(res, 500));
    const d = await listed();
    assert.equal(d.ip, "127.0.0.1");
    assert.equal(d.port, 53318);
  },
);

check(
  "post.offline",
  "a device added by address that stops answering stays listed, as not answering",
  async () => {
    const app = ctx.app;
    await peer.stop();
    await lookUntil(
      "not answering",
      async () => (await listed())?.online === false,
    );
    await postTab("send");
    await app.waitText(".post-device-state", "Not answering.");
  },
);

check(
  "post.identity",
  "another device answering at that address: nothing is sent to it until you say it's yours",
  async () => {
    const app = ctx.app;
    const other = new Peer("Mock Phone", 53318);
    await other.start();
    try {
      await lookUntil(
        "seen as another device",
        async () => (await listed())?.changedTo === other.fingerprint,
      );
      await postTab("send");
      await app.waitText(
        ".post-device-state",
        "Another device answers there now.",
      );
      const sent = await app.b.execute(
        (fp) =>
          window.__TAURI_INTERNALS__
            .invoke("post_send", { to: fp, paths: [], text: "x", pin: null })
            .then(
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
      await toPost();
      await app.until(() => !document.querySelector(".post-trust-new"));
    } finally {
      await other.stop();
      await peer.start();
    }
  },
);

check(
  "post.one-way",
  "a device this computer reaches on another network, that never reached it: Receive says it may not get through",
  async () => {
    const app = ctx.app;
    const shy = new Peer("Shy Phone", await freePort());
    await shy.start();
    try {
      await app.invoke("post_add_device", {
        address: "127.0.0.1",
        port: shy.port,
      });
      await postTab("receive");
      await app.waitText(".post-one-way", "Shy Phone");
      await app.click(".post-one-way-ok");
      await app.until(() => !document.querySelector(".post-one-way"));
      // Once it reaches this computer itself, it isn't one of them.
      assert.equal((await shy.register()).status, 200);
      const d = await until("came in", async () =>
        (await ctx.app.invoke("post_devices")).find(
          (x) => x.fingerprint === shy.fingerprint && x.cameIn,
        ),
      );
      assert.equal(d.reached, true);
    } finally {
      await shy.stop();
    }
  },
);

check(
  "post.door",
  "the router door: no router answering is said so (Try again); one answering NAT-PMP opens it, Close it now closes it; one facing the internet isn't opened until the user says so",
  async () => {
    const app = ctx.app;
    const door = ".post-settings .post-reach-door";
    await router.start();
    try {
      await app.panel("settings");
      await app.waitText(door, "doesn't answer UPnP, NAT-PMP or PCP", 30_000);
      const port = (await app.invoke("post_status")).port;
      router.mode = "natpmp";
      await app.click(".post-settings .post-door-retry");
      await app.waitText(
        door,
        "Open: 192.168.31.178:40000 → this computer (NAT-PMP",
        30_000,
      );
      assert.deepEqual(router.asks, [{ internal: port, lifetime: 3600 }]);
      assert.equal((await app.invoke("post_door")).state, "open");
      await app.click(".post-settings .post-door-close");
      await until("closed", () => router.asks.some((a) => a.lifetime === 0));
      await app.waitText(door, "Off.");
      // Its outside is the internet: not opened by itself.
      router.outside = "203.0.113.7";
      router.asks = [];
      await app.click(".post-settings .post-door");
      await app.waitText(
        door,
        "the router's outside is the internet (203.0.113.7)",
        30_000,
      );
      assert.deepEqual(router.asks, []);
      await app.click(".post-settings .post-door-public");
      await app.waitText(
        ".post-settings .post-door-ask",
        "This door opens to the internet",
      );
      await app.click(".post-settings .post-door-public-yes");
      await app.waitText(door, "Open: 203.0.113.7:40000", 30_000);
      assert.equal((await app.fullSettings()).post.doorPublic, true);
      // Back as it was: a door to the internet only when asked again.
      await app.setSettings((s) => ({
        ...s,
        post: { ...s.post, door: true, doorPublic: false },
      }));
      await until("closed again", () =>
        router.asks.some((a) => a.lifetime === 0),
      );
    } finally {
      router.stop();
    }
  },
);

/** The pretend ePet's row in Pet Post → Send, with Pair (it introduces itself as an ePet). */
async function epetRow() {
  const app = ctx.app;
  await peer.request(LOCALSEND_PORT, "/api/localsend/v2/register", peer.info());
  await postTab("send");
  try {
    await app.until(() =>
      [...document.querySelectorAll(".post-device")].some(
        (e) =>
          e.textContent.includes("Mock Phone") && e.querySelector(".post-pair"),
      ),
    );
  } catch (e) {
    const rows = await app.b.execute(() =>
      [...document.querySelectorAll(".post-device")].map((r) => r.outerHTML),
    );
    const list = await app.invoke("post_devices");
    throw new Error(
      `no Pair by Mock Phone: ${JSON.stringify(rows)} ${JSON.stringify(list)}`,
    );
  }
}

/** Not paired with the pretend ePet (either side), and it's an ePet. */
async function unpaired() {
  const app = ctx.app;
  Object.assign(peer, {
    epet: true,
    pairCode: null,
    pairDecline: false,
    pairAsks: [],
    paired: [],
    pairKey: null,
  });
  await app.setSettings((s) => ({
    ...s,
    post: { ...s.post, paired: [], verified: [] },
  }));
}

check(
  "post.pair",
  "Pair with another ePet: it shows a code, typed here → paired on both sides (🔒 Paired, counts as verified)",
  async () => {
    const app = ctx.app;
    await unpaired();
    try {
      await app.closeWindow("panel");
      await app.invoke("open_post_window", { verify: null, tab: "send" });
      await epetRow();
      await app.b.execute(() =>
        [...document.querySelectorAll(".post-device")]
          .find(
            (e) =>
              e.textContent.includes("Mock Phone") &&
              e.querySelector(".post-pair"),
          )
          .querySelector(".post-pair")
          .click(),
      );
      await app
        .until(() => document.querySelector(".post-pair-code"))
        .catch(async (e) => {
          throw new Error(`${e.message}: ${await app.text(".post-pair-view")}`);
        });
      assert.equal(peer.pairAsks.length, 1);
      assert.equal(peer.pairAsks[0].fingerprint, fingerprint);
      // Typed as shown, with a space.
      const code = peer.pairCode;
      await app.type(".post-pair-code", `${code.slice(0, 3)} ${code.slice(3)}`);
      await app.click(".post-pair-go");
      await app.waitText(".post-pair-done", "Paired with Mock Phone");
      assert.deepEqual(peer.paired, [fingerprint]);
      const post = await postSettings();
      assert.ok(post.paired.some((d) => d.fingerprint === peer.fingerprint));
      assert.ok(post.verified.some((d) => d.fingerprint === peer.fingerprint));
      await app.click(".post-pair-close");
      await app.until(() =>
        [...document.querySelectorAll(".post-device")].some(
          (e) =>
            e.textContent.includes("Mock Phone") &&
            e.querySelector(".post-paired"),
        ),
      );
    } finally {
      peer.epet = false;
    }
  },
);

check(
  "post.pair-wrong",
  "a wrong code ends the pairing (one go per code): said so, nothing paired; Pair again gets a new code",
  async () => {
    const app = ctx.app;
    await unpaired();
    try {
      await epetRow();
      await app.b.execute(() =>
        [...document.querySelectorAll(".post-device")]
          .find(
            (e) =>
              e.textContent.includes("Mock Phone") &&
              e.querySelector(".post-pair"),
          )
          .querySelector(".post-pair")
          .click(),
      );
      await app.until(() => document.querySelector(".post-pair-code"));
      const first = peer.pairCode;
      const wrong = String((Number(first) + 1) % 1e6).padStart(6, "0");
      await app.type(".post-pair-code", wrong);
      await app.click(".post-pair-go");
      await app.waitText(".post-pair-wrong", "The code didn't match");
      assert.deepEqual(peer.paired, []);
      assert.equal((await postSettings()).paired.length, 0);
      await app.click(".post-pair-again");
      await app.until(() => document.querySelector(".post-pair-code"));
      assert.equal(peer.pairAsks.length, 2);
      // Gave up: the code there goes.
      await app.click(".post-pair-cancel");
      await until("cancelled there", async () => peer.pairCode === null);
    } finally {
      peer.epet = false;
    }
  },
);

check(
  "post.pair-asked",
  "another ePet asks to pair: the pet shows the code (Decline); right code → paired here too; wrong → said; declined → told",
  async () => {
    const app = ctx.app;
    await unpaired();
    try {
      await app.closeWindow("panel");
      await app.toPet();
      const shownCode = async () => {
        const text = await until("the code in the bubble", async () => {
          const b = await app.bubble();
          return b?.includes("wants to pair") && b;
        });
        assert.ok(
          text.includes("Mock Phone wants to pair with this computer"),
          text,
        );
        const m = /(\d{3}) (\d{3})/.exec(text);
        return m[1] + m[2];
      };
      // Right code: paired, and said.
      assert.equal((await peer.askPair()).body?.answer, "shown");
      const code = await shownCode();
      assert.equal(await peer.finishPair(code, fingerprint), "paired");
      await app.waitBubble("Paired with Mock Phone.");
      await until("kept", async () =>
        (await postSettings()).paired.some(
          (d) => d.fingerprint === peer.fingerprint,
        ),
      );
      // Wrong code: said.
      await peer.askPair();
      const again = await shownCode();
      const wrong = String((Number(again) + 1) % 1e6).padStart(6, "0");
      assert.equal(await peer.finishPair(wrong, fingerprint), "wrong");
      await app.waitBubble("didn't work: the code didn't match");
      // Declined: told when it types the code.
      await peer.askPair();
      const third = await shownCode();
      await app.answer("Decline");
      assert.equal(await peer.finishPair(third, fingerprint), "declined");
    } finally {
      peer.epet = false;
    }
  },
);

check(
  "post.pair-strict",
  "strict with a paired ePet: another device with its name is warned about and not sent to; a claim to be it without its certificate is refused",
  async () => {
    const app = ctx.app;
    await unpaired();
    await app.setSettings((s) => ({
      ...s,
      post: {
        ...s.post,
        paired: [
          {
            fingerprint: peer.fingerprint,
            alias: "Mock Phone",
            at: Date.now(),
          },
        ],
      },
    }));
    const other = new Peer("Mock Phone", 53319);
    await other.start();
    try {
      // Pretending to be it (its fingerprint, another certificate): refused.
      const files = {
        f: { id: "f", fileName: "x.txt", size: 1, fileType: "text/plain" },
      };
      const claim = { ...other.info(), fingerprint: peer.fingerprint };
      const r = await other.request(
        LOCALSEND_PORT,
        "/api/localsend/v2/prepare-upload",
        { info: claim, files },
      );
      assert.equal(r.status, 403);
      // Its own identity, the same name: listed with a warning, and can't be chosen.
      await app.invoke("post_add_device", {
        address: "127.0.0.1",
        port: 53319,
      });
      await app.invoke("open_post_window", { verify: null, tab: "send" });
      await postTab("send");
      const row = await app.until(() => {
        const rows = [...document.querySelectorAll(".post-device")].filter(
          (e) => e.textContent.includes("Not the Mock Phone you paired with"),
        );
        return (
          rows.length === 1 &&
          rows[0].classList.contains("unavailable") &&
          rows[0].textContent
        );
      });
      assert.ok(row.includes("Pair again"));
    } finally {
      await other.stop();
      await app.setSettings((s) => ({
        ...s,
        post: {
          ...s.post,
          paired: [],
          devices: s.post.devices.filter((d) => d.port !== 53319),
        },
      }));
    }
  },
);

// --- Alarms, to-dos and anniversaries between paired ePets (src-tauri/src/post/invite.rs) ---

/** A calendar file as another ePet writes it (desktoppet-core ics.rs): each item with its ePet data. */
function icsOf(items, offset = -new Date().getTimezoneOffset()) {
  const esc = (s) =>
    s
      .replace(/\\/g, "\\\\")
      .replace(/;/g, "\;")
      .replace(/,/g, "\\,")
      .replace(/\n/g, "\\n");
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//ePet//ePet//EN",
    `X-EPET-OFFSET:${offset}`,
  ];
  for (const { uid, item } of items) {
    const kind = item.type === "todo" ? "VTODO" : "VEVENT";
    lines.push(
      `BEGIN:${kind}`,
      `UID:${esc(uid)}`,
      `SUMMARY:${esc(item.label ?? item.title ?? item.name)}`,
      `X-EPET-DATA:${esc(JSON.stringify(item))}`,
      `END:${kind}`,
    );
  }
  lines.push("END:VCALENDAR");
  return lines.join("\r\n");
}

const plants = (time, label = "Water plants") => ({
  uid: "e2e-plants",
  item: {
    type: "alarm",
    label,
    repeat: "weekdays",
    days: 0,
    time,
    at: null,
    important: true,
    autoSnooze: false,
  },
});

/** Paired with the pretend ePet (as if by a code), known to be one, and its nickname. */
async function pairedWithDad(rules) {
  const app = ctx.app;
  Object.assign(peer, {
    epet: true,
    schedules: [],
    receipts: [],
    scheduleAnswer: "asked",
  });
  await app.setSettings((s) => ({
    ...s,
    post: {
      ...s.post,
      paired: [
        {
          fingerprint: peer.fingerprint,
          alias: "Mock Phone",
          at: Date.now(),
          nick: "Dad",
          ...(rules ? { rules } : {}),
        },
      ],
    },
  }));
  await peer.register();
  await until("an ePet, online", async () =>
    (await app.invoke("post_devices")).some(
      (d) => d.fingerprint === peer.fingerprint && d.epet,
    ),
  );
}

const alarmsNamed = async (label) =>
  (await ctx.app.invoke("list_alarms")).filter((a) => a.label === label);

check(
  "post.schedule-send",
  "📤 on an alarm → Send to… the paired ePet (by its nickname): it gets the calendar file, its answer shows, a receipt from it updates it; Save as .ics…",
  async () => {
    const app = ctx.app;
    await pairedWithDad();
    const at = new Date();
    at.setHours(7, 30, 0, 0);
    const alarm = await app.invoke("add_alarm", {
      label: "Get up, sleepyhead",
      at: at.getTime() + 86_400_000,
      repeat: "weekdays",
      days: null,
      important: true,
    });
    try {
      await app.closeWindow("panel");
      await app.panel("alarms");
      await app.until(
        (id) =>
          [...document.querySelectorAll(".clock-row")].some(
            (r) =>
              r.textContent.includes("Get up, sleepyhead") &&
              r.querySelector(".icon.send"),
          ),
        [alarm.id],
      );
      await app.click(".clock-row .icon.send", "📤");
      // (The row's button: the first one, ours is the only alarm with that name.)
      await app.waitText(".post-send-sheet", "Send “Get up, sleepyhead” to");
      await app.waitText(".post-send-dev", "Dad");
      await app.click(
        `.post-send-dev[data-fingerprint="${peer.fingerprint}"] input`,
      );
      await app.click(".post-send-go");
      await app.waitText(
        ".post-send-answer",
        "Delivered · waiting for an answer",
      );
      assert.equal(peer.schedules.length, 1);
      const sent = peer.schedules[0];
      assert.match(sent, /SUMMARY:Get up\\, sleepyhead/);
      assert.match(sent, /RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR/);
      assert.match(sent, /X-EPET-DATA:/);
      const uid = /^UID:(.*?)\r?$/m.exec(sent)[1];
      // Its user added it: said here.
      assert.equal((await peer.sendReceipt(uid, "added")).status, 204);
      await app.waitText(".post-send-answer", "✓ Added");
      await app.click(".post-send-close");
      // As a file, for phones.
      const file = join(inbox, "alarm.ics");
      await app.invoke("post_schedule_save", {
        kind: "alarm",
        id: alarm.id,
        tz: "Europe/London",
        title: "",
        path: file,
      });
      const text = readFileSync(file, "utf8");
      assert.match(text, /^BEGIN:VCALENDAR/);
      assert.match(text, /BEGIN:VALARM/);
    } finally {
      await app.invoke("delete_alarm", { id: alarm.id });
    }
  },
);

check(
  "post.schedule-receive",
  "a paired ePet sends a reminder: the pet says so; Pet Post → Receive previews it; Add → in Alarms with 👤 its nickname; sent again → already there; changed there → what changed, Update; changed here too → Keep mine",
  async () => {
    const app = ctx.app;
    await pairedWithDad();
    for (const a of await alarmsNamed("Water plants"))
      await app.invoke("delete_alarm", { id: a.id });
    try {
      await app.closeWindow("panel");
      const r = await peer.sendSchedule(icsOf([plants("07:30")]));
      assert.equal(r.status, 200);
      assert.deepEqual(r.body.answers, [
        { uid: "e2e-plants", answer: "asked" },
      ]);
      await app.waitBubble("Dad sent you a reminder: “Water plants”");
      await app.answer("Show");
      await app.toWindow("panel.html");
      await app.waitText(".post-inv-new", "Water plants");
      assert.match(await app.text(".post-inv-new"), /from Dad · Mock Phone/);
      assert.match(await app.text(".post-inv-new"), /Weekdays/);
      await app.click(".post-inv-new .post-inv-take");
      await app.waitText(".post-inv-said", "Added “Water plants”");
      await until("told", async () => peer.receipts.length === 1);
      assert.equal(peer.receipts[0].answer, "added");
      assert.equal(peer.receipts[0].uid, "e2e-plants");
      const [mine] = await alarmsNamed("Water plants");
      assert.equal(mine.timeHm, "07:30");
      assert.equal(mine.repeat, "weekdays");
      assert.equal(mine.important, true);
      // Who it's from, by its row.
      await app.tab("alarms");
      await app.waitText(".clock-row", "👤 Dad");

      // Sent again as it was: nothing to ask.
      const again = await peer.sendSchedule(icsOf([plants("07:30")]));
      assert.equal(again.body.answers[0].answer, "have");
      assert.equal((await alarmsNamed("Water plants")).length, 1);

      // Changed there: what changed, Update.
      const later = await peer.sendSchedule(icsOf([plants("08:00")]));
      assert.equal(later.body.answers[0].answer, "asked");
      await app.tab("post");
      await app.waitText(".post-inv-changed", "Dad updated “Water plants”");
      const eight = await app.clock(new Date().setHours(8, 0, 0, 0));
      assert.ok((await app.text(".post-inv-changed")).includes(eight));
      await app.click(".post-inv-changed .post-inv-take");
      await until(
        "updated",
        async () => (await alarmsNamed("Water plants"))[0]?.timeHm === "08:00",
      );

      // Changed here, then there again: asked which, Keep mine.
      await app.invoke("update_alarm", {
        id: mine.id,
        label: "Water plants!!",
        at: new Date().setHours(8, 5, 0, 0) + 86_400_000,
        repeat: "weekdays",
        days: null,
      });
      await peer.sendSchedule(icsOf([plants("08:15")]));
      await app.waitText(".post-inv-changed.edited", "you changed it too");
      await app.click(".post-inv-changed.edited .post-inv-keep");
      await until("told kept", async () =>
        peer.receipts.some((x) => x.answer === "kept"),
      );
      assert.equal((await alarmsNamed("Water plants!!")).length, 1);
    } finally {
      for (const a of [
        ...(await alarmsNamed("Water plants")),
        ...(await alarmsNamed("Water plants!!")),
      ])
        await app.invoke("delete_alarm", { id: a.id });
    }
  },
);

check(
  "post.schedule-parts",
  "part by part: a new anniversary without one of its reminders (fireworks kept); an update of its date only; a part left out isn't asked about again",
  async () => {
    const app = ctx.app;
    await pairedWithDad();
    const sabrina = (day, preps, effect) => ({
      uid: "e2e-sabrina",
      item: {
        type: "anniversary",
        kind: "birthday",
        icon: "🎂",
        name: "Sabrina",
        month: 9,
        day,
        since: 1986,
        preps,
        effect,
        music: "birthday",
        calendar: "solar",
        leap: false,
        nth: null,
        weekday: null,
      },
    });
    const gift = { lead: "1w", label: "Buy a gift" };
    const cake = { lead: "1d", label: "Order a cake" };
    const mine = async () =>
      (await app.invoke("list_anniversaries")).find(
        (a) => a.name === "Sabrina",
      );
    try {
      await app.closeWindow("panel");
      await app.invoke("open_post_window", { verify: null, tab: "receive" });
      await postTab("receive");
      await peer.sendSchedule(icsOf([sabrina(17, [gift, cake], true)]));
      await app.waitText(".post-inv-new", "Sabrina");
      await app.waitText(".post-inv-allrow", "5 of the 5");
      await app.click('.post-inv-part[data-part="prep:0"] input');
      await app.waitText(".post-inv-allrow", "4 of the 5");
      await app.waitText(".post-inv-new .post-inv-take", "Add selected");
      await app.click(".post-inv-new .post-inv-take");
      await until("added", async () => !!(await mine()));
      let a = await mine();
      assert.deepEqual(a.preps, [cake]);
      assert.equal(a.effect, true);
      assert.equal(a.since, 1986);

      // Its day and reminders changed there: only the day is asked about (the reminders
      // weren't taken), said so.
      await peer.sendSchedule(
        icsOf([sabrina(18, [{ ...cake, lead: "3d" }], true)]),
      );
      await app.waitText(".post-inv-changed", "Sabrina");
      assert.deepEqual(
        await app.b.execute(() =>
          [...document.querySelectorAll(".post-inv-changed tr[data-part]")].map(
            (r) => r.dataset.part,
          ),
        ),
        ["date"],
      );
      await app.waitText(".post-inv-skipped", "Not listed: Before");
      await app.click(".post-inv-changed .post-inv-take");
      await until("moved", async () => (await mine())?.day === 18);
      assert.deepEqual((await mine()).preps, [cake]);

      // Its day and fireworks: only the day taken.
      await peer.sendSchedule(
        icsOf([sabrina(19, [{ ...cake, lead: "3d" }], false)]),
      );
      await app.waitText(".post-inv-changed", "Sabrina");
      await app.click('.post-inv-changed tr[data-part="effect"] input');
      await app.waitText(
        ".post-inv-changed .post-inv-take",
        "Update selected (1)",
      );
      await app.click(".post-inv-changed .post-inv-take");
      await until("moved again", async () => (await mine())?.day === 19);
      a = await mine();
      assert.equal(a.effect, true);
    } finally {
      const a = await mine();
      if (a) await app.invoke("delete_anniversary", { id: a.id });
    }
  },
);

check(
  "post.rename",
  "✎ by a paired ePet in Pet Post → Send: a nickname typed there names it (its own name under it); emptied, its own name again",
  async () => {
    const app = ctx.app;
    await pairedWithDad();
    await app.setSettings((s) => ({
      ...s,
      post: { ...s.post, paired: s.post.paired.map(({ nick, ...d }) => d) },
    }));
    await app.closeWindow("panel");
    await app.invoke("open_post_window", { verify: null, tab: "send" });
    await postTab("send");
    await app.until(() =>
      document.querySelector(".post-device .post-rename-start"),
    );
    await app.click(".post-device .post-rename-start");
    await app.type(".post-rename-input", "Dad", { enter: true });
    await until(
      "named",
      async () => (await postSettings()).paired[0]?.nick === "Dad",
    );
    await app.waitText(".post-device strong", "Dad");
    assert.match(await app.text(".post-device .hint"), /Mock Phone/);
    await app.click(".post-device .post-rename-start");
    await app.type(".post-rename-input", "");
    await app.click(".post-rename-save");
    await until("unnamed", async () => !(await postSettings()).paired[0]?.nick);
    await app.waitText(".post-device strong", "Mock Phone");
  },
);

check(
  "post.schedule-rules",
  "Settings → Pet Post → a paired ePet: its nickname, and what it sends: Add → added at once (the pet says so; Undo deletes it and tells the sender); Don't take → declined",
  async () => {
    const app = ctx.app;
    await pairedWithDad();
    await app.setSettings((s) => ({
      ...s,
      post: { ...s.post, paired: s.post.paired.map(({ nick, ...d }) => d) },
    }));
    await app.closeWindow("panel");
    await app.panel("settings");
    const item = `.post-paired-item[data-fingerprint="${peer.fingerprint}"]`;
    await app.click(`${item} .post-paired-more`);
    await app.type(`${item} .post-paired-nick`, "Dad");
    await app.b.execute(
      (s) => document.querySelector(s).dispatchEvent(new Event("change")),
      `${item} .post-paired-nick`,
    );
    await until(
      "nickname kept",
      async () => (await postSettings()).paired[0]?.nick === "Dad",
    );
    await app.click(`${item} tr[data-kind="todo"] input[value="auto"]`);
    await until(
      "rule kept",
      async () => (await postSettings()).paired[0]?.rules?.todo === "auto",
    );
    await app.click(
      `${item} tr[data-kind="anniversary"] input[value="refuse"]`,
    );
    await until(
      "rule kept",
      async () =>
        (await postSettings()).paired[0]?.rules?.anniversary === "refuse",
    );

    // A to-do: added without asking; Undo.
    const tomorrow = new Date(Date.now() + 86_400_000);
    const day = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, "0")}-${String(tomorrow.getDate()).padStart(2, "0")}`;
    const todo = {
      uid: "e2e-milk",
      item: { type: "todo", title: "Buy milk", at: null, day, repeat: "none" },
    };
    const r = await peer.sendSchedule(icsOf([todo]));
    assert.equal(r.body.answers[0].answer, "added");
    const todos = async () =>
      (await app.invoke("list_todos")).filter((x) => x.title === "Buy milk");
    assert.equal((await todos()).length, 1);
    await app.waitBubble("Dad added a to-do: “Buy milk”");
    await app.answer("Undo");
    await until("undone", async () => (await todos()).length === 0);
    await until("told", async () =>
      peer.receipts.some(
        (x) => x.uid === "e2e-milk" && x.answer === "declined",
      ),
    );

    // An anniversary: not taken.
    const ann = {
      uid: "e2e-ann",
      item: {
        type: "anniversary",
        kind: "birthday",
        icon: "🎂",
        name: "Grandma",
        month: 3,
        day: 12,
        since: 1950,
        preps: [],
        effect: true,
        music: null,
        calendar: "solar",
        leap: false,
        nth: null,
        weekday: null,
      },
    };
    const no = await peer.sendSchedule(icsOf([ann]));
    assert.equal(no.body.answers[0].answer, "declined");
    assert.ok(
      !(await app.invoke("list_anniversaries")).some(
        (a) => a.name === "Grandma",
      ),
    );
  },
);

check(
  "post.schedule-import",
  "a calendar file (.ics, from a phone): Pet Post → Receive → Import… shows each to add: a birthday becomes an anniversary, an appointment an alarm",
  async () => {
    const app = ctx.app;
    const when = new Date(Date.now() + 2 * 86_400_000);
    when.setHours(14, 30, 0, 0);
    const local = (d) =>
      `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}T${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}00`;
    const file = join(inbox, "phone.ics");
    writeFileSync(
      file,
      [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//Phone//EN",
        "BEGIN:VEVENT",
        "UID:bday-aunt",
        "SUMMARY:Aunt May's birthday",
        "DTSTART;VALUE=DATE:19700704",
        "RRULE:FREQ=YEARLY",
        "END:VEVENT",
        "BEGIN:VEVENT",
        "UID:dentist",
        "SUMMARY:Dentist",
        `DTSTART:${local(when)}`,
        "END:VEVENT",
        "END:VCALENDAR",
      ].join("\r\n"),
    );
    await app.closeWindow("panel");
    await app.invoke("open_post_window", { verify: null, tab: "receive" });
    await postTab("receive");
    const r = await app.invoke("post_schedule_import", {
      path: file,
      title: "",
    });
    assert.deepEqual(r, { status: "ok", items: 2, skipped: 0 });
    await app.waitText(".post-inv-new", "Aunt May's birthday");
    await app.waitText(".post-inv-new", "Dentist");
    assert.match(await app.text(".post-inv-new"), /phone\.ics/);
    await app.click(".post-inv-new .post-inv-take");
    await until("an anniversary", async () =>
      (await app.invoke("list_anniversaries")).find(
        (a) => a.name === "Aunt May's birthday",
      ),
    );
    const aunt = (await app.invoke("list_anniversaries")).find(
      (a) => a.name === "Aunt May's birthday",
    );
    assert.deepEqual(
      [aunt.kind, aunt.month, aunt.day, aunt.since],
      ["birthday", 7, 4, 1970],
    );
    await app.click(".post-inv-new .post-inv-keep");
    await app.waitNoText(".post-tab-body", "Dentist");
    await app.invoke("delete_anniversary", { id: aunt.id });
  },
);

check(
  "post.schedule-unpaired",
  "not paired: what another ePet sends is refused (and nothing is sent to it)",
  async () => {
    const app = ctx.app;
    await unpaired();
    peer.schedules = [];
    const r = await peer.sendSchedule(icsOf([plants("07:30")]));
    assert.equal(r.status, 403);
    assert.equal(r.body.answer, "unpaired");
    assert.equal((await alarmsNamed("Water plants")).length, 0);
    peer.epet = false;
  },
);

check("post.off-again", "turned off: it stops listening", async () => {
  const app = ctx.app;
  await app.closeWindow("panel");
  await app.panel("settings");
  await app.click(".post-settings .post-enabled");
  await until(
    "stopped",
    async () => !(await app.invoke("post_status")).running,
  );
  assert.equal(await listening(LOCALSEND_PORT), false);
});

check(
  "post.port-taken",
  "LocalSend's port taken by another app: the next free one, said in Pet Post and Settings",
  async () => {
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
      assert.ok(
        status.port > LOCALSEND_PORT && status.port <= LOCALSEND_PORT + 10,
        `port ${status.port}`,
      );
      assert.equal(await listening(status.port), true);
      await app.waitText(
        ".post-settings .post-state",
        `(port ${status.port}: 53317 is taken by another app)`,
      );
      await app.invoke("open_post_window");
      await postTab("receive");
      await app.waitText(
        ".post-port-moved",
        `so this computer uses ${status.port}`,
      );
      await app.until(
        (p) =>
          [...document.querySelectorAll(".post-address")].every((e) =>
            e.textContent.endsWith(`:${p}`),
          ),
        [status.port],
      );
      await app.closeWindow("panel");
      await app.panel("settings");
      await app.click(".post-settings .post-enabled");
      await until(
        "stopped",
        async () => !(await app.invoke("post_status")).running,
      );
    } finally {
      await new Promise((r) => other.close(r));
    }
  },
);
