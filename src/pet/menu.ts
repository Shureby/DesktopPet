import type { CharacterRegistry } from "../characters/registry";
import type { CareAction, CharacterDef } from "../characters/schema";
import { pick, type Rng } from "../engine/random";
import { formatDuration, PRESET_MINUTES } from "../features/alarm/timers";
import { formatRemaining } from "../features/pomodoro/logic";
import type { Alarm, Backend, PomodoroStatus, Settings } from "../platform";

/** What both menus (the pet's right-click menu and the tray menu) need. */
export interface MenuContext {
  backend: Backend;
  registry: CharacterRegistry;
  settings: Settings;
  pomodoro: PomodoroStatus;
  /** Running timers, soonest first. */
  timers: (Alarm & { nextFire: number })[];
  /** Alarms waiting to ring again after a snooze. */
  snoozed?: (Alarm & { nextFire: number })[];
  setTimer: (minutes: number) => void;
  /** Asks for a custom length (in the pet's speech bubble). */
  customTimer: () => void;
  /** Formats time left; the tray uses whole minutes since it isn't redrawn every second. */
  remaining?: (ms: number) => string;
}

/** The pet's own menu adds a care action and "Hide pet". */
export interface PetMenuContext extends MenuContext {
  character: CharacterDef;
  hungry: boolean;
  rng: Rng;
  care: (action: CareAction) => void;
  hide: () => void;
}

/** The tray menu adds show/hide (the way back to a hidden pet) and Quit. */
export interface TrayMenuContext extends MenuContext {
  petVisible: boolean;
}

export interface Item {
  /** Fixed id for items the app handles natively (the tray's show/hide, panel, quit). */
  id?: string;
  text: string;
  action?: () => void;
  checked?: boolean;
  items?: (Item | "sep")[];
}


export function careLabel(action: CareAction, character: CharacterDef): string {
  return action.label.replace(/\{name\}/g, character.displayName);
}

/** One care action at random; feeding comes first when the pet is hungry. */
export function pickCare(character: CharacterDef, hungry: boolean, rng: Rng): CareAction {
  const care = character.personality.care;
  const feed = care.filter((a) => a.kind === "feed");
  return (hungry && pick(rng, feed)) || pick(rng, care) || care[0];
}

