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
  - an alarm or reminder is ringing, or a bubble waits for an answer (✓ Done / Later): the
    buttons need the mouse, and a hover line would replace the bubble (it did before
    0.32.1);
  - the pet is running to a reminder, except for one rule (since 0.32.1): **the mouse put
    on it, or waiting in its way, stops it where it is.** It counts once the mouse has been
    still for 0.15 s and the pet is under it or was within 0.3 s (a running pet slips out
    from under a cursor in a fraction of a second). It turns to the cursor and rings
    there, and doesn't go on to the middle. A mouse sweeping across doesn't count. It
    doesn't apply to walking back to the edge to hide, or to a remembrance's candle
    (`RunStopper` in `brain/hover.ts`);
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
- **The only differences** (plus one exception: during a focus session with the pet hidden,
  the tray leaves out the game; see "Games during a focus session"):
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
- **Clicking a badge opens its tab:** ⏱ and 🔔/💤 open Alarms; 🍅 or ☕ opens Focus.
- **Clicking a note badge clears it:** the missed-alarm badge and the "⏱ Done" badge.
- **Countdown badges update their text in place** rather than being rebuilt, so a click
  never lands on a replaced element.

## Alarms and timers nobody answers (since 0.5.0)

Code: `src/features/alarm/ringing.ts`, the scheduler in `src-tauri/src/scheduler.rs`.

- **An alarm rings for "Ring for" (60 s by default), then snoozes itself** for 5 min, up
  to 3 times (both in Settings → Alarms & timers). After that it is marked **missed**:
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
  - "While I was hidden you missed…".
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

## When the pet is hidden (since 0.22.0)

Code: `peek` / `end_peek` in `src-tauri/src/app_windows.rs`, the scheduler
(`src-tauri/src/scheduler.rs`), `enterPeek` / `watchPeek` / `tellUnseen` in `PetHost`, the
`unseen` table in `store.rs`.

- **There are no system notifications.** The pet announces everything itself. Before
  0.22.0 alarms also sent "ePet / Alarm / Alarm": it said nothing, did nothing when
  clicked, and repeated the bubble.
- **Hidden, the pet comes out** for what Settings → Pet → "When hidden, it comes out for"
  ticks:
  - Alarms, Timers and To-do reminders are on by default.
  - Focus sessions (a focus or break ending) is off by default: it happens a dozen times a
    day.
  - Anything unticked shows a red ❗ "While your pet is hidden, … will not alert you."
- **Coming out:**
  - The app shows the window natively (the hidden window's script may be throttled), without
    announcing it as shown. The tray still says "Show pet".
  - The pet steps in from the nearest screen edge, walks to the middle and rings as usual.
  - Once nothing rings, waits or talks, it walks back to the edge and hides again
    (`end_peek`).
  - Showing it meanwhile ("Show pet") keeps it out.
  - Behind a mini-game, an alarm brings the pet out too.
- **Nobody answers while it's hidden:** alarms snooze themselves as usual (the pet goes
  back in between); a missed alarm, an unanswered timer or to-do reminder goes on a list.
  The pet goes back in either way.
- **Unticked kinds** count as unanswered at once (an alarm is missed straight away: nobody
  can answer its snoozes) and go on the same list.
- **"While I was hidden you missed:"** When you show the pet (or start ePet with it shown),
  it lists them in an important bubble that stays until **Done**:
  - each with its own date ("⏰ Alarm · Fri, Sep 26 8:55 PM (snoozed 3×)"), oldest first, up
    to five and "…and N more";
  - Done clears the list and the badges of the missed alarms in it (still Missed in the
    history);
  - a to-do stays open (it shows as Overdue).
  - The list is kept in the `unseen` table (v9), so it survives a restart.

## When ePet wasn't running (since 0.22.0)

Code: `take_due` in `store.rs` (mirrored in the browser mock).

- **What came due while ePet wasn't running (switched off, asleep, closed) isn't missed:**
  there was no one to ring for. It doesn't ring late either.
  - Repeating alarms wait for their next day.
  - One-off alarms and timers finish without ringing: "Didn't ring · Today 9:00 AM · ePet
    wasn't running" in Finished (`alarms.off_at`). No badge.
  - To-dos show as **Overdue** ("Overdue · Today 9:00 AM", red) until done or given a new
    time. Any to-do past its reminder time shows this way, however it was missed.
- **Except an alarm that snoozes itself:** it still rings within its snooze time (snooze
  length × automatic snoozes, 5 × 3 = 15 min by default, from Settings).
  - The snoozes that time would have used count. A 9:00 alarm rung at 9:12 has used two,
    so with no answer it is missed at about 9:17, as if ePet had been running.
  - Started after 9:15, it doesn't ring and isn't missed.
- Timers, to-dos and alarms set to "Mark as missed" (no snoozes) have no such grace.
- A scheduler tick up to a minute late (a busy machine, just woken) is still on time.
- Example: a daily 9:00 alarm, off at 8:30, on at 10:00 the next day: nothing rings,
  nothing is missed.

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

## Setting an alarm (since 0.20.0)

