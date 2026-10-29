/**
 * The pet as Pet Post's courier (docs/INTERACTIONS.md, "Pet Post"): drop files on it to
 * send them; when someone sends you files it carries the parcel and asks; a text message
 * shows in its bubble. The network side is the app's (src-tauri/src/post/).
 */
import { t } from "../i18n";
import type { Backend, Settings } from "../platform";
import {
  DEVICE_ICONS,
  fileCount,
  formatSize,
  largeDelivery,
  markedName,
  isBlocked,
  sendable,
  sendError,
  withFavorite,
  withPaired,
  missedOfferTitle,
  offerLines,
  percent,
  postAlias,
  postConfig,
  transferLine,
  transferOver,
  type PostDevice,
  type PostOffer,
  type PostStatus,
  type PostText,
  type PostTransfer,
} from "../features/post/post";
import { deviceName, kindWord, type ScheduleTaken } from "../features/post/schedule";

export interface CourierAction {
  label: string;
  run: () => void;
  /** Leaves the bubble (and its question) up. */
  keep?: boolean;
}

/** What the courier needs from the pet (PetHost). */
export interface CourierHost {
  readonly backend: Backend;
  settings(): Settings;
  petName(): string;
  /** A bubble (see PetHost.say): with `onTimeout` it waits for an answer like an alarm. */
  say(text: string | string[], ms: number, actions?: CourierAction[], onTimeout?: () => void, important?: boolean): void;
  /** Takes the bubble down if it still starts with `first`. */
  unsay(first: string): void;
  /** Asks for a line of text in the bubble (a PIN). */
  ask(title: string, label: string, submit: (value: string) => void): void;
  /** Nothing is ringing or being asked: a question can be shown now. */
  free(): boolean;
  /** Hidden by the user. */
  hidden(): boolean;
  /** Stepped aside (a presentation, a call, a full-screen app). */
  away(): boolean;
  /** Quiet mode: no sounds, and the hidden pet doesn't come out. */
  quiet(): boolean;
  /** The hidden pet comes out for a delivery. */
  comeOut(): Promise<void>;
  /** A short sound (unless the mode is silent): someone sends something, or (`received`) a delivery is in. */
  chime(received?: boolean): void;
  /** Into "While I was hidden you missed:". */
  recordMissed(title: string): Promise<void>;
  /** The badges changed. */
  redraw(): void;
}

/** A 📦 badge by the pet while something is on its way. */
export interface CourierBadge {
  text: string;
  title: string;
  onClick: () => void;
}

/** How long the app waits for an answer (src-tauri/src/post/server.rs, ANSWER_SECONDS). */
const ANSWER_MS = 60_000;

export class Courier {
  private status: PostStatus | null = null;
  private devices: PostDevice[] = [];
  private transfer: PostTransfer | null = null;
  /** A delivery the pet started (it asks for a PIN and reports how it went). */
  private mine: { to: string; paths: string[]; text: string | null } | null = null;
  /** The offer being asked about (its bubble's first line). */
  private asking: { offer: PostOffer; first: string } | null = null;
  /** Offers waiting for the bubble (an alarm is ringing). */
  private waiting: PostOffer[] = [];
  private lastConfig = "";

  constructor(private readonly host: CourierHost) {}

  async start(): Promise<void> {
    const b = this.host.backend;
    await b.on("post-status", (s) => (this.status = s));
    await b.on("post-devices", (d) => {
      this.devices = d;
      void this.onSharing(d);
    });
    await b.on("post-offer", (o) => void this.onOffer(o));
    await b.on("post-offer-closed", (c) => this.onClosed(c.id, c.reason));
    await b.on("post-text", (m) => void this.onText(m));
    await b.on("post-verify-asked", (a) => void this.onVerifyAsked(a.fingerprint, a.alias));
    await b.on("post-verify-ask-closed", (a) => this.onVerifyAskClosed(a.fingerprint));
    await b.on("post-pair-asked", (a) => void this.onPairAsked(a.fingerprint, a.alias, a.code, a.until));
    await b.on("post-pair-closed", (c) => this.onPairClosed(c.fingerprint, c.reason));
    await b.on("post-paired", (p) => void this.onPaired(p.fingerprint, p.alias));
    await b.on("post-schedule", (x) => void this.onSchedule(x));
    await b.on("post-transfer", (tr) => this.onTransfer(tr));
    this.status = await b.postStatus().catch(() => null);
    await this.configure();
    setInterval(() => this.askWaiting(), 1000);
  }

