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
  /**
   * ePets paired with a code (they count as verified too). Strict with them: only their
   * certificate proves them, only over HTTPS; one with the same name but another
   * certificate is not them.
   */
  paired: MarkedDevice[];
  /** Asks the router in front of this computer to let devices outside it in (UPnP, NAT-PMP, PCP). */
  door: boolean;
  /** ...also when the router's outside is the internet (only once the user said so). */
  doorPublic: boolean;
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
  paired: [],
  door: true,
  doorPublic: false,
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
    paired: marked(s?.paired),
    door: s?.door !== false,
    doorPublic: s?.doorPublic === true,
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

/** The record of an ePet paired with a code, if it is. */
export function pairedMark(s: PostSettings, fingerprint: string | null | undefined): MarkedDevice | null {
  const fp = fingerprint?.toUpperCase();
  return (fp && s.paired.find((d) => d.fingerprint === fp)) || null;
}

/** Paired with a code: paired and verified (and no longer blocked). */
export function withPaired(s: PostSettings, d: { fingerprint: string; alias: string }, at = Date.now()): PostSettings {
  const fp = d.fingerprint.toUpperCase();
  const v = withVerified(s, d, at);
  return { ...v, paired: [...v.paired.filter((x) => x.fingerprint !== fp), { fingerprint: fp, alias: d.alias, at }] };
}

/** Unpaired: no longer paired nor verified (pair again, or Verify, to trust it again). */
export function withoutPaired(s: PostSettings, fingerprint: string): PostSettings {
  const fp = fingerprint.toUpperCase();
  return { ...withoutVerified(s, fp), paired: s.paired.filter((x) => x.fingerprint !== fp) };
}

/**
 * A device that isn't a paired ePet but goes by a paired one's name: someone may be
 * pretending to be it (or it was reinstalled: pair again). The paired one it looks like.
 */
export function lookalikeOf(s: PostSettings, d: { fingerprint: string; alias: string }): MarkedDevice | null {
  if (pairedMark(s, d.fingerprint)) return null;
  const name = d.alias.trim().toLowerCase();
  return (name && s.paired.find((p) => p.alias.trim().toLowerCase() === name)) || null;
}

/** They don't match: blocked, and no longer verified, a favorite or kept at an address. */
export function withBlocked(s: PostSettings, d: { fingerprint: string; alias: string }, at = Date.now()): PostSettings {
  const fp = d.fingerprint.toUpperCase();
  const rest = withoutFavorite(withoutPaired(s, fp), fp);
  return { ...rest, devices: rest.devices.filter((x) => x.fingerprint !== fp), blocked: [...rest.blocked.filter((x) => x.fingerprint !== fp), { fingerprint: fp, alias: d.alias, at }] };
}

export function withoutBlocked(s: PostSettings, fingerprint: string): PostSettings {
  const fp = fingerprint.toUpperCase();
  return { ...s, blocked: s.blocked.filter((x) => x.fingerprint !== fp) };
}

/** A name in the pet's bubble, with a lock when paired, a shield when verified. */
export function markedName(s: PostSettings, name: string, fingerprint: string | null | undefined): string {
  if (pairedMark(s, fingerprint)) return `${name} 🔒`;
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
  paired: string[];
  door: boolean;
  doorPublic: boolean;
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
    paired: s.paired.map((d) => d.fingerprint),
    door: s.door,
    doorPublic: s.doorPublic,
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
  /** It has reached this computer itself (introduced itself, sent something). */
  cameIn: boolean;
  /** It shares files by link (LocalSend's Share via link): this computer can fetch them. */
  sharing: boolean;
  /** It runs ePet (else LocalSend). */
  epet: boolean;
  /** When it last asked for deliveries to collect (0: never): what's sent to it waits for it. */
  collectsAt: number;
}

/** It collects what's sent to it (an ePet that can't be reached: behind another router). */
export function collects(d: PostDevice, now = Date.now()): boolean {
  return d.collectsAt > 0 && now - d.collectsAt < 60_000;
}

