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
import { h } from "../panel/dom";
import { copyText } from "../pet/courier";
import { VERIFY_ICONS } from "../features/post/verifyIcons";
import {
  addError,
  DEVICE_ICONS,
  LOCALSEND_PORT,
  sendable,
  sendError,
  sourceLabel,
  fileCount,
  formatSize,
  percent,
  transferLine,
  transferOver,
  type PostDevice,
  type PostStatus,
  type PostTransfer,
  type PostVerify,
  type SavedDevice,
} from "../features/post/post";
import "../styles/panel.css";

const root = document.getElementById("post")!;
let settings: Settings;
let status: PostStatus | null = null;
let devices: PostDevice[] = [];
let selected: string | null = null;
/** Sending from this window: what, so a PIN can be given (and how it goes is shown here). */
let mine: { to: string; paths: string[]; text: string | null } | null = null;
let transfer: PostTransfer | null = null;
/** Files and texts received while the window is open, newest first. */
const received: ({ files: PostTransfer } | { text: string; from: string })[] = [];
let looking = false;
let draft = "";
/** Adding a device by address: the form is open, and how it went. */
let adding: { address: string; port: string; state: "" | "busy" | "done" | "failed"; message: string; firewall: boolean } | null = null;
/** Verify shown for a device. */
let verifying: { fingerprint: string; code: PostVerify | null; mode: "icons" | "text"; error: string } | null = null;

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
  const saved: SavedDevice = { address: d.address ?? d.ip, port: d.port, fingerprint: d.fingerprint, alias: d.alias, deviceType: d.deviceType };
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

function verify(fingerprint: string): void {
  verifying = { fingerprint: fingerprint.toUpperCase(), code: null, mode: "icons", error: "" };
  render();
  backend
    .postVerify(fingerprint)
    .then((code) => {
      if (verifying?.fingerprint === fingerprint.toUpperCase()) verifying.code = code;
    })
    .catch(() => verifying && (verifying.error = t("Pet Post is off.")))
    .finally(render);
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
  setTimeout(() => {
    looking = false;
    render();
  }, 4000);
}

function deviceRow(d: PostDevice): Node {
  const can = sendable(d);
  const where = [sourceLabel(d), d.deviceModel, d.address ?? d.ip].filter(Boolean).join(" · ");
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
      h("strong", {}, d.alias),
      h("span", { class: "hint" }, where),
      state ? h("span", { class: `post-device-state${d.changedTo ? " warning" : ""}` }, state) : null,
      d.changedTo
        ? h(
            "span",
            { class: "row" },
            h("button", { class: "small post-trust-new", onclick: (e: Event) => (e.stopPropagation(), void trustNew(d)) }, t("It's mine: use the new one")),
          )
        : null,
    ),
    d.https && can
      ? h("button", { class: "small post-verify", title: t("Verify: compare with what the other device shows"), onclick: (e: Event) => (e.stopPropagation(), verify(d.fingerprint)) }, `🛡 ${t("Verify")}`)
      : null,
    d.address
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
    h("header", { class: "post-head" }, h("h2", {}, `🛡 ${t("Verify")}`), h("p", { class: "hint" }, t("With {name}", { name: d?.alias ?? v.fingerprint.slice(0, 12) }))),
    h("div", { class: "row post-verify-modes" }, mode("icons", t("Icons")), mode("text", t("Text"))),
    body,
    h("p", {}, t("Does it look the same on the other device?")),
    h("p", { class: "hint" }, t("In LocalSend: the device (or the delivery from this computer), then Verify. In ePet: Pet Post → Verify.")),
    h("p", { class: "row" }, h("button", { class: "primary post-verify-done", onclick: () => ((verifying = null), render()) }, t("Done"))),
  );
}

function progress(): Node | null {
  const tr = transfer;
  if (!tr) return null;
  const over = transferOver(tr);
  const bar = h("progress", { max: 100, value: percent(tr) });
  const rows: Node[] = [h("p", { class: over && tr.state !== "done" ? "warning" : "" }, transferLine(tr))];
  if (!over && tr.state !== "waiting") rows.push(bar, h("p", { class: "hint" }, `${formatSize(tr.done)} / ${formatSize(tr.total)} · ${fileCount(tr.files)}`));
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
  const busy = !!transfer && !transferOver(transfer);
  const head = h(
    "header",
    { class: "post-head" },
    h("h2", {}, `📦 ${t("Pet Post")}`),
    h(
      "p",
      { class: "hint" },
      on && status?.running ? t("This computer is “{name}”.", { name: status.alias }) : on ? t("Starting…") : t("Pet Post is off."),
      " ",
      h("a", { href: "#", onclick: (e: Event) => (e.preventDefault(), void backend.openPanel("settings")) }, t("Settings…")),
    ),
  );
  if (!on) {
    root.replaceChildren(
      head,
      h(
        "div",
        { class: "box" },
        h("p", {}, t("Send files and text to phones and computers nearby, and get theirs.")),
        h("p", { class: "hint" }, t("Works with LocalSend on phones and computers, and with ePet on other computers.")),
        h("button", { class: "primary post-turn-on", onclick: () => void turnOn() }, t("Turn on")),
      ),
    );
    return;
  }
  const text = h("textarea", { class: "post-text", rows: 3, placeholder: t("A message, a link…") }) as HTMLTextAreaElement;
  text.value = draft;
  text.addEventListener("input", () => (draft = text.value));
  root.replaceChildren(
    head,
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
    ...(received.length
      ? [
          h("h3", {}, t("Received")),
          h(
            "ul",
            { class: "post-received" },
            ...received.map((r) =>
              "files" in r
                ? h(
                    "li",
                    { class: "row" },
                    h("span", { class: "grow" }, t("{files} from {who}", { files: fileCount(r.files.files), who: r.files.peer })),
                    h("button", { class: "small", onclick: () => void backend.postOpen(r.files.first) }, t("Show")),
                  )
                : h(
                    "li",
                    { class: "row" },
                    h("span", { class: "grow post-received-text" }, `💬 ${r.from}: ${r.text}`),
                    h("button", { class: "small", onclick: () => copyText(r.text) }, t("Copy")),
                  ),
            ),
          ),
        ]
      : []),
    h("p", { class: "row" }, h("button", { class: "small", onclick: () => void backend.postOpen(null) }, t("Open the received files folder"))),
  );
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
    // Typing in the add form: not redrawn under the cursor.
    if (!adding || !(document.activeElement instanceof HTMLInputElement)) render();
  });
  await backend.on("post-verify", (fp) => verify(fp));
  await backend.on("post-text", (m) => {
    // The pet shows it too; here it stays, to copy.
    received.unshift({ text: m.text, from: m.alias });
    render();
  });
  await backend.on("post-transfer", (tr) => {
    if (tr.direction === "in" && tr.state === "done") received.unshift({ files: tr });
    // How a delivery from the pet goes is the pet's to say; this window shows its own.
    if (tr.direction === "out" && !mine) return;
    transfer = tr;
    if (tr.direction === "out" && transferOver(tr) && tr.state !== "pin") mine = null;
    render();
  });
  render();
  if (settings.post.enabled && !devices.length) lookAgain();
  // Opened for Verify (the pet's "Verify…" on a delivery).
  const asked = /^#verify=([0-9A-Fa-f]+)$/.exec(location.hash)?.[1];
  if (asked) verify(asked);
}

void main();
