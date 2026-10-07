import { HoverTracker, RunStopper } from "../brain/hover";
import { todoRemindsAt } from "../features/todo/repeat";
import { celebrationEffect, celebrationLines, musicFor } from "../features/anniversary/templates";
import { candleLayout, playEffect } from "../celebrate/effects";
import type { Vigil } from "../characters/abilities/core";
import { applyMoodEvent, isHungry, moodTier, parseMood, type MoodEvent } from "../brain/mood";
import { RulesBrain } from "../brain/RulesBrain";
import { Pet } from "../characters/Pet";
import { loadAll, type CharacterRegistry, type LoadedCharacter } from "../characters/registry";
import { areaIndexAt } from "../engine/physics";
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
  badgeAlarms,
  alarmBadgeLine,
  unseenLines,
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
import { formatRemaining, gameHeld } from "../features/pomodoro/logic";
import type { Alarm, Backend, Celebration, PetActivity, PomodoroStatus, ReminderEvent, Settings, Unseen } from "../platform";
import type { CareAction } from "../characters/schema";
import { buildItems, buildTrayItems, nativeMenu, showPetMenu, type Item, type MenuContext, type PetMenuContext } from "./menu";
import { inQuietHours } from "./quietHours";
import { playMusic, playRingtone, ringAlarm, sounds } from "./sound";

const STEP = 1 / 30;
/**
 * Logical size of the pet window in Tauri mode (must match tauri.conf.json). Wide enough
 * for the badges beside the pet ("⏰ Missed 9:40 PM +1"); the empty parts click through.
 */
