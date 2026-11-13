import { AnimationPlayer, type AnimationDef } from "../../../engine/animation";
import { createRng, type Rng } from "../../../engine/random";
import type { SpriteAtlas } from "../../../engine/sprites";
import { t } from "../../../i18n";
import { h } from "../../../panel/dom";
import { levelName, LEVELS, parseLevel, type Level } from "../levels";
import {
  COLS,
  goEndless,
  HOLD,
  LAST_LEVEL,
  LIVES,
  move,
  newGame,
  parseTheme,
  ROWS,
  step,
  stopHere,
  THEME_CHOICES,
  TUNING,
  type Cause,
  type Dir,
  type State,
  type ThemeChoice,
  type ThemeId,
} from "./logic";
import { drawBoard, THEME, themeName } from "./themes";

export interface Options {
  level: Level;
  theme: ThemeChoice;
  /** Sound effects, and the music behind the game (each theme its own piece). */
  sounds: boolean;
  music: boolean;
}

/** What is heard (src/pet/sound.ts, CrossingSound). */
export type Sound = "start" | "hop" | "bump" | "splash" | "timeup" | "tick" | "level" | "over" | "cleared";

/** After a pause, the game is back after "3, 2, 1". */
export const RESUME_MS = 3000;

export interface Hooks {
  /** The pet's name, and how it's drawn. */
  name: string;
  atlas: SpriteAtlas;
  animations: Record<string, AnimationDef>;
  load(key: string): string | null;
  store(key: string, value: string): void;
  /** The best score so far (0: none). */
  best: number;
  /** A game is over: its score, the level reached, whether all 20 levels were done. */
  finished(score: number, level: number, cleared: boolean): void;
  /** All 20 levels done (the first time in a game). */
  cleared(): void;
  close(): void;
  minimize(): void;
  onTop(on: boolean): void;
  sound(kind: Sound): void;
  /** The music of a theme from now on (null: none). */
  music(theme: ThemeId | null): void;
}

const OPTIONS_KEY = "epet-crossing-options";
const KEYS: Record<string, Dir> = {
  ArrowUp: "up",
  KeyW: "up",
  Space: "up",
  ArrowDown: "down",
  KeyS: "down",
  ArrowLeft: "left",
  KeyA: "left",
  ArrowRight: "right",
  KeyD: "right",
};

type Screen = "start" | "play" | "over" | "cleared";

/**
 * The Pet Crossing window: the pet hops up the board, level after level. The pet in it is
 * the desktop pet itself (it's off the desktop meanwhile, as in Safe Landing).
 */
export class Crossing {
  options: Options;
  state: State;
  screen: Screen = "start";
  /** Paused: why, and when "3, 2, 1" ends (0: until you continue). */
  paused: { reason: string; resumeAt: number } | null = null;
  private skipBusy = false;
  /** Another window clicked pauses the game (the end-to-end tests turn it off: they click around). */
  pauseOnBlur = true;
  private best: number;
  private newBest = false;
  /** What the banner over the board says, and until when. */
  private banner = { text: "", good: false, until: 0 };
  private readonly rng: Rng;
  private readonly anim: AnimationPlayer;
  private facing: 1 | -1 = 1;
  /** A hop being drawn: where it came from (cells away) and how far along it is. */
  private hop = { dx: 0, dy: 0, t: 1 };
  private cell = 44;
  private last = performance.now();

  private readonly canvas = h("canvas", { class: "xg-canvas" });
  private readonly ctx: CanvasRenderingContext2D;
  private readonly stage = h("div", { class: "xg-stage" });
  private readonly overlay = h("div", { class: "xg-overlay" });
  private readonly bannerEl = h("div", { class: "xg-banner", role: "status" });
  private readonly levelEl = h("strong", { class: "xg-level" });
  private readonly livesEl = h("span", { class: "xg-lives" });
  private readonly barEl = h("div", { class: "xg-timebar" });
  private readonly secsEl = h("span", { class: "xg-secs" });
  private readonly scoreEl = h("strong", { class: "xg-score" });
  private readonly themeEl = h("span", {});
  private readonly bestEl = h("span", {});
  private readonly pauseBtn = h("button", { class: "t24-icon xg-pause", onclick: () => this.togglePause() }, "⏸");
  private readonly musicBtn = h("button", { class: "t24-icon xg-music", onclick: () => this.setOptions({ music: !this.options.music }) }, "♪");
  private readonly soundBtn = h("button", { class: "t24-icon xg-sound", onclick: () => this.setOptions({ sounds: !this.options.sounds }) }, "🔔");
  /** The music playing now (a theme's), and the second last ticked. */
  private playing: ThemeId | null = null;
  private ticked = 0;