Code: `renderAlarms` in `src/panel/main.ts`, `src/panel/timeField.ts`, `src/panel/dayPicker.ts`,
`Repeat::Days` in `crates/desktoppet-core/src/model.rs`.

- **A new alarm starts at the current time,** so it's quick to set one for a little later.
  Opening the Alarms tab takes the time afresh. While you're setting it up, the tab
  redrawing (a timer ending, say) keeps what you've entered.
- **Time fields work like a phone's time wheel.** Hour, minute and AM/PM each change by:
  - dragging up or down (up is more, one step per 8 px);
  - the mouse wheel, or ↑/↓;
  - typing ("7", "3", "0" → 7:30; A or P for AM/PM). A click on AM/PM flips it.
  - Parts wrap without carrying (59 → 00 keeps the hour; 12-hour clocks go 12 → 1 keeping
    AM/PM).
  - This replaces the system time field, which only took the wheel.
  - It follows the system's 12/24-hour setting. The same field is used for the time slots
    in Settings → Modes (Quiet hours before 0.37.0).
- **Repeat:** Once, Every day, Weekdays, Weekends (since 0.21.0) or Custom days.
  - **The day picker (M T W T F S S) shows only for Weekdays, Weekends and Custom days.**
    Once and Every day have no days to pick. Before 0.21.0 it also showed under Once,
    where it did nothing.
  - Weekdays shows Mon–Fri ticked, Weekends Sat + Sun.
  - **Picking days by hand names them.** Mon–Fri is Weekdays, Sat + Sun is Weekends,
    anything else is Custom days, and the menu follows. All seven stay Custom days, so the
    picker doesn't vanish under the mouse; the saved alarm says "Every day".
  - Choosing Custom days from the menu starts from the days shown (to tweak Weekdays), or
    from today's weekday after Once or Every day.
  - Add is disabled while no day is picked.
  - Weekends and custom days are saved as chosen days (`repeatFor`). Every day and
    Weekdays keep their own kinds.
  - An alarm on chosen days is `repeat = 'days'` with the days in `alarms.repeat_days`
    (v8 migration; bits, Sunday = bit 0).
  - Its first ring is the first chosen day at or after the time set. Skip once, snoozes and
    new cycles all go through `next_occurrence`.
  - Rows and the Skip-once dialog name the days: "Mon, Wed, Fri", "Weekends"…

## Editing an alarm (since 0.23.0)

Code: `renderAlarms` and `draftFor` in `src/panel/main.ts` / `src/panel/alarmText.ts`,
`Store::update_alarm` in `crates/desktoppet-core/src/store.rs`.

- **✎ sits left of ✕ on each alarm,** and like ✕ shows only while the mouse is over the row.
  Clicking the row itself doesn't edit: both actions are buttons. Timers and finished
  alarms have no ✎.
- **✎ fills the New alarm form** with the alarm's time, repeat, days and label (empty for
  an unnamed alarm). The same thing happens for custom timers: ✎ fills the input above.
  - The heading becomes "Edit alarm · Gym" with **Cancel** on its right, and Add becomes
    **Save**.
  - The row being edited has an orange border.
  - Cancel, or the alarm being deleted while it's being edited, brings back a new alarm.
- **Save sets the alarm again** from the form (the same rules as adding one: a time that
  has passed today means tomorrow, a repeating alarm's first ring is its first day at or
  after that). It stays the same alarm in the list, not a new one.
  - **It switches on.** You edit an alarm to have it ring, so an alarm that was off is on
    after Save. We don't ask first.
  - A snooze cycle, a skipped ring ("⏭ Skips …") and "Didn't ring" belong to the old time,
    so they're cleared.

## To-dos: days, times and repeats (since 0.24.0)

Code: `renderTodos` in `src/panel/main.ts`, `src/panel/dateField.ts`, `src/features/todo/quickAdd.ts`,
`src/features/todo/repeat.ts`; `add_todo`/`update_todo`/`tick_repeating`/`take_due` in
`crates/desktoppet-core/src/store.rs` (v10 migration), `next_todo` in `schedule.rs`.

