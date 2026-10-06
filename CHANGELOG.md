# Changelog

All notable changes to the app. Versions follow [Semantic Versioning](https://semver.org/):
before 1.0, every test build that adds or changes features bumps the minor version
(0.**x**.0) and a fixes-only build bumps the patch version (0.x.**y**).

How to release a build: add entries under **Unreleased** as you go, then run
`npm run set-version -- 0.9.0`. It moves them under the new version and updates every
version field (package.json, Cargo.toml, tauri.conf.json, lockfiles). CI fails if the
versions disagree or this file has no section for the current version.

Manual tests live in `docs/test-checklist.json` (rendered to `docs/TESTING.md` by
`npm run test-checklist`). Each item's `rev` is the version in which its expected
behaviour last changed: when a change makes earlier results meaningless, set the
affected items' `rev` to the new version so the online checklist asks for a retest.

## [Unreleased]

## [0.32.2] - 2026-10-06

### Fixed
- Copies of a character all had the same name, "Cat (copy)". They're now named after their
  folder: "Cat (copy)", "Cat (copy 2)", "Cat (copy 3)"…

### Added (development)
- Automated tests of the real app on Windows CI (WebDriver), mapped to the manual checklist:
  43 of its 146 items are now tested on every push (39 fully, 4 partly). The online
  checklist marks them 🤖 / 🤖+👀 and shows their CI results.

## [0.32.1] - 2026-10-06

### Fixed
- The pet running to the middle of the screen for a reminder now stops where it is when
  you put the mouse on it (or in its way), and rings there. Sweeping the mouse across it
  doesn't stop it.
- Resting the mouse on the pet while a to-do reminder waited for an answer replaced the
  reminder (and its ✓ Done / Later buttons) with a hover line such as "Yes? Can I help
  you?". Hover reactions now wait until it's answered.

## [0.32.0] - 2026-10-06

### Changed
- A remembrance's candle and flowers stand at the bottom middle of the pet's screen, sized
  by the screen's shorter side, so they fit on a portrait screen too. The pet walks aside,
  clear of the flowers, and sits facing the candle; afterwards it roams again from there.

### Fixed
- Two or more anniversaries on the same day all started at once, and only the last one
  was seen. Now they play one after another, remembrances first, with a short pause
  between.

## [0.31.0] - 2026-10-06

### Added
- Your own characters are usable without the source code:
  - "⧉ Make a copy" under each character on the Characters page copies it into your
    characters folder (as "cat-copy" and so on), opens it and loads it straight away.
  - The characters folder now has a README (how to make a character, what each part of
    character.json does), the JSON schema (editors check against it) and an example cat.
  - "⟳ Reload characters" applies your edits without restarting; the pet on the desktop
    redraws itself. Load errors show opened on the Characters page.

## [0.30.0] - 2026-10-06

### Added
- Wedding and dating anniversaries: every third firework bursts as two hearts side by
  side, red with pink or red with gold.
- Birthdays and pets' birthdays: drawn balloons in festive colours rise from the bottom,
  some shaped like cat, dog or bear heads (more of them on a pet's birthday). They replace
  the falling 🎈.

## [0.29.0] - 2026-10-06

### Added
- Two wedding pieces: Mendelssohn's Wedding March (the trumpet fanfare and the first
  strain) and Wagner's Bridal Chorus ("Here comes the bride"). A wedding anniversary
  can now choose between the Canon (still the default) and these two; other happy days
  can pick them too.

## [0.28.0] - 2026-10-06

### Added
- Music for anniversaries, synthesized in the app (no audio files). Settings → To-do
  reminders → "Play music with it" (off by default) and its volume. It plays with the
  celebration and its preview, for the same length, fading out at the end; an alarm
  ringing over it stops it.
  - Birthdays (a pet's too) play Happy Birthday and weddings Pachelbel's Canon. Other happy
    days choose from six pieces in the form (default: the music-box waltz), a remembrance
    from four mourning pieces (default: an original Chinese-style piece).

### Changed
- A remembrance's candle is bigger (about 12% of the screen's height), between two small
  bouquets of three white chrysanthemums.

## [0.27.1] - 2026-10-06

### Fixed
- ▶ Preview froze ePet on Windows: the screen under the pet couldn't be clicked (ePet
  included) until ePet was ended in Task Manager. The preview opened its window from a
  synchronous command, which deadlocks on Windows; it's asynchronous now. The celebration
  window is also only shown once clicks pass through it, so it can never block the screen.

