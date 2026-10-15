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
}

export const DEFAULT_POST: PostSettings = { enabled: false, alias: "", pin: "", autoAcceptTrusted: true, trusted: [], saveDir: "" };

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