  constructor(
    private readonly root: HTMLElement,
    private readonly hooks: Hooks,
    seed = Date.now() & 0xffffff,
  ) {
    this.rng = createRng(seed);
    this.ctx = this.canvas.getContext("2d")!;
    this.anim = new AnimationPlayer(hooks.animations);
    this.anim.play("idle");
    this.best = hooks.best;
    this.options = this.loadOptions();
    // Behind the start screen: the board as it will look.
    this.state = newGame(this.options.level, this.options.theme, this.rng);
    this.build();
    window.addEventListener("keydown", (e) => this.onKey(e));
    window.addEventListener("resize", () => this.resize());
    // Another window clicked: the clock doesn't run on behind your back.
    window.addEventListener("blur", () => {
      if (this.pauseOnBlur && this.screen === "play" && !this.paused) this.pause("you");
    });
    this.resize();
    this.renderOverlay();
    requestAnimationFrame((now) => this.frame(now));
  }

  private loadOptions(): Options {
    try {
      const o = JSON.parse(this.hooks.load(OPTIONS_KEY) ?? "{}") as Partial<Options>;
      return { level: parseLevel(o.level), theme: parseTheme(o.theme), sounds: o.sounds !== false, music: o.music !== false };
    } catch {
      return { level: "normal", theme: "cute", sounds: true, music: true };
    }
  }

  /** Picked on the start screen, or ♪ / 🔔 in the head (kept for the next games). */
  setOptions(patch: Partial<Options>): void {
    const lanes = "level" in patch || "theme" in patch;
    this.options = { ...this.options, ...patch };
    this.hooks.store(OPTIONS_KEY, JSON.stringify(this.options));
    if (lanes && this.screen === "start") this.state = newGame(this.options.level, this.options.theme, this.rng);
    this.toggles();
    if (lanes || this.screen === "start") this.renderOverlay();
  }

  private sound(kind: Sound): void {
    if (this.options.sounds) this.hooks.sound(kind);
  }

  /** The music follows the game: the level's theme while it's played, none while it waits. */
  private syncMusic(): void {
    const want = this.options.music && this.screen === "play" && !this.paused ? this.state.theme : null;
    if (want === this.playing) return;
    this.playing = want;
    this.hooks.music(want);
  }

  private toggles(): void {
    const set = (b: HTMLElement, on: boolean, text: string) => {
      b.classList.toggle("off", !on);
      b.setAttribute("aria-pressed", String(on));
      b.title = text;
      b.setAttribute("aria-label", text);
    };
    set(this.musicBtn, this.options.music, this.options.music ? t("Music: on") : t("Music: off"));
    set(this.soundBtn, this.options.sounds, this.options.sounds ? t("Sound effects: on") : t("Sound effects: off"));
  }

  // --- Playing -------------------------------------------------------------------

  /** A new game, at what the start screen says. */
  start(): void {
    this.state = newGame(this.options.level, this.options.theme, this.rng);
    this.screen = "play";
    this.paused = null;
    this.skipBusy = false;
    this.newBest = false;
    this.banner.until = 0;
    this.hop.t = 1;
    this.anim.play("idle");
    this.hooks.onTop(true);
    this.sound("start");
    this.renderOverlay();
  }

  /** Back to the start screen (to pick again). */
  toStart(): void {
    this.screen = "start";
    this.paused = null;
    this.state = newGame(this.options.level, this.options.theme, this.rng);
    this.anim.play("idle");
    this.renderOverlay();
  }

  /** One hop (a key, or a button of the pad). */
  go(dir: Dir): void {
    if (this.screen !== "play" || this.paused) return;
    const s = this.state;
    const from = { x: s.x, row: s.row };
    const events = move(s, dir);
    if (!events.includes("hop")) return;
    if (dir === "left") this.facing = -1;
    else if (dir === "right") this.facing = 1;
    this.hop = { dx: from.x - s.x, dy: from.row - s.row, t: 0 };
    if (events.includes("level")) {
      this.say(t("Level {n} done! +{bonus}", { n: s.level, bonus: Math.ceil(s.time) * s.level }), true);
      this.sound("level");
      this.play("happy");
    } else {
      this.sound("hop");
      this.play("jump");
    }
  }

