/**
 * Pet Post, the main window's Pet Post tab (docs/INTERACTIONS.md, "Pet Post"): devices found nearby (and added
 * by address), sending them files, a folder or a text, how it goes, what arrived while
 * it's open, and Verify (the same icons on both screens). The pet asks about deliveries to
 * you (src/pet/courier.ts); the settings are in the panel.
 */
import { backend, type Settings } from "../platform";
import { t, onLanguage } from "../i18n";
import { formatWhen, h } from "../panel/dom";
import { copyText } from "../pet/courier";
import { VERIFY_ICONS } from "../features/post/verifyIcons";
import {
  addError,
  isFavorite,
  withFavorite,
  withoutFavorite,
  DEVICE_ICONS,
  LOCALSEND_PORT,
  sendable,
  sendError,
  sourceLabel,
  fileCount,
  formatSize,
  Rate,
  transferLine,
  transferOver,
  type PostDevice,
  type PostStatus,
  type PostTransfer,
  type PostVerify,
  type PostOffer,
  type PostReceived,
  type SavedDevice,
  namesLine,
  recentSenders,
  collects,
  oneWay,
  shareError,
  isBlocked,
  type PostShareList,
  verifiedMark,
  withBlocked,
  withVerified,
  withoutVerified,
  type PostVerifyAnswer,
  itemStatus,
  largeDelivery,
  listsItems,
  partialLine,
  retryPaths,
  shownItems,
  tallyLine,
  unlisted,
  pairedMark,
  lookalikeOf,
  withoutPaired,
} from "../features/post/post";
import { closePair, pairing, pairView, startPair, tickPair, type PairContext } from "./pair";
import { importCalendar, inboxCards, inboxCount, loadInbox, type InboxContext } from "./schedule";
import { nickOf, withNick } from "../features/post/schedule";

/** Where Pet Post is drawn: the main window's Pet Post tab (`mountPost`). */
let root: HTMLElement = document.createElement("div");
/** Brings its tab to the front (a drop, "Open Pet Post…", Verify asked for). */
let showTab: () => void = () => {};

/** Material Icons' "verified_user" (a shield with a check), as LocalSend's Verify shows it. */
const VERIFIED_USER = "M10 17 18 9 16.6 7.6 10 14.2 7.4 11.6 6 13ZM12 1 21 5V11Q21 15.2 18.4 18.6Q15.8 22.1 12 23Q8.2 22.1 5.6 18.6Q3 15.2 3 11V5Z";

/** Material Icons' "favorite" and "favorite_border" (♥ / ♡), as LocalSend's Favorite. */
const FAVORITE =
  "M12 21.3 10.5 20Q8.1 17.8 6.9 16.7Q5.8 15.6 4.4 14Q3 12.4 2.5 11.1Q2 9.8 2 8.5Q2 6.2 3.6 4.6Q5.2 3 7.5 3Q10.2 3 12 5.1Q13.8 3 16.5 3Q18.8 3 20.4 4.6Q22 6.2 22 8.5Q22 10.3 20.8 12.3Q19.5 14.2 18.1 15.7Q16.7 17.2 13.5 20.1Z";
const FAVORITE_BORDER =
  "M12.1 18.6Q14.3 16.5 15.4 15.5Q16.5 14.5 17.8 13.1Q19 11.7 19.5 10.6Q20 9.5 20 8.5Q20 7 19 6Q18 5 16.5 5Q15.3 5 14.3 5.7Q13.3 6.3 12.9 7.4H11.1Q10.7 6.3 9.7 5.7Q8.7 5 7.5 5Q6 5 5 6Q4 7 4 8.5Q4 9.5 4.5 10.6Q5 11.7 6.2 13.1Q7.5 14.5 8.6 15.5Q9.7 16.5 11.9 18.6L12 18.7ZM16.5 3Q18.8 3 20.4 4.6Q22 6.2 22 8.5Q22 9.8 21.5 11.1Q21 12.4 19.6 14Q18.2 15.6 17.1 16.7Q15.9 17.8 13.5 20L12 21.3L10.5 20.1Q7.3 17.2 5.9 15.7Q4.5 14.2 3.2 12.3Q2 10.3 2 8.5Q2 6.2 3.6 4.6Q5.2 3 7.5 3Q10.2 3 12 5.1Q13.8 3 16.5 3Z";

/** A device whose ♡ was clicked for the first time ever: told first what a favorite means. */
let favoriteAsk: string | null = null;

/** ♡ / ♥: a favorite's deliveries are accepted without asking (said once, the first time). */
async function favorite(d: PostDevice, on: boolean): Promise<void> {
  const cur = await backend.getSettings();
  if (on && !cur.post.favoriteNoticeSeen && favoriteAsk !== d.fingerprint) {
    favoriteAsk = d.fingerprint;
    render();
    return;
  }
  favoriteAsk = null;
  const post = on ? withFavorite(cur.post, d) : withoutFavorite(cur.post, d.fingerprint);
  settings = await backend.setSettings({ post });
  render();
}

/** A small icon (an SVG path in a 24×24 box), in the text's colour. */
function icon(path: string, css = "ui-icon"): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("class", css);
  svg.setAttribute("aria-hidden", "true");
  const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
  p.setAttribute("d", path);
  svg.append(p);
  return svg;
}
let settings: Settings;
let status: PostStatus | null = null;
let devices: PostDevice[] = [];
let selected: string | null = null;
/** Sending from this window: what, so a PIN can be given (and how it goes is shown here). */
let mine: { to: string; paths: string[]; text: string | null } | null = null;
let transfer: PostTransfer | null = null;
/** Someone wants to send files: asked here as well as by the pet (answered in one, gone from both). */
let offer: PostOffer | null = null;
/** A delivery coming in. */
let incoming: PostTransfer | null = null;
/** What a device shares by link, being looked at (by fingerprint, or "link"). */
let share: {
  key: string;
  alias: string;
  target: { fingerprint?: string; link?: string };
  state: "asking" | "pin" | "list" | "error";
  list: PostShareList | null;
  chosen: Set<string>;
  error: string;
  pin: string;
} | null = null;
/** Sharing devices told "Not now" (until they stop sharing). */
const shareDismissed = new Set<string>();
/** The delivery coming in is fetched from a share (Stop fetching, not Stop receiving). */
let fetchingShare = false;
/** "Get files from a link…" open, and what's typed. */
let linkOpen = false;
let linkText = "";
/** How fast what's coming in, and what this window sends, goes. */
const inRate = new Rate();
const outRate = new Rate();
/** What was received (kept by the app), the latest first. */
let history: PostReceived[] = [];
/** Received entries whose files aren't there any more. */
const gone = new Set<string>();
let looking = false;
let draft = "";
/** Adding a device by address: the form is open, and how it went. */
let adding: { address: string; port: string; state: "" | "busy" | "done" | "failed"; message: string; firewall: boolean } | null = null;
/** Verify shown for a device. */
let verifying: {
  fingerprint: string;
  /** Its name, when it isn't listed (a recent sender). */
  alias: string;
  code: PostVerify | null;
  mode: "icons" | "text";
  error: string;
  /** The other device (an ePet) asked to show it too: "" (not asked: it asked us), "asking", or its answer. */
  asked: "" | "asking" | PostVerifyAnswer;
  /** Its user says the icons don't match. */
  mismatch: boolean;
  /** They don't match: "Block …?" is up. */
  confirm: boolean;
} | null = null;

let sendFailed = "";
/** Send files…'s ▾ menu (Files… / A folder…) is open. */
let filesMenu = false;
/** The delivery shown was a text (its files aren't listed). */
let lastText = false;
/** Send: files (picked or dropped) or a message (remembered on this computer). */
type SendMode = "files" | "message";
let sendMode: SendMode = (() => {
  try {
    const m = localStorage.getItem("post.sendMode");
    if (m === "files" || m === "message") return m;
    // (0.51 kept whether the message box was open.)
    return localStorage.getItem("post.messageOpen") === "1" ? "message" : "files";
  } catch {
    return "files";
  }
})();

function setSendMode(mode: SendMode): void {
  sendMode = mode;
  try {
    localStorage.setItem("post.sendMode", mode);
  } catch {
    // Not kept: fine.
  }
}

/** Files being dragged over the window: how many (0: none). */
let dragging = 0;
/** A drop that was refused: why (said for a moment where it was dropped). */
let dropNote = "";
/** Text was dropped and filled in (said until it's sent or typed on). */
let textDropped = false;

/** The selected device's name. */
function selectedName(): string {
  return devices.find((d) => d.fingerprint === selected)?.alias ?? "";
}

function sendingNow(): boolean {
  return !!transfer && !transferOver(transfer);
}

function dropNoteFor(msg: string): void {
  dropNote = msg;
  render();
  setTimeout(() => dropNote === msg && ((dropNote = ""), render()), 4000);
}

/** Files or folders dropped on the window: sent to the selected device. */
function dropFiles(paths: string[]): void {
  dragging = 0;
  if (!paths.length) return render();
  if (tab !== "send") tab = "send";
  setSendMode("files");
  if (!selected) return dropNoteFor(t("Pick a device above first."));
  if (sendingNow()) return dropNoteFor(t("Wait until this delivery is done."));
  send(paths, null);
}

/** Text dropped on the window: into the message (after what's there), not sent. */
function dropText(text: string): void {
  const dropped = text.trim();
  if (!dropped) return;
  draft = draft.trim() ? `${draft.replace(/\s+$/, "")}\n${dropped}` : dropped;
  if (tab !== "send") tab = "send";
  setSendMode("message");
  textDropped = true;
  render();
  const box = root.querySelector<HTMLTextAreaElement>(".post-text");
  box?.focus();
  box?.setSelectionRange(box.value.length, box.value.length);
}

