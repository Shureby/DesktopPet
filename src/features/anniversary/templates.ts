import type { Anniversary, AnniversaryPrep } from "../../platform/types";
import { PIECES, pieceById, type Piece } from "../../celebrate/music";

/**
 * Anniversary templates (docs/INTERACTIONS.md, "Anniversaries"): picking one fills in the
 * icon, the reminders before the day and whether it plays an effect; the pet's words on the
 * day come from it too. Everything stays editable.
 */
export type AnniversaryKind = "birthday" | "wedding" | "dating" | "pet" | "work" | "home" | "remembrance" | "custom";

export interface AnniversaryTemplate {
  label: string;
  icon: string;
  preps: AnniversaryPrep[];
  /** Fireworks for a happy day; a remembrance's candle and flowers are off by default. */
  effect: boolean;
  /** What falls with the fireworks, after the anniversary's own icon. */
  falling: string[];
  /** Some fireworks burst as a pair of hearts side by side (red with pink or gold). */
  hearts?: boolean;
  /** Balloons rise from the bottom; this share of them are shaped like pets' heads. */
  balloons?: number;
  placeholder: string;
  /** The music on the day (src/celebrate/music.ts): the default, or the only one when `musicFixed`. */
  music: string;
  musicFixed?: boolean;
  /** The only pieces it can choose from (otherwise any of its mood). */
  musicOptions?: string[];
}

export const TEMPLATES: Record<AnniversaryKind, AnniversaryTemplate> = {
  birthday: {
    label: "Birthday",
    icon: "🎂",
    preps: [
      { lead: "1w", label: "Buy a gift" },
      { lead: "1d", label: "Order a cake" },
    ],
    effect: true,
    falling: ["🎁"],
    balloons: 0.3,
    placeholder: "Whose birthday? e.g. Mum",
    music: "birthday",
    musicFixed: true,
  },
  wedding: {
    label: "Wedding anniversary",
    icon: "💍",
    preps: [
      { lead: "1w", label: "Book a restaurant" },
      { lead: "1d", label: "Buy flowers" },
    ],
    effect: true,
    falling: ["❤️", "🥂"],
    hearts: true,
    placeholder: "e.g. Our wedding",
    music: "canon",
    musicOptions: ["canon", "mendelssohn", "wagner"],
  },
  dating: {
    label: "Dating anniversary",
    icon: "💝",
    preps: [{ lead: "1d", label: "Plan a surprise" }],
    effect: true,
    falling: ["🌹", "❤️"],
    hearts: true,
    placeholder: "e.g. Us",
    music: "waltz",
  },
  pet: {
    label: "Pet's birthday",
    icon: "🐾",
    preps: [{ lead: "1d", label: "Buy treats" }],
    effect: true,
    falling: ["🦴"],
    balloons: 0.6,
    placeholder: "Your pet's name",
    music: "birthday",
    musicFixed: true,
  },
  work: { label: "Work anniversary", icon: "🏆", preps: [], effect: true, falling: ["🎉", "⭐"], placeholder: "e.g. Joined EzyAppCo", music: "waltz" },
  home: { label: "Home anniversary", icon: "🏠", preps: [], effect: true, falling: ["🎉", "🎈"], placeholder: "e.g. Moved in", music: "waltz" },
  remembrance: {
    label: "Remembrance",
    icon: "🕯️",
    preps: [{ lead: "1d", label: "Buy flowers" }],
    effect: false,
    falling: [],
    placeholder: "Who you remember",
    music: "aisi",
  },
  custom: { label: "Custom", icon: "🌟", preps: [], effect: true, falling: ["🎉", "🎊"], placeholder: "Name", music: "waltz" },
};

export const KINDS = Object.keys(TEMPLATES) as AnniversaryKind[];

export function templateOf(kind: string): AnniversaryTemplate {
  return TEMPLATES[(kind in TEMPLATES ? kind : "custom") as AnniversaryKind];
}

export const ICONS = ["🎂", "🎁", "💍", "💐", "🌹", "💝", "❤️", "🥂", "🍾", "🎉", "🎊", "🎈", "🏠", "🎓", "👶", "🐾", "🏆", "✈️", "🌟", "🕯️"];

/** How long before the day a reminder comes (the store knows the same codes). */
export const LEADS: [string, string][] = [
  ["1d", "1 day"],
  ["2d", "2 days"],
  ["3d", "3 days"],
  ["1w", "1 week"],
  ["2w", "2 weeks"],
  ["1m", "1 month"],
];

export function leadLabel(lead: string): string {
  return LEADS.find(([k]) => k === lead)?.[1] ?? lead;
}

/** 1st, 2nd, 3rd, 4th … 11th, 12th, 13th … 21st. */
export function ordinal(n: number): string {
  const v = n % 100;
  if (v >= 11 && v <= 13) return `${n}th`;
  return `${n}${({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th"}`;
}

