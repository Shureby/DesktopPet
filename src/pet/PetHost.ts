import { HoverTracker } from "../brain/hover";
import { applyMoodEvent, isHungry, moodTier, parseMood, type MoodEvent } from "../brain/mood";
import { RulesBrain } from "../brain/RulesBrain";
import { Pet } from "../characters/Pet";
import type { CharacterRegistry, LoadedCharacter } from "../characters/registry";
import { createRng } from "../engine/random";
import { SpriteAtlas } from "../engine/sprites";
import {
  alarmName,
  alarmTime,
  clock,
  missedAlarms,
  timeRange,
  timerBadgeLine,
  onUnanswered,
  snoozedAlarms,
  visibleDoneTimers,
  type DoneTimer,
} from "../features/alarm/ringing";
import {
  activeTimers,
  durationInput,
  forgetCustomTimer,
  formatDuration,
  isTimer,
  parseDuration,
  rememberCustomTimer,
  replaceCustomTimer,
  timerLabel,
  timerName,
  TIMER_PREFIX,
} from "../features/alarm/timers";
import { formatRemaining } from "../features/pomodoro/logic";
import type { Alarm, Backend, PetActivity, PomodoroStatus, ReminderEvent, Settings } from "../platform";
import type { CareAction } from "../characters/schema";
import { buildTrayItems, nativeMenu, showPetMenu, type MenuContext } from "./menu";
import { inQuietHours } from "./quietHours";
import { playRingtone, ringAlarm, sounds } from "./sound";

const STEP = 1 / 30;
/**
 * Logical size of the pet window in Tauri mode (must match tauri.conf.json). Wide enough
 * for the badges beside the pet ("⏰ Missed 9:40 PM +1"); the empty parts click through.
 */
export const PET_WINDOW = { w: 340, h: 240 };

interface BubbleAction {
  label: string;
  run: () => void;
}

/**
 * Hosts one pet on the desktop: runs the fixed-step simulation, renders it,
 * moves the (Tauri) window, handles dragging/petting and shows reminders.
 *
 * In Tauri the canvas is a small transparent window that follows the pet.
 * In the browser mock the canvas fills the page and the pet moves inside it.
 */
