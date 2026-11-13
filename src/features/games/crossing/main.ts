import { loadBundled, loadUser } from "../../../characters/registry";
import { characterName } from "../../../characters/text";
import { SpriteAtlas } from "../../../engine/sprites";
import { followLocale } from "../../../i18n/apply";
import { playAnswerSound } from "../../../pet/sound";
import { backend } from "../../../platform";
import { watchErrors } from "../../../platform/errors";
import { followTestClock } from "../../../platform/testClock";
import "../../../styles/twenty-four.css";
import "../../../styles/crossing.css";
import { Crossing } from "./game";
import type { Dir } from "./logic";

/** This window, in the app (absent in a plain browser). */
async function appWindow() {
  if (!("__TAURI_INTERNALS__" in window)) return null;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  return getCurrentWindow();
}

/**
 * The Pet Crossing window. The pet in the game is the desktop pet (it's off the desktop
 * while the game is open, as in Safe Landing); when it has to ring or ask something it
 * comes out, and the game waits ("board-pause", as the board games).
 */
async function main() {
  watchErrors(backend, "crossing");
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
  const best = (await backend.topScores("crossing", 1).catch(() => []))[0]?.score ?? 0;
  const win = await appWindow();
  const game = new Crossing(document.getElementById("crossing")!, {
    name: characterName(def),
    atlas,
    animations: def.animations,
    best,
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
    finished: (score, _level, cleared) => {
      if (score > 0) void backend.recordScore("crossing", def.id, score);
      // All 20 levels: the pet is proud of you.
      void backend.emit("pet-event", { type: "game", won: cleared });
    },
    cleared: () => void backend.unlockAchievement("crossing_win"),
    close: () => void backend.closeGame(),
    minimize: () => void win?.minimize(),
    onTop: (on) => void win?.setAlwaysOnTop(on),
    sound: (kind) => {
      if (settings.sound) playAnswerSound(kind, 0.6);
    },
  });
  await backend.on("board-pause", (p) => game.busy(p.reason));
  await backend.on("settings", (s) => {
    settings.sound = s.sound;
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
  // End-to-end tests (e2e/, debug builds only): what the game shows, and the lanes as a test needs them.
  if (await backend.e2eEnabled()) {
    Object.assign(window, {
      __epetSounds: [],
      __epetCrossing: {
        get state() {
          return game.snapshot();
        },
        go: (dir: Dir) => game.go(dir),
        rig: (r: Parameters<Crossing["rig"]>[0]) => game.rig(r),
        start: () => game.start(),
        pause: () => game.togglePause(),
        busy: (reason: string | null) => game.busy(reason),
        pauseOnBlur: (on: boolean) => (game.pauseOnBlur = on),
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
