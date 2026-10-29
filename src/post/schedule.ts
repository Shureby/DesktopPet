/**
 * Sending alarms, to-dos and anniversaries (docs/INTERACTIONS.md, "Sending reminders and
 * anniversaries"): the "Send to…" sheet (from their rows in the main window) and, on Pet
 * Post → Receive, what was sent here to answer: Add or not, an update (what changed), or an
 * update of one changed here too (which one to keep).
 */
import { msg, t } from "../i18n";
import { clock, joinDot, shortDate } from "../i18n/format";
import { formatDay, formatWhen, h } from "../panel/dom";
import { repeatText } from "../panel/alarmText";
import { repeatLabel } from "../features/todo/repeat";
import { daysUntil, leadLabel, musicFor, nextAnniversary, ruleText, untilText } from "../features/anniversary/templates";
import type { PostDevice } from "../features/post/post";
import {
  answerText,
  answerTone,
  deviceName,
  hereZone,
  itemIcon,
  itemTitle,
  nickOf,
  rulesOf,
  sentAnswers,
  withRule,
  zoneNote,
  type InboxItem,
  type SentItem,
  type ShareKind,
  type SharedItem,
} from "../features/post/schedule";
import type { Backend, Settings } from "../platform/types";

/** "HH:MM" today, as ms (to show in this computer's clock style). */
function hmMs(hm: string): number {
  const [hh, mm] = hm.split(":").map(Number);
  const d = new Date();
  d.setHours(hh, mm, 0, 0);
  return d.getTime();
}

/** "YYYY-MM-DD" as that day's local midnight. */
function dayMs(day: string): number {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, m - 1, d).getTime();
}

/** What an item is, line by line ([label, value]), as the preview shows it. */
export function itemRows(item: SharedItem, now = Date.now()): [string, string][] {
  if (item.type === "alarm") {
    const time = item.time ? clock(hmMs(item.time)) : item.at !== null ? formatWhen(item.at, now) : "--:--";
    const rows: [string, string][] = [
      [t("Time"), time],
      [t("Repeat"), repeatText({ repeat: item.repeat, repeatDays: item.days })],
    ];
    const extras = [item.important ? t("Important") : null, item.autoSnooze ? t("Tries again if you don't answer") : null];
    if (extras.some(Boolean)) rows.push([t("Settings"), joinDot(...extras)]);
    return rows;
  }
  if (item.type === "todo") {
    const when = item.at !== null ? formatWhen(item.at, now) : item.day ? formatDay(dayMs(item.day), now) : t("No date");
    const rows: [string, string][] = [[t("When"), when]];
    if (item.repeat !== "none") rows.push([t("Repeat"), repeatLabel(item.repeat)]);
    return rows;
  }
  const on = nextAnniversary(item, now);
  const day = on ? `${shortDate(on.getTime())} (${untilText(daysUntil(on, now)).replace(" 🎉", "")})` : `${item.month}/${item.day}`;
  const rows: [string, string][] = [[t("Date"), joinDot(ruleText(item), day, item.since ? t("since {year}", { year: item.since }) : null)]];
  if (item.preps.length) rows.push([t("Before"), item.preps.map((p) => t("{lead} before: {label}", { lead: leadLabel(p.lead), label: p.label })).join(" · ")]);
  const effect = item.effect ? (item.kind === "remembrance" ? t("Candle and flowers") : t("Fireworks")) : null;
  rows.push([t("On the day"), joinDot(effect, t(musicFor(item).name))]);
  return rows;
}

const PART_LABELS: Record<string, string> = {
  label: msg("Name"),
  title: msg("Name"),
  name: msg("Name"),
  when: msg("Time"),
  date: msg("Date"),
  since: msg("Starting year"),
  preps: msg("Before"),
  effect: msg("On the day"),
  music: msg("Music"),
  important: msg("Important"),
  autoSnooze: msg("Tries again if you don't answer"),
};

const yesNo = (on: boolean) => (on ? t("Yes") : t("No"));

