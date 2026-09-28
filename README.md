# ePet (working title)

A desktop pet in the spirit of the classic eSheep. A little animal wanders your
desktop, walks on top of your windows and can be picked up and thrown. It is
also a helper: it reminds you of to-dos, rings alarms, runs focus sessions
(Pomodoro) and has mini-games for when you need a break.

Built with **Tauri 2 + TypeScript** for **Windows and macOS**, to ship on
**Steam**, the **Epic Games Store** and **[ezyappco.com/ePet](https://ezyappco.com/ePet)**.
The product name is not final. It lives in one place, [`product.config.json`](product.config.json).

| Cat | Rooster |
| --- | --- |
| Climbs screen edges and window sides, pounces on your cursor | Glides down from anywhere, crows at your alarms |

## What's in the MVP

- **Pet**: walks, runs, sits, sleeps, jumps and falls. It lands on (and rides) the top edges of real windows, can be dragged and thrown, and clicks pass through everywhere except the pet itself.
- **Interchangeable characters**: data-driven `character.json` files with shared abilities, per-character special moves, personality and fighting style. Two ship now (Cat, Rooster); more can be added without code.
- **To-dos** with natural quick-add ("call mom at 3pm", "stretch in 20m", "standup tomorrow 9:30"). The pet runs over and tells you.
- **Alarms and timers**: once, daily or weekdays, with snooze. They ring even while the UI is busy (the scheduler is in Rust).
- **Focus sessions (Pomodoro)**: 25/5 with a long break every 4 rounds (all configurable). The pet sits and "works" with you, then celebrates on breaks. It keeps 7-day stats.
- **Mood**: affection and fullness (0–100, saved per character). Petting, feeding and using the app's features raise them; ignoring the pet lowers them slowly, and only while the app runs. Mood changes behaviour and lines (adoring pets come to your cursor, grumpy ones mope, hungry ones complain) but never blocks reminders. Hover over the pet to see its hearts.
- **Feedback everywhere**: setting a timer or adding a to-do gets a spoken confirmation. Timers and the focus session show stacked countdown badges next to the pet.
- **Mini-game: Safe Landing**. Games read character *abilities*, so the Rooster glides and the Cat clings to walls.
- **Storefront layer**: Steam, Epic or direct build, chosen with a Cargo feature.

## Getting started

```bash
npm ci                 # Node 22+ (use `npx npm@11 install` when changing deps: npm 10 has a peer-resolution bug)
npm run dev            # browser demo at http://localhost:1420/pet.html (no Rust needed)
npm run tauri dev      # the real desktop app (needs Rust + Tauri prerequisites)
```

The **browser demo** uses an in-memory backend ([`src/platform/mock.ts`](src/platform/mock.ts))
and draggable fake windows, so you can work on behaviour and UI without the native shell.
In devtools, `petHost.pet` is the live simulation.

Tauri prerequisites: <https://v2.tauri.app/start/prerequisites/> (Linux also needs
`libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev libxdo-dev`).

## Checks

```bash
npm run typecheck && npm test                  # TypeScript + 59 Vitest tests
cargo test --workspace                         # Rust core: storage, alarms, focus sessions
cargo clippy --workspace --all-targets -- -D warnings
```

## Project layout

```
product.config.json        product name, bundle id, publisher (rename here)
assets/characters/<id>/    character.json (+ sprite sheets / sounds)
schema/                    JSON Schema for character.json (editor autocompletion)
src/
  engine/                  physics, state machine, animation, sprites, RNG
  characters/              schema, validation, registry, Pet runtime
    abilities/             core + climbWall, glide, pounce (reusable by any character)
    combat/                movesets and the shared power budget (Stickman Fight)
  brain/                   Brain interface + RulesBrain (future: LLM brains)
  features/                todo quick-add, pomodoro logic, games (GameHost + Safe Landing)
  pet/  panel/             the pet window and the control panel
  platform/                Backend interface: Tauri implementation + browser mock
crates/desktoppet-core/    Rust: SQLite store, alarm recurrence, focus sessions (unit tested)
src-tauri/                 Rust: windows, tray, commands, scheduler, desktop window list,
                           storefront (direct / steam / epic)
```

## Adding a character

Copy `assets/characters/cat`, change `id` and the art, and pick abilities and a
personality. [docs/CHARACTERS.md](docs/CHARACTERS.md) explains the format,
abilities, movesets and the conformance test every character must pass. Users
can drop data-only characters into their characters folder (Panel → Characters);
that folder is also the path for Steam Workshop content.

## More

- [docs/INTERACTIONS.md](docs/INTERACTIONS.md): how the pet responds to the mouse, menus, badges and unanswered alarms (the rules and why)
- [docs/CHARACTERS.md](docs/CHARACTERS.md): character format and how to add abilities
- [docs/DISTRIBUTION.md](docs/DISTRIBUTION.md): Steam, Epic, the website build, signing, renaming
- [docs/ROADMAP.md](docs/ROADMAP.md): next characters, games, tools and the LLM tier
- [docs/TESTING.md](docs/TESTING.md): the manual test checklist (generated from `docs/test-checklist.json`)
