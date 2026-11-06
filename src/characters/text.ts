/**
 * A character's words in the interface's language: its own translation where it has one
 * (character.json "translations"), the English otherwise.
 */
import { language } from "../i18n";
import type { CareAction, CharacterDef, Translation } from "./schema";

function translation(def: CharacterDef): Translation | undefined {
  const l = language();
  return l === "en" ? undefined : def.translations?.[l];
}

export function characterName(def: CharacterDef): string {
  return translation(def)?.displayName ?? def.displayName;
}

export function characterDescription(def: CharacterDef): string {
  return translation(def)?.description ?? def.description;
}

/** Its fighting style (the Characters page). */
export function characterStyle(def: CharacterDef): string {
  return translation(def)?.style ?? def.moveset.style;
}

/** A care action's label ("Pet the {name}"), `{name}` filled in. */
export function careText(def: CharacterDef, action: CareAction): string {
  const i = def.personality.care.indexOf(action);
  const label = (i >= 0 ? translation(def)?.care?.[i] : undefined) ?? action.label;
  return label.replace(/\{name\}/g, characterName(def));
}

/** The lines for a situation ("greet", "alarm"…). */
export function characterLines(def: CharacterDef, key: string): string[] {
  return translation(def)?.lines?.[key] ?? def.personality.lines[key] ?? [];
}