/** One part of an item (desktoppet-core share.rs, `parts`), as [label, value]. */
export function partRow(item: SharedItem, part: string, now = Date.now()): [string, string] {
  const label = t(PART_LABELS[part] ?? part);
  if (item.type === "alarm") {
    if (part === "label") return [label, item.label];
    if (part === "when") {
      const time = item.time ? clock(hmMs(item.time)) : item.at !== null ? formatWhen(item.at, now) : "--:--";
      return [label, joinDot(time, repeatText({ repeat: item.repeat, repeatDays: item.days }))];
    }
    return [label, yesNo(part === "important" ? item.important : item.autoSnooze)];
  }
  if (item.type === "todo") {
    if (part === "title") return [label, item.title];
    const when = item.at !== null ? formatWhen(item.at, now) : item.day ? formatDay(dayMs(item.day), now) : t("No date");
    return [label, joinDot(when, item.repeat === "none" ? null : repeatLabel(item.repeat))];
  }
  if (part === "name") return [label, `${item.icon} ${item.name}`.trim()];
  if (part === "date") {
    const on = nextAnniversary(item, now);
    return [label, joinDot(ruleText(item), on ? shortDate(on.getTime()) : `${item.month}/${item.day}`)];
  }
  if (part === "since") return [label, item.since ? t("since {year}", { year: item.since }) : "—"];
  if (part === "preps") return [label, item.preps.length ? item.preps.map((p) => t("{lead} before: {label}", { lead: leadLabel(p.lead), label: p.label })).join(" · ") : t("None")];
  if (part === "effect") return [label, item.effect ? (item.kind === "remembrance" ? t("Candle and flowers") : t("Fireworks")) : t("Nothing")];
  return [label, t(musicFor(item).name)];
}

/**
 * A new one, part by part: what it is (can't be left out) and what can (`optional`, as the
 * app lists them: "since", "prep:0"…, "effect", "music"; "important", "autoSnooze").
 */
export function newParts(item: SharedItem, optional: string[], now = Date.now()): { part: string | null; label: string; value: string }[] {
  const fixed: { part: string | null; label: string; value: string }[] = [];
  if (item.type === "anniversary") {
    const on = nextAnniversary(item, now);
    const day = on ? `${shortDate(on.getTime())} · ${untilText(daysUntil(on, now)).replace(" 🎉", "")}` : `${item.month}/${item.day}`;
    fixed.push({ part: null, label: t("Name"), value: `${item.icon} ${item.name}`.trim() }, { part: null, label: t("Date"), value: joinDot(ruleText(item), day) });
  } else if (item.type === "alarm") {
    const [time, repeat] = itemRows(item, now);
    fixed.push({ part: null, label: time[0], value: time[1] }, { part: null, label: repeat[0], value: repeat[1] });
  } else fixed.push(...itemRows(item, now).map(([label, value]) => ({ part: null, label, value })));
  let lastLabel = "";
  const parts = optional.map((part) => {
    let label = "";
    let value = "";
    if (item.type === "anniversary") {
      if (part === "since") [label, value] = [t("Starting year"), t("since {year}", { year: item.since ?? 0 })];
      else if (part.startsWith("prep:")) {
        const p = item.preps[Number(part.slice(5))];
        [label, value] = [t("Before"), p ? t("{lead} before: {label}", { lead: leadLabel(p.lead), label: p.label }) : ""];
      } else if (part === "effect") [label, value] = [t("On the day"), item.kind === "remembrance" ? t("Candle and flowers") : t("Fireworks")];
      else if (part === "music") [label, value] = [t("On the day"), t("Music: {name}", { name: t(musicFor(item).name) })];
    } else if (part === "important") [label, value] = [t("Settings"), t("Important (rings during calls and slide shows)")];
    else if (part === "autoSnooze") [label, value] = [t("Settings"), t("Tries again if you don't answer")];
    // The same label as the row above: said once.
    const shown = label === lastLabel ? "" : label;
    lastLabel = label;
    return { part, label: shown, value };
  });
  return [...fixed, ...parts];
}

function kv(rows: [string, string][]): Node {
  return h("div", { class: "post-inv-kv" }, ...rows.flatMap(([k, v]) => [h("span", { class: "k" }, k), h("span", { class: "v" }, v)]));
}

// --- Pet Post → Receive: what waits for an answer -----------------------------------

export interface InboxContext {
  backend: Backend;
  settings(): Settings;
  saved(s: Settings): void;
  render(): void;
}

let inbox: InboxItem[] = [];
/** A repeating alarm from another time zone: at the sender's clock time (by invitation). */
const theirTime = new Map<number, boolean>();
const busy = new Set<number>();
const failed = new Map<number, string>();
/** "From now on, add … without asking", ticked (by invitation). */
const always = new Set<number>();
/** The parts unticked (by invitation): a new one's optional parts, an update's parts. */
const unticked = new Map<number, Set<string>>();
/** An update whose parts not taken before are shown too. */
const showSkipped = new Set<number>();
const off = (id: number) => unticked.get(id) ?? (unticked.set(id, new Set()), unticked.get(id)!);

