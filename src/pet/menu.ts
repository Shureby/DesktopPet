import type { CharacterRegistry } from "../characters/registry";
import type { CareAction, CharacterDef } from "../characters/schema";
import { pick, type Rng } from "../engine/random";
import { formatDuration, PRESET_MINUTES, timerName } from "../features/alarm/timers";
import { alarmName, clock } from "../features/alarm/ringing";
import { gameHeld } from "../features/pomodoro/logic";
import {
  dayKey,
  MODE_ICONS,
  MODE_IDS,
  MODE_NAMES,
  modeNow,
  overrideUntil,
  tomorrowMorning,
  type ModeId,
  type ModeSettings,
} from "../features/modes/modes";
import type { Alarm, Backend, PanelTab, PomodoroStatus, Settings } from "../platform";

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
  /** Alarms nobody answered (their badge stays until clicked). */
  missed?: Alarm[];
  setTimer: (minutes: number) => void;
  /** Asks for a custom length (in the pet's speech bubble). */
  customTimer: () => void;
  /** Opens a game, asking first during a focus session (see `gameHeld`). */
  playGame: (game: string) => void;
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

/**
 * The part both menus share, identical in wording and order: to-dos, alarms, timers and
 * focus sessions. Every item starts with a verb.
 *
 * Times are shown as clock times ("rings 3:52 PM"), never as time left: a native menu
 * can't count down while it is open, and the tray menu is built ahead of time, so a
 * countdown would always be stale there. The live countdown is on the badges by the pet.
 */
export function taskItems(c: MenuContext): (Item | "sep")[] {

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
    items.push({
      text: `Cancel timer: ${timerName(t)} (rings ${clock(t.nextFire)})`,
      action: () => void c.backend.deleteAlarm(t.id),
    });
  } else if (c.timers.length > 1) {
    items.push({
      text: "Cancel timer",
      items: c.timers.map((t) => ({
        text: `${timerName(t)} (rings ${clock(t.nextFire)})`,
        action: () => void c.backend.deleteAlarm(t.id),
      })),
    });
  }
  for (const a of c.snoozed ?? []) {
    items.push({
      text: `Cancel snooze: ${alarmName(a)} (next ring ${clock(a.nextFire)})`,
      action: () => void c.backend.dismissAlarm(a.id),
    });
  }
  items.push(
    c.pomodoro.phase !== "idle"
      ? {
          text: `Stop focus session${c.pomodoro.endsAt ? ` (ends ${clock(c.pomodoro.endsAt)})` : ""}`,
          action: () => void c.backend.pomodoroStop(),
        }
      : { text: "Start focus session 🍅", action: () => void c.backend.pomodoroStart() },
  );
  return items;
}

/**
 * The tab "Open panel…" opens: whatever runs out first, a focus session (Focus) or a timer
 * or snoozed alarm (Alarms); Alarms if one was missed; otherwise the panel's default.
 */
export function panelTabFor(c: MenuContext): PanelTab | undefined {
  const alarmsAt = Math.min(...[...c.timers, ...(c.snoozed ?? [])].map((t) => t.nextFire));
  const focusAt = c.pomodoro.phase !== "idle" && c.pomodoro.endsAt ? c.pomodoro.endsAt : Infinity;
  if (alarmsAt !== Infinity || focusAt !== Infinity) return focusAt < alarmsAt ? "focus" : "alarms";
  return c.missed?.length ? "alarms" : undefined;
}

/** Shared too: the mini-game and switching characters. */
export function playItems(c: MenuContext): (Item | "sep")[] {
  return [
    {
      // Says so during a focus session: it will ask first.
      text: `Play Safe Landing${gameHeld(c.settings.pomodoro, c.pomodoro) ? " (focusing)" : ""}`,
      action: () => c.playGame("safe-landing"),
    },
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

/**
 * "Switch mode (now: 👔 Work until 5:30 PM)" (docs/INTERACTIONS.md, "Modes"). A mode picked
 * here is for a while: until the schedule (or the mode picked in the Modes tab) next changes,
 * then back to that. Also Quiet for 30 min…tomorrow morning, and Today is a day off.
 */
export function modeItem(c: MenuContext): Item {
  const m = c.settings.modes;
  const now = new Date();
  const n = modeNow(m, now);
  const today = dayKey(now);
  // On the modes as stored, not as this menu was built (another window may have saved since).
  const set = (patch: Partial<ModeSettings>) =>
    void c.backend.getSettings().then((s) => c.backend.setSettings({ modes: { ...s.modes, ...patch } }));
  const forAWhile = (mode: ModeId, until: number) => set({ override: { mode, until } });
  const until = overrideUntil(m, now);
  const morning = tomorrowMorning(m, now);
  return {
    text: `Switch mode (now: ${MODE_ICONS[n.mode]} ${MODE_NAMES[n.mode]}${n.until ? ` until ${clock(n.until)}` : ""})`,
    items: [
      { text: "Auto (schedule)", checked: m.choice === "auto" && n.why !== "override", action: () => set({ choice: "auto", override: null }) },
      ...MODE_IDS.map((id) => ({
        text: `${MODE_ICONS[id]} ${MODE_NAMES[id]} until ${clock(until)}`,
        checked: n.why === "override" ? n.mode === id : m.choice === id,
        action: () => forAWhile(id, until),
      })),
      "sep",
      {
        text: "Quiet for…",
        items: [
          { text: "30 minutes", action: () => forAWhile("quiet", Date.now() + 30 * 60_000) },
          { text: "1 hour", action: () => forAWhile("quiet", Date.now() + 3_600_000) },
          { text: "2 hours", action: () => forAWhile("quiet", Date.now() + 2 * 3_600_000) },
          { text: `Until tomorrow ${clock(morning)}`, action: () => forAWhile("quiet", morning) },
        ],
      },
      { text: "Today is a day off", checked: m.dayOffOn === today, action: () => set({ dayOffOn: m.dayOffOn === today ? null : today }) },
    ],
  };
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
    modeItem(c),
    { text: "Open panel…", action: () => void c.backend.openPanel(panelTabFor(c)) },
    { text: "Hide pet", action: c.hide },
  ];
}

/**
 * The tray menu: show/hide on top (it is the way back to a hidden pet), Quit at the bottom.
 * Those two carry ids the app handles itself (src-tauri/src/tray.rs), so they work even if
 * the hidden pet window's script is throttled.
 */
export function buildTrayItems(c: TrayMenuContext): (Item | "sep")[] {
  return [
    c.petVisible ? { id: "hide", text: "Hide pet" } : { id: "show", text: "Show pet" },
    "sep",
    ...taskItems(c),
    "sep",
    // The one difference in the shared part: with the pet hidden during a focus session there
    // is no pet to ask "Play anyway?", so the game is left out until the focus ends.
    ...playItems(c).filter((i) => c.petVisible || !gameHeld(c.settings.pomodoro, c.pomodoro) || i === "sep" || !i.text.startsWith("Play")),
    "sep",
    modeItem(c),
    { text: "Open panel…", action: () => void c.backend.openPanel(panelTabFor(c)) },
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
