import { createRng, type Rng } from "../../../engine/random";
import { t } from "../../../i18n";
import { h } from "../../../panel/dom";
import {
  apply,
  dailyHand,
  deal,
  face,
  handOf,
  is24,
  isRed,
  label,
  OP_SIGN,
  OPS,
  petPlan,
  READY_MS,
  STEP_GRACE_MS,
  stepText,
  type DealOptions,
  type Frac,
  type Hand,
  type Level,
  type LevelChoice,
  type Op,
  type PetPlan,
  type Suit,
} from "./logic";
import type { PetStage } from "./stage";

export type Mode = "race" | "practice" | "timed" | "daily";

export interface Options extends DealOptions {
  level: LevelChoice;
  /** A "ding-dong" for a right answer and a "boop" for a wrong one. */
  sounds: boolean;
}

export const DEFAULT_OPTIONS: Options = { hard: true, unsolvable: false, level: "mood", sounds: true };

/** Hands in a round (race and practice). */
export const ROUND = 13;
/** A timed round's length. */
export const TIMED_MS = 120_000;
/** Recent hands kept so the next rounds don't repeat them. */
const RECENT = 80;

interface Card {
  value: Frac;
  text: string;
  suit: Suit | null;
  used: boolean;
  /** Made from two others (not dealt). */
  made: boolean;
}

export interface Hooks {
  /** The pet's name, for "Vs Cat". */
  name: string;
  /** Its level now when it follows its mood. */
  moodLevel: Level;
  stage: PetStage;
  load(key: string): string | null;
  store(key: string, value: string): void;
  /** A round is over: `won` in a race (or any point elsewhere), the score to keep. */
  finished(won: boolean, score: number, raceWon: boolean): void;
  close(): void;
  /** Plays the right or wrong sound (the app's "Other sounds" setting may keep it quiet). */
  sound(kind: "right" | "wrong"): void;
  now?: () => number;
}

