import { createRng, type Rng } from "../../../engine/random";
import { msg, t } from "../../../i18n";
import { h } from "../../../panel/dom";
import type { PetStage } from "../twenty-four/stage";
import { goesNext, legalMoves, newGame, other, petMove, play, thinkMs, type Level, type Player, type Rules, type State } from "./logic";

/** The tabs: three games against the pet, and two players at one computer. */
export type Mode = Rules | "duo";
export type LevelChoice = Level | "mood";

/** The pet's own mark: the cat's paw print, the rooster's footprint (others: a dot). */
export type Mark = "paw" | "foot" | "dot";

export interface Options {
  level: LevelChoice;
  /** Two players: which game. */
  duoRules: Rules;
  sounds: boolean;
}

export const DEFAULT_OPTIONS: Options = { level: "mood", duoRules: "classic", sounds: true };
/** After a pause, the board is back after "3, 2, 1". */
export const RESUME_MS = 3000;

export interface Hooks {
  /** The pet's name (another character picked meanwhile: its name). */
  name: string;
  mark: Mark;
  /** Its level now when it follows its mood. */
  moodLevel: Level;
  stage: PetStage;
  load(key: string): string | null;
  store(key: string, value: string): void;
  /** A game against the pet is over: whether you won, and your wins so far. */
  finished(won: boolean, wins: number): void;
  close(): void;
  minimize(): void;
  onTop(on: boolean): void;
  sound(kind: "right" | "wrong"): void;
  now?: () => number;
}

const OPTIONS_KEY = "epet-ttt-options";
/** The cells' names, for screen readers and the end-to-end tests. */
const PLACES = [msg("top left"), msg("top"), msg("top right"), msg("left"), msg("centre"), msg("right"), msg("bottom left"), msg("bottom"), msg("bottom right")];

const SVG_NS = "http://www.w3.org/2000/svg";
function svg(paths: string, cls: string, fill = false): SVGSVGElement {
  const el = document.createElementNS(SVG_NS, "svg");
  el.setAttribute("viewBox", "0 0 24 24");
  el.setAttribute("class", cls);
  el.setAttribute("aria-hidden", "true");
  el.innerHTML = paths;
  if (fill) el.setAttribute("fill", "currentColor");
  return el;
}

/** ✕, ○, or the pet's mark, as a drawing. */
function markOf(kind: "x" | "ring" | Mark): SVGSVGElement {
  switch (kind) {
    case "x":
      return svg('<path d="M5 5l14 14M19 5L5 19" stroke="currentColor" stroke-width="3" stroke-linecap="round" fill="none"/>', "ttt-mark x");
    case "ring":
      return svg('<circle cx="12" cy="12" r="7.5" stroke="currentColor" stroke-width="3" fill="none"/>', "ttt-mark ring");
    case "paw":
      return svg(
        '<ellipse cx="12" cy="15.5" rx="4.6" ry="3.9"/><ellipse cx="6.2" cy="10.2" rx="1.9" ry="2.4"/><ellipse cx="9.6" cy="6.6" rx="1.9" ry="2.5"/><ellipse cx="14.4" cy="6.6" rx="1.9" ry="2.5"/><ellipse cx="17.8" cy="10.2" rx="1.9" ry="2.4"/>',
        "ttt-mark pet",
        true,
      );
    case "foot":
      return svg(
        '<path d="M12 21V11M12 11L5.5 4.5M12 11V3M12 11l6.5-6.5M12 17l-3 2.5" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" fill="none"/>',
        "ttt-mark pet",
      );
    default:
      return svg('<circle cx="12" cy="12" r="6.5"/>', "ttt-mark pet", true);
  }
}

export function levelName(l: Level): string {
  return l === "easy" ? t("Easy") : l === "normal" ? t("Normal") : t("Won't go easy");
}

