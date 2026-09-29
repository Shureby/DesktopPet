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
- **Clicking a badge opens its tab:** ⏱, 💤 and 🔔 open Alarms; 🍅 or ☕ opens Focus.
- **Clicking a note badge clears it:** the missed-alarm badge and the "⏱ Done" badge.
- **Countdown badges update their text in place** rather than being rebuilt, so a click
  never lands on a replaced element.

## Alarms and timers nobody answers (since 0.5.0)

Code: `src/features/alarm/ringing.ts`, the scheduler in `src-tauri/src/scheduler.rs`.

- **An alarm rings for "Ring for" (60 s by default), then snoozes itself** for 5 min, up
  to 3 times (both in Settings → Alerts). After that it is marked **missed**:
  - an OS notification;
  - an orange "⏰ Missed 9:40 PM" badge that stays until clicked;
  - the pet mentions it once, the next time you hover or click it.
- **Done on any ring ends the whole snooze cycle.**
- **Timers never snooze themselves.** An unanswered timer leaves a grey "⏱ Done 14:05"
  badge for an hour, or until clicked. The pet mentioning it doesn't remove the badge.
- **A snoozed timer stays visible and cancellable:** in the Alarms tab, as a badge, and
  under "Cancel timer" in the menu.

### An alarm keeps its own time through snoozes (since 0.15.0)

- **Snoozes never change what the alarm is called.** An alarm set for 9:40 PM is "Alarm
  9:40 PM" in every place and at every ring, however often it was snoozed:
  - the ringing bubble;
  - the menu;
  - the badges;
  - the Finished list;
  - the OS notification.
- **The ring time is kept in `rang_at`:** when the current ringing cycle began. A ring
  after a snooze keeps it; a repeating alarm's next day starts a new cycle.
- **A ring after a snooze says so:** "Snoozed 2× · first rang 9:40 PM". The last automatic
  one adds "last try before it's marked missed".
- **Menus name both times:** "Cancel snooze: Alarm 9:40 PM (next ring 9:46 PM)".
- **Labels never contain a time.** An unnamed alarm is stored as "Alarm" and shown with
  its time through `clock()`, which follows the system's 12/24-hour setting.
  - The old default, "Alarm 21:40", mixed 24-hour text into a 12-hour UI.
  - Migration v6 renamed those labels to "Alarm".
- **Seeing a missed alarm isn't undoing it.**
  - Clicking the ⏰ badge (or pressing Done) sets `missed_seen_at`: the badge goes.
  - The Finished list still says "Missed · Today 9:40 PM · snoozed 3×".
- **The missed-alarm notice is important.** While it shows (8 s), petting or chatter can't
  replace it; petting still counts, silently.

### Several things due at once (since 0.15.0)

- **Alarms and timers that come due while another is ringing join the same bubble,**
  e.g. "⏱ 2 timers are up: • 12 min timer • 25 min timer".
  - Snooze or Done answers all of them.
  - Nobody answering treats each by its own rule.
  - The ring time restarts when one joins.
- **Before 0.15.0 the earlier one was silently counted as unanswered,** so two timers
  finishing a second apart looked like one timer vanishing.
- **A to-do reminder that comes due meanwhile waits,** and shows once the bubble closes.
- **Done keeps a timer in the Finished list** ("Done · Today 12:42 PM"). It used to delete
  it, so the timers you answered disappeared and the unanswered ones stayed. Cancel on a
  running timer still deletes it: that is before it rang.

## Switching off a repeating alarm (since 0.18.0)

Code: `askTurnOff` in `src/panel/main.ts`, `skip_alarm_once` / `unskip_alarm` in
`crates/desktoppet-core/src/store.rs`, `skipWhen` in `src/panel/alarmText.ts`.

- **Like a phone, the switch asks first** for an alarm that repeats (every day, weekdays):
  - `Skip once · Sep 30 7:00 PM (Today)`: only the next ring is skipped. The alarm stays
    on and rings again at the one after.
  - `Turn off repeating alarm`: off, as before.
  - `Cancel` (or Esc, or a click outside): nothing changes.
- **The skip button names the exact ring:** date, time and day. The day is "Today",
  "Tomorrow" or the weekday ("Oct 5 7:00 PM (Monday)"): a weekday alarm skipped on a
  Friday evening next rings on Monday.
- **A skipped alarm says so** in its row: `⏭ Skips Sep 30 7:00 PM (Today) · Undo`.
  - Undo brings the skipped ring back.
  - The mark goes once the skipped time has passed.
  - Switching it off again asks with only "Turn off repeating alarm" and Cancel.
