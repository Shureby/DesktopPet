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
