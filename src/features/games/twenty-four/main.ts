import { loadBundled, loadUser } from "../../../characters/registry";
import { characterName } from "../../../characters/text";
import { followLocale } from "../../../i18n/apply";
import { playAnswerSound } from "../../../pet/sound";
import { backend } from "../../../platform";
import { followTestClock } from "../../../platform/testClock";
import "../../../styles/twenty-four.css";
import { TwentyFour, type Mode } from "./game";
import { PetStage } from "./stage";
import { watchErrors } from "../../../platform/errors";

/** This window, in the app (absent in a plain browser). */
async function appWindow() {
  if (!("__TAURI_INTERNALS__" in window)) return null;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  return getCurrentWindow();
}

/**
 * The 24 Points window: the board. The pet on it is the desktop pet (characters/board.ts):
 * the game tells it what to do ("board-pet"), and it tells the game when something needs
 * you ("board-pause").
 */
async function main() {
  watchErrors(backend, "twenty-four");
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
  const win = await appWindow();
  const stage = new PetStage((b) => void backend.emit("board-pet", b));
  const game = new TwentyFour(document.getElementById("t24")!, {
    name: characterName(def),
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
        // Not kept: the next round may repeat a hand.
      }
    },
    finished: (won, score, raceWon) => {
      if (score > 0) void backend.recordScore("twenty-four", def.id, score);
      if (raceWon) void backend.unlockAchievement("twenty_four_win");
      // Won: the pet is proud of you.
      void backend.emit("pet-event", { type: "game", won });
    },
    close: () => void backend.closeGame(),
    minimize: () => void win?.minimize(),
    onTop: (on) => void win?.setAlwaysOnTop(on),
    // The game's own switch (⚙) decides, not Settings → "Other sounds (petting)".
    sound: (kind) => playAnswerSound(kind, 0.6),
  });
  await backend.on("board-pause", (p) => game.busy(p.reason));
  // Another character picked meanwhile: its name from now on.
  let character = def.id;
  await backend.on("settings", async (s) => {
    if (s.character === character) return;
    character = s.character;
    const next = registry.pick(s.character, "cat").def;
    game.characterChanged(characterName(next));
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
  game.start(["race", "practice", "timed", "daily"].includes(first) ? first : "race");
  // End-to-end tests (e2e/, debug builds only): what the board shows, a given hand, the pet answering now.
  if (await backend.e2eEnabled()) {
    Object.assign(window, {
      __epetSounds: [],
      __epet24: {
        get state() {
          return game.snapshot();
        },
        deal: (ranks: number[]) => game.dealHand(ranks),
        petNow: () => game.petNow(),
        petReady: () => game.petReady(),
        timeUp: () => game.runOut(),
        start: (mode: Mode) => game.start(mode),
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