/** A great many files (or much data) about to be sent: asked first. */
let confirming: { paths: string[]; files: number; bytes: number } | null = null;

function send(paths: string[], text: string | null, pin: string | null = null, sure = false): void {
  if (!selected) return;
  // Files: how many and how big, first (a whole disk dropped by mistake, say).
  if (text === null && !pin && !sure) {
    const go = () => send(paths, null, null, true);
    void backend.postMeasure(paths).then((m) => {
      if (!largeDelivery(m)) return go();
      confirming = { paths, ...m };
      setSendMode("files");
      render();
    }, go);
    return;
  }
  confirming = null;
  mine = { to: selected, paths, text };
  lastText = text !== null;
  textDropped = false;
  filesMenu = false;
  sendFailed = "";
  backend.postSend(selected, paths, text, pin).catch((e) => {
    mine = null;
    transfer = null;
    sendFailed = sendError(String(e));
    render();
  });
}

/** Keeps a device added by address in the settings (replacing one at that address, or with that fingerprint). */
async function keep(d: PostDevice, replace?: string): Promise<void> {
  const cur = await backend.getSettings();
  const saved: SavedDevice = { address: d.address ?? d.ip, port: d.port, fingerprint: d.fingerprint, alias: d.alias, deviceType: d.deviceType, via: "address" };
  const others = cur.post.devices.filter((x) => x.fingerprint !== d.fingerprint && x.fingerprint !== replace && x.address !== saved.address);
  // The device that answered there before isn't trusted any more.
  const trusted = replace ? cur.post.trusted.filter((x) => x.fingerprint !== replace) : cur.post.trusted;
  settings = await backend.setSettings({ post: { ...cur.post, devices: [...others, saved], trusted } });
}

async function add(): Promise<void> {
  if (!adding || adding.state === "busy") return;
  const address = adding.address.trim();
  const port = Number(adding.port) || LOCALSEND_PORT;
  if (!address) return;
  adding.state = "busy";
  render();
  try {
    const d = await backend.postAddDevice(address, port);
    await keep(d);
    selected = d.fingerprint;
    adding = { address: "", port: String(LOCALSEND_PORT), state: "done", message: t("Added {name}.", { name: d.alias }), firewall: false };
  } catch (e) {
    const code = String(e);
    adding = { ...adding, state: "failed", message: addError(code), firewall: code === "unreachable" };
  }
  render();
}

/** Another device answers at a device's address now: the user says it's the right one. */
async function trustNew(d: PostDevice): Promise<void> {
  try {
    const now = await backend.postAddDevice(d.address ?? d.ip, d.port);
    await keep(now, d.fingerprint);
    selected = now.fingerprint;
  } catch (e) {
    sendFailed = addError(String(e));
  }
  render();
}

/**
 * No longer remembered (✕): not kept at its address, and no longer a favorite. Verified or
 * paired, it stays so (Settings → Pet Post undoes that).
 */
async function forget(d: PostDevice): Promise<void> {
  const cur = await backend.getSettings();
  const post = withoutFavorite(cur.post, d.fingerprint);
  settings = await backend.setSettings({ post: { ...post, devices: post.devices.filter((x) => x.fingerprint !== d.fingerprint) } });
  if (selected === d.fingerprint) selected = null;
  render();
}

function verify(fingerprint: string, alias = ""): void {
  if (pairing) closePair(pairContext);
  const fp = fingerprint.toUpperCase();
  const v: NonNullable<typeof verifying> = { fingerprint: fp, alias, code: null, mode: "icons", error: "", asked: "", mismatch: false, confirm: false };
  verifying = v;
  const redraw = () => verifying === v && render();
  render();
  backend
    .postVerify(fp)
    .then((code) => {
      v.code = code;
      // It asked for this: it shows them already (not asked back).
      if (code.askedBy) return;
      // An ePet is asked to show them too, and its user answers (LocalSend can't be asked).
      v.asked = "asking";
      void backend
        .postVerifyAsk(fp)
        .catch((): PostVerifyAnswer => "unreachable")
        .then((a) => {
          v.asked = a;
          // Declined: nothing is sent to it this time.
          if (a === "declined" && transfer?.fingerprint === fp && !transferOver(transfer)) void backend.postCancelSend();
          // Shown: whether its user says they don't match (a warning here, nothing more).
          if (a === "shown")
            void backend
              .postVerifyResult(fp)
              .catch(() => null)
              .then((r) => r === "mismatch" && verifying === v && ((v.mismatch = true), render()));
          redraw();
        });
    })
    .catch(() => (v.error = t("Pet Post is off.")))
    .finally(redraw);
}

/** They match: marked verified (here; the other side decides for itself). */
async function verifiedNow(v: NonNullable<typeof verifying>, name: string): Promise<void> {
  void backend.postVerifyDecided(v.fingerprint, true);
  const cur = await backend.getSettings();
  settings = await backend.setSettings({ post: withVerified(cur.post, { fingerprint: v.fingerprint, alias: name }) });
  // Back to the list, where its name now has the badge.
  if (verifying === v) verifying = null;
  render();
}

/** They don't match: blocked (after "Block …?"). */
async function block(v: NonNullable<typeof verifying>, name: string): Promise<void> {
  const cur = await backend.getSettings();
  settings = await backend.setSettings({ post: withBlocked(cur.post, { fingerprint: v.fingerprint, alias: name }) });
  if (selected === v.fingerprint) selected = null;
  verifying = null;
  render();
}

/** Re-check: no longer verified here (the two sides disagree), and asked again. */
async function recheck(v: NonNullable<typeof verifying>, name: string): Promise<void> {
  const cur = await backend.getSettings();
  settings = await backend.setSettings({ post: withoutVerified(cur.post, v.fingerprint) });
  verify(v.fingerprint, name);
}

/** A green "Verified" (the shield alone when `small`) by a verified device's name. */
function verifiedBadge(fingerprint: string | null | undefined, small = false): Node | null {
  const paired = pairedMark(settings.post, fingerprint);
  if (paired) {
    const title = t("Paired on {date} with a code: only this ePet gets what you send it.", { date: formatWhen(paired.at) });
    return h("span", { class: `post-paired${small ? " small" : ""}`, title, "aria-label": t("Paired") }, "🔒", small ? null : ` ${t("Paired")}`);
  }
  const mark = verifiedMark(settings.post, fingerprint);
  if (!mark) return null;
  const title = t("Verified on {date}: the icons matched on both screens.", { date: formatWhen(mark.at) });
  return h("span", { class: `post-verified${small ? " small" : ""}`, title, "aria-label": t("Verified") }, icon(VERIFIED_USER), small ? null : t("Verified"));
}

/** Stands for a name in a line, where it goes with its badge (`named`). */
const NAME = "\u0001";

/** A line with the device's name (written as NAME in it) and, if verified, its badge. */
function named(line: string, name: string, fingerprint: string | null | undefined, small = false): Node[] {
  const [before, after = ""] = line.split(NAME);
  return [before, h("span", { class: "post-name" }, name), verifiedBadge(fingerprint, small), after].filter((n): n is Node | string => n !== null && n !== "") as Node[];
}

/** On (the pet window tells the app; it says when it's listening, "post-status"). */
async function turnOn(): Promise<void> {
  const current = await backend.getSettings();
  settings = await backend.setSettings({ post: { ...current.post, enabled: true } });
  render();
  lookAgain();
}

async function pick(folder: boolean): Promise<void> {
  setSendMode("files");
  render();
  const who = selectedName();
  const title = folder ? t("Choose a folder to send to {who}", { who }) : t("Choose files to send to {who}", { who });
  const paths = await backend.postPick(folder, title);
  if (paths?.length) send(paths, null);
}

function lookAgain(): void {
  looking = true;
  render();
  void backend.postRefresh();
  // (Its own addresses may have changed too.)
  void backend.postStatus().then((s) => ((status = s), render()), () => {});
  setTimeout(() => {
    looking = false;
    render();
  }, 4000);
}

/** The paired ePet being renamed here (✎), and what's typed. */
let renaming: { fingerprint: string; text: string } | null = null;

async function saveNick(fingerprint: string, text: string): Promise<void> {
  renaming = null;
  const cur = await backend.getSettings();
  settings = await backend.setSettings({ post: withNick(cur.post, fingerprint, text) });
  render();
}

