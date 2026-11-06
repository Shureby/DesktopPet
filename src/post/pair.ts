/**
 * Pet Post → Pair (docs/INTERACTIONS.md, "Pairing ePets"): asks the other ePet to show a
 * 6-digit code, and you type it here. One go per code: a wrong one ends it (pair again
 * for a new one).
 */
import { t } from "../i18n";
import { withPaired } from "../features/post/post";
import { withNick } from "../features/post/schedule";
import type { Backend, PostPairAsk, PostPairResult, Settings } from "../platform/types";
import { h } from "../panel/dom";

export interface PairContext {
  backend: Backend;
  render(): void;
  /** Saves the settings (the window keeps what's saved). */
  saved(s: Settings): void;
  /** Back to the list with this device chosen, on Send. */
  sendTo(fingerprint: string): void;
  /** Verify instead (an ePet that can't pair). */
  verify(fingerprint: string, alias: string): void;
}

type Stage = "asking" | "shown" | "finishing" | Exclude<PostPairAsk["answer"], "shown"> | Exclude<PostPairResult, "invalid">;

export interface Pairing {
  fingerprint: string;
  alias: string;
  stage: Stage;
  until: number;
  code: string;
  /** Typed something that isn't 6 digits. */
  invalid: boolean;
  /** Paired: the nickname typed (and whether it's saved). */
  nick: string;
  nickSaved: boolean;
}

export let pairing: Pairing | null = null;

/** Starts pairing with a device: asks it to show a code. */
export function startPair(ctx: PairContext, fingerprint: string, alias: string): void {
  const p: Pairing = { fingerprint: fingerprint.toUpperCase(), alias, stage: "asking", until: 0, code: "", invalid: false, nick: "", nickSaved: false };
  pairing = p;
  ctx.render();
  void ctx.backend
    .postPairAsk(p.fingerprint)
    .catch((): PostPairAsk => ({ answer: "unreachable" }))
    .then((a) => {
      if (pairing !== p) return;
      p.stage = a.answer === "shown" ? "shown" : a.answer;
      p.until = a.until ?? Date.now() + 120_000;
      ctx.render();
      focusCode();
    });
}

function focusCode(): void {
  requestAnimationFrame(() => document.querySelector<HTMLInputElement>(".post-pair-code")?.focus());
}

async function finish(ctx: PairContext, p: Pairing): Promise<void> {
  const digits = p.code.replace(/[\s-]/g, "");
  if (!/^\d{6}$/.test(digits)) {
    p.invalid = true;
    ctx.render();
    return;
  }
  p.stage = "finishing";
  ctx.render();
  const r = await ctx.backend.postPairFinish(p.fingerprint, digits).catch((): PostPairResult => "unreachable");
  if (pairing !== p) return;
  if (r === "paired") {
    const cur = await ctx.backend.getSettings();
    ctx.saved(await ctx.backend.setSettings({ post: withPaired(cur.post, { fingerprint: p.fingerprint, alias: p.alias }) }));
  }
  p.stage = r === "invalid" ? "shown" : r;
  p.invalid = r === "invalid";
  ctx.render();
}

export function closePair(ctx: PairContext, tell = true): void {
  const p = pairing;
  pairing = null;
  // Stopped before typing it: the code there goes.
  if (tell && p && (p.stage === "shown" || p.stage === "asking")) void ctx.backend.postPairCancel(p.fingerprint);
  ctx.render();
}

