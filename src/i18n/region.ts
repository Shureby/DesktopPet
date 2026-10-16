import { msg } from "./index";

/**
 * The region (docs/INTERACTIONS.md, "Language and region"): which holidays the Holiday
 * template offers. It's apart from the language: an English interface in Singapore has
 * Singapore's holidays.
 */
export type Region = "CN" | "TW" | "HK" | "SG" | "MY" | "other";
export type RegionSetting = "auto" | Region;

export const REGIONS: Region[] = ["CN", "TW", "HK", "SG", "MY", "other"];

/** The English names (the menu shows them through t()). */
export const REGION_NAMES: Record<Region, string> = {
  CN: msg("Mainland China"),
  TW: msg("Taiwan"),
  HK: msg("Hong Kong"),
  SG: msg("Singapore"),
  MY: msg("Malaysia"),
  other: msg("Other"),
};

/** The region for a country code (ISO 3166, as the system gives it); Macau goes with Hong Kong. */
export function regionOf(country: string | null | undefined): Region {
  const c = (country ?? "").toUpperCase();
  if (c === "MO") return "HK";
  return (REGIONS as string[]).includes(c) ? (c as Region) : "other";
}

/** The region to use: the one chosen, or the system's. */
export function resolveRegion(setting: RegionSetting | undefined, systemCountry: string | null): Region {
  if (setting && setting !== "auto" && REGIONS.includes(setting)) return setting;
  return regionOf(systemCountry);
}

let current: Region = "other";

export function region(): Region {
  return current;
}

export function setRegion(r: Region): void {
  current = r;
}