/** "36th" for birthdays and the like, "7 years" where a count reads better. */
export function yearsText(kind: string, years: number): string {
  if (kind === "dating" || kind === "remembrance" || kind === "work" || kind === "home") return `${years} year${years === 1 ? "" : "s"}`;
  return ordinal(years);
}

/** The pet's words on the day: a line, and a smaller one under it (or ""). */
export function celebrationLines(a: Pick<Anniversary, "kind" | "name" | "icon">, years: number | null): [string, string] {
  const y = years ?? 0;
  switch (a.kind) {
    case "birthday":
      return [y ? `🎉 Happy ${ordinal(y)} birthday, ${a.name}!` : `🎉 Happy birthday, ${a.name}!`, ""];
    case "wedding":
      return [y ? `🥂 Happy ${ordinal(y)} wedding anniversary!` : "🥂 Happy wedding anniversary!", a.name];
    case "dating":
      return [y ? `💝 ${yearsText("dating", y)} together today!` : "💝 Happy anniversary!", a.name];
    case "pet":
      return [`🐾 Happy birthday, ${a.name}!`, y ? `${ordinal(y)} birthday` : ""];
    case "work":
      return [y ? `🏆 ${yearsText("work", y)} at work today!` : "🏆 Happy work anniversary!", a.name];
    case "home":
      return [y ? `🏠 ${yearsText("home", y)} in your home!` : "🏠 Happy home anniversary!", a.name];
    case "remembrance":
      return [`🕯️ Remembering ${a.name} today.`, y ? yearsText("remembrance", y) : ""];
    default:
      return [`${a.icon} Today is ${a.name}!`, y ? yearsText("custom", y) : ""];
  }
}

/** What the day plays: fireworks (with these icons falling) or a candle and flowers. */
export function celebrationEffect(a: Pick<Anniversary, "kind" | "icon">): {
  mode: "fireworks" | "candle";
  icons: string[];
  hearts?: boolean;
  balloons?: number;
} {
  if (a.kind === "remembrance") return { mode: "candle", icons: [] };
  const t = templateOf(a.kind);
  // With drawn balloons rising, a 🎈 icon doesn't fall as well.
  const icons = [a.icon, ...t.falling.filter((i) => i !== a.icon)].filter((i) => !(t.balloons !== undefined && i === "🎈"));
  return { mode: "fireworks", icons, hearts: t.hearts, balloons: t.balloons };
}

/** The pieces it can choose from: its template's list (a wedding), else happy ones, or for a remembrance the mourning ones. */
export function musicChoices(kind: string): Piece[] {
  const options = templateOf(kind).musicOptions;
  if (options) return PIECES.filter((p) => options.includes(p.id));
  const mood = kind === "remembrance" ? "mourning" : "happy";
  return PIECES.filter((p) => p.mood === mood);
}

/** The piece it plays: the template's own when fixed, else its choice (if it suits), else the default. */
export function musicFor(a: Pick<Anniversary, "kind" | "music">): Piece {
  const t = templateOf(a.kind);
  const chosen = t.musicFixed ? undefined : musicChoices(a.kind).find((p) => p.id === a.music);
  return chosen ?? pieceById(t.music) ?? PIECES[0];
}

/** The next time it comes round, on or after `now`'s day (Feb 29 is Feb 28 in other years). */
export function nextAnniversary(month: number, day: number, now = Date.now()): Date {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  for (const y of [today.getFullYear(), today.getFullYear() + 1]) {
    const last = new Date(y, month, 0).getDate();
    const d = new Date(y, month - 1, Math.min(day, last));
    if (d >= today) return d;
  }
  return today;
}

/** Whole days from today to `date`. */
export function daysUntil(date: Date, now = Date.now()): number {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  return Math.round((date.getTime() - today.getTime()) / 86_400_000);
}

/** "Today", "Tomorrow", "in 3 days", "in 5 months". */
export function untilText(days: number): string {
  if (days === 0) return "Today 🎉";
  if (days === 1) return "Tomorrow";
  if (days <= 60) return `in ${days} days`;
  const months = Math.round(days / 30.4);
  return `in ${months} month${months === 1 ? "" : "s"}`;
}

/** The day of a reminder `lead` before `on` (mirrors prep_day in schedule.rs). */
export function prepDay(on: Date, lead: string): Date | null {
  const days = ({ "1d": 1, "2d": 2, "3d": 3, "1w": 7, "2w": 14 } as Record<string, number>)[lead];
  if (days !== undefined) return new Date(on.getFullYear(), on.getMonth(), on.getDate() - days);
  if (lead !== "1m") return null;
  const last = new Date(on.getFullYear(), on.getMonth(), 0).getDate();
  return new Date(on.getFullYear(), on.getMonth() - 1, Math.min(on.getDate(), last));
}
