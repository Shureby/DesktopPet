import { loadBundled, loadUser } from "../../../characters/registry";
import { characterName } from "../../../characters/text";
import { SpriteAtlas } from "../../../engine/sprites";
import { followLocale } from "../../../i18n/apply";
import { pieceById } from "../../../celebrate/music";
import { playCrossingSound, playMusic } from "../../../pet/sound";
import { backend } from "../../../platform";
import { watchErrors } from "../../../platform/errors";
import { followTestClock } from "../../../platform/testClock";
import "../../../styles/twenty-four.css";
import "../../../styles/crossing.css";
import { Crossing } from "./game";
import type { Dir, ThemeId } from "./logic";

/** Each theme's music: pieces the anniversaries have (src/celebrate/music.ts), the merry ones. */
const MUSIC: Record<ThemeId, string> = { cute: "waltz", traffic: "ode", office: "canon" };
const MUSIC_VOLUME = 0.3;
/** A piece is scheduled this long at a time, and again from its start when that's over (pieces divide 60 s). */
const MUSIC_ROUND = 60;

/** Plays a theme's piece round and round until told otherwise. */
function musicBox(allowed: () => boolean) {
  let stop: (() => void) | null = null;
  let again = 0;
  const halt = () => {
    clearTimeout(again);
    stop?.();
    stop = null;
  };
  const round = (id: string) => {
    const piece = pieceById(id);
    if (!piece) return;
    // (Two seconds over: the fade at its end is under the next round's start.)
    stop = playMusic(piece, MUSIC_ROUND + 2, MUSIC_VOLUME);
    again = window.setTimeout(() => round(id), MUSIC_ROUND * 1000);
  };
  return (theme: ThemeId | null) => {
    halt();
    if (theme && allowed()) round(MUSIC[theme]);
  };
}

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
      if (settings.sound) playCrossingSound(kind, 0.6);
    },
    music: musicBox(() => settings.sound),
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
