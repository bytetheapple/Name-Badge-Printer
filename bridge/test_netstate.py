"""What the print server says about its own networks.

The card this feeds exists because a server on a wired 192.168.3.x drop and a
printer on 192.168.0.x WiFi looked identical, from the app, to a broken
printer. So the parsing is worth pinning: a wrong SSID or a missing address
turns the one screen that answers "are these on the same network" back into a
screen that does not.

    ./venv/bin/python test_netstate.py
"""
import sys

import netstate

FAILURES = []


def check(label, condition, detail=""):
    if condition:
        print(f"  ok    {label}")
    else:
        FAILURES.append(label)
        print(f"  FAIL  {label}{(' — ' + detail) if detail else ''}")


# Real output from the Pi at the site, both interfaces up.
CANNED = {
    ("nmcli", "-t", "-f", "DEVICE,TYPE,STATE", "device", "status"):
        "eth0:ethernet:connected\nlo:loopback:connected (externally)\nwlan0:wifi:connected\n",
    ("nmcli", "radio", "wifi"): "enabled\n",
    ("nmcli", "-t", "-f", "ACTIVE,SSID,SIGNAL", "device", "wifi"):
        "yes:Tbe-Staff:100\nno:Tbe-Guest:72\n",
    ("nmcli", "-t", "-f", "IP4.ADDRESS", "device", "show", "eth0"):
        "IP4.ADDRESS[1]:192.168.3.113/24\n",
    ("nmcli", "-t", "-f", "IP4.ADDRESS", "device", "show", "wlan0"):
        "IP4.ADDRESS[1]:192.168.0.87/24\n",
    ("which", "nmcli"): "/usr/bin/nmcli\n",
}

netstate._run = lambda args, timeout=4.0: CANNED.get(tuple(args), "")

print("— both interfaces, which is the state that fixed the site —")
state = netstate.describe(max_age=0)
by_name = {i["name"]: i for i in state["interfaces"]}
check("reports both interfaces", set(by_name) == {"eth0", "wlan0"}, str(by_name))
check("drops loopback", "lo" not in by_name)
check("the wired address", by_name["eth0"]["ip"] == "192.168.3.113", str(by_name["eth0"]))
check("the wireless address", by_name["wlan0"]["ip"] == "192.168.0.87", str(by_name["wlan0"]))
check("names them by kind, not by device", by_name["eth0"]["kind"] == "wired"
      and by_name["wlan0"]["kind"] == "wifi", str(by_name))
check("the SSID it actually joined, not the strongest", by_name["wlan0"]["ssid"] == "Tbe-Staff",
      str(by_name["wlan0"]))
check("and the radio state", state["wifi_radio"] == "enabled", str(state))
# The SSID belongs to the wireless interface and nowhere else: a wired card
# labelled with a network name would be actively misleading.
check("no SSID on the wired interface", "ssid" not in by_name["eth0"], str(by_name["eth0"]))

print("— the radio off, which is how every server ships —")
CANNED[("nmcli", "radio", "wifi")] = "disabled\n"
CANNED[("nmcli", "-t", "-f", "DEVICE,TYPE,STATE", "device", "status")] = (
    "eth0:ethernet:connected\nwlan0:wifi:unavailable\n")
state = netstate.describe(max_age=0)
wlan = [i for i in state["interfaces"] if i["name"] == "wlan0"][0]
check("still lists the radio", wlan["kind"] == "wifi")
check("with no address", wlan["ip"] is None, str(wlan))
check("and does not claim an SSID", "ssid" not in wlan, str(wlan))
check("says the radio is off", state["wifi_radio"] == "disabled")

print("— nothing to ask: never raise, never block a heartbeat —")
netstate._run = lambda args, timeout=4.0: ""
state = netstate.describe(max_age=0)
check("still returns a shape", isinstance(state.get("interfaces"), list), str(state))

print("— the cache holds, because this shells out —")
calls = []


def counting(args, timeout=4.0):
    calls.append(args)
    return CANNED.get(tuple(args), "")


netstate._run = counting
netstate.describe(max_age=0)
first = len(calls)
netstate.describe()
check("a second look costs nothing", len(calls) == first, f"{len(calls)} vs {first}")

print()
if FAILURES:
    print(f"RESULT: {len(FAILURES)} failure(s): {', '.join(FAILURES)}")
    sys.exit(1)
print("RESULT: all checks passed")