/** A paired ePet's name here: its nickname (✎ to give or change it), or its own name. */
function nameLine(d: PostDevice): Node[] {
  const paired = !!pairedMark(settings.post, d.fingerprint);
  const nick = paired ? nickOf(settings.post, d.fingerprint) : "";
  if (paired && renaming?.fingerprint === d.fingerprint) {
    const r = renaming;
    const input = h("input", {
      type: "text",
      class: "post-rename-input",
      maxLength: 40,
      value: r.text,
      placeholder: d.alias,
      "aria-label": t("Nickname"),
      onclick: (e: Event) => e.stopPropagation(),
      oninput: (e: Event) => (r.text = (e.target as HTMLInputElement).value),
      onkeydown: (e: KeyboardEvent) => {
        e.stopPropagation();
        if (e.key === "Enter") void saveNick(d.fingerprint, r.text);
        if (e.key === "Escape") ((renaming = null), render());
      },
    });
    requestAnimationFrame(() => input.isConnected && document.activeElement !== input && (input.focus(), input.select()));
    return [
      h(
        "span",
        { class: "row post-rename" },
        input,
        h("button", { class: "small primary post-rename-save", onclick: (e: Event) => (e.stopPropagation(), void saveNick(d.fingerprint, r.text)) }, t("Save")),
        h("button", { class: "small post-rename-cancel", onclick: (e: Event) => (e.stopPropagation(), (renaming = null), render()) }, t("Cancel")),
      ),
      h("span", { class: "hint" }, t("Only you see it. Empty: its own name, {name}.", { name: d.alias })),
    ];
  }
  return [
    h(
      "strong",
      {},
      nick || d.alias,
      verifiedBadge(d.fingerprint),
      paired
        ? h(
            "button",
            {
              class: "icon post-rename-start",
              title: nick ? t("Rename") : t("Give it a name"),
              "aria-label": nick ? t("Rename") : t("Give it a name"),
              onclick: (e: Event) => (e.stopPropagation(), (renaming = { fingerprint: d.fingerprint, text: nick }), render()),
            },
            "✎",
          )
        : null,
    ),
  ];
}

function deviceRow(d: PostDevice): Node {
  // Goes by a paired ePet's name with another identity: not sent to (someone may pretend).
  const lookalike = lookalikeOf(settings.post, d);
  const can = sendable(d) && !lookalike;
  // Named here: its own name goes to the line under it (to tell it apart).
  const own = nickOf(settings.post, d.fingerprint) && pairedMark(settings.post, d.fingerprint) ? d.alias : null;
  const where = [own, sourceLabel(d, settings.post), d.deviceModel, d.address ?? d.ip].filter(Boolean).join(" · ");
  const state = d.changedTo
    ? t("⚠ Another device answers there now.")
    : lookalike
      ? t("⚠ Not the {name} you paired with: its identity is different. Reinstalled? Pair again. Otherwise someone may be pretending.", { name: lookalike.alias })
      : !d.online
        ? t("Not answering.")
        : "";
  const row = h(
    "li",
    {
      class: `post-device${d.fingerprint === selected ? " selected" : ""}${can ? "" : " unavailable"}`,
      tabIndex: 0,
      role: "radio",
      "aria-checked": String(d.fingerprint === selected),
      "aria-disabled": String(!can),
      onclick: () => {
        if (!can) return;
        selected = d.fingerprint;
        render();
      },
    },
    h("span", { class: "icon" }, DEVICE_ICONS[d.deviceType] ?? "💻"),
    h(
      "span",
      { class: "grow" },
      ...nameLine(d),
      h("span", { class: "hint" }, where),
      collects(d) ? h("span", { class: "post-collects", title: t("It's behind another router: what's sent to it waits until it collects it.") }, `↩ ${t("It collects")}`) : null,
      state ? h("span", { class: `post-device-state${d.changedTo || lookalike ? " warning" : ""}` }, state) : null,
      lookalike
        ? h(
            "span",
            { class: "row" },
            h("button", { class: "small primary post-pair-again-row", onclick: (e: Event) => (e.stopPropagation(), pair(d)) }, `🔗 ${t("Pair again…")}`),
            h("button", { class: "small post-unpair-old", onclick: (e: Event) => (e.stopPropagation(), void unpair(lookalike.fingerprint)) }, t("Unpair the old one")),
          )
        : null,
      favoriteAsk === d.fingerprint
        ? h(
            "span",
            { class: "post-favorite-notice" },
            h("span", {}, t("A favorite is remembered (looked for even off this network), and what it sends you is accepted without asking.")),
            h(
              "span",
              { class: "row" },
              h("button", { class: "small primary post-favorite-yes", onclick: (e: Event) => (e.stopPropagation(), void favorite(d, true)) }, t("Add to favorites")),
              h("button", { class: "small", onclick: (e: Event) => (e.stopPropagation(), (favoriteAsk = null), render()) }, t("Cancel")),
            ),
          )
        : null,
      d.changedTo
        ? h(
            "span",
            { class: "row" },
            h("button", { class: "small post-trust-new", onclick: (e: Event) => (e.stopPropagation(), void trustNew(d)) }, t("It's mine: use the new one")),
          )
        : null,
    ),
    d.https && (can || isFavorite(settings.post, d.fingerprint))
      ? h(
          "button",
          {
            class: `small post-favorite${isFavorite(settings.post, d.fingerprint) ? " on" : ""}`,
            title: isFavorite(settings.post, d.fingerprint) ? t("Favorite: what it sends is accepted without asking. Click to remove.") : t("Favorite"),
            "aria-label": t("Favorite"),
            "aria-pressed": String(isFavorite(settings.post, d.fingerprint)),
            onclick: (e: Event) => (e.stopPropagation(), void favorite(d, !isFavorite(settings.post, d.fingerprint))),
          },
          icon(isFavorite(settings.post, d.fingerprint) ? FAVORITE : FAVORITE_BORDER),
        )
      : null,
    // An ePet pairs (a code); LocalSend Verifies (icons). Paired: nothing more to check.
    d.https && can && d.epet && !pairedMark(settings.post, d.fingerprint)
      ? h("button", { class: "small post-pair", title: t("Pair: type a code the other ePet shows, once"), onclick: (e: Event) => (e.stopPropagation(), pair(d)) }, `🔗 ${t("Pair…")}`)
      : null,
    // (An ePet can still be Verified, an older one too: the shield alone, beside Pair.)
    d.https && can && !pairedMark(settings.post, d.fingerprint)
      ? h(
          "button",
          { class: "small post-verify", title: t("Verify: compare with what the other device shows"), "aria-label": t("Verify"), onclick: (e: Event) => (e.stopPropagation(), verify(d.fingerprint)) },
          icon(VERIFIED_USER),
          d.epet ? null : t("Verify"),
        )
      : null,
    // Remembered (added by address; or a favorite not answering): ✕ forgets it.
    settings.post.devices.some((x) => x.fingerprint === d.fingerprint && (x.via === "address" || !d.online))
      ? h(
          "button",
          { class: "small post-forget", title: t("Forget it (verified or paired, it stays so)"), "aria-label": t("Remove"), onclick: (e: Event) => (e.stopPropagation(), void forget(d)) },
          "✕",
        )
      : null,
  );
  return row;
}

function deviceList(): Node {
  if (!devices.length) {
    return h(
      "div",
      { class: "box post-empty" },
      h("p", {}, looking ? t("Looking for devices…") : t("No one found yet.")),
      h("p", { class: "hint" }, t("The other device needs LocalSend or ePet open, on the same network (Wi-Fi).")),
    );
  }
  const usable = devices.filter(sendable);
  if (!selected || !usable.some((d) => d.fingerprint === selected)) selected = usable[0]?.fingerprint ?? null;
  return h("ul", { class: "post-devices" }, ...devices.map(deviceRow));
}

type Tab = "receive" | "send" | "history";
const TABS: { id: Tab; icon: string; label: () => string }[] = [
  { id: "receive", icon: "📥", label: () => t("Receive") },
  { id: "send", icon: "📤", label: () => t("Send") },
  { id: "history", icon: "🕘", label: () => t("History") },
];

/** A per-window choice kept in this browser's storage (it may be unavailable: then not kept). */
function stored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function store(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // (Not kept.)
  }
}

/** The tab shown: as left last time, unless the window was opened for another. */
let tab: Tab = (["receive", "send", "history"] as const).find((x) => x === stored("post.tab")) ?? "receive";
function show(next: Tab): void {
  tab = next;
  store("post.tab", next);
  render();
}

/** What the pairing view (./pair.ts) needs of this window. */
const pairContext: PairContext = {
  backend,
  render: () => render(),
  saved: (s) => (settings = s),
  sendTo: (fp) => {
    selected = fp;
    setSendMode("files");
    show("send");
  },
  verify: (fp, alias) => verify(fp, alias),
};

/** What the invitations (alarms, to-dos, anniversaries sent here: ./schedule.ts) need. */
const inboxContext: InboxContext = {
  backend,
  settings: () => settings,
  saved: (s) => (settings = s),
  render: () => render(),
};

/** Pairs with a device (an ePet): Pet Post → Pair. */
function pair(d: { fingerprint: string; alias: string }): void {
  verifying = null;
  startPair(pairContext, d.fingerprint, d.alias);
}

/** No longer paired with the ePet this one looks like (the old one, reinstalled maybe). */
async function unpair(fingerprint: string): Promise<void> {
  const cur = await backend.getSettings();
  settings = await backend.setSettings({ post: withoutPaired(cur.post, fingerprint) });
  render();
}

/** This computer's address picked to show (by its IP), and whether the list is open. */
let addressChoice = stored("post.address");
let addressesOpen = false;

const KIND_GROUPS: { kinds: string[]; label: () => string }[] = [
  { kinds: ["ethernet", "wifi", "lan"], label: () => t("Local network (wired / wireless)") },
  { kinds: ["tailscale"], label: () => "Tailscale" },
  { kinds: ["virtual"], label: () => t("Other virtual adapters (rarely needed)") },
];