/** What a device shares by link (`postShareOpen`). */
export interface PostShareList {
  alias: string;
  /** Proven by its certificate ("" over plain HTTP). */
  fingerprint: string;
  /** Over HTTPS (else plain HTTP: not encrypted). */
  https: boolean;
  files: { id: string; fileName: string; size: number; fileType: string }[];
}

/** Why what a device shares couldn't be had (`postShareOpen`'s error). */
export function shareError(code: string, who: string): string {
  switch (code) {
    case "pin":
      return t("Wrong PIN.");
    case "declined":
      return t("{who} didn't allow it (or didn't answer in time).", { who });
    case "notSharing":
      return t("{who} isn't sharing anything now.", { who });
    case "tooMany":
      return t("Too many tries: wait a minute.");
    case "blocked":
      return t("{who} is blocked (Settings → Pet Post).", { who });
    case "link":
      return t("That isn't a link LocalSend shows (like http://192.168.1.20:53317).");
    case "unreachable":
      return t("Couldn't reach {who}.", { who });
    case "off":
      return t("Pet Post is off.");
    default:
      return t("Getting what {who} shares didn't work.", { who });
  }
}

/**
 * Devices that may be unable to send here: reached by this computer on another network
 * (not one of `own`'s /24s, nor Tailscale), but never reaching it themselves: this
 * computer is probably behind another router (or a firewall), whose way in is closed.
 */
export function oneWay(devices: PostDevice[], own: string[]): PostDevice[] {
  const net = (ip: string) => (/^\d+\.\d+\.\d+\.\d+$/.test(ip) ? ip.split(".").slice(0, 3).join(".") : null);
  const mine = new Set(own.map(net).filter(Boolean));
  return devices.filter((d) => d.reached && d.online && !d.cameIn && d.source !== "tailnet" && !!net(d.ip) && !mine.has(net(d.ip)) && !d.ip.startsWith("100."));
}

/** The router door ("post-door"): the router in front of this computer letting devices outside it in. */
export interface PostDoor {
  /** "off": the setting (or Pet Post) is off; "none": no router answered; "public": its outside is the internet, not opened by itself; "refused": the router said no (`error`). */
  state: "off" | "trying" | "open" | "none" | "public" | "refused";
  via: "upnp" | "natpmp" | "pcp" | null;
  /** The router asked (this computer's gateway). */
  router: string | null;
  /** Where devices outside reach this computer (with `externalPort`); "public": the router's outside address. */
  externalIp: string | null;
  externalPort: number;
  error: string | null;
}

export const DOOR_OFF: PostDoor = { state: "off", via: null, router: null, externalIp: null, externalPort: 0, error: null };

/** One line of "How others reach this computer": ✓ (true), ✗ (false) or neither (null). */
export interface ReachLine {
  kind: "here" | "other" | "fetch" | "door" | "tailscale";
  ok: boolean | null;
  title: string;
  detail: string;
  /** Lines under another (the ways that still work when it can't get in). */
  sub?: boolean;
}

const VIA: Record<NonNullable<PostDoor["via"]>, string> = { upnp: "UPnP", natpmp: "NAT-PMP", pcp: "PCP" };

/**
 * How others reach this computer (Settings → Pet Post): this computer's networks; the
 * networks of devices it reaches beyond them, and whether those got in (else what still
 * works: this computer fetching); the router door; Tailscale.
 */
