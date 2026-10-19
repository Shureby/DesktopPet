/**
 * Pet Post (docs/INTERACTIONS.md, "Pet Post"): files and text to and from devices on the
 * same network, with the LocalSend protocol (src-tauri/src/post/). Here: the settings,
 * what the app reports, and the words for it.
 */
import { t } from "../../i18n";

export interface TrustedDevice {
  fingerprint: string;
  alias: string;
}

/** A device added by address (behind another router, on Tailscale…), remembered. */
export interface SavedDevice {
  /** An IP address or a host name, as typed. */
  address: string;
  port: number;
  /** Its certificate's when added: another one there is another device. */
  fingerprint: string;
  alias: string;
  deviceType: string;
  /** How it came to be kept: added by address, or made a favorite (♥) when found. */
  via: "address" | "favorite";
}

export const LOCALSEND_PORT = 53317;

/** Settings → Pet Post. */
export interface PostSettings {
  /** Off until turned on: only then does ePet listen on the network. */
  enabled: boolean;
  /** The name other devices see ("": "{pet} on {computer}"). */
  alias: string;
  /** Senders must give it (""): none). */
  pin: string;
  /** Deliveries from a trusted device are taken without asking. */
  autoAcceptTrusted: boolean;
  trusted: TrustedDevice[];
  /** Where received files go ("": Downloads/ePet). */
  saveDir: string;
  /** Devices added by address. */
  devices: SavedDevice[];
  /** Extra networks to look in ("192.168.8.0/24"). */
  networks: string[];
  /** Lists the devices of the Tailscale network, if Tailscale is installed. */
  tailscale: boolean;
  /** Was told once that a favorite's files are accepted without asking. */
  favoriteNoticeSeen: boolean;
  /** Verify: the icons matched on both screens (a mark: shown by its name, nothing more). */
  verified: MarkedDevice[];
  /** Verify: the icons didn't match. Not listed, nothing sent to it, all it asks refused. */
  blocked: MarkedDevice[];
}

/** A device verified or blocked, by its certificate's fingerprint. */
export interface MarkedDevice {
  fingerprint: string;
  alias: string;
  /** When (ms). */
  at: number;
}

export const DEFAULT_POST: PostSettings = {
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
};

/** At most this many addresses in an extra network (a /22). */
export const MAX_NETWORK_HOSTS = 1024;

/**
 * An extra network as typed ("192.168.8.0/24", or one address): written the usual way
 * ("192.168.8.0/24"), or null if it isn't one or is too big (as the app reads it:
 * desktoppet-core post::network_hosts).
 */
