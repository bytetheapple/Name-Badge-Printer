"""Tests for the label sizes brother_ql does not ship.

DK-1234 is the media this product recommends and prints on, and the admin has
offered it as a choice all along — but brother_ql has no such label, so
selecting it laid badges out for the wrong media and then failed the job with a
KeyError. These tests cover both halves.

    ./venv/bin/python test_labels.py
"""
import os
import sys

FAILURES = []


def check(label, condition, detail=""):
    if condition:
        print(f"  ok    {label}")
    else:
        FAILURES.append(label)
        print(f"  FAIL  {label}{(' — ' + detail) if detail else ''}")


sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import labels  # noqa: E402
import badge  # noqa: E402
from brother_ql import devicedependent as dd  # noqa: E402
from brother_ql import labels as bql  # noqa: E402
from brother_ql.conversion import convert  # noqa: E402
from brother_ql.raster import BrotherQLRaster  # noqa: E402

DK = labels.DK_1234

print("— DK-1234 reaches both of brother_ql's registries —")
check("convert() can look it up", DK in dd.label_type_specs)
check("anything reading ALL_LABELS can see it",
      any(l.identifier == DK for l in bql.ALL_LABELS))
check("registering twice changes nothing",
      (labels.register(), sum(1 for l in bql.ALL_LABELS if l.identifier == DK))[1] == 1)

print("— its geometry is die-cut, not a continuous fallback —")
spec = dd.label_type_specs[DK]
check("is fixed in both dimensions", spec["dots_printable"] == (672, 944), str(spec["dots_printable"]))
check("carries the die-cut form factor",
      "DIE_CUT" in str(spec["kind"]), str(spec["kind"]))
check("keeps the 62mm-class right margin", spec["right_margin_dots"] == 12)

print("— badge.py lays out for the label, not for 62mm continuous —")
die_cut = badge._label_render_size(DK, 90)
endless = badge._label_render_size("62", 90)
check("uses the die-cut size", die_cut == (944, 672), str(die_cut))
check("is not the continuous fallback", die_cut != endless, f"{die_cut} == {endless}")
check("62mm continuous is untouched", endless == (1063, 696), str(endless))
check("an unknown label still falls back rather than raising",
      badge._label_render_size("no-such-label", 90) == (1063, 696))

print("— a badge for it converts to raster —")
img = badge.render_badge("Ada", "Lovelace", {}, DK)
check("renders at the printable size", img.size == (944, 672), str(img.size))
try:
    data = convert(
        qlr=BrotherQLRaster("QL-820NWB"), images=[img.rotate(90, expand=True)],
        label=DK, rotate="0", threshold=70.0, dither=False, compress=False,
        red=False, dpi_600=False, hq=True, cut=True,
    )
    check("convert() accepts it", len(data) > 1000, f"{len(data)} bytes")
except Exception as e:  # noqa: BLE001
    check("convert() accepts it", False, f"{type(e).__name__}: {e}")

print("— the option the admin offers is the identifier used here —")
ui = (open(os.path.join(os.path.dirname(__file__), "..", "app", "src", "routes",
                        "admin", "PrinterConfig.tsx")).read())
check("the admin's DK-1234 option matches this identifier", f'value="{DK}"' in ui)

print()
if FAILURES:
    print(f"RESULT: {len(FAILURES)} failure(s): {', '.join(FAILURES)}")
    sys.exit(1)
print("RESULT: all checks passed")