export function reachLines(status: PostStatus | null, devices: PostDevice[], door: PostDoor, tailnet: PostTailnet, tailscale: boolean): ReachLine[] {
  const net = (ip: string) => (/^\d+\.\d+\.\d+\.\d+$/.test(ip) ? ip.split(".").slice(0, 3).join(".") : null);
  const own = (status?.addresses ?? []).filter((a) => a.kind !== "tailscale" && a.kind !== "virtual");
  const mine = new Set(own.map((a) => net(a.ip)).filter(Boolean));
  const lines: ReachLine[] = [...mine].map((n) => ({ kind: "here", ok: true, title: t("This network ({net})", { net: `${n}.x` }), detail: t("Devices here can send to you directly.") }));
  const router = door.router ? ` (${door.router})` : "";
  // Beyond: devices this computer reached (or that came in) on other networks, by network.
  const others = new Map<string, PostDevice[]>();
  for (const d of devices) {
    const n = net(d.ip);
    if (!n || mine.has(n) || d.source === "tailnet" || d.ip.startsWith("100.") || !(d.reached || d.cameIn)) continue;
    others.set(n, [...(others.get(n) ?? []), d]);
  }
  for (const [n, list] of [...others].sort(([a], [b]) => a.localeCompare(b))) {
    const came = list.find((d) => d.cameIn);
    const title = `${n}.x`;
    if (came) lines.push({ kind: "other", ok: true, title, detail: t("Devices there reach this computer (such as {name}).", { name: came.alias }) });
    else if (door.state === "open") lines.push({ kind: "other", ok: null, title, detail: t("The router's door is open, so devices there should get in. None has yet (such as {name}).", { name: list[0].alias }) });
    else {
      lines.push({
        kind: "other",
        ok: false,
        title: `${title} (${t("such as {name}", { name: list[0].alias })})`,
        detail: t("This computer is behind another router{router}: devices there can't reach it. This computer reaches them, so:", { router }),
      });
      lines.push({ kind: "fetch", ok: true, sub: true, title: t("This computer fetches"), detail: t("when they share by link (LocalSend's Share via link), or when they run ePet (they collect what you send).") });
    }
  }
  const title = t("Router door");
  switch (door.state) {
    case "off":
      lines.push({ kind: "door", ok: null, title, detail: t("Off.") });
      break;
    case "trying":
      lines.push({ kind: "door", ok: null, title, detail: t("Asking the router…") });
      break;
    case "open":
      lines.push({
        kind: "door",
        ok: true,
        title,
        detail: t("Open: {address} → this computer ({via} · renewed every 30 minutes · closed when Pet Post stops)", { address: `${door.externalIp}:${door.externalPort}`, via: door.via ? VIA[door.via] : "" }),
      });
      break;
    case "none":
      lines.push({ kind: "door", ok: false, title, detail: t("The router{router} doesn't answer UPnP, NAT-PMP or PCP (often switched off in it).", { router }) });
      break;
    case "public":
      lines.push({ kind: "door", ok: false, title, detail: t("Not opened by itself: the router's outside is the internet ({ip}).", { ip: door.externalIp ?? "" }) });
      break;
    case "refused":
      lines.push({ kind: "door", ok: false, title, detail: t("The router{router} said no: {error}", { router, error: door.error ?? "" }) });
      break;
  }
  if (tailscale) {
    const ts = "Tailscale";
    if (tailnet.state === "running") lines.push({ kind: "tailscale", ok: true, title: ts, detail: tailnetLine(tailnet, devices.filter((d) => d.source === "tailnet").length) });
    else if (tailnet.state === "missing") lines.push({ kind: "tailscale", ok: null, title: ts, detail: t("Not installed. With it on both, your phone and this computer reach each other on any network.") });
    else if (tailnet.state) lines.push({ kind: "tailscale", ok: null, title: ts, detail: tailnetLine(tailnet, 0) });
  }
  return lines;
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
  /** Sent to a device that collects it: waiting for it to. */
  collect?: boolean;
  done: number;
  total: number;
  files: number;
  folder: string | null;
  first: string | null;
  error: string | null;
  /** Each file and how far it is (all of them when few; else the ones moving, failed, just finished and next), and the counts. */
  items?: PostItem[];
  tally?: PostTally | null;
}

/** One file of a delivery. */
export interface PostItem {
  id: string;
  name: string;
  size: number;
  done: number;
  /** "skipped": the receiver didn't want it. */
  state: "waiting" | "moving" | "done" | "failed" | "skipped";
  /** Sending: where it is on this computer (to send it again). */
  path?: string;
  error?: string;
}

