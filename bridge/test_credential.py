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

print("— an unreadable file reads as absent, not as a crash —")
os.chmod(credential.TOKEN_FILE, 0)
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
