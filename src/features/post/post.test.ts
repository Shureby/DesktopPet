import { describe, expect, it } from "vitest";
import { mergeSettings } from "../../platform/types";
import {
  fileCount,
  formatSize,
  missedOfferTitle,
  namesLine,
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
    expect(s.post).toEqual({ enabled: false, alias: "", pin: "", autoAcceptTrusted: true, trusted: [], saveDir: "" });
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
    });
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
    const o = { id: "1", alias: "Pixel 8", deviceModel: null, fingerprint: "", files: 2, bytes: 2_500_000, names: ["a.jpg", "b.jpg"] };
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