/** What of it is taken: of a new one, the optional parts kept; of an update, the parts taken (null: all of it). */
function chosenParts(e: InboxItem): string[] | null {
  const no = unticked.get(e.id) ?? new Set<string>();
  if (e.match.state === "changed") {
    const m = e.match;
    const shown = [...m.changed, ...(showSkipped.has(e.id) ? m.skipped : [])];
    return shown.filter((p) => (m.changed.includes(p) ? !no.has(p) : !skippedOff(e, p)));
  }
  return no.size ? e.optional.filter((p) => !no.has(p)) : null;
}

/** A part not taken before, shown again: unticked until ticked. */
function skippedOff(e: InboxItem, p: string): boolean {
  return !(ticked.get(e.id)?.has(p) ?? false);
}
/** Parts not taken before that were ticked this time. */
const ticked = new Map<number, Set<string>>();
/** What the last answer did, said for a moment. */
let said = "";
let saidTimer: ReturnType<typeof setTimeout> | undefined;

export async function loadInbox(ctx: InboxContext): Promise<void> {
  inbox = await ctx.backend.postScheduleInbox().catch(() => inbox);
  ctx.render();
}

export function inboxCount(): number {
  return inbox.length;
}

function say(ctx: InboxContext, text: string): void {
  said = text;
  clearTimeout(saidTimer);
  saidTimer = setTimeout(() => {
    said = "";
    ctx.render();
  }, 5000);
}

async function answer(ctx: InboxContext, e: InboxItem, take: boolean): Promise<void> {
  busy.add(e.id);
  failed.delete(e.id);
  ctx.render();
  try {
    if (take && always.has(e.id) && e.from) {
      const cur = await ctx.backend.getSettings();
      ctx.saved(await ctx.backend.setSettings({ post: withRule(cur.post, e.from, e.shared.item.type, "auto") }));
    }
    const result = await ctx.backend.postScheduleAnswer(
      e.id,
      take,
      e.match.state === "new" || e.match.state === "changed" ? (theirTime.get(e.id) ?? null) : null,
      take ? chosenParts(e) : null,
    );
    inbox = inbox.filter((x) => x.id !== e.id);
    const title = itemTitle(e.shared.item);
    const words: Record<string, string> = {
      added: t("✓ Added “{title}”.", { title }),
      updated: t("✓ Updated “{title}”.", { title }),
      have: t("You already have “{title}”.", { title }),
      kept: t("Kept your “{title}”.", { title }),
    };
    if (words[result]) say(ctx, words[result]);
  } catch (err) {
    failed.set(e.id, String(err).includes("passed") ? t("Its time has passed: it can't be added.") : t("Couldn't add it: {error}", { error: String(err) }));
  }
  busy.delete(e.id);
  ctx.render();
}

/** "from Dad · Will's Rooster", or the file it's from. */
function fromLine(ctx: InboxContext, e: InboxItem): Node {
  if (!e.from) return h("span", { class: "hint post-inv-from" }, `📄 ${e.name}`);
  const post = ctx.settings().post;
  const nick = nickOf(post, e.from);
  return h("span", { class: "hint post-inv-from" }, t("from {who}", { who: nick || e.name }), nick ? ` · ${e.name}` : "");
}

function zoneLine(e: InboxItem): Node | null {
  const z = zoneNote(e);
  if (!z) return null;
  if (z.kind === "moment") {
    const time = z.place ? `${formatWhen(z.theirs)} (${z.place})` : formatWhen(z.theirs);
    return h("p", { class: "post-inv-zone" }, `🌐 ${t("Their time: {time}. Shown here in your time.", { time })}`);
  }
  const theirs = theirTime.get(e.id) === true;
  const choice = (on: boolean, text: string) =>
    h("button", { class: `small${on === theirs ? " on" : ""}`, "aria-pressed": String(on === theirs), onclick: () => (theirTime.set(e.id, on), redrawLater()) }, text);
  return h(
    "div",
    { class: "post-inv-zone" },
    h("p", {}, `🌐 ${t("You're in different time zones. Ring at whose time?")}`),
    h(
      "div",
      { class: "seg" },
      choice(false, t("Mine: {time}", { time: z.herePlace ? `${clock(hmMs(z.mine))} (${z.herePlace})` : clock(hmMs(z.mine)) })),
      choice(true, t("Theirs: {time} = {here} here", { time: clock(hmMs(z.mine)), here: clock(hmMs(z.theirsHere)) })),
    ),
  );
}

