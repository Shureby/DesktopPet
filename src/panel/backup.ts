/**
 * Settings → Backup (docs/INTERACTIONS.md, "Backup and restore"): export everything to a
 * file (with a password if you like), restore one here or on another computer, and the
 * backups ePet makes itself every day.
 */
import type { Backend, BackupSummary, RestoreParts, SavedBackup } from "../platform/types";
import { formatWhen, h } from "./dom";

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** "HOME-PC · Windows · Today 9:41 AM" */
export function backupFrom(s: BackupSummary, now = Date.now()): string {
  const os = { windows: "Windows", macos: "macOS", linux: "Linux" }[s.device.os] ?? s.device.os;
  return `${s.device.name} · ${os} · ${formatWhen(s.madeAt, now)}`;
}

/** "3 alarms · 12 to-dos · 2 anniversaries · 1 character" (what would be restored; timers never are). */
export function backupContents(s: BackupSummary): string {
  const parts = [plural(s.alarms, "alarm"), plural(s.todos, "to-do"), plural(s.anniversaries, "anniversary").replace("anniversarys", "anniversaries")];
  if (s.characters) parts.push(plural(s.characters, "character"));
  return parts.join(" · ");
}

/** A dialog like `ask` in main.ts, with whatever goes in it; returns its close function. */
function dialog(title: string, body: Node[], buttons: Node[]): () => void {
  const close = () => {
    overlay.remove();
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
  const box = h(
    "div",
    { class: "ask backup-dialog", role: "dialog", "aria-modal": "true" },
    h("p", { class: "title" }, title),
    ...body,
    ...buttons,
    h("button", { class: "cancel", onclick: close }, "Cancel"),
  );
  const overlay = h("div", { class: "ask-overlay", onclick: (e: Event) => e.target === overlay && close() }, box);
  document.addEventListener("keydown", onKey);
  document.body.append(overlay);
  (box.querySelector("input, button") as HTMLElement | null)?.focus();
  return close;
}

export function backupSection(backend: Backend): Node {
  const status = h("p", { class: "hint backup-status" });
  const say = (text: string, error = false) => {
    status.textContent = text;
    status.classList.toggle("warning", error);
  };

  const exportBackup = () => {
    const pw = h("input", { type: "password", placeholder: "Password (optional)", autocomplete: "new-password", class: "backup-password" });
    const again = h("input", { type: "password", placeholder: "Password again", autocomplete: "new-password", class: "backup-password-again" });
    const problem = h("p", { class: "warning" });
    const close = dialog(
      "Export backup",
      [
        h("p", { class: "sub" }, "Everything ePet keeps, in one file: alarms, to-dos, anniversaries, settings, your pet and your characters."),
        pw,
        again,
        h("p", { class: "sub" }, "With a password the file is encrypted. Forget it and the backup can't be opened — not even by us."),
        problem,
      ],
      [
        h(
          "button",
          {
            class: "primary",
            onclick: async () => {
              if (pw.value !== again.value) {
                problem.textContent = "The passwords don't match.";
                return;
              }
              close();
              try {
                const saved = await backend.backupExport(pw.value || null);
                if (saved) say(`Saved${pw.value ? " (encrypted)" : ""}: ${saved}`);
              } catch (e) {
                say(`Couldn't save the backup: ${String(e)}`, true);
              }
            },
          },
          "Export",
        ),
      ],
    );
  };

  /** Opens a backup (asking for its password if it has one), then offers what to restore. */
  const openBackup = async (path: string | null, password: string | null = null, wrong = false): Promise<void> => {
    let opened;
    try {
      opened = await backend.backupOpen(path, password);
    } catch (e) {
      say(`Couldn't open it: ${String(e)}`, true);
      return;
    }
    if (opened.status === "cancelled") return;
    if (opened.status === "needsPassword" || opened.status === "wrongPassword") {
      const pw = h("input", { type: "password", placeholder: "Password", class: "backup-open-password" });
      const go = () => {
        close();
        void openBackup(opened.path, pw.value, true);
      };
      pw.addEventListener("keydown", (e) => e.key === "Enter" && go());
      const close = dialog(
        "This backup has a password",
        [
          h("p", { class: "sub" }, opened.path ?? ""),
          pw,
          ...(opened.status === "wrongPassword" || wrong ? [h("p", { class: "warning wrong-password" }, "Wrong password.")] : []),
        ],
        [h("button", { class: "primary", onclick: go }, "Open")],
      );
      return;
    }
    if (opened.summary) restoreDialog(opened.summary);
  };

  const restoreDialog = (s: BackupSummary) => {
    const parts: RestoreParts = { schedule: true, settings: true, pet: true, characters: s.characters > 0 };
    const check = (key: keyof RestoreParts, text: string, disabled = false) =>
      h(
        "label",
        { class: "check" },
        h("input", { type: "checkbox", checked: parts[key], disabled, onchange: () => (parts[key] = !parts[key]), name: key }),
        text,
      );
    let mode: "merge" | "replace" = "merge";
    const radio = (value: "merge" | "replace", text: string, sub: string, cls = "") =>
      h(
        "label",
        { class: `check ${cls}` },
        h("input", { type: "radio", name: "restore-mode", value, checked: value === mode, onchange: () => (mode = value) }),
        h("span", {}, text, h("small", { class: "hint" }, ` — ${sub}`)),
      );
    const close = dialog(
      "Restore backup",
      [
        h("p", { class: "sub backup-from" }, backupFrom(s)),
        h("p", { class: "sub backup-contents" }, backupContents(s)),
        check("schedule", "Alarms, to-dos and anniversaries"),
        check("settings", "Settings"),
        check("pet", "Your pet: mood, scores, achievements"),
        check("characters", s.characters ? "Your characters" : "Your characters (none in this backup)", !s.characters),
        radio("merge", "Merge", "with what's here; where both changed one, the newer wins"),
        radio("replace", "Replace", "what's here goes (timers stay)", "replace"),
        h("p", { class: "sub" }, "ePet backs up this computer first, then restarts."),
      ],
      [
        h(
          "button",
          {
            class: "primary",
            onclick: async () => {
              close();
              say("Restoring… ePet will restart.");
              try {
                await backend.backupRestore(parts, mode);
              } catch (e) {
                say(`Couldn't restore: ${String(e)}`, true);
              }
            },
          },
          "Restore",
        ),
      ],
    );
  };

  const saved = h("div", { class: "saved-backups" });
  const listSaved = async () => {
    let list: SavedBackup[] = [];
    try {
      list = await backend.backupListAuto();
    } catch {
      // No folder yet: nothing to list.
    }
    saved.replaceChildren(
      ...list.map((b) =>
        h(
          "div",
          { class: "row spread saved-backup" },
          h("span", {}, formatWhen(b.madeAt), h("small", { class: "hint" }, b.kind === "auto" ? " · daily" : " · before a restore")),
          h("button", { onclick: () => void openBackup(b.path) }, "Restore…"),
        ),
      ),
    );
    if (!list.length) saved.append(h("p", { class: "hint" }, "The first one is made a few seconds after ePet starts."));
  };
  void listSaved();

  return h(
    "div",
    { class: "box backup" },
    h(
      "div",
      { class: "row" },
      h("button", { class: "backup-export", onclick: exportBackup }, "Export backup…"),
      h("button", { class: "backup-restore", onclick: () => void openBackup(null) }, "Restore from backup…"),
    ),
    status,
    h("hr"),
    h("div", { class: "subhead" }, "Automatic backups"),
    h("p", { class: "hint" }, "One a day, the last 7 kept, on this computer."),
    saved,
  );
}
