import { describe, expect, it } from "vitest";
import { mergeSettings } from "../../platform/types";
import {
  fileCount,
  formatSize,
  addError,
  percentText,
  Rate,
  timeLeft,
  isFavorite,
  withFavorite,
  withoutFavorite,
  missedOfferTitle,
  namesLine,
  parseNetwork,
  sendable,
  sourceLabel,
  tailnetLine,
  type PostDevice,
  offerLines,
  percent,
  postAlias,
  postConfig,
  postSettings,
  transferLine,
  transferOver,
  recentSenders,
  oneWay,
  isBlocked,
  markedName,
  verifiedMark,
  withBlocked,
  withoutBlocked,
  withVerified,
  withoutVerified,
  type PostReceived,
  type PostTransfer,
} from "./post";

const tr = (p: Partial<PostTransfer>): PostTransfer => ({
  direction: "out",
  state: "sending",
  peer: "Pixel",
  fingerprint: "A1",
  done: 0,
  total: 0,
  files: 1,
  folder: null,
  first: null,
  error: null,
  ...p,
});

describe("Pet Post settings", () => {
  it("are off by default, and older settings get the defaults", () => {
    const s = mergeSettings({});
    expect(s.post).toEqual({
      enabled: false,
      alias: "",
      pin: "",
      autoAcceptTrusted: true,
      trusted: [],
      saveDir: "",
      devices: [],
      networks: [],
      tailscale: true,
      favoriteNoticeSeen: false,
      verified: [],
      blocked: [],
    });
    expect(mergeSettings(null).post.enabled).toBe(false);
  });

  it("keep what's valid and drop what isn't", () => {
    const s = postSettings({
      enabled: true,
      alias: "x".repeat(100),
      autoAcceptTrusted: false,
      trusted: [{ fingerprint: "ab12", alias: "Phone" }, { fingerprint: "", alias: "?" }, null as never],
      saveDir: "D:/Inbox",
    });
    expect(s.enabled).toBe(true);
    expect(s.alias.length).toBe(64);
    expect(s.autoAcceptTrusted).toBe(false);
    expect(s.trusted).toEqual([{ fingerprint: "AB12", alias: "Phone" }]);
    expect(s.saveDir).toBe("D:/Inbox");
  });

  it("go to the app with the trusted fingerprints and the name others see", () => {
    const s = postSettings({ enabled: true, trusted: [{ fingerprint: "AA", alias: "a" }] });
    expect(postAlias(s, "Cat", "HOME-PC")).toBe("Cat on HOME-PC");
    expect(postAlias({ ...s, alias: "Desk" }, "Cat", "HOME-PC")).toBe("Desk");
    expect(postConfig(s, "Cat on HOME-PC")).toEqual({
      enabled: true,
      alias: "Cat on HOME-PC",
      pin: "",
      autoAcceptTrusted: true,
      trusted: ["AA"],
      saveDir: "",
      port: 0,
      devices: [],
      networks: [],
      tailscale: true,
      blocked: [],
    });
  });

  it("devices added by address and extra networks: kept when they're right", () => {
    const s = postSettings({
      devices: [
        { address: " 192.168.8.20 ", port: 53317, fingerprint: "ab", alias: "Phone", deviceType: "mobile", via: "favorite" },
        { address: "laptop.tail1234.ts.net", port: 0, fingerprint: "CD", alias: "", deviceType: "desktop" } as never,
        { address: "", port: 1, fingerprint: "EF", alias: "", deviceType: "desktop", via: "address" },
        { address: "x", port: 1, fingerprint: "", alias: "", deviceType: "desktop", via: "address" },
      ],
      networks: ["192.168.8.77/24", "10.0.0.0/8", "nonsense", 5 as never],
      tailscale: false,
    });
    expect(s.devices).toEqual([
      { address: "192.168.8.20", port: 53317, fingerprint: "AB", alias: "Phone", deviceType: "mobile", via: "favorite" },
      { address: "laptop.tail1234.ts.net", port: 53317, fingerprint: "CD", alias: "", deviceType: "desktop", via: "address" },
    ]);
    expect(s.networks).toEqual(["192.168.8.0/24"]);
    expect(s.tailscale).toBe(false);
  });

  it("extra networks as the app reads them (desktoppet-core post::network_hosts)", () => {
    expect(parseNetwork("192.168.8.0/24")).toBe("192.168.8.0/24");
    expect(parseNetwork(" 192.168.8.77 / 24 ")).toBe("192.168.8.0/24");
    expect(parseNetwork("10.0.0.5")).toBe("10.0.0.5");
    expect(parseNetwork("10.0.3.9/22")).toBe("10.0.0.0/22");
    expect(parseNetwork("10.0.0.0/21")).toBeNull();
    expect(parseNetwork("10.0.0.0/33")).toBeNull();
    expect(parseNetwork("192.168.8")).toBeNull();
    expect(parseNetwork("256.1.1.1")).toBeNull();
    expect(parseNetwork("phone.local")).toBeNull();
  });
});