/** Set by inboxCards: a re-render after a choice in a card. */
let redrawLater: () => void = () => {};

function kindRuleLabel(kind: ShareKind, who: string): string {
  return kind === "alarm"
    ? t("From now on, add {who}'s reminders without asking", { who })
    : kind === "todo"
      ? t("From now on, add {who}'s to-dos without asking", { who })
      : t("From now on, add {who}'s anniversaries without asking", { who });
}

function card(ctx: InboxContext, e: InboxItem): Node {
  const item = e.shared.item;
  const post = ctx.settings().post;
  const who = e.from ? deviceName(post, e.from, e.name) : e.name;
  const title = itemTitle(item);
  const working = busy.has(e.id);
  const error = failed.get(e.id);
  const m = e.match;
  const button = (cls: string, text: string, take: boolean, disabled = false) =>
    h("button", { class: cls, disabled: working || disabled, onclick: () => void answer(ctx, e, take) }, text);
  if (m.state === "changed") {
    const head = m.edited ? t("{who} updated “{title}” · you changed it too", { who, title }) : t("{who} updated “{title}”", { who, title });
    const shown = [...m.changed, ...(showSkipped.has(e.id) ? m.skipped : [])];
    const isOn = (p: string) => (m.changed.includes(p) ? !off(e.id).has(p) : !skippedOff(e, p));
    const toggle = (p: string, on: boolean) => {
      if (m.changed.includes(p)) {
        if (on) off(e.id).delete(p);
        else off(e.id).add(p);
      } else {
        const set = ticked.get(e.id) ?? new Set<string>();
        if (on) set.add(p);
        else set.delete(p);
        ticked.set(e.id, set);
      }
      redrawLater();
    };
    const count = shown.filter(isOn).length;
    const all = count === shown.length;
    const rows = shown.map((p) => {
      const [label, here] = partRow(m.local, p);
      const [, sent] = partRow(item, p);
      return h(
        "tr",
        { class: isOn(p) ? "" : "off", "data-part": p },
        h(
          "td",
          { class: "c" },
          h("input", { type: "checkbox", checked: isOn(p), "aria-label": label, onchange: (ev: Event) => toggle(p, (ev.target as HTMLInputElement).checked) }),
        ),
        h("td", {}, label),
        h("td", { class: m.edited ? "mine" : "old" }, here),
        h("td", { class: "new" }, sent),
      );
    });
    const takeLabel = all ? (m.edited ? t("Use the new one") : t("Update")) : t("Update selected ({n})", { n: count });
    return h(
      "div",
      { class: `box post-inv post-inv-changed${m.edited ? " edited" : ""}`, "data-id": String(e.id) },
      h("div", { class: "row" }, h("p", { class: "title grow" }, `🔄 ${head}`)),
      fromLine(ctx, e),
      h(
        "table",
        { class: "post-inv-diff" },
        h("tr", {}, h("th", { class: "c" }), h("th", {}), h("th", {}, m.edited ? t("Yours") : t("Now")), h("th", {}, m.edited ? t("Their new one") : t("Updated"))),
        ...rows,
      ),
      m.skipped.length && !showSkipped.has(e.id)
        ? h(
            "p",
            { class: "hint post-inv-skipped" },
            t("Not listed: {parts}. You didn't take it before, so it stays as yours.", { parts: m.skipped.map((p) => t(PART_LABELS[p] ?? p)).join(t(", ")) }),
            " ",
            h("a", { href: "#", class: "post-inv-show-skipped", onclick: (ev: Event) => (ev.preventDefault(), showSkipped.add(e.id), redrawLater()) }, t("Show it too")),
          )
        : null,
      zoneLine(e),
      error ? h("p", { class: "warning" }, error) : null,
      m.edited
        ? h("div", { class: "row" }, button("post-inv-take", takeLabel, true, count === 0), button("primary post-inv-keep", t("Keep mine"), false))
        : h("div", { class: "row" }, button("primary post-inv-take", takeLabel, true, count === 0), button("post-inv-keep", t("Don't"), false)),
      m.edited ? h("p", { class: "hint" }, t("You changed this one: even when {who}'s are added without asking, you're asked.", { who })) : null,
    );
  }
  const same = m.state === "same";
  // Part by part, when something of it can be left out.
  const choosing = !same && !e.past && e.optional.length > 0;
  const no = off(e.id);
  const kept = e.optional.filter((p) => !no.has(p)).length;
  const setAll = (on: boolean) => {
    no.clear();
    if (!on) for (const p of e.optional) no.add(p);
    redrawLater();
  };
  const allBox = h("input", { type: "checkbox", class: "post-inv-all", checked: kept === e.optional.length, onchange: (ev: Event) => setAll((ev.target as HTMLInputElement).checked) });
  allBox.indeterminate = kept > 0 && kept < e.optional.length;
  const partList = choosing
    ? h(
        "div",
        { class: "post-inv-parts" },
        h("label", { class: "post-inv-allrow" }, allBox, t("All"), h("span", { class: "grow" }), t("{n} of the {m} that can be left out", { n: kept, m: e.optional.length })),
        ...newParts(item, e.optional).map((r) =>
          h(
            "label",
            { class: `post-inv-part${r.part === null ? " lock" : no.has(r.part) ? " off" : ""}`, ...(r.part ? { "data-part": r.part } : {}) },
            h("input", {
              type: "checkbox",
              checked: r.part === null || !no.has(r.part),
              disabled: r.part === null,
              onchange: (ev: Event) => {
                if ((ev.target as HTMLInputElement).checked) no.delete(r.part!);
                else no.add(r.part!);
                redrawLater();
              },
            }),
            h("span", { class: "k" }, r.label),
            h("span", { class: "v" }, r.value, r.part === null ? h("span", { class: "lockt" }, ` ${t("(needed)")}`) : null),
          ),
        ),
      )
    : kv(itemRows(item));
  return h(
    "div",
    { class: "box post-inv post-inv-new", "data-id": String(e.id) },
    h("div", { class: "row" }, h("p", { class: "title grow" }, `${itemIcon(item)} ${title}`)),
    fromLine(ctx, e),
    partList,
    choosing && kept < e.optional.length ? h("p", { class: "hint" }, t("What you leave out is as if it weren't set (no fireworks, no to-dos before it, its type's own music). You can change it after.")) : null,
    zoneLine(e),
    e.past ? h("p", { class: "warning" }, t("Its time has passed: it can't be added.")) : null,
    same ? h("p", { class: "hint" }, t("You already have it.")) : null,
    error ? h("p", { class: "warning" }, error) : null,
    same
      ? h("div", { class: "row" }, button("primary post-inv-take", t("OK"), true))
      : h(
          "div",
          { class: "row" },
          button("primary post-inv-take", choosing && kept < e.optional.length ? t("Add selected") : t("Add|invitation"), true, e.past),
          button("post-inv-keep", t("Don't add"), false),
        ),
    !same && e.from && !e.past
      ? h(
          "label",
          { class: "check hint post-inv-always" },
          h("input", {
            type: "checkbox",
            checked: always.has(e.id) || rulesOf(post, e.from)[item.type] === "auto",
            onchange: (ev: Event) => ((ev.target as HTMLInputElement).checked ? always.add(e.id) : always.delete(e.id)),
          }),
          kindRuleLabel(item.type, who),
        )
      : null,
  );
}

