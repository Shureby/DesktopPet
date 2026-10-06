# Characters

Every pet (cat, rooster, and later tiger, dog, sheep, goat, gorilla…) shares
one engine. A character is **data first, code optional**:

```
assets/characters/<id>/
  character.json      required; validated by src/characters/validate.ts
  *.png / *.webp      optional sprite sheet (or inline pixel art in the JSON)
```

Adding the folder is all it takes: [`registry.ts`](../src/characters/registry.ts)
discovers it, the panel lists it, and every mini-game can use it.

## Users' own characters (since 0.31.0)

Users don't see the bundled folders, so the app gives them a way in:

- **The characters folder** (Panel → Characters → "your characters folder"; on Windows
  `%APPDATA%\com.ezyappco.epet\characters`) gets, whenever it's opened or read and they're
  missing: `README.txt` (the user guide, `src-tauri/src/characters_readme.txt`),
  `character.schema.json` and `example-cat/character.json.example` (the cat with id
  `example-cat`; the `.example` keeps it from loading). Edited files are left alone.
- **"⧉ Make a copy"** under each card writes the character's JSON with a new id
  (`cat-copy`, `cat-copy-2`…), the name "Cat (copy)" and `"$schema": "../character.schema.json"`
  into a new folder (with a user character's images and sounds), opens that folder and
  reloads. (`copy_character`; the source must be inside the characters folder.)
- **"⟳ Reload characters"** makes every window read the folder again
  (`characters-changed`); the pet redraws itself from the new file and keeps its mood.
  Load errors are listed, opened, on the Characters page.

## character.json

Point `"$schema"` at `schema/character.schema.json` for autocompletion. The main fields:

| Field | What it does |
| --- | --- |
| `id`, `displayName`, `description` | Identity. `id` is lowercase with dashes. |
| `sprite` | `"pixels"` (palette + rows of characters, great for placeholder art) or `"sheet"` (PNG/WebP grid). Art faces `facing` and is mirrored for the other direction. |
| `stats` | `walkSpeed`, `runSpeed`, `jumpPower` (logical px/s), `weight` (gravity multiplier), `climbSpeed`. |
| `animations` | Name → `{ frames, fps, loop, next }`. **Required core set**: idle, walk, run, jump, fall, land, sit, sleep, drag, happy, alert. Abilities may require more. |
| `abilities` | `[{ "id": "climbWall", "params": { … } }]`. These are the special movements. |
| `personality` | Weights for idle behaviours, `sleepiness`, `sociability` and speech `lines` (greet, petted, thrown, landed, reminder, alarm, focusStart, breakStart, focusEnd, bored). `{title}` is replaced with the reminder text. |
| `personality.care` | Right-click menu actions (`{ "label": "Scratch the {name}'s chin", "kind": "pet" }`, `kind` is `pet` or `feed`). One is shown at random; feeding comes first when the pet is hungry. |
| mood lines | `fed`, `full`, `enough` (petting capped for the hour), `hungry`, `grumpy`, `adoring`, `sulk`, `praise`, `timerSet` (`{duration}`, `{time}`), `noted` (`{title}`, `{when}`). Missing lines fall back to neutral text. |
| hover lines | `dodgeHungry`, `dodgeGrumpy` (stepping away from the mouse), `noticed`, `noticedHappy` (after 2 s of hovering), `release` (moving on from a parked mouse). See [INTERACTIONS.md](INTERACTIONS.md). Missing lines just stay silent. |
| `moveset` | Fighting style for Stickman Fight: light/heavy/special/aerial moves with timings, damage, range and knockback. |

## Abilities (shared special movements)

Abilities live in [`src/characters/abilities/`](../src/characters/abilities). Each
one can add FSM states, idle behaviours, reactions (`onHitWall`,
`onCrossWindowSide`, `onFalling`) and **game modifiers**. Mini-games read the
modifiers, never character ids, so a new character automatically plays
differently in every game.

| Ability | Needs animations | Does | Game effect |
| --- | --- | --- | --- |
| `core` (everyone) | core set | idle, walk, run, sit, sleep, jump, fall, land, drag, happy, alert, goto | none |
| `climbWall` | `climb` | Climbs screen edges and window sides, then tops out onto windows | clings to walls |
| `glide` | `glide` | Floats down slowly | slow fall while holding glide |
| `pounce` | `crouch`, `pounce` | Wiggles, then leaps at the cursor | higher jumps, better air control |

Ideas for the upcoming cast: tiger `sprint`, goat `highJump` / `headbutt`,
gorilla `chestBeat` / `knuckleRun` (+ `climbWall`), dog `fetch` / `chaseCursor` /
`dig`, sheep `graze` / `bleat`. To add one, write a module next to the others,
register it in `abilities/index.ts`, and any character can opt in.

First-party characters that need behaviour JSON can't express (e.g. the gorilla
shaking the window it sits on) can ship a code hook. **User and Workshop
characters are data-only** and never run scripts.

## Fighting styles and balance

Movesets differ per character (tiger: fast pounce combos; gorilla: slow heavy
slams; rooster: pecks and aerial flurries), but every moveset must sit within a
shared **power budget** ([`combat/moveset.ts`](../src/characters/combat/moveset.ts)):
average damage-per-second weighted by reach must be within ±25% of the target.
Validation rejects characters outside the budget.

## Conformance test

[`characters.test.ts`](../src/characters/characters.test.ts) loops over **every**
bundled character and checks that it validates, that the moveset is in budget,
that it only uses known abilities, and that it survives three simulated minutes
of free roaming. New characters get this coverage automatically.

## Art tips

- Pixel art: keep every frame the same size and use `.` for transparent pixels. `npm run sprites` renders previews to `build/previews/<id>.png`.
- Anchor: frames are drawn with the feet at the bottom centre, so leave the bottom row for feet.
- Placeholder art is original. Don't reuse the eSheep art or other copyrighted sprites.
