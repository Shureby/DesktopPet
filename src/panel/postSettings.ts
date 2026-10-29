/**
 * Settings → Pet Post (docs/INTERACTIONS.md, "Pet Post"): on or off, the name others see,
 * where received files go, trusted devices, an optional PIN, and beyond this network:
 * how others reach this computer (and the router door), devices added by address, extra
 * networks to look in, and Tailscale. Sending is in the
 * Pet Post window (and by dropping files on the pet).
 */
import { t } from "../i18n";
import type { Backend, Settings } from "../platform/types";
import {
  parseNetwork,
  withoutFavorite,
  withoutBlocked,
  withoutPaired,
  withoutVerified,
  postAlias,
  shortFingerprint,
  tailnetLine,
  reachLines,
  DOOR_OFF,
  type MarkedDevice,
  type PostDoor,
  type PostDevice,
  type PostSettings,
  type PostStatus,
  type PostTailnet,
} from "../features/post/post";
import { nickOf, rulesOf, SHARE_KINDS, withNick, withRule, type ShareKind, type ShareRule } from "../features/post/schedule";
import { formatWhen, h } from "./dom";

/** Paired ePets whose details (nickname, what they send) are open. */
const openPaired = new Set<string>();

/** Opens a paired ePet's details (the pet's "Name it…" after pairing). */
export function openPairedDetails(fingerprint: string): void {
  openPaired.add(fingerprint.toUpperCase());
}

/** Lines of "Also look in these networks" that aren't one (shown until fixed; the page is redrawn on saving). */
let badNetworks: string[] = [];