/** This computer's addresses and port, one shown (the likeliest, or the one picked) and the rest in a list: what others type to add it by address. */
function addressPicker(): Node | null {
  if (!status?.running || !status.addresses.length) return null;
  const port = status.port;
  const list = status.addresses;
  const current = list.find((a) => a.ip === addressChoice) ?? list[0];
  const text = (a: { ip: string }) => `${a.ip}:${port}`;
  const tag = (a: { name: string; kind: string }) => h("span", { class: `post-tag ${a.kind}` }, a.kind === "tailscale" ? "Tailscale" : a.name || a.kind);
  const menu = addressesOpen
    ? h(
        "div",
        { class: "post-address-menu", role: "listbox" },
        ...KIND_GROUPS.flatMap((g) => {
          const items = list.filter((a) => g.kinds.includes(a.kind));
          if (!items.length) return [];
          return [
            h("div", { class: "post-address-group" }, g.label()),
            ...items.map((a) =>
              h(
                "div",
                {
                  class: `post-address-option${a === current ? " on" : ""}${a.kind === "virtual" ? " dim" : ""}`,
                  role: "option",
                  "aria-selected": String(a === current),
                  tabIndex: 0,
                  onclick: () => {
                    addressChoice = a.ip;
                    store("post.address", a.ip);
                    addressesOpen = false;
                    render();
                  },
                },
                h("code", {}, text(a)),
                tag(a),
                a === current ? h("span", { class: "check" }, "✓") : null,
              ),
            ),
          ];
        }),
      )
    : null;
  return h(
    "div",
    { class: "post-own" },
    h("p", { class: "hint" }, t("To add this computer by address on another device:")),
    h(
      "div",
      { class: "row post-address-row" },
      h(
        "button",
        {
          class: "post-address-pick grow",
          "aria-expanded": String(addressesOpen),
          disabled: list.length < 2,
          onclick: () => ((addressesOpen = !addressesOpen), render()),
        },
        h("code", { class: "post-address" }, text(current)),
        tag(current),
        list.length > 1 ? h("span", { class: "chev" }, addressesOpen ? "▴" : `▾ ${t("{n} more", { n: list.length - 1 })}`) : null,
      ),
      copyButton("small post-address-copy", text(current)),
    ),
    menu,
    addressesOpen ? h("p", { class: "hint" }, t("Pick the one on the network the other device is on: the same Wi-Fi, or Tailscale when you're apart.")) : null,
    port !== LOCALSEND_PORT
      ? h(
          "p",
          { class: "warning post-port-moved" },
          t("Port {usual} is taken by another app (LocalSend?), so this computer uses {port}: a device adding it by address needs this port.", { usual: LOCALSEND_PORT, port }),
        )
      : null,
  );
}

/** Where received files go, with Change… right here. */
function saveDirLine(): Node {
  return h(
    "div",
    { class: "row post-save-dir" },
    h("span", { class: "hint" }, t("Saved to:")),
    h("span", { class: "grow path", title: status?.saveDir ?? "" }, status?.saveDir ?? ""),
    h(
      "button",
      {
        class: "small post-change-dir",
        onclick: async () => {
          const dir = await backend.postPickSaveDir();
          if (!dir) return;
          const cur = await backend.getSettings();
          settings = await backend.setSettings({ post: { ...cur.post, saveDir: dir } });
          status = await backend.postStatus().catch(() => status);
          render();
        },
      },
      t("Change…"),
    ),
  );
}

/** The Receive tab: what's coming, or ready to receive; this computer's address, where files go, the latest received. */
function receiveTab(): Node[] {
  const cards = [offerCard(), incomingCard()].filter((n): n is Node => n !== null);
  const ready = h(
    "div",
    { class: "post-ready" },
    h("div", { class: "post-ready-icon" }, "📥"),
    h("div", { class: "post-ready-name" }, status?.alias ?? ""),
    h("p", { class: "hint" }, t("Ready to receive: nearby devices can see this computer.")),
  );
  const latest = history[0];
  const invites = inboxCards(inboxContext);
  return ([
    ...invites,
    ...(cards.length ? cards : invites.length ? [] : [ready]),
    ...shareCards(),
    oneWayCard(),
    ...[addressPicker()].filter((n): n is Node => n !== null),
    saveDirLine(),
    h(
      "p",
      { class: "hint" },
      h("button", { class: "link post-import-ics", onclick: () => void importCalendar(inboxContext) }, `📅 ${t("Import a calendar file (.ics)…")}`),
    ),
    h("h3", {}, t("Latest")),
    latest ? h("ul", { class: "post-received" }, receivedRow(latest)) : h("p", { class: "hint" }, t("Nothing received yet.")),
    history.length > 1 ? h("p", { class: "hint" }, h("a", { href: "#", class: "post-to-history", onclick: (e: Event) => (e.preventDefault(), show("history")) }, t("All of it: 🕘 History"))) : null,
    recentList(),
  ] as (Node | null)[]).filter((n): n is Node => n !== null);
}

/** Asks what a device shares (its user may be asked first, or a PIN). */
async function openShare(key: string, alias: string, target: { fingerprint?: string; link?: string }, pin: string | null = null): Promise<void> {
  const s: NonNullable<typeof share> = { key, alias, target, state: "asking", list: null, chosen: new Set(), error: "", pin: "" };
  share = s;
  render();
  try {
    const list = await backend.postShareOpen(target, pin);
    if (share !== s) return;
    s.list = list;
    s.alias = list.alias || alias;
    s.chosen = new Set(list.files.map((f) => f.id));
    s.state = "list";
  } catch (e) {
    if (share !== s) return;
    const code = String(e);
    if (code === "pin") {
      s.state = "pin";
      s.error = pin ? shareError("pin", alias) : "";
    } else {
      s.state = "error";
      s.error = shareError(code, alias);
    }
  }
  render();
}

async function getShared(s: NonNullable<typeof share>): Promise<void> {
  try {
    fetchingShare = true;
    await backend.postShareGet([...s.chosen]);
    share = null;
    linkOpen = false;
    linkText = "";
  } catch (e) {
    fetchingShare = false;
    s.state = "error";
    s.error = String(e) === "busy" ? t("Something is being received now: try again when it's in.") : shareError(String(e), s.alias);
  }
  render();
}

/** Receive: devices sharing files by link (LocalSend's Share via link), and what one shares. */
function shareCards(): Node[] {
  const out: Node[] = [];
  const sharing = devices.filter((d) => d.sharing && !isBlocked(settings.post, d.fingerprint) && !shareDismissed.has(d.fingerprint) && share?.key !== d.fingerprint);
  for (const d of sharing) {
    out.push(
      h(
        "div",
        { class: "box post-share" },
        h("p", { class: "post-share-title" }, "📤 ", ...named(t("{who} is sharing files with you", { who: NAME }), d.alias, d.fingerprint)),
        h(
          "div",
          { class: "row" },
          h("button", { class: "primary post-share-open", onclick: () => void openShare(d.fingerprint, d.alias, { fingerprint: d.fingerprint }) }, t("See what's shared")),
          h("button", { class: "post-share-not-now", onclick: () => (shareDismissed.add(d.fingerprint), render()) }, t("Not now")),
        ),
      ),
    );
  }
  const s = share;
  if (s) out.push(shareCard(s));
  if (!s) {
    out.push(
      linkOpen
        ? h(
            "div",
            { class: "box post-share-link" },
            h("p", { class: "post-share-title" }, `🔗 ${t("Get files from a link")}`),
            h("p", { class: "hint" }, t("In LocalSend on the other device: choose the files, then ⚙ by Nearby devices → Share via link, and type the address it shows here:")),
            h(
              "div",
              { class: "row" },
              (() => {
                const input = h("input", { type: "text", class: "post-share-link-input", placeholder: "http://192.168.1.20:53317", value: linkText }) as HTMLInputElement;
                input.addEventListener("input", () => (linkText = input.value));
                input.addEventListener("keydown", (e) => e.key === "Enter" && linkText.trim() && void openShare("link", linkText.trim(), { link: linkText.trim() }));
                return input;
              })(),
              h("button", { class: "primary post-share-link-go", onclick: () => linkText.trim() && void openShare("link", linkText.trim(), { link: linkText.trim() }) }, t("Get files")),
              h("button", { class: "small", onclick: () => ((linkOpen = false), render()) }, "✕"),
            ),
          )
        : h("p", { class: "row" }, h("button", { class: "small post-share-link-open", onclick: () => ((linkOpen = true), render()) }, `🔗 ${t("Get files from a link…")}`)),
    );
  }
  return out;
}

