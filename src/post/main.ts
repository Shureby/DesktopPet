/**
 * The Pet Post window (docs/INTERACTIONS.md, "Pet Post"): devices found nearby (and added
 * by address), sending them files, a folder or a text, how it goes, what arrived while
 * it's open, and Verify (the same icons on both screens). The pet asks about deliveries to
 * you (src/pet/courier.ts); the settings are in the panel.
 */
import { backend, type Settings } from "../platform";
import { t, onLanguage } from "../i18n";
import { followLocale } from "../i18n/apply";
import { followTestClock } from "../platform/testClock";
import product from "../../product.config.json";
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
  verifiedMark,
  withBlocked,
  withVerified,
  withoutVerified,
  type PostVerifyAnswer,
} from "../features/post/post";
import "../styles/panel.css";

const root = document.getElementById("post")!;

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
  /** They match: marked verified. */
  matched: boolean;
  /** They don't match: "Block …?" is up. */
  confirm: boolean;
} | null = null;

let sendFailed = "";

function send(paths: string[], text: string | null, pin: string | null = null): void {
  if (!selected) return;
  mine = { to: selected, paths, text };
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

async function forget(d: PostDevice): Promise<void> {
  const cur = await backend.getSettings();
  settings = await backend.setSettings({ post: { ...cur.post, devices: cur.post.devices.filter((x) => x.fingerprint !== d.fingerprint) } });
  if (selected === d.fingerprint) selected = null;
  render();
}

function verify(fingerprint: string, alias = ""): void {
  const fp = fingerprint.toUpperCase();
  const v: NonNullable<typeof verifying> = { fingerprint: fp, alias, code: null, mode: "icons", error: "", asked: "", mismatch: false, matched: false, confirm: false };
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
  v.matched = true;
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
  const paths = await backend.postPick(folder);
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

function deviceRow(d: PostDevice): Node {
  const can = sendable(d);
  const where = [sourceLabel(d, settings.post), d.deviceModel, d.address ?? d.ip].filter(Boolean).join(" · ");
  const state = d.changedTo ? t("⚠ Another device answers there now.") : !d.online ? t("Not answering.") : "";
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
      h("strong", {}, d.alias, verifiedBadge(d.fingerprint)),
      h("span", { class: "hint" }, where),
      state ? h("span", { class: `post-device-state${d.changedTo ? " warning" : ""}` }, state) : null,
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
    d.https && can
      ? h("button", { class: "small post-verify", title: t("Verify: compare with what the other device shows"), onclick: (e: Event) => (e.stopPropagation(), verify(d.fingerprint)) }, icon(VERIFIED_USER), t("Verify"))
      : null,
    settings.post.devices.some((x) => x.fingerprint === d.fingerprint && x.via === "address")
      ? h("button", { class: "small post-forget", title: t("Remove"), "aria-label": t("Remove"), onclick: (e: Event) => (e.stopPropagation(), void forget(d)) }, "✕")
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
      h("button", { class: "small post-address-copy", onclick: () => copyText(text(current)) }, t("Copy")),
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
  return ([
    ...(cards.length ? cards : [ready]),
    ...[addressPicker()].filter((n): n is Node => n !== null),
    saveDirLine(),
    h("h3", {}, t("Latest")),
    latest ? h("ul", { class: "post-received" }, receivedRow(latest)) : h("p", { class: "hint" }, t("Nothing received yet.")),
    history.length > 1 ? h("p", { class: "hint" }, h("a", { href: "#", class: "post-to-history", onclick: (e: Event) => (e.preventDefault(), show("history")) }, t("All of it: 🕘 History"))) : null,
    recentList(),
  ] as (Node | null)[]).filter((n): n is Node => n !== null);
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
    h("p", { class: "row" }, h("button", { class: "primary post-verify-done", onclick: () => ((verifying = null), render()) }, t("Done"))),
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
  } else if (v.matched) {
    line("post-verify-matched", `✓ ${t("{name} is marked as verified.", { name })}`);
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

/** A delivery coming in: how far, and Stop receiving. */
function incomingCard(): Node | null {
  const tr = incoming;
  if (!tr) return null;
  const over = transferOver(tr);
  const rows: Node[] = [h("p", { class: over && tr.state !== "done" ? "warning" : "" }, ...named(transferLine(tr, NAME), tr.peer, tr.fingerprint))];
  if (!over) {
    rows.push(
      h("progress", { max: 1000, value: Math.floor((tr.done / Math.max(1, tr.total)) * 1000) }),
      h("p", { class: "hint post-rate" }, [`${formatSize(tr.done)} / ${formatSize(tr.total)} · ${fileCount(tr.files)}`, inRate.line(tr)].filter(Boolean).join(" · ")),
      h("button", { class: "post-stop-receiving", onclick: () => void backend.postStopReceiving() }, t("Stop receiving")),
    );
  }
  return h("div", { class: "box post-incoming" }, ...rows);
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
      h("div", { class: "row" }, h("span", { class: "grow post-received-text" }, r.text), h("button", { class: "small", onclick: () => copyText(r.text!) }, t("Copy"))),
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
  if (!over && tr.state !== "waiting")
    rows.push(bar, h("p", { class: "hint post-rate" }, [`${formatSize(tr.done)} / ${formatSize(tr.total)} · ${fileCount(tr.files)}`, outRate.line(tr)].filter(Boolean).join(" · ")));
  if (tr.direction === "out" && !over && mine) rows.push(h("button", { onclick: () => void backend.postCancelSend() }, t("Cancel")));
  if (tr.direction === "out" && tr.state === "pin" && mine) {
    const input = h("input", { type: "text", class: "post-pin-input", placeholder: t("PIN"), autocomplete: "off" });
    const go = () => {
      const pin = input.value.trim();
      if (pin && mine) send(mine.paths, mine.text, pin);
    };
    input.addEventListener("keydown", (e) => e.key === "Enter" && go());
    rows.push(h("div", { class: "row" }, input, h("button", { class: "primary", onclick: go }, t("Send"))));
    setTimeout(() => input.focus());
  }
  return h("div", { class: "box post-progress" }, ...rows);
}

function render(): void {
  document.title = t("Pet Post");
  if (verifying) {
    root.replaceChildren(verifyView());
    return;
  }
  const on = settings.post.enabled;
  const head = h(
    "header",
    { class: "post-head row" },
    h("h2", { class: "grow" }, `📦 ${t("Pet Post")}`),
    h("a", { href: "#", class: "post-settings-link", onclick: (e: Event) => (e.preventDefault(), void backend.openPanel("settings")) }, `⚙ ${t("Settings…")}`),
  );
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
    { class: "post-tabs", role: "tablist" },
    ...TABS.map((x) =>
      h(
        "button",
        { class: `post-tab${tab === x.id ? " active" : ""}`, "data-tab": x.id, role: "tab", "aria-selected": String(tab === x.id), onclick: () => show(x.id) },
        `${x.icon} ${x.label()}`,
        x.id === "receive" && offer && tab !== "receive" ? h("span", { class: "post-tab-badge" }, "1") : null,
      ),
    ),
  );
  const state =
    status?.running || !status?.error ? null : h("p", { class: "warning" }, t("Couldn't start: {error}", { error: status.error }));
  const body = tab === "receive" ? receiveTab() : tab === "send" ? sendTab() : historyTab();
  const focus = remember();
  root.replaceChildren(head, tabs, ...(state ? [state] : []), h("div", { class: "post-tab-body" }, ...body));
  focus();
}

/** The Send tab: devices (found, added by address), files, a folder or a text, and how it goes. */
function sendTab(): Node[] {
  const busy = !!transfer && !transferOver(transfer);
  const text = h("textarea", { class: "post-text", rows: 3, placeholder: t("A message, a link…") }) as HTMLTextAreaElement;
  text.value = draft;
  text.addEventListener("input", () => (draft = text.value));
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
      { class: "row wrap post-send" },
      h("button", { class: "primary post-files", disabled: !selected || busy, onclick: () => void pick(false) }, `📄 ${t("Send files…")}`),
      h("button", { class: "post-folder", disabled: !selected || busy, onclick: () => void pick(true) }, `📁 ${t("Send a folder…")}`),
    ),
    h("p", { class: "hint" }, t("Or drop files on the pet.")),
    text,
    h(
      "div",
      { class: "row" },
      h(
        "button",
        {
          class: "small",
          onclick: async () => {
            draft = (await navigator.clipboard.readText().catch(() => "")) || draft;
            render();
          },
        },
        t("Paste"),
      ),
      h(
        "button",
        {
          class: "post-send-text",
          disabled: !selected || busy,
          onclick: () => {
            if (!draft.trim()) return text.focus();
            send([], draft);
          },
        },
        t("Send text"),
      ),
    ),
    ...[sendFailed ? h("p", { class: "warning post-send-failed" }, sendFailed) : null, progress()].filter((n): n is Node => n !== null),
  ];
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

async function main(): Promise<void> {
  await followTestClock(backend, () => render());
  settings = await backend.getSettings();
  await followLocale(backend, settings);
  onLanguage(() => render());
  document.title = product.productName;
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
    // (Typing meanwhile: the cursor is put back, see remember().)
    render();
  });
  await backend.on("post-verify", (fp) => verify(fp));
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
  await backend.on("post-tab", (x) => show(x));
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
      // Done or stopped: said for a moment, then the card goes.
      if (transferOver(tr)) setTimeout(() => incoming === tr && ((incoming = null), render()), 6000);
      return;
    }
    // How a delivery from the pet goes is the pet's to say; this window shows its own.
    if (!mine) return;
    if (tr.state === "waiting") outRate.push(0);
    outRate.push(tr.done);
    transfer = tr;
    if (tr.direction === "out" && transferOver(tr) && tr.state !== "pin") mine = null;
    render();
  });
  offer = await backend.postPendingOffer().catch(() => null);
  if (offer) tab = "receive";
  history = await backend.postHistory().catch(() => []);
  // The offer's countdown (only its line).
  setInterval(() => {
    const line = root.querySelector(".post-offer-countdown");
    if (offer && line) line.textContent = countdown(offer);
  }, 1000);
  render();
  if (settings.post.enabled && !devices.length) lookAgain();
  // Opened for Verify (the pet's "Verify…" on a delivery), or on a tab ("#send").
  const asked = /^#verify=([0-9A-Fa-f]+)$/.exec(location.hash)?.[1];
  if (asked) verify(asked);
  const opened = /^#(receive|send|history)$/.exec(location.hash)?.[1] as Tab | undefined;
  if (opened) show(opened);
}

void main();
