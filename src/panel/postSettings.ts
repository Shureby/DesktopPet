/**
 * Settings → Pet Post (docs/INTERACTIONS.md, "Pet Post"): on or off, the name others see,
 * where received files go, trusted devices, an optional PIN, and beyond this network:
 * devices added by address, extra networks to look in, and Tailscale. Sending is in the
 * Pet Post window (and by dropping files on the pet).
 */
import { t } from "../i18n";
import type { Backend, Settings } from "../platform/types";
import { parseNetwork, postAlias, tailnetLine, type PostDevice, type PostSettings, type PostStatus, type PostTailnet } from "../features/post/post";
import { h } from "./dom";

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

  const draw = () => {
    const s = get().post;
    showTailnet();
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
                  onclick: () =>
                    void update({
                      trusted: get().post.trusted.filter((x) => x.fingerprint !== d.fingerprint),
                    }),
                },
                t("Remove"),
              ),
            ),
          ),
        )
      : h("p", { class: "hint" }, t("None yet. Choose “Always accept” when a device sends you something."));

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
              t("Accept from trusted devices without asking"),
            ),
            h("p", { class: "hint" }, t("Everyone else: the pet asks you each time.")),
            h("div", { class: "subhead" }, t("Trusted devices")),
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
            h("hr"),
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
  });
  void backend.on("post-devices", (d) => {
    devices = d;
    showTailnet();
  });
  void backend.postTailnet().then((tn) => ((tailnet = tn), showTailnet())).catch(() => {});
  void backend.postDevices().then((d) => ((devices = d), showTailnet())).catch(() => {});
  draw();
  return root;
}