  /** Tells the app the settings (when they or the pet's name change). */
  async configure(): Promise<void> {
    const s = this.host.settings();
    const computer = this.status?.computer ?? "";
    const config = postConfig(s.post, postAlias(s.post, this.host.petName(), computer));
    const key = JSON.stringify(config);
    if (key === this.lastConfig) return;
    this.lastConfig = key;
    try {
      this.status = await this.host.backend.postConfigure(config);
      if (s.post.enabled) this.devices = await this.host.backend.postDevices();
    } catch (e) {
      console.warn("Pet Post:", e);
    }
  }

  badge(): CourierBadge | null {
    const tr = this.transfer;
    if (!tr) return null;
    return {
      text: tr.state === "waiting" ? "📦 …" : `📦 ${percent(tr)}%`,
      title: transferLine(tr),
      onClick: () => void this.host.backend.openPostWindow(null, tr.direction === "in" ? "receive" : "send"),
    };
  }

  // --- Sending ------------------------------------------------------------------------

  /** Files dropped on the pet. */
  dropped(paths: string[]): void {
    if (!paths.length) return;
    if (!this.host.settings().post.enabled) {
      this.host.say(
        [t("Pet Post is off."), t("Turn it on to send files to phones and computers nearby (works with LocalSend).")],
        15_000,
        [
          { label: t("Turn on"), run: () => void this.enable().then(() => this.deliver(paths)) },
          { label: t("Not now"), run: () => {} },
        ],
      );
      return;
    }
    void this.deliver(paths);
  }

  private async enable(): Promise<void> {
    const b = this.host.backend;
    const s = await b.getSettings();
    await b.setSettings({ post: { ...s.post, enabled: true } });
  }

  /** Who to deliver to: up to four devices as buttons. */
  private async deliver(paths: string[], looked = false): Promise<void> {
    const b = this.host.backend;
    // Turned on just now: the settings reach the app first.
    await this.configure();
    this.devices = (await b.postDevices().catch(() => [])).filter(sendable);
    if (!this.devices.length) {
      if (!looked) {
        void b.postRefresh();
        this.host.say(t("Looking for someone to deliver to…"), 4000);
        setTimeout(() => void this.deliver(paths, true), 3500);
        return;
      }
      this.host.say([t("I can't find anyone nearby."), t("The other device needs LocalSend or ePet open, on the same network.")], 15_000, [
        { label: t("Look again"), run: () => void this.deliver(paths) },
        { label: t("Pet Post…"), run: () => void b.openPostWindow(null, "send") },
      ]);
      return;
    }
    const name = paths[0].split(/[\\/]/).pop() ?? paths[0];
    const what = paths.length === 1 ? `“${name}”` : t("{n} items", { n: paths.length });
    const shown = this.devices.slice(0, 4);
    // A great many files (or much data): said, so a disk dropped by mistake is noticed.
    const m = await b.postMeasure(paths).catch(() => null);
    const title = m && largeDelivery(m) ? [t("Deliver {what} to…", { what }), `⚠ ${t("That's {files}, {size} in all.", { files: fileCount(m.files), size: formatSize(m.bytes) })}`] : t("Deliver {what} to…", { what });
    this.host.say(title, 30_000, [
      ...shown.map((d) => ({ label: `${DEVICE_ICONS[d.deviceType] ?? "💻"} ${markedName(this.host.settings().post, d.alias, d.fingerprint)}`, run: () => this.send(d.fingerprint, paths, null) })),
      ...(this.devices.length > shown.length ? [{ label: t("More…"), run: () => void b.openPostWindow(null, "send") }] : []),
      { label: t("Cancel"), run: () => {} },
    ]);
  }

  private send(to: string, paths: string[], text: string | null, pin: string | null = null): void {
    this.mine = { to, paths, text };
    this.host.backend.postSend(to, paths, text, pin).catch((e) => {
      this.mine = null;
      this.host.say(sendError(String(e)), 8000);
    });
  }

  // --- Receiving ----------------------------------------------------------------------