export function postSection(backend: Backend, get: () => Settings, save: (patch: Partial<Settings>) => Promise<void>, petName: () => string): Node {
  const root = h("div", { class: "box post-settings" });
  let status: PostStatus | null = null;
  let tailnet: PostTailnet = { state: "", online: 0 };
  let devices: PostDevice[] = [];
  const tailnetText = h("p", { class: "hint post-tailnet" });
  const showTailnet = () => {
    tailnetText.textContent = get().post.tailscale ? tailnetLine(tailnet, devices.filter((d) => d.source === "tailnet").length) : "";
  };
  const update = (patch: Partial<PostSettings>) => save({ post: { ...get().post, ...patch } }).then(() => poll());

  // How others reach this computer, and the router door: redrawn on its own (devices,
  // the door and Tailscale change while the page is open).
  let door: PostDoor = DOOR_OFF;
  let askingPublic = false;
  const reach = h("div", { class: "post-reach" });
  const showReach = () => {
    const s = get().post;
    const mark = (ok: boolean | null) => (ok === true ? "✓" : ok === false ? "✗" : "·");
    const lines = reachLines(status, devices, s.door ? door : DOOR_OFF, tailnet, s.tailscale);
    const doorButtons: Node[] = [];
    if (s.door && (door.state === "none" || door.state === "refused"))
      doorButtons.push(h("button", { class: "small post-door-retry", onclick: () => void backend.postDoorRetry() }, t("Try again")));
    if (s.door && door.state === "open") doorButtons.push(h("button", { class: "small post-door-close", onclick: () => void update({ door: false, doorPublic: false }) }, t("Close it now")));
    if (s.door && door.state === "public" && !askingPublic)
      doorButtons.push(h("button", { class: "small post-door-public", onclick: () => ((askingPublic = true), showReach()) }, t("Open it anyway…")));
    const publicAsk =
      s.door && door.state === "public" && askingPublic
        ? [
            h(
              "div",
              { class: "post-door-ask" },
              h("p", { class: "post-door-ask-title" }, t("This door opens to the internet")),
              h("p", {}, t("The router's outside address is {ip}, a public one. Anyone on the internet could then reach Pet Post and ask to send you files.", { ip: door.externalIp ?? "" })),
              h("p", { class: "hint" }, t("Better: set a PIN, and accept only from favorites. To let in another network of your home, this usually isn't needed.")),
              h(
                "div",
                { class: "row" },
                h("button", { class: "small", onclick: () => ((askingPublic = false), showReach()) }, t("Don't")),
                h("button", { class: "small primary post-door-public-yes", onclick: () => ((askingPublic = false), void update({ doorPublic: true })) }, t("Open it anyway")),
              ),
            ),
          ]
        : [];
    reach.replaceChildren(
      h(
        "ul",
        { class: "post-reach-lines" },
        ...lines.map((l) =>
          h(
            "li",
            { class: `post-reach-${l.kind} ${l.ok === true ? "ok" : l.ok === false ? "bad" : ""} ${l.sub ? "sub" : ""}` },
            h("span", { class: "mark" }, mark(l.ok)),
            h("b", {}, l.title),
            h("span", { class: "hint" }, l.detail),
            ...(l.kind === "door" ? doorButtons.map((b) => h("div", { class: "row" }, b)) : []),
          ),
        ),
      ),
      ...publicAsk,
      h(
        "label",
        { class: "check" },
        h("input", {
          type: "checkbox",
          class: "post-door",
          checked: s.door,
          onchange: () => void update({ door: !s.door, doorPublic: false }),
        }),
        t("Let the router open a door for Pet Post"),
      ),
      h(
        "p",
        { class: "hint" },
        t("When this computer is behind a second router, devices on the network outside it can then get in. Opened by itself only when that's still a home network; when it's the internet, you're asked."),
      ),
    );
  };

  const draw = () => {
    const s = get().post;
    showTailnet();
    showReach();
    const state = h("p", { class: "hint post-state" });
    if (s.enabled && status?.running)
      state.textContent =
        status.port === 53317
          ? t("On: others see this computer as “{name}”.", { name: status.alias })
          : t("On: others see this computer as “{name}” (port {port}: {usual} is taken by another app).", { name: status.alias, port: status.port, usual: 53317 });
    else if (s.enabled && status?.error) {
      state.textContent = t("Couldn't start: {error}", { error: status.error });
      state.classList.add("warning");
    } else if (s.enabled) state.textContent = t("Starting…");
    else state.textContent = t("Off: ePet doesn't listen on the network.");

    const placeholder = postAlias({ ...s, alias: "" }, petName(), status?.computer ?? "");
    const trusted = s.trusted.length
      ? h(
          "ul",
          { class: "trusted" },
          ...s.trusted.map((d) =>
            h(
              "li",
              { class: "row" },
              h("span", { class: "grow", title: d.fingerprint }, d.alias || d.fingerprint.slice(0, 12)),
              h(
                "button",
                {
                  class: "small",
                  onclick: () => void save({ post: withoutFavorite(get().post, d.fingerprint) }).then(() => poll()),
                },
                t("Remove"),
              ),
            ),
          ),
        )
      : h("p", { class: "hint" }, t("None yet. Click ♡ by a device in Pet Post, or choose “Always accept” when it sends you something."));

    /** Verified or blocked devices, each with a button that takes it off the list. */
    const marks = (list: MarkedDevice[], css: string, when: (d: MarkedDevice) => string, label: string, without: (fp: string) => PostSettings, none: string) =>
      list.length
        ? h(
            "ul",
            { class: `trusted ${css}` },
            ...list.map((d) =>
              h(
                "li",
                { class: "row" },
                h("span", { class: "grow", title: d.fingerprint }, h("span", {}, d.alias || shortFingerprint(d.fingerprint)), h("span", { class: "hint" }, ` · ${when(d)} · ${shortFingerprint(d.fingerprint)}`)),
                h("button", { class: "small", onclick: () => void save({ post: without(d.fingerprint) }).then(() => poll()) }, label),
              ),
            ),
          )
        : h("p", { class: "hint" }, none);

    const kindLabel: Record<ShareKind, string> = { alarm: `⏰ ${t("Reminders")}`, todo: `☑️ ${t("To-dos")}`, anniversary: `🎂 ${t("Anniversaries")}` };
    const ruleLabel: [ShareRule, string][] = [
      ["ask", t("Ask me")],
      ["auto", t("Add|rule")],
      ["refuse", t("Don't take")],
    ];
    /** Paired ePets: a nickname (only seen here) and what happens to what each sends. */
    const pairedList = () =>
      s.paired.length
        ? h(
            "ul",
            { class: "trusted post-paired-list" },
            ...s.paired.map((d) => {
              const fp = d.fingerprint;
              const nick = nickOf(s, fp);
              const open = openPaired.has(fp);
              const rules = rulesOf(s, fp);
              const toggle = () => {
                if (open) openPaired.delete(fp);
                else openPaired.add(fp);
                draw();
              };
              return h(
                "li",
                { class: "post-paired-item", "data-fingerprint": fp, "data-section": `paired-${fp}` },
                h(
                  "div",
                  { class: "row" },
                  h(
                    "span",
                    { class: "grow", title: fp },
                    h("span", {}, nick || d.alias || shortFingerprint(fp)),
                    h("span", { class: "hint" }, `${nick ? ` ${d.alias}` : ""} · ${t("Paired {when} with a code", { when: formatWhen(d.at) })} · ${shortFingerprint(fp)}`),
                  ),
                  h("button", { class: "small post-paired-more", "aria-expanded": String(open), onclick: toggle }, open ? t("Done") : t("Name, what it sends…")),
                  h("button", { class: "small", onclick: () => void save({ post: withoutPaired(get().post, fp) }).then(() => poll()) }, t("Unpair")),
                ),
                open
                  ? h(
                      "div",
                      { class: "post-paired-detail" },
                      h(
                        "label",
                        { class: "row" },
                        h("span", { class: "lbl" }, t("Nickname")),
                        h("input", {
                          type: "text",
                          class: "post-paired-nick",
                          maxLength: 40,
                          value: nick,
                          placeholder: t("e.g. Dad"),
                          onchange: (e: Event) => void save({ post: withNick(get().post, fp, (e.target as HTMLInputElement).value) }).then(() => poll()),
                        }),
                        h("span", { class: "hint" }, t("Only you see it")),
                      ),
                      h("div", { class: "lbl" }, t("What it sends you")),
                      h(
                        "table",
                        { class: "post-rules" },
                        h("tr", {}, h("th", {}), ...ruleLabel.map(([, l]) => h("th", {}, l))),
                        ...SHARE_KINDS.map((kind) =>
                          h(
                            "tr",
                            { "data-kind": kind },
                            h("td", {}, kindLabel[kind]),
                            ...ruleLabel.map(([rule, l]) =>
                              h(
                                "td",
                                {},
                                h("input", {
                                  type: "radio",
                                  name: `rule-${fp}-${kind}`,
                                  value: rule,
                                  "aria-label": `${kindLabel[kind]}: ${l}`,
                                  checked: rules[kind] === rule,
                                  onchange: () => void save({ post: withRule(get().post, fp, kind, rule) }).then(() => poll()),
                                }),
                              ),
                            ),
                          ),
                        ),
                      ),
                      h("p", { class: "hint" }, t("Added without asking, your pet still says so, with Undo. One you changed here is always asked about when it's updated.")),
                    )
                  : null,
              );
            }),
          )
        : h("p", { class: "hint" }, t("None yet. In Pet Post, choose Pair by an ePet and type the code it shows."));

    root.replaceChildren(
      h(
        "label",
        { class: "check" },
        h("input", {
          type: "checkbox",
          class: "post-enabled",
          checked: s.enabled,
          onchange: () => void update({ enabled: !s.enabled }),
        }),
        t("Send and receive files on this network"),
      ),
      h("p", { class: "hint" }, t("Works with LocalSend on phones and computers, and with ePet on other computers. Drop files on the pet to send them.")),
      state,
      // The system asks once whether ePet may use the network (a firewall); "no" hides it.
      ...(s.enabled ? [h("p", { class: "hint" }, t("Others can't find this computer? Check that your firewall lets ePet use the network."))] : []),
      // The rest once it's on.
      ...(s.enabled
        ? [
            h(
              "label",
              { class: "row spread" },
              h("span", { class: "label" }, t("Name")),
              h("input", {
                type: "text",
                class: "post-alias",
                maxLength: 64,
                value: s.alias,
                placeholder,
                onchange: (e: Event) =>
                  void update({
                    alias: (e.target as HTMLInputElement).value.trim(),
                  }),
              }),
            ),
            h(
              "div",
              { class: "row" },
              h("span", { class: "label" }, t("Save to")),
              h("span", { class: "grow path", title: status?.saveDir ?? "" }, s.saveDir || status?.saveDir || ""),
            ),
            h(
              "div",
              { class: "row" },
              h(
                "button",
                {
                  class: "small",
                  onclick: async () => {
                    const dir = await backend.postPickSaveDir();
                    if (dir) await update({ saveDir: dir });
                  },
                },
                t("Change…"),
              ),
              h("button", { class: "small", onclick: () => void backend.postOpen(null) }, t("Open folder")),
            ),
            h("hr"),
            h(
              "label",
              { class: "check" },
              h("input", {
                type: "checkbox",
                checked: s.autoAcceptTrusted,
                onchange: () => void update({ autoAcceptTrusted: !s.autoAcceptTrusted }),
              }),
              t("Accept from favorites without asking"),
            ),
            h("p", { class: "hint" }, t("Everyone else: the pet asks you each time.")),
            h("div", { class: "subhead" }, `♥ ${t("Favorites")}`),
            trusted,
            h(
              "label",
              { class: "row spread" },
              h("span", { class: "label" }, t("PIN")),
              h("input", {
                type: "text",
                class: "post-pin",
                maxLength: 32,
                value: s.pin,
                placeholder: t("None"),
                autocomplete: "off",
                onchange: (e: Event) =>
                  void update({
                    pin: (e.target as HTMLInputElement).value.trim(),
                  }),
              }),
            ),
            h("p", { class: "hint" }, t("With a PIN, senders must type it before they can send you anything.")),
            h("div", { class: "subhead" }, t("Paired ePets")),
            pairedList(),
            h("div", { class: "subhead" }, t("Verified devices")),
            marks(s.verified, "post-verified-list", (d) => t("Verified {when}", { when: formatWhen(d.at) }), t("Remove"), (fp) => withoutVerified(get().post, fp), t("None yet. In Pet Post, Verify a device and choose “They match”.")),
            h("div", { class: "subhead" }, t("Blocked devices")),
            marks(s.blocked, "post-blocked-list", (d) => t("Blocked {when} · the icons didn't match", { when: formatWhen(d.at) }), t("Unblock"), (fp) => withoutBlocked(get().post, fp), t("None.")),
            h("hr"),
            h("div", { class: "subhead" }, t("How others reach this computer")),
            reach,
            h("div", { class: "subhead" }, t("Beyond this network")),
            h("p", { class: "hint" }, t("Devices are found on this network by themselves. Others (behind another router, on Tailscale) can be added by address in Pet Post.")),
            ...(s.devices.length
              ? [
                  h(
                    "ul",
                    { class: "trusted post-saved" },
                    ...s.devices.map((d) =>
                      h(
                        "li",
                        { class: "row" },
                        h("span", { class: "grow", title: d.fingerprint }, `${d.alias && d.alias !== d.address ? `${d.alias} (${d.address})` : d.address}${d.port === 53317 ? "" : `:${d.port}`}`),
                        h("button", { class: "small", onclick: () => void update({ devices: get().post.devices.filter((x) => x.fingerprint !== d.fingerprint) }) }, t("Remove")),
                      ),
                    ),
                  ),
                ]
              : []),
            h("label", { class: "label", for: "post-networks" }, t("Also look in these networks")),
            h("textarea", {
              id: "post-networks",
              class: "post-networks",
              rows: 2,
              spellcheck: false,
              placeholder: "192.168.8.0/24",
              value: [...s.networks, ...badNetworks].join("\n"),
              onchange: (e: Event) => {
                const lines = (e.target as HTMLTextAreaElement).value.split(/[\n,;]+/).map((l) => l.trim()).filter(Boolean);
                const good = lines.map(parseNetwork).filter((n): n is string => !!n);
                badNetworks = lines.filter((l) => !parseNetwork(l));
                void update({ networks: [...new Set(good)] });
              },
            }),
            badNetworks.length
              ? h("p", { class: "warning post-networks-bad" }, t("Not a network: {list}. Write it like 192.168.8.0/24 (up to /22).", { list: badNetworks.join(", ") }))
              : h("p", { class: "hint" }, t("One per line, such as 192.168.8.0/24 (behind another router). Asked each time Pet Post looks.")),
            h(
              "label",
              { class: "check" },
              h("input", {
                type: "checkbox",
                class: "post-tailscale",
                checked: s.tailscale,
                onchange: () => void update({ tailscale: !s.tailscale }),
              }),
              t("List the devices of my Tailscale network"),
            ),
            tailnetText,
          ]
        : []),
      h("button", { onclick: () => void backend.openPostWindow() }, t("Open Pet Post…")),
    );
  };

  // Until it says it's listening (or why not): the pet window starts it after the save.
  // The panel may build the page a moment before showing it, so this keeps going until
  // the section has been shown and then replaced (or for half a minute).
  let shown = false;
  let tries = 0;
  const poll = async () => {
    status = await backend.postStatus().catch(() => status);
    shown ||= root.isConnected;
    draw();
    const starting = get().post.enabled && !status?.running && !status?.error;
    const stopping = !get().post.enabled && status?.running;
    const gone = shown && !root.isConnected;
    if ((starting || stopping) && !gone && ++tries < 60) setTimeout(() => void poll(), 500);
  };
  void poll();
  void backend.on("post-status", (st) => {
    status = st;
    draw();
  });
  void backend.on("post-tailnet", (tn) => {
    tailnet = tn;
    showTailnet();
    showReach();
  });
  void backend.on("post-devices", (d) => {
    devices = d;
    showTailnet();
    showReach();
  });
  void backend.on("post-door", (d) => {
    door = d;
    if (d.state !== "public") askingPublic = false;
    showReach();
  });
  void backend.postTailnet().then((tn) => ((tailnet = tn), showTailnet(), showReach())).catch(() => {});
  void backend.postDevices().then((d) => ((devices = d), showTailnet(), showReach())).catch(() => {});
  void backend.postDoor().then((d) => ((door = d), showReach())).catch(() => {});
  draw();
  return root;
}