  private play(anim: string): void {
    if (anim in this.hooks.animations) this.anim.play(anim, true);
  }

  private say(text: string, good: boolean): void {
    this.banner = { text, good, until: performance.now() + 1400 };
  }

  private causeLine(cause: Cause | null): string {
    return cause === "time" ? t("Time's up! −1 life") : cause === "fell" ? t("Missed your footing! −1 life") : t("Bumped! −1 life");
  }

  private advance(dt: number): void {
    const s = this.state;
    for (const e of step(s, dt, this.rng)) {
      if (e === "died") {
        this.say(this.causeLine(s.cause), false);
        this.sound(s.cause === "time" ? "timeup" : s.cause === "fell" ? "splash" : "bump");
        this.play("alert");
      } else if (e === "respawn") {
        this.hop.t = 1;
        this.anim.play("idle");
      } else if (e === "over") this.over(false);
      else if (e === "cleared") {
        this.sound("cleared");
        this.screen = "cleared";
        this.hooks.cleared();
        this.renderOverlay();
      }
    }
    // The last five seconds tick.
    const secs = Math.ceil(s.time);
    if (s.phase === "playing" && secs <= 5 && secs > 0 && secs !== this.ticked) this.sound("tick");
    this.ticked = secs;
    // The hop over (or a new level begun): it stands again.
    if (s.phase === "playing" && this.hop.t >= 1 && this.anim.current !== "idle") this.anim.play("idle");
  }

  private over(cleared: boolean): void {
    const s = this.state;
    this.screen = "over";
    if (!cleared) this.sound("over");
    this.newBest = s.score > this.best;
    this.best = Math.max(this.best, s.score);
    this.hooks.finished(s.score, s.level, cleared || s.endless);
    this.renderOverlay();
  }

  /** After level 20: endless levels, or enough. */
  endless(on: boolean): void {
    if (this.screen !== "cleared") return;
    if (on) {
      goEndless(this.state, this.rng);
      this.screen = "play";
      this.hop.t = 1;
      this.anim.play("idle");
      this.renderOverlay();
    } else {
      stopHere(this.state);
      this.over(true);
    }
  }

  // --- Pausing (Esc, another window, the pet needing you, minimized) ------------------

  togglePause(): void {
    if (this.screen !== "play") return;
    if (!this.paused) this.pause("you");
    else if (!this.paused.resumeAt) this.keepPlaying();
  }

  /** The pet rings or asks (null: it's over). */
  busy(reason: string | null): void {
    if (reason === null) {
      this.skipBusy = false;
      if (this.paused && ["ring", "ask", "celebrate"].includes(this.paused.reason) && !this.paused.resumeAt) this.resumeSoon();
      return;
    }
    if (this.skipBusy || this.screen !== "play") return;
    this.pause(reason);
    this.hooks.onTop(false);
  }

  minimize(): void {
    if (this.screen === "play") this.pause("minimized");
    this.hooks.minimize();
  }

  restored(): void {
    if (this.paused?.reason === "minimized") this.resumeSoon();
  }

  keepPlaying(): void {
    if (!this.paused) return;
    this.skipBusy = ["ring", "ask", "celebrate"].includes(this.paused.reason);
    this.resumeSoon();
  }

  private pause(reason: string): void {
    this.paused = { reason, resumeAt: 0 };
    this.renderOverlay();
  }

  private resumeSoon(): void {
    if (!this.paused) return;
    this.paused.resumeAt = performance.now() + RESUME_MS;
    this.renderOverlay();
  }

  private onKey(e: KeyboardEvent): void {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
    const start = e.code === "Space" || e.code === "Enter";
    if (e.code === "Escape" || e.code === "KeyP") this.togglePause();
    else if (this.screen === "play" && KEYS[e.code]) {
      // One hop a press (a held key doesn't run).
      if (!e.repeat) this.go(KEYS[e.code]);
    } else if (start && !e.repeat && (this.screen === "start" || this.screen === "over")) this.start();
    else return;
    e.preventDefault();
  }

  // --- Drawing ---------------------------------------------------------------------