  private async onOffer(o: PostOffer): Promise<void> {
    // The Pet Post window is open: it asks too; the hidden pet stays hidden (it would only
    // ask the same), and the window's taskbar button flashes if it's behind others.
    const window = await this.host.backend.postWindowShown().catch(() => false);
    if (window) void this.host.backend.postAttention();
    if (window && this.host.hidden() && !this.host.away()) {
      this.host.chime();
      return;
    }
    // Not now (a presentation, a call; or hidden in Quiet mode): declined, and you're told later.
    if (this.host.away() || (this.host.hidden() && this.host.quiet())) {
      void this.host.backend.postAnswer(o.id, false);
      void this.host.recordMissed(missedOfferTitle(o));
      return;
    }
    if (this.host.hidden()) await this.host.comeOut();
    this.waiting.push(o);
    this.askWaiting();
  }

  private askWaiting(): void {
    if (this.asking || !this.waiting.length || !this.host.free()) return;
    this.ask(this.waiting.shift()!);
  }

  private ask(o: PostOffer): void {
    const lines = offerLines(o, markedName(this.host.settings().post, o.alias, o.fingerprint));
    this.asking = { offer: o, first: lines[0] };
    const answer = (accept: boolean) => {
      this.asking = null;
      void this.host.backend.postAnswer(o.id, accept);
    };
    const s = this.host.settings();
    const trusted = s.post.trusted.some((d) => d.fingerprint === o.fingerprint);
    const actions: CourierAction[] = [
      { label: t("Accept"), run: () => answer(true) },
      { label: t("Decline"), run: () => answer(false) },
    ];
    // Compared on both screens (LocalSend's Verify), meanwhile the question stays.
    if (o.fingerprint) {
      actions.push({ label: t("Verify…"), keep: true, run: () => void this.host.backend.openPostWindow(o.fingerprint) });
    }
    // Only a device that proved who it is can be trusted (its certificate).
    if (o.fingerprint && !trusted) {
      actions.push({
        label: t("Always accept"),
        run: () => {
          answer(true);
          // A favorite (kept at the address it's at now, if it's listed).
          const d = this.devices.find((x) => x.fingerprint === o.fingerprint);
          void this.host.backend.getSettings().then((cur) =>
            this.host.backend.setSettings({ post: withFavorite(cur.post, d ?? { fingerprint: o.fingerprint, alias: o.alias }) }),
          );
        },
      });
    }
    // Answered by the app's own timeout if nobody does (post-offer-closed).
    this.host.say(lines, ANSWER_MS + 5000, actions, () => (this.asking = null), true);
    this.host.chime();
  }

  private onClosed(id: string, reason: "cancelled" | "timeout" | "answered"): void {
    const waiting = this.waiting.find((o) => o.id === id);
    this.waiting = this.waiting.filter((o) => o.id !== id);
    const offer = this.asking?.offer.id === id ? this.asking.offer : waiting;
    if (this.asking?.offer.id === id) {
      this.host.unsay(this.asking.first);
      this.asking = null;
    }
    if (offer && reason === "timeout") void this.host.recordMissed(missedOfferTitle(offer));
  }

  private async onText(m: PostText): Promise<void> {
    const short = m.text.length > 280 ? `${m.text.slice(0, 280)}…` : m.text;
    if (this.host.away() || (this.host.hidden() && this.host.quiet())) {
      void this.host.recordMissed(t("{who}: “{text}”", { who: m.alias, text: short.length > 60 ? `${short.slice(0, 60)}…` : short }));
      return;
    }
    if (this.host.hidden()) await this.host.comeOut();
    this.showText(m, short);
    this.host.chime();
  }

  /** A text received, with Copy (said whether it worked) and OK. */
  private showText(m: PostText, short: string, failed = false): void {
    const lines = [t("💬 {who} says:", { who: m.alias }), short];
    if (failed) lines.push(t("Couldn't copy it. Try again?"));
    this.host.say(lines, 60_000, [
      {
        label: t("Copy"),
        run: () =>
          void copyText(this.host.backend, m.text).then((ok) =>
            ok ? this.host.say(t("📋 Copied to the clipboard."), 2500) : this.showText(m, short, true),
          ),
      },
      { label: t("OK"), run: () => {} },
    ], undefined, true);
  }

  /** Devices sharing files by link already told about (until they stop sharing). */
  private sharingTold = new Set<string>();

