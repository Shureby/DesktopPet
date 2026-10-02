import { celebrationEffect } from "../features/anniversary/templates";
import type { Celebration } from "../platform/types";
import { playEffect } from "./effects";

/**
 * The "celebrate" window (src-tauri/src/app_windows.rs, open_celebration): transparent and
 * click-through over the pet's monitor. What to play comes in the URL hash as hex-encoded
 * JSON; the app closes the window when it's over.
 */
const hex = location.hash.slice(1);
const bytes = new Uint8Array((hex.match(/../g) ?? []).map((b) => parseInt(b, 16)));
const { celebration, petX, petY } = JSON.parse(new TextDecoder().decode(bytes)) as {
  celebration: Celebration;
  petX: number;
  petY: number;
};
const canvas = document.getElementById("fx") as HTMLCanvasElement;
const { mode, icons } = celebrationEffect(celebration.anniversary);
void playEffect(canvas, { mode, icons, ms: celebration.seconds * 1000, petX, petY });