function shareCard(s: NonNullable<typeof share>): Node {
  const close = () => ((share = null), render());
  const fp = s.list?.fingerprint ?? s.target.fingerprint ?? "";
  const title = h("p", { class: "post-share-title" }, "📤 ", ...named(t("{who} is sharing files with you", { who: NAME }), s.alias, fp));
  if (s.state === "asking") {
    return h(
      "div",
      { class: "box post-share" },
      title,
      h("p", { class: "hint post-share-asking" }, t("Asking {who}… If it asks, allow it there.", { who: s.alias })),
      h("button", { class: "small", onclick: close }, t("Cancel")),
    );
  }
  if (s.state === "pin") {
    const input = h("input", { type: "text", class: "post-share-pin", placeholder: t("PIN"), autocomplete: "off", value: s.pin }) as HTMLInputElement;
    input.addEventListener("input", () => (s.pin = input.value));
    const go = () => input.value.trim() && void openShare(s.key, s.alias, s.target, input.value.trim());
    input.addEventListener("keydown", (e) => e.key === "Enter" && go());
    return h(
      "div",
      { class: "box post-share" },
      title,
      h("p", {}, t("{who} wants a PIN.", { who: s.alias })),
      s.error ? h("p", { class: "warning" }, s.error) : null,
      h("div", { class: "row" }, input, h("button", { class: "primary post-share-pin-go", onclick: go }, t("OK")), h("button", { onclick: close }, t("Cancel"))),
    );
  }
  if (s.state === "error" || !s.list) {
    return h(
      "div",
      { class: "box post-share" },
      title,
      h("p", { class: "warning post-share-error" }, s.error),
      h("div", { class: "row" }, h("button", { class: "post-share-retry", onclick: () => void openShare(s.key, s.alias, s.target) }, t("Try again")), h("button", { onclick: close }, t("Close"))),
    );
  }
  const list = s.list;
  const n = s.chosen.size;
  return h(
    "div",
    { class: "box post-share" },
    title,
    list.https ? null : h("p", { class: "hint post-share-plain" }, t("Not encrypted (plain HTTP): fine at home, not on a public network.")),
    h(
      "ul",
      { class: "post-share-files" },
      ...list.files.map((f) => {
        const box = h("input", { type: "checkbox", checked: s.chosen.has(f.id) }) as HTMLInputElement;
        box.addEventListener("change", () => (box.checked ? s.chosen.add(f.id) : s.chosen.delete(f.id), render()));
        return h("li", {}, h("label", { class: "row" }, box, h("span", { class: "grow" }, f.fileName), h("span", { class: "hint" }, formatSize(f.size))));
      }),
    ),
    h(
      "div",
      { class: "row" },
      h("button", { class: "primary post-share-get", disabled: !n, onclick: () => void getShared(s) }, t("Get {files}", { files: fileCount(n) })),
      h("button", { class: "post-share-close", onclick: close }, t("Not now")),
    ),
  );
}

/** Devices told about "may not get through" ("Got it"): not told again (this window's storage). */
const ONE_WAY_SEEN = "post.oneWaySeen";

function oneWaySeen(): string[] {
  try {
    return JSON.parse(localStorage.getItem(ONE_WAY_SEEN) ?? "[]");
  } catch {
    return [];
  }
}

/** Receive: devices that may be unable to send here (this computer behind another router). */
function oneWayCard(): Node | null {
  const own = (status?.addresses ?? []).map((a) => a.ip);
  const seen = oneWaySeen();
  const list = oneWay(devices, own).filter((d) => !seen.includes(d.fingerprint));
  if (!list.length) return null;
  const mine = own.find((ip) => !ip.startsWith("100.")) ?? "";
  const net = mine.split(".").slice(0, 3).join(".");
  const names = list.map((d) => `${d.alias} (${d.ip.split(".").slice(0, 3).join(".")}.x)`).join(", ");
  return h(
    "div",
    { class: "box post-one-way" },
    h("p", { class: "post-one-way-title" }, `⚠ ${t("Some devices may not get through")}`),
    h("p", { class: "hint" }, t("This computer is behind another router ({net}.x). {names} can see it, but what they send may be stopped by that router.", { net, names })),
    h(
      "ul",
      { class: "hint" },
      h("li", {}, t("From LocalSend: choose Share via link on it instead of sending.")),
      h("li", {}, t("Or put both on the same Wi-Fi, or use Tailscale on both.")),
    ),
    h(
      "button",
      {
        class: "small post-one-way-ok",
        onclick: () => {
          try {
            localStorage.setItem(ONE_WAY_SEEN, JSON.stringify([...seen, ...list.map((d) => d.fingerprint)]));
          } catch {
            /* not kept: shown again next time */
          }
          render();
        },
      },
      t("Got it"),
    ),
  );
}

/** Receive → Recent senders: who sent something lately, to Verify (they needn't be found). */
function recentList(): Node | null {
  const senders = recentSenders(history, 5, settings.post.blocked);
  if (!senders.length) return null;
  return h(
    "div",
    { class: "post-recent" },
    h("h3", {}, t("Recent senders")),
    h(
      "ul",
      { class: "post-devices" },
      ...senders.map((s) => {
        const what = s.last.text !== null ? t("a message") : fileCount(s.last.files);
        return h(
          "li",
          { class: "post-device post-recent-sender" },
          h("span", { class: "icon" }, DEVICE_ICONS[s.deviceType] ?? "💻"),
          h("span", { class: "grow" }, h("strong", {}, s.alias, verifiedBadge(s.fingerprint)), h("span", { class: "hint" }, [s.deviceModel, what, formatWhen(s.last.at)].filter(Boolean).join(" · "))),
          h("button", { class: "small post-verify", title: t("Verify: compare with what the other device shows"), onclick: () => verify(s.fingerprint, s.alias) }, icon(VERIFIED_USER), t("Verify")),
        );
      }),
    ),
    h("p", { class: "hint" }, t("The last devices that sent you something.")),
  );
}

/** The History tab: everything received (the last 50). */
function historyTab(): Node[] {
  return [
    h(
      "div",
      { class: "row spread" },
      h("h3", {}, t("Received files and messages")),
      history.length ? h("button", { class: "small post-clear-history", onclick: () => void backend.postClearHistory() }, t("Clear")) : null,
    ),
    history.length ? h("ul", { class: "post-received" }, ...history.map(receivedRow)) : h("p", { class: "hint" }, t("Nothing received yet.")),
    h("p", { class: "row" }, h("button", { class: "small", onclick: () => void backend.postOpen(null) }, t("Open the received files folder"))),
  ];
}

/** "+ Add by address": behind another router, on Tailscale, or where multicast doesn't get through. */
function addForm(): Node {
  if (!adding) {
    return h(
      "p",
      { class: "row" },
      h("button", { class: "small post-add-open", onclick: () => ((adding = { address: "", port: String(LOCALSEND_PORT), state: "", message: "", firewall: false }), render()) }, `＋ ${t("Add by address…")}`),
    );
  }
  const a = adding;
  const address = h("input", { type: "text", class: "post-add-address grow", placeholder: t("192.168.8.20 or a name"), value: a.address, autocomplete: "off", spellcheck: false });
  const port = h("input", { type: "number", class: "post-add-port", min: 1, max: 65535, value: a.port, "aria-label": t("Port") });
  address.addEventListener("input", () => (a.address = address.value));
  port.addEventListener("input", () => (a.port = port.value));
  const go = () => void add();
  address.addEventListener("keydown", (e) => e.key === "Enter" && go());
  port.addEventListener("keydown", (e) => e.key === "Enter" && go());
  if (a.state === "") setTimeout(() => address.focus());
  return h(
    "div",
    { class: "box post-add" },
    h("p", { class: "hint" }, t("A device on another network (behind another router, or on Tailscale): its IP address or name, and port.")),
    h("div", { class: "row" }, address, port, h("button", { class: "primary post-add-go", disabled: a.state === "busy", onclick: go }, a.state === "busy" ? t("Connecting…") : t("Add"))),
    a.message ? h("p", { class: `post-add-state${a.state === "failed" ? " warning" : ""}` }, a.message) : null,
    a.firewall
      ? h("p", { class: "hint post-firewall" }, t("Also check the firewall: on Windows, ePet must be allowed on that network's type (Tailscale's is often Public). Windows Security → Firewall & network protection → Allow an app."))
      : null,
    h("p", { class: "row" }, h("button", { class: "small", onclick: () => ((adding = null), render()) }, t("Close"))),
  );
}

/** Verify: what both screens should show (LocalSend: the device, then Verify). */
function verifyView(): Node {
  const v = verifying!;
  const d = devices.find((x) => x.fingerprint === v.fingerprint);
  const name = d?.alias ?? (v.alias || v.code?.askedBy || v.fingerprint.slice(0, 12));
  const icons = v.code?.icons.map((i) => VERIFY_ICONS[i]) ?? [];
  const mode = (m: "icons" | "text", label: string) =>
    h("button", { class: `small post-verify-${m}${v.mode === m ? " primary" : ""}`, "aria-pressed": String(v.mode === m), onclick: () => ((v.mode = m), render()) }, label);
  const body = v.error
    ? h("p", { class: "warning" }, v.error)
    : !v.code
      ? h("p", { class: "hint" }, t("Working it out…"))
      : v.mode === "icons"
        ? h(
            "div",
            { class: "post-verify-grid", role: "img", "aria-label": icons.map(([n]) => n.replace(/_/g, " ")).join(", ") },
            ...icons.map(([name, path]) => {
              const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
              svg.setAttribute("viewBox", "0 0 24 24");
              svg.setAttribute("data-icon", name);
              const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
              p.setAttribute("d", path);
              svg.append(p);
              return svg;
            }),
          )
        : h("p", { class: "post-verify-code" }, v.code.text);
  return h(
    "div",
    { class: "post-verify-view" },
    h("header", { class: "post-head" }, h("h2", {}, icon(VERIFIED_USER, "ui-icon big"), t("Verify")), h("p", { class: "hint" }, t("With {name}", { name }))),
    h("div", { class: "row post-verify-modes" }, mode("icons", t("Icons")), mode("text", t("Text"))),
    body,
    ...verifyStatus(v, name),
    h("p", { class: "hint" }, t("In LocalSend: the device (or the delivery from this computer), then Verify. In ePet: Pet Post → Verify.")),
    // Kept in sight at the bottom, however long the rest is (it scrolls).
    h("div", { class: "row post-verify-foot" }, h("button", { class: "primary post-verify-done", onclick: () => ((verifying = null), render()) }, t("Done"))),
  );
}

