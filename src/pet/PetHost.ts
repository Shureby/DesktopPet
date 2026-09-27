import { applyMoodEvent, isHungry, moodTier, parseMood, type MoodEvent } from "../brain/mood";
import { RulesBrain } from "../brain/RulesBrain";
import { Pet } from "../characters/Pet";
import type { CharacterRegistry, LoadedCharacter } from "../characters/registry";
import { createRng } from "../engine/random";
import { SpriteAtlas } from "../engine/sprites";
import { activeTimers, formatDuration, timerLabel } from "../features/alarm/timers";
import { formatRemaining } from "../features/pomodoro/logic";
import type { Alarm, Backend, PetActivity, PomodoroStatus, ReminderEvent, Settings } from "../platform";
import type { CareAction } from "../characters/schema";
import { showPetMenu } from "./menu";
import { inQuietHours } from "./quietHours";
import { playRingtone, ringAlarm, sounds } from "./sound";

const STEP = 1 / 30;
/** Logical size of the pet window in Tauri mode (must match tauri.conf.json). */
export const PET_WINDOW = { w: 260, h: 240 };

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
  private timers: Alarm[] = [];
  private hovering = false;

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
    const snap = await this.backend.desktopSnapshot();
    this.dpr = snap.scale;
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
      this.pet.react({ type: "pomodoro", phase: p.phase });
      if (this.settings.sound) sounds.chime();
    });
    await this.backend.on("settings", (s) => void this.applySettings(s));
    await this.backend.on("game", (g) => this.setHidden(g.state === "started"));
    await this.backend.on("pet-command", (c) => {
      if (c === "greet") this.pet.react({ type: "greet" });
    });
    await this.backend.on("alarms-changed", () => void this.refreshTimers());
    await this.backend.on("pet-event", (e) => this.onActivity(e));
    await this.refreshTimers();
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
      this.pet.unit = this.dpr * s.size;
      this.pet.speed = s.speed;
      const { w, h } = this.pet.spriteSize;
      this.pet.body.w = w * 0.6;
      this.pet.body.h = h;
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
      if (snap.scale !== this.dpr) {
        this.dpr = snap.scale;
        this.pet.unit = this.dpr * this.settings.size;
        this.resize();
      }
    } finally {
      this.snapshotPending = false;
    }
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
    this.badges.style.left = `${f.x + spriteW / 2 + 4}px`;
    this.badges.style.top = `${f.y - 2}px`;
    this.renderBadges();
    this.moodMeter.hidden = !this.hovering || !!this.drag;
  }

  /** Focus session on top, then the soonest timer ("+N" when more are running). */
  private renderBadges(): void {
    const now = Date.now();
    const rows: string[] = [];
    if (this.pomodoro.phase !== "idle" && this.pomodoro.endsAt) {
      const icon = this.pomodoro.phase === "focus" ? "🍅" : "☕";
      rows.push(`${icon} ${formatRemaining(this.pomodoro.endsAt - now)}`);
    }
    const timers = activeTimers(this.timers, now);
    if (timers.length) {
      const more = timers.length > 1 ? ` +${timers.length - 1}` : "";
      rows.push(`⏱ ${formatRemaining(timers[0].nextFire - now)}${more}`);
    }
    const text = rows.join("\n");
    if (this.badges.dataset.text !== text) {
      this.badges.dataset.text = text;
      this.badges.replaceChildren(...rows.map((r) => Object.assign(document.createElement("div"), { textContent: r })));
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
      const cursor = await this.backend.petFrame(Math.round(winX), Math.round(winY), this.ignoringCursor);
      if (cursor) {
        this.pet.cursor = this.windowed ? cursor : { x: cursor.x * this.dpr, y: cursor.y * this.dpr };
        const overPet = this.isOverPet(cursor.x, cursor.y, winX, winY);
        if (overPet && !this.hovering) this.renderMoodMeter();
        this.hovering = overPet;
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

  private onContextMenu(e: MouseEvent): void {
    e.preventDefault();
    void showPetMenu(e, {
      backend: this.backend,
      registry: this.registry,
      settings: this.settings,
      pomodoro: this.pomodoro,
      character: this.character.def,
      hungry: isHungry(this.pet.mood),
      timers: activeTimers(this.timers),
      rng: this.pet.rng,
      care: (a) => this.care(a),
      setTimer: (min) => void this.setTimer(min),
      hide: () => void this.hidePet(),
    });
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
  }

  /** Starts a timer and has the pet confirm it (instead of silently setting it). */
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
    if (this.windowed) {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      await getCurrentWindow().hide();
    } else this.setHidden(true);
  }

  // --- Speech & reminders -------------------------------------------------

  private say(text: string, ms: number, actions: BubbleAction[] = []): void {
    clearTimeout(this.bubbleTimer);
    this.bubble.replaceChildren();
    const p = document.createElement("div");
    p.textContent = text;
    this.bubble.append(p);
    if (actions.length) {
      const row = document.createElement("div");
      row.className = "actions";
      for (const a of actions) {
        const btn = document.createElement("button");
        btn.textContent = a.label;
        btn.addEventListener("click", (ev) => {
          ev.stopPropagation();
          a.run();
          this.hideBubble();
        });
        row.append(btn);
      }
      this.bubble.append(row);
    }
    this.bubble.hidden = false;
    this.bubbleTimer = setTimeout(() => this.hideBubble(), ms);
  }

  private hideBubble(): void {
    this.bubble.hidden = true;
    this.stopRinging?.();
    this.stopRinging = null;
  }

  private onReminder(r: ReminderEvent): void {
    const alert = this.settings.alerts[r.kind];
    if (r.kind === "alarm") void this.refreshTimers();
    // During a focus session the pet stays at its "desk" so the session isn't disrupted.
    const run = alert.petRuns && this.pomodoro.phase !== "focus";
    this.pet.react({ type: "reminder", kind: r.kind, title: r.title, run });
    const text = this.bubble.firstElementChild?.textContent || r.title;
    const actions: BubbleAction[] =
      r.kind === "alarm"
        ? [
            { label: "Snooze 5m", run: () => void this.backend.snoozeAlarm(r.id, 5) },
            { label: "Stop", run: () => {} },
          ]
        : [
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
    this.stopRinging?.();
    this.stopRinging = null;
    if (alert.ring) {
      // Alarms ring until dismissed; to-dos ring once.
      if (r.kind === "alarm") this.stopRinging = ringAlarm(alert.ringtone, alert.volume);
      else playRingtone(alert.ringtone, alert.volume);
    }
  }
}
