/**
 * Sending alarms, to-dos and anniversaries to a paired ePet (docs/INTERACTIONS.md, "Sending
 * reminders and anniversaries"): what's sent (as the app has it: desktoppet-core share.rs),
 * the rules for what each paired ePet sends, nicknames, and the words for how it went.
 */
import { msg, t } from "../../i18n";
import type { DayMask, NewAnniversary, Repeat, TodoRepeat } from "../../platform/types";
import type { MarkedDevice, PostSettings } from "./post";

export type ShareKind = "alarm" | "todo" | "anniversary";

export interface SharedAlarm {
  type: "alarm";
  label: string;
  repeat: Repeat;
  /** The days of a "days" alarm (0 otherwise). */
  days: DayMask;
  /** "HH:MM" for a repeating one: the same clock time wherever it rings. */
  time: string | null;
  /** When a one-off rings (ms). */
  at: number | null;
  important: boolean;
  autoSnooze: boolean;
}

export interface SharedTodo {
  type: "todo";
  title: string;
  /** At a moment (ms)… */
  at: number | null;
  /** …or on a day without a time ("YYYY-MM-DD"). */
  day: string | null;
  repeat: TodoRepeat;
}

export type SharedAnniversary = { type: "anniversary" } & NewAnniversary;

export type SharedItem = SharedAlarm | SharedTodo | SharedAnniversary;

export interface Shared {
  uid: string;
  item: SharedItem;
}

/** What a sent item is to what's here. */
export type ShareMatch =
  | { state: "new" }
  | { state: "same"; id: number }
  /** The sender changed it; `edited`: changed here too since it was taken; `local`: what's here. */
  /**
   * `changed`: the parts the sender changed (see SHARE_PARTS); `skipped`: ones it changed
   * that weren't taken here before (not asked about again).
   */
  | { state: "changed"; id: number; edited: boolean; local: SharedItem; changed: string[]; skipped: string[] };

/** Something sent that waits for an answer (Pet Post → Receive). */
export interface InboxItem {
  id: number;
  /** The sender's fingerprint ("" for a file). */
  from: string;
  /** Its name then (or the file's). */
  name: string;
  shared: Shared;
  /** The sender's time zone (IANA name, "" if unknown) and offset from UTC (minutes). */
  tz: string;
  offset: number | null;
  at: number;
  match: ShareMatch;
  /** An anniversary's next day ("YYYY-MM-DD"). */
  next: string | null;
  /** A one-off whose time has passed: it can't be added. */
  past: boolean;
  /** This computer's offset from UTC (minutes). */
  hereOffset: number;
  /** What a new one has that can be left out: "since", "prep:0"…, "effect", "music"; "important", "autoSnooze". */
  optional: string[];
}

/** Something a paired ePet sent, taken in ("post-schedule"). */
export interface ScheduleTaken {
  /** "asked": waits in the inbox; "added" / "updated": without asking (Undo); "have": already here. */
  what: "asked" | "added" | "updated" | "have";
  fingerprint: string;
  name: string;
  kind: ShareKind;
  title: string;
  id: number | null;
  inbox: number | null;
}

/** Something sent from here, and how it went ("post-schedule-sent"). */
export interface SentItem {
  fingerprint: string;
  kind: ShareKind;
  id: number;
  uid: string;
  answer: string;
  at: number;
}

/** Where something here came from. */
export interface ShareOrigin {
  kind: ShareKind;
  id: number;
  /** The sender's fingerprint ("" for a file). */
  from: string;
}

/** What a paired ePet's items of a kind do here. */
export type ShareRule = "ask" | "auto" | "refuse";
export type ShareRules = Record<ShareKind, ShareRule>;

export const SHARE_KINDS: ShareKind[] = ["alarm", "todo", "anniversary"];
export const DEFAULT_RULES: ShareRules = { alarm: "ask", todo: "ask", anniversary: "ask" };

/** A paired ePet as kept in the settings: its nickname (only seen here) and rules. */
export type PairedDevice = MarkedDevice & { nick?: string; rules?: Partial<ShareRules> };

/** Its rules (asking for whatever isn't set). */
export function rulesOf(post: PostSettings, fingerprint: string): ShareRules {
  const d = paired(post, fingerprint);
  const r = d?.rules ?? {};
  const ok = (v: unknown): v is ShareRule => v === "ask" || v === "auto" || v === "refuse";
  return { alarm: ok(r.alarm) ? r.alarm : "ask", todo: ok(r.todo) ? r.todo : "ask", anniversary: ok(r.anniversary) ? r.anniversary : "ask" };
}

function paired(post: PostSettings, fingerprint: string): PairedDevice | undefined {
  const fp = fingerprint.toUpperCase();
  return (post.paired as PairedDevice[]).find((d) => d.fingerprint === fp);
}

export function withRule(post: PostSettings, fingerprint: string, kind: ShareKind, rule: ShareRule): PostSettings {
  const fp = fingerprint.toUpperCase();
  return {
    ...post,
    paired: (post.paired as PairedDevice[]).map((d) => (d.fingerprint === fp ? { ...d, rules: { ...rulesOf(post, fp), [kind]: rule } } : d)),
  };
}

/** Its nickname, as typed here ("" clears it). */
export function withNick(post: PostSettings, fingerprint: string, nick: string): PostSettings {
  const fp = fingerprint.toUpperCase();
  const name = nick.trim().slice(0, 40);
  return {
    ...post,
    paired: (post.paired as PairedDevice[]).map((d) => {
      if (d.fingerprint !== fp) return d;
      const { nick: _old, ...rest } = d;
      return name ? { ...rest, nick: name } : rest;
    }),
  };
}

