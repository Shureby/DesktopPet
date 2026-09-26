import type { CharacterRegistry } from "../characters/registry";
import type { Backend, PomodoroStatus, Settings } from "../platform";

export interface MenuContext {
  backend: Backend;
  registry: CharacterRegistry;
  settings: Settings;
  pomodoro: PomodoroStatus;
  pet: () => void;
}

interface Item {
  text: string;
  action?: () => void;
  checked?: boolean;
  items?: Item[];
}

function buildItems(c: MenuContext): (Item | "sep")[] {
  const timer = (min: number) => () =>
    void c.backend.addAlarm(`Timer: ${min} min`, Date.now() + min * 60_000, "none");
  const focusing = c.pomodoro.phase !== "idle";
  return [
    { text: "Pet ♥", action: c.pet },
    "sep",
    { text: "Add to-do…", action: () => void c.backend.openPanel("todos") },
    {
      text: "Timer",
      items: [1, 5, 10, 15, 30, 60].map((m) => ({ text: `${m} min`, action: timer(m) })),
    },
    focusing
      ? { text: "Stop tomato clock", action: () => void c.backend.pomodoroStop() }
      : { text: "Start tomato clock 🍅", action: () => void c.backend.pomodoroStart() },
    "sep",
    { text: "Play: Safe Landing", action: () => void c.backend.openGame("safe-landing") },
    {
      text: "Character",
      items: c.registry.list().map((ch) => ({
        text: ch.def.displayName,
        checked: ch.def.id === c.settings.character,
        action: () => void c.backend.setSettings({ character: ch.def.id }),
      })),
    },
    "sep",
    { text: "Open panel…", action: () => void c.backend.openPanel() },
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