/** Under the icons: how asking the other device went, and They match / They don't match. */
function verifyStatus(v: NonNullable<typeof verifying>, name: string): Node[] {
  if (!v.code) return [];
  const out: Node[] = [];
  const line = (css: string, text: string) => out.push(h("p", { class: `post-verify-line ${css}` }, text));
  switch (v.asked) {
    case "asking":
      line("post-verify-asking", `⏳ ${t("Verification request sent to {name}. Waiting for it…", { name })}`);
      break;
    case "shown":
      line("post-verify-shown", `✓ ${t("{name} shows them too. Compare the icons on both screens: if they differ, someone may be in between (a man-in-the-middle attack).", { name })}`);
      break;
    case "declined":
      line("post-verify-declined warning", t("{name} declined to verify. Nothing is sent to it this time.", { name }));
      break;
    case "refused":
      line("post-verify-refused warning", t("{name} refused: it may have blocked this computer. To check again, unblock it there (Settings → Pet Post), then Verify again.", { name }));
      break;
    case "busy":
      line("post-verify-busy hint", t("Asked just now: try again in a few seconds."));
      break;
    case "unreachable":
      line("post-verify-unreachable hint", t("Couldn't ask {name}: open Verify there to compare.", { name }));
      break;
    case "unsupported":
      line("hint", t("Does it look the same on the other device?"));
      break;
    default:
      if (v.code.askedBy) line("post-verify-asked-by hint", t("{name} asked to compare.", { name: v.code.askedBy }));
  }
  if (v.mismatch && !v.confirm) {
    out.push(
      h(
        "div",
        { class: "box post-verify-mismatch" },
        h("p", {}, t("{name} says the icons don't match. Look again: if they really differ, don't trust this connection.", { name })),
        h(
          "div",
          { class: "row" },
          h("button", { class: "danger post-verify-block", onclick: () => ((v.confirm = true), render()) }, t("Block")),
          h("button", { class: "post-verify-recheck", onclick: () => void recheck(v, name) }, t("Re-check")),
        ),
      ),
    );
  }
  if (v.confirm) {
    out.push(
      h(
        "div",
        { class: "box post-verify-confirm" },
        h("p", {}, h("strong", {}, t("Block {name}?", { name }))),
        h("p", { class: "hint" }, t("The icons differ: this may not be the device it says it is. Nothing will be sent to it, and what it sends is refused. You can unblock it in Settings → Pet Post.")),
        h(
          "div",
          { class: "row" },
          h("button", { class: "danger post-verify-block-yes", onclick: () => void block(v, name) }, t("Block")),
          h("button", { class: "post-verify-look-again", onclick: () => ((v.confirm = false), render()) }, t("Look again")),
        ),
      ),
    );
  } else if (!v.mismatch && !["asking", "declined", "refused"].includes(v.asked)) {
    out.push(
      h(
        "div",
        { class: "row post-verify-decide" },
        h("button", { class: "post-verify-match", onclick: () => void verifiedNow(v, name) }, `✓ ${t("They match")}`),
        h(
          "button",
          {
            class: "post-verify-mismatch-button",
            onclick: () => {
              void backend.postVerifyDecided(v.fingerprint, false);
              v.confirm = true;
              render();
            },
          },
          `✗ ${t("They don't match")}`,
        ),
      ),
    );
  }
  return out;
}

function answer(accept: boolean, always = false): void {
  const o = offer;
  if (!o) return;
  offer = null;
  render();
  void backend.postAnswer(o.id, accept);
  if (always) {
    // "Always accept": a favorite (kept at the address it's at now, if it's listed).
    const d = devices.find((x) => x.fingerprint === o.fingerprint);
    void backend.getSettings().then((cur) => backend.setSettings({ post: withFavorite(cur.post, d ?? { fingerprint: o.fingerprint, alias: o.alias }) }));
  }
}

/** "Declined in 42 s if you don't answer." */
function countdown(o: PostOffer): string {
  return t("Declined in {s} s if you don't answer.", { s: Math.max(0, Math.ceil((o.until - Date.now()) / 1000)) });
}

/** Someone wants to send files: the same question the pet asks. */
function offerCard(): Node | null {
  const o = offer;
  if (!o) return null;
  const trusted = settings.post.trusted.some((d) => d.fingerprint === o.fingerprint);
  return h(
    "div",
    { class: "box post-offer" },
    h("p", { class: "post-offer-title" }, ...named(`📦 ${t("{who} wants to send you {files} ({size})", { who: NAME, files: fileCount(o.files), size: formatSize(o.bytes) })}`, o.alias, o.fingerprint)),
    h("p", { class: "hint" }, namesLine(o.names, o.files)),
    h("p", { class: "hint post-offer-countdown" }, countdown(o)),
    h(
      "div",
      { class: "row wrap" },
      h("button", { class: "primary post-accept", onclick: () => answer(true) }, t("Accept")),
      h("button", { class: "post-decline", onclick: () => answer(false) }, t("Decline")),
      o.fingerprint && !trusted ? h("button", { class: "post-always", onclick: () => answer(true, true) }, t("Always accept")) : null,
      o.fingerprint ? h("button", { class: "small post-offer-verify", onclick: () => verify(o.fingerprint, o.alias) }, icon(VERIFIED_USER), t("Verify")) : null,
    ),
  );
}

/** Each file of a delivery and how far it is (when there's more than one, or one failed). */
function itemRows(tr: PostTransfer): Node[] {
  if (!listsItems(tr)) return [];
  const rows = shownItems(tr).map((x) =>
    h(
      "li",
      { class: `post-item ${x.state}` },
      h("span", { class: "post-item-name", title: x.error ? `${x.name}: ${x.error}` : x.name }, x.name),
      x.state === "moving" ? h("progress", { max: 1000, value: Math.floor((x.done / Math.max(1, x.size)) * 1000) }) : h("span"),
      h("span", { class: "post-item-state" }, itemStatus(x)),
    ),
  );
  const more = unlisted(tr);
  const counts = tallyLine(tr);
  return [
    ...(counts ? [h("p", { class: "hint post-tally" }, counts)] : []),
    h("ul", { class: "post-items" }, ...rows),
    ...(more ? [h("p", { class: "hint post-items-more" }, t("… and {n} more", { n: more }))] : []),
  ];
}

/** A delivery coming in: how far, and Stop receiving. */
function incomingCard(): Node | null {
  const tr = incoming;
  if (!tr) return null;
  const over = transferOver(tr);
  const partial = partialLine(tr, NAME);
  const rows: Node[] = [
    partial
      ? h("p", { class: "warning post-partial" }, ...named(partial, tr.peer, tr.fingerprint))
      : h("p", { class: over && tr.state !== "done" ? "warning" : "" }, ...named(transferLine(tr, NAME), tr.peer, tr.fingerprint)),
  ];
  if (!over)
    rows.push(
      h("progress", { max: 1000, value: Math.floor((tr.done / Math.max(1, tr.total)) * 1000) }),
      h("p", { class: "hint post-rate" }, [`${formatSize(tr.done)} / ${formatSize(tr.total)} · ${fileCount(tr.files)}`, inRate.line(tr)].filter(Boolean).join(" · ")),
    );
  rows.push(...itemRows(tr));
  if (!over)
    rows.push(
      h(
        "div",
        { class: "row end" },
        h("button", { class: "small post-stop-receiving", onclick: () => void (fetchingShare ? backend.postShareCancel() : backend.postStopReceiving()) }, t("Stop receiving")),
      ),
    );
  else if (tr.state !== "done") rows.push(h("div", { class: "row end" }, h("button", { class: "small post-incoming-close", onclick: () => ((incoming = null), render()) }, t("Close"))));
  return h("div", { class: "box post-incoming" }, ...rows);
}

/** Copy: the button says whether it worked ("✓ Copied" / "✗ Couldn't copy"), then goes back. */
function copyButton(css: string, text: string): HTMLButtonElement {
  const b = h("button", { class: css }, t("Copy")) as HTMLButtonElement;
  let back = 0;
  b.onclick = async () => {
    const ok = await copyText(backend, text);
    b.textContent = ok ? `✓ ${t("Copied")}` : `✗ ${t("Couldn't copy")}`;
    b.classList.toggle("copied", ok);
    b.classList.toggle("copy-failed", !ok);
    clearTimeout(back);
    back = window.setTimeout(() => {
      b.textContent = t("Copy");
      b.classList.remove("copied", "copy-failed");
    }, 1500);
  };
  return b;
}

/** One thing received: files (Open, Show in folder) or a text (Copy). */
function receivedRow(r: PostReceived): Node {
  const when = h("span", { class: "hint" }, formatWhen(r.at));
  const open = (reveal: boolean) =>
    backend.postOpenReceived(r.id, reveal).catch(() => {
      gone.add(r.id);
      render();
    });
  if (r.text !== null) {
    return h(
      "li",
      { class: "post-received-item" },
      h("div", { class: "row" }, h("strong", { class: "grow" }, "💬 ", ...named(NAME, r.from, r.fingerprint, true)), when),
      h("div", { class: "row" }, h("span", { class: "grow post-received-text" }, r.text), copyButton("small post-received-copy", r.text!)),
    );
  }
  const names = r.paths.map((p) => p.split(/[\\/]/).pop() ?? p);
  return h(
    "li",
    { class: "post-received-item" },
    h("div", { class: "row" }, h("strong", { class: "grow" }, ...named(`📦 ${t("{files} from {who}", { files: fileCount(r.files), who: NAME })} · ${formatSize(r.bytes)}`, r.from, r.fingerprint, true)), when),
    h("div", { class: "hint post-received-names" }, namesLine(names.slice(0, 3), r.files)),
    gone.has(r.id)
      ? h("p", { class: "hint warning" }, t("Not there any more (moved or deleted)."))
      : h(
          "div",
          { class: "row" },
          r.files === 1 ? h("button", { class: "small post-open-file", onclick: () => void open(false) }, t("Open")) : null,
          // A calendar file (from a phone, say): its alarms, to-dos and anniversaries to add.
          r.files === 1 && /\.(ics|ical|icalendar)$/i.test(r.paths[0] ?? "")
            ? h("button", { class: "small post-import-received", onclick: () => (show("receive"), void importCalendar(inboxContext, r.paths[0])) }, `📅 ${t("Add to ePet…")}`)
            : null,
          h("button", { class: "small post-show-file", onclick: () => void open(true) }, t("Show in folder")),
        ),
  );
}