/** How many files of a delivery are where. */
export interface PostTally {
  done: number;
  moving: number;
  waiting: number;
  failed: number;
  skipped: number;
}

/** Asked about before sending: more than this many files, or this much in all. */
export const LARGE_FILES = 100;
export const LARGE_BYTES = 1024 ** 3;

/** A delivery big enough to ask about first (a whole disk dropped by mistake, say). */
export function largeDelivery(m: { files: number; bytes: number }): boolean {
  return m.files > LARGE_FILES || m.bytes >= LARGE_BYTES;
}

/** A file's line: "35%", "✓ Finished", "Waiting", "✗ Failed", "Skipped". */
export function itemStatus(it: PostItem): string {
  switch (it.state) {
    case "moving":
      return `${Math.floor((it.done / Math.max(1, it.size)) * 100)}%`;
    case "done":
      return `✓ ${t("Finished")}`;
    case "failed":
      return `✗ ${t("Failed")}`;
    case "skipped":
      return t("Skipped");
    default:
      return t("Waiting");
  }
}

/** At most this many files listed in the window. */
const ITEMS_SHOWN = 8;

/** The files to list: failed and moving first, then the rest in order, at most ITEMS_SHOWN (in their own order). */
export function shownItems(tr: PostTransfer): PostItem[] {
  const items = tr.items ?? [];
  if (items.length <= ITEMS_SHOWN) return items;
  const rank = (x: PostItem) => (x.state === "failed" ? 0 : x.state === "moving" ? 1 : x.state === "done" ? 2 : 3);
  const pick = new Set(
    items
      .map((x, i) => ({ x, i }))
      .sort((a, b) => rank(a.x) - rank(b.x) || a.i - b.i)
      .slice(0, ITEMS_SHOWN)
      .map((p) => p.i),
  );
  return items.filter((_, i) => pick.has(i));
}

/** Its files are listed: more than one, or one that failed. */
export function listsItems(tr: PostTransfer): boolean {
  const items = tr.items ?? [];
  return items.length > 1 || items.some((x) => x.state === "failed");
}

/** The files not listed (a big delivery). */
export function unlisted(tr: PostTransfer): number {
  const t = tr.tally;
  if (!t) return 0;
  return Math.max(0, t.done + t.moving + t.waiting + t.failed + t.skipped - shownItems(tr).length);
}

/** The counts, when not every file is listed: "✓ 38 finished · 2 sending · 80 waiting". */
export function tallyLine(tr: PostTransfer): string {
  const c = tr.tally;
  if (!c || !unlisted(tr)) return "";
  const moving = tr.direction === "out" ? t("{n} sending", { n: c.moving }) : t("{n} receiving", { n: c.moving });
  return [
    `✓ ${t("{n} finished", { n: c.done })}`,
    c.moving ? moving : "",
    c.waiting ? t("{n} waiting", { n: c.waiting }) : "",
    c.failed ? `✗ ${t("{n} failed", { n: c.failed })}` : "",
    c.skipped ? t("{n} skipped", { n: c.skipped }) : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

/** Some files got there and some didn't: "Delivered 3 of 4 files to X" (else ""). */
export function partialLine(tr: PostTransfer, who = tr.peer): string {
  const c = tr.tally;
  if (!c || !transferOver(tr) || tr.state === "done" || !c.done) return "";
  const of = c.done + c.moving + c.waiting + c.failed;
  return tr.direction === "out" ? t("Delivered {done} of {of} files to {who}.", { done: c.done, of, who }) : t("Got {done} of {of} files from {who}.", { done: c.done, of, who });
}

/** Files of a delivery sent from here that didn't get there (to send again). */
export function retryPaths(tr: PostTransfer): string[] {
  if (tr.direction !== "out" || !transferOver(tr) || tr.state === "done") return [];
  return (tr.items ?? []).filter((x) => (x.state === "failed" || x.state === "waiting") && x.path).map((x) => x.path!);
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
      return tr.collect ? t("Waiting for {who} to collect it…", { who }) : t("Waiting for {who} to accept…", { who });
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