/** Pet Post → Receive: what was sent here to answer (and what the last answer did). */
export function inboxCards(ctx: InboxContext): Node[] {
  redrawLater = () => ctx.render();
  const out: Node[] = inbox.map((e) => card(ctx, e));
  if (said) out.unshift(h("p", { class: "post-inv-said" }, said));
  return out;
}

/** "Import calendar file…" (Pet Post → Receive): what's in it comes here to answer. */
export async function importCalendar(ctx: InboxContext, path: string | null = null): Promise<void> {
  const r = await ctx.backend.postScheduleImport(path, t("Import a calendar file")).catch(() => null);
  if (!r || r.status === "cancelled") return;
  if (r.status === "notCalendar") say(ctx, t("That isn't a calendar file (.ics)."));
  else if (r.items === 0) say(ctx, r.skipped ? t("Nothing in it to add (past or not a reminder).") : t("You already have all of it."));
  else say(ctx, t("{n} to answer below.", { n: r.items }));
  await loadInbox(ctx);
}

// --- "Send to…" (a row's 📤 in the main window) --------------------------------------

export interface SendSheet {
  backend: Backend;
  settings: Settings;
  kind: ShareKind;
  id: number;
  title: string;
  /** Pet Post → its settings (no paired ePet yet, or it's off). */
  openPost(): void;
}