## [0.27.0] - 2026-10-02

### Added
- ▶ Preview for anniversaries (in the form and on each row): plays the day's celebration now
  (words, effect, length) without marking it or making to-dos.

### Fixed
- The celebration's window no longer covers the pet and its bubble. The candle and flowers
  stand clear of the bubble, and the pet sits by them.

## [0.26.0] - 2026-10-02

### Added
- Anniversaries (To-dos → 🎂 Anniversaries): templates (birthday, wedding, dating, pet's
  birthday, work, home, remembrance, custom), a choice of icons, day and month with an
  optional "since" year, and up to 3 reminders before the day that become to-dos on their
  day.
- On the day the pet celebrates the first time you're at the computer: fireworks with the
  day's icons falling, or for a remembrance a white candle and chrysanthemums (off by
  default). Settings: on or off, 10–60 s; the hidden pet comes out for it (Anniversaries).

## [0.25.0] - 2026-10-02

### Added
- To-dos are in sections: **Today** (overdue, today's, and those without a day) and
  **Upcoming** (from tomorrow, folded by default, with the next date in its title), then
  Done.
- Unticking a repeating to-do's entry in Done undoes the tick: the to-do goes back to that
  day.

## [0.24.0] - 2026-10-02

### Added
- Repeating to-dos: Daily, Weekly, Fortnightly, Monthly, Quarterly, Yearly, counted from
  their first day. Ticking one off logs this time in Done and moves it on to its next day
  (past today, so missed times don't pile up).
- To-dos on a day without a time: they remind at a set time (Settings → To-do reminders,
  9:00 AM by default) and are overdue only from the next day. Several at once come in one
  "📅 Today:" bubble; Later keeps the day.
- The to-do form has a row for the day (a new date field you can drag, scroll or type, in
  the system's order), the time ("+ Time") and the repeat. Typing "bins every tue",
  "pay bills monthly 1st" or "call mom tomorrow 3pm" fills it in.
- To-dos can be edited (✎ on hover, like alarms).

### Changed
- "buy milk today" / "dentist fri" (a day without a time) is now a to-do on that day instead
  of one at 9:00 AM.

## [0.23.0] - 2026-10-01

### Added
- Alarms can be edited: ✎ (left of ✕, on hover) fills the alarm form with its time, repeat,
  days and label. "Edit alarm · …" has Cancel on its right; Save changes the alarm in
  place and switches it on, clearing its snooze or skipped ring.

## [0.22.3] - 2026-10-01

### Fixed
- **The Alarms list puts the soonest ring first** (a snoozed alarm by its snoozed ring),
  like the pet's badge, with alarms switched off at the end. It was in the order they
  were set.

## [0.22.2] - 2026-10-01

### Fixed
- **Fields too narrow for their text:**
  - the 🔔 look-ahead showed "12" for 120 (Windows' spin arrows took the room);
  - "Stop and mark as missed" was cut off (now "Mark as missed");
  - the repeat menu and the alarm label's placeholder ("Label") are no longer clipped.

## [0.22.1] - 2026-10-01

### Changed
- **The Focus tab fits the panel without scrolling.** The session is one card (phase,
  countdown and buttons), the chart is shorter with totals beside it, the four lengths
  share a row, and work hours are one card with a short hint.
- **The Settings tab is grouped by what it's about:** Pet (size, speed, quiet hours, what
  the hidden pet comes out for), Alarms & timers, To-do reminders, General.
  - Related controls share lines; snooze choices read "Snooze 5 min × 3".

## [0.22.0] - 2026-10-01

### Added
- **The hidden pet comes out for reminders.** It steps in from the screen edge, rings in
  the middle, and goes back once you answer.
  - Settings → Alerts → "When your pet is hidden, it comes out for": Alarms, Timers and
    To-do reminders (on), Focus sessions (off).
  - Anything unticked shows a red warning.
- **"While I was hidden you missed:"** Showing the pet lists what nobody answered while it
  was hidden, each with its date, until you press Done. It is kept across restarts.
- **Overdue to-dos** are marked in red.

### Changed
- **What came due while ePet wasn't running isn't missed, and doesn't ring late.**
  - One-off alarms and timers say "Didn't ring · ePet wasn't running".
  - An alarm that snoozes itself still rings within its snooze time (5 min × 3 by default),
    with the snoozes already used counted.

### Removed
- **System notifications** (they said "ePet / Alarm / Alarm" and did nothing), and the
  notification plugin with them.

## [0.21.0] - 2026-09-30

### Added
- **A Weekends repeat** for new alarms (Sat + Sun).

### Changed
- **The day picker only shows for Weekdays, Weekends and Custom days.**
  - Picking days by hand switches the menu: Mon–Fri is Weekdays, Sat + Sun is Weekends,
    anything else Custom days.
  - Custom days starts from the days shown, or today's weekday.

### Fixed
- **The day picker showed under Once and Every day,** where it did nothing (a style kept
  it visible).

## [0.20.1] - 2026-09-30

### Fixed
- **During a focus session, a game never opens anything before you answer "Play anyway?".**
  - With the pet hidden, the tray leaves the game out until the focus ends. Before, it
    opened the panel's Games tab and asked only on Play.
  - While something rings, the pet asks once the ring is over.

## [0.20.0] - 2026-09-30

### Added
- **Custom repeat days for alarms:** Once / Every day / Weekdays / Custom days, with
  M T W T F S S toggles (e.g. Mon, Wed, Fri). Rows name the days.
- **Focus work hours** (Focus tab, off by default): work days and hours (Mon–Fri
  09:00–17:30 by default).
  - The tomato clock starts by itself when work starts, once a day.
  - No new focus begins after work ends.
  - A run started by hand outside work keeps going until the next end of work.
- **Games ask first during a focus session** ("Play anyway?"), with a Focus option to turn
  this off. Menus say "(focusing)".

### Changed
- **Time fields are the pet's own:** drag each part up or down, scroll, use ↑/↓ or type.
  Used for new alarms, Quiet hours and work hours.
- **A new alarm starts at the current time** instead of 7:30 AM. Your changes survive the
  tab redrawing.

## [0.19.1] - 2026-09-30

### Fixed
- **Nothing by the pet is cut off at the edge of the screen.**
  - Badges move to the pet's other side when they don't fit. They move back only with
    room to spare, and never while the mouse is on them.
  - The heart meter takes the free side, or goes above the pet.
  - The speech bubble and badge info box shift to stay on screen.

## [0.19.0] - 2026-09-30

### Changed
- **Snoozed and upcoming alarms share one badge,** in ring order, like timers. The icon
  is the nearest one's (`💤 11:33 AM +2` when that is a snooze). The info box marks
  snoozed ones: `Alarm 11:25 AM · 💤×1 · next 11:33 AM`.
  - Snoozed alarms show even with "Show upcoming alarms" off.
  - Before, a separate 💤 badge could sit above an earlier 🔔 one.

## [0.18.0] - 2026-09-29

### Added
- **Skip once for repeating alarms.** Switching off an alarm that repeats now asks, like a
  phone: `Skip once · Sep 30 7:00 PM (Today)`, `Turn off repeating alarm`, or Cancel.
  - A skipped alarm stays on and shows `⏭ Skips … · Undo` until that time passes.
  - Skipping a snoozed alarm ends today's snoozes.
  - One-off alarms still switch off straight away.

## [0.17.0] - 2026-09-29

### Added
- **🔔 badge for alarms coming up soon:** the nearest alarm's time, "+n" for the others,
  and every one of them on hover. Before, an alarm had no badge until it snoozed, while
  timers always had one.
  - Settings → Alerts → "Show upcoming alarms by the pet" (on by default).
  - "Within N minutes" (1–120, 60 by default) shows only while it's on.

### Changed
- **A badge's info box can be clicked.** It stays while you move the mouse onto it, and
  clicking it does what the badge does. Its last line is a link ("Open the Alarms tab",
  "Mark as seen", "Dismiss"); before, the box vanished as soon as you moved toward it.

## [0.16.1] - 2026-09-29

### Fixed
- **A snoozed timer is marked in the ⏱ badge's info:** `1 min · 💤×1 · 9:38 → 9:45 PM`.
  Its range runs to the next ring, so it looked like a normal timer with the wrong times.
- **Badge info lines separate their parts with ` · `** (`12 min · 8:10 → 8:22 PM`,
  `Focus · 8:00 → 8:25 PM`). The spaces between them were collapsed into one.

## [0.16.0] - 2026-09-29

### Changed
- **Every badge by the pet explains itself the same way on hover:** what and when first,
  then what a click does.
  - ⏱ lists each timer as a short range: `12 min 8:10 → 8:22 PM`. It said only when it
    rings, while the panel also said when it started.
  - 🍅/☕ shows the session's range.
  - 💤 names the snoozed alarm and its next ring. Clicking it now opens the Alarms tab.
  - ⏰ Missed and ⏱ Done say what they are for.
- **The heart meter only appears with the cursor on the pet itself,** not on its badges or
  speech bubble.

## [0.15.0] - 2026-09-28

### Fixed
- **Two timers ending at almost the same time**: the first one was silently counted as
  unanswered as soon as the second rang. One Done then seemed to cancel both, and only
  one showed up in Finished. Anything that comes due while something is ringing now
  joins the same bubble ("⏱ 2 timers are up: …"), and Snooze or Done answers all of it.
  A to-do reminder that comes due meanwhile waits its turn instead of being dropped.
- **A timer you answered disappeared.** Done deleted it, so only unanswered timers stayed
  in Finished. Done now keeps it there: "Done · Today 12:42 PM".
- **A snoozed alarm no longer changes its name or time.** An alarm set for 9:40 PM is
  "Alarm 9:40 PM" everywhere, however often it was snoozed:
  - the ringing bubble;
  - the menu ("Cancel snooze: Alarm 9:40 PM (next ring 9:46 PM)");
  - the badges ("⏰ Missed 9:40 PM" rather than when it was given up on);
  - Finished;
  - the OS notification.
- **A ring after a snooze says so:** "Snoozed 2× · first rang 9:40 PM", and the last
  automatic one warns that it will be marked missed next.
- **Unnamed alarms were called "Alarm 21:40"** (24-hour text in a 12-hour UI). They are now
  "Alarm" plus the time in the system's format, and existing ones are renamed.
- **Clicking the ⏰ Missed badge turned the alarm into "Rang · 9:58 PM" in Finished.** It now
  only hides the badge; Finished keeps "Missed · Today 9:40 PM · snoozed 3×".
- **The pet's "you missed Alarm 9:40 PM" notice was replaced straight away** by a petting
  line when you clicked the pet. It now stays for its 8 seconds; petting still counts.
- **Hovering the pet cleared the "⏱ Done" badge.** It now stays for its hour, or until
  clicked.
- **Badges were cut off at the pet window's edge** ("⏰ Missed 9:59 p…"). The window is wider,
  and a badge that still doesn't fit ends in "…".
- **"Started …" showed for no timer:**
  - Timers set before 0.14.0 now work out their start time.
  - Hovering the ⏱ badge now shows the timer list in a box the pet draws itself.
    Native tooltips don't appear in the pet's window.

### Internal
- Store migration v6: `alarms.missed_seen_at`; `rang_at` is now the start of a ringing
  cycle; default labels no longer contain a time. New `acknowledge_missed` command.
- `alarmName()` and `alarmTime()` (features/alarm/ringing.ts) are the one way alarms are
  named and timed in the UI; panel text helpers moved to `panel/alarmText.ts` (tested).

## [0.14.0] - 2026-09-28

### Changed
- **Running timers show when they were started:** "Started 4:29 PM · rings at 4:41 PM".
  With several timers going, a forgotten one could be mistaken for part of an alarm
  ringing at the same time.
- **Hovering the ⏱ badge by the pet lists every running timer** and when it rings.

### Internal
- Store migration v5: `alarms.created_at`. Timers set before this version show no start
  time.
- `timerName()` is shared by the panel, menus and badges.

## [0.13.0] - 2026-09-28

### Changed
- **Finished things say when they finished.** Two "1 min timer · Done" rows could not be
  told apart before.
  - Alarms tab → Finished: "Done · Today 12:42 PM" for timers and "Rang · Today 8:40 AM"
    for one-off alarms, which show their ring time instead of ⏰.
  - To-dos → Done: "Done · Today 3:15 PM".
  - Both lists put the most recent first.
- Dates in the panel say "Yesterday" too, and times have no leading zero ("3:00 PM"),
  matching the menus and badges.

### Internal
- Store migration v4: `alarms.rang_at`. To-dos now expose `done_at` (`doneAt`).

## [0.12.0] - 2026-09-28

### Added
- **The pet responds to the mouse resting on it**
  (rules and reasons: [docs/INTERACTIONS.md](docs/INTERACTIONS.md)).
  - It stops and faces the cursor instead of running on, and reacts after 2 seconds.
  - Moving the mouse over it after that is stroking, the same as a click: at most once
    every 1.5 s, within the hourly petting cap.
  - A hungry or unhappy pet first steps a little away and says why ("My tummy's flat…",
    "Oh, *now* you remember me?"). Hovering again within 10 s counts as insisting, and it
    stays. It steps away at most once every 2 minutes.
  - A mouse left still on it for 8 s lets it carry on, so it never parks on top of what
    you are working on.
  - New speech lines for cat and rooster: `dodgeHungry`, `dodgeGrumpy`, `noticed`,
    `noticedHappy`, `release`.
- `docs/INTERACTIONS.md` records the interaction rules: hovering, menus, badges, the
  "Open panel…" tab choice and unanswered alarms.

## [0.11.0] - 2026-09-28

### Added
- **The countdown badges by the pet are clickable.** ⏱ opens the Alarms tab, 🍅 (or ☕
  during a break) opens the Focus tab.

### Changed
- "Open panel…" (pet menu and tray) opens the tab of whatever runs out first. A timer or
  snoozed alarm opens Alarms; a focus session or break opens Focus. With a missed alarm
  it opens Alarms; otherwise the panel opens as before.

## [0.10.0] - 2026-09-28

### Changed
- Menus show when things happen, not how long is left: "Stop focus session (ends 4:10 PM)",
  "Cancel timer: 5 min (rings 3:52 PM)", "Cancel snooze: Wake up (rings 7:05 AM)".
  - A native menu can't count down while it is open, and the tray menu is built ahead
    of time, so the tray's "25 min left" could be over a minute off.
  - A clock time never goes stale, so both menus are always right and always match.
  - The live countdown is still on the badges by the pet and in the panel.

### Fixed
- Panel → Alarms: the custom length box no longer touches the quick timer buttons above it.

## [0.9.0] - 2026-09-28

### Changed
- **The tray menu now matches the pet's right-click menu.** Both are built from one
  definition, so the tasks section (Add to-do… / Set alarm… / Set timer / Cancel timer /
  Cancel snooze / focus session) and the play section (Play Safe Landing / Switch
  character) are identical in wording, order and behaviour. The tray gains Add to-do…,
  Set timer, Cancel timer and Cancel snooze.
- Only two differences remain, on purpose:
  - **Top:** the pet menu has a care action; the tray has "Show pet" / "Hide pet",
    whichever applies.
  - **Bottom:** Quit is only in the tray. The pet menu keeps "Hide pet".
- "Switch character" in the tray is now a submenu, as on the pet, instead of opening
  the panel.
- The tray shows time left in whole minutes ("12 min left") and refreshes every
  30 seconds.
- "Custom / Edit…" from the tray opens the panel's Alarms tab when the pet is hidden.

### Fixed
- The tray said "Start focus session" even while a session was running.

## [0.8.1] - 2026-09-28

### Fixed
- **Windows:** changing a monitor's display scale (for example 100% → 125% or 150%)
  while the app was running made the pet disappear. Only the top of its speech bubble
  still showed, it could not be clicked, and going back to 100% or hiding and showing it
  didn't bring it back. The pet window now follows the scale every frame: its size,
  position and the pet's size all update, in both directions. This also covers moving
  the pet between monitors with different scales.

## [0.8.0] - 2026-09-27

### Added
- **Custom timers.** "Set timer" has a 45 min preset, then a separator, your custom
  lengths ("20 min (custom)") and "Custom / Edit…".
  - "Custom / Edit…" asks in the pet's speech bubble. It accepts 20, 1:30, 90s, 1h30m
    or 2.5h and shows how it reads the input as you type.
  - Up to three custom lengths are kept, most recent first. A new one replaces the
    one used longest ago.
  - The saved lengths are listed under the input. ✎ changes that one in place
    (the new length takes its slot) and ✕ removes it.
- **Panel → Alarms → Quick timer** shows the same custom lengths (dashed buttons,
  with ✎ and ✕ on hover) and has a custom-length box.
- Settings shows the app version.

## [0.7.0] - 2026-09-27

### Added
- "Set alarm…" in the pet menu and the tray. It opens the Alarms tab with the
  time field ready to type in.

## [0.6.0] - 2026-09-27

### Changed
- The Alarms tab now looks like a phone clock.
  - Alarms have on/off switches instead of checkboxes. A tick used to mean
    "will ring" here but "done" on the To-dos tab.
  - Each alarm shows its time large, with the label and the schedule
    ("Every day · Tomorrow") underneath. Switched-off alarms are greyed out
    instead of struck through.
  - Snoozed alarms show a "💤 9:05 (2/3)" chip, and delete appears on hover.
- Running timers have their own section with a live countdown and a Cancel button.
- Finished items say whether they were missed, rang, or done.

## [0.5.0] - 2026-09-27

### Added
- **If nobody answers an alarm**, it snoozes itself: 5 min, up to 3 times by
  default. After the last snooze it is marked missed, with a notification and an
  orange "⏰ Missed 9:00" badge that stays until you click it.
- **Timers that nobody answers** leave a quiet "⏱ Done 14:05" badge. It goes away
  when clicked or after an hour.
- When you come back, the pet tells you once what you missed.
- Settings → Alerts → Alarms has two new options:
  - "Ring for" (30 s–5 min).
  - "If nobody answers": auto-snooze, or stop and mark the alarm missed.

### Changed
- The ringing buttons are now "Snooze N min" and "Done". "Done" on any ring ends
  the whole snooze cycle.
- Snoozed alarms show "💤 9:05" by the pet and "Cancel snooze: …" in the menu.
- Ordinary pet chatter no longer replaces a ringing alarm's bubble.

## [0.4.1] - 2026-09-27

### Fixed
- A snoozed timer used to vanish and could not be cancelled. Rung timers now stay
  until you answer them:
  - Snooze re-arms the timer, and it shows in the Alarms tab, the badge and the menu.
  - Stop deletes it.
- The pet confirms a snooze, or explains why it failed.

## [0.4.0] - 2026-09-27

### Added
- Finished items are cleared automatically once a day, and Alarms and To-dos each
  have a "Clear" button.
- A floating "+3 ♥" appears whenever you care for the pet.

### Fixed
- Pets no longer turn grumpy on their own. Mood starts at 60, and "content" now
  covers 40–79.
- Picking the pet up and carrying it counts as play. Only a hard landing after
  you throw it costs affection.

## [0.3.0] - 2026-09-27

### Added
- **Mood.** Affection and fullness are tracked per character, and they change
  how the pet behaves.
- **Care actions** that differ per character ("Scratch the Cat's chin",
  "Scatter some corn"), picked at random.
- **The pet confirms timers**, and badges count down next to it: timers, plus a
  focus session.

### Changed
- Menu items start with a verb.
- "Tomato clock" is now "focus session".

## [0.2.0] - 2026-09-26

### Added
- **Settings → Alerts:** the pet can come to the middle of the screen, and it
  can ring. There are six ringtones, with a preview and a volume slider.

### Fixed
- **Windows:** "Add to-do…" froze the whole app. Opening windows no longer
  blocks the main thread.
- **Windows builds:** the build scripts now resolve the repo root correctly.

## [0.1.0] - 2026-09-26

### Added
- First test build (MVP):
  - **The pet:** a desktop pet that walks on screen edges and windows, and can
    be dragged and thrown.
  - **Characters:** data-driven, starting with Cat and Rooster.
  - **Tools:** to-dos, alarms, timers and a tomato clock, with a control panel
    and a tray menu.
  - **Mini-game:** Safe Landing.
  - **Builds:** Windows and macOS installers, plus a Steam depot, built by CI.