/** How long a badge's info box stays after the cursor leaves the badge, to reach the box. */
const BADGE_INFO_GRACE_MS = 400;
/** Badges moved left of the pet go back right only with this much room to spare (no flicker). */
const BADGE_FLIP_SLACK = 40;

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
/** How long to wait for more to-dos without a time before telling them (they come due together). */
const DAY_TODO_GATHER_MS = 400;
/** The pause between two celebrations on the same day. */
const CELEBRATION_GAP_MS = 2000;
/** How far (CSS px) beyond a remembrance's flowers the pet sits, so its bubble stays clear. */
const VIGIL_BUBBLE_CLEARANCE = 160;

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
  /** Frames drawn (the end-to-end tests check the pet keeps going). */
  private frames = 0;
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
  /** To-dos without a time arriving together, told in one bubble (remindDayTodo). */
  private dayTodos: ReminderEvent[] = [];
  /** Stops the anniversary music playing now (an alarm ringing over it stops it). */
  private stopMusic: (() => void) | null = null;
  /** A celebration is playing (the next waits for it, and a short pause). */
  private celebrating = false;
  /** Anniversaries that came while an alarm rang or another played: celebrated after it. */
  private celebrations: Celebration[] = [];
  /** A game asked for during a focus session while something was ringing (see playGame). */
  private pendingGame: string | null = null;
  /**
   * The hidden pet is out for a reminder ("peek", docs/INTERACTIONS.md): when it was brought
   * out, and whether it is walking back to the edge to hide again.
   */
  private peek: { since: number; leaving: { x: number; since: number } | null } | null = null;
  /** The celebration playing last (for the end-to-end tests). */
  private lastCelebration: Celebration | null = null;
  /** A mini-game is open (the pet is hidden for it). */
  private gameOn = false;
  /** "While I was hidden you missed…" waits for a ring to finish. */
  private unseenPending = false;
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
  private readonly runStopper = new RunStopper();
  /** What the hovered badge stands for (see updateBadgeInfo). */
  private readonly badgeInfo = Object.assign(document.createElement("div"), { className: "badge-info", hidden: true });
  /** The badge the info box is about; clicking the box clicks it. */
  private badgeInfoFor: HTMLElement | null = null;
  /** When the cursor left both the badge and its box (0 while on either). */
  private badgeInfoAwaySince = 0;
  /** Which side of the pet the badges are on; "left" only when they don't fit on the right. */
  private badgeSide: "left" | "right" = "right";
  /** False while the pet is hidden from its menu or the tray. */
  private petVisible = true;
  /** Tray menus still referenced: the current one and the one before (it may be open). */
  private trayMenus: { close(): Promise<void> }[] = [];
  private trayOutline = "";
  private trayTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly backend: Backend,
    private registry: CharacterRegistry,
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
    // The box does what its badge does, so its last line can be a link you move to and click.
    this.badgeInfo.addEventListener("click", (e) => {
      e.stopPropagation();
      const badge = this.badgeInfoFor;
      this.badgeInfo.hidden = true;
      this.badgeInfoFor = null;
      badge?.click();
    });
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
    await this.backend.on("celebrate", (c) => this.onCelebrate(c));
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
      // Shown while out for a reminder: it just stays out.
      if (visible) this.peek = null;
      if (!this.windowed) this.setHidden(!visible);
      this.scheduleTray();
      if (visible) void this.tellUnseen();
    });
    await this.backend.on("pet-peek", () => {
      // A focus session or break ended: the pet comes out, says so (the "pomodoro" event),
      // and goes back once the line is gone.
      this.enterPeek();
    });
    await this.backend.on("game", (g) => {
      this.gameOn = g.state === "started";
      this.setHidden(this.gameOn);
    });
    await this.backend.on("pet-command", (c) => {
      if (c === "greet") this.pet.react({ type: "greet" });
    });
    await this.backend.on("alarms-changed", () => void this.refreshTimers());
    await this.backend.on("characters-changed", () => void this.reloadCharacters());
    await this.backend.on("pet-event", (e) => this.onActivity(e));
    // Listening: what's due (also what came due while ePet was off) can be sent now.
    await this.backend.petReady();
    await this.refreshTimers();
    // Anything the hidden pet couldn't tell you before ePet was last closed.
    if (this.petVisible) void this.tellUnseen();
    // The pet out for a reminder goes back once it's answered (see watchPeek).
    setInterval(() => this.watchPeek(), 300);
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

  /** "Reload characters" or a copy: read them again and redraw the pet from its new file. */
  private async reloadCharacters(): Promise<void> {
    this.registry = await loadAll(() => this.backend.listUserCharacters(), this.backend.assetUrl);
    const { x, y } = this.pet.body;
    await this.setCharacter(this.settings.character, x, y - 1);
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

  /**
   * The part of the canvas that is on screen (the pet's work area), in canvas CSS px. Near a
   * screen edge the pet window hangs off it, and what's drawn there can't be seen.
   */
  private visibleRange(): { left: number; right: number } {
    const viewW = this.windowed ? PET_WINDOW.w : window.innerWidth;
    const world = this.pet.world;
    const b = this.pet.body;
    const i = world ? areaIndexAt(world, b.x, b.y - 1) : -1;
    if (!world || i < 0) return { left: 0, right: viewW };
    const a = world.areas[i];
    // Canvas x 0 in screen CSS px.
    const origin = this.windowed ? b.x / this.dpr - PET_WINDOW.w / 2 : 0;
    return {
      left: Math.max(0, a.x / this.dpr - origin),
      right: Math.min(viewW, (a.x + a.w) / this.dpr - origin),
    };
  }

  /** Where the pet's feet are drawn, in canvas CSS px. */
  private feet(): { x: number; y: number } {
    if (this.windowed) return { x: PET_WINDOW.w / 2, y: PET_WINDOW.h - 2 };
    return { x: this.pet.body.x / this.dpr, y: this.pet.body.y / this.dpr };
  }

  private frame(now: number): void {
    const dt = Math.min(0.25, (now - this.last) / 1000);
    this.last = now;
    this.frames++;
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
    const spriteW = this.atlas.width * this.artScale;
    const halfW = spriteW / 2;
    // What of the window is on screen: near a screen edge, part of it isn't
    // (docs/INTERACTIONS.md, "At the edge of the screen").
    const vis = this.visibleRange();

    // The speech bubble stays on screen; its tail keeps pointing at the pet.
    const bw = this.bubble.offsetWidth;
    const bx = Math.max(vis.left + 2 + bw / 2, Math.min(f.x, vis.right - 2 - bw / 2));
    this.bubble.style.left = `${bw ? bx : f.x}px`;
    this.bubble.style.top = `${f.y - spriteH - 8}px`;
    this.bubble.style.setProperty("--tail", `${Math.max(-(bw / 2 - 12), Math.min(bw / 2 - 12, f.x - bx))}px`);

    // Badges go right of the pet, or left when they don't fit on screen there. They flip back
    // only once there is room to spare, and never while the mouse is on them.
    const rightSpace = vis.right - (f.x + halfW + 4) - 2;
    const leftSpace = f.x - halfW - 4 - (vis.left + 2);
    let needed = 0;
    for (const el of this.badges.children) needed = Math.max(needed, (el as HTMLElement).scrollWidth + 4);
    if (!this.badgeInfoFor && needed > 0) {
      if (this.badgeSide === "right" && rightSpace < needed && leftSpace > rightSpace) this.badgeSide = "left";
      else if (this.badgeSide === "left" && rightSpace >= needed + BADGE_FLIP_SLACK) this.badgeSide = "right";
    }
    const left = this.badgeSide === "left";
    this.badges.classList.toggle("left", left);
    // Anchored at the feet and growing upward, so extra rows never fall off the window.
    this.badges.style.left = `${left ? f.x - halfW - 4 : f.x + halfW + 4}px`;
    this.badges.style.top = `${f.y - 2}px`;
    // Never wider than what's visible: a long badge ends in "…" instead of being cut off.
    this.badges.style.maxWidth = `${Math.max(40, left ? leftSpace : rightSpace)}px`;

    // The heart meter takes the other side; if that is off screen too, above the pet's head
    // (above the bubble, if one shows).
    const mw = this.moodMeter.offsetWidth;
    const meterSide = !left ? (leftSpace >= mw ? "left" : "above") : rightSpace >= mw ? "right" : "above";
    this.moodMeter.dataset.side = meterSide;
    if (meterSide === "above") {
      const top = this.bubble.hidden ? f.y - spriteH - 4 : this.bubble.getBoundingClientRect().top - 4;
      this.moodMeter.style.left = `${Math.max(vis.left + 2 + mw / 2, Math.min(f.x, vis.right - 2 - mw / 2))}px`;
      this.moodMeter.style.top = `${top}px`;
    } else {
      this.moodMeter.style.left = `${meterSide === "left" ? f.x - halfW - 4 : f.x + halfW + 4}px`;
      this.moodMeter.style.top = `${f.y - 2}px`;
    }
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
        title: info([`${name} · ${timeRange(p.endsAt - minutes * 60_000, p.endsAt)}`], "Open the Focus tab"),
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
    // Snoozed and upcoming alarms share one badge, in ring order, like timers do. Its icon is
    // the nearest one's: 💤 if that is a snooze.
    const alarms = badgeAlarms(this.timers, this.settings.upcomingAlarms, now);
    if (alarms.length) {
      const first = alarms[0];
      rows.push({
        // Clock times: it may be an hour away, a countdown would just be noise.
        text: `${first.snoozes > 0 ? "💤" : "🔔"} ${clock(first.nextFire)}${more(alarms.length)}`,
        title: info(alarms.map(alarmBadgeLine), "Open the Alarms tab"),
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
        title: info([`${alarmName(m)}${m.snoozes ? ` · snoozed ${m.snoozes}×` : ""}`], "Mark as seen"),
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
          "Dismiss",
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

  /**
   * Shows what the badge under the cursor stands for (e.g. every running timer), or hides it.
   * The box stays while the cursor is on it, and for a moment on the way there, so its link
   * can be clicked (docs/INTERACTIONS.md).
   */
  private updateBadgeInfo(cursor: { x: number; y: number }, winX: number, winY: number): void {
    const lx = this.windowed ? (cursor.x - winX) / this.dpr : cursor.x;
    const ly = this.windowed ? (cursor.y - winY) / this.dpr : cursor.y;
    const under = (el: Element) => {
      const r = el.getBoundingClientRect();
      return lx >= r.left && lx <= r.right && ly >= r.top && ly <= r.bottom;
    };
    let target: HTMLElement | null = null;
    const current = this.badgeInfoFor?.isConnected && !this.badges.hidden && !this.hidden ? this.badgeInfoFor : null;
    if (current && !this.badgeInfo.hidden && under(this.badgeInfo)) {
      // On the box (which may cover the badges above): keep it.
      target = current;
    } else if (!this.badges.hidden && !this.hidden) {
      for (const el of this.badges.children) {
        if (el instanceof HTMLElement && el.dataset.info && under(el)) target = el;
      }
    }
    const now = performance.now();
    if (target) this.badgeInfoAwaySince = 0;
    else if (current) {
      // Moving from the badge to its box: keep it for a moment.
      this.badgeInfoAwaySince ||= now;
      if (now - this.badgeInfoAwaySince < BADGE_INFO_GRACE_MS) target = current;
    }
    if (!target) {
      this.badgeInfo.hidden = true;
      this.badgeInfoFor = null;
      return;
    }
    this.badgeInfoFor = target;
    const info = target.dataset.info ?? "";
    // Rebuilt only when the text changes, so a click never lands on a replaced element.
    if (this.badgeInfo.dataset.info !== info) {
      this.badgeInfo.dataset.info = info;
      const lines = info.split("\n");
      const action = lines.pop() ?? "";
      this.badgeInfo.replaceChildren(
        document.createTextNode(lines.join("\n")),
        Object.assign(document.createElement("span"), { className: "link", textContent: action }),
      );
    }
    this.badgeInfo.hidden = false;
    const r = target.getBoundingClientRect();
    const vis = this.visibleRange();
    const w = this.badgeInfo.offsetWidth;
    // Just above the badge, touching it, kept on screen: from the badge's left edge, or its
    // right edge when the badges are left of the pet.
    const x = this.badgeSide === "left" ? r.right - w : r.left;
    this.badgeInfo.style.left = `${Math.max(vis.left + 2, Math.min(x, vis.right - w - 2))}px`;
    this.badgeInfo.style.top = `${r.top + 1}px`;
  }

  /** Feeds the hover rules and turns what they decide into pet reactions or petting. */
  private updateHover(cursor: { x: number; y: number }, winX: number, winY: number): void {
    // Running to the middle for a reminder: under a still mouse it stops where it is (not
    // when it walks back to the edge to hide, nor to a remembrance's candle).
    const running = this.pet.state === "goto" && !this.peek?.leaving && !this.drag;
    const over = this.isNearSprite(cursor.x, cursor.y, winX, winY);
    if (this.runStopper.update(performance.now(), { running, over, cursor, unit: this.dpr })) {
      this.pet.target = null;
      const c = this.pet.cursor;
      if (c) this.pet.facing = c.x > this.pet.body.x ? 1 : -1;
      this.pet.fsm.set("alert", true);
    }
    const tier = moodTier(this.pet.mood);
    const events = this.hover.update(performance.now(), {
      over,
      cursor,
      unit: this.dpr,
      // Off while ringing or a bubble waits for an answer (a to-do's ✓ Done / Later): a
      // hover line would replace it and its buttons.
      canAttend:
        !this.drag &&
        !this.activeRing &&
        !this.awaitingAnswer() &&
        !this.hidden &&
        this.pet.mode === "free" &&
        this.pet.state !== "goto",
      unhappy: isHungry(this.pet.mood) ? "hungry" : tier === "grumpy" || tier === "sulking" ? "grumpy" : null,
    });
    for (const e of events) {
      if (e.type === "stroke") this.care({ label: "", kind: "pet" });
      else if (e.type === "dodge") this.pet.react({ type: "hover", phase: "dodge", reason: e.reason });
      else this.pet.react({ type: "hover", phase: e.type });
    }
  }

  /** The bubble shows buttons (a reminder) and nobody has answered yet. */
  private awaitingAnswer(): boolean {
    return !this.bubble.hidden && this.bubble.querySelector(".actions") !== null;
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
    for (const el of [this.bubble, this.badges, this.moodMeter, this.badgeInfo]) {
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
      playGame: (game) => this.playGame(game),
    };
  }

  /**
   * Opens a game; during a focus session (Focus → "Ask before games") the pet asks first,
   * before anything opens. While an alarm or timer rings, it asks once the ring is over.
   * (With the pet hidden the tray leaves the game out while focusing: see buildTrayItems.)
   */
  private playGame(game: string): void {
    if (!gameHeld(this.settings.pomodoro, this.pomodoro)) {
      void this.backend.openGame(game);
      return;
    }
    if (this.activeRing) {
      this.pendingGame = game;
      return;
    }
    const until = this.pomodoro.endsAt ? ` until ${clock(this.pomodoro.endsAt)}` : "";
    this.say(`We're focusing${until}. Play anyway?`, 15_000, [
      { label: "Play anyway", run: () => void this.backend.openGame(game) },
      { label: "Cancel", run: () => {} },
    ]);
  }

  private petMenuContext(): PetMenuContext {
    return {
      ...this.menuContext(),
      character: this.character.def,
      hungry: isHungry(this.pet.mood),
      rng: this.pet.rng,
      care: (a) => this.care(a),
      hide: () => void this.hidePet(),
    };
  }

  private onContextMenu(e: MouseEvent): void {
    e.preventDefault();
    void showPetMenu(e, this.petMenuContext());
  }

  /**
   * Hooks for the end-to-end tests (e2e/; debug builds started with EPET_E2E only): both
   * menus as data and "clicking" their items (the same actions the native menus run), and
   * what the pet is doing.
   */
  testHooks() {
    type Entry = Item | "sep";
    const menus = {
      pet: () => buildItems(this.petMenuContext()),
      tray: () => buildTrayItems({ ...this.menuContext(), petVisible: this.petVisible }),
    };
    const outline = (items: Entry[]): unknown[] =>
      items.map((i) => (i === "sep" ? "—" : i.items ? { text: i.text, items: outline(i.items) } : i.checked ? `✓ ${i.text}` : i.text));
    return {
      menu: (which: keyof typeof menus) => outline(menus[which]()),
      /** Runs the item at `path` (each step: the start of an item's text); returns its text. */
      run: async (which: keyof typeof menus, path: string[]) => {
        let items: Entry[] = menus[which]();
        let item: Item | undefined;
        for (const step of path) {
          item = items.find((i): i is Item => i !== "sep" && i.text.startsWith(step));
          if (!item) throw new Error(`No menu item "${step}" in ${JSON.stringify(outline(items))}`);
          items = item.items ?? [];
        }
        if (!item) throw new Error("Empty menu path");
        // The tray's own items (show/hide, Quit) are handled by the app, as a click would be.
        if (item.id) await this.backend.e2eTray(item.id);
        else item.action?.();
        return item.text;
      },
      care: (kind: CareAction["kind"]) => this.care({ label: "", kind }),
      /** The mouse arriving on the pet (as syncWindow does when the cursor comes over it). */
      hoverIn: () => this.welcomeBack(),
      /** The settings in force (stored ones merged with the defaults). */
      settings: () => this.settings,
      state: () => ({
        state: this.pet.state,
        frames: this.frames,
        mode: this.pet.mode,
        target: this.pet.target,
        x: this.pet.body.x,
        y: this.pet.body.y,
        dpr: this.dpr,
        area: this.peekArea(),
        hidden: this.hidden,
        petVisible: this.petVisible,
        peek: !!this.peek,
        ringing: !!this.activeRing,
        prompting: this.prompting,
        mood: { ...this.pet.mood },
        character: this.character.def.id,
        pomodoro: this.pomodoro,
        vigil: (this.pet.scratch.vigil as Vigil | undefined) ?? null,
        celebration: this.lastCelebration,
        celebrating: this.celebrating,
        facing: this.pet.facing,
        size: this.pet.spriteSize,
        speed: this.pet.speed,
      }),
    };
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
        const when = !e.dueAt
          ? ""
          : e.allDay
            ? ` · ${new Date(e.dueAt).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })}`
            : ` · ${new Date(e.dueAt).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}`;
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
    // An alarm or reminder ringing stops the anniversary music.
    if (onTimeout) {
      this.stopMusic?.();
      this.stopMusic = null;
    }
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
    // Hidden and not coming out for this kind (Settings → Alerts): nobody can answer it, so
    // it counts as unanswered at once and waits in "While I was hidden you missed…".
    if (!r.peek && !this.petVisible) {
      void this.unansweredWhileHidden(r);
      return;
    }
    // Hidden (or behind a mini-game): come out for it.
    if (r.peek || this.hidden) this.enterPeek();
    if (r.kind === "todo") {
      if (this.activeRing) this.queued.push(r);
      else if (r.allDay) this.remindDayTodo(r);
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

  /**
   * A to-do without a time: they all come due at the same moment (the day's reminder time), so
   * the ones arriving together are told in one bubble ("📅 Today: • bins • pay bills").
   */
  private remindDayTodo(r: ReminderEvent): void {
    this.dayTodos.push(r);
    if (this.dayTodos.length > 1) return;
    setTimeout(() => {
      const list = this.dayTodos;
      this.dayTodos = [];
      if (this.activeRing) this.queued.push(...list);
      else if (list.length === 1) this.remindTodo(list[0]);
      else this.remindDayTodos(list);
    }, DAY_TODO_GATHER_MS);
  }

  private remindDayTodos(list: ReminderEvent[]): void {
    const alert = this.settings.alerts.todo;
    const run = alert.petRuns && this.pomodoro.phase !== "focus";
    this.pet.react({ type: "reminder", kind: "todo", title: list.map((r) => r.title).join(", "), run });
    const actions: BubbleAction[] = [
      { label: "Open To-dos", run: () => void this.backend.openPanel("todos") },
      { label: "Later", run: () => list.forEach((r) => this.later(r)) },
    ];
    const lines = ["📅 Today:", ...list.map((r) => `• ${r.title}`)];
    this.say(lines, 60_000, actions, this.peek ? () => list.forEach((r) => void this.unansweredWhileHidden(r)) : undefined);
    if (alert.ring) playRingtone(alert.ringtone, alert.volume);
  }

  /** "Later": a to-do with a time moves 10 minutes on; one on a day keeps its day and reminds again. */
  private later(r: ReminderEvent): void {
    const at = Date.now() + 10 * 60_000;
    void this.backend.updateTodo(r.id, r.allDay ? { remindAt: at } : { dueAt: at });
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
      { label: "Later", run: () => this.later(r) },
    ];
    // Out of hiding for it, an unanswered reminder is recorded for when you show the pet.
    this.say(text, 60_000, actions, this.peek ? () => void this.unansweredWhileHidden(r) : undefined);
    if (alert.ring) playRingtone(alert.ringtone, alert.volume);
  }

  /**
   * An anniversary (docs/INTERACTIONS.md, "Anniversaries"): the pet says the day's words for as
   * long as the celebration lasts. The app plays the fireworks or candle in its own window;
   * in the browser mock they're drawn over this page. A ringing alarm goes first.
   */
  private onCelebrate(c: Celebration): void {
    if (c.peek) this.enterPeek();
    // One at a time: several on one day come in turn (remembrances first), and an alarm
    // ringing goes first.
    if (this.activeRing || this.celebrating) {
      this.celebrations.push(c);
      return;
    }
    this.celebrating = true;
    this.lastCelebration = c;
    setTimeout(() => {
      this.celebrating = false;
      this.nextQueued();
    }, c.seconds * 1000 + CELEBRATION_GAP_MS);
    const [line, sub] = celebrationLines(c.anniversary, c.years);
    const remembrance = c.anniversary.kind === "remembrance";
    // A remembrance is quiet: the pet walks aside from the candle (in the middle of the
    // screen) and sits facing it; then it roams again from there.
    if (remembrance && c.effect) this.keepVigil(c.seconds);
    else if (remembrance) this.pet.fsm.set("sit", true);
    else this.pet.react({ type: "praise" });
    this.say(sub ? [line, sub] : line, c.seconds * 1000, [], undefined, true);
    const music = this.settings.celebrate;
    if (music.music) {
      this.stopMusic?.();
      const stop = playMusic(musicFor(c.anniversary), c.seconds, music.musicVolume);
      this.stopMusic = stop;
      setTimeout(() => {
        if (this.stopMusic === stop) this.stopMusic = null;
      }, c.seconds * 1000);
    }
    if (!c.effect) return;
    if (this.windowed) {
      void this.backend.showCelebration(c);
      return;
    }
    const canvas = document.createElement("canvas");
    // Under the pet and its bubble, like the app's window under the pet's.
    Object.assign(canvas.style, { position: "fixed", inset: "0", width: "100vw", height: "100vh", pointerEvents: "none", zIndex: "0" });
    document.body.prepend(canvas);
    const b = this.pet.body;
    void playEffect(canvas, { ...celebrationEffect(c.anniversary), ms: c.seconds * 1000, petX: b.x / this.dpr, petY: b.y / this.dpr }).then(() =>
      canvas.remove(),
    );
  }

  /**
   * The candle stands in the middle of the pet's screen: the pet walks to whichever side is
   * nearer (the other if there's no room), clear of the flowers with its bubble, and sits
   * facing the candle for `seconds`.
   */
  private keepVigil(seconds: number): void {
    const area = this.peekArea();
    if (!area || this.drag) {
      this.pet.fsm.set("sit", true);
      return;
    }
    const { reach } = candleLayout(area.w / this.dpr, area.h / this.dpr);
    const centre = area.x + area.w / 2;
    const away = (reach + VIGIL_BUBBLE_CLEARANCE) * this.dpr;
    const margin = this.pet.spriteSize.w;
    let side: 1 | -1 = this.pet.body.x < centre ? -1 : 1;
    const fits = (s: 1 | -1) => (s === -1 ? centre - away - margin >= area.x : centre + away + margin <= area.x + area.w);
    if (!fits(side) && fits(side === 1 ? -1 : 1)) side = side === 1 ? -1 : 1;
    const x = Math.min(area.x + area.w - margin, Math.max(area.x + margin, centre + side * away));
    const vigil: Vigil = { face: side === 1 ? -1 : 1, seconds };
    this.pet.scratch.vigil = vigil;
    this.pet.target = { x };
    this.pet.fsm.set("walkTo", true);
  }

  private nextQueued(): void {
    if (this.activeRing || this.celebrating) return;
    const party = this.celebrations.shift();
    if (party) {
      this.onCelebrate(party);
      return;
    }
    const r = this.queued.shift();
    if (r) this.onReminder(r);
    else if (this.unseenPending && this.petVisible) void this.tellUnseen();
    else if (this.pendingGame) {
      // A game asked for while ringing: ask now (or just open it, if the focus is over).
      const game = this.pendingGame;
      this.pendingGame = null;
      this.playGame(game);
    }
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
      await this.backend.markAlarmMissed(id);
      if (this.peek) await this.recordUnseen(alarm);
    } else if (this.peek) {
      // Rung out of hiding: told when the pet is shown again, not as a badge.
      await this.recordUnseen(alarm);
    } else {
      // When it rang (as in Finished), not when the ring gave up on you.
      this.doneTimers = [...this.doneTimers, { id, label: alarm.label, at: alarm.rangAt ?? Date.now() }];
    }
    await this.refreshTimers();
  }

  /** Remembers an alarm, timer or to-do the hidden pet couldn't get answered. */
  private async recordUnseen(item: Alarm | ReminderEvent, todoDue?: number): Promise<void> {
    let entry: Omit<Unseen, "id">;
    if ("kind" in item && item.kind === "todo") {
      entry = { kind: "todo", refId: item.id, title: item.title, at: todoDue ?? Date.now(), snoozes: 0 };
    } else {
      const a = item as Alarm;
      entry = isTimer(a)
        ? { kind: "timer", refId: a.id, title: `${timerName(a)} timer`, at: a.rangAt ?? Date.now(), snoozes: 0 }
        : // The label, not alarmName: the line adds the date and time itself.
          { kind: "alarm", refId: a.id, title: a.label || "Alarm", at: alarmTime(a) ?? Date.now(), snoozes: a.snoozes };
    }
    await this.backend.recordUnseen(entry);
  }

  /**
   * Due while the pet is hidden and not coming out for it (or unanswered out of hiding): an
   * alarm is missed at once (nobody can answer its snoozes), a timer is done, and each waits
   * in "While I was hidden you missed…".
   */
  private async unansweredWhileHidden(r: ReminderEvent): Promise<void> {
    if (r.kind === "todo") {
      const todo = (await this.backend.listTodos()).find((t) => t.id === r.id);
      // A day's to-do is listed at its reminder time, not its midnight.
      await this.recordUnseen(r, (todo && todoRemindsAt(todo, this.settings.todoDayTime)) ?? undefined);
      return;
    }
    await this.refreshTimers();
    const alarm = this.timers.find((a) => a.id === r.id);
    if (!alarm) return;
    if (!isTimer(alarm)) await this.backend.markAlarmMissed(alarm.id);
    await this.refreshTimers();
    await this.recordUnseen(this.timers.find((a) => a.id === r.id) ?? alarm);
  }

  /**
   * Shown again: "While I was hidden you missed:" and the list, with each item's date. It
   * stays until Done (an important bubble: chatter and petting can't replace it), which
   * clears the list and the badges of the missed alarms in it.
   */
  private async tellUnseen(): Promise<void> {
    const list = await this.backend.listUnseen();
    if (!list.length) return;
    if (this.activeRing) {
      this.unseenPending = true;
      return;
    }
    this.unseenPending = false;
    // Its alarms are told here, not again on hover (welcomeBack).
    for (const u of list) if (u.kind === "alarm") this.announcedMissed.add(u.refId);
    this.say(
      unseenLines(list),
      24 * 60 * 60_000,
      [{ label: "Done", run: () => void this.backend.clearUnseen().then(() => this.refreshTimers()) }],
      undefined,
      true,
    );
  }

  // --- Out of hiding for a reminder ("peek") --------------------------------

  /** Brought out (or still out): from the nearest screen edge; the reminder sends it to the middle. */
  private enterPeek(): void {
    if (this.peek) {
      this.peek.leaving = null;
      return;
    }
    this.peek = { since: Date.now(), leaving: null };
    const area = this.peekArea();
    if (area) {
      const b = this.pet.body;
      const margin = this.pet.spriteSize.w;
      b.x = b.x - area.x < area.x + area.w - b.x ? area.x + margin : area.x + area.w - margin;
      b.support = null;
      b.vx = 0;
      b.y = Math.min(b.y, area.y + area.h);
    }
    if (this.hidden) this.setHidden(false);
    // Out for something: it goes to the middle of the screen whatever its mood.
    if (area) {
      this.pet.target = { x: area.x + area.w / 2 };
      this.pet.fsm.set("goto", true);
    }
  }

  private peekArea() {
    const world = this.pet.world;
    if (!world?.areas.length) return null;
    const i = areaIndexAt(world, this.pet.body.x, this.pet.body.y - 1);
    return world.areas[Math.max(0, i)];
  }

  /**
   * Out for a reminder: once nothing rings, waits or talks any more, walk to the nearest
   * edge, then hide again (end_peek; the user may have shown the pet meanwhile).
   */
  private watchPeek(): void {
    const peek = this.peek;
    if (!peek) return;
    const busy = this.activeRing || this.queued.length || !this.bubble.hidden || this.prompting || this.drag;
    if (busy || Date.now() - peek.since < 3000) {
      peek.leaving = null;
      return;
    }
    const area = this.peekArea();
    if (!peek.leaving) {
      const b = this.pet.body;
      const x = !area ? b.x : b.x - area.x < area.x + area.w - b.x ? area.x : area.x + area.w;
      peek.leaving = { x, since: Date.now() };
      this.pet.target = { x };
      this.pet.fsm.set("goto", true);
      return;
    }
    const arrived = Math.abs(this.pet.body.x - peek.leaving.x) < this.pet.spriteSize.w;
    if (arrived || Date.now() - peek.leaving.since > 10_000) {
      this.peek = null;
      void this.backend.endPeek();
      // In the browser (and behind a mini-game) the pet hides itself.
      if ((!this.windowed && !this.petVisible) || this.gameOn) this.setHidden(true);
    }
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
