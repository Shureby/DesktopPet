# Roadmap

## Next milestone

- **Characters**: dog, sheep, goat, tiger, gorilla, each with one new ability (`chaseCursor`, `graze`, `highJump`, `sprint`, `chestBeat`) and its own fighting style.
- **Mini-games**: Jump Up (endless climber) and Stickman Fight (1v1 using each character's `moveset`; the stickman AI is a state machine).
- **Steam**: real App ID, achievements, Workshop upload and download of data-only characters.
- **Steam on macOS (before launch):** CI builds only a Windows Steam depot today. Add a
  macOS Steam depot job: universal build with `--features steam`, `libsteam_api.dylib`
  in `Contents/Frameworks` (via `bundle.macOS.frameworks` in a Steam-specific Tauri
  config), signed and notarised. Launch on Steam with Windows and macOS ticked; Linux and
  SteamOS unticked.
- **Direct build**: auto-updater feed, code signing, license keys.

## Anniversaries (0.26.0, agreed 2026-10-02)

Comes after 0.24.0 (repeating to-dos and editing to-dos) and 0.25.0 (Today / Upcoming sections).

- **A 🎂 Anniversaries sub-page in To-dos.** To-dos opens on the To-dos sub-page (the
  tickable list). The sub-tab shows a count when an anniversary is within 7 days
  ("🎂 Anniversaries · 1").
- **Adding one:** name, date, an optional "since" year (for "36th" / "10th anniversary"),
  and up to 3 "remind before" rows. Each row is a lead time (1 day, 1 week…) plus an
  extra label. For example 老婆生日 with 1 day / 买生日蛋糕 makes the to-do
  "🎂 老婆生日 - 买生日蛋糕".
- **Generated to-dos appear on their day,** with a 9:00 AM reminder. They aren't listed
  months ahead. If the computer was off that day, the to-do is made at the next launch and
  shows as Overdue. Deleting the anniversary keeps generated to-dos that aren't ticked yet.
- **Anniversaries aren't ticked.** The sub-page lists them by next date ("Sat, Oct 25 (in 23
  days) · 36th"), with ✎ and ✕. Each rolls over to next year after its day. Feb 29 falls
  on Feb 28 in other years.
- **Celebration on the day:** the first time you're at the computer that day, a
  full-screen, click-through fireworks overlay plays for about 5 s on the pet's screen,
  and the pet says "🎉 Today is 老婆生日!" (with the count). Once a day.
  - Settings switch "Celebrate anniversaries with fireworks", on by default.
  - The hidden-pet checkboxes get "Anniversaries", ticked by default.

## Lunar-calendar birthdays (future upgrade, a selling point)

> **Status: idea for later.** Recorded 2026-10-02.

Many Chinese users, and their parents especially, keep 农历 birthdays, which fall on a
different Gregorian date each year. Add a "Lunar" switch to the anniversary date, with the
lunar month and day (闰月 handled). Its Gregorian date is computed each year, and rows show
both ("农历八月十五 · Oct 6"). It's a good line for Chinese store pages and marketing, so
it's worth announcing on its own when it ships.

## Rename to ChimePet (do in the last build before launch)

> **Status: decided, not done.** Recorded 2026-10-01. "ePet" stays the working name
> while we're developing. The rename goes into the last build before the first store
> release, because the identifier can't change once a store build is out.

**Name:** **ChimePet** (中文 **铃宠**). We searched for both on 2026-10-01 and found no
desktop pet, app or game with either name. A "Pet Chime" pet doorbell (hardware) and the
bank Chime exist. Before launch, check trademarks (IP Australia, USPTO, EUIPO, CNIPA for
铃宠; classes 9 and 41), domains (chimepet.com / .app), Steam and Epic listings, and
social handles.

**What changes (users see these):**
- `product.config.json` → `productName: "ChimePet"`, `website: https://ezyappco.com/ChimePet`.
  The installer, Start menu, tray tooltip, window and panel titles, the version line in
  Settings and the Steam exe (`ChimePet.exe`) all read it.
- "Didn't ring · … · ePet wasn't running": read the product name instead of writing ePet.
- README (drop "working title"), DISTRIBUTION, INTERACTIONS, TESTING and the checklist
  (rev on 1.3, 7.19 and the other items that mention the name; plus a new item for
  upgrading from ePet). The CHANGELOG keeps its old entries and gets "Renamed ePet →
  ChimePet".
- 铃宠 is used only on the Chinese store pages for now. It goes into the app when the UI
  is localised.

**Identifier:** change `com.ezyappco.epet` → `com.ezyappco.chimepet` (still free to do
before the first store upload). On first launch, if the new data folder has no
database and the old one does, copy it across so alarms, to-dos and settings carry
over. Testers uninstall ePet once: Windows treats the renamed app as a different
program, so both would be installed and both would start with the computer.