export class PetHost {
  pet!: Pet;
  private atlas!: SpriteAtlas;
  private character!: LoadedCharacter;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly windowed: boolean;
  private settings: Settings;
  private pomodoro: PomodoroStatus = { phase: "idle", round: 0, endsAt: null };
  private hidden = false;
  private acc = 0;
  private last = performance.now();
  private framePending = false;
  private snapshotPending = false;
  private dpr = 1;
  private ignoringCursor = false;
  private drag: { pointerId: number; dx: number; dy: number; moved: boolean; sx: number; sy: number } | null = null;
  private bubbleTimer: ReturnType<typeof setTimeout> | undefined;
  private stopRinging: (() => void) | null = null;
  /** All alarms and timers (refreshed on alarms-changed). */
  private timers: Alarm[] = [];
  /** Timers that finished with nobody around: shown quietly for an hour. */
  private doneTimers: DoneTimer[] = [];
  /** Missed alarms the pet already told you about (the badge stays until clicked). */
  private announcedMissed = new Set<number>();
  /** The alarm currently ringing; `onTimeout` runs if nobody answers. */
  private activeRing: { onTimeout: () => void } | null = null;
  /** Alarms and timers in the ringing bubble (several can be due at once). */
  private ringing: number[] = [];
  /** The pet's line that heads a single alarm's ringing bubble. */
  private ringHeadline = "";
  /** When the ringing bubble gives up (a redraw with fresh data keeps this). */
  private ringEndsAt = 0;
  /** Reminders that came due while something was ringing (to-dos); shown next. */
  private queued: ReminderEvent[] = [];
  /** Until when an important bubble (a missed-alarm notice) can't be talked over. */
  private importantUntil = 0;
  /** Finished timers the pet already mentioned (their badge stays until it expires or is clicked). */
  private announcedDone = new Set<number>();
  /** The bubble is asking for a custom timer length; chatter must not replace it. */
  private prompting = false;
  private hovering = false;
  /** The cursor is on the pet itself (not its bubble or badges): shows the heart meter. */
  private overSprite = false;
  /** The mouse resting on the pet: stop, react, stroke (brain/hover.ts, docs/INTERACTIONS.md). */
  private readonly hover = new HoverTracker();
  /** What the hovered badge stands for (see updateBadgeInfo). */
  private readonly badgeInfo = Object.assign(document.createElement("div"), { className: "badge-info", hidden: true });
  /** False while the pet is hidden from its menu or the tray. */
  private petVisible = true;
  /** Tray menus still referenced: the current one and the one before (it may be open). */
  private trayMenus: { close(): Promise<void> }[] = [];
  private trayOutline = "";
  private trayTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly backend: Backend,
    private readonly registry: CharacterRegistry,
    private readonly canvas: HTMLCanvasElement,
    private readonly bubble: HTMLElement,
    /** Countdown badges (focus session, timers) next to the pet. */
    private readonly badges: HTMLElement,
    /** Heart/fullness meter shown while hovering the pet. */
    private readonly moodMeter: HTMLElement,
    settings: Settings,
  ) {
    this.ctx = canvas.getContext("2d", { willReadFrequently: false })!;
    this.windowed = backend.kind === "tauri";
    this.settings = settings;
  }

  async start(): Promise<void> {
    document.body.append(this.badgeInfo);
    const snap = await this.backend.desktopSnapshot();
    this.dpr = this.windowed ? window.devicePixelRatio || 1 : snap.scale;
    const area = snap.areas[0] ?? { x: 0, y: 0, w: 1280, h: 720 };
    await this.setCharacter(this.settings.character, area.x + area.w * (0.3 + Math.random() * 0.4), area.y + area.h * 0.3);
    this.pet.world = { areas: snap.areas, windows: snap.windows };

    this.resize();
    window.addEventListener("resize", () => this.resize());
    this.canvas.addEventListener("pointerdown", (e) => this.onPointerDown(e));
    this.canvas.addEventListener("pointermove", (e) => this.onPointerMove(e));
    this.canvas.addEventListener("pointerup", (e) => this.onPointerUp(e));
    this.canvas.addEventListener("contextmenu", (e) => this.onContextMenu(e));

    await this.backend.on("reminder", (r) => this.onReminder(r));
    await this.backend.on("pomodoro", (p) => {
      // Finishing a focus session makes the pet proud of you.
      if (this.pomodoro.phase === "focus" && (p.phase === "short_break" || p.phase === "long_break")) {
        this.moodEvent("focusDone");
      }
      this.pomodoro = p;
      this.updateMode();
      this.scheduleTray();
      this.pet.react({ type: "pomodoro", phase: p.phase });
      if (this.settings.sound) sounds.chime();
    });
    await this.backend.on("settings", (s) => {
      void this.applySettings(s);
      this.scheduleTray();
    });
    await this.backend.on("pet-visibility", (visible) => {
      this.petVisible = visible;
      if (!this.windowed) this.setHidden(!visible);
      this.scheduleTray();
    });
    await this.backend.on("game", (g) => this.setHidden(g.state === "started"));
    await this.backend.on("pet-command", (c) => {
      if (c === "greet") this.pet.react({ type: "greet" });
    });
    await this.backend.on("alarms-changed", () => void this.refreshTimers());
    await this.backend.on("pet-event", (e) => this.onActivity(e));
    await this.refreshTimers();
    // Timers that ran out leave the tray menu even if no event arrives (unchanged menus aren't rebuilt).
    setInterval(() => this.scheduleTray(), 30_000);
    // Mood is saved every minute and when leaving, not every tick.
    setInterval(() => void this.saveMood(), 60_000);
    window.addEventListener("beforeunload", () => void this.saveMood());
    this.pomodoro = await this.backend.pomodoroStatus();
    this.updateMode();
    setInterval(() => this.updateMode(), 30_000);
    setInterval(() => void this.refreshWorld(), 500);

    this.pet.react({ type: "greet" });
    requestAnimationFrame((t) => this.frame(t));
  }

  private async setCharacter(id: string, x: number, y: number): Promise<void> {
    if (this.pet) await this.saveMood();
    const c = this.registry.pick(id, "cat");
    const atlas = await SpriteAtlas.load(c.def.sprite, c.asset);
    const world = this.pet?.world;
    const brain = new RulesBrain();
    this.character = c;
    this.atlas = atlas;
    this.pet = new Pet(c.def, {
      brain,
      rng: createRng(Date.now() & 0xffffffff),
      unit: this.dpr * this.settings.size,
      speed: this.settings.speed,
      x,
      y,
    });
    if (world) this.pet.world = world;
    this.pet.onSay = (text, ms) => this.say(text, ms);
    try {
      this.pet.mood = parseMood(await this.backend.loadMood(c.def.id));
    } catch (e) {
      console.warn("Could not load mood", e);
    }
    this.updateMode();
  }

  private async applySettings(s: Settings): Promise<void> {
    const changedCharacter = s.character !== this.character.def.id;
    this.settings = s;
    if (changedCharacter) {
      const { x, y } = this.pet.body;
      await this.setCharacter(s.character, x, y - 1);
      this.pet.react({ type: "greet" });
    } else {
      this.pet.setUnit(this.dpr * s.size);
      this.pet.speed = s.speed;
    }
    this.updateMode();
  }

  private updateMode(): void {
    if (!this.pet) return;
    const q = this.settings.quietHours;
    this.pet.mode = this.hidden
      ? "hidden"
      : this.pomodoro.phase === "focus"
        ? "focus"
        : q.enabled && inQuietHours(new Date(), q.start, q.end)
          ? "quiet"
          : "free";
  }

  private setHidden(hidden: boolean): void {
    this.hidden = hidden;
    this.canvas.style.visibility = hidden ? "hidden" : "visible";
    this.updateMode();
  }

  private async refreshWorld(): Promise<void> {
    if (this.snapshotPending) return;
    this.snapshotPending = true;
    try {
      const snap = await this.backend.desktopSnapshot();
      this.pet.world = { areas: snap.areas, windows: snap.windows };
      // In the app the webview's own pixel ratio is the truth (checked every frame).
      if (!this.windowed && snap.scale !== this.dpr) this.setScale(snap.scale);
    } finally {
      this.snapshotPending = false;
    }
  }

  /**
   * Follows a display-scale change: Windows changing 100% → 150%, or the pet moving to a
   * monitor with another scale. Sprite size, canvas resolution and window size all follow.
   */
  private setScale(scale: number): void {
    this.dpr = scale;
    this.pet.setUnit(scale * this.settings.size);
    this.resize();
  }

  // --- Rendering & loop ---------------------------------------------------

  private resize(): void {
    const w = this.windowed ? PET_WINDOW.w : window.innerWidth;
    const h = this.windowed ? PET_WINDOW.h : window.innerHeight;
    const ratio = window.devicePixelRatio || 1;
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.canvas.width = Math.round(w * ratio);
    this.canvas.height = Math.round(h * ratio);
    this.ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  }

  /** CSS px per art pixel. */
  private get artScale(): number {
    return this.character.def.sprite.scale * this.settings.size;
  }

  /** Where the pet's feet are drawn, in canvas CSS px. */
  private feet(): { x: number; y: number } {
    if (this.windowed) return { x: PET_WINDOW.w / 2, y: PET_WINDOW.h - 2 };
    return { x: this.pet.body.x / this.dpr, y: this.pet.body.y / this.dpr };
  }

  private frame(now: number): void {
    const dt = Math.min(0.25, (now - this.last) / 1000);
    this.last = now;
    this.acc += dt;
    const ratio = window.devicePixelRatio || 1;
    if (this.windowed && ratio !== this.dpr) this.setScale(ratio);
    while (this.acc >= STEP) {
      // Dragging is a kinematic state, so updating is safe (physics is skipped).
      this.pet.update(STEP);
      this.acc -= STEP;
    }
    this.render();
    void this.syncWindow();
    requestAnimationFrame((t) => this.frame(t));
  }

  private render(): void {
    const w = this.canvas.width / (window.devicePixelRatio || 1);
    const h = this.canvas.height / (window.devicePixelRatio || 1);
    this.ctx.clearRect(0, 0, w, h);
    if (this.hidden) return;
    const f = this.feet();
    this.atlas.draw(this.ctx, this.pet.anim.frame, f.x, f.y, this.artScale, this.pet.facing);

    const spriteH = this.atlas.height * this.artScale;
    const place = (el: HTMLElement, dy: number, dx = 0) => {
      el.style.left = `${f.x + dx}px`;
      el.style.top = `${f.y - spriteH - dy}px`;
    };
    place(this.bubble, 8);
    // Left of the pet (badges are on the right), so it never hides behind the bubble.
    this.moodMeter.style.left = `${f.x - this.atlas.width * this.artScale / 2 - 4}px`;
    this.moodMeter.style.top = `${f.y - 2}px`;
    const spriteW = this.atlas.width * this.artScale;
    // Anchored at the feet and growing upward, so extra rows never fall off the window.
    const badgesLeft = f.x + spriteW / 2 + 4;
    this.badges.style.left = `${badgesLeft}px`;
    this.badges.style.top = `${f.y - 2}px`;
    // Never wider than the window: a long badge ends in "…" instead of being cut off mid-border.
    const viewW = this.windowed ? PET_WINDOW.w : window.innerWidth;
    this.badges.style.maxWidth = `${Math.max(40, viewW - badgesLeft - 4)}px`;
    this.renderBadges();
    this.moodMeter.hidden = !this.overSprite || !!this.drag;
  }

  /**
   * Stacked badges next to the pet: focus session, running timer, snoozed alarm,
   * then (quieter) a missed alarm (stays until clicked) and a finished timer
   * (disappears after an hour or on click).
   */
  private renderBadges(): void {
    const now = Date.now();
    // `live` rows count down: their text changes every second but the element is kept, so
    // a click never lands on an element that was just replaced.
    const rows: { text: string; cls?: string; title?: string; onClick?: () => void; live?: boolean }[] = [];
    const more = (n: number) => (n > 1 ? ` +${n - 1}` : "");
    // Hovering a badge shows what it stands for (updateBadgeInfo): what, then when, then
    // what a click does, on its own last line. Same shape for every badge.
    const info = (lines: string[], action: string) => [...lines, action].join("\n");
    const p = this.pomodoro;
    if (p.phase !== "idle" && p.endsAt) {
      const icon = p.phase === "focus" ? "🍅" : "☕";
      const pc = this.settings.pomodoro;
      const minutes = p.phase === "focus" ? pc.focusMin : p.phase === "short_break" ? pc.shortBreakMin : pc.longBreakMin;
      const name = p.phase === "focus" ? "Focus" : "Break";
      rows.push({
        text: `${icon} ${formatRemaining(p.endsAt - now)}`,
        title: info([`${name}   ${timeRange(p.endsAt - minutes * 60_000, p.endsAt)}`], "Open the Focus tab"),
        onClick: () => void this.backend.openPanel("focus"),
        live: true,
      });
    }
    const timers = activeTimers(this.timers, now);
    if (timers.length) {
      rows.push({
        text: `⏱ ${formatRemaining(timers[0].nextFire - now)}${more(timers.length)}`,
        // Every running timer, so "+5" isn't a mystery.
        title: info(timers.map(timerBadgeLine), "Open the Alarms tab"),
        onClick: () => void this.backend.openPanel("alarms"),
        live: true,
      });
    }
    const snoozed = snoozedAlarms(this.timers, now);
    if (snoozed.length) {
      const s = snoozed[0];
      rows.push({
        text: `💤 ${clock(s.nextFire)}${more(snoozed.length)}`,
        title: info([`${alarmName(s)} · snoozed ${s.snoozes}×`, `next ring ${clock(s.nextFire)}`], "Open the Alarms tab"),
        onClick: () => void this.backend.openPanel("alarms"),
      });
    }
    const missed = missedAlarms(this.timers);
    if (missed.length) {
      const m = missed[0];
      rows.push({
        // The alarm's own time (9:40), not when it was finally given up on (9:59).
        text: `⏰ Missed ${clock(alarmTime(m) ?? m.missedAt)}${more(missed.length)}`,
        cls: "missed",
        title: info([`${alarmName(m)}${m.snoozes ? ` · snoozed ${m.snoozes}×` : ""}`], "Click when you've seen it"),
        onClick: () => {
          // Seen: the badge goes (right away; the refresh confirms), the history keeps it.
          this.timers = this.timers.map((a) => (a.id === m.id ? { ...a, missedSeenAt: Date.now() } : a));
          void this.backend.acknowledgeMissed(m.id).then(() => this.refreshTimers());
        },
      });
    }
    const done = visibleDoneTimers(this.doneTimers, now);
    if (done.length) {
      rows.push({
        text: `⏱ Done ${clock(done[0].at)}${more(done.length)}`,
        cls: "quiet",
        title: info(
          done.map((t) => `${t.label.startsWith(TIMER_PREFIX) ? t.label.slice(TIMER_PREFIX.length) : t.label} timer · done ${clock(t.at)}`),
          "Click to dismiss",
        ),
        onClick: () => (this.doneTimers = []),
      });
    }
    const key = rows.map((r) => (r.live ? `live:${r.text.split(" ")[0]}` : r.text)).join("\n");
    if (this.badges.dataset.text === key) {
      rows.forEach((r, i) => {
        const el = this.badges.children[i];
        if (!r.live || !(el instanceof HTMLElement)) return;
        if (el.textContent !== r.text) el.textContent = r.text;
        if (r.title !== undefined && el.dataset.info !== r.title) el.dataset.info = r.title;
      });
    } else {
      this.badges.dataset.text = key;
      this.badges.replaceChildren(
        ...rows.map((r) => {
          const el = document.createElement("div");
          el.textContent = r.text;
          if (r.cls) el.className = r.cls;
          // Shown by updateBadgeInfo on hover (not `title`: see .badge-info in pet.css).
          if (r.title) el.dataset.info = r.title;
          if (r.onClick) {
            el.classList.add("clickable");
            el.addEventListener("click", (e) => {
              e.stopPropagation();
              r.onClick!();
              // Force a re-render on the next frame (an empty list has key "").
              delete this.badges.dataset.text;
            });
          }
          return el;
        }),
      );
    }
    this.badges.hidden = rows.length === 0;
  }

  private renderMoodMeter(): void {
    const m = this.pet.mood;
    const hearts = Math.ceil(m.affection / 20);
    const food = Math.ceil(m.fullness / 20);
    this.moodMeter.textContent =
      `${"♥".repeat(hearts)}${"♡".repeat(5 - hearts)} ${Math.round(m.affection)}%\n` +
      `${"●".repeat(food)}${"○".repeat(5 - food)} ${Math.round(m.fullness)}%`;
    this.moodMeter.title = `Affection ${Math.round(m.affection)}% · Fullness ${Math.round(m.fullness)}%`;
    this.moodMeter.dataset.tier = moodTier(m);
    this.moodMeter.classList.toggle("hungry", isHungry(m));
  }

  /** Moves the Tauri window to the pet and toggles click-through based on what's under the cursor. */
  private async syncWindow(): Promise<void> {
    if (this.framePending) return;
    this.framePending = true;
    try {
      const b = this.pet.body;
      const winX = b.x - (PET_WINDOW.w / 2) * this.dpr;
      const winY = b.y - (PET_WINDOW.h - 2) * this.dpr;
      const cursor = await this.backend.petFrame(
        Math.round(winX),
        Math.round(winY),
        Math.round(PET_WINDOW.w * this.dpr),
        Math.round(PET_WINDOW.h * this.dpr),
        this.ignoringCursor,
      );
      if (cursor) {
        this.pet.cursor = this.windowed ? cursor : { x: cursor.x * this.dpr, y: cursor.y * this.dpr };
        const overPet = this.isOverPet(cursor.x, cursor.y, winX, winY);
        if (overPet && !this.hovering) this.welcomeBack();
        this.hovering = overPet;
        // The heart meter is about the pet: on a badge or the bubble you're after the
        // alarm or the focus session, so it stays hidden there.
        const overSprite = this.isNearSprite(cursor.x, cursor.y, winX, winY);
        if (overSprite && !this.overSprite) this.renderMoodMeter();
        this.overSprite = overSprite;
        this.updateHover(cursor, winX, winY);
        this.updateBadgeInfo(cursor, winX, winY);
        this.ignoringCursor = !overPet && !this.drag;
        // In the browser mock the full-page canvas must not block the fake windows underneath.
        this.canvas.style.pointerEvents = this.ignoringCursor ? "none" : "auto";
        this.canvas.style.cursor = overPet ? "grab" : "default";
      }
    } catch {
      // Window may be closing; try again next frame.
    } finally {
      this.framePending = false;
    }
  }

  /** Shows what the badge under the cursor stands for (e.g. every running timer), or hides it. */
  private updateBadgeInfo(cursor: { x: number; y: number }, winX: number, winY: number): void {
    const lx = this.windowed ? (cursor.x - winX) / this.dpr : cursor.x;
    const ly = this.windowed ? (cursor.y - winY) / this.dpr : cursor.y;
    let hit: HTMLElement | null = null;
    if (!this.badges.hidden) {
      for (const el of this.badges.children) {
        const r = el.getBoundingClientRect();
        if (el instanceof HTMLElement && el.dataset.info && lx >= r.left && lx <= r.right && ly >= r.top && ly <= r.bottom) {
          hit = el;
        }
      }
    }
    if (!hit) {
      this.badgeInfo.hidden = true;
      return;
    }
    const r = hit.getBoundingClientRect();
    const viewW = this.windowed ? PET_WINDOW.w : window.innerWidth;
    this.badgeInfo.textContent = hit.dataset.info ?? "";
    this.badgeInfo.hidden = false;
    // Above the badge, kept inside the window.
    this.badgeInfo.style.left = `${Math.max(2, Math.min(r.left, viewW - this.badgeInfo.offsetWidth - 2))}px`;
    this.badgeInfo.style.top = `${r.top - 3}px`;
  }

  /** Feeds the hover rules and turns what they decide into pet reactions or petting. */
  private updateHover(cursor: { x: number; y: number }, winX: number, winY: number): void {
    const tier = moodTier(this.pet.mood);
    const events = this.hover.update(performance.now(), {
      over: this.isNearSprite(cursor.x, cursor.y, winX, winY),
      cursor,
      unit: this.dpr,
      canAttend:
        !this.drag && !this.activeRing && !this.hidden && this.pet.mode === "free" && this.pet.state !== "goto",
      unhappy: isHungry(this.pet.mood) ? "hungry" : tier === "grumpy" || tier === "sulking" ? "grumpy" : null,
    });
    for (const e of events) {
      if (e.type === "stroke") this.care({ label: "", kind: "pet" });
      else if (e.type === "dodge") this.pet.react({ type: "hover", phase: "dodge", reason: e.reason });
      else this.pet.react({ type: "hover", phase: e.type });
    }
  }

  /**
   * The sprite's bounding box: hovering and stroking use this rather than exact pixels,
   * so rubbing across a gap in the art (between the legs) isn't leaving and coming back.
   */
  private isNearSprite(cx: number, cy: number, winX: number, winY: number): boolean {
    if (this.hidden) return false;
    const lx = this.windowed ? (cx - winX) / this.dpr : cx;
    const ly = this.windowed ? (cy - winY) / this.dpr : cy;
    const f = this.feet();
    const w = this.atlas.width * this.artScale;
    const h = this.atlas.height * this.artScale;
    return Math.abs(lx - f.x) <= w / 2 && ly <= f.y + 2 && ly >= f.y - h;
  }

  /** Hit test in the pet's own pixels (plus bubble/badge) so clicks elsewhere pass through. */
  private isOverPet(cx: number, cy: number, winX: number, winY: number): boolean {
    if (this.hidden) return false;
    // Cursor in canvas CSS px.
    const lx = this.windowed ? (cx - winX) / this.dpr : cx;
    const ly = this.windowed ? (cy - winY) / this.dpr : cy;
    for (const el of [this.bubble, this.badges, this.moodMeter]) {
      if (el.hidden) continue;
      const r = el.getBoundingClientRect();
      if (lx >= r.left && lx <= r.right && ly >= r.top && ly <= r.bottom) return true;
    }
    const f = this.feet();
    const s = this.artScale;
    // Be generous by one art pixel so thin sprites are still easy to grab.
    for (const [ox, oy] of [[0, 0], [s, 0], [-s, 0], [0, s], [0, -s]]) {
      if (this.atlas.hit(this.pet.anim.frame, lx - f.x + ox, ly - f.y + oy, s, this.pet.facing)) return true;
    }
    return false;
  }

  // --- Input --------------------------------------------------------------

  /** Pointer position in physical screen px. */
  private screenPoint(e: PointerEvent): { x: number; y: number } {
    if (!this.windowed) return { x: e.clientX, y: e.clientY };
    // Prefer the OS cursor from Rust (exact on mixed-DPI setups); screenX/Y are logical.
    return this.pet.cursor ?? { x: e.screenX * this.dpr, y: e.screenY * this.dpr };
  }

  private onPointerDown(e: PointerEvent): void {
    if (e.button !== 0) return;
    const f = this.feet();
    const hitPet = this.atlas.hit(this.pet.anim.frame, e.offsetX - f.x, e.offsetY - f.y, this.artScale, this.pet.facing);
    if (!hitPet) return;
    const p = this.screenPoint(e);
    this.canvas.setPointerCapture(e.pointerId);
    this.drag = { pointerId: e.pointerId, dx: this.pet.body.x - p.x, dy: this.pet.body.y - p.y, moved: false, sx: p.x, sy: p.y };
    this.ignoringCursor = false;
  }

  private onPointerMove(e: PointerEvent): void {
    const d = this.drag;
    if (!d || e.pointerId !== d.pointerId) return;
    const p = this.screenPoint(e);
    if (!d.moved && Math.hypot(p.x - d.sx, p.y - d.sy) > 5 * this.dpr) {
      d.moved = true;
      this.pet.startDrag();
      // Hold the pet by the scruff: feet hang below the cursor.
      d.dx = 0;
      d.dy = this.pet.spriteSize.h * 0.85;
    }
    if (d.moved) this.pet.dragTo(p.x + d.dx, p.y + d.dy, performance.now());
  }

  private onPointerUp(e: PointerEvent): void {
    const d = this.drag;
    if (!d || e.pointerId !== d.pointerId) return;
    this.drag = null;
    if (d.moved) {
      this.pet.endDrag();
      // Being carried around is play; it shares the hourly cap with petting.
      this.moodEvent("carried");
    } else this.care({ label: "", kind: "pet" });
  }

  /** What the pet menu and the tray menu share (see menu.ts). */
  private menuContext(): MenuContext {
    return {
      backend: this.backend,
      registry: this.registry,
      settings: this.settings,
      pomodoro: this.pomodoro,
      timers: activeTimers(this.timers),
      snoozed: snoozedAlarms(this.timers),
      missed: missedAlarms(this.timers),
      setTimer: (min) => void this.startTimer(min),
      // The length is asked for in the pet's bubble; with the pet hidden, the panel asks.
      customTimer: () => void (this.petVisible ? this.askCustomTimer() : this.backend.openPanel("alarms")),
    };
  }

  private onContextMenu(e: MouseEvent): void {
    e.preventDefault();
    void showPetMenu(e, {
      ...this.menuContext(),
      character: this.character.def,
      hungry: isHungry(this.pet.mood),
      rng: this.pet.rng,
      care: (a) => this.care(a),
      hide: () => void this.hidePet(),
    });
  }

  /** Rebuilds the tray menu soon (state changes often come in bursts). */
  private scheduleTray(): void {
    if (!this.windowed) return;
    clearTimeout(this.trayTimer);
    this.trayTimer = setTimeout(() => void this.updateTray(), 200);
  }

  /** The tray menu is built here from the same items as the pet menu, so the two always match. */
  private async updateTray(): Promise<void> {
    const items = buildTrayItems({
      ...this.menuContext(),
      petVisible: this.petVisible,
    });
    const outline = JSON.stringify(items, (k, v) => (k === "action" ? undefined : v));
    if (outline === this.trayOutline) return;
    try {
      const { TrayIcon } = await import("@tauri-apps/api/tray");
      const tray = await TrayIcon.getById("main");
      if (!tray) return;
      const menu = await nativeMenu(items);
      await tray.setMenu(menu);
      this.trayOutline = outline;
      // Keep the previous menu alive a little longer: it may be open on screen right now.
      this.trayMenus.push(menu);
      while (this.trayMenus.length > 2) void this.trayMenus.shift()!.close();
    } catch (e) {
      console.warn("Could not update the tray menu", e);
    }
  }

  // --- Care, mood & feedback ----------------------------------------------

  /** Petting (click or menu) and feeding. */
  private care(action: CareAction): void {
    const before = { ...this.pet.mood };
    if (action.kind === "feed") {
      const result = applyMoodEvent(this.pet.mood, "feed") === "full" ? "full" : "ok";
      this.pet.react({ type: "fed", result });
    } else {
      const result = applyMoodEvent(this.pet.mood, "pet") === "capped" ? "capped" : "ok";
      this.pet.react({ type: "petted", result });
      if (this.settings.sound) sounds.pop();
    }
    this.showGain(before.affection, before.fullness);
    this.renderMoodMeter();
    void this.saveMood();
  }

  private moodEvent(e: MoodEvent): void {
    const before = { ...this.pet.mood };
    applyMoodEvent(this.pet.mood, e);
    this.showGain(before.affection, before.fullness);
    this.renderMoodMeter();
    void this.saveMood();
  }

  /** Floats "+3 ♥" / "+40 🍽" above the pet so every bit of care visibly counts. */
  private showGain(affectionBefore: number, fullnessBefore: number): void {
    const love = Math.round(this.pet.mood.affection - affectionBefore);
    const food = Math.round(this.pet.mood.fullness - fullnessBefore);
    const parts = [love && `${love > 0 ? "+" : ""}${love} ♥`, food > 0 && `+${food} 🍽`].filter(Boolean);
    if (!parts.length || this.hidden) return;
    const el = document.createElement("div");
    el.className = `gain ${love < 0 ? "loss" : ""}`;
    el.textContent = parts.join("  ");
    const f = this.feet();
    const spriteW = this.atlas.width * this.artScale;
    // Top-right of the pet's head: the meter is on the left, the bubble above.
    el.style.left = `${f.x + spriteW / 2}px`;
    el.style.top = `${f.y - this.atlas.height * this.artScale}px`;
    document.body.append(el);
    setTimeout(() => el.remove(), 1200);
  }

  private async saveMood(): Promise<void> {
    try {
      await this.backend.saveMood(this.character.def.id, this.pet.mood);
    } catch (e) {
      console.warn("Could not save mood", e);
    }
  }

  private async refreshTimers(): Promise<void> {
    try {
      this.timers = await this.backend.listAlarms();
    } catch {
      // Keep the last list.
    }
    this.scheduleTray();
  }

  /** Snoozes and confirms, so the snoozed alarm never silently disappears. */
  private async snooze(id: number, minutes: number): Promise<void> {
    try {
      await this.backend.snoozeAlarm(id, minutes);
      await this.refreshTimers();
      const time = new Date(Date.now() + minutes * 60_000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
      this.say(`💤 Snoozed until ${time}. Right-click me to cancel.`, 4000);
      this.announcedMissed.delete(id);
    } catch (e) {
      this.say(`Couldn't snooze: ${e instanceof Error ? e.message : String(e)}`, 4000);
    }
  }

  /**
   * Starts a timer from the menu or the custom prompt, remembering custom lengths (max three).
   * `replacing` is the saved length being edited with ✎; the new length takes its place.
   */
  private async startTimer(minutes: number, replacing?: number): Promise<void> {
    await this.setTimer(minutes);
    const saved = this.settings.recentTimers;
    const recentTimers =
      replacing === undefined ? rememberCustomTimer(saved, minutes) : replaceCustomTimer(saved, replacing, minutes);
    if (recentTimers.join() !== saved.join()) this.settings = await this.backend.setSettings({ recentTimers });
  }

  /**
   * "Custom / Edit…": asks for a length right in the speech bubble (a native menu can't take
   * input), and lists the saved custom lengths with ✎ (edit that one) and ✕ (forget it).
   */
  private async askCustomTimer(): Promise<void> {
    if (this.activeRing) return;
    clearTimeout(this.bubbleTimer);
    this.prompting = true;
    const EXAMPLES = "e.g. 20 · 1:30 · 90s";
    /** The saved length being edited, if any. */
    let editing: number | undefined;
    const close = () => {
      this.prompting = false;
      this.hideBubble();
    };
    const button = (text: string, title: string, onClick: () => void) => {
      const b = document.createElement("button");
      b.textContent = text;
      b.title = title;
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        onClick();
      });
      return b;
    };
    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = "20";
    input.className = "duration";
    input.setAttribute("aria-label", "Timer length");
    const hint = document.createElement("div");
    hint.className = "hint";
    const showHint = () => {
      const minutes = parseDuration(input.value);
      hint.classList.remove("error");
      if (editing !== undefined) {
        hint.textContent = `Change ${formatDuration(editing)} → ${minutes === null ? "…" : formatDuration(minutes)}`;
        return;
      }
      hint.textContent = input.value.trim() ? (minutes === null ? "…" : `= ${formatDuration(minutes)}`) : EXAMPLES;
    };
    const submit = () => {
      const minutes = parseDuration(input.value);
      if (minutes === null) {
        hint.textContent = "Try 20, 1:30 or 90s";
        hint.classList.add("error");
        input.focus();
        return;
      }
      close();
      void this.startTimer(minutes, editing);
    };
    input.addEventListener("input", showHint);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") submit();
      if (e.key === "Escape") close();
    });
    const saved = document.createElement("div");
    saved.className = "saved";
    const renderSaved = () => {
      const list = this.settings.recentTimers;
      saved.hidden = list.length === 0;
      saved.replaceChildren(
        ...list.map((m) => {
          const chip = document.createElement("span");
          chip.className = "chip" + (m === editing ? " editing" : "");
          chip.append(
            formatDuration(m),
            button("✎", "Change this one", () => {
              editing = m;
              input.value = durationInput(m);
              renderSaved();
              showHint();
              input.focus();
              input.select();
            }),
            button("✕", "Forget this one", () => {
              if (editing === m) editing = undefined;
              const recentTimers = forgetCustomTimer(this.settings.recentTimers, m);
              this.settings = { ...this.settings, recentTimers };
              void this.backend.setSettings({ recentTimers }).then((s) => (this.settings = s));
              renderSaved();
              showHint();
              input.focus();
            }),
          );
          return chip;
        }),
      );
    };
    renderSaved();
    showHint();
    const title = document.createElement("div");
    title.textContent = "How long?";
    const row = document.createElement("div");
    row.className = "actions";
    row.append(input, button("Start", "Start the timer", submit), button("✕", "Cancel", close));
    this.bubble.replaceChildren(title, row, hint, saved);
    this.bubble.hidden = false;
    // Give up quietly if left alone.
    this.bubbleTimer = setTimeout(close, 45_000);
    // The pet window never takes focus by itself; typing needs it.
    if (this.windowed) {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      await getCurrentWindow().setFocus();
    }
    input.focus();
  }

  private async setTimer(minutes: number): Promise<void> {
    const alarm = await this.backend.addAlarm(timerLabel(minutes), Date.now() + minutes * 60_000, "none");
    this.timers = [...this.timers.filter((t) => t.id !== alarm.id), alarm];
    const time = new Date(alarm.nextFire ?? Date.now()).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    this.sayLine("timerSet", { duration: formatDuration(minutes), time }, `⏱ ${formatDuration(minutes)} timer set. I'll ring at ${time}.`);
    if (this.pet.grounded && this.pet.state !== "sleep") this.pet.fsm.set("happy", true);
  }

  /** Reacts to things the user did in other windows (panel, games). */
  private onActivity(e: PetActivity): void {
    switch (e.type) {
      case "todoAdded": {
        const when = e.dueAt
          ? ` · ${new Date(e.dueAt).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}`
          : "";
        this.sayLine("noted", { title: e.title, when }, `Got it: ${e.title}${when}`);
        break;
      }
      case "todoDone":
        this.moodEvent("todoDone");
        this.pet.react({ type: "praise" });
        break;
      case "game":
        this.moodEvent("game");
        if (e.won) this.pet.react({ type: "praise" });
        break;
    }
  }

  /** Says a character line, or the fallback if the character has none for `key`. */
  private sayLine(key: string, vars: Record<string, string>, fallback: string): void {
    if (this.pet.def.personality.lines[key]?.length) this.pet.say(key, vars, 5000);
    else this.say(fallback, 5000);
  }

  private async hidePet(): Promise<void> {
    await this.backend.setPetVisible(false);
  }

  // --- Speech & reminders -------------------------------------------------

  /**
   * Shows a speech bubble; extra lines are shown smaller. A bubble with `onTimeout` is
   * ringing: nothing else replaces it (more alarms join it, see `onReminder`), and
   * `onTimeout` runs if nobody presses a button. An `important` bubble (e.g. "you missed
   * an alarm") can't be replaced by chatter or petting lines while it is shown.
   */
  private say(
    text: string | string[],
    ms: number,
    actions: BubbleAction[] = [],
    onTimeout?: () => void,
    important = false,
  ): void {
    if (this.activeRing && !onTimeout) return;
    if (!onTimeout && !important && Date.now() < this.importantUntil) return;
    // Don't talk over the custom-timer prompt (an alarm still takes priority).
    if (this.prompting && !onTimeout) return;
    this.prompting = false;
    this.importantUntil = important ? Date.now() + ms : 0;
    clearTimeout(this.bubbleTimer);
    this.bubble.replaceChildren();
    const [first, ...notes] = Array.isArray(text) ? text : [text];
    const p = document.createElement("div");
    p.textContent = first;
    this.bubble.append(p);
    for (const note of notes) {
      const n = document.createElement("div");
      n.className = "note";
      n.textContent = note;
      this.bubble.append(n);
    }
    if (actions.length) {
      const row = document.createElement("div");
      row.className = "actions";
      for (const a of actions) {
        const btn = document.createElement("button");
        btn.textContent = a.label;
        btn.addEventListener("click", (ev) => {
          ev.stopPropagation();
          this.activeRing = null;
          a.run();
          this.hideBubble();
        });
        row.append(btn);
      }
      this.bubble.append(row);
    }
    this.bubble.hidden = false;
    this.activeRing = onTimeout ? { onTimeout } : null;
    this.bubbleTimer = setTimeout(() => {
      const ring = this.activeRing;
      this.activeRing = null;
      this.hideBubble();
      ring?.onTimeout();
    }, ms);
  }

  private hideBubble(): void {
    this.bubble.hidden = true;
    this.stopRinging?.();
    this.stopRinging = null;
  }

  /**
   * An alarm, timer or to-do is due. Alarms and timers that come due while another is
   * still ringing join the same bubble (answered together), instead of the earlier one
   * silently counting as unanswered. A to-do that comes due meanwhile waits its turn.
   */
  private onReminder(r: ReminderEvent): void {
    if (r.kind === "todo") {
      if (this.activeRing) this.queued.push(r);
      else this.remindTodo(r);
      return;
    }
    const joining = this.activeRing !== null && this.ringing.length > 0;
    if (!this.ringing.includes(r.id)) this.ringing.push(r.id);
    const alert = this.settings.alerts.alarm;
    if (!joining) {
      // During a focus session the pet stays at its "desk" so the session isn't disrupted.
      const run = alert.petRuns && this.pomodoro.phase !== "focus";
      const known = this.timers.find((a) => a.id === r.id);
      this.pet.react({ type: "reminder", kind: "alarm", title: known ? alarmName(known) : r.title, run });
      // The pet's own line ("MEOW! Alarm 9:40 PM") heads a single alarm's bubble.
      this.ringHeadline = this.bubble.firstElementChild?.textContent ?? "";
    }
    // (Re)start the sound: a joining alarm rings for the full time too, like the bubble.
    this.stopRinging?.();
    this.stopRinging = alert.ring ? ringAlarm(alert.ringtone, alert.volume, alert.ringSeconds) : null;
    this.showRing();
    // The cached list may predate this ring (snooze count, first ring time): refresh and redraw.
    void this.refreshTimers().then(() => {
      if (this.activeRing && this.ringing.includes(r.id)) this.showRing(false);
    });
  }

  /** What is ringing, as bubble lines: one item says what it is; several are listed. */
  private ringLines(): string[] {
    const alert = this.settings.alerts.alarm;
    const items = this.ringing.map((id) => this.timers.find((a) => a.id === id));
    const snoozeNote = (a: Alarm) => {
      if (isTimer(a) || a.snoozes === 0) return null;
      const first = alarmTime(a);
      const note = `Snoozed ${a.snoozes}×${first !== null ? ` · first rang ${clock(first)}` : ""}`;
      return a.snoozes >= alert.autoSnoozeMax && alert.autoSnoozeMax > 0
        ? `${note} · last try before it's marked missed`
        : note;
    };
    const describe = (a: Alarm | undefined) => (!a ? "Alarm" : isTimer(a) ? `${timerName(a)} timer` : alarmName(a));
    if (items.length === 1) {
      const a = items[0];
      const head = a && isTimer(a) ? `⏱ Time's up! (${timerName(a)} timer)` : this.ringHeadline || describe(a);
      const note = a ? snoozeNote(a) : null;
      return note ? [head, note] : [head];
    }
    const allTimers = items.every((a) => a && isTimer(a));
    const head = allTimers ? `⏱ ${items.length} timers are up:` : `⏰ ${items.length} things are due:`;
    return [
      head,
      ...items.map((a) => {
        const note = a && !isTimer(a) && a.snoozes ? ` (snoozed ${a.snoozes}×)` : "";
        return `• ${describe(a)}${note}`;
      }),
    ];
  }

  /**
   * (Re)draws the ringing bubble for everything in `ringing`. `restart` (default) gives it a
   * full ring time again, e.g. when another alarm joins; a redraw with fresh data doesn't.
   */
  private showRing(restart = true): void {
    const alert = this.settings.alerts.alarm;
    const ids = () => {
      const all = this.ringing;
      this.ringing = [];
      // Whatever waited (a to-do) gets its turn once this bubble is gone.
      setTimeout(() => this.nextQueued(), 400);
      return all;
    };
    const actions: BubbleAction[] = [
      {
        label: `Snooze ${alert.snoozeMinutes} min`,
        run: () => {
          for (const id of ids()) void this.snooze(id, alert.snoozeMinutes);
        },
      },
      {
        label: "Done",
        run: () => {
          for (const id of ids()) void this.done(id);
        },
      },
    ];
    const ms = restart ? alert.ringSeconds * 1000 : Math.max(1000, this.ringEndsAt - Date.now());
    if (restart) this.ringEndsAt = Date.now() + ms;
    this.say(this.ringLines(), ms, actions, () => {
      for (const id of ids()) void this.unanswered(id);
    });
  }

  private remindTodo(r: ReminderEvent): void {
    const alert = this.settings.alerts.todo;
    const run = alert.petRuns && this.pomodoro.phase !== "focus";
    this.pet.react({ type: "reminder", kind: "todo", title: r.title, run });
    const text = this.bubble.firstElementChild?.textContent || r.title;
    const actions: BubbleAction[] = [
      {
        label: "✓ Done",
        run: () => {
          void this.backend.updateTodo(r.id, { done: true });
          this.onActivity({ type: "todoDone" });
        },
      },
      { label: "Later", run: () => void this.backend.updateTodo(r.id, { dueAt: Date.now() + 10 * 60_000 }) },
    ];
    this.say(text, 60_000, actions);
    if (alert.ring) playRingtone(alert.ringtone, alert.volume);
  }

  private nextQueued(): void {
    if (this.activeRing) return;
    const r = this.queued.shift();
    if (r) this.onReminder(r);
  }

  /**
   * "Done": ends the ringing/snooze cycle. Timers and one-off alarms stay in Finished (with
   * when they rang), so an answered timer is never just gone; repeating alarms keep their schedule.
   */
  private async done(id: number): Promise<void> {
    await this.backend.dismissAlarm(id);
    await this.refreshTimers();
  }

  /** Nobody answered: alarms snooze themselves a few times, then count as missed; timers are just done. */
  private async unanswered(id: number): Promise<void> {
    await this.refreshTimers();
    const alarm = this.timers.find((a) => a.id === id);
    if (!alarm) return;
    const next = onUnanswered(alarm, this.settings.alerts.alarm);
    if (next.action === "autoSnooze") {
      await this.backend.snoozeAlarm(id, next.minutes);
      this.say(
        `💤 No answer… I'll try ${alarmName(alarm)} again at ${clock(Date.now() + next.minutes * 60_000)} (${next.attempt}/${next.max}).`,
        8000,
      );
    } else if (next.action === "missed") {
      await this.backend.markAlarmMissed(id, alarmName(alarm));
    } else {
      this.doneTimers = [...this.doneTimers, { id, label: alarm.label, at: Date.now() }];
    }
    await this.refreshTimers();
  }

  /**
   * The first time you come back to the pet after missing something, it tells you (once
   * per item). This is an important bubble: petting or chatter can't replace it. Badges
   * stay until clicked (or, for finished timers, for an hour).
   */
  private welcomeBack(): void {
    if (this.activeRing || this.drag) return;
    const missed = missedAlarms(this.timers).filter((a) => !this.announcedMissed.has(a.id));
    if (missed.length) {
      for (const a of missed) this.announcedMissed.add(a.id);
      const a = missed[0];
      const tries = a.snoozes ? ` (I tried ${a.snoozes} more time${a.snoozes > 1 ? "s" : ""})` : "";
      const others = missed.length > 1 ? ` and ${missed.length - 1} more` : "";
      this.say(`You missed ${alarmName(a)}${tries}${others}. Click ⏰ when you've seen it.`, 8000, [], undefined, true);
      return;
    }
    const done = visibleDoneTimers(this.doneTimers).filter((t) => !this.announcedDone.has(t.id));
    if (done.length) {
      for (const t of done) this.announcedDone.add(t.id);
      const t = done[done.length - 1];
      const name = t.label.startsWith(TIMER_PREFIX) ? t.label.slice(TIMER_PREFIX.length) : t.label;
      this.say(
        done.length === 1
          ? `While you were away, your ${name} timer finished at ${clock(t.at)}.`
          : `While you were away, ${done.length} timers finished (last at ${clock(t.at)}).`,
        6000,
        [],
        undefined,
        true,
      );
    }
  }
}