export function parseNetwork(text: string): string | null {
  const m = /^\s*(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\s*(?:\/\s*(\d{1,2})\s*)?$/.exec(text);
  if (!m) return null;
  const parts = m.slice(1, 5).map(Number);
  if (parts.some((p) => p > 255)) return null;
  const prefix = m[5] === undefined ? 32 : Number(m[5]);
  if (prefix < 22 || prefix > 32) return null;
  const ip = parts.reduce((a, p) => a * 256 + p, 0);
  const size = 2 ** (32 - prefix);
  const base = ip - (ip % size);
  const dotted = [24, 16, 8, 0].map((sh) => Math.floor(base / 2 ** sh) % 256).join(".");
  return prefix === 32 ? dotted : `${dotted}/${prefix}`;
}

export function postSettings(s: Partial<PostSettings> | undefined): PostSettings {
  const d = DEFAULT_POST;
  const str = (v: unknown, fallback: string) => (typeof v === "string" ? v : fallback);
  return {
    enabled: s?.enabled === true,
    alias: str(s?.alias, d.alias).slice(0, 64),
    pin: str(s?.pin, d.pin).slice(0, 32),
    autoAcceptTrusted: s?.autoAcceptTrusted !== false,
    trusted: Array.isArray(s?.trusted)
      ? s.trusted.filter((x) => x && typeof x.fingerprint === "string" && x.fingerprint).map((x) => ({ fingerprint: x.fingerprint.toUpperCase(), alias: str(x.alias, "") }))
      : [],
    saveDir: str(s?.saveDir, d.saveDir),
    devices: Array.isArray(s?.devices)
      ? s.devices
          .filter((x) => x && typeof x.address === "string" && x.address.trim() && typeof x.fingerprint === "string" && x.fingerprint)
          .map((x) => ({
            address: x.address.trim().slice(0, 253),
            port: Number.isInteger(x.port) && x.port > 0 && x.port < 65536 ? x.port : LOCALSEND_PORT,
            fingerprint: x.fingerprint.toUpperCase(),
            alias: str(x.alias, "").slice(0, 64),
            deviceType: str(x.deviceType, "desktop"),
            via: x.via === "favorite" ? ("favorite" as const) : ("address" as const),
          }))
      : [],
    networks: Array.isArray(s?.networks) ? s.networks.map((n) => (typeof n === "string" ? parseNetwork(n) : null)).filter((n): n is string => !!n) : [],
    tailscale: s?.tailscale !== false,
    favoriteNoticeSeen: s?.favoriteNoticeSeen === true,
    verified: marked(s?.verified),
    blocked: marked(s?.blocked),
  };
}

function marked(list: unknown): MarkedDevice[] {
  if (!Array.isArray(list)) return [];
  return list
    .filter((x) => x && typeof x.fingerprint === "string" && x.fingerprint)
    .map((x) => ({ fingerprint: x.fingerprint.toUpperCase(), alias: typeof x.alias === "string" ? x.alias.slice(0, 64) : "", at: Number.isFinite(x.at) ? x.at : 0 }));
}

/** The record of a device verified (They match), if it is. */
export function verifiedMark(s: PostSettings, fingerprint: string | null | undefined): MarkedDevice | null {
  const fp = fingerprint?.toUpperCase();
  return (fp && s.verified.find((d) => d.fingerprint === fp)) || null;
}

export function isBlocked(s: PostSettings, fingerprint: string | null | undefined): boolean {
  const fp = fingerprint?.toUpperCase();
  return !!fp && s.blocked.some((d) => d.fingerprint === fp);
}

/** They match: verified (and no longer blocked, if it was). */
export function withVerified(s: PostSettings, d: { fingerprint: string; alias: string }, at = Date.now()): PostSettings {
  const fp = d.fingerprint.toUpperCase();
  return { ...s, verified: [...s.verified.filter((x) => x.fingerprint !== fp), { fingerprint: fp, alias: d.alias, at }], blocked: s.blocked.filter((x) => x.fingerprint !== fp) };
}

export function withoutVerified(s: PostSettings, fingerprint: string): PostSettings {
  const fp = fingerprint.toUpperCase();
  return { ...s, verified: s.verified.filter((x) => x.fingerprint !== fp) };
}

/** They don't match: blocked, and no longer verified, a favorite or kept at an address. */
export function withBlocked(s: PostSettings, d: { fingerprint: string; alias: string }, at = Date.now()): PostSettings {
  const fp = d.fingerprint.toUpperCase();
  const rest = withoutFavorite(withoutVerified(s, fp), fp);
  return { ...rest, devices: rest.devices.filter((x) => x.fingerprint !== fp), blocked: [...rest.blocked.filter((x) => x.fingerprint !== fp), { fingerprint: fp, alias: d.alias, at }] };
}

export function withoutBlocked(s: PostSettings, fingerprint: string): PostSettings {
  const fp = fingerprint.toUpperCase();
  return { ...s, blocked: s.blocked.filter((x) => x.fingerprint !== fp) };
}

/** A name in the pet's bubble, with a shield when the device is verified. */
export function markedName(s: PostSettings, name: string, fingerprint: string | null | undefined): string {
  return verifiedMark(s, fingerprint) ? `${name} 🛡` : name;
}

/** A short fingerprint, to tell two devices apart ("8C1E…44A0"). */
export function shortFingerprint(fp: string): string {
  return fp.length > 10 ? `${fp.slice(0, 4)}…${fp.slice(-4)}` : fp;
}

/** A favorite (♥): what's sent from it is accepted without asking (the app's "trusted"). */
export function isFavorite(s: PostSettings, fingerprint: string): boolean {
  return !!fingerprint && s.trusted.some((d) => d.fingerprint === fingerprint.toUpperCase());
}

/**
 * Makes a device a favorite: trusted (its deliveries accepted without asking) and kept, so
 * it's listed and asked at its address even when it isn't found on this network.
 */
export function withFavorite(
  s: PostSettings,
  d: { fingerprint: string; alias: string; deviceType?: string; address?: string | null; ip?: string; port?: number },
): PostSettings {
  const fingerprint = d.fingerprint.toUpperCase();
  const trusted = isFavorite(s, fingerprint) ? s.trusted : [...s.trusted, { fingerprint, alias: d.alias }];
  const address = d.address ?? d.ip;
  const kept = s.devices.some((x) => x.fingerprint === fingerprint) || !address || address === "0.0.0.0";
  const devices = kept
    ? s.devices
    : [...s.devices, { address, port: d.port || LOCALSEND_PORT, fingerprint, alias: d.alias, deviceType: d.deviceType ?? "desktop", via: "favorite" as const }];
  return { ...s, trusted, devices, favoriteNoticeSeen: true };
}

/** No longer a favorite: asked again, and no longer kept unless it was added by address. */
export function withoutFavorite(s: PostSettings, fingerprint: string): PostSettings {
  const fp = fingerprint.toUpperCase();
  return {
    ...s,
    trusted: s.trusted.filter((d) => d.fingerprint !== fp),
    devices: s.devices.filter((d) => !(d.fingerprint === fp && d.via === "favorite")),
  };
}

/** What the app is told (`post_configure`). `port`: 0 for LocalSend's (tests use another). */
export interface PostConfig {
  enabled: boolean;
  alias: string;
  pin: string;
  autoAcceptTrusted: boolean;
  trusted: string[];
  saveDir: string;
  port: number;
  devices: SavedDevice[];
  networks: string[];
  tailscale: boolean;
  blocked: string[];
}

export function postConfig(s: PostSettings, alias: string, port = 0): PostConfig {
  return {
    enabled: s.enabled,
    alias,
    pin: s.pin,
    autoAcceptTrusted: s.autoAcceptTrusted,
    trusted: s.trusted.map((d) => d.fingerprint),
    saveDir: s.saveDir,
    port,
    devices: s.devices,
    networks: s.networks,
    tailscale: s.tailscale,
    blocked: s.blocked.map((d) => d.fingerprint),
  };
}

/** The name others see: as set, or "Cat on HOME-PC". */
export function postAlias(s: PostSettings, pet: string, computer: string): string {
  return s.alias.trim() || t("{pet} on {computer}", { pet, computer });
}

export type DeviceType = "mobile" | "desktop" | "web" | "headless" | "server";

export interface PostDevice {
  fingerprint: string;
  alias: string;
  deviceModel: string | null;
  deviceType: DeviceType;
  ip: string;
  port: number;
  https: boolean;
  lastSeen: number;
  /** How it was found. */
  source: "lan" | "address" | "network" | "tailnet";
  /** We reached it at `ip` (else it only reached us: maybe from behind a router). */
  reached: boolean;
  /** Added by address: that address. */
  address: string | null;
  /** Added by address and not answering now. */
  online: boolean;
  /** Added by address, and another device (this fingerprint) answers there now. */
  changedTo: string | null;
}

/** What Tailscale says ("post-tailnet"). */
export interface PostTailnet {
  /** "" before it was asked (or Tailscale is off in the settings). */
  state: "" | "missing" | "stopped" | "needsLogin" | "running" | "error";
  /** Its devices online now. */
  online: number;
}

/** What both devices show to check they talk to each other (LocalSend's Verify). */
export type PostVerifyAnswer = "shown" | "declined" | "refused" | "busy" | "unsupported" | "unreachable";

export interface PostVerify {
  /** Both fingerprints, sorted and joined. */
  text: string;
  /** 16 numbers into VERIFY_ICONS. */
  icons: number[];
  /** That device asked for it lately (its name): then it isn't asked back. */
  askedBy: string | null;
}

export interface PostStatus {
  running: boolean;
  port: number;
  alias: string;
  fingerprint: string;
  /** Why it isn't running although it's on. */
  error: string | null;
  saveDir: string;
  /** This computer's name. */
  computer: string;
  /** Where others can reach it (with `port`), to add it by address. */
  addresses: { ip: string; name: string; kind: "ethernet" | "wifi" | "lan" | "tailscale" | "virtual" }[];
}

export type TransferState = "waiting" | "receiving" | "sending" | "done" | "declined" | "busy" | "pin" | "tooMany" | "failed" | "cancelled" | "stopped";

export interface PostTransfer {
  direction: "in" | "out";
  state: TransferState;
  peer: string;
  /** Its fingerprint (receiving: "" unless its certificate proves it). */
  fingerprint: string;
  done: number;
  total: number;
  files: number;
  folder: string | null;
  first: string | null;
  error: string | null;
}

/** Someone wants to send files: the pet asks. */
export interface PostOffer {
  id: string;
  alias: string;
  deviceModel: string | null;
  /** Proven by its certificate ("" when not: then it can't be trusted). */
  fingerprint: string;
  files: number;
  bytes: number;
  names: string[];
  /** Declined then if nobody answers (ms). */
  until: number;
}

/** Something received (the Pet Post window's "Received"; kept by the app, the latest first). */
export interface PostReceived {
  id: string;
  at: number;
  from: string;
  /** Its fingerprint, proven by its certificate ("" when not; absent before 0.47). */
  fingerprint?: string;
  deviceModel?: string | null;
  deviceType?: PostDevice["deviceType"];
  /** A text message (else files). */
  text: string | null;
  files: number;
  bytes: number;
  /** Where they were saved (the first 20). */
  paths: string[];
  folder: string | null;
}

export interface PostText {
  alias: string;
  text: string;
}

export const DEVICE_ICONS: Record<DeviceType, string> = { mobile: "📱", desktop: "💻", web: "🌐", headless: "🖥", server: "🗄" };

/** "12 MB", "860 KB", "3 bytes". */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return t("{n} bytes", { n: bytes });
  const units = ["KB", "MB", "GB", "TB"];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1).replace(/\.0$/, "") : Math.round(v)} ${units[i]}`;
}

/** "3 files", "1 file". */
export function fileCount(n: number): string {
  return n === 1 ? t("1 file") : t("{n} files", { n });
}

/** "a.jpg, b.jpg and 3 more" (names as sent: just the file's own name). */
export function namesLine(names: string[], total: number): string {
  const short = names.map((n) => n.split(/[\\/]/).pop() || n);
  const more = total - short.length;
  return more > 0 ? t("{names} and {n} more", { names: short.join(", "), n: more }) : short.join(", ");
}

/** The pet's question: "Phone wants to send you 3 files (12 MB): a.jpg, …". */
export function offerLines(o: PostOffer, who = o.alias): string[] {
  return [
    t("📦 {who} wants to send you {files} ({size})", { who, files: fileCount(o.files), size: formatSize(o.bytes) }),
    namesLine(o.names, o.files),
  ];
}

/** The line for an unanswered delivery in "While I was hidden you missed:". */
export function missedOfferTitle(o: PostOffer): string {
  return t("{who}: {files}", { who: o.alias, files: fileCount(o.files) });
}

export function percent(tr: PostTransfer): number {
  return tr.total > 0 ? Math.min(100, Math.floor((tr.done / tr.total) * 100)) : 0;
}

const MB = 1024 * 1024;

/**
 * How far, said with as many decimals as a big delivery needs to be seen moving: none
 * under 100 MB, one up to 1 GB, two above ("37.42"). Never 100 before it's all there.
 */
export function percentText(tr: PostTransfer): string {
  if (tr.total <= 0) return "0";
  const digits = tr.total < 100 * MB ? 0 : tr.total < 1024 * MB ? 1 : 2;
  const scale = 10 ** digits;
  const value = Math.min(100 * scale - (tr.done < tr.total ? 1 : 0), Math.floor((tr.done * 100 * scale) / tr.total));
  return (Math.max(0, value) / scale).toFixed(digits);
}

/** How fast a delivery goes (bytes a second, over the last few seconds) and how long it has left. */
export class Rate {
  private samples: { at: number; done: number }[] = [];

  constructor(private readonly windowMs = 4000) {}

  /** A new progress report (its bytes so far), at `at` (ms). */
  push(done: number, at = Date.now()): void {
    const last = this.samples[this.samples.length - 1];
    // Started again (another delivery): from scratch.
    if (last && done < last.done) this.samples = [];
    this.samples.push({ at, done });
    while (this.samples.length > 2 && at - this.samples[0].at > this.windowMs) this.samples.shift();
  }

  /** Bytes a second, or null before there's enough to tell. */
  speed(): number | null {
    const first = this.samples[0];
    const last = this.samples[this.samples.length - 1];
    if (!first || !last || last.at - first.at < 500) return null;
    return ((last.done - first.done) * 1000) / (last.at - first.at);
  }

  /** "85 MB/s · about 2 min left" (just the speed until the time left is clear). */
  line(tr: PostTransfer): string {
    const v = this.speed();
    if (v === null || v <= 0) return "";
    const speed = t("{size}/s", { size: formatSize(v) });
    const left = (tr.total - tr.done) / v;
    if (!Number.isFinite(left) || left <= 0) return speed;
    return `${speed} · ${timeLeft(left)}`;
  }
}

/** "about 2 min left", "less than a minute left", "about 1 h 20 min left". */
export function timeLeft(seconds: number): string {
  if (seconds < 60) return t("less than a minute left");
  const min = Math.round(seconds / 60);
  if (min < 60) return t("about {n} min left", { n: min });
  return t("about {h} h {m} min left", { h: Math.floor(min / 60), m: min % 60 });
}

/** One line on how a transfer goes (the pet's bubble and the Pet Post window). */
export function transferLine(tr: PostTransfer, who = tr.peer): string {
  if (tr.direction === "in") {
    switch (tr.state) {
      case "receiving":
        return t("Receiving from {who}… {pct}%", { who, pct: percentText(tr) });
      case "done":
        return t("Got {files} from {who}!", { files: fileCount(tr.files), who });
      case "cancelled":
        return t("{who} stopped sending.", { who });
      case "stopped":
        return t("Stopped receiving from {who}.", { who });
      default:
        return t("Receiving from {who} didn't work.", { who });
    }
  }
  switch (tr.state) {
    case "waiting":
      return t("Waiting for {who} to accept…", { who });
    case "sending":
      return t("Delivering to {who}… {pct}%", { who, pct: percentText(tr) });
    case "done":
      return t("Delivered to {who}!", { who });
    case "declined":
      return t("{who} didn't accept it.", { who });
    case "busy":
      return t("{who} is busy receiving something else. Try again in a moment.", { who });
    case "pin":
      return t("{who} asks for a PIN.", { who });
    case "tooMany":
      return t("Too many wrong PINs. Wait a minute and try again.");
    case "cancelled":
      return t("Delivery cancelled.");
    default:
      return t("Couldn't deliver to {who}.", { who });
  }
}

/** Over (nothing more will come for it). */
export function transferOver(tr: PostTransfer): boolean {
  return !["waiting", "receiving", "sending"].includes(tr.state);
}

/** Where a device was found, for its line in the list ("" for this network). */
export function sourceLabel(d: PostDevice, s?: PostSettings): string {
  // A favorite was found some other way: it's said how.
  if (d.source === "address" && s?.devices.some((x) => x.fingerprint === d.fingerprint && x.via === "favorite")) return "";
  switch (d.source) {
    case "address":
      return t("added by address");
    case "network":
      return t("on another network");
    case "tailnet":
      return t("via Tailscale");
    default:
      return "";
  }
}

/** Can be sent to now (one added by address may not answer, or be another device now). */
export function sendable(d: PostDevice): boolean {
  return d.online && !d.changedTo;
}

/** Why sending didn't start (post_send's error). */
export function sendError(code: string): string {
  switch (code) {
    case "identity":
      return t("Another device answers at that address now. Check it in Pet Post.");
    case "offline":
      return t("That device isn't answering.");
    case "busy":
      return t("I'm still delivering something else.");
    default:
      return t("That device is gone.");
  }
}

/** Why a device couldn't be added by address (post_add_device's error). */
export function addError(code: string): string {
  switch (code) {
    case "off":
      return t("Pet Post is off.");
    case "address":
      return t("No device by that name. Check the address.");
    case "notPet":
      return t("Something answers there, but not LocalSend or ePet.");
    default:
      return t("Couldn't reach it. Is LocalSend (or ePet with Pet Post on) open there, on that port?");
  }
}

/** What Settings → Pet Post says about Tailscale. */
export function tailnetLine(tn: PostTailnet, found: number): string {
  switch (tn.state) {
    case "missing":
      return t("Tailscale isn't installed on this computer.");
    case "stopped":
      return t("Tailscale is installed but not connected.");
    case "needsLogin":
      return t("Tailscale is installed but not signed in.");
    case "error":
      return t("Couldn't ask Tailscale.");
    case "running":
      return tn.online === 1
        ? t("Tailscale: 1 device online, {found} with LocalSend or ePet.", { found })
        : t("Tailscale: {online} devices online, {found} with LocalSend or ePet.", { online: tn.online, found });
    default:
      return t("Looks when you press Look again in Pet Post.");
  }
}

/** Someone who sent something lately (Receive → Recent senders, with Verify). */
export interface RecentSender {
  fingerprint: string;
  alias: string;
  deviceModel: string | null;
  deviceType: PostDevice["deviceType"];
  /** The latest thing they sent. */
  last: PostReceived;
}

/** The last `n` devices that sent something, proven by their certificates (the latest first). */
export function recentSenders(history: PostReceived[], n = 5, blocked: MarkedDevice[] = []): RecentSender[] {
  const out: RecentSender[] = [];
  for (const r of history) {
    const fp = r.fingerprint?.toUpperCase();
    if (!fp || out.some((s) => s.fingerprint === fp) || blocked.some((b) => b.fingerprint === fp)) continue;
    out.push({ fingerprint: fp, alias: r.from, deviceModel: r.deviceModel ?? null, deviceType: r.deviceType ?? "desktop", last: r });
    if (out.length === n) break;
  }
  return out;
}
