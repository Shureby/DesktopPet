import { parseMood } from "../../../brain/mood";
import type { CharacterDef } from "../../../characters/schema";
import { loadBundled, loadUser } from "../../../characters/registry";
import { characterName } from "../../../characters/text";
import { followLocale } from "../../../i18n/apply";
import { playAnswerSound } from "../../../pet/sound";
import { backend } from "../../../platform";
import { followTestClock } from "../../../platform/testClock";
import "../../../styles/twenty-four.css";
import "../../../styles/tic-tac-toe.css";
import { PetStage } from "../twenty-four/stage";
import { TicTacToe, type Mark, type Mode } from "./game";
import { levelFromMood } from "./logic";

/** This window, in the app (absent in a plain browser). */
async function appWindow() {
  if (!("__TAURI_INTERNALS__" in window)) return null;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  return getCurrentWindow();
}

/** The pet's own mark: the cat's paw print, the rooster's footprint, else a dot. */
function markOf(def: CharacterDef): Mark {
  return def.id === "cat" ? "paw" : def.id === "rooster" ? "foot" : "dot";
}

/**
 * The tic-tac-toe window: the board. The pet on it is the desktop pet (characters/board.ts):
 * the game tells it what to do ("board-pet"), and it tells the game when something needs
 * you ("board-pause"), as in 24 Points.
 */
async function main() {
  await followTestClock(backend);
  const registry = loadBundled();
  try {
    loadUser(await backend.listUserCharacters(), backend.assetUrl, registry);
  } catch {
    // No user characters.
  }
  const settings = await backend.getSettings();
  await followLocale(backend, settings);
  const def = registry.pick(settings.character, "cat").def;
  const mood = parseMood(await backend.loadMood(def.id).catch(() => null));
  const win = await appWindow();
  const stage = new PetStage((b) => void backend.emit("board-pet", b));
  const game = new TicTacToe(document.getElementById("ttt")!, {
    name: characterName(def),
    mark: markOf(def),
    moodLevel: levelFromMood(mood),
    stage,
    load: (k) => {
      try {
        return localStorage.getItem(k);
      } catch {
        return null;
      }
    },
    store: (k, v) => {
      try {
        localStorage.setItem(k, v);
      } catch {
        // Not kept.
      }
    },
    finished: (won, wins) => {
      if (won) void backend.recordScore("tic-tac-toe", def.id, wins);
      if (won) void backend.unlockAchievement("tic_tac_toe_win");
      // Playing together makes the pet happier.
      void backend.emit("pet-event", { type: "game", won });
    },
    close: () => void backend.closeGame(),
    minimize: () => void win?.minimize(),
    onTop: (on) => void win?.setAlwaysOnTop(on),
    sound: (kind) => {
      if (settings.sound) playAnswerSound(kind, 0.6);
    },
  });
  await backend.on("board-pause", (p) => game.busy(p.reason));
  let character = def.id;
  await backend.on("settings", async (s) => {
    settings.sound = s.sound;
    if (s.character === character) return;
    character = s.character;
    const next = registry.pick(s.character, "cat").def;
    const m = parseMood(await backend.loadMood(next.id).catch(() => null));
    game.characterChanged(characterName(next), markOf(next), levelFromMood(m));
  });
  // Back from the taskbar: on again after "3, 2, 1".
  if (win) {
    let minimized = false;
    setInterval(async () => {
      const now = await win.isMinimized().catch(() => false);
      if (minimized && !now) game.restored();
      minimized = now;
    }, 400);
  }
  const first = location.hash.slice(1) as Mode;
  game.start(["classic", "vanishing", "ultimate", "duo"].includes(first) ? first : "classic");
  // End-to-end tests (e2e/, debug builds only): what the board shows, the pet playing now.
  if (await backend.e2eEnabled()) {
    Object.assign(window, {
      __epetSounds: [],
      __epetTtt: {
        get state() {
          return game.snapshot();
        },
        tap: (i: number) => game.tap(i),
        petNow: () => game.petNow(),
        think: (ms: number | null) => (game.thinkFor = ms),
        start: (mode: Mode) => game.start(mode),
        level: (level: "easy" | "normal" | "strong" | "mood") => ((game.options = { ...game.options, level }), game.render()),
        minimize: () => game.minimize(),
        restore: async () => {
          await win?.unminimize();
          await win?.setFocus();
        },
      },
    });
  }
  window.focus();
}

main().catch((e) => console.error(e));
