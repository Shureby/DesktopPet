"""Makes src/features/post/verifyIcons.ts: the icons Pet Post's Verify shows, the same as
LocalSend's (its app/lib/util/fingerprint_alphabet.dart: 260 Material Icons, in its order),
drawn from the Material Icons font, as the LocalSend app (Flutter) draws them.

  pip install fonttools
  git clone --depth 1 https://github.com/google/material-design-icons
  python3 scripts/verify-icons.py material-design-icons/font

The names (and their order) are in this script: the order is what makes our icons match
LocalSend's, so it must never change. Both are under the Apache License 2.0
(docs/THIRD_PARTY.md).
"""

import sys
from pathlib import Path

from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont

# LocalSend's iconAlphabet (https://github.com/localsend/localsend, Apache-2.0), in order.
ALPHABET = """
ac_unit accessibility agriculture alarm album anchor android apartment apple architecture
attach_file attach_money audiotrack back_hand backpack badge bakery_dining balance bathtub
battery_full bento biotech blender bluetooth bolt bookmark brush bug_report build cable cake
calculate calendar_today campaign casino cast castle celebration cell_tower chair
change_history chat checkroom church circle cloud coffee_maker colorize computer
confirmation_number content_cut conveyor_belt cookie coronavirus cottage credit_card
cruelty_free cyclone delete diamond directions_bike directions_boat directions_bus
directions_car door_front_door earbuds eco edit egg elevator email emoji_events emoji_nature
engineering explore extension face factory fastfood favorite fence festival fingerprint
fire_extinguisher fireplace fitness_center flag flashlight_on flight flutter_dash forklift
format_paint gavel grass groups handshake hardware headphones healing hearing hexagon
history_edu hive home hourglass_empty houseboat hub ice_skating icecream inventory_2 iron
kebab_dining key keyboard king_bed kitchen landscape layers light lightbulb link liquor
local_bar local_cafe local_drink local_florist local_gas_station local_laundry_service
local_mall local_pizza local_shipping local_taxi location_city lock luggage map
markunread_mailbox masks medication memory menu menu_book mic microwave military_tech
monitor_heart mood mosque motorcycle mouse movie museum newspaper nightlight notifications
oil_barrel outdoor_grill outlet palette park pentagon person pets phishing phone photo_camera
piano pie_chart place pool power precision_manufacturing print propane_tank psychology public
push_pin qr_code radar radio ramen_dining receipt recycling redeem refresh restaurant rocket
room_service route router sailing satellite_alt savings school science search settings
shelves shield shopping_basket shopping_cart shower signpost sim_card smart_toy smartphone
smoking_rooms soap solar_power speaker sports_esports sports_football sports_golf
sports_hockey sports_motorsports sports_soccer sports_tennis square stadium stairs star store
straighten stroller table_restaurant tag temple_buddhist theater_comedy theaters thermostat
thumb_up toggle_on toll tornado toys traffic train tune umbrella usb vaccines videocam
view_in_ar visibility voicemail volcano wallet warehouse warning watch water_drop waves
wb_sunny weekend whatshot wifi wind_power window wine_bar work
""".split()

# Flutter's name → the font's.
FONT_NAME = {"door_front_door": "door_front"}


def number(v: float) -> str:
    return ("%.1f" % v).rstrip("0").rstrip(".").replace("-0", "0") or "0"


def main() -> None:
    assert len(ALPHABET) == 260 and len(set(ALPHABET)) == 260
    fonts = Path(sys.argv[1])
    font = TTFont(fonts / "MaterialIcons-Regular.ttf")
    codepoints = {}
    for line in (fonts / "MaterialIcons-Regular.codepoints").read_text().splitlines():
        name, cp = line.split()
        codepoints[name] = int(cp, 16)
    cmap, glyphs = font.getBestCmap(), font.getGlyphSet()
    scale = 24 / font["head"].unitsPerEm
    rows = []
    for name in ALPHABET:
        glyph = cmap[codepoints[FONT_NAME.get(name, name)]]
        pen = SVGPathPen(glyphs, ntos=number)
        glyphs[glyph].draw(TransformPen(pen, (scale, 0, 0, -scale, 0, 24)))
        rows.append(f'  ["{name}", "{pen.getCommands()}"],')
    out = Path(__file__).resolve().parent.parent / "src/features/post/verifyIcons.ts"
    out.write_text(
        "// Made by scripts/verify-icons.py: don't edit. LocalSend's icon alphabet (its order)\n"
        "// drawn from the Material Icons font; both Apache-2.0 (docs/THIRD_PARTY.md).\n"
        "/** [name, SVG path in a 24×24 box], in LocalSend's order. */\n"
        "export const VERIFY_ICONS: readonly (readonly [string, string])[] = [\n" + "\n".join(rows) + "\n];\n"
    )
    print(f"{len(rows)} icons → {out}")


main()