/** "1:42" */
export function left(until: number, now = Date.now()): string {
  const s = Math.max(0, Math.ceil((until - now) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** The countdown, once a second (only its line). */
export function tickPair(root: HTMLElement): void {
  const p = pairing;
  const line = root.querySelector(".post-pair-left");
  if (!p || p.stage !== "shown" || !line) return;
  if (Date.now() > p.until) {
    p.stage = "expired";
    line.textContent = "";
    return;
  }
  line.textContent = t("Expires in {time}", { time: left(p.until) });
}

export function pairView(ctx: PairContext): Node {
  const p = pairing!;
  const name = p.alias;
  const close = h("button", { class: "post-pair-close", onclick: () => closePair(ctx) }, t("Close"));
  const again = h("button", { class: "primary post-pair-again", onclick: () => startPair(ctx, p.fingerprint, p.alias) }, t("Pair again"));
  const card = (cls: string, title: string, lines: string[], ...buttons: Node[]) =>
    h("div", { class: `box post-pair-card ${cls}` }, h("p", { class: "title" }, title), ...lines.map((l) => h("p", { class: "hint" }, l)), h("div", { class: "row" }, ...buttons));
  let body: Node;
  switch (p.stage) {
    case "asking":
      body = card("", `⏳ ${t("Asking {name} to show a code…", { name })}`, [], h("button", { onclick: () => closePair(ctx) }, t("Cancel")));
      break;
    case "shown":
    case "finishing": {
      const busy = p.stage === "finishing";
      const input = h("input", {
        class: "post-pair-code",
        type: "text",
        inputmode: "numeric",
        autocomplete: "one-time-code",
        maxlength: 7,
        placeholder: "••••••",
        "aria-label": t("Pairing code"),
        value: p.code,
        disabled: busy,
        oninput: (e: Event) => {
          p.code = (e.target as HTMLInputElement).value;
          p.invalid = false;
          const ready = /^\d{6}$/.test(p.code.replace(/[\s-]/g, ""));
          document.querySelector<HTMLButtonElement>(".post-pair-go")?.toggleAttribute("disabled", !ready);
        },
        onkeydown: (e: KeyboardEvent) => {
          if (e.key === "Enter") void finish(ctx, p);
          if (e.key === "Escape") closePair(ctx);
        },
      });
      const ready = /^\d{6}$/.test(p.code.replace(/[\s-]/g, ""));
      body = h(
        "div",
        { class: "box post-pair-card" },
        h("p", { class: "hint" }, t("{name} shows a 6-digit code now. Type it here:", { name })),
        input,
        p.invalid ? h("p", { class: "warning post-pair-invalid" }, t("Type the 6 digits.")) : null,
        h(
          "div",
          { class: "row" },
          h("button", { class: "primary post-pair-go", disabled: busy || !ready, onclick: () => void finish(ctx, p) }, busy ? t("Checking…") : t("Pair")),
          h("button", { class: "post-pair-cancel", disabled: busy, onclick: () => closePair(ctx) }, t("Cancel")),
          h("span", { class: "hint post-pair-left grow" }, busy ? "" : t("Expires in {time}", { time: left(p.until) })),
        ),
        h("p", { class: "hint" }, t("A friend's computer: ask them to read you the number (by phone or in a chat).")),
      );
      break;
    }
    case "paired": {
      const saveNick = async () => {
        const cur = await ctx.backend.getSettings();
        ctx.saved(await ctx.backend.setSettings({ post: withNick(cur.post, p.fingerprint, p.nick) }));
        p.nickSaved = true;
        ctx.render();
      };
      body = h(
        "div",
        {},
        card(
          "post-pair-done",
          `✓ ${t("Paired with {name}", { name })}`,
          [t("From now on, what you send to {name} reaches only this {name}. If its identity ever changes, Pet Post warns you and doesn't send.", { name })],
          h("button", { class: "primary post-pair-send", onclick: () => ((pairing = null), ctx.sendTo(p.fingerprint)) }, t("Send files…")),
          h("button", { class: "post-pair-close", onclick: () => closePair(ctx, false) }, t("Done")),
        ),
        // A name for it that only you see (Dad, Work laptop): reminders it sends say it.
        h(
          "div",
          { class: "box post-pair-nick" },
          h("p", { class: "title" }, t("Give it a name?")),
          h(
            "div",
            { class: "row" },
            h("input", {
              type: "text",
              class: "post-pair-nick-input",
              maxlength: 40,
              placeholder: t("e.g. Dad"),
              value: p.nick,
              oninput: (e: Event) => ((p.nick = (e.target as HTMLInputElement).value), (p.nickSaved = false)),
              onkeydown: (e: KeyboardEvent) => e.key === "Enter" && void saveNick(),
            }),
            h("button", { class: "post-pair-nick-save", onclick: () => void saveNick() }, p.nickSaved ? `✓ ${t("Saved")}` : t("Save")),
          ),
          h("p", { class: "hint" }, t("Only you see it. Reminders and anniversaries it sends you show this name.")),
        ),
      );
      break;
    }
    case "wrong":
      body = card(
        "warning post-pair-wrong",
        `✗ ${t("The code didn't match. This pairing is cancelled.")}`,
        [t("Pair again for a new code. If you're sure you typed it right, someone may be pretending to be {name}: don't pair for now.", { name })],
        again,
        close,
      );
      break;
    case "expired":
      body = card("post-pair-expired", t("The code expired."), [t("Pair again for a new one.")], again, close);
      break;
    case "declined":
      body = card("post-pair-declined", t("{name} declined to pair.", { name }), [], close);
      break;
    case "busy":
      body = card("post-pair-busy", t("{name} is pairing with another device. Try again in a minute.", { name }), [], again, close);
      break;
    case "later":
      body = card("warning post-pair-later", t("Too many wrong codes: {name} takes no pairing from this computer for 10 minutes.", { name }), [], close);
      break;
    case "refused":
      body = card("warning post-pair-refused", t("{name} refused: it may have blocked this computer.", { name }), [], close);
      break;
    case "unsupported":
      body = card(
        "post-pair-unsupported",
        t("{name} can't pair: it needs ePet 0.54 or newer.", { name }),
        [t("You can Verify it instead: compare the icons on both screens.")],
        h("button", { class: "primary", onclick: () => ((pairing = null), ctx.verify(p.fingerprint, p.alias)) }, t("Verify")),
        close,
      );
      break;
    default:
      body = card("post-pair-unreachable", t("Couldn't reach {name}.", { name }), [], again, close);
  }
  return h(
    "div",
    { class: "post-pair-view" },
    h("header", { class: "post-head" }, h("h2", {}, `🔗 ${t("Pair")}`), h("p", { class: "hint" }, t("With {name}", { name }))),
    body,
    h("p", { class: "hint" }, t("Pairing checks once that it really is {name}: the code never crosses the network. After that the two ePets remember each other and send only to each other's identity.", { name })),
  );
}
