/**
 * Settings → Pet Post (docs/INTERACTIONS.md, "Pet Post"): on or off, the name others see,
 * where received files go, trusted devices and an optional PIN. Sending is in the Pet
 * Post window (and by dropping files on the pet).
 */
import { t } from "../i18n";
import type { Backend, Settings } from "../platform/types";
import { postAlias, type PostSettings, type PostStatus } from "../features/post/post";
import { h } from "./dom";

export function postSection(backend: Backend, get: () => Settings, save: (patch: Partial<Settings>) => Promise<void>, petName: () => string): Node {
  const root = h("div", { class: "box post-settings" });
  let status: PostStatus | null = null;
  const update = (patch: Partial<PostSettings>) => save({ post: { ...get().post, ...patch } }).then(() => poll());

  const draw = () => {
    const s = get().post;
    const state = h("p", { class: "hint post-state" });
    if (s.enabled && status?.running)
      state.textContent = t("On: others see this computer as “{name}”.", {
        name: status.alias,
      });
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
          ]
        : []),
      h("button", { onclick: () => void backend.openPostWindow() }, t("Open Pet Post…")),
    );
  };

  // Until it says it's listening (or why not): the pet window starts it after the save.
  const poll = async () => {
    status = await backend.postStatus().catch(() => status);
    if (root.isConnected || !status) draw();
    const starting = get().post.enabled && !status?.running && !status?.error;
    const stopping = !get().post.enabled && status?.running;
    if ((starting || stopping) && (root.isConnected || !root.parentNode)) setTimeout(() => void poll(), 500);
  };
  void poll();
  void backend.on("post-status", (st) => {
    status = st;
    if (root.isConnected) draw();
  });
  draw();
  return root;
}