export function nickOf(post: PostSettings, fingerprint: string | null | undefined): string {
  return (fingerprint && paired(post, fingerprint)?.nick) || "";
}

/** How a device is called here: its nickname, else its name (as paired, or `fallback`). */
export function deviceName(post: PostSettings, fingerprint: string | null | undefined, fallback = ""): string {
  if (!fingerprint) return fallback;
  const d = paired(post, fingerprint);
  return d?.nick || fallback || d?.alias || "";
}

/** What the app is told: the rules that aren't "ask" everywhere. */
export function shareRulesConfig(post: PostSettings): { fingerprint: string; alarm: ShareRule; todo: ShareRule; anniversary: ShareRule }[] {
  return post.paired
    .map((d) => ({ fingerprint: d.fingerprint, ...rulesOf(post, d.fingerprint) }))
    .filter((r) => r.alarm !== "ask" || r.todo !== "ask" || r.anniversary !== "ask");
}

/** Kept from the settings as saved: a paired device's nickname and rules. */
export function pairedExtras(x: unknown): Pick<PairedDevice, "nick" | "rules"> {
  const o = (x ?? {}) as { nick?: unknown; rules?: unknown };
  const out: Pick<PairedDevice, "nick" | "rules"> = {};
  if (typeof o.nick === "string" && o.nick.trim()) out.nick = o.nick.trim().slice(0, 40);
  if (o.rules && typeof o.rules === "object") {
    const r = o.rules as Record<string, unknown>;
    const rules: Partial<ShareRules> = {};
    for (const k of SHARE_KINDS) if (r[k] === "auto" || r[k] === "refuse" || r[k] === "ask") rules[k] = r[k] as ShareRule;
    if (Object.keys(rules).length) out.rules = rules;
  }
  return out;
}

export function itemTitle(item: SharedItem): string {
  return item.type === "alarm" ? item.label : item.type === "todo" ? item.title : item.name;
}

export function itemIcon(item: SharedItem): string {
  return item.type === "alarm" ? "⏰" : item.type === "todo" ? "☑️" : item.icon || "🎂";
}

/** "a reminder", "a to-do", "an anniversary" (for the pet's words). */
export function kindWord(kind: ShareKind): string {
  return kind === "alarm" ? t("a reminder") : kind === "todo" ? t("a to-do") : t("an anniversary");
}

/** The words for how a send went (to one device). */
export function answerText(answer: string): string {
  const words: Record<string, string> = {
    sending: msg("Sending…"),
    asked: msg("Delivered · waiting for an answer"),
    added: msg("✓ Added"),
    updated: msg("✓ Updated"),
    have: msg("✓ Already has it"),
    kept: msg("Kept their own"),
    declined: msg("Declined"),
    expired: msg("Its time has passed"),
    unreachable: msg("Not online"),
    unsupported: msg("Needs ePet 0.56 or newer"),
    refused: msg("Refused"),
    unpaired: msg("Not paired there: pair again"),
  };
  return t(words[answer] ?? msg("Couldn't send"));
}

/** Whether an answer is a good one (green), still open (grey) or not (red). */
export function answerTone(answer: string): "ok" | "wait" | "no" {
  if (["added", "updated", "have"].includes(answer)) return "ok";
  if (["sending", "asked"].includes(answer)) return "wait";
  return "no";
}

/** The latest answer of each device for an item sent from here. */
export function sentAnswers(list: SentItem[], kind: ShareKind, id: number): Map<string, string> {
  const out = new Map<string, string>();
  for (const s of [...list].sort((a, b) => a.at - b.at)) if (s.kind === kind && s.id === id) out.set(s.fingerprint, s.answer);
  return out;
}

/** "Shanghai" from "Asia/Shanghai" ("" if unknown). */
export function placeOf(tz: string): string {
  const last = tz.split("/").pop() ?? "";
  return last.replace(/_/g, " ");
}

/** This computer's time zone (IANA name), as the system says. */
export function hereZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? "";
  } catch {
    return "";
  }
}

/** "HH:MM" moved by `minutes` (around the clock). */
export function shiftHm(hm: string, minutes: number): string {
  const [h, m] = hm.split(":").map(Number);
  const total = (((h * 60 + m + minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

/**
 * The sender is in another time zone: what that means for this item. A moment (a one-off,
 * a to-do with a time) is already in this computer's time: `theirs` is the sender's clock
 * then (as ms to show in this computer's time). A repeating alarm's clock time can be kept
 * here (`mine`) or the sender's (`theirsHere`). Null when the zones agree, or it's a day.
 */
export type ZoneNote =
  | { kind: "moment"; theirs: number; place: string }
  | { kind: "clock"; mine: string; theirsHere: string; place: string; herePlace: string };

export function zoneNote(e: Pick<InboxItem, "shared" | "offset" | "hereOffset" | "tz">, here = hereZone()): ZoneNote | null {
  if (e.offset === null || e.offset === e.hereOffset) return null;
  const item = e.shared.item;
  const place = placeOf(e.tz);
  const moment = item.type === "alarm" ? (item.time === null ? item.at : null) : item.type === "todo" ? item.at : null;
  if (moment !== null) return { kind: "moment", theirs: moment + (e.offset - e.hereOffset) * 60_000, place };
  if (item.type === "alarm" && item.time) {
    return { kind: "clock", mine: item.time, theirsHere: shiftHm(item.time, e.hereOffset - e.offset), place, herePlace: placeOf(here) };
  }
  return null;
}