/** Today in the computer's time zone, "2026-11-04". */
function today(now: number): string {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const seconds = (ms: number) => (ms / 1000).toFixed(1);

/** The 24 Points window: a board of four cards, with the pet on top. */
export class TwentyFour {
  mode: Mode = "race";
  options: Options;
  private rng: Rng;
  private hand!: Hand;
  private cards: Card[] = [];
  private history: Card[][] = [];
  /** "8 ÷ 3 = 8/3" for each move made (undone with its card snapshot). */
  private moves: string[] = [];
  /** The most moves made on this hand (Undo doesn't take it back): the pet waits a bit for each. */
  private furthest = 0;
  private pick: number | null = null;
  private op: Op | null = null;
  /** playing: working on a hand; over: the hand is done (Next); done: the round is over. */
  phase: "playing" | "over" | "done" = "playing";
  handNo = 0;
  you = 0;
  pet = 0;
  private solved = 0;
  private fastest: number | null = null;
  private dealtAt = 0;
  private endsAt = 0;
  /** 0: no help yet; 1–3: hint steps shown; 4: the whole answer. */
  hint = 0;
  private wrongNone = false;
  message = "";
  private messageGood = false;
  /** How the last move came out: 24, or one card that isn't 24. */
  private outcome: "right" | "wrong" | null = null;
  /** The answer shown (by the pet, or after "I can't get it"). */
  private revealed = false;
  private plan: PetPlan | null = null;
  petState: "idle" | "thinking" | "ready" | "found" | "stuck" = "idle";
  private round = new Set<string>();
  private nextTimer = 0;
  private showOptions = false;
  private readonly root: HTMLElement;

  constructor(
    root: HTMLElement,
    private readonly hooks: Hooks,
    seed = Date.now() & 0xffffff,
  ) {
    this.root = root;
    this.rng = createRng(seed);
    this.options = this.loadOptions();
    window.addEventListener("keydown", (e) => this.onKey(e));
    setInterval(() => this.tick(), 100);
  }

  private now() {
    return this.hooks.now?.() ?? Date.now();
  }

  private loadOptions(): Options {
    try {
      const raw = JSON.parse(this.hooks.load("epet.24.options") ?? "null");
      return { ...DEFAULT_OPTIONS, ...(raw && typeof raw === "object" ? raw : {}) };
    } catch {
      return { ...DEFAULT_OPTIONS };
    }
  }

  private saveOptions() {
    this.hooks.store("epet.24.options", JSON.stringify(this.options));
  }

  private recent(): string[] {
    try {
      const r = JSON.parse(this.hooks.load("epet.24.recent") ?? "[]");
      return Array.isArray(r) ? r.filter((k) => typeof k === "string") : [];
    } catch {
      return [];
    }
  }

  get level(): Level {
    return this.options.level === "mood" ? this.hooks.moodLevel : this.options.level;
  }

  // --- Rounds and hands ------------------------------------------------------

  start(mode: Mode = this.mode): void {
    clearTimeout(this.nextTimer);
    this.mode = mode;
    this.you = this.pet = this.solved = this.handNo = 0;
    this.fastest = null;
    this.round = new Set();
    this.showOptions = false;
    this.hooks.stage.set("rest");
    this.hooks.stage.say("");
    if (mode === "daily") {
      const done = this.daily();
      if (done) {
        this.phase = "done";
        this.render();
        return;
      }
    }
    this.endsAt = mode === "timed" ? this.now() + TIMED_MS : 0;
    this.next();
  }

  /** A given hand instead of a dealt one (the end-to-end tests). */
  dealHand(ranks: number[]): void {
    this.begin(handOf(ranks, this.rng));
  }

  private next(): void {
    clearTimeout(this.nextTimer);
    const over = this.mode === "timed" ? this.now() >= this.endsAt : this.mode === "daily" ? this.handNo >= 1 : this.handNo >= ROUND;
    if (over) return this.finish();
    if (this.mode === "daily") return this.begin(dailyHand(today(this.now())));
    const recent = new Set(this.recent());
    this.begin(deal(this.rng, this.options, this.round, recent));
  }

  private begin(hand: Hand): void {
    clearTimeout(this.nextTimer);
    this.hand = hand;
    this.handNo++;
    this.round.add(hand.key);
    if (this.mode !== "daily") this.hooks.store("epet.24.recent", JSON.stringify([...this.recent().filter((k) => k !== hand.key), hand.key].slice(-RECENT)));
    this.cards = hand.ranks.map((r, i) => ({ value: { n: r, d: 1 }, text: face(r), suit: hand.suits[i], used: false, made: false }));
    this.history = [];
    this.moves = [];
    this.furthest = 0;
    this.outcome = null;
    this.revealed = false;
    this.pick = this.op = null;
    this.hint = 0;
    this.wrongNone = false;
    this.message = "";
    this.phase = "playing";
    this.dealtAt = this.now();
    this.plan = this.mode === "race" ? petPlan(hand.kind, this.level, this.rng) : null;
    this.petState = this.plan ? "thinking" : "idle";
    const stage = this.hooks.stage;
    stage.set(this.plan ? "think" : "rest");
    stage.say(this.plan && this.handNo === 1 ? t("Let's see who's quicker!") : "", 2500);
    this.render();
  }

  private finish(): void {
    this.phase = "done";
    const stage = this.hooks.stage;
    const raceWon = this.mode === "race" && this.you > this.pet;
    if (this.mode === "race") {
      if (this.you > this.pet) {
        stage.set("sulk");
        stage.say(t("Not fair! One more round!"));
      } else if (this.pet > this.you) {
        stage.set("cheer");
        stage.say(t("I win this time! Hehe."));
      } else {
        stage.set("rest");
        stage.say(t("A draw! Again?"));
      }
    } else {
      stage.set("cheer");
      stage.say(t("That was fun!"), 4000);
    }
    if (this.mode === "daily") this.hooks.store("epet.24.daily", JSON.stringify({ date: today(this.now()), ms: this.fastest, helped: this.hint > 0, solved: this.solved > 0 }));
    this.hooks.finished(raceWon || (this.mode !== "race" && this.solved > 0), Math.max(0, this.you), raceWon);
    this.render();
  }

  /** Today's hand already played: what happened (null if not yet). */
  private daily(): { ms: number | null; helped: boolean; solved: boolean } | null {
    try {
      const d = JSON.parse(this.hooks.load("epet.24.daily") ?? "null");
      return d && d.date === today(this.now()) ? d : null;
    } catch {
      return null;
    }
  }

  // --- Playing a hand ----------------------------------------------------------

  private get live(): number[] {
    return this.cards.flatMap((c, i) => (c.used ? [] : [i]));
  }

  tapCard(i: number): void {
    if (this.phase !== "playing" || this.cards[i]?.used) return;
    if (this.pick === null || this.op === null) {
      this.pick = this.pick === i ? null : i;
      this.op = null;
    } else if (this.pick === i) {
      this.pick = null;
      this.op = null;
    } else {
      this.combine(this.pick, this.op, i);
    }
    this.render();
  }

  tapOp(op: Op): void {
    if (this.phase !== "playing" || this.pick === null) return;
    this.op = this.op === op ? null : op;
    this.render();
  }

  private combine(a: number, op: Op, b: number): void {
    const r = apply(this.cards[a].value, op, this.cards[b].value);
    if (!r) {
      this.say(t("Can't divide by 0"), false);
      this.op = null;
      this.sound("wrong");
      return;
    }
    this.history.push(this.cards.map((c) => ({ ...c })));
    this.moves.push(`${this.cards[a].text} ${OP_SIGN[op]} ${this.cards[b].text} = ${label(r)}`);
    this.cards[a].used = true;
    this.cards[b] = { value: r, text: label(r), suit: null, used: false, made: true };
    this.op = null;
    this.message = "";
    if (this.history.length > this.furthest) {
      // Getting somewhere: the pet gives you a little longer.
      this.furthest = this.history.length;
      if (this.plan) this.plan = { ...this.plan, ms: this.plan.ms + STEP_GRACE_MS };
    }
    const left = this.live;
    if (left.length > 1) {
      this.pick = b;
      return;
    }
    this.pick = null;
    if (is24(r)) return this.solvedByYou();
    this.outcome = "wrong";
    this.say(t("Makes {n}, not 24. Undo a step or start over.", { n: label(r) }), false);
    this.sound("wrong");
    if (this.mode === "race") this.hooks.stage.say(t("Hehe, so close~"), 2500);
  }

  private sound(kind: "right" | "wrong") {
    if (this.options.sounds) this.hooks.sound(kind);
  }

  /** Back to the four cards dealt. */
  restart(): void {
    if (this.phase !== "playing" || !this.history.length) return;
    this.cards = this.history[0];
    this.history = [];
    this.moves = [];
    this.pick = this.op = null;
    this.outcome = null;
    this.message = "";
    this.render();
  }

  undo(): void {
    if (this.phase !== "playing" || !this.history.length) return;
    this.cards = this.history.pop()!;
    this.moves.pop();
    this.outcome = null;
    this.pick = this.op = null;
    this.message = "";
    this.render();
  }

  private say(text: string, good: boolean) {
    this.message = text;
    this.messageGood = good;
  }

  private solvedByYou(): void {
    const ms = this.now() - this.dealtAt;
    this.solved++;
    const stage = this.hooks.stage;
    this.outcome = "right";
    this.sound("right");
    if (this.hint > 0) {
      this.say(t("Got it! (no point after help)"), true);
    } else {
      this.you++;
      this.fastest = this.fastest === null ? ms : Math.min(this.fastest, ms);
      this.say(t("Got it! +1 ({s} s)", { s: seconds(ms) }), true);
    }
    if (this.mode === "race") {
      stage.set("sulk");
      stage.say(t("You got it first!"), 2500);
    } else if (this.hint === 0) {
      stage.set("cheer");
      stage.say(t("Nice one!"), 2000);
    }
    // Timed rounds go on by themselves (after a moment to see it); the others wait for Next.
    this.endHand(this.mode === "timed" ? 1500 : 0);
  }

  /** "No answer!" (with hands without an answer mixed in). */
  noAnswer(): void {
    if (this.phase !== "playing" || this.wrongNone || !this.options.unsolvable) return;
    const stage = this.hooks.stage;
    if (this.hand.kind === "none") {
      this.you++;
      this.solved++;
      this.say(t("Right, no answer! +1"), true);
      this.sound("right");
      stage.set(this.mode === "race" ? "sulk" : "cheer");
      stage.say(this.mode === "race" ? t("You called it first!") : t("Nice one!"), 2000);
      this.endHand(this.mode === "timed" ? 1500 : 0);
    } else {
      this.you--;
      this.wrongNone = true;
      this.say(t("There is an answer! −1"), false);
      this.sound("wrong");
      stage.say(t("Hehe, there is one."), 2500);
      this.render();
    }
  }

  /** "I can't get it": the pet helps (practice, daily) or answers (race), or the next hand (timed). */
  cantGetIt(): void {
    if (this.phase !== "playing") return;
    const stage = this.hooks.stage;
    const sol = this.hand.solution;
    if (this.mode === "race") {
      if (this.plan?.finds) {
        this.pet++;
        stage.set("cheer");
        stage.say(sol ? t("{expr} = 24!", { expr: sol.expr }) : t("No answer for this one!"));
      } else {
        stage.set("rest");
        stage.say(t("I couldn't find it either…"), 3000);
      }
      this.petState = "found";
      this.reveal();
      return this.endHand(0);
    }
    if (this.mode === "timed") {
      this.reveal();
      return this.endHand(2000);
    }
    // Practice and daily: one step at a time, from the dealt cards.
    if (!sol) {
      this.hint = 4;
      this.say(t("No answer for this one."), false);
      stage.set("help");
      stage.say(t("This one has no answer. Next!"), 3000);
      return this.endHand(0);
    }
    if (this.history.length) this.cards = this.history[0];
    this.history = [];
    this.moves = [];
    this.outcome = null;
    this.pick = this.op = null;
    this.hint++;
    stage.set("help");
    const step = sol.steps[this.hint - 1];
    if (this.hint === 1) stage.say(t("Watch me: first {step}.", { step: stepText(step) }));
    else if (this.hint < 3) stage.say(t("Then {step}.", { step: stepText(step) }));
    else {
      this.hint = 4;
      stage.say(t("{expr} = 24!", { expr: sol.expr }));
      this.reveal();
      return this.endHand(0);
    }
    this.message = "";
    this.render();
  }

  private reveal() {
    const sol = this.hand.solution;
    this.revealed = true;
    this.say(sol ? t("Answer: {expr} = 24", { expr: sol.expr }) : t("No answer for this one."), false);
  }

  /** The hand is done; the next one comes after `ms` (0: when Next is pressed). */
  private endHand(ms: number) {
    this.phase = "over";
    this.plan = null;
    this.render();
    if (ms > 0) this.nextTimer = window.setTimeout(() => this.next(), ms);
  }

  nextHand(): void {
    if (this.phase === "over") this.next();
    else if (this.phase === "done") this.start();
  }

  /** What the board shows (the end-to-end tests). */
  snapshot() {
    const stage = this.hooks.stage;
    return {
      mode: this.mode,
      phase: this.phase,
      handNo: this.handNo,
      you: this.you,
      pet: this.pet,
      hint: this.hint,
      petState: this.petState,
      petMs: this.plan?.ms ?? null,
      message: this.message,
      kind: this.hand?.kind ?? null,
      key: this.hand?.key ?? null,
      cards: this.cards.map((c) => ({ text: c.text, used: c.used })),
      options: this.options,
      level: this.level,
      pose: stage.current,
      bubble: stage.saying,
    };
  }

  /** The pet has the answer now, 3 s before it says it (the end-to-end tests). */
  petReady(): void {
    if (this.plan) this.dealtAt = this.now() - (this.plan.ms - READY_MS);
    this.tick();
  }

  /** A timed round's time runs out now (the end-to-end tests). */
  timeUp(): void {
    if (this.mode === "timed") this.endsAt = this.now();
    this.tick();
  }

  /** The pet answers now (the end-to-end tests). */
  petNow(): void {
    if (this.plan) this.dealtAt = this.now() - this.plan.ms;
    this.tick();
  }

  private tick() {
    if (this.mode === "timed" && this.phase !== "done" && this.now() >= this.endsAt) {
      if (this.phase === "playing") this.reveal();
      return this.finish();
    }
    if (this.mode === "timed" && this.phase !== "done") this.renderClock();
    const plan = this.plan;
    if (!plan || this.phase !== "playing") return;
    const at = this.now() - this.dealtAt;
    const stage = this.hooks.stage;
    if (plan.finds && this.petState === "thinking" && at >= plan.ms - READY_MS) {
      this.petState = "ready";
      stage.set("ready");
      stage.say(t("Got it~ Take your time, I'll say it in {s} seconds.", { s: READY_MS / 1000 }));
      this.render();
    }
    if (at < plan.ms) {
      if (this.petState !== "stuck") this.renderClock();
      return;
    }
    if (!plan.finds) {
      if (this.petState !== "stuck") {
        this.petState = "stuck";
        stage.set("rest");
        stage.say(t("I can't find it… your turn."), 4000);
        this.render();
      }
      return;
    }
    this.pet++;
    this.petState = "found";
    stage.set("cheer");
    const sol = this.hand.solution;
    stage.say(sol ? t("{expr} = 24!", { expr: sol.expr }) : t("No answer for this one!"));
    this.revealed = true;
    this.say(sol ? t("{name}: {expr} = 24", { name: this.hooks.name, expr: sol.expr }) : t("{name}: no answer for this one", { name: this.hooks.name }), false);
    this.endHand(0);
  }

  private onKey(e: KeyboardEvent) {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
    const ops: Record<string, Op> = { "+": "+", "-": "-", "*": "*", x: "*", X: "*", "/": "/" };
    if (/^[1-4]$/.test(e.key)) this.tapCard(Number(e.key) - 1);
    else if (ops[e.key]) this.tapOp(ops[e.key]);
    else if (e.key === "Backspace" || e.key === "z") this.undo();
    else if (e.key === "Enter" || e.key === " ") this.nextHand();
    else if (e.key === "Escape") this.hooks.close();
    else return;
    e.preventDefault();
  }

  // --- Drawing -----------------------------------------------------------------

  private clockEl: HTMLElement | null = null;

  private renderClock() {
    const el = this.clockEl;
    if (!el) return;
    if (this.mode === "timed") {
      const left = Math.max(0, this.endsAt - this.now());
      el.querySelector(".t24-bar > div")?.setAttribute("style", `width: ${(left / TIMED_MS) * 100}%`);
      el.querySelector(".t24-clock-text")!.textContent = t("{s} s left", { s: Math.ceil(left / 1000) });
    } else if (this.plan) {
      const at = this.now() - this.dealtAt;
      el.querySelector(".t24-bar > div")?.setAttribute("style", `width: ${Math.min(100, (at / this.plan.ms) * 100)}%`);
      if (this.petState === "ready") el.querySelector(".t24-clock-text")!.textContent = t("{name} has it: answers in {s} s", { name: this.hooks.name, s: Math.max(0, Math.ceil((this.plan.ms - at) / 1000)) });
    }
  }

  render(): void {
    const tabs: [Mode, string][] = [
      ["race", t("Vs {name}", { name: this.hooks.name })],
      ["practice", t("Practice")],
      ["timed", t("Timed")],
      ["daily", t("Daily|game")],
    ];
    const header = h(
      "header",
      { class: "t24-head", "data-tauri-drag-region": "" },
      h("strong", { "data-tauri-drag-region": "" }, t("24 Points")),
      h(
        "nav",
        { class: "t24-tabs" },
        ...tabs.map(([m, text]) => h("button", { class: m === this.mode ? "on" : "", "data-mode": m, onclick: () => this.start(m) }, text)),
      ),
      h("button", { class: "t24-icon", title: t("Options"), "aria-label": t("Options"), "aria-expanded": String(this.showOptions), onclick: () => ((this.showOptions = !this.showOptions), this.render()) }, "⚙"),
      h("button", { class: "t24-icon", title: t("Close"), "aria-label": t("Close"), onclick: () => this.hooks.close() }, "×"),
    );
    const body = this.showOptions ? this.optionsView() : this.phase === "done" ? this.resultView() : this.handView();
    this.root.replaceChildren(header, body);
  }

  private handView(): HTMLElement {
    const hard = this.hand.kind === "hard";
    const top = h(
      "div",
      { class: "t24-top" },
      h(
        "div",
        { class: "t24-score" },
        this.mode === "race" ? t("You {you} : {pet} {name}", { you: this.you, pet: this.pet, name: this.hooks.name }) : t("Score {n}", { n: this.you }),
      ),
      h(
        "div",
        { class: "t24-count" },
        this.mode === "timed" ? t("Hand {n}", { n: this.handNo }) : this.mode === "daily" ? t("Today's hand") : t("Hand {n} / {total}", { n: this.handNo, total: ROUND }),
        hard ? h("b", { class: "t24-hard" }, ` · ${t("Hard")}`) : null,
      ),
    );
    const clock =
      this.mode === "timed" || this.plan
        ? h(
            "div",
            { class: "t24-clock" },
            h(
              "div",
              { class: "t24-clock-text" },
              this.mode === "timed"
                ? ""
                : this.petState === "ready"
                  ? t("{name} has it: answers in {s} s", { name: this.hooks.name, s: READY_MS / 1000 })
                  : this.petState === "stuck"
                    ? t("{name} is stuck", { name: this.hooks.name })
                    : t("{name} is thinking…", { name: this.hooks.name }),
            ),
            h("div", { class: "t24-bar" }, h("div", {})),
          )
        : null;
    this.clockEl = clock;
    const note = hard && this.phase === "playing" && this.mode !== "race" ? h("div", { class: "t24-note" }, t("This one's tricky: it needs fractions.")) : null;
    const step = this.hint > 0 && this.hint < 4 ? this.hand.solution?.steps[0] : undefined;
    const hinted = (i: number) => {
      if (!step || this.hint !== 1 || this.history.length) return false;
      const c = this.cards[i];
      const first = this.cards.findIndex((x) => !x.used && label(x.value) === label(step.a));
      const second = this.cards.findIndex((x, k) => k !== first && !x.used && label(x.value) === label(step.b));
      return !c.used && (i === first || i === second);
    };
    const cards = h(
      "div",
      { class: "t24-cards" },
      ...this.cards.map((c, i) =>
        h(
          "button",
          {
            class: ["t24-card", c.used ? "used" : "", c.made ? "made" : "", this.pick === i ? "picked" : "", hinted(i) ? "hinted" : "", !c.used && this.outcome ? this.outcome : ""].filter(Boolean).join(" "),
            disabled: c.used || this.phase !== "playing",
            "aria-label": c.used ? t("Used") : c.text,
            onclick: () => this.tapCard(i),
          },
          h("span", { class: "t24-rank" }, c.text),
          c.suit
            ? h("span", { class: isRed(c.suit) ? "t24-suit red" : "t24-suit" }, c.suit)
            : h("span", { class: "t24-suit" }, !c.used && this.outcome ? (this.outcome === "right" ? "✓" : "✗") : " "),
        ),
      ),
    );
    const sol = this.hand.solution;
    // One line per move; the last says how it came out. Shown answers are written the same way.
    const shown = this.revealed && sol ? sol.steps.map((st) => stepText(st)) : null;
    const done = shown ? "right" : this.outcome;
    const lines = (shown ?? this.moves).map((text, k, all) =>
      h("div", { class: k === all.length - 1 && done ? `t24-line ${done}` : "t24-line" }, k === all.length - 1 && done ? `${text}  ${done === "right" ? "✓" : "✗"}` : text),
    );
    const partial =
      this.phase === "playing" && this.pick !== null
        ? h(
            "div",
            { class: "t24-line t24-partial" },
            `${this.cards[this.pick].text}${this.op ? ` ${OP_SIGN[this.op]}` : ""} `,
            h("span", { class: "t24-caret" }, "▍"),
            h("small", {}, `  ${this.op ? t("Pick another card") : t("Pick a sign")}`),
          )
        : null;
    const work = h(
      "div",
      { class: "t24-work" },
      this.hint > 0 && this.hint < 4 && sol
        ? h("div", { class: "t24-hint" }, h("small", {}, t("{name}'s hint (step {n} of 3)", { name: this.hooks.name, n: this.hint })), h("div", {}, sol.steps.slice(0, this.hint).map((st) => stepText(st)).join("   ·   ")))
        : null,
      ...lines,
      partial,
      !lines.length && !partial && this.phase === "playing" ? h("div", { class: "t24-line t24-placeholder" }, t("Pick a card, a sign, then another card")) : null,
      this.message ? h("div", { class: this.messageGood ? "t24-msg good" : "t24-msg" }, this.message) : null,
    );
    const ops = h(
      "div",
      { class: "t24-ops" },
      ...OPS.map((op) => h("button", { class: this.op === op ? "on" : "", disabled: this.phase !== "playing" || this.pick === null, "aria-label": OP_SIGN[op], onclick: () => this.tapOp(op) }, OP_SIGN[op])),
    );
    const actions =
      this.phase === "over"
        ? h(
            "div",
            { class: "t24-actions" },
            h("span", { class: "t24-fine" }, t("Enter works too")),
            h("span", { class: "grow" }),
            h("button", { class: "primary", onclick: () => this.nextHand() }, this.lastHand ? t("See the result") : t("Next hand →")),
          )
        : h(
            "div",
            { class: "t24-actions" },
            h("button", { class: this.outcome === "wrong" ? "warn" : "", disabled: !this.history.length || this.phase !== "playing", onclick: () => this.undo() }, t("↶ Undo a step")),
            h("button", { class: this.outcome === "wrong" ? "warn" : "", disabled: !this.history.length || this.phase !== "playing", onclick: () => this.restart() }, t("⟲ Start over")),
            h("span", { class: "grow" }),
            this.options.unsolvable && this.mode !== "daily"
              ? h("button", { class: "t24-none", disabled: this.wrongNone || this.phase !== "playing", onclick: () => this.noAnswer() }, t("No answer!"), h("small", {}, ` ${t("(wrong: −1)")}`))
              : null,
            h(
              "button",
              { class: "primary", disabled: this.phase !== "playing", onclick: () => this.cantGetIt() },
              this.hint > 0 && this.hint < 4 ? t("Show the next step") : t("I can't get it"),
            ),
          );
    const help = this.mode === "practice" || this.mode === "daily" ? h("p", { class: "t24-fine" }, t("After help, a hand scores 0.")) : null;
    const el = h("div", { class: "t24-body" }, top, clock, note, cards, work, ops, actions, help);
    queueMicrotask(() => this.renderClock());
    return el;
  }

  private get lastHand() {
    return this.mode === "daily" || (this.mode !== "timed" && this.handNo >= ROUND);
  }

  private resultView(): HTMLElement {
    const name = this.hooks.name;
    let title: string;
    const lines: string[] = [];
    if (this.mode === "race") {
      title = this.you > this.pet ? t("You win!") : this.pet > this.you ? t("{name} wins!", { name }) : t("A draw");
      lines.push(t("You {you} : {pet} {name}", { you: this.you, pet: this.pet, name }));
    } else if (this.mode === "timed") {
      title = t("{n} solved in 2 minutes", { n: this.solved });
      lines.push(t("Score {n}", { n: this.you }));
    } else if (this.mode === "daily") {
      const d = this.daily();
      title = t("Today's hand");
      lines.push(!d || !d.solved ? t("Not solved") : d.helped ? t("Solved with help") : t("Solved in {s} s", { s: seconds(d.ms ?? 0) }));
      lines.push(t("A new hand comes tomorrow."));
    } else {
      title = t("{n} of {total} solved", { n: this.solved, total: ROUND });
      lines.push(t("Score {n}", { n: this.you }));
    }
    if (this.fastest !== null && this.mode !== "daily") lines.push(t("Your fastest: {s} s", { s: seconds(this.fastest) }));
    return h(
      "div",
      { class: "t24-body t24-result" },
      h("h2", {}, title),
      ...lines.map((l) => h("p", {}, l)),
      h("p", { class: "t24-mood" }, t("Played with {name}: happier now", { name })),
      h(
        "div",
        { class: "t24-actions" },
        this.mode === "daily"
          ? h("button", { class: "primary", onclick: () => this.start("practice") }, t("Practice instead"))
          : h("button", { class: "primary", onclick: () => this.start() }, t("Play again")),
        h("button", { onclick: () => this.hooks.close() }, t("Close")),
      ),
    );
  }

  private optionsView(): HTMLElement {
    const set = (patch: Partial<Options>) => {
      this.options = { ...this.options, ...patch };
      this.saveOptions();
    };
    const radio = <T extends string>(name: string, value: T, current: T, text: string, onpick: (v: T) => void) =>
      h(
        "label",
        { class: "t24-radio" },
        h("input", { type: "radio", name, value, checked: value === current, onchange: () => onpick(value) }),
        text,
      );
    const levels: [LevelChoice, string][] = [
      ["mood", t("Follows its mood (now: {level})", { level: levelName(this.hooks.moodLevel) })],
      ["easy", levelName("easy")],
      ["normal", levelName("normal")],
      ["strong", levelName("strong")],
    ];
    return h(
      "div",
      { class: "t24-body t24-options" },
      h("h3", {}, t("Hands")),
      radio("hands", "normal", this.options.hard ? "all" : "normal", t("Normal only"), () => set({ hard: false })),
      radio("hands", "all", this.options.hard ? "all" : "normal", t("Normal and hard (hard ones need fractions)"), () => set({ hard: true })),
      h(
        "label",
        { class: "t24-radio" },
        h("input", { type: "checkbox", name: "unsolvable", checked: this.options.unsolvable, onchange: (e: Event) => set({ unsolvable: (e.target as HTMLInputElement).checked }) }),
        t("Mix in hands with no answer (a “No answer!” button: right +1, wrong −1)"),
      ),
      h(
        "label",
        { class: "t24-radio" },
        h("input", { type: "checkbox", name: "sounds", checked: this.options.sounds, onchange: (e: Event) => set({ sounds: (e.target as HTMLInputElement).checked }) }),
        t("Sounds for right and wrong answers"),
      ),
      h("h3", {}, t("{name}'s level", { name: this.hooks.name })),
      ...levels.map(([v, text]) => radio("level", v, this.options.level, text, (l) => set({ level: l }))),
      h("div", { class: "t24-actions" }, h("span", { class: "grow" }), h("button", { class: "primary", onclick: () => this.start() }, t("Done: new round"))),
    );
  }
}

export function levelName(l: Level): string {
  return l === "easy" ? t("Easy") : l === "normal" ? t("Normal") : t("Won't go easy");
}