  /**
   * A device started sharing files by link (LocalSend's Share via link): the pet says so,
   * and See them opens Pet Post where they're listed. (The window open: it shows them.)
   */
  private async onSharing(list: PostDevice[]): Promise<void> {
    for (const fp of [...this.sharingTold]) if (!list.some((d) => d.fingerprint === fp && d.sharing)) this.sharingTold.delete(fp);
    const s = this.host.settings();
    const fresh = list.filter((d) => d.sharing && !this.sharingTold.has(d.fingerprint) && !isBlocked(s.post, d.fingerprint));
    if (!fresh.length) return;
    for (const d of fresh) this.sharingTold.add(d.fingerprint);
    const b = this.host.backend;
    if (await b.postWindowShown().catch(() => false)) {
      void b.postAttention();
      return;
    }
    if (this.host.away() || (this.host.hidden() && this.host.quiet()) || !this.host.free()) return;
    if (this.host.hidden()) await this.host.comeOut();
    const d = fresh[0];
    this.host.say(t("📤 {who} is sharing files with you.", { who: markedName(s.post, d.alias, d.fingerprint) }), 30_000, [
      { label: t("See them"), run: () => void b.openPostWindow(null, "receive") },
      { label: t("Not now"), run: () => {} },
    ], undefined, true);
    this.host.chime();
  }

  /** Questions about Verify up now (fingerprint → the bubble's first line). */
  private verifyAsks = new Map<string, string>();

  /**
   * Another ePet asks to compare Verify: Show (its icons open in Pet Post) or Decline; not
   * a window out of the blue. Away, or hidden in Quiet mode: declined.
   */
  private async onVerifyAsked(fingerprint: string, alias: string): Promise<void> {
    const b = this.host.backend;
    if (this.host.away() || (this.host.hidden() && this.host.quiet())) {
      void b.postVerifyAnswer(fingerprint, false);
      return;
    }
    if (this.host.hidden()) await this.host.comeOut();
    const first = t("{who} wants to verify with you.", { who: alias });
    this.verifyAsks.set(fingerprint, first);
    const answered = (show: boolean) => {
      this.verifyAsks.delete(fingerprint);
      void b.postVerifyAnswer(fingerprint, show);
      if (show) void b.openPostWindow(fingerprint);
    };
    this.host.say(first, 65_000, [
      { label: t("Show"), run: () => answered(true) },
      { label: t("Decline"), run: () => answered(false) },
    ], () => this.verifyAsks.delete(fingerprint), true);
    this.host.chime();
  }

  /** The question is over unanswered (it gave up, or a minute went by). */
  private onVerifyAskClosed(fingerprint: string): void {
    const first = this.verifyAsks.get(fingerprint);
    if (first === undefined) return;
    this.verifyAsks.delete(fingerprint);
    this.host.unsay(first);
  }

  // --- Pairing (docs/INTERACTIONS.md, "Pairing ePets") -------------------------------

  /** The bubble with a pairing code (its first line), by the asker's fingerprint. */
  private pairAsks = new Map<string, string>();

  /**
   * Another ePet asks to pair: the pet says the code to type there (the hidden pet comes
   * out). Stepped aside, or hidden in Quiet mode: declined.
   */
  private async onPairAsked(fingerprint: string, alias: string, code: string, until: number): Promise<void> {
    const b = this.host.backend;
    if (this.host.away() || (this.host.hidden() && this.host.quiet())) {
      void b.postPairDecline(fingerprint);
      return;
    }
    if (this.host.hidden()) await this.host.comeOut();
    const old = this.pairAsks.get(fingerprint);
    if (old) this.host.unsay(old);
    const first = `🔗 ${t("{who} wants to pair with this computer. Type this code there:", { who: alias })}`;
    this.pairAsks.set(fingerprint, first);
    this.host.say(
      [first, `${code.slice(0, 3)} ${code.slice(3)}`, t("Don't know it, or not pairing? Decline.")],
      Math.max(5000, until - Date.now()),
      [
        {
          label: t("Decline"),
          run: () => {
            this.pairAsks.delete(fingerprint);
            void b.postPairDecline(fingerprint);
          },
        },
      ],
      () => this.pairAsks.delete(fingerprint),
      true,
    );
    this.host.chime();
  }

  /** The code's bubble goes; a wrong code is said. */
  private onPairClosed(fingerprint: string, reason: string): void {
    const first = this.pairAsks.get(fingerprint);
    this.pairAsks.delete(fingerprint);
    if (first !== undefined) this.host.unsay(first);
    if (reason === "wrong" && first !== undefined) {
      const who = this.devices.find((d) => d.fingerprint === fingerprint)?.alias ?? "";
      this.host.say(t("Pairing with {who} didn't work: the code didn't match.", { who }), 8000);
    }
  }

