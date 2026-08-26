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

print()
if FAILURES:
    print(f"RESULT: {len(FAILURES)} failure(s): {', '.join(FAILURES)}")
    sys.exit(1)
print("RESULT: all checks passed")