const dev = (p: Partial<PostDevice>): PostDevice => ({
  fingerprint: "AA",
  alias: "Pixel",
  deviceModel: null,
  deviceType: "mobile",
  ip: "192.168.8.20",
  port: 53317,
  https: true,
  lastSeen: 0,
  source: "lan",
  reached: true,
  address: null,
  online: true,
  changedTo: null,
  cameIn: true,
  sharing: false,
  ...p,
});

describe("Pet Post progress: decimals for big deliveries, speed and time left", () => {
  const MB = 1024 * 1024;
  it("the percentage has as many decimals as a big delivery needs, and never says 100 too soon", () => {
    expect(percentText(tr({ done: 37 * MB, total: 99 * MB }))).toBe("37");
    expect(percentText(tr({ done: 374 * MB, total: 1000 * MB }))).toBe("37.4");
    expect(percentText(tr({ done: 3742 * MB, total: 10_000 * MB }))).toBe("37.42");
    expect(percentText(tr({ done: 10_000 * MB - 1, total: 10_000 * MB }))).toBe("99.99");
    expect(percentText(tr({ done: 10_000 * MB, total: 10_000 * MB }))).toBe("100.00");
    expect(percentText(tr({ done: 0, total: 0 }))).toBe("0");
  });

  it("speed over the last seconds, and the time left", () => {
    const r = new Rate();
    const big = tr({ total: 12_000 * MB });
    r.push(0, 0);
    expect(r.speed()).toBeNull();
    r.push(100 * MB, 1000);
    r.push(200 * MB, 2000);
    expect(r.speed()).toBe(100 * MB);
    expect(r.line({ ...big, done: 200 * MB })).toBe("100 MB/s · about 2 min left");
    expect(timeLeft(20)).toBe("less than a minute left");
    expect(timeLeft(150)).toBe("about 3 min left");
    expect(timeLeft(4800)).toBe("about 1 h 20 min left");
    // Another delivery starts: from scratch.
    r.push(0, 3000);
    expect(r.speed()).toBeNull();
  });
});

describe("Pet Post favorites", () => {
  it("a favorite is trusted and kept; no longer one, it's asked again and forgotten (unless added by address)", () => {
    const s = postSettings({});
    const fav = withFavorite(s, { fingerprint: "ab", alias: "Phone", deviceType: "mobile", ip: "192.168.31.237", port: 53317 });
    expect(isFavorite(fav, "AB")).toBe(true);
    expect(fav.trusted).toEqual([{ fingerprint: "AB", alias: "Phone" }]);
    expect(fav.devices).toEqual([{ address: "192.168.31.237", port: 53317, fingerprint: "AB", alias: "Phone", deviceType: "mobile", via: "favorite" }]);
    expect(fav.favoriteNoticeSeen).toBe(true);
    // Twice: no doubles.
    expect(withFavorite(fav, { fingerprint: "AB", alias: "Phone", ip: "192.168.31.237" })).toEqual(fav);
    const off = withoutFavorite(fav, "ab");
    expect(isFavorite(off, "AB")).toBe(false);
    expect(off.devices).toEqual([]);
    // Added by address first: it stays (only its ♥ goes).
    const byAddress = postSettings({ devices: [{ address: "nas.local", port: 53317, fingerprint: "CD", alias: "NAS", deviceType: "desktop", via: "address" }] });
    const both = withFavorite(byAddress, { fingerprint: "CD", alias: "NAS", address: "nas.local" });
    expect(both.devices.length).toBe(1);
    expect(withoutFavorite(both, "CD").devices.length).toBe(1);
  });
});

