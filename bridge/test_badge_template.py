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


def _band_darkness(img):
    """Fraction of dark pixels across the top 10% of the badge."""
    band = img.convert("L").crop((0, 0, img.width, max(1, img.height // 10)))
    px = list(band.getdata())
    return sum(1 for v in px if v < 128) / len(px)


member = badge_mod.render_badge("Miriam", "Rosenbaum", TPL, "62")
visitor = badge_mod.render_badge("Miriam", "Rosenbaum", TPL, "62", visitor=True)

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

print()
if FAILURES:
    print(f"RESULT: {len(FAILURES)} failure(s): {', '.join(FAILURES)}")
    sys.exit(1)
print("RESULT: all checks passed")