/** The tic-tac-toe window: a board of three games (or two players), with the pet on top. */
export class TicTacToe {
  mode: Mode = "classic";
  options: Options;
  state!: State;
  /** What was played, to take back (Undo). */
  private history: State[] = [];
  /** Games won this session: you (✕) and the pet / the second player (○). */
  you = 0;
  pet = 0;
  draws = 0;
  /** Who starts the next game (it takes turns). */
  private starts: Player = "x";
  /** The pet's move is coming at this time (0: not its turn). */
  private petAt = 0;
  /** Its move, picked when it's due. */
  private thinking = false;
  /** Paused: why, since when, and when "3, 2, 1" ends (0: still paused). */
  paused: { reason: string; since: number; resumeAt: number } | null = null;
  private skipBusy = false;
  private showOptions = false;
  private readonly rng: Rng;
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
      const o = JSON.parse(this.hooks.load(OPTIONS_KEY) ?? "{}") as Partial<Options>;
      return {
        level: (["mood", "easy", "normal", "strong"] as const).find((x) => x === o.level) ?? "mood",
        duoRules: (["classic", "vanishing", "ultimate"] as const).find((x) => x === o.duoRules) ?? "classic",
        sounds: o.sounds !== false,
      };
    } catch {
      return { ...DEFAULT_OPTIONS };
    }
  }

  private saveOptions() {
    this.hooks.store(OPTIONS_KEY, JSON.stringify(this.options));
  }

  get level(): Level {
    return this.options.level === "mood" ? this.hooks.moodLevel : this.options.level;
  }

  get duo(): boolean {
    return this.mode === "duo";
  }

  get rules(): Rules {
    return this.mode === "duo" ? this.options.duoRules : this.mode;
  }

  /** A mode picked (a tab): its score starts again. */
  start(mode: Mode = this.mode): void {
    if (mode !== this.mode) {
      this.you = this.pet = this.draws = 0;
      this.starts = "x";
    }
    this.mode = mode;
    this.showOptions = false;
    this.newGame();
  }

  /** The next game: the other one starts it. */
  newGame(): void {
    this.state = newGame(this.rules, this.starts);
    this.history = [];
    this.petAt = 0;
    this.hooks.stage.set("rest");
    if (!this.duo && this.state.turn === "o") this.petTurn();
    this.render();
  }

  // --- Playing -----------------------------------------------------------------

  /** A cell clicked (or its key). */
  tap(i: number): void {
    const s = this.state;
    if (this.paused || s.winner || (!this.duo && s.turn !== "x")) return;
    const next = play(s, i);
    if (next === s) return;
    this.history.push(s);
    this.state = next;
    if (next.winner) return this.over();
    if (!this.duo) this.petTurn();
    this.render();
  }

  /** The pet's turn: it paces while it thinks, then plays. */
  private petTurn(): void {
    this.petAt = this.now() + thinkMs(this.state, this.rng);
    this.hooks.stage.set("think");
  }

  private petPlays(): void {
    this.petAt = 0;
    this.thinking = true;
    const m = petMove(this.state, this.level, this.rng);
    this.thinking = false;
    this.history.push(this.state);
    this.state = play(this.state, m);
    this.hooks.stage.set("rest");
    if (this.state.winner) return this.over();
    this.render();
  }

  private over(): void {
    const s = this.state;
    const stage = this.hooks.stage;
    this.petAt = 0;
    if (s.winner === "x") this.you++;
    else if (s.winner === "o") this.pet++;
    else this.draws++;
    this.starts = other(this.starts);
    if (!this.duo) {
      if (s.winner === "o") {
        stage.set("cheer");
        stage.say(t("Three in a row! Mine!"), 5000);
      } else if (s.winner === "x") {
        stage.set("sulk");
        stage.say(t("Hmph… one more game!"), 5000);
      } else {
        stage.set("rest");
        stage.say(t("A draw. Again?"), 4000);
      }
      this.hooks.finished(s.winner === "x", this.you);
    } else stage.set("cheer");
    if (this.options.sounds) this.hooks.sound(s.winner === "o" && !this.duo ? "wrong" : "right");
    this.render();
  }

  /** Takes back your last move (and the pet's answer to it). */
  undo(): void {
    if (this.paused || !this.history.length) return;
    let back = this.history.pop()!;
    // Against the pet: back to your turn.
    while (!this.duo && back.turn === "o" && this.history.length) back = this.history.pop()!;
    if (!this.duo && back.turn === "o") return void this.history.push(back);
    if (this.state.winner) {
      // A finished game taken back: its result doesn't count.
      if (this.state.winner === "x") this.you--;
      else if (this.state.winner === "o") this.pet--;
      else this.draws--;
      this.starts = other(this.starts);
    }
    this.state = back;
    this.petAt = 0;
    this.hooks.stage.set("rest");
    this.render();
  }

  /** Gives up this game: the other side wins it. */
  resign(): void {
    const s = this.state;
    if (this.paused || s.winner || s.moves === 0) return;
    this.history.push(s);
    const loser: Player = this.duo ? s.turn : "x";
    this.state = { ...s, winner: other(loser), line: null };
    this.over();
  }

  // --- Pausing (as 24 Points) -----------------------------------------------------

  busy(reason: string | null): void {
    if (reason === null) {
      this.skipBusy = false;
      if (this.paused && this.paused.reason !== "minimized" && !this.paused.resumeAt) this.resumeSoon();
      return;
    }
    if (this.skipBusy) return;
    this.pause(reason);
    this.hooks.onTop(false);
  }

  minimize(): void {
    this.pause("minimized");
    this.hooks.minimize();
  }

  restored(): void {
    if (this.paused?.reason === "minimized") this.resumeSoon();
  }

  keepPlaying(): void {
    if (!this.paused) return;
    this.skipBusy = this.paused.reason !== "minimized";
    this.resumeSoon();
  }

  private pause(reason: string): void {
    if (this.paused) this.paused = { ...this.paused, reason, resumeAt: 0 };
    else this.paused = { reason, since: this.now(), resumeAt: 0 };
    this.render();
  }

  private resumeSoon(): void {
    if (!this.paused) return;
    this.paused.resumeAt = this.now() + RESUME_MS;
    this.render();
  }

  private resume(): void {
    const p = this.paused;
    if (!p) return;
    // The pet's thinking doesn't run on while paused.
    if (this.petAt) this.petAt += this.now() - p.since;
    this.paused = null;
    this.hooks.onTop(true);
    this.render();
  }

  characterChanged(name: string, mark: Mark, moodLevel: Level): void {
    this.hooks.name = name;
    this.hooks.mark = mark;
    this.hooks.moodLevel = moodLevel;
    this.render();
  }

  private tick(): void {
    if (this.paused) {
      if (this.paused.resumeAt && this.now() >= this.paused.resumeAt) this.resume();
      else {
        const el = this.root.querySelector(".t24-pause-count");
        if (this.paused.resumeAt && el) el.textContent = String(Math.max(1, Math.ceil((this.paused.resumeAt - this.now()) / 1000)));
      }
      return;
    }
    if (this.petAt && this.now() >= this.petAt && !this.thinking) this.petPlays();
  }

  /** The pet plays now (the end-to-end tests). */
  petNow(): void {
    if (this.petAt) this.petAt = this.now();
    this.tick();
  }

  snapshot() {
    const s = this.state;
    return {
      mode: this.mode,
      rules: s.rules,
      cells: s.cells,
      turn: s.turn,
      forced: s.forced,
      small: s.small,
      winner: s.winner,
      line: s.line,
      goesNext: { x: goesNext(s, "x"), o: goesNext(s, "o") },
      you: this.you,
      pet: this.pet,
      draws: this.draws,
      petThinking: this.petAt > 0,
      level: this.level,
      options: this.options,
      paused: this.paused ? { reason: this.paused.reason, counting: this.paused.resumeAt > 0 } : null,
      pose: this.hooks.stage.current,
      bubble: this.hooks.stage.saying,
    };
  }

  private onKey(e: KeyboardEvent) {
    if (this.paused && e.key !== "Escape") return;
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
    if (/^[1-9]$/.test(e.key) && this.rules !== "ultimate") this.tap(Number(e.key) - 1);
    else if (e.key === "Backspace" || e.key === "z") this.undo();
    else if ((e.key === "Enter" || e.key === " ") && this.state.winner) this.newGame();
    else if (e.key === "Escape") this.hooks.close();
    else return;
    e.preventDefault();
  }

  // --- Drawing -----------------------------------------------------------------

  /** Who is ✕ and ○ (or the pet's mark), by name. */
  private who(p: Player): string {
    if (this.duo) return p === "x" ? t("Player 1") : t("Player 2");
    return p === "x" ? t("You") : this.hooks.name;
  }

  private markFor(p: Player): SVGSVGElement {
    return p === "x" ? markOf("x") : markOf(this.duo ? "ring" : this.hooks.mark);
  }

  render(): void {
    const tabs: [Mode, string][] = [
      ["classic", t("Classic")],
      ["vanishing", t("Vanishing")],
      ["ultimate", t("Ultimate")],
      ["duo", t("Two players")],
    ];
    const header = h(
      "header",
      { class: "t24-head", "data-tauri-drag-region": "" },
      h("strong", { "data-tauri-drag-region": "" }, t("Tic-tac-toe")),
      h("nav", { class: "t24-tabs" }, ...tabs.map(([m, text]) => h("button", { class: m === this.mode ? "on" : "", "data-mode": m, onclick: () => this.start(m) }, text))),
      h("button", { class: "t24-icon", title: t("Options"), "aria-label": t("Options"), "aria-expanded": String(this.showOptions), onclick: () => ((this.showOptions = !this.showOptions), this.render()) }, "⚙"),
      h("button", { class: "t24-icon", title: t("Minimize (pauses the game)"), "aria-label": t("Minimize (pauses the game)"), onclick: () => this.minimize() }, "–"),
      h("button", { class: "t24-icon", title: t("Close"), "aria-label": t("Close"), onclick: () => this.hooks.close() }, "×"),
    );
    const body = this.showOptions ? this.optionsView() : this.gameView();
    if (this.paused && !this.showOptions) {
      body.classList.add("paused");
      body.append(this.pauseView());
    }
    this.root.replaceChildren(header, body);
  }

  private pauseView(): HTMLElement {
    const p = this.paused!;
    const name = this.hooks.name;
    const why =
      p.reason === "ring"
        ? t("Paused: {name} is ringing", { name })
        : p.reason === "ask"
          ? t("Paused: {name} is asking you something", { name })
          : p.reason === "celebrate"
            ? t("Paused: a celebration")
            : t("Paused");
    const counting = p.resumeAt > 0;
    return h(
      "div",
      { class: "t24-pause", role: "status" },
      h("div", { class: "t24-pause-why" }, counting ? t("Back to it in") : why),
      h("div", { class: "t24-pause-count" }, counting ? String(Math.max(1, Math.ceil((p.resumeAt - this.now()) / 1000))) : "⏸"),
      !counting && p.reason !== "minimized" ? h("button", { onclick: () => this.keepPlaying() }, t("Keep playing")) : null,
    );
  }

  /** What the line under the score says: whose turn, or how it ended. */
  private status(): string {
    const s = this.state;
    if (s.winner === "draw") return t("A draw");
    if (s.winner) return this.duo ? t("{who} wins!", { who: this.who(s.winner) }) : s.winner === "x" ? t("You win!") : t("{name} wins!", { name: this.hooks.name });
    if (!this.duo && s.turn === "o") return t("{name} is thinking…", { name: this.hooks.name });
    const turn = this.duo ? t("{who}'s turn", { who: this.who(s.turn) }) : t("Your turn");
    if (s.rules === "ultimate" && s.forced !== null) return t("{turn} · play in the {place} board", { turn, place: t(PLACES[s.forced]) });
    if (s.rules === "ultimate") return t("{turn} · play in any open board", { turn });
    return turn;
  }

  /** The rule in one line, under the board. */
  private ruleLine(): string {
    const s = this.state;
    if (s.rules === "vanishing") return t("Three pieces each: placing a fourth takes away your oldest (marked).");
    if (s.rules === "ultimate") return t("Where you play in a small board sends the other player to that board. Win three boards in a row.");
    return t("Three in a row wins.");
  }

  private gameView(): HTMLElement {
    const s = this.state;
    const name = this.hooks.name;
    const score = h(
      "div",
      { class: "ttt-score" },
      h("span", { class: "ttt-side" }, this.markFor("x"), h("span", {}, this.who("x"))),
      h("strong", { class: "ttt-count" }, `${this.you} : ${this.pet}`),
      h("span", { class: "ttt-side" }, h("span", {}, this.who("o")), this.markFor("o")),
    );
    const board = s.rules === "ultimate" ? this.ultimateView() : this.smallView();
    const playing = !s.winner;
    const actions = h(
      "div",
      { class: "t24-actions" },
      h("button", { class: "ttt-undo", disabled: !this.history.length, onclick: () => this.undo() }, t("Undo a move")),
      playing ? h("button", { class: "ttt-resign", disabled: s.moves === 0, onclick: () => this.resign() }, t("Resign")) : null,
      h("span", { class: "grow" }),
      !this.duo ? h("span", { class: "t24-count ttt-level" }, t("{name}'s level: {level}", { name, level: levelName(this.level) })) : null,
      !playing ? h("button", { class: "primary ttt-again", onclick: () => this.newGame() }, t("Play again")) : null,
    );
    return h(
      "div",
      { class: `t24-body ttt-body ttt-${s.rules}` },
      score,
      h("div", { class: `ttt-status${s.winner ? " over" : ""}`, role: "status" }, this.status()),
      board,
      h("p", { class: "t24-fine ttt-rule" }, this.ruleLine()),
      actions,
    );
  }

  /** One cell: empty (a button), or its mark; vanishing marks the piece that goes next. */
  private cell(i: number, owner: Player | null, cls: string, label: string): HTMLElement {
    const s = this.state;
    const mine = !this.duo ? s.turn === "x" : true;
    const can = !s.winner && !this.paused && mine && owner === null && legalMoves(s).includes(i);
    const fading = !s.winner && owner !== null && goesNext(s, owner) === i;
    const won = s.line && s.rules !== "ultimate" && s.line.includes(i);
    const b = h(
      "button",
      {
        class: `${cls}${owner ? ` ${owner}` : ""}${fading ? " fading" : ""}${won ? " won" : ""}${s.last === i ? " last" : ""}${can ? " open" : ""}`,
        "data-cell": String(i),
        "aria-label": label,
        disabled: !can,
        onclick: () => this.tap(i),
      },
      owner ? this.markFor(owner) : null,
      fading ? h("small", { class: "ttt-goes" }, t("goes next move")) : null,
    );
    return b;
  }

  private smallView(): HTMLElement {
    const s = this.state;
    return h(
      "div",
      { class: "ttt-grid" },
      ...s.cells.map((owner, i) => this.cell(i, owner, "ttt-cell", t("{place}: {who}", { place: t(PLACES[i]), who: owner ? this.who(owner) : t("empty") }))),
    );
  }

  private ultimateView(): HTMLElement {
    const s = this.state;
    const boards = s.small.map((result, b) => {
      const active = !s.winner && result === null && (s.forced === null || s.forced === b);
      const cells = Array.from({ length: 9 }, (_, c) => {
        const i = b * 9 + c;
        const owner = s.cells[i];
        return this.cell(i, owner, "ttt-mini", t("{board} board, {place}: {who}", { board: t(PLACES[b]), place: t(PLACES[c]), who: owner ? this.who(owner) : t("empty") }));
      });
      const won = s.line?.includes(b);
      return h(
        "div",
        { class: `ttt-board${active ? " active" : ""}${result ? ` done ${result}` : ""}${won ? " won" : ""}`, "data-board": String(b) },
        ...cells,
        result && result !== "draw" ? h("div", { class: "ttt-board-mark" }, this.markFor(result)) : null,
      );
    });
    return h("div", { class: "ttt-grid ultimate" }, ...boards);
  }

  private optionsView(): HTMLElement {
    const set = (patch: Partial<Options>) => {
      this.options = { ...this.options, ...patch };
      this.saveOptions();
    };
    const radio = <T extends string>(name: string, value: T, current: T, text: string, onpick: (v: T) => void) =>
      h("label", { class: "t24-radio" }, h("input", { type: "radio", name, value, checked: value === current, onchange: () => onpick(value) }), text);
    const levels: [LevelChoice, string][] = [
      ["mood", t("Follows its mood (now: {level})", { level: levelName(this.hooks.moodLevel) })],
      ["easy", levelName("easy")],
      ["normal", levelName("normal")],
      ["strong", levelName("strong")],
    ];
    const games: [Rules, string][] = [
      ["classic", t("Classic")],
      ["vanishing", t("Vanishing")],
      ["ultimate", t("Ultimate")],
    ];
    return h(
      "div",
      { class: "t24-body t24-options" },
      h("h3", {}, t("{name}'s level", { name: this.hooks.name })),
      ...levels.map(([v, text]) => radio("level", v, this.options.level, text, (l) => set({ level: l }))),
      h("p", { class: "t24-fine" }, t("At its best it never loses at classic: the most you can get is a draw.")),
      h("h3", {}, t("Two players play")),
      ...games.map(([v, text]) => radio("duo", v, this.options.duoRules, text, (r) => set({ duoRules: r }))),
      h(
        "label",
        { class: "t24-radio" },
        h("input", { type: "checkbox", name: "sounds", checked: this.options.sounds, onchange: (e: Event) => set({ sounds: (e.target as HTMLInputElement).checked }) }),
        t("A sound when a game ends"),
      ),
      h("div", { class: "t24-actions" }, h("span", { class: "grow" }), h("button", { class: "primary", onclick: () => this.start() }, t("Done: new game"))),
    );
  }
}