  /** Paired: remembered (paired and verified), and said. */
  private async onPaired(fingerprint: string, alias: string): Promise<void> {
    const b = this.host.backend;
    const cur = await b.getSettings();
    await b.setSettings({ post: withPaired(cur.post, { fingerprint, alias }) });
    this.host.say([`✓ ${t("Paired with {who}.", { who: alias })}`, t("You can give it a name in Settings → Pet Post.")], 10_000, [
      { label: t("Name it…"), run: () => void b.openPanel(`settings:paired=${fingerprint}`) },
      { label: t("OK"), run: () => {} },
    ]);
  }

  // --- Alarms, to-dos and anniversaries sent here (docs/INTERACTIONS.md, "Sending reminders and anniversaries")

  /**
   * A paired ePet sent something: waiting for an answer (Show: Pet Post → Receive), added
   * without asking (Undo), or already here. Hidden, the pet doesn't come out for it: it
   * waits in "While I was hidden you missed…" (an invitation also waits in Pet Post).
   */
  private async onSchedule(x: ScheduleTaken): Promise<void> {
    const b = this.host.backend;
    const who = deviceName(this.host.settings().post, x.fingerprint, x.name);
    const what = kindWord(x.kind);
    const title = `“${x.title}”`;
    const first =
      x.what === "asked"
        ? `📨 ${t("{who} sent you {what}: {title}", { who, what, title })}`
        : x.what === "have"
          ? t("{who} sent {title} again: you already have it.", { who, title })
          : x.what === "updated"
            ? `✓ ${t("{who} updated {title}.", { who, title })}`
            : `✓ ${t("{who} added {what}: {title}", { who, what, title })}`;
    if (this.host.away() || this.host.hidden()) {
      if (x.what !== "have") await this.host.recordMissed(first);
      return;
    }
    if (x.what === "asked") {
      this.host.say([first, t("Add it?")], 30_000, [
        { label: t("Show"), run: () => void b.openPostWindow(null, "receive") },
        { label: t("Later"), run: () => {} },
      ]);
      this.host.chime();
    } else if (x.what === "have") {
      this.host.say(first, 6000);
    } else {
      const id = x.id;
      this.host.say(first, 15_000, [
        ...(x.what === "added" && id !== null ? [{ label: t("Undo"), run: () => void b.postScheduleUndo(x.kind, id) }] : []),
        { label: t("OK"), run: () => {} },
      ]);
      this.host.chime(true);
    }
  }

  private onTransfer(tr: PostTransfer): void {
    const line = (x: PostTransfer) => transferLine(x, markedName(this.host.settings().post, x.peer, x.fingerprint));
    const before = this.transfer;
    this.transfer = transferOver(tr) ? null : tr;
    this.host.redraw();
    const b = this.host.backend;
    if (tr.direction === "in") {
      if (tr.state === "done") this.host.chime(true);
      if (tr.state === "receiving" && !before) this.host.say(line(tr), 4000);
      else if (tr.state === "done")
        this.host.say(line(tr), 20_000, [
          { label: t("Show"), run: () => void b.postOpen(tr.first) },
          { label: t("OK"), run: () => {} },
        ], undefined, true);
      else if (transferOver(tr)) this.host.say(line(tr), 6000);
      return;
    }
    // Sent from the Pet Post window: the window says how it goes (the badge shows it too).
    const mine = this.mine;
    if (!mine) return;
    if (tr.state === "waiting") {
      this.host.say(line(tr), ANSWER_MS, [{ label: t("Cancel"), run: () => void b.postCancelSend() }]);
    } else if (tr.state === "sending" && before?.state === "waiting") {
      this.host.say(line(tr), 3000);
    } else if (tr.state === "pin") {
      this.host.ask(line(tr), t("PIN"), (pin) => this.send(mine.to, mine.paths, mine.text, pin));
    } else if (transferOver(tr)) {
      this.mine = null;
      this.host.say(line(tr), 6000);
    }
  }
}

/** Copies to the clipboard (with the old way as a fallback). */
/** Puts text on the clipboard (by the app; the page's own ways if that fails): whether it worked. */
export async function copyText(backend: Backend, text: string): Promise<boolean> {
  try {
    await backend.postCopyText(text);
    return true;
  } catch {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const area = Object.assign(document.createElement("textarea"), { value: text });
      document.body.append(area);
      area.select();
      const ok = document.execCommand("copy");
      area.remove();
      return ok;
    }
  }
}