**Not renamed (users don't see these):** the repo `DesktopPet`, the `desktoppet` crates,
`desktoppet.db` and the mock's storage keys.

**Outside the code:** a page at ezyappco.com/ChimePet (redirect /ePet there), and the
store listings under the new name.

## Linux (later, if users ask)

> **Status: idea for later.** Recorded 2026-10-01. Not planned for launch: Steam ships
> Windows and macOS only, and Linux/SteamOS stay unticked.

- **Why not now:**
  - On **Wayland** (the default on most distros) an app can't move its own window, and
    the pet walks by moving its window. It only works under X11/XWayland
    (`GDK_BACKEND=x11`).
  - Transparent, always-on-top windows and the tray behave differently across desktops.
    GNOME has no tray without an extension.
  - Steam's Linux runtime doesn't include WebKitGTK, so we'd have to ship it ourselves.
- **Proton isn't the answer:** the Windows build depends on WebView2, which is generally
  unreliable under Proton. Transparency and the tray are likely to break too. Don't claim
  Proton or Steam Deck support.
- **Steam Deck:** Game Mode shows one full-screen app and has no desktop, so a desktop
  pet has no place there. Desktop Mode is plain Linux (see above).
- **If we do it:** a native Linux build that forces X11, a tray fallback (open the panel
  from the pet's menu), WebKitGTK bundled for the Steam runtime, and a "Linux (X11)"
  note on the store page.

## Personality

- Needs and moods (energy, boredom, affection) visible in the panel. The pet levels up with use.
- Hides while a full-screen app or game is running, and in a "presentation mode".
- Several pets at once that interact with each other. Seasonal costumes.

## Small desktop tools

- Stretch, water and 20-20-20 eye-rest reminders.
- Clipboard history: the pet "eats" what you copy and you can pick it back up.
- Drop a file on the pet to compress it, convert an image, or move it to a folder.
- Downloads tidier, and folder sync (the pet carries a box while syncing).
- Sticky notes pinned next to the pet. A system glance: battery, CPU, next meeting from an ICS feed.
- Screenshot + annotate, colour picker.

## To-dos with progress, tied to focus (idea, not scheduled)

> **Status: idea for later.** Recorded 2026-09-30 after looking at a competitor's
> five-column task board. Not planned for any version yet. It's a direction to extend
> into when to-dos need more than open/done.

**Why not a full board now:** ePet's to-dos are quick one-liners with reminders. A
multi-column board with custom statuses and drag-and-drop competes with Trello and Notion,
looks empty with the handful of tasks a desktop-pet user keeps, and would cost about as
much as the whole to-do module. What's worth taking from it is *progress*: to do → doing
→ done.

**Step 1: a "doing" state for to-dos.**
- A ▶ on a to-do marks it as what you're working on now (one at a time).
- The pet shows it: in a badge or its info box ("Doing: write the weekly report").

**Step 2: focus on a to-do.**
- Start a tomato-clock session from a to-do; the session belongs to it.
- When the focus ends, the pet asks "Done with *write the weekly report*?" [✓ Done]
  [Not yet].
- Each to-do counts its sessions ("🍅×3"). The Focus stats can also show time per task.

**Later: a board view built on the same data.**
- Columns such as To do / Doing / Waiting / Done, and user-defined statuses.
- Moving a card into **Doing** starts a focus session on it, and moving it out (or
  finishing) stops it. A card moved to Done gets the pet's congratulations and its 🍅
  count.
- "Clear done" at the end of the day, like finished alarms.
- Steps 1–2 should store status and sessions per to-do so that a board is only a new
  view, not a new data model.

## More mini-games

A taskbar hurdle runner, catching falling food (feeds the pet's mood) and
whack-a-bug. Scores earn coins that unlock cosmetics.

## LLM tier

The `Brain` interface (`src/brain/Brain.ts`) is the extension point:

1. **Rules** (free, offline): today's `RulesBrain`.
2. **Local small model** (llama.cpp / Ollama, 1–4B params): turn free-form text into structured to-dos and alarms, summarise, decide when it's a good moment to interrupt.
3. **Cloud subscription**: small, cheap models for frequent judgement calls (e.g. Claude Haiku), and larger ones for predefined skills such as summarising a dropped file, planning the day from to-dos or triaging Downloads.

Keep prompts **predefined and tool-scoped** so cost and safety stay predictable.
Each character's `personality` feeds the prompt so each animal "talks"
differently. The model you mentioned as "jev" slots into the same interface
once we know which one it is.