function progress(): Node | null {
  const tr = transfer;
  if (!tr) return null;
  const over = transferOver(tr);
  const bar = h("progress", { max: 1000, value: Math.floor((tr.done / Math.max(1, tr.total)) * 1000) });
  const rows: Node[] = [h("p", { class: over && tr.state !== "done" ? "warning" : "" }, ...named(transferLine(tr, NAME), tr.peer, tr.fingerprint))];
  // It asks for a PIN: nothing has been sent yet, so no files listed; the PIN, Send, or
  // Cancel (to give up: nothing is left half-sent).
  if (tr.direction === "out" && tr.state === "pin" && mine) {
    const cancel = () => {
      mine = null;
      transfer = null;
      render();
    };
    const input = h("input", { type: "text", class: "post-pin-input", placeholder: t("PIN"), autocomplete: "off" }) as HTMLInputElement;
    const go = () => {
      const pin = input.value.trim();
      if (pin && mine) send(mine.paths, mine.text, pin);
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") go();
      if (e.key === "Escape") cancel();
    });
    setTimeout(() => input.focus());
    return h(
      "div",
      { class: "box post-progress" },
      ...rows,
      mine.text === null ? h("p", { class: "hint post-pin-what" }, `${fileCount(tr.files)} · ${formatSize(tr.total)}`) : null,
      h(
        "div",
        { class: "row" },
        input,
        h("button", { class: "primary post-pin-send", onclick: go }, t("Send")),
        h("button", { class: "post-pin-cancel", onclick: cancel }, t("Cancel")),
      ),
      h("p", { class: "hint post-pin-where" }, t("The PIN is set on the other device (LocalSend: Settings → Receive → Require PIN; ePet: Settings → Pet Post → PIN). Ask its owner.")),
    );
  }
  // Couldn't get there at all: why that may be.
  if (tr.direction === "out" && tr.state === "failed" && tr.error?.startsWith("unreachable"))
    rows.push(h("p", { class: "hint post-unreachable-hint" }, t("Couldn't reach it: it may be behind another router, or a firewall stops it. Putting both on the same Wi-Fi, or Tailscale on both, helps.")));
  const partial = partialLine(tr, NAME);
  if (partial) rows[0] = h("p", { class: "warning post-partial" }, ...named(partial, tr.peer, tr.fingerprint));
  if (!over && tr.state !== "waiting")
    rows.push(bar, h("p", { class: "hint post-rate" }, [`${formatSize(tr.done)} / ${formatSize(tr.total)} · ${fileCount(tr.files)}`, outRate.line(tr)].filter(Boolean).join(" · ")));
  // Not a text: each file.
  if (!(mine?.text ?? lastText)) rows.push(...itemRows(tr));
  if (tr.direction === "out" && !over && mine) rows.push(h("div", { class: "row end" }, h("button", { class: "small post-stop-send", onclick: () => void backend.postCancelSend() }, t("Stop"))));
  const again = retryPaths(tr);
  if (over && tr.state !== "done")
    rows.push(
      h(
        "div",
        { class: "row end" },
        again.length ? h("button", { class: "small post-send-again", onclick: () => send(again, null) }, t("Send the rest again")) : null,
        h("button", { class: "small post-progress-close", onclick: () => ((transfer = null), render()) }, t("Close")),
      ),
    );
  return h("div", { class: "box post-progress" }, ...rows);
}

/** What was shown last (a tab, Pair, Verify): another view starts at its top. */
let shownView = "";

function render(): void {
  const view = pairing ? "pair" : verifying ? "verify" : `tab:${tab}`;
  if (view !== shownView) {
    const first = shownView === "";
    shownView = view;
    // (After drawing it: scrolled down a long list, Pair or Verify would open out of sight.)
    if (!first) requestAnimationFrame(() => root.isConnected && root.getBoundingClientRect().top < 0 && root.scrollIntoView({ block: "start" }));
  }
  if (pairing) {
    root.replaceChildren(pairView(pairContext));
    return;
  }
  if (verifying) {
    root.replaceChildren(verifyView());
    return;
  }
  const on = settings.post.enabled;
  const settingsLink = h(
    "a",
    { href: "#", class: "post-settings-link", onclick: (e: Event) => (e.preventDefault(), void backend.openPanel("settings:post")) },
    `⚙ ${t("Pet Post settings")}`,
  );
  const head = h("header", { class: "post-head row" }, h("span", { class: "grow" }), settingsLink);
  if (!on) {
    root.replaceChildren(
      head,
      h(
        "div",
        { class: "box" },
        h("p", {}, t("Pet Post is off.")),
        h("p", {}, t("Send files and text to phones and computers nearby, and get theirs.")),
        h("p", { class: "hint" }, t("Works with LocalSend on phones and computers, and with ePet on other computers.")),
        h("button", { class: "primary post-turn-on", onclick: () => void turnOn() }, t("Turn on")),
      ),
    );
    return;
  }
  const tabs = h(
    "nav",
    { class: "post-tabs row", role: "tablist" },
    ...TABS.map((x) =>
      h(
        "button",
        { class: `post-tab${tab === x.id ? " active" : ""}`, "data-tab": x.id, role: "tab", "aria-selected": String(tab === x.id), onclick: () => show(x.id) },
        `${x.icon} ${x.label()}`,
        x.id === "receive" && (offer || inboxCount()) && tab !== "receive" ? h("span", { class: "post-tab-badge" }, String((offer ? 1 : 0) + inboxCount())) : null,
      ),
    ),
    h("span", { class: "grow" }),
    settingsLink,
  );
  const state =
    status?.running || !status?.error ? null : h("p", { class: "warning" }, t("Couldn't start: {error}", { error: status.error }));
  const body = tab === "receive" ? receiveTab() : tab === "send" ? sendTab() : historyTab();
  const focus = remember();
  root.replaceChildren(tabs, ...(state ? [state] : []), h("div", { class: "post-tab-body" }, ...body));
  focus();
}

/** The Send tab: devices (found, added by address), files, a folder or a text, and how it goes. */
function sendTab(): Node[] {
  const busy = sendingNow();
  // Files dragged over the window: the files side shows, to drop them on.
  const mode: SendMode = dragging ? "files" : sendMode;
  const text = h("textarea", { class: "post-text", rows: 3, placeholder: t("A message, a link…") }) as HTMLTextAreaElement;
  text.value = draft;
  const canSendText = () => !!selected && !busy && !!draft.trim();
  const sendText = h(
    "button",
    {
      class: `post-send-text${canSendText() ? " primary" : ""}`,
      disabled: !canSendText(),
      onclick: () => {
        if (draft.trim()) send([], draft);
      },
    },
    t("Send text"),
  ) as HTMLButtonElement;
  text.addEventListener("input", () => {
    draft = text.value;
    textDropped = false;
    root.querySelector(".post-dropped-text")?.remove();
    sendText.disabled = !canSendText();
    sendText.classList.toggle("primary", canSendText());
  });
  const files = mode === "files";
  // How the delivery shown goes: the files' under Files, a text's under the message.
  const shown = transfer && (lastText ? !files : files) ? progress() : null;
  const who = selectedName();
  const zone = () => {
    const lines: Node[] = [];
    if (dragging) {
      if (!selected) lines.push(h("strong", {}, t("Pick a device above first.")));
      else if (busy) lines.push(h("strong", {}, t("Wait until this delivery is done.")));
      else lines.push(h("strong", {}, `⬇ ${t("Let go to send to {who}", { who })}`), h("span", { class: "hint" }, fileCount(dragging)));
    } else if (dropNote) lines.push(h("strong", { class: "warning" }, dropNote));
    else if (selected) lines.push(h("span", {}, t("Drop files or folders here to send to {who}", { who })), h("span", { class: "hint" }, t("You can also drop them on the pet.")));
    else lines.push(h("span", {}, t("Pick a device above, then drop files or folders here.")));
    return h("div", { class: `post-drop${dragging ? " hot" : ""}` }, ...lines);
  };
  return [
    h(
      "div",
      { class: "row spread" },
      h("h3", {}, t("Send to")),
      h("button", { class: "small post-refresh", onclick: lookAgain, disabled: looking }, `↻ ${t("Look again")}`),
    ),
    deviceList(),
    addForm(),
    h(
      "div",
      { class: "row post-send" },
      h(
        "span",
        { class: `post-split${files ? " on" : ""}` },
        h("button", { class: `post-files${files ? " primary" : ""}`, disabled: !selected || busy, onclick: () => ((filesMenu = false), void pick(false)) }, `📄 ${t("Send files…")}`),
        h(
          "button",
          {
            class: `post-files-more${files ? " primary" : ""}`,
            disabled: !selected || busy,
            title: t("Files or a folder"),
            "aria-label": t("Files or a folder"),
            "aria-expanded": String(filesMenu),
            onclick: (e: Event) => {
              e.stopPropagation();
              setSendMode("files");
              filesMenu = !filesMenu;
              render();
            },
          },
          "▾",
        ),
      ),
      h(
        "button",
        {
          class: `post-message${files ? "" : " primary"}`,
          "aria-pressed": String(!files),
          onclick: () => {
            setSendMode("message");
            render();
            root.querySelector<HTMLTextAreaElement>(".post-text")?.focus();
          },
        },
        `💬 ${t("Send a message")}`,
        // A draft waits there.
        files && draft.trim() ? h("span", { class: "post-draft-dot", title: t("A message you haven't sent") }) : null,
      ),
      filesMenu && selected && !busy
        ? h(
            "div",
            { class: "post-send-menu", role: "menu" },
            h("button", { class: "post-files-menu", role: "menuitem", onclick: () => ((filesMenu = false), void pick(false)) }, `📄 ${t("Files…")}`),
            h("button", { class: "post-folder", role: "menuitem", onclick: () => ((filesMenu = false), void pick(true)) }, `📁 ${t("A folder…")}`),
          )
        : null,
    ),
    ...(files
      ? [sendFailed ? h("p", { class: "warning post-send-failed" }, sendFailed) : null, confirming && !dragging ? confirmBox(confirming) : dragging || !shown ? zone() : shown]
      : [
          h(
            "div",
            { class: "post-message-box" },
            text,
            textDropped ? h("p", { class: "post-dropped-text" }, `✓ ${t("The text you dropped is in. Check it, then Send text.")}`) : null,
            h(
              "div",
              { class: "row" },
              h(
                "button",
                {
                  class: "small post-paste",
                  onclick: async () => {
                    draft = (await backend.postClipboardText().catch(() => "")) || draft;
                    render();
                  },
                },
                t("Paste"),
              ),
              h("span", { class: "grow" }),
              sendText,
            ),
          ),
          sendFailed ? h("p", { class: "warning post-send-failed" }, sendFailed) : null,
          shown,
        ]
    ).filter((n): n is Node => n !== null),
  ];
}