- **The form:** the quick-add box, and under it a row with 📅 the day, the time and 🔁 repeat.
  - Typing fills the row ("bins every tue", "call mom tomorrow 3pm", "pay bills monthly
    1st"), until the row is changed by hand. After that, typing leaves it alone. Words it
    understood are left out of the title.
  - No day: a dashed "+ Date" (today when clicked). Repeat is greyed out, because a repeat
    counts from a day.
  - A day without a time: a dashed "+ Time" (the next whole hour when clicked). ✕ inside a
    field takes it off again.
  - The hint says what will be saved: "📅 Tue, 6 Oct — “bins” · 🔁 every week · reminds at
    9:00 AM that day", or "⏰ Today 3:00 PM — “call mom”".
- **The date field works like the time field:** drag a part up or down, scroll, ↑/↓, or type.
  - The grey weekday follows the date.
  - Parts are in the system's order (7 Oct 2026 in Australia, Oct 7, 2026 in the US).
  - Parts wrap without carrying, and a day past the month's end becomes its last day. We
    don't use the system date picker because it can't be dragged or scrolled.
- **To-dos are often about a day, not a time** (unlike alarms):
  - A to-do without a time is on its day (`all_day`, `due_at` = local midnight).
  - It reminds at **Settings → To-do reminders → "To-dos without a time remind you at"**
    (9:00 AM by default). If ePet starts later that day, it reminds then.
  - It is **Overdue only from the next day.** One with a time is overdue once its time has
    passed.
  - The next day, ePet doesn't remind you of yesterday's; the row just says
    "Overdue · Yesterday".
  - Several come due at the same moment, so the pet tells them in **one bubble**
    ("📅 Today: • water plants • take out bins") with Open To-dos and Later. A single one
    gets the usual ✓ Done / Later.
  - **Later** on a day's to-do reminds again in 10 minutes and keeps its day
    (`remind_at`). On a to-do with a time it moves the time, as before.
- **Repeat:** Daily, Weekly, Fortnightly, Monthly, Quarterly, Yearly.
  - **Counted from the first day** (`anchor_at`), so fortnightly stays on its weeks. Monthly
    on the 31st is the 30th in a 30-day month and the 31st again after. Feb 29 is Feb 28
    in other years.
  - **Ticking one off** puts this time in Done as its own entry ("Done · Today 7:12 PM").
    The to-do stays open on its **next day after both its own day and today**:
    - ticked late, missed times don't pile up;
    - ticked early, it moves to the time after the one you did.
  - **Not ticked:** it stays where it is and turns Overdue. It doesn't move on by itself,
    because the thing still needs doing (an alarm is just missed).
  - ✕ deletes the whole repeating to-do. To skip one time, tick it.
  - Unticking the logged entry in Done makes it an ordinary open to-do.
- **Editing (✎):** like alarms (0.23.0).
  - ✎ shows on hover on open to-dos and fills the form. The heading becomes
    "Edit to-do · …" with Cancel on its right, Add becomes Save, and the row is outlined.
  - When editing, the text box is just the title and isn't parsed.
  - Only what changed is saved. A new day restarts a repeating to-do's count from it.
- **Sections (since 0.25.0):**
  - **Today (n):** overdue first (red), then today's with a time, today's without one, and
    those with no day (no day means any time, so they count as today's).
  - **Upcoming (n) · next Tue, 6 Oct:** from tomorrow on, soonest first. It's folded by
    default, and the panel remembers whether you opened it (per computer). A to-do moves to
    Today on its day by itself.
  - **Done (n):** as before. "Nothing for today. Your pet approves." when Today is empty.
- **Unticking undoes a tick (since 0.25.0):** a ticked-off time of a repeating to-do
  remembers which to-do it was (`repeat_of`, v11 migration). Unticking it in Done removes
  the entry and puts the to-do back on that day.
  - If that day has already come, it isn't reminded a second time.
  - If the to-do was deleted meanwhile, the entry just becomes an ordinary open to-do.

## Anniversaries (since 0.26.0)

Code: `renderAnniversaries` in `src/panel/main.ts`, `src/features/anniversary/templates.ts`,
`src/celebrate/` (the effects), `onCelebrate` in `src/pet/PetHost.ts`;
`tick_anniversaries`/`celebrations_due` in `crates/desktoppet-core/src/store.rs` (v12),
`celebrate` in `src-tauri/src/scheduler.rs`, `open_celebration` in `app_windows.rs`.

- **Where:** To-dos has two sub-pages, [To-dos] (where it opens) and
  [🎂 Anniversaries · n]. The count is how many fall within a week.
- **The form:**
  - **Type** (template): Birthday, Wedding anniversary, Dating anniversary, Pet's
    birthday, Work anniversary, Home anniversary, Remembrance, Custom. It fills in the
    icon, the reminders and the day's effect. Anything changed by hand stays when the type
    changes.
  - **Icon:** the button opens a grid of 20 emoji.
  - **Name.**
  - **Date:** day and month only, in the date field (drag, scroll, type). Feb 29 can be
    picked; in other years it's Feb 28.
  - **How the day is kept (since 0.39.0):** the select beside Date: **Date** (as above),
    **Lunar date** or **Day of the week**. "Next: Fri, Sep 25, 2026 (in 12 days)" under it
    says when the day as set comes next.
    - **Lunar date:** the lunar month (1st–12th), day (1–30) and **Leap**. Code:
      `src/features/anniversary/lunar.ts` and `crates/desktoppet-core/src/lunar.rs` (the
      same table, 1900–2099; both tested against `crates/desktoppet-core/tests/lunar-vectors.json`,
      from the Hong Kong Observatory's tables). A leap-month date falls in the leap month in
      years that have it, else in the regular month; a 30th falls on the 29th in a 29-day
      month (so lunar 12/30 is always New Year's Eve). Sources differ by a day on a few
      months after 2050 (2057, 2089, 2097); ePet follows the Hong Kong Observatory.
    - **Day of the week:** the 1st–4th or Last weekday of a month ("2nd Sunday of May").
    - The list says how ("Lunar 8/15 · Fri, Sep 25 · in 12 days", "2nd Sunday of May ·
      Sun, May 9"); reminders, the day's celebration and the years count work as for a
      date. The years count is by the Gregorian year.
  - **Holiday (since 0.39.0):** a type with a list to pick from: Lunar New Year, Lantern
    Festival, Dragon Boat Festival, Qixi, Mid-Autumn Festival, Double Ninth Festival, Lunar
    New Year's Eve (lunar), Mother's Day, Father's Day, Father's Day (Australia, NZ),
    Thanksgiving (US), Thanksgiving (Canada) (days of the week). Picking one fills in its
    name, icon, day, music and suggested reminders ("1 week before: Buy mooncakes"), all
    still editable; a holiday has no Since. On the day: "🥮 Happy Mid-Autumn Festival!" and
    fireworks. Qingming (a solar term) isn't offered.
  - **Since:** the year it began, optional, for "36th" / "7 years".
  - **Remind before:** up to 3 rows of lead (1 day, 2 days, 3 days, 1 week, 2 weeks,
    1 month) and label.
  - **The day's effect:** "Fireworks on the day 🎆" (on for happy days), or for a
    remembrance "Candle and flowers on the day 🕯️" (off by default, since some find it
    unlucky, but the day is still remembered).
  - **Music (since 0.28.0):** Birthday and Pet's birthday always play "Happy Birthday"
    (shown, not a choice). Wedding anniversary chooses between Pachelbel's Canon (the
    default), Mendelssohn's Wedding March and Wagner's Bridal Chorus (since 0.29.0; the
    Canon only before). Other happy days choose from all the happy pieces (default: the
    music-box waltz); a remembrance chooses from the mourning ones (default: Remembrance,
    an original Chinese-style piece). Changing the type goes back to the new type's
    default when the chosen piece isn't one of its choices.
  - While Settings turns them off for every anniversary, the form says so beside them:
    "⚠ Off for all anniversaries · Turn on" (on-screen celebrations) and "⚠ Music is off
    for all anniversaries · Turn on"; Turn on switches the setting on there and then
    (since 0.36.0; before, "· off in Settings").
- **The list:** soonest first: "Sat, 25 Oct · in 3 days · 36th" (orange within a week,
  "Today 🎉" on the day), and the reminders. ✎ (on hover) edits it like alarms and to-dos.
  ✕ deletes it, but the to-dos it already made stay.
- **Reminders become to-dos on their day:** a day's to-do "🎂 Mum - Order a cake", reminded
  at the to-dos-without-a-time time. Each is made once a year.
  - If ePet wasn't running that day, it's made at the next start up to the anniversary
    (it shows as overdue).
  - Reminder days already past when the anniversary was added or changed aren't made.
- **On the day:** the first time you're at the computer (the cursor moves), once a day.
  - The pet says the day's words for as long as the celebration lasts:
    - "🎉 Happy 36th birthday, Mum!"
    - "🥂 Happy 10th wedding anniversary!"
    - "🕯️ Remembering 外婆 today." / "7 years"
    - …
  - If its effect is on (and the setting), the app plays it in a transparent,
    click-through window over the pet's monitor:
    - **Fireworks**, with the anniversary's icon and its template's icons falling
      (🎂🎁, 💍❤️🥂…);
      - **Weddings and dating anniversaries (since 0.30.0):** every third firework bursts
        as two hearts side by side, red with pink or red with gold (either side).
      - **Birthdays and pets' birthdays (since 0.30.0):** drawn balloons in festive
        colours (red, gold, pink, orange, purple, lime) rise from the bottom, swaying on
        their strings, about one a second. Some are pets' heads (cat, dog or bear, with a
        face): about 30% on a birthday, 60% on a pet's birthday. A 🎈 icon doesn't fall as
        well.
    - **for a remembrance:** the screen dims, and a white candle flickers between two small
      bouquets of three white chrysanthemums **at the bottom middle of the pet's screen**
      (since 0.32.0; beside the pet before, which on a portrait screen could run off the
      edge). The candle is about 12% of the screen's shorter side, and the whole scene at
      most half its width (`candleLayout`). The pet walks calmly to the nearer side (the
      other if there's no room), far enough that its bubble clears the flowers, and sits
      facing the candle until it's over (`walkTo`, then `vigil`); then it roams again
      from there. Since 0.34.0, whatever interrupts it on the way or while it sits (the
      mouse resting on it, petting, a hop, a climb, being carried, an alarm) only pauses
      it: afterwards it goes back and sits again until the time is up (`Pet.next`), it
      walks for as long as that takes, and it faces the candle from wherever it sits.
      Without the effect it just sits where it is.
  - **Settings → To-do reminders → "Celebrate anniversaries on screen for [15] s"**
    (10–60 s). Off: no effect, the pet just says it.
  - **Music (since 0.28.0):** "Play music with it" (off by default) and its volume, under
    the line above. When on, the anniversary's piece plays in the pet's window for the
    celebration's length (looping; every piece is 30 or 60 s) and fades out over its last
    2 s. It plays even if the effect is off. An alarm or reminder ringing over it stops
    it.
    - The pieces are synthesized (`src/celebrate/music.ts`), no audio files. Happy:
      Happy Birthday, Canon in D, Wedding March (Mendelssohn: the trumpet fanfare and the
      first strain), Bridal Chorus (Wagner: the first strain, "Here comes the bride"), Ode to Joy, Jasmine Flower (茉莉花), Festive (original,
      Chinese style), Music-box waltz (original). Mourning: Remembrance (original, Chinese
      style), Chopin's funeral march, Taps, Reflection (original, piano). The melodies
      are public domain or written for ePet. 《哀乐》 isn't used: it's under copyright
      until 2065.
    - Every piece is levelled by its average loudness, and a limiter stops any clipping.
  - **Hidden pet:** it comes out for it if "When hidden, it comes out for → Anniversaries"
    is ticked (the default). Otherwise the celebration waits until the pet is shown that
    day.
  - **Several on the same day (since 0.32.0)** play one after another, each in full
    (words, effect, music), with a 2 s pause between: remembrances first, then the happy
    ones (by when they were added). Before, they all started at once and only the last
    was seen. The pet asks for each effect window when its turn comes
    (`show_celebration`).
  - An alarm ringing at the time goes first.
  - The effect window is above other apps but below the pet, so the pet and its words stay
    clear. In a remembrance the pet sits by the candle instead of cheering.
- **▶ Preview (since 0.27.0):** plays the day's celebration now, so it can be seen without
  waiting for the day.
  - The form's "▶ Preview" (next to Add) uses the form as it stands, saved or not; with no
    name yet, it borrows the template's.
  - Each row's ▶ (on hover, before ✎) previews a saved anniversary.
  - It's exactly what the day does: the words, the years, the effect or none (the
    anniversary's switch and the setting), the music or none (the setting), and the
    length.
  - It marks nothing: the real day still celebrates, and no reminder to-dos are made.
  - A hidden pet comes out for it.
  - **Stop (since 0.36.0):** while it plays, its ▶ turns into "■ Stop" (a row's into ■);
    Stop ends it at once: the words, the music, the effect window and a remembrance's
    vigil (the pet gets up and roams). It turns back by itself when the preview is over.
  - **One at a time (since 0.36.0):** a new preview replaces the one playing, so clicking
    three times plays it once; before, they queued and played one after another. A
    preview doesn't wait behind a ringing alarm or a real celebration: it doesn't play.
  - Changing the Music while the form's preview plays plays the new piece instead.
  - The effect window is shown only after it's made click-through, so it can never block
    the screen. Commands that open a window are async: opening one from a synchronous
    command deadlocks on Windows (0.27.0's preview froze ePet that way).

## Focus work hours (since 0.20.0)

Code: `run_cutoff`, `current_work_period` in `crates/desktoppet-core/src/pomodoro.rs` (mirrored
in `src/features/pomodoro/workHours.ts`), `tick_pomodoro` in `store.rs`, `workHoursSection`
in the panel.

- **Off (the default), the tomato clock runs until you stop it,** as before.
- **On (Focus → Work hours):** work days (Mon–Fri by default) and hours (09:00–17:30 by
  default). An end at or before the start is the next morning (a night shift).
  - **Since 0.37.0 the days and hours are the Work slots in Settings → Modes** (the work
    days, and the earliest Work start to the latest Work end on them). The Focus tab says
    what they are, with a link; the panel copies them into `pomodoro.workHours` whenever
    the schedule is saved, which is what the clock below reads.
  - **It starts by itself** when work starts on a work day, if it isn't running.
    - This happens once per work period. If you stop it, it stays stopped until the next
      work day. A period that begins with it already running counts as started too.
    - A computer switched on mid-morning starts it then.
  - **No new focus begins after the end of work.** A focus that ends after it skips its
    break; a break that ends after it doesn't start another focus.
  - **Every run stops at the next end of work after it began** ("cutoff"). A run started
    by hand in the evening keeps going until the next work day's end of work.
- **Off works the same way:** every day is all work, so there is no cutoff. The only
  difference is that it never starts by itself (it would start at midnight).
- The run's start is `PomodoroStatus.runStartedAt`. The cutoff is worked out when needed,
  so changing the hours applies at once.

## Focus sounds (since 0.36.0)

- **A focus starting and a break starting sound different,** so they can be told apart
  without seeing the pet (it may be hidden or on another screen). Focus → "Sound: focus
  starts" (default **Field phone**: one ring, about 1.3 s, of the chirping operations-room
  desk phone — two pairs of chirps, then a fast trill) and "Sound: break starts"
  (default **Office trill**), each with ▶ and Off; one Volume for both.
- They play whether the pet is shown or hidden ("When hidden, it comes out for → Focus
  sessions" decides only whether the pet comes out).
- Before 0.36.0 both were the same chime, under Settings → "Other sounds"; that is now
  "Other sounds (petting)". Settings from before with Other sounds off start with both
  focus sounds Off.

## Modes (since 0.37.0)

Code: `src/features/modes/modes.ts` (pure: the mode now, the schedule, presets, settings from
before), `updateMode` / `preset()` in `PetHost`, `modeItem` in `src/pet/menu.ts`,
`src/panel/modes.ts` (the Modes tab; in Settings in 0.37.0).

- **Four modes, each changing a few things** (every one can be changed in Settings → Modes →
  "What each mode changes"; Reset to defaults puts them back):
  - ✨ **Lively**: like Normal, and anniversaries play their music even when it's off.
  - 🙂 **Normal**: your settings as they are (shown, not editable, in the table).
  - 👔 **Work**: rings at half volume, alarms ring 15 s at most; the pet perks up where it
    is instead of coming to the middle; anniversaries wait; it doesn't talk on its own;
    no petting or focus sounds.
  - 🌙 **Quiet**: the pet keeps calm (sits, sleeps; what Quiet hours did) and doesn't talk
    on its own; to-dos don't ring (the bubble only); anniversaries wait; no petting or
    focus sounds. **Alarms and timers still ring**, starting at a quarter of their volume
    and rising to it over 30 seconds, and the pet doesn't run.
- **Which mode:** a mode for a while (from the menus) first, until it runs out; then the
  mode picked in the Modes tab: Auto (the default, the weekly schedule; time not in a slot
  is Normal) or one mode for good.
  - **A mode picked from a menu is for a while** (since 0.37.1): until what's underneath
    next changes (the schedule's next slot), or midnight if nothing changes; the menu says
    so ("👔 Work until 5:30 PM"). Then it's back to Auto, or the mode picked for good.
  - **Quiet for…**: 30 minutes, 1 hour, 2 hours, or until tomorrow morning (when the
    schedule's Quiet night ends tomorrow; 8:00 without one).
  - Auto in the menu ends a mode for a while at once.
- **The weekly schedule:** which days are work days (Mon–Fri by default), and a table of
  time slots for work days and one for days off, each "from – until → mode".
  - A slot that ends at or before its start runs past midnight and belongs to the day it
    starts on (Monday 22:00–07:00 is Monday night).
  - Where slots overlap, the quieter mode wins (Quiet, Work, Lively, Normal), minute by
    minute: Work until 10:01 PM and Quiet from 10:00 PM is Quiet from 10:00. The Modes tab
    says so under the slot that gives way (since 0.37.2): "Overlaps Quiet 10:00 PM–8:30 AM:
    Quiet wins 10:00 PM–10:01 PM". Only within one table. The week's bars are drawn by
    quarter hours, so a minute's overlap doesn't show there.
  - A slot past midnight says "(next day)" after its end (since 0.37.2), so 8:30 AM and
    8:30 PM can't be mixed up unnoticed.
  - **Defaults:** work days 22:00–07:00 Quiet and 09:00–17:30 Work; days off 23:00–08:00
    Quiet.
  - "Today is a day off" (menu or the Modes tab) uses the days-off table today.
  - "Days off until [date]" (the Modes tab, since 0.37.1): every day up to and including it
    uses the days-off table (a holiday). "+ Days off until…" starts it a week ahead; ✕ ends it.
  - Editing slots (since 0.37.1): a new slot starts where the last one in its table ends,
    an hour long (12:00–13:00 in an empty table); an end set to the start moves an hour
    later, with a short note, so a slot never silently covers the whole day.
- **Saving:** every change to the modes (the tab, the menus, the pet's own "introduced")
  starts from the settings as stored, not from what that window last heard, so windows
  don't undo each other (since 0.37.2).
- **Settings from before 0.37.0:** Quiet hours that were on become a Quiet slot in both
  tables; Focus work hours that were on become a Work slot on their days (and those are
  the work days). With neither on, the default schedule. The mode is Auto.
- **Where it shows:**
  - **The mode's icon before the first badge by the pet** (since 0.37.1): "👔 🍅 24:13",
    "🌙 ⏱ 4:59". No badges, no icon: with nothing to remind you of, the mode makes no
    difference you'd see. Normal shows none. Hovering the icon says which mode and why
    ("until 5:30 PM, then Auto"); clicking it opens the Modes tab. (0.37.0 had a badge of
    its own.)
  - The tray icon's tooltip: "ePet · 👔 Work until 5:30 PM" (since 0.37.1), so the mode
    shows with the pet hidden too.
  - Both menus: "Switch mode (now: 👔 Work until 5:30 PM)" above Open panel…: Auto
    (schedule), the four modes for a while, Quiet for…, Today is a day off.
  - The Modes tab (between Focus and Characters since 0.37.1): the mode now and why, Auto or
    a mode for good, the week (seven bars coloured by mode, a line at the time now), the
    work days, days off until, both tables, and what each mode changes, every row and
    mode with an ⓘ saying what it does. Settings → Pet has a line linking to it ("Quiet
    hours are now in Modes").
  - **Once, the pet says what modes are** (since 0.37.1): "New: modes! I'm in 👔 Work until
    5:30 PM. Quieter at night and at work, by a weekly schedule." [Show me] [OK] (Show me
    opens the Modes tab). Not in Quiet, not in the first half minute after start, not over
    something ringing. `modes.introduced` remembers it.
- **Anniversaries that wait** (Work, Quiet): nothing plays; a badge with the anniversary's
  own icon by the pet ("🎂 Mum"; click: celebrate now). When the mode next allows
  celebrations the pet asks once "🎉 Today: 🎂 Mum Celebrate now?" [Celebrate] [Skip].
  Kept over a restart.
  - **At 23:59, still waiting:** the pet asks once more, "Celebrate before the day ends?",
    unless it's Quiet (you're likely asleep).
  - **After midnight it's missed.** The next time you're at the computer (the cursor moves)
    and it isn't Quiet, the pet says so once: "🎂 You missed Mum yesterday." [Celebrate now]
    [OK]. Missed ones older than a week aren't brought up.
- The pet works the mode out every 30 seconds and whenever the settings or the clock
  change, so a slot starts within half a minute.
- Modes are this computer's own settings (not synced); a backup restores them with the
  rest of the settings.

## Stepping aside (since 0.38.0)

Code: `src-tauri/src/avoid.rs` (watching, every second; coming back; screen-capture
protection), `busy` in `src-tauri/src/desktop/{windows,macos}.rs` (what you're doing),
`src/features/avoid/avoid.ts` (pure: what rings meanwhile), `onAvoid` in `PetHost`,
`src/panel/avoid.ts` (Modes tab → Step aside automatically).

- **What it steps aside for** (each can be unticked in the Modes tab):
  - **Full screen**: the window in front covers the whole of the pet's screen, taskbar or
    menu bar too (a game, a video, a browser on F11). A maximized window with a title bar
    doesn't count (an auto-hiding taskbar would make every one "full screen"). On Windows a
    full-screen Direct3D game counts wherever it is. Only the pet's screen counts: a video
    full screen on the other one leaves the pet where it is.
  - **Presenting**: a PowerPoint slide show (Windows: its window, or Windows' presentation
    mode), Keynote or PowerPoint full screen (macOS).
  - **A call**: any app is using a camera or the microphone. Windows: Settings → Privacy's
    record of who uses them (an app using one has no stop time yet). macOS: the camera or the
    default microphone "running somewhere" (what the green and orange dots show).
  - The strictest counts: presenting, then a call, then full screen.
- **It goes at once and comes back about 10 s after** that's over (a video leaving full
  screen for a moment doesn't bring it out and send it off again). The window is hidden
  natively, as when you hide it, but the tray says why ("Stepped aside: in a call", and in
  the tooltip) and offers **Show pet**: it comes back and stays until that call or game is
  over (the next one sends it off again).
- **Meanwhile:**
  - **Important alarms** (the alarm form's Important tick) bring the pet out, as when it's
    hidden, and ring in full.
  - During a **game or video**, other alarms and timers ring without the pet, softly at
    first (as in Quiet); unanswered, they snooze or go on the list as usual.
  - During a **call or slide show** nothing else rings: alarms are missed at once and timers
    done, as for a hidden pet that isn't coming out for them; whatever was ringing when it
    started goes quiet.
  - To-do reminders go on the list in both cases. Focus and break sounds play during a game
    or video, not in a call. Anniversaries wait until the pet is back (and you move the
    mouse); the pet doesn't talk or wander.
- **Back:** "While you were busy you missed:" and the list (as after hiding).
- **Screen sharing:** during a call or a slide show ePet's pet and effect windows are left out
  of screen sharing, recordings and screenshots (Windows 10 2004 and later:
  `WDA_EXCLUDEFROMCAPTURE`; macOS: not shared). You still see them. "Always hide ePet from
  screenshots and recordings" keeps them out all the time. Some newer macOS capture may
  ignore it.
- **Focus sessions** don't make it step aside: the pet stays with you (it already sits
  quietly and keeps to its desk then).
- **Important alarms** also ring in full in every mode: as loud as set, no softer start, for
  their whole ring time.
- **Testing:** ePet Test's tray has 🧪 Pretend (full screen, presenting, in a call); the
  end-to-end tests pretend the same way (`pretend_busy`) and never look at the real screen.

## Games during a focus session (since 0.20.0)

Code: `gameHeld` in `src/features/pomodoro/logic.ts`, `PetHost.playGame`, `playGame` in the
panel.

- **During a focus session games ask first** (Focus → "Ask before games during a focus
  session", on by default). Breaks don't ask.
  - The menus say "Play Safe Landing (focusing)".
  - From the pet or tray menu, the pet asks: "We're focusing until 4:10 PM. Play anyway?"
    [Play anyway] [Cancel].
  - The panel's Games tab asks the same in a dialog when you press Play.
  - **Nothing opens before you answer** (since 0.20.1).
  - **With the pet hidden, the tray leaves the game out during a focus session.** There's
    no pet to ask, and a system dialog would need an extra dependency for a rare case.
    - It comes back when the focus ends or the pet is shown.
    - This is the one place the two menus differ in their shared part.
    - Before 0.20.1 the panel's Games tab opened first and asked only on Play.
  - **While an alarm or timer rings,** the pet asks once the ring is over (like a to-do
    that comes due meanwhile).

## The Focus and Settings tabs (since 0.22.1)

- **Both are laid out to show as much as possible in the panel's default size.** Settings
  are grouped in cards, and a hint is one short line under what it explains.
- **Focus fits without scrolling:** the session (phase, countdown, Start or Skip/Stop) in
  one card at the top; the last 7 days with totals ("12 sessions · 5 h 0 min"); the four
  lengths in one row; the two options; work hours (one line: the days and hours, from
  Settings → Modes since 0.37.0).
- **Settings is grouped by what it's about:**
  - Pet: size, speed, and "When hidden, it comes out for" (with its warning); Quiet hours
    before 0.37.0;
  - Modes (since 0.37.0, see "Modes");
  - Alarms & timers: ring (tone, preview, volume), Ring for / If nobody answers side by
    side, coming to the middle, the 🔔 look-ahead;
  - To-do reminders: ring, coming to the middle;
  - General: start with the computer, other sounds (petting);
  - Backup (since 0.35.0).

## Backup and restore (since 0.35.0)

Settings → Backup. A backup is one `.epetbackup` file with everything ePet keeps: alarms
(and timers), to-dos, anniversaries, this computer's settings, the pet (each character's
mood, game scores, achievements, focus history) and the user's own characters.

- **Export backup…** asks where to save it (`ePet backup 2026-10-08.epetbackup`). A
  password is optional; with one the file is encrypted, and without it the backup can't be
  opened. The two password fields must match.
- **Restore from backup…** asks for the file, then its password if it has one ("Wrong
  password." if it isn't). Before anything changes it shows where and when the backup was
  made and what it holds, and offers:
  - what to restore: alarms, to-dos and anniversaries; settings; the pet; the characters
    (each ticked; characters only if the backup has any);
  - **Merge** (default): alongside what's here. Each alarm, to-do and anniversary has an id
    of its own across computers, so nothing comes twice; where both sides changed one, the
    one changed last wins. Something deleted here since the backup comes back (restoring is
    asking for what's in it); something the backup had deleted goes, unless it changed
    here after that.
  - **Replace**: what's here goes and the backup's comes instead.
  - Timers are never restored: they belong to the computer they were set on.
  - Settings restored keep this computer's "Start with my computer".
  - A character folder already here of the same name is kept beside as `<name>.bak`.
- **Restoring** first saves a backup of this computer as it is (listed as "before a
  restore", the last 3 kept), then restores and starts ePet again.
- **Automatic backups:** a few seconds after ePet starts, once a day, a backup without a
  password in the app's data folder (`backups/`), the last 7 kept. Each is listed with
  "Restore…".

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
  - Settings → Alarms & timers → "Show alarms due within N min by the pet" turns 🔔 off and
    sets the look-ahead, 1–120 (the number is greyed out while it's off; since 0.22.1, one
    line).
  - 🔔 shows the nearest alarm's clock time (not a countdown: it may be an hour away) and
    "+n" for the others, like ⏱.
  - **Snoozed and upcoming alarms share that one badge** (since 0.19.0), in ring order,
    the way snoozed timers stay in the ⏱ list. Two badges put the times out of order
    (💤 11:33 above 🔔 11:30).
    - The icon is the nearest alarm's: `💤 11:33 AM +2` when that one is snoozed.
    - A snoozed alarm always shows, whatever the look-ahead and even with upcoming
      alarms off: its ringing cycle isn't over.
- **Hovering a badge shows what it stands for,** in the same shape for every badge (since
  0.16.0): what and when, then what a click does on the last line.

  | Badge | Info | Last line |
  |---|---|---|
  | ⏱ | every running timer: `12 min · 8:10 → 8:22 PM`; a snoozed one `1 min · 💤×1 · 9:38 → 9:45 PM` | Open the Alarms tab |
  | 🍅 / ☕ | `Focus · 8:00 → 8:25 PM` (or `Break …`) | Open the Focus tab |
  | 🔔 / 💤 | every snoozed or upcoming alarm: `Alarm 9:40 PM`, `Login CMC · 10:05 PM`, a snoozed one `Alarm 9:25 PM · 💤×1 · next 9:33 PM` | Open the Alarms tab |
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
- **At the edge of the screen** (since 0.19.1), nothing by the pet is cut off:
  - **Badges move to the pet's left** when they don't fit on screen to its right.
    - This is the same way menus and tooltips flip near a screen edge.
    - They go back right only with 40 px to spare (`BADGE_FLIP_SLACK`), so a pet walking
      along the edge doesn't make them flicker.
    - They never move while the mouse is on a badge or its info box.
  - **The heart meter takes the side the badges don't use.** If that side is off screen
    too, it goes above the pet's head (above the bubble, if one shows). The badges come
    first: they are what you act on.
  - **The speech bubble and the info box shift to stay on screen.** The bubble's tail
    keeps pointing at the pet.
  - What counts as "on screen" is the work area the pet is in (`visibleRange`). The pet
    window itself is centred on the pet and can hang off the edge.
- **The Alarms list puts the soonest ring first** (since 0.22.3), like the pet's 🔔 badge:
  a snoozed alarm by its snoozed ring; alarms switched off come last, by time of day.
  Before, it was the order they were set in.
- **Finished and done lists put the most recent first.**
- **Dates read "Today", "Yesterday", "Tomorrow", otherwise a short date**
  (`formatWhen` in `src/panel/dom.ts`). Times follow the system's 12/24-hour setting,
  without a leading zero.
- **The ring time is stored in `alarms.rang_at`** (v4 migration; since v6 it is the start
  of the ringing cycle, see above). A one-off alarm loses `next_fire` once it rings, which
  is how it counts as finished, so the time needs its own column.
