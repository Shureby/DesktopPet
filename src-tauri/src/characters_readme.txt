YOUR OWN CHARACTERS
===================

Every folder in here with a character.json in it is a character. Pick it in the
panel's Characters page like the built-in ones. Characters are data only (a JSON
file plus images): they never run code.

The quickest way to start
-------------------------

1. In the panel, open Characters and click "Make a copy" under a character.
   A folder like "cat-copy" appears here with its character.json, and this
   folder opens.
2. Edit cat-copy/character.json in any text editor (Notepad works; VS Code
   or another editor that reads "$schema" also checks it as you type).
3. In the panel, click "Reload characters". Your changes show straight away.
   If something is wrong, the Characters page lists what and where.

Or start from the example: copy the "example-cat" folder, rename
character.json.example to character.json, and change "id" to a new name.

Rules
-----

- "id": lowercase letters, digits and dashes (e.g. "ginger-cat"). Each
  character needs its own id; a second one with the same id is ignored.
- character.json must be under 2 MB.
- Images (PNG or WebP) go in the same folder as character.json.

What's in character.json
------------------------

displayName, description
    The name and the line shown in the panel.

sprite
    The look. Two kinds:

    "pixels": pixel art written as text. "palette" maps a letter to a colour,
    and each frame is a list of rows; "." is transparent. Every frame must be
    the same size. Change the palette colours for a quick new look (e.g. a
    grey cat: change "o" and "d").

        "palette": { "k": "#2b2118", "o": "#f0a04b" },
        "frames": { "stand": ["..kk..", ".koook", ...] }

    "sheet": a PNG/WebP sprite sheet in a grid.

        "sprite": {
          "type": "sheet",
          "src": "sheet.png",
          "frameWidth": 32, "frameHeight": 32,
          "scale": 2,
          "facing": "right",
          "frames": { "stand": [0, 0], "walk1": [1, 0], "walk2": [2, 0] }
        }

    Each frame is [column, row] in the grid. Draw the character facing
    "facing" (it's mirrored for the other way), feet on the bottom row.

stats
    walkSpeed, runSpeed, jumpPower (pixels per second), weight (1 is
    average; higher falls faster), climbSpeed.

animations
    Name -> { "frames": [...], "fps": 8, "loop": true, "next": "idle" }.
    Every character needs: idle, walk, run, jump, fall, land, sit, sleep,
    drag, happy, alert. Abilities need more (below).

abilities
    Special moves, each { "id": ..., "params": { ... } }:
      climbWall  climbs screen edges and windows (needs a "climb" animation)
      glide      floats down slowly (needs "glide")
      pounce     leaps at the cursor (needs "crouch" and "pounce")

personality
    How often it does each idle behaviour, how sleepy and sociable it is,
    what it says ("lines": greet, petted, thrown, landed, reminder, alarm,
    focusStart, breakStart, focusEnd, bored, and more) and the right-click
    "care" actions. {title} in a line is replaced with the reminder's text.
    Leave out any line you don't want to change: it falls back to a neutral
    one.

moveset
    Its fighting style in the Stickman Fight game. Moves must stay within a
    shared power budget; the Characters page says if they don't.

Please only use art you made or may share.
