import type { CharacterRegistry } from "../characters/registry";
import type { CareAction, CharacterDef } from "../characters/schema";
import { pick, type Rng } from "../engine/random";
import { formatDuration, PRESET_MINUTES } from "../features/alarm/timers";
import { formatRemaining } from "../features/pomodoro/logic";
import type { Alarm, Backend, PomodoroStatus, Settings } from "../platform";

export interface MenuContext {
  backend: Backend;
  registry: CharacterRegistry;
  settings: Settings;
  pomodoro: PomodoroStatus;
  character: CharacterDef;
  hungry: boolean;
  /** Running timers, soonest first. */
  timers: (Alarm & { nextFire: number })[];
  /** Alarms waiting to ring again after a snooze. */
  snoozed?: (Alarm & { nextFire: number })[];
  rng: Rng;
  care: (action: CareAction) => void;
  setTimer: (minutes: number) => void;
  /** Asks for a custom length in the pet's speech bubble. */
  customTimer: () => void;
  hide: () => void;
}

export interface Item {
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

/** Every item starts with a verb; items are grouped by what you're doing. */
export function buildItems(c: MenuContext): (Item | "sep")[] {
  const now = Date.now();
  const care = pickCare(c.character, c.hungry, c.rng);
  const focusing = c.pomodoro.phase !== "idle";
  const left = (at: number | null) => (at ? ` (${formatRemaining(at - now)} left)` : "");

  // Presets keep fixed positions (muscle memory); the user's own lengths sit below a separator.
  const recent = c.settings.recentTimers.filter((m) => !PRESET_MINUTES.includes(m));
  const timerItems: (Item | "sep")[] = [
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
    timerItems.push({ text: `Cancel timer${left(t.nextFire)}`, action: () => void c.backend.deleteAlarm(t.id) });
  } else if (c.timers.length > 1) {
    timerItems.push({
      text: "Cancel timer",
      items: c.timers.map((t) => ({
        text: `${t.label.replace(/^Timer: /, "")}${left(t.nextFire)}`,
        action: () => void c.backend.deleteAlarm(t.id),
      })),
    });
  }

  for (const a of c.snoozed ?? []) {
    const at = new Date(a.nextFire).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    timerItems.push({ text: `Cancel snooze: ${a.label} (${at})`, action: () => void c.backend.dismissAlarm(a.id) });
  }

  return [
    { text: `${careLabel(care, c.character)}${care.kind === "pet" ? " ♥" : ""}`, action: () => c.care(care) },
    "sep",
    { text: "Add to-do…", action: () => void c.backend.openPanel("todos") },
    { text: "Set alarm…", action: () => void c.backend.openPanel("alarms") },
    ...timerItems,
    focusing
      ? { text: `Stop focus session${left(c.pomodoro.endsAt)}`, action: () => void c.backend.pomodoroStop() }
      : { text: "Start focus session 🍅", action: () => void c.backend.pomodoroStart() },
    "sep",
    { text: "Play Safe Landing", action: () => void c.backend.openGame("safe-landing") },
    {
      text: "Switch character",
      items: c.registry.list().map((ch) => ({
        text: ch.def.displayName,
        checked: ch.def.id === c.settings.character,
        action: () => void c.backend.setSettings({ character: ch.def.id }),
      })),
    },
    "sep",
    { text: "Open panel…", action: () => void c.backend.openPanel() },
    { text: "Hide pet", action: c.hide },
  ];
}

/** Right-click menu: native in the app, a small HTML menu in the browser mock. */
export async function showPetMenu(e: MouseEvent, c: MenuContext): Promise<void> {
  const items = buildItems(c);
  if (c.backend.kind === "tauri") {
    const { Menu, Submenu, MenuItem, CheckMenuItem, PredefinedMenuItem } = await import("@tauri-apps/api/menu");
    const toNative = async (i: Item | "sep"): Promise<unknown> => {
      if (i === "sep") return PredefinedMenuItem.new({ item: "Separator" });
      if (i.items) return Submenu.new({ text: i.text, items: (await Promise.all(i.items.map(toNative))) as never });
      if (i.checked !== undefined) return CheckMenuItem.new({ text: i.text, checked: i.checked, action: i.action });
      return MenuItem.new({ text: i.text, action: i.action });
    };
    const menu = await Menu.new({ items: (await Promise.all(items.map(toNative))) as never });
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
