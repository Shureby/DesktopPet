import { parseMood } from "../../../brain/mood";
import { loadBundled, loadUser } from "../../../characters/registry";
import { characterName } from "../../../characters/text";
import { SpriteAtlas } from "../../../engine/sprites";
import { followLocale } from "../../../i18n/apply";
import { backend } from "../../../platform";
import { followTestClock } from "../../../platform/testClock";
import "../../../styles/twenty-four.css";
import { TwentyFour, type Mode } from "./game";
import { levelFromMood } from "./logic";
import { PetStage } from "./stage";

/** The 24 Points window: the board, with the current character standing on top of it. */
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
  const character = registry.pick(settings.character, "cat");
  const def = character.def;
  const atlas = await SpriteAtlas.load(def.sprite, character.asset);
  const mood = parseMood(await backend.loadMood(def.id).catch(() => null));
  const stage = new PetStage(document.getElementById("t24-pet") as HTMLCanvasElement, document.getElementById("t24-bubble")!, def, atlas);
  const game = new TwentyFour(document.getElementById("t24")!, {
    name: characterName(def),
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
        // Not kept: the next round may repeat a hand.
      }
    },
    finished: (won, score, raceWon) => {
      if (score > 0) void backend.recordScore("twenty-four", def.id, score);
      if (raceWon) void backend.unlockAchievement("twenty_four_win");
      // Playing together makes the pet happier.
      void backend.emit("pet-event", { type: "game", won });
    },
    close: () => void backend.closeGame(),
  });
  const first = location.hash.slice(1) as Mode;
  game.start(["race", "practice", "timed", "daily"].includes(first) ? first : "race");
  // End-to-end tests (e2e/, debug builds only): what the board shows, a given hand, the pet answering now.
  if (await backend.e2eEnabled()) {
    Object.assign(window, {
      __epet24: {
        get state() {
          return game.snapshot();
        },
        deal: (ranks: number[]) => game.dealHand(ranks),
        petNow: () => game.petNow(),
        petReady: () => game.petReady(),
        timeUp: () => game.timeUp(),
        start: (mode: Mode) => game.start(mode),
      },
    });
  }
  window.focus();
}

main().catch((e) => console.error(e));
