"""Offline tests for where the bridge keeps its own credential.

The stakes are asymmetric. Failing to store a replacement is recoverable — the
server has not retired the old one yet. Storing it badly is not: a half-written
file after a power cut leaves a device with no working credential and no
operator, which is exactly the situation this whole mechanism exists to avoid.

    ./venv/bin/python test_credential.py
"""
import os
import sys
import tempfile

FAILURES = []


def check(label, condition, detail=""):
    if condition:
        print(f"  ok    {label}")
    else:
        FAILURES.append(label)
        print(f"  FAIL  {label}{(' — ' + detail) if detail else ''}")


sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import credential  # noqa: E402

work = tempfile.mkdtemp()
credential.TOKEN_FILE = os.path.join(work, "token")
# Point the legacy path somewhere empty too, or a real bridge/token on the
# machine running the tests would leak into them.
legacy_dir = tempfile.mkdtemp()
credential.LEGACY_TOKEN_FILE = os.path.join(legacy_dir, "token")

print("— a device that has never rotated —")
check("no stored credential", credential.stored() == "")
check("falls back to the bootstrap", credential.current("nbk_bootstrap") == "nbk_bootstrap")

print("— storing a replacement —")
credential.store("nbk_rotated_one")
check("reads back what was written", credential.stored() == "nbk_rotated_one")
check("the stored one wins over the bootstrap",
      credential.current("nbk_bootstrap") == "nbk_rotated_one")
check("and over no bootstrap at all", credential.current("") == "nbk_rotated_one")

mode = os.stat(credential.TOKEN_FILE).st_mode & 0o777
check("not readable by anyone else", mode == 0o600, oct(mode))

credential.store("nbk_rotated_two")
check("replaces rather than appends", credential.stored() == "nbk_rotated_two")
check("leaves no temporary files behind",
      [f for f in os.listdir(work) if f.startswith(".token-")] == [],
      str(os.listdir(work)))

print("— surrounding whitespace —")
credential.store("  nbk_padded  \n")
check("is stripped on the way in", credential.stored() == "nbk_padded")

print("— what must never be stored —")
for bad in ("", "   ", "\n"):
    try:
        credential.store(bad)
        check(f"refuses {bad!r}", False, "no exception")
    except ValueError:
        check(f"refuses {bad!r}", True)
check("and the previous credential survives that", credential.stored() == "nbk_padded")

print("— a write that fails must not destroy what is there —")
# The rename is the only thing that replaces the file, and it happens last.
real_replace = os.replace
os.replace = lambda *a, **k: (_ for _ in ()).throw(OSError("disk full"))
try:
    credential.store("nbk_never_lands")
    check("raises when the write fails", False, "no exception")
except OSError:
    check("raises when the write fails", True)
finally:
    os.replace = real_replace
check("the old credential is intact", credential.stored() == "nbk_padded")
check("and no debris is left", [f for f in os.listdir(work) if f.startswith(".token-")] == [],
      str(os.listdir(work)))

print("— a device that rotated before the state directory existed —")
# Its only working credential is in the old location: the value in .env was
# retired the first time it connected. Losing track of it would take that
# device off the air until somebody re-imaged it.
open(credential.LEGACY_TOKEN_FILE, "w").write("nbk_from_the_old_place\n")
os.remove(credential.TOKEN_FILE)
check("the old location is still honoured", credential.stored() == "nbk_from_the_old_place")
check("and still beats the bootstrap token",
      credential.current("nbk_bootstrap") == "nbk_from_the_old_place")

credential.store("nbk_rotated_again")
check("the next rotation writes to the new home", credential.stored() == "nbk_rotated_again")
check("which wins over the old one",
      open(credential.LEGACY_TOKEN_FILE).read().strip() == "nbk_from_the_old_place")

print("— a state directory that does not exist yet —")
fresh = os.path.join(tempfile.mkdtemp(), "nested", "token")
credential.TOKEN_FILE = fresh
credential.store("nbk_made_the_directory")
check("is created rather than failing", credential.stored() == "nbk_made_the_directory")
credential.TOKEN_FILE = os.path.join(work, "token")

print("— an unreadable file reads as absent, not as a crash —")
os.chmod(credential.TOKEN_FILE, 0)
os.remove(credential.LEGACY_TOKEN_FILE)
unreadable = credential.stored()
os.chmod(credential.TOKEN_FILE, 0o600)
# Root can read anything, so this check only means something as a normal user.
if os.geteuid() == 0:
    print("  --    skipped: running as root, which can read it regardless")
else:
    check("falls back rather than raising", unreadable == "")

print()
if FAILURES:
    print(f"RESULT: {len(FAILURES)} failure(s): {', '.join(FAILURES)}")
    sys.exit(1)
print("RESULT: all checks passed")