- **Skipping a snoozed alarm ends today's snoozes;** it rings next at its regular time.
- **One-off alarms and timers switch off without asking,** and switching anything on
  never asks.
- The skipped ring is kept in `alarms.skipped_fire` (v7 migration). It is cleared when the
  alarm rings or is switched off or on.

## Showing when things happened (since 0.13.0)

- **Anything finished says when,** so identical items can be told apart ("1 min timer"
  twice) and you can see how long ago it was:
  - timers: "Done · Today 12:42 PM";
  - one-off alarms: "Rang · Today 8:40 AM", with the ring time as the big time;
  - missed alarms: "Missed · Today 8:40 AM";
  - done to-dos: "Done · Today 3:15 PM".
- **Running timers say when they were started** (since 0.14.0): "Started 4:29 PM · rings
  at 4:41 PM". Without this, a forgotten test timer looked like part of an alarm that
  happened to ring at the same time. The start time is `alarms.created_at` (v5 migration).
  For timers set before 0.14.0 it is worked out from the ring time and the length in the
  label (`timerStartedAt`), unless a snooze moved the ring.
- **The badges show what happens within the next while** (since 0.17.0): running timers,
  the focus session, snoozed alarms and, with 🔔, alarms that ring within the next 60 min.
  - Before, an alarm had no badge until it snoozed, while timers always had one.
  - Settings → Alerts → "Show upcoming alarms by the pet" turns 🔔 off. While on, "Within
    N minutes" sets the look-ahead, 1–120. The field is hidden while it's off.
  - 🔔 shows the nearest alarm's clock time (not a countdown: it may be an hour away) and
    "+n" for the others within the look-ahead, like ⏱.
  - A snoozed alarm is under 💤, not 🔔.
- **Hovering a badge shows what it stands for,** in the same shape for every badge (since
  0.16.0): what and when, then what a click does on the last line.

  | Badge | Info | Last line |
  |---|---|---|
  | ⏱ | every running timer: `12 min · 8:10 → 8:22 PM`; a snoozed one `1 min · 💤×1 · 9:38 → 9:45 PM` | Open the Alarms tab |
  | 🍅 / ☕ | `Focus · 8:00 → 8:25 PM` (or `Break …`) | Open the Focus tab |
  | 💤 | `Alarm 9:40 PM · snoozed 1×`, `next ring 9:46 PM` | Open the Alarms tab |
  | 🔔 | every upcoming alarm: `Alarm 9:40 PM`, `Login CMC · 10:05 PM` | Open the Alarms tab |
  | ⏰ Missed | `Alarm 9:40 PM · snoozed 3×` | Mark as seen |
  | ⏱ Done | `12 min timer · done 8:22 PM` | Dismiss |

  - The ⏱ list is why "+5" isn't a mystery.
  - Times are ranges, not "Started … · rings at …", because the box is small. A shared
    AM/PM is written once (`timeRange`).
  - Parts of a line are separated by ` · `, as everywhere else (since 0.16.1). The box
    collapses repeated spaces, so spaces alone ran the parts together.
  - A snoozed timer is marked `💤×N` (since 0.16.1). Its range runs to the next ring, so
    without the mark "1 min · 9:38 → 9:45 PM" looks wrong.
  - The pet draws the box itself (`.badge-info`): native tooltips don't show reliably in
    its transparent, never-focused window.
  - **The box can be clicked** (since 0.17.0). Its last line looks like a link, so people
    move to it and click it; before, the box closed as soon as the mouse left the badge.
    - Clicking anywhere in the box does what clicking its badge does.
    - It touches the badge. It stays while the mouse is on it, and for 0.4 s after the
      mouse leaves both, which is enough to cross over at an angle.
    - The last line is always a verb: "Open the Alarms tab", "Mark as seen", "Dismiss".
- **The heart meter only shows with the cursor on the pet itself,** not on its badges or
  bubble. There you're after the alarm or the focus session, not the pet's mood.
- **The pet window is 340 px wide** (since 0.15.0), so badges beside the pet fit. A badge
  that is still too long ends in "…" rather than being cut off.
- **Finished and done lists put the most recent first.**
- **Dates read "Today", "Yesterday", "Tomorrow", otherwise a short date**
  (`formatWhen` in `src/panel/dom.ts`). Times follow the system's 12/24-hour setting,
  without a leading zero.
- **The ring time is stored in `alarms.rang_at`** (v4 migration; since v6 it is the start
  of the ringing cycle, see above). A one-off alarm loses `next_fire` once it rings, which
  is how it counts as finished, so the time needs its own column.
