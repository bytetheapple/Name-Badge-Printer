"""Which header a badge prints, in every combination.

This decides whose graphic ends up on a badge, so it is worth pinning down
rather than reasoning about. The logo used to be a PNG shipped inside the
bridge — one congregation's mark, on every deployment — and the checks at the
bottom exist to stop that returning by any route.

    ./venv/bin/python test_badge_template.py
"""
import os
import sys

FAILURES = []


def check(label, condition, detail=""):
    if condition:
        print(f"  ok    {label}")
    else:
        FAILURES.append(label)
        print(f"  FAIL  {label}{(' — ' + str(detail)) if detail else ''}")


HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import bridge  # noqa: E402

CFG = {"badge_template": {"header": "ORG WIDE", "footer": "footer"},
       "logo_url": "https://storage.example/org-mark.png"}

print("— the printer's own wording wins over the organization's —")
t = bridge.badge_template_for(
    {"badge_header_mode": "text", "badge_header": "WELCOME", "badge_subtitle": "Guest"}, CFG)
check("header comes from the printer", t["header"] == "WELCOME", t["header"])
check("subtitle comes from the printer", t["subtitle"] == "Guest", t.get("subtitle"))
check("anything else is inherited", t["footer"] == "footer")

print("— which graphic, if any —")
check("text mode draws no image",
      bridge.badge_template_for({"badge_header_mode": "text"}, CFG)["header_image"] == "")
check("logo mode uses the resolved organization mark",
      bridge.badge_template_for(
          {"badge_header_mode": "logo"}, CFG, header_path="/cache/mark.img",
      )["header_image"] == "/cache/mark.img")
check("a per-job graphic overrides the printer's mode",
      bridge.badge_template_for(
          {"badge_header_mode": "text"}, CFG, header_path="/cache/job.img",
      )["header_image"] == "/cache/job.img")

print("— a graphic that could not be fetched degrades to words —")
# Not to somebody else's image: printing the wrong congregation's mark is worse
# than printing none, and both are recoverable, but only one is noticed.
for mode in ("logo", "image"):
    check(f"{mode} mode with nothing fetched prints text",
          bridge.badge_template_for({"badge_header_mode": mode}, CFG)["header_image"] == "")

print("— no organization can end up with another's mark —")
check("an org-wide template's header_image never survives",
      bridge.badge_template_for(
          {"badge_header_mode": "logo"},
          {"badge_template": {"header_image": "someone-elses.png"}},
      )["header_image"] == "")
src = open(os.path.join(HERE, "bridge.py"), encoding="utf-8").read()
check("no bundled logo constant remains", "BUNDLED_LOGO" not in src)
check("no congregation is named in the code", "shir-hadash" not in src.lower())
check("no logo ships with the bridge",
      not os.path.exists(os.path.join(HERE, "assets", "shir-hadash-logo.png")))

print("— a visitor badge is told apart from a member's —")
# The inversion is the whole feature, so it is measured rather than eyeballed:
# the top band dark on one and not the other, and the member badge untouched.
import badge as badge_mod
from PIL import Image

TPL = {"header": "WELCOME", "subtitle": "Beth Shalom"}

# The label production actually prints on. Asserted rather than assumed: the
# renderer falls back to 62 mm continuous for an unknown label, so a stale
# brother_ql would have these tests quietly measuring a geometry no printer
# ever sees. This machine did exactly that until 2026-08-31.
LABEL = "60x86"
from brother_ql.labels import ALL_LABELS

check(f"{LABEL} is a label this brother_ql knows",
      LABEL in {l.identifier for l in ALL_LABELS},
      "stale brother-ql-next; pip install -U brother-ql-next")
check("it renders at the die-cut size, not the continuous fallback",
      badge_mod._label_render_size(LABEL, 90) == (954, 672),
      str(badge_mod._label_render_size(LABEL, 90)))