describe("Pet Post beyond this network", () => {
  it("only devices that answer, as themselves, can be sent to", () => {
    expect(sendable(dev({}))).toBe(true);
    expect(sendable(dev({ online: false }))).toBe(false);
    expect(sendable(dev({ changedTo: "BB" }))).toBe(false);
  });

  it("says where a device was found, and why adding one didn't work", () => {
    expect(sourceLabel(dev({}))).toBe("");
    expect(sourceLabel(dev({ source: "tailnet" }))).toBe("via Tailscale");
    expect(sourceLabel(dev({ source: "address" }))).toBe("added by address");
    expect(sourceLabel(dev({ source: "network" }))).toBe("on another network");
    expect(addError("address")).toMatch(/No device by that name/);
    expect(addError("unreachable")).toMatch(/Couldn't reach it/);
    expect(addError("notPet")).toMatch(/not LocalSend or ePet/);
  });

  it("says what Tailscale says", () => {
    expect(tailnetLine({ state: "missing", online: 0 }, 0)).toBe("Tailscale isn't installed on this computer.");
    expect(tailnetLine({ state: "needsLogin", online: 0 }, 0)).toBe("Tailscale is installed but not signed in.");
    expect(tailnetLine({ state: "running", online: 3 }, 1)).toBe("Tailscale: 3 devices online, 1 with LocalSend or ePet.");
  });
});

describe("Pet Post: what the pet and the window say", () => {
  it("sizes, counts and names", () => {
    expect(formatSize(3)).toBe("3 bytes");
    expect(formatSize(2048)).toBe("2 KB");
    expect(formatSize(1536)).toBe("1.5 KB");
    expect(formatSize(12 * 1024 * 1024)).toBe("12 MB");
    expect(formatSize(5 * 1024 ** 3)).toBe("5 GB");
    expect(fileCount(1)).toBe("1 file");
    expect(fileCount(3)).toBe("3 files");
    expect(namesLine(["Trip/a.jpg", "b.jpg"], 2)).toBe("a.jpg, b.jpg");
    expect(namesLine(["a.jpg", "b.jpg", "c.jpg"], 7)).toBe("a.jpg, b.jpg, c.jpg and 4 more");
  });

  it("an offer", () => {
    const o = { id: "1", alias: "Pixel 8", deviceModel: null, fingerprint: "", files: 2, bytes: 2_500_000, names: ["a.jpg", "b.jpg"], until: 0 };
    expect(offerLines(o)).toEqual(["📦 Pixel 8 wants to send you 2 files (2.4 MB)", "a.jpg, b.jpg"]);
    expect(missedOfferTitle(o)).toBe("Pixel 8: 2 files");
  });

  it("how a delivery goes", () => {
    expect(transferLine(tr({ state: "waiting" }))).toBe("Waiting for Pixel to accept…");
    expect(transferLine(tr({ done: 50, total: 200 }))).toBe("Delivering to Pixel… 25%");
    expect(transferLine(tr({ state: "declined" }))).toBe("Pixel didn't accept it.");
    expect(transferLine(tr({ state: "pin" }))).toBe("Pixel asks for a PIN.");
    expect(transferLine(tr({ direction: "in", state: "done", files: 3 }))).toBe("Got 3 files from Pixel!");
    expect(transferLine(tr({ direction: "in", state: "receiving", done: 1, total: 3 }))).toBe("Receiving from Pixel… 33%");
    expect(percent(tr({ done: 5, total: 0 }))).toBe(0);
    expect(transferOver(tr({ state: "sending" }))).toBe(false);
    expect(transferOver(tr({ state: "busy" }))).toBe(true);
  });
});

describe("recentSenders", () => {
  const r = (id: string, from: string, fingerprint?: string): PostReceived => ({ id, at: 0, from, fingerprint, text: null, files: 1, bytes: 1, paths: [], folder: null });
  it("lists each proven sender once, the latest first, at most n", () => {
    const list = recentSenders([r("5", "Phone", "aa"), r("4", "Old name", "AA"), r("3", "Laptop", "BB"), r("2", "Unproven", ""), r("1", "Before 0.47"), r("0", "Tablet", "CC")], 2);
    expect(list.map((s) => [s.fingerprint, s.alias, s.last.id])).toEqual([
      ["AA", "Phone", "5"],
      ["BB", "Laptop", "3"],
    ]);
    expect(recentSenders([r("1", "Before 0.47")])).toEqual([]);
    expect(recentSenders([r("1", "Tablet", "CC")])[0].deviceType).toBe("desktop");
  });
});

describe("Verified and blocked devices", () => {
  it("They match: verified (a mark); They don't match: blocked, and no longer verified, a favorite or kept", () => {
    let s = postSettings({ trusted: [{ fingerprint: "AA", alias: "Mac" }], devices: [{ address: "10.0.0.2", port: 53317, fingerprint: "AA", alias: "Mac", deviceType: "desktop", via: "favorite" }] });
    s = withVerified(s, { fingerprint: "aa", alias: "Mac" }, 1000);
    expect(verifiedMark(s, "AA")).toEqual({ fingerprint: "AA", alias: "Mac", at: 1000 });
    expect(markedName(s, "Mac", "aa")).toBe("Mac 🛡");
    expect(markedName(s, "Pixel", "BB")).toBe("Pixel");
    expect(postConfig(s, "x").blocked).toEqual([]);
    s = withBlocked(s, { fingerprint: "AA", alias: "Mac" }, 2000);
    expect(verifiedMark(s, "AA")).toBeNull();
    expect(isBlocked(s, "aa")).toBe(true);
    expect([s.trusted, s.devices]).toEqual([[], []]);
    expect(postConfig(s, "x").blocked).toEqual(["AA"]);
    // Verified again: no longer blocked.
    expect(isBlocked(withVerified(s, { fingerprint: "AA", alias: "Mac" }), "AA")).toBe(false);
    expect(withoutBlocked(s, "aa").blocked).toEqual([]);
    expect(withoutVerified(withVerified(s, { fingerprint: "BB", alias: "B" }), "bb").verified).toEqual([]);
    // Kept in the settings as they were, and junk dropped.
    expect(postSettings({ ...s, verified: [{ fingerprint: "cc", alias: "C", at: 5 }, { fingerprint: "", alias: "", at: 0 }] as never }).verified).toEqual([{ fingerprint: "CC", alias: "C", at: 5 }]);
  });
});

describe("oneWay", () => {
  it("lists devices reached on another network that never reached this computer", () => {
    const own = ["192.168.8.192", "100.64.0.5"];
    const phone = dev({ fingerprint: "P", ip: "192.168.31.237", cameIn: false });
    const list = [
      phone,
      dev({ fingerprint: "Q", ip: "192.168.31.20", cameIn: true }),
      dev({ fingerprint: "R", ip: "192.168.8.30", cameIn: false }),
      dev({ fingerprint: "S", ip: "100.70.1.2", source: "tailnet", cameIn: false }),
      dev({ fingerprint: "T", ip: "192.168.31.40", reached: false, cameIn: false }),
      dev({ fingerprint: "U", ip: "192.168.31.41", online: false, cameIn: false }),
    ];
    expect(oneWay(list, own).map((d) => d.fingerprint)).toEqual(["P"]);
  });
});
