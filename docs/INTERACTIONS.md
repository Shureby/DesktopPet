# Interaction rules

How the pet and the app respond to the user, and why. These are product decisions made
while testing. Change them on purpose: update this file, the code it points to, the tests
and `docs/test-checklist.json` together, and note the change in `CHANGELOG.md`.

## Mouse resting on the pet (since 0.12.0)

Code: `src/brain/hover.ts` (the rules and their numbers, `HOVER`), `RulesBrain.onHover`
(what the pet does), the `attend` and `dodge` states in `abilities/core.ts`, and
`PetHost.updateHover` (wiring). Tests: `brain/hover.test.ts`, `characters.test.ts`.

| # | When | The pet… |
|---|---|---|
| 1 | The mouse comes to rest on it | **Stops** (brakes, it doesn't freeze), turns to face the cursor and waits (`attend`). If it is jumping, pouncing, climbing or gliding, it stops once it lands. |
| 2 | …and it is hungry or unhappy (grumpy or sulking) | First **steps away** about one body length (walking, not running), stays near the cursor, turns back and says why: hungry → `dodgeHungry` ("My tummy's flat…"); neglected → `dodgeGrumpy` ("Oh, *now* you remember me?"). |
| 3 | The mouse comes back within 10 s of a step-away, or follows it | That counts as **insisting**: no more stepping away, and the pet reacts at once (as if hovered for 2 s). |
| 4 | The mouse has rested on it for 2 s | **Reacts once** per hover: an adoring pet (sometimes a content one) hops happily and says `noticedHappy`; otherwise it says `noticed` ("Mrrp?"). |
| 5 | After that, the mouse moves over it | That is **stroking**, the same as a click: +3 affection, "+3 ♥", a `petted` line. At most once every 1.5 s, and within the hourly petting cap (15 affection per hour, then "That's plenty for now"). A sulking pet may still snub it. |
| 6 | The mouse stays still on it for 8 s | The pet **goes on** with its day (`release`, "I'll be around."). It won't stop again until the mouse leaves and comes back. |

Limits and reasons:

- **Stepping away happens at most once every 2 minutes per pet.** Otherwise it turns into
  an endless chase.
- **Nothing happens in the first 2 seconds except stopping.** A mouse passing over the pet
  on its way somewhere shouldn't count as petting.
- **Rule 6 is about blocking.** While the mouse is on the pet, the pet is clickable (not
  click-through), so a pet parked under a resting mouse would block whatever is
  underneath. The pet leaves after 8 s.
- **Hovering uses the sprite's bounding box, not its exact pixels.** Stroking across a gap
  in the art (between the legs) then doesn't count as leaving and coming back. Clicks still
  use exact pixels.
- **Movement means 3 logical px from where the mouse last moved,** not frame to frame, so
  a slow stroke still counts.
- **Hover rules are off while:**
  - the pet is being dragged;
  - an alarm or reminder is ringing (the bubble's buttons need the mouse);
  - the pet is running to a reminder;
  - a focus session is on (the pet sits still anyway);
  - the pet is hidden, or a mini-game is open.

Speech lines each character needs (see `docs/CHARACTERS.md`): `dodgeHungry`,
`dodgeGrumpy`, `noticed`, `noticedHappy` and `release`.

## Menus (since 0.9.0)

Code: `src/pet/menu.ts`. Tests: `pet/menu.test.ts`.

- **One definition for both menus.** The pet's right-click menu and the tray menu share
  one definition (`taskItems`, `playItems`), so their functions are identical in wording,
  order and behaviour:
  - Add to-do… / Set alarm… / Set timer ▸ / Cancel timer / Cancel snooze / Start or
    Stop focus session;
  - Play Safe Landing / Switch character ▸;
  - Open panel….
- **The only differences:**
  - **Top:** the pet menu has a care action; the tray has Show pet / Hide pet.
  - **Bottom:** the pet menu ends with Hide pet; Quit is only in the tray (the OS
    convention, and it can't be hit by accident on the pet).
- **Every item starts with a verb.**
- **Menus show clock times, never time left** (since 0.10.0): "ends 4:10 PM",
  "rings 3:52 PM". A native menu can't count down while open, and the tray menu is built
  ahead of time, so a countdown would be stale. The live countdown is on the badges.
- **Show/hide and Quit in the tray are handled natively** (fixed ids in `tray.rs`). They
  work even if the hidden pet window's script is throttled.
- **Set timer:**
  - The presets keep fixed positions. Up to 3 custom lengths follow below a separator,
    most recent first; a new one replaces the oldest.
  - "Custom / Edit…" asks in the pet's bubble, or opens the panel when the pet is hidden.
  - ✎ changes a saved length in place; ✕ removes it.

## "Open panel…" and the badges (since 0.11.0)

- **"Open panel…" opens the tab of whatever runs out first** (`panelTabFor`):
  - Alarms for a timer or snoozed alarm;
  - Focus for a focus session or break;
  - Alarms for a missed alarm;
  - otherwise the panel's default.
- **Clicking a badge opens its tab:** ⏱ opens Alarms; 🍅 or ☕ opens Focus.
- **Clicking a note badge clears it:** the missed-alarm badge and the "⏱ Done" badge.
- **Countdown badges update their text in place** rather than being rebuilt, so a click
  never lands on a replaced element.

## Alarms and timers nobody answers (since 0.5.0)

Code: `src/features/alarm/ringing.ts`, the scheduler in `src-tauri/src/scheduler.rs`.

- **An alarm rings for "Ring for" (60 s by default), then snoozes itself** for 5 min, up
  to 3 times (both in Settings → Alerts). After that it is marked **missed**:
  - an OS notification;
  - an orange "⏰ Missed 9:00" badge that stays until clicked;
  - the pet mentions it once, the next time you hover.
- **Done on any ring ends the whole snooze cycle.**
- **Timers never snooze themselves.** An unanswered timer leaves a grey "⏱ Done 14:05"
  badge for an hour, or until clicked.
- **A snoozed timer stays visible and cancellable:** in the Alarms tab, as a badge, and
  under "Cancel timer" in the menu.

## Showing when things happened (since 0.13.0)

- **Anything finished says when,** so identical items can be told apart ("1 min timer"
  twice) and you can see how long ago it was:
  - timers: "Done · Today 12:42 PM";
  - one-off alarms: "Rang · Today 8:40 AM", with the ring time as the big time;
  - missed alarms: "Missed · Today 8:40 AM";
  - done to-dos: "Done · Today 3:15 PM".
- **Running timers say when they were started** (since 0.14.0): "Started 4:29 PM · rings
  at 4:41 PM". Without this, a forgotten test timer looked like part of an alarm that
  happened to ring at the same time. The start time is `alarms.created_at` (v5 migration);
  timers set before 0.14.0 show only "Rings at …".
- **Hovering the ⏱ badge lists every running timer** with its ring time, so "+5" isn't a
  mystery.
- **Finished and done lists put the most recent first.**
- **Dates read "Today", "Yesterday", "Tomorrow", otherwise a short date**
  (`formatWhen` in `src/panel/dom.ts`). Times follow the system's 12/24-hour setting,
  without a leading zero.
- **The ring time is stored in `alarms.rang_at`** (v4 migration). A one-off alarm loses
  `next_fire` once it rings, which is how it counts as finished, so the time needs its
  own column.