/** "12 min left" rounded up, for menus that can't count down live. */
export function minutesLeft(ms: number): string {
  const m = Math.max(1, Math.ceil(ms / 60_000));
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`;
}

/**
 * The part both menus share, identical in wording and order: to-dos, alarms, timers and
 * focus sessions. Every item starts with a verb.
 */
export function taskItems(c: MenuContext): (Item | "sep")[] {
  const now = Date.now();
  const fmt = c.remaining ?? formatRemaining;
  const left = (at: number | null) => (at ? ` (${fmt(at - now)} left)` : "");

  // Presets keep fixed positions (muscle memory); the user's own lengths sit below a separator.
  const recent = c.settings.recentTimers.filter((m) => !PRESET_MINUTES.includes(m));
  const items: (Item | "sep")[] = [
    { text: "Add to-do…", action: () => void c.backend.openPanel("todos") },
    { text: "Set alarm…", action: () => void c.backend.openPanel("alarms") },
    {
      text: "Set timer",
      items: [
        ...PRESET_MINUTES.map((m) => ({ text: formatDuration(m), action: () => c.setTimer(m) })),
        "sep" as const,
        ...recent.map((m) => ({ text: `${formatDuration(m)} (custom)`, action: () => c.setTimer(m) })),
        { text: "Custom / Edit…", action: c.customTimer },
      ],
    },
  ];
  if (c.timers.length === 1) {
    const t = c.timers[0];
    items.push({ text: `Cancel timer${left(t.nextFire)}`, action: () => void c.backend.deleteAlarm(t.id) });
  } else if (c.timers.length > 1) {
    items.push({
      text: "Cancel timer",
      items: c.timers.map((t) => ({
        text: `${t.label.replace(/^Timer: /, "")}${left(t.nextFire)}`,
        action: () => void c.backend.deleteAlarm(t.id),
      })),
    });
  }
  for (const a of c.snoozed ?? []) {
    const at = new Date(a.nextFire).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    items.push({ text: `Cancel snooze: ${a.label} (${at})`, action: () => void c.backend.dismissAlarm(a.id) });
  }
  items.push(
    c.pomodoro.phase !== "idle"
      ? { text: `Stop focus session${left(c.pomodoro.endsAt)}`, action: () => void c.backend.pomodoroStop() }
      : { text: "Start focus session 🍅", action: () => void c.backend.pomodoroStart() },
  );
  return items;
}

/** Shared too: the mini-game and switching characters. */
export function playItems(c: MenuContext): (Item | "sep")[] {
  return [
    { text: "Play Safe Landing", action: () => void c.backend.openGame("safe-landing") },
    {
      text: "Switch character",
      items: c.registry.list().map((ch) => ({
        text: ch.def.displayName,
        checked: ch.def.id === c.settings.character,
        action: () => void c.backend.setSettings({ character: ch.def.id }),
      })),
    },
  ];
}

/** The pet's right-click menu: a care action on top, then the shared sections. */
export function buildItems(c: PetMenuContext): (Item | "sep")[] {
  const care = pickCare(c.character, c.hungry, c.rng);
  return [
    { text: `${careLabel(care, c.character)}${care.kind === "pet" ? " ♥" : ""}`, action: () => c.care(care) },
    "sep",
    ...taskItems(c),
    "sep",
    ...playItems(c),
    "sep",
    { text: "Open panel…", action: () => void c.backend.openPanel() },
    { text: "Hide pet", action: c.hide },
  ];
}

/**
 * The tray menu: show/hide on top (it is the way back to a hidden pet), Quit at the bottom.
 * Those two and "Open panel…" carry ids the app handles itself (src-tauri/src/tray.rs), so
 * they work even if the hidden pet window's script is throttled.
 */
export function buildTrayItems(c: TrayMenuContext): (Item | "sep")[] {
  return [
    c.petVisible ? { id: "hide", text: "Hide pet" } : { id: "show", text: "Show pet" },
    "sep",
    ...taskItems(c),
    "sep",
    ...playItems(c),
    "sep",
    { id: "panel", text: "Open panel…" },
    "sep",
    { id: "quit", text: "Quit" },
  ];
}

/** Builds a native menu (Tauri) from items. The caller owns it and closes it when replaced. */
export async function nativeMenu(items: (Item | "sep")[]) {
  const { Menu, Submenu, MenuItem, CheckMenuItem, PredefinedMenuItem } = await import("@tauri-apps/api/menu");
  const toNative = async (i: Item | "sep"): Promise<unknown> => {
    if (i === "sep") return PredefinedMenuItem.new({ item: "Separator" });
    if (i.items) return Submenu.new({ text: i.text, items: (await Promise.all(i.items.map(toNative))) as never });
    if (i.checked !== undefined) return CheckMenuItem.new({ text: i.text, checked: i.checked, action: i.action });
    return MenuItem.new({ id: i.id, text: i.text, action: i.action });
  };
  return Menu.new({ items: (await Promise.all(items.map(toNative))) as never });
}

/** Right-click menu: native in the app, a small HTML menu in the browser mock. */
export async function showPetMenu(e: MouseEvent, c: PetMenuContext): Promise<void> {
  const items = buildItems(c);
  if (c.backend.kind === "tauri") {
    const menu = await nativeMenu(items);
    await menu.popup();
    return;
  }
  htmlMenu(e.clientX, e.clientY, items);
}

function htmlMenu(x: number, y: number, items: (Item | "sep")[]): void {
  document.querySelector(".pet-menu")?.remove();
  const render = (list: (Item | "sep")[]) => {
    const ul = document.createElement("ul");
    ul.className = "pet-menu";
    for (const i of list) {
      const li = document.createElement("li");
      if (i === "sep") {
        li.className = "sep";
      } else {
        li.textContent = (i.checked ? "✓ " : "") + i.text + (i.items ? " ▸" : "");
        if (i.items) li.append(render(i.items));
        else
          li.addEventListener("click", () => {
            i.action?.();
            document.querySelector(".pet-menu")?.remove();
          });
      }
      ul.append(li);
    }
    return ul;
  };
  const menu = render(items);
  menu.style.left = `${Math.min(x, window.innerWidth - 200)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - 320)}px`;
  document.body.append(menu);
  setTimeout(() => document.addEventListener("click", () => menu.remove(), { once: true }));
}
