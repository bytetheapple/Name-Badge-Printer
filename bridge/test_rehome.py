"""Offline tests for the background address-recovery worker.

The rehomer sweeps for a printer that moved across a subnet, where mDNS cannot
see it. The behaviour that matters is its restraint as much as its success: it
must not turn a printer switched off for the night into a continuous scan, must
never sweep two printers at once, and must hand a find back exactly once. These
drive it with an injected search and a hand-turned clock, so there is no network
and no waiting.

    ./venv/bin/python test_rehome.py
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
import rehome  # noqa: E402


class Clock:
    """A monotonic clock the test turns by hand."""

    def __init__(self):
        self.t = 0.0

    def __call__(self):
        return self.t

    def advance(self, dt):
        self.t += dt
        return self.t


def make(search):
    """A rehomer wired to `search` and a hand-turned clock, worker not started."""
    clock = Clock()
    r = rehome.Rehomer(search=search, clock=clock)
    return r, clock


P = {"id": "p1", "mac": "44:f7:9f:bc:ab:e8", "serial": "B6G868653",
     "subnet": "192.168.1", "printer_ip": "192.168.1.46"}


print("— a reachable printer is never swept —")
calls = []
r, clock = make(lambda *a: calls.append(a) or None)
r.update(P, reachable=True)
clock.advance(10_000)
r._run_once()
check("nothing is scheduled for a healthy printer", calls == [], str(calls))

print("— an unreachable printer is swept, but only after a grace —")
found_at = {"ip": None}
calls = []
r, clock = make(lambda mac, serial, subnet, ip, attempts: calls.append((mac, ip)) or found_at["ip"])
r.update(P, reachable=False)
clock.advance(5)
r._run_once()
check("not swept during the first seconds (a reboot is not chased)", calls == [], str(calls))
clock.advance(30)  # now 35s in, past the 30s grace
r._run_once()
check("swept once the grace has passed", len(calls) == 1, str(calls))
check("searched by the identity it was given", calls[0][0] == P["mac"])
check("nothing to take while the sweep found nothing", r.take("p1") is None)

print("— a find is handed back once, then adopted —")
found_at["ip"] = "192.168.0.60"          # the printer answers on another subnet now
clock.advance(rehome._FLOOR)             # well past the next backoff step
r._run_once()
check("the new address is offered to the heartbeat", r.take("p1") == "192.168.0.60")
check("and only once — a second take is empty", r.take("p1") is None)

print("— the sweep backs off, and does not abandon —")
times = []
r, clock = make(lambda *a: None)         # every sweep misses
r.update(P, reachable=False)
# Jump the clock to each job's own next-due time, so the gaps we measure are
# the backoff schedule itself, not whatever step the test chose.
for _ in range(8):
    clock.t = r._jobs["p1"].next_at
    r._run_once()
    times.append(clock.t)
gaps = [round(b - a) for a, b in zip(times, times[1:])]
check("sweeps get further apart, then settle at the floor",
      gaps[0] < gaps[-1] and gaps[-1] == int(rehome._FLOOR), str(gaps))
check("it keeps trying rather than giving up", len(times) == 8, str(len(times)))

print("— status() reports the schedule the console shows —")
r, clock = make(lambda mac, serial, subnet, ip, attempts: "192.168.0.60")
check("no status before a printer is known", r.status("p1") is None)
r.update(P, reachable=False)
st = r.status("p1")
check("a scheduled printer has a since and a next", st and st["since"] == 0 and st["next_at"] == 30, str(st))
check("but no last search until one has run", st and st["last_at"] is None, str(st))
clock.advance(30)
r._run_once()
st = r.status("p1")
check("after a sweep, last search is recorded", st and st["last_at"] == 30, str(st))
check("and the attempt is counted", st and st["attempts"] == 1, str(st))
check("and the next search is pushed out by the backoff", st and st["next_at"] == 30 + 60, str(st))
r.update(P, reachable=True)
check("a recovered printer has no status", r.status("p1") is None)

print("— a printer with no identity to match on is left alone —")
calls = []
r, clock = make(lambda *a: calls.append(a) or None)
r.update({"id": "p2", "printer_ip": "192.168.1.9"}, reachable=False)
clock.advance(10_000)
r._run_once()
check("no MAC and no serial means no sweep", calls == [], str(calls))

print("— coming back reachable stops the sweep —")
calls = []
r, clock = make(lambda *a: calls.append(a) or None)
r.update(P, reachable=False)
r.update(P, reachable=True)              # found by mDNS, say, before the grace elapsed
clock.advance(10_000)
r._run_once()
check("a recovered printer is dropped and not swept", calls == [], str(calls))

print("— only one printer is swept per tick —")
calls = []
r, clock = make(lambda mac, serial, subnet, ip, attempts: calls.append(ip) or None)
r.update({**P, "id": "a", "printer_ip": "192.168.1.10"}, reachable=False)
r.update({**P, "id": "b", "printer_ip": "192.168.1.11"}, reachable=False)
clock.advance(60)                        # both are due
r._run_once()
check("the first tick sweeps exactly one", len(calls) == 1, str(calls))
r._run_once()
check("the second tick sweeps the other", len(calls) == 2 and set(calls) == {"192.168.1.10", "192.168.1.11"}, str(calls))

print("— a pending find is not overwritten before it is taken —")
seq = iter(["192.168.0.60", "192.168.0.99"])
r, clock = make(lambda *a: next(seq, None))
r.update(P, reachable=False)
clock.advance(60)
r._run_once()                            # finds .60
clock.advance(rehome._FLOOR + 1)
r._run_once()                            # must NOT search again while .60 is unclaimed
check("the earlier find still stands", r.take("p1") == "192.168.0.60")

print("— a search that raises does not crash the worker —")
def boom(*a):
    raise RuntimeError("network on fire")
r, clock = make(boom)
r.update(P, reachable=False)
clock.advance(60)
try:
    r._run_once()
    crashed = False
except Exception:
    crashed = True
check("the exception is swallowed, the job survives", not crashed)
check("and the failed attempt was still counted (it will retry, later)",
      r._jobs["p1"].attempts == 1)

print("— the real sweep starts near, then widens once it has missed —")
asked = []
_real_find = rehome.discover.find_printer
_real_cands = rehome.discover.candidate_subnets
try:
    rehome.discover.candidate_subnets = lambda own=None: [f"10.0.{n}" for n in range(20)]
    rehome.discover.find_printer = lambda **kw: asked.append(kw["subnet"]) or None
    r = rehome.Rehomer()
    # Early attempts stay near: the common one-subnet-over move, kept cheap.
    r._sweep("mac", "serial", "10.0.0", "10.0.0.5", 0)
    check("an early sweep is bounded to the nearest few subnets",
          len(asked) == rehome._AUTO_SUBNETS, str(asked))
    asked.clear()
    r._sweep("mac", "serial", "10.0.0", "10.0.0.5", rehome._ESCALATE_AFTER - 1)
    check("still near on the last attempt before escalating",
          len(asked) == rehome._AUTO_SUBNETS, str(asked))
    # Once the near range has missed, widen to every candidate network.
    asked.clear()
    r._sweep("mac", "serial", "10.0.0", "10.0.0.5", rehome._ESCALATE_AFTER)
    check("after enough misses it widens to every candidate subnet",
          len(asked) == 20, str(len(asked)))
finally:
    rehome.discover.find_printer = _real_find
    rehome.discover.candidate_subnets = _real_cands

print("— the rehomer widens on its own as attempts pile up —")
# The search seam sees the attempt count, so we can watch it escalate through
# _run_once without touching the network.
seen = []
r, clock = make(lambda mac, serial, subnet, ip, attempts: seen.append(attempts) or None)
r.update(P, reachable=False)
for _ in range(rehome._ESCALATE_AFTER + 1):
    clock.t = r._jobs["p1"].next_at
    r._run_once()
check("each sweep is told how many have already missed", seen == list(range(len(seen))), str(seen))
check("and it reaches the escalation threshold", max(seen) >= rehome._ESCALATE_AFTER, str(seen))


print()
if FAILURES:
    print(f"RESULT: {len(FAILURES)} failure(s): {', '.join(FAILURES)}")
    sys.exit(1)
print("RESULT: all checks passed")
