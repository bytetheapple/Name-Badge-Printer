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

print("— nmcli that reports an absent address as -- —")
CANNED[("nmcli", "-t", "-f", "DEVICE,TYPE,STATE", "device", "status")] = "eth0:ethernet:connected\n"
CANNED[("nmcli", "-t", "-f", "IP4.ADDRESS", "device", "show", "eth0")] = "IP4.ADDRESS:--\n"
netstate._run = lambda args, timeout=4.0: CANNED.get(tuple(args), "")
state = netstate.describe(max_age=0)
# "--" is not an address, and a card showing it looks like a value rather than
# an absence -- which is how somebody concludes the wired port is configured.
check("does not pass '--' off as an address", state["interfaces"][0]["ip"] is None,
      str(state["interfaces"][0]))
CANNED[("nmcli", "-t", "-f", "IP4.ADDRESS", "device", "show", "eth0")] = \
    "IP4.ADDRESS[1]:192.168.3.113/24\n"

print("— a Pi with no NetworkManager still names its wired port —")
# Raspberry Pi OS before Bookworm has no nmcli. Falling all the way back to a
# single nameless "default" card would hide the wired/wireless split that this
# whole card exists to show.
IP_OUT = ("1: eth0    inet 192.168.3.113/24 brd 192.168.3.255 scope global dynamic eth0\\"
          "       valid_lft 6000sec preferred_lft 6000sec\n")
netstate._run = lambda args, timeout=4.0: IP_OUT if args[:2] == ["ip", "-o"] else ""
netstate._kind_of = lambda d: "wired" if d.startswith("e") else "wifi"
_listdir, _isdir = netstate.os.listdir, netstate.os.path.isdir
try:
    netstate.os.listdir = lambda p: ["lo", "eth0", "wlan0"]
    netstate.os.path.isdir = lambda p: p == "/sys/class/net"
    state = netstate.describe(max_age=0)
    names = {i["name"]: i for i in state["interfaces"]}
    check("finds both devices without nmcli", set(names) == {"eth0", "wlan0"}, str(names))
    check("reads the wired address", names["eth0"]["ip"] == "192.168.3.113", str(names["eth0"]))
    check("calls it wired", names["eth0"]["kind"] == "wired", str(names["eth0"]))
    check("and shows the radio as having no address",
          names["wlan0"]["ip"] is None, str(names["wlan0"]))
finally:
    netstate.os.listdir, netstate.os.path.isdir = _listdir, _isdir


print("— the networks it can see, for a list instead of a spelling test —")
# Real output from the site: the same network on many access points, a hidden
# one with no name, and an open guest network.
netstate._scan_cache = None
CANNED[("nmcli", "radio", "wifi")] = "enabled\n"
CANNED[("nmcli", "-t", "-f", "DEVICE,TYPE,STATE", "device", "status")] = (
    "eth0:ethernet:connected\nwlan0:wifi:connected\n")
CANNED[("nmcli", "-t", "-f", "SSID,SIGNAL,SECURITY", "device", "wifi", "list", "--rescan", "auto")] = (
    "Tbe-Staff:100:WPA2\n"
    "Tbe-Guest:72:\n"
    "Tbe-Staff:82:WPA2\n"
    ":64:WPA2\n"
    "Tbe-Staff:60:WPA2\n"
)
netstate._run = lambda args, timeout=4.0: CANNED.get(tuple(args), "")
state = netstate.describe(max_age=0)
names = [n["ssid"] for n in state["networks"]]
check("one row per name", names == ["Tbe-Staff", "Tbe-Guest"], str(names))
check("strongest first", state["networks"][0]["signal"] == 100, str(state["networks"]))
check("and the strongest of the duplicates is the one kept",
      state["networks"][0]["ssid"] == "Tbe-Staff")
check("a hidden network offers nothing to pick", "" not in names, str(names))
check("says which ones need a passphrase",
      state["networks"][0]["secure"] is True and state["networks"][1]["secure"] is False,
      str(state["networks"]))

print("— a radio that is off is not scanned —")
netstate._scan_cache = None
CANNED[("nmcli", "radio", "wifi")] = "disabled\n"
asked = []
_canned_run = netstate._run
netstate._run = lambda args, timeout=4.0: (asked.append(args), _canned_run(args, timeout))[1]
state = netstate.describe(max_age=0)
check("nothing to offer", state["networks"] == [], str(state["networks"]))
# A scan on a blocked radio returns nothing after a wait. Not asking is the
# point, not the empty answer.
check("and the scan was not attempted",
      not any("list" in a for a in asked), str(asked))
netstate._run = _canned_run


print("— a server not yet on WiFi refreshes its scan sooner —")
# The setup moment: somebody is at the console waiting to pick a network, and
# five minutes is a long time to stand there.
netstate._scan_cache = None
CANNED[("nmcli", "radio", "wifi")] = "enabled\n"
asked_ttl = []
_real_visible = netstate.visible_networks
netstate.visible_networks = lambda max_age=netstate._SCAN_TTL: (asked_ttl.append(max_age), [])[1]
try:
    CANNED[("nmcli", "-t", "-f", "DEVICE,TYPE,STATE", "device", "status")] = (
        "eth0:ethernet:connected\nwlan0:wifi:disconnected\n")
    netstate.describe(max_age=0)
    check("waits less while unjoined", asked_ttl[-1] == netstate._SCAN_SETUP_TTL, str(asked_ttl))

    CANNED[("nmcli", "-t", "-f", "DEVICE,TYPE,STATE", "device", "status")] = (
        "eth0:ethernet:connected\nwlan0:wifi:connected\n")
    CANNED[("nmcli", "-t", "-f", "IP4.ADDRESS", "device", "show", "wlan0")] = (
        "IP4.ADDRESS[1]:192.168.0.87/24\n")
    netstate.describe(max_age=0)
    check("and settles once it is on a network", asked_ttl[-1] == netstate._SCAN_TTL, str(asked_ttl))
finally:
    netstate.visible_networks = _real_visible


print()
if FAILURES:
    print(f"RESULT: {len(FAILURES)} failure(s): {', '.join(FAILURES)}")
    sys.exit(1)
print("RESULT: all checks passed")