/** Picks paired ePets to send an alarm, to-do or anniversary to, and says how it went. */
export async function openSendSheet(o: SendSheet): Promise<void> {
  const b = o.backend;
  const post = o.settings.post;
  const devices: PostDevice[] = post.enabled ? await b.postDevices().catch(() => []) : [];
  let sent: SentItem[] = await b.postScheduleSent().catch(() => []);
  const chosen = new Set<string>();
  let sending = false;
  let note = "";
  const box = h("div", { class: "ask post-send-sheet", role: "dialog", "aria-modal": "true" });
  const overlay = h("div", { class: "ask-overlay", onclick: (e: Event) => e.target === overlay && close() }, box);
  let unlisten: (() => void) | null = null;
  const close = () => {
    overlay.remove();
    document.removeEventListener("keydown", onKey);
    unlisten?.();
  };
  const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
  const paint = () => {
    const answers = sentAnswers(sent, o.kind, o.id);
    const rows = post.paired.map((d) => {
      const online = devices.some((x) => x.fingerprint === d.fingerprint && x.online !== false && x.epet);
      const answer = answers.get(d.fingerprint);
      const nick = nickOf(post, d.fingerprint);
      return h(
        "label",
        { class: "post-send-dev", "data-fingerprint": d.fingerprint },
        h("input", {
          type: "checkbox",
          checked: chosen.has(d.fingerprint),
          disabled: sending,
          onchange: (e: Event) => {
            if ((e.target as HTMLInputElement).checked) chosen.add(d.fingerprint);
            else chosen.delete(d.fingerprint);
            paint();
          },
        }),
        h("span", { class: "grow" }, nick || d.alias, nick ? h("small", { class: "hint" }, ` ${d.alias}`) : null),
        answer
          ? h("span", { class: `post-send-answer ${answerTone(answer)}` }, answerText(answer))
          : online
            ? null
            : h("span", { class: "post-send-answer wait" }, t("Not online")),
      );
    });
    box.replaceChildren(
      h("p", { class: "title" }, `📤 ${t("Send “{title}” to", { title: o.title })}`),
      ...(post.paired.length && post.enabled
        ? [h("div", { class: "post-send-devs" }, ...rows), h("p", { class: "sub" }, t("Only paired ePets are listed. They see it first, then add it or not."))]
        : [
            h("p", { class: "sub" }, post.enabled ? t("No paired ePets yet: pair one in Pet Post first.") : t("Pet Post is off: turn it on to send to other ePets.")),
            h("button", { class: "link", onclick: () => (close(), o.openPost()) }, t("Open Pet Post")),
          ]),
      ...(note ? [h("p", { class: "warning" }, note)] : []),
      h(
        "div",
        { class: "row" },
        post.paired.length && post.enabled
          ? h("button", { class: "primary post-send-go", disabled: sending || !chosen.size, onclick: () => void go() }, sending ? t("Sending…") : t("Send"))
          : null,
        h("button", { class: "cancel post-send-close", onclick: close }, t("Close")),
        h("span", { class: "grow" }),
        h("button", { class: "small post-send-ics", onclick: () => void saveIcs() }, `📄 ${t("Save as .ics…")}`),
      ),
      h("p", { class: "sub" }, t("Save as .ics: for phones and anyone else (send it with LocalSend). Phones add it to their calendar; ePet imports it.")),
    );
  };
  const go = async () => {
    sending = true;
    note = "";
    paint();
    try {
      await b.postScheduleSend([...chosen], o.kind, o.id, hereZone());
      sent = await b.postScheduleSent().catch(() => sent);
      chosen.clear();
    } catch (e) {
      note = String(e);
    }
    sending = false;
    paint();
  };
  const saveIcs = async () => {
    const where = await b.postScheduleSave(o.kind, o.id, hereZone(), t("Save as .ics…")).catch((e) => ((note = String(e)), null));
    if (where) note = "";
    if (where) box.querySelector(".post-send-ics")!.textContent = `✓ ${t("Saved")}`;
    else paint();
  };
  unlisten = await b.on("post-schedule-sent", (list) => {
    sent = list;
    if (overlay.isConnected) paint();
  });
  paint();
  document.addEventListener("keydown", onKey);
  document.body.append(overlay);
}

/** "👤 Dad" by something that came from another ePet (its nickname, else its name). */
export function fromChip(settings: Settings, origins: Map<string, string>, kind: ShareKind, id: number): Node | null {
  const from = origins.get(`${kind}:${id}`);
  if (from === undefined || from === "") return null;
  // (No longer paired: no name to give it.)
  const name = deviceName(settings.post, from);
  return name ? h("span", { class: "chip from", title: t("Sent from {who}", { who: name }) }, `👤 ${name}`) : null;
}
