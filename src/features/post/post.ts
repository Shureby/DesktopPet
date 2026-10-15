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
          }))
      : [],
    networks: Array.isArray(s?.networks) ? s.networks.map((n) => (typeof n === "string" ? parseNetwork(n) : null)).filter((n): n is string => !!n) : [],
    tailscale: s?.tailscale !== false,
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
export interface PostVerify {
  /** Both fingerprints, sorted and joined. */
  text: string;
  /** 16 numbers into VERIFY_ICONS. */
  icons: number[];
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
  addresses: { ip: string; tailnet: boolean }[];
}

export type TransferState = "waiting" | "receiving" | "sending" | "done" | "declined" | "busy" | "pin" | "tooMany" | "failed" | "cancelled";

export interface PostTransfer {
  direction: "in" | "out";
  state: TransferState;
  peer: string;
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
export function offerLines(o: PostOffer): string[] {
  return [
    t("📦 {who} wants to send you {files} ({size})", { who: o.alias, files: fileCount(o.files), size: formatSize(o.bytes) }),
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

/** One line on how a transfer goes (the pet's bubble and the Pet Post window). */
export function transferLine(tr: PostTransfer): string {
  const who = tr.peer;
  if (tr.direction === "in") {
    switch (tr.state) {
      case "receiving":
        return t("Receiving from {who}… {pct}%", { who, pct: percent(tr) });
      case "done":
        return t("Got {files} from {who}!", { files: fileCount(tr.files), who });
      case "cancelled":
        return t("{who} stopped sending.", { who });
      default:
        return t("Receiving from {who} didn't work.", { who });
    }
  }
  switch (tr.state) {
    case "waiting":
      return t("Waiting for {who} to accept…", { who });
    case "sending":
      return t("Delivering to {who}… {pct}%", { who, pct: percent(tr) });
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
export function sourceLabel(d: PostDevice): string {
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