/** "Send 5472 files (2.1 GB) to X?": Send or Cancel. */
function confirmBox(c: NonNullable<typeof confirming>): Node {
  return h(
    "div",
    { class: "box post-large" },
    h("p", { class: "post-large-title" }, t("Send {files} ({size}) to {who}?", { files: fileCount(c.files), size: formatSize(c.bytes), who: selectedName() })),
    h("p", { class: "hint" }, t("That's a lot. Check it's what you meant to send.")),
    h(
      "div",
      { class: "row end" },
      h("button", { class: "post-large-no", onclick: () => ((confirming = null), render()) }, t("Cancel")),
      h("button", { class: "primary post-large-yes", onclick: () => send(c.paths, null, null, true) }, t("Send")),
    ),
  );
}

/** Where the cursor is (an input, by its class), to put it back after redrawing. */
function remember(): () => void {
  const el = document.activeElement;
  if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) || !el.className) return () => {};
  const css = `.${el.className.split(/\s+/)[0]}`;
  const [start, end] = [el.selectionStart, el.selectionEnd];
  return () => {
    const again = root.querySelector<HTMLInputElement | HTMLTextAreaElement>(css);
    if (!again) return;
    again.focus();
    try {
      again.setSelectionRange(start, end);
    } catch {
      // (Number inputs have no selection.)
    }
  };
}

let mounted: Promise<void> | null = null;
/** Ready (its events heard): what it's opened for is shown at once; before, after loading. */
let ready = false;
let pendingOpen = "";

/** Opened for something: "send" (a tab), "verify=<fingerprint>"; "" for nothing in particular. */
export function openPost(opened: string): void {
  if (!opened) return;
  if (ready) applyOpened(opened);
  else pendingOpen = opened;
}

function applyOpened(opened: string): void {
  const asked = /^verify=([0-9A-Fa-f]+)$/.exec(opened)?.[1];
  if (asked) return verify(asked);
  const on = /^(receive|send|history)$/.exec(opened)?.[1] as Tab | undefined;
  if (on) {
    verifying = null;
    show(on);
  }
}

/**
 * Draws Pet Post into `el` (the main window's Pet Post tab), once. `show` brings that tab
 * to the front; `opened` is what it was opened for: "send", "verify=<fingerprint>"…
 */
export function mountPost(el: HTMLElement, show: () => void, opened = ""): Promise<void> {
  root = el;
  showTab = show;
  mounted ??= main(opened);
  return mounted;
}

async function main(opened: string): Promise<void> {
  // A click elsewhere closes Send files…'s menu.
  document.addEventListener("click", (e) => {
    if (filesMenu && !(e.target as Element | null)?.closest?.(".post-send-menu, .post-files-more")) {
      filesMenu = false;
      render();
    }
  });
  // Tests send files from here as the file dialog (or a drop) would: neither can be driven.
  if (await backend.e2eEnabled()) Object.assign(window, { __post: { send: (paths: string[]) => send(paths, null), drop: dropFiles } });
  // Text dropped on the window (files come through the app, below): into the message.
  document.addEventListener("dragover", (e) => {
    const types = e.dataTransfer?.types ?? [];
    if (types.includes("text/plain") && !types.includes("Files")) e.preventDefault();
  });
  document.addEventListener("drop", (e) => {
    const dt = e.dataTransfer;
    if (!dt || dt.types.includes("Files")) return;
    const dropped = dt.getData("text/plain");
    if (!dropped.trim()) return;
    e.preventDefault();
    dropText(dropped);
  });
  // Files and folders dropped on the window (the app gives their paths).
  if (backend.kind === "tauri") {
    const { getCurrentWebview } = await import("@tauri-apps/api/webview");
    await getCurrentWebview().onDragDropEvent((e) => {
      const p = e.payload;
      if (p.type === "enter") {
        dragging = p.paths.length;
        // Files dragged over the window, whichever tab: Pet Post → Send.
        if (dragging) showTab();
        if (dragging && tab !== "send") tab = "send";
        render();
      } else if (p.type === "leave") {
        dragging = 0;
        render();
      } else if (p.type === "drop") dropFiles(p.paths);
    });
  }
  settings = await backend.getSettings();
  onLanguage(() => render());
  status = await backend.postStatus().catch(() => null);
  devices = await backend.postDevices().catch(() => []);
  await backend.on("settings", (s) => {
    settings = s;
    render();
  });
  await backend.on("post-status", (s) => {
    status = s;
    render();
  });
  await backend.on("post-devices", (d) => {
    devices = d;
    for (const fp of [...shareDismissed]) if (!d.some((x) => x.fingerprint === fp && x.sharing)) shareDismissed.delete(fp);
    // (Typing meanwhile: the cursor is put back, see remember().)
    render();
  });
  await backend.on("post-verify", (fp) => (showTab(), verify(fp)));
  await backend.on("post-pair", (fp) => (showTab(), pair({ fingerprint: fp, alias: devices.find((d) => d.fingerprint === fp)?.alias ?? "" })));
  await backend.on("post-history", (list) => {
    history = list;
    render();
  });
  await backend.on("post-offer", (o) => {
    offer = o;
    // Wherever it was, the question is on Receive.
    tab = "receive";
    render();
  });
  await backend.on("post-tab", (x) => (showTab(), show(x)));
  await backend.on("post-offer-closed", (c) => {
    if (offer?.id !== c.id) return;
    offer = null;
    render();
  });
  await backend.on("post-transfer", (tr) => {
    if (tr.direction === "in") {
      if (!incoming || transferOver(incoming)) inRate.push(0);
      inRate.push(tr.done);
      incoming = tr;
      render();
      if (transferOver(tr)) fetchingShare = false;
      // Done: said for a moment, then the card goes. Not all of it got here: it stays (Close).
      if (transferOver(tr) && !(tr.tally?.failed || partialLine(tr))) setTimeout(() => incoming === tr && ((incoming = null), render()), 6000);
      return;
    }
    // How a delivery from the pet goes is the pet's to say; this window shows its own.
    if (!mine) return;
    if (tr.state === "waiting") outRate.push(0);
    outRate.push(tr.done);
    transfer = tr;
    // A text that got there: the box is emptied (unless something else was typed meanwhile).
    if (tr.state === "done" && mine.text !== null && draft === mine.text) draft = "";
    if (tr.direction === "out" && transferOver(tr) && tr.state !== "pin") {
      lastText = mine.text !== null;
      mine = null;
    }
    // All of it got there: said for a moment, then the box goes (History has it).
    if (tr.state === "done") setTimeout(() => transfer === tr && ((transfer = null), render()), 5000);
    render();
  });
  offer = await backend.postPendingOffer().catch(() => null);
  if (offer) tab = "receive";
  history = await backend.postHistory().catch(() => []);
  await loadInbox(inboxContext);
  await backend.on("post-schedule", () => void loadInbox(inboxContext));
  await backend.on("post-schedule-inbox", () => void loadInbox(inboxContext));
  // The offer's countdown (only its line).
  setInterval(() => {
    const line = root.querySelector(".post-offer-countdown");
    if (offer && line) line.textContent = countdown(offer);
    const p = pairing;
    tickPair(root);
    if (p && p.stage === "expired") render();
  }, 1000);
  render();
  if (settings.post.enabled && !devices.length) lookAgain();
  // Opened for Verify (the pet's "Verify…" on a delivery), or on a tab ("send").
  ready = true;
  const first = pendingOpen || opened;
  pendingOpen = "";
  if (first) applyOpened(first);
}
