import { isTauri } from "@tauri-apps/api/core";
import { mockBackend } from "./mock";
import { tauriBackend } from "./tauri";
import type { Backend } from "./types";

export * from "./types";

/** The Tauri backend inside the app, the localStorage mock in a plain browser. */
export const backend: Backend = isTauri() ? tauriBackend : mockBackend;
