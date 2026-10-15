/**
 * The Pet Post window (docs/INTERACTIONS.md, "Pet Post"): devices found nearby, sending
 * them files, a folder or a text, how it goes, and what arrived while it's open. The pet
 * asks about deliveries to you (src/pet/courier.ts); the settings are in the panel.
 */
import { backend, type Settings } from "../platform";
import { t, onLanguage } from "../i18n";
import { followLocale } from "../i18n/apply";
import { followTestClock } from "../platform/testClock";
import product from "../../product.config.json";
import { h } from "../panel/dom";
import { copyText } from "../pet/courier";
import {
  DEVICE_ICONS,
  fileCount,
  formatSize,
  percent,
  transferLine,
  transferOver,
  type PostDevice,
  type PostStatus,
  type PostTransfer,
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

function send(paths: string[], text: string | null, pin: string | null = null): void {
  if (!selected) return;
  mine = { to: selected, paths, text };
  backend.postSend(selected, paths, text, pin).catch(() => {
    mine = null;
    transfer = null;
    render();
  });
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

function deviceList(): Node {
  if (!devices.length) {
    return h(
      "div",
      { class: "box post-empty" },
      h("p", {}, looking ? t("Looking for devices…") : t("No one found yet.")),
      h("p", { class: "hint" }, t("The other device needs LocalSend or ePet open, on the same network (Wi-Fi).")),
    );
  }
  if (!selected || !devices.some((d) => d.fingerprint === selected)) selected = devices[0].fingerprint;
  return h(
    "ul",
    { class: "post-devices" },
    ...devices.map((d) =>
      h(
        "li",
        {
          class: `post-device${d.fingerprint === selected ? " selected" : ""}`,
          tabIndex: 0,
          role: "radio",
          "aria-checked": String(d.fingerprint === selected),
          onclick: () => {
            selected = d.fingerprint;
            render();
          },
        },
        h("span", { class: "icon" }, DEVICE_ICONS[d.deviceType] ?? "💻"),
        h("span", { class: "grow" }, h("strong", {}, d.alias), h("span", { class: "hint" }, [d.deviceModel, d.ip].filter(Boolean).join(" · "))),
      ),
    ),
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
    ...[progress()].filter((n): n is Node => n !== null),
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
    render();
  });
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
}

void main();
