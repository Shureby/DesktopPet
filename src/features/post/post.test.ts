import { describe, expect, it } from "vitest";
import { mergeSettings } from "../../platform/types";
import {
  fileCount,
  formatSize,
  addError,
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
  type PostTransfer,
} from "./post";

const tr = (p: Partial<PostTransfer>): PostTransfer => ({
  direction: "out",
  state: "sending",
  peer: "Pixel",
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
    });
  });

  it("devices added by address and extra networks: kept when they're right", () => {
    const s = postSettings({
      devices: [
        { address: " 192.168.8.20 ", port: 53317, fingerprint: "ab", alias: "Phone", deviceType: "mobile" },
        { address: "laptop.tail1234.ts.net", port: 0, fingerprint: "CD", alias: "", deviceType: "desktop" },
        { address: "", port: 1, fingerprint: "EF", alias: "", deviceType: "desktop" },
        { address: "x", port: 1, fingerprint: "", alias: "", deviceType: "desktop" },
      ],
      networks: ["192.168.8.77/24", "10.0.0.0/8", "nonsense", 5 as never],
      tailscale: false,
    });
    expect(s.devices).toEqual([
      { address: "192.168.8.20", port: 53317, fingerprint: "AB", alias: "Phone", deviceType: "mobile" },
      { address: "laptop.tail1234.ts.net", port: 53317, fingerprint: "CD", alias: "", deviceType: "desktop" },
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
  ...p,
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
