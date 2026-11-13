/**
 * Each window sets its language and region from the settings when it starts and again when
 * they change, so a change in the panel shows everywhere at once.
 */
import type { Backend, Settings, SystemLocale } from "../platform/types";
import { resolveLanguage, setLanguage } from "./index";
import { resolveRegion, setRegion } from "./region";

let system: SystemLocale = { languages: [], country: null };

export function applyLocale(settings: Pick<Settings, "locale">): void {
  setLanguage(resolveLanguage(settings.locale?.language, system.languages));
  setRegion(resolveRegion(settings.locale?.region, system.country));
}

/** Reads the system's language once, applies the settings and follows their changes. */
export async function followLocale(backend: Backend, settings: Pick<Settings, "locale">): Promise<void> {
  system = await backend.systemLocale().catch(() => system);
  applyLocale(settings);
  await backend.on("settings", (s) => applyLocale(s));
}

/** What "Auto" picks on this computer, for the settings page. */
export function systemLocale(): SystemLocale {
  return system;
}