  private frame(now: number): void {
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    if (this.paused?.resumeAt && now >= this.paused.resumeAt) {
      this.paused = null;
      this.hooks.onTop(true);
      this.renderOverlay();
    }
    if (this.screen === "play" && !this.paused) {
      this.advance(dt);
      this.hop.t = Math.min(1, this.hop.t + dt / 0.08);
      this.anim.update(dt);
    } else if (this.paused?.resumeAt) {
      const el = this.overlay.querySelector(".t24-pause-count");
      if (el) el.textContent = String(Math.max(1, Math.ceil((this.paused.resumeAt - now) / 1000)));
    }
    this.syncMusic();
    this.draw(now);
    this.hud(now);
    requestAnimationFrame((n) => this.frame(n));
  }

  private resize(): void {
    const r = this.stage.getBoundingClientRect();
    if (!r.width || !r.height) return;
    this.cell = Math.max(16, Math.floor(Math.min(r.width / COLS, r.height / ROWS)));
    const ratio = window.devicePixelRatio || 1;
    const [w, hgt] = [COLS * this.cell, ROWS * this.cell];
    this.canvas.width = Math.round(w * ratio);
    this.canvas.height = Math.round(hgt * ratio);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${hgt}px`;
    this.ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  }

  private draw(now: number): void {
    const { ctx, cell, hooks } = this;
    const s = this.state;
    const font = getComputedStyle(this.root).fontFamily;
    drawBoard(ctx, s, cell, t(THEME[s.theme].goal), font);
    // The pet: where it is, a hop's arc on the way there.
    const p = 1 - this.hop.t;
    const x = (s.x + this.hop.dx * p + 0.5) * cell;
    const y = (s.row + this.hop.dy * p + 1) * cell - cell * 0.1 - Math.sin(this.hop.t * Math.PI) * cell * 0.22 * (this.hop.t < 1 ? 1 : 0);
    const { atlas } = hooks;
    let scale = Math.max(1, Math.round((cell * 0.85) / Math.max(atlas.width, atlas.height)));
    ctx.save();
    if (s.phase === "dead") {
      // It blinks where it came to grief; into the river it sinks.
      const left = Math.max(0, s.hold / HOLD);
      ctx.globalAlpha = Math.floor(now / 90) % 2 ? 0.35 : 0.9;
      if (s.cause === "fell") scale *= 0.5 + 0.5 * left;
    }
    atlas.draw(ctx, this.anim.frame, x, y, scale, this.facing);
    ctx.restore();
  }

  /** The numbers above the board, and the banner on it. */
  private hud(now: number): void {
    const s = this.state;
    const set = (el: HTMLElement, text: string) => {
      if (el.textContent !== text) el.textContent = text;
    };
    set(this.levelEl, s.endless ? t("Level {n} · endless", { n: s.level }) : t("Level {n}", { n: s.level }));
    const lives = Array.from({ length: LIVES }, (_, i) => (i < s.lives ? "♥" : "♡")).join("");
    set(this.livesEl, lives);
    this.livesEl.setAttribute("aria-label", t("Lives: {n}", { n: s.lives }));
    const share = Math.max(0, s.time / TUNING[s.difficulty].time);
    this.barEl.style.width = `${share * 100}%`;
    this.barEl.className = `xg-timebar${share <= 0.25 ? " bad" : share <= 0.5 ? " warn" : ""}`;
    set(this.secsEl, String(Math.ceil(s.time)));
    set(this.scoreEl, String(s.score));
    const theme = this.options.theme === "random" ? `${t(themeName("random"))} → ${t(THEME[s.theme].name)}` : t(THEME[s.theme].name);
    set(this.themeEl, t("Theme: {theme}", { theme }));
    set(this.bestEl, this.best ? t("Best {n}", { n: this.best }) : "");
    const showing = now < this.banner.until && this.screen === "play";
    set(this.bannerEl, showing ? this.banner.text : "");
    this.bannerEl.className = `xg-banner${showing ? " on" : ""}${this.banner.good ? " good" : ""}`;
    this.pauseBtn.disabled = this.screen !== "play";
  }

  private build(): void {
    const pad = (dir: Dir, cls: string, label: string, ...kids: (Node | string)[]) =>
      h(
        "button",
        {
          class: cls,
          "data-go": dir,
          "aria-label": label,
          tabIndex: -1,
          // The keyboard stays with the game (Space mustn't press a button again).
          onmousedown: (e: Event) => e.preventDefault(),
          onclick: () => this.go(dir),
        },
        ...kids,
      );
    const key = (text: string) => h("kbd", {}, text);
    const header = h(
      "header",
      { class: "t24-head", "data-tauri-drag-region": "" },
      h("strong", { "data-tauri-drag-region": "" }, t("Pet Crossing")),
      h("span", { class: "grow", "data-tauri-drag-region": "" }),
      this.musicBtn,
      this.soundBtn,
      this.pauseBtn,
      h("button", { class: "t24-icon", title: t("Minimize (pauses the game)"), "aria-label": t("Minimize (pauses the game)"), onclick: () => this.minimize() }, "–"),
      h("button", { class: "t24-icon", title: t("Close"), "aria-label": t("Close"), onclick: () => this.hooks.close() }, "×"),
    );
    this.toggles();
    this.pauseBtn.title = t("Pause (Esc)");
    this.pauseBtn.setAttribute("aria-label", t("Pause (Esc)"));
    const hud = h(
      "div",
      { class: "xg-hud" },
      this.levelEl,
      this.livesEl,
      h("div", { class: "xg-time", role: "timer", "aria-label": t("Seconds left") }, this.barEl, this.secsEl),
      h("span", { class: "xg-scorebox" }, h("small", {}, t("Score")), this.scoreEl),
    );
    this.stage.append(this.canvas, this.bannerEl, this.overlay);
    const controls = h(
      "div",
      { class: "xg-controls" },
      h(
        "div",
        { class: "xg-pad" },
        pad("up", "up", t("Forward"), "▲", h("small", {}, "W / Space")),
        pad("left", "left", t("Left"), h("small", {}, "A"), "◀"),
        pad("down", "down", t("Back"), h("small", {}, "S"), "▼"),
        pad("right", "right", t("Right"), h("small", {}, "D"), "▶"),
      ),
      h(
        "ul",
        { class: "xg-keys" },
        h("li", {}, key("↑"), key("↓"), key("←"), key("→"), " / ", key("W"), key("A"), key("S"), key("D"), " ", t("move (back too)")),
        h("li", {}, key("Space"), " ", t("forward")),
        h("li", {}, key("Esc"), " ", t("pause")),
      ),
    );
    this.root.replaceChildren(header, h("div", { class: "xg-body" }, hud, h("div", { class: "xg-sub" }, this.themeEl, this.bestEl), this.stage, controls));
  }

  private chips<T extends string>(label: string, name: string, values: readonly T[], current: T, text: (v: T) => string, pick: (v: T) => void): HTMLElement {
    return h(
      "div",
      { class: "xg-group", role: "group", "aria-label": label },
      h("span", { class: "xg-group-label" }, label),
      h(
        "div",
        { class: "xg-chips" },
        ...values.map((v) => h("button", { class: v === current ? "selected" : "", [`data-${name}`]: v, "aria-pressed": String(v === current), onclick: () => pick(v) }, text(v))),
      ),
    );
  }

  private renderOverlay(): void {
    const s = this.state;
    const name = this.hooks.name;
    let view: HTMLElement | null = null;
    const onOff = (v: "on" | "off") => (v === "on" ? t("On") : t("Off"));
    if (this.screen === "start") {
      view = h(
        "div",
        { class: "xg-screen xg-start" },
        h("h2", {}, t("Pet Crossing")),
        h("p", {}, t("{name} hops up one cell at a time: dodge what moves along the road, ride what slides along the river, and reach the goal at the top before the time runs out.", { name })),
        this.chips(t("Difficulty"), "level", LEVELS, this.options.level, levelName, (level) => this.setOptions({ level })),
        this.chips(t("Theme"), "theme", THEME_CHOICES, this.options.theme, (c) => t(themeName(c)), (theme) => this.setOptions({ theme })),
        h(
          "div",
          { class: "xg-switches" },
          this.chips(t("Music"), "music", ["on", "off"] as const, this.options.music ? "on" : "off", onOff, (v) => this.setOptions({ music: v === "on" })),
          this.chips(t("Sound effects"), "sounds", ["on", "off"] as const, this.options.sounds ? "on" : "off", onOff, (v) => this.setOptions({ sounds: v === "on" })),
        ),
        h("button", { class: "primary xg-go", onclick: () => this.start() }, t("Start")),
        h("p", { class: "t24-fine" }, t("Three lives. Each level is faster; after level {n} it asks about endless levels.", { n: LAST_LEVEL })),
      );
    } else if (this.screen === "over") {
      view = h(
        "div",
        { class: "xg-screen xg-over" },
        h("h2", {}, s.lives > 0 ? t("Well played!") : t("Game over")),
        h("p", { class: "xg-result" }, t("Reached level {n} · Score {score}", { n: s.level, score: s.score })),
        this.newBest ? h("p", { class: "xg-newbest" }, t("A new best!")) : this.best ? h("p", {}, t("Best {n}", { n: this.best })) : null,
        h(
          "div",
          { class: "xg-buttons" },
          h("button", { class: "primary xg-again", onclick: () => this.start() }, t("Play again")),
          h("button", { class: "xg-settings", onclick: () => this.toStart() }, t("Change settings")),
        ),
      );
    } else if (this.screen === "cleared") {
      view = h(
        "div",
        { class: "xg-screen xg-cleared" },
        h("h2", {}, t("All {n} levels done!", { n: LAST_LEVEL })),
        h("p", {}, t("{name} asks: one more round? Endless levels, faster and faster.", { name })),
        h(
          "div",
          { class: "xg-buttons" },
          h("button", { class: "primary xg-endless", onclick: () => this.endless(true) }, t("Let's go!")),
          h("button", { class: "xg-stop", onclick: () => this.endless(false) }, t("Stop here")),
        ),
      );
    } else if (this.paused) {
      const p = this.paused;
      const counting = p.resumeAt > 0;
      const why =
        p.reason === "ring"
          ? t("Paused: {name} is ringing", { name })
          : p.reason === "ask"
            ? t("Paused: {name} is asking you something", { name })
            : p.reason === "celebrate"
              ? t("Paused: a celebration")
              : t("Paused");
      const pet = ["ring", "ask", "celebrate"].includes(p.reason);
      view = h(
        "div",
        { class: "t24-pause", role: "status" },
        h("div", { class: "t24-pause-why" }, counting ? t("Back to it in") : why),
        h("div", { class: "t24-pause-count" }, counting ? String(Math.max(1, Math.ceil((p.resumeAt - performance.now()) / 1000))) : "⏸"),
        !counting && p.reason !== "minimized" ? h("button", { class: "xg-continue", onclick: () => this.keepPlaying() }, pet ? t("Keep playing") : t("Continue")) : null,
        !counting && !pet && p.reason !== "minimized" ? h("button", { class: "xg-settings", onclick: () => this.toStart() }, t("Change settings")) : null,
      );
    }
    this.overlay.replaceChildren(...(view ? [view] : []));
    this.overlay.classList.toggle("on", !!view);
  }

  // --- The end-to-end tests ----------------------------------------------------------

  snapshot() {
    const s = this.state;
    return {
      screen: this.screen,
      paused: this.paused ? { reason: this.paused.reason, counting: this.paused.resumeAt > 0 } : null,
      options: this.options,
      level: s.level,
      lives: s.lives,
      score: s.score,
      time: s.time,
      x: s.x,
      row: s.row,
      theme: s.theme,
      endless: s.endless,
      phase: s.phase,
      cause: s.cause,
      best: this.best,
      banner: performance.now() < this.banner.until ? this.banner.text : "",
      music: this.playing,
      cell: this.cell,
    };
  }

  /**
   * The lanes as a test needs them: the road empty ("clear") or full ("wall"), the river
   * covered ("bridge") or bare ("gap"), all standing still; and the level, lives and seconds.
   */
  rig(r: { road?: "clear" | "wall"; river?: "bridge" | "gap"; level?: number; lives?: number; time?: number }): void {
    const s = this.state;
    for (const lane of s.lanes) {
      if (!lane) continue;
      const how = lane.kind === "road" ? r.road : r.river;
      if (!how) continue;
      const full = how === "wall" || how === "bridge";
      Object.assign(lane, { speed: 0, offset: 0, count: full ? 1 : 0, gap: COLS, width: COLS });
    }
    if (r.level !== undefined) s.level = r.level;
    if (r.lives !== undefined) s.lives = r.lives;
    if (r.time !== undefined) s.time = r.time;
  }
}