def _band_darkness(img):
    """Fraction of dark pixels across the top 10% of the badge."""
    band = img.convert("L").crop((0, 0, img.width, max(1, img.height // 10)))
    px = list(band.getdata())
    return sum(1 for v in px if v < 128) / len(px)


member = badge_mod.render_badge("Miriam", "Rosenbaum", TPL, LABEL)
visitor = badge_mod.render_badge("Miriam", "Rosenbaum", TPL, LABEL, visitor=True)

check("a member's header band is mostly white", _band_darkness(member) < 0.1,
      f"{_band_darkness(member):.2f}")
check("a visitor's header band is solid", _band_darkness(visitor) > 0.9,
      f"{_band_darkness(visitor):.2f}")
check("the two badges are not the same image",
      list(member.getdata()) != list(visitor.getdata()))
check("both are the same size, so the label fits either",
      member.size == visitor.size)

# The word, knocked out of the band. Checked by looking for white pixels in the
# top-right corner, where nothing else on the badge reaches.
corner = visitor.convert("L").crop(
    (int(visitor.width * 0.78), 0, visitor.width, visitor.height // 12))
check("\"Visitor\" is printed in the corner of the band",
      any(v > 200 for v in corner.getdata()))
check("a member badge has nothing in that corner",
      all(v > 200 for v in member.convert("L").crop(
          (int(member.width * 0.78), 0, member.width, member.height // 12)).getdata()))

# A dark mark on white and the same mark on transparency must both come out
# white, or a congregation's logo vanishes into the band.
for mode, bg in (("RGBA", (0, 0, 0, 0)), ("RGB", (255, 255, 255))):
    art = Image.new(mode, (40, 20), bg)
    for x in range(5, 35):
        for y in range(5, 15):
            art.putpixel((x, y), (0, 0, 0, 255) if mode == "RGBA" else (0, 0, 0))
    mark, mask = badge_mod._white_mark(art)
    lit = sum(1 for v in mask.getdata() if v > 128)
    check(f"a {mode} logo becomes a white silhouette", 250 < lit < 350, f"{lit} px")

print("— a badge never carries another organization's name —")
# The built-in logo had this exact fault and was fixed in "the badge logo
# belongs to the organization, not to the build"; the subtitle on the next line
# was missed and kept defaulting to a congregation's name. bridge.py only sets
# `subtitle` when the printer has one, so every org that had not filled it in
# printed somebody else's name on every badge.
check("an unconfigured subtitle renders nothing at all",
      badge_mod.render_badge("Ada", "L", template={"length_mm": 90}, label="62").tobytes()
      == badge_mod.render_badge("Ada", "L", template={"length_mm": 90, "subtitle": ""},
                            label="62").tobytes())
check("and a configured one is still drawn",
      badge_mod.render_badge("Ada", "L", template={"length_mm": 90}, label="62").tobytes()
      != badge_mod.render_badge("Ada", "L", template={"length_mm": 90, "subtitle": "Temple Beth El"},
                            label="62").tobytes())

print("— a badge length nobody set does not crash the renderer —")
# Reported from the field: every job on one organization failed with "height
# and width must be > 0", which is PIL describing an image to somebody whose
# actual problem was an unfilled setting. A default badge is useful; a
# traceback in a lobby is not.
for _len in (0, -5, None):
    try:
        _w, _h = badge_mod._label_render_size('62', float(_len or 0))
        check(f"length {_len!r} still renders", _w > 0 and _h > 0, f"{_w}x{_h}")
    except Exception as _e:
        check(f"length {_len!r} still renders", False, str(_e))
check("and a real length is untouched",
      badge_mod._label_render_size('62', 90.0) == badge_mod._label_render_size('62', 0.0))

print("— a label table that reports oddly still yields a drawable canvas —")
# A continuous roll has no fixed length, so one of the two numbers in
# dots_printable is zero. Which one is not something every build of brother_ql
# agrees on, and reading the zero as the head width gave a canvas with no
# height — reported by PIL as "height and width must be > 0", which sounds
# like a bug in the image and is a fact about a label table.
import enum as _enum


class _FF(_enum.IntEnum):
    ENDLESS = 1


class _Endless:
    identifier = "fake"
    # An IntEnum member, as brother_ql actually provides — not the string it
    # happens to stringify to on one Python. Python 3.11 changed IntEnum's
    # __str__ to return the number, so testing this with a string tested the
    # one environment where the bug could not appear.
    form_factor = _FF.ENDLESS
    dots_printable = (0, 696)          # and the pair in the other order

class _Zeroes:
    identifier = "broken"
    form_factor = _FF.ENDLESS
    dots_printable = (0, 0)            # no help at all

_saved = dict(badge_mod._LABELS)
try:
    badge_mod._LABELS["fake"] = _Endless()
    badge_mod._LABELS["broken"] = _Zeroes()
    for _lab in ("fake", "broken", "62", "60x86"):
        _w, _h = badge_mod._label_render_size(_lab, 90.0)
        check(f"{_lab} gives a drawable canvas", _w > 0 and _h > 0, f"{_w}x{_h}")
    # And the one that matters: a real badge comes out rather than an exception.
    _img = badge_mod.render_badge("Ada", "L", {}, "fake")
    check("and a badge actually renders on it", _img.size[0] > 0 and _img.size[1] > 0)
finally:
    badge_mod._LABELS.clear()
    badge_mod._LABELS.update(_saved)

print("— the test print shows what a real badge looks like —")
# It used to print the date as the first name, the time as the last, its own
# header, and this project's former name as the subtitle. So it verified none
# of the organization's own settings, and because a ten-character date must
# shrink to fit, it printed the name at half the size a real one gets —
# reported from the field as "the text is so small I can't read it".
_t = {"header": "WELCOME", "subtitle": "Temple Beth El", "length_mm": 90}
_test = badge_mod.render_test_badge(_t, "62")
_real = badge_mod.render_badge("Test", "Print", _t, "62")
check("it is the organization's own badge, not a substitute",
      _test.size == _real.size)
check("no former product name survives anywhere",
      "Name Badge Printer" not in open("badge.py", encoding="utf-8").read())
# The name is the thing being judged, so it must be sized like a real one.
from PIL import ImageDraw as _D
_inner = _test.width - 2 * round(4 * badge_mod.MM)
_f_test = badge_mod._fit_line(_D.Draw(_test), "Test", _inner,
                              round(30 * badge_mod.MM), round(12 * badge_mod.MM))
_f_date = badge_mod._fit_line(_D.Draw(_test), "2026-09-04", _inner,
                              round(30 * badge_mod.MM), round(12 * badge_mod.MM))
check("and it is sized like a name, not like a date",
      _f_test.size > _f_date.size, f"{_f_test.size} vs {_f_date.size}")

print()
if FAILURES:
    print(f"RESULT: {len(FAILURES)} failure(s): {', '.join(FAILURES)}")
    sys.exit(1)
print("RESULT: all checks passed")
