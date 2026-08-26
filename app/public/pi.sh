#!/usr/bin/env bash
#
# Turn a freshly imaged Raspberry Pi into a print server.
#
#   curl -sSL https://guestbadges.com/pi.sh | sudo bash -s -- gbc_<claim code>
#
# Run once, on a Pi that has just booted on Ethernet with internet access. It
# installs the bridge, exchanges the claim code for that device's own
# credential, and starts the service. There are no printers yet and that is the
# expected end state: bridge online, nothing attached.
#
# Everything it needs comes from the claim code. Nothing sensitive is baked
# into the image, and the credential this fetches is replaced by the device
# itself the first time it polls — so even the value written here is temporary.
set -euo pipefail

REPO="https://github.com/bytetheapple/Name-Badge-Printer.git"
SUPABASE_URL="https://xesgdkwwhszdtcgcdjjw.supabase.co"
# /opt, not the login user's home. A home directory is 0750 on Pi OS, so the
# service account could not traverse into it — and opening it up would undo
# the separation this exists for. The login user owns the checkout, so git
# pull still works as them.
TARGET="/opt/name-badge-printer"
SERVICE="name-badge-bridge"
# The bridge runs as its own account, not as the person who logs in. That
# account is in no privileged group, so a fault in the bridge — or a leaked
# bridge credential — reaches something that can only run this one program.
# Support still happens as the login user, which is separately in sudo.
SVC_USER="nbkbridge"

say()  { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
fail() { printf '\n\033[31mFAILED: %s\033[0m\n' "$*" >&2; exit 1; }

CLAIM="${1:-}"
[ -n "$CLAIM" ] || fail "no claim code given. Get one from the Platform console:
    curl -sSL https://guestbadges.com/pi.sh | sudo bash -s -- gbc_xxxxxxxx"
[ "$(id -u)" -eq 0 ] || fail "run this with sudo."

RUN_AS="${SUDO_USER:-$USER}"
[ "$RUN_AS" != "root" ] || fail "run this as a normal user with sudo, not as root —
the bridge should not run as root, and its files should not be owned by it."

say "Claiming this device"
# Done before anything is installed. A bad or spent code should cost seconds,
# not a full install followed by a failure at the end.
RESPONSE=$(curl -sS --max-time 30 -X POST "$SUPABASE_URL/functions/v1/pi-claim" \
  -H "Content-Type: application/json" \
  -d "{\"claim_code\":\"$CLAIM\"}") || fail "could not reach the service. Is this Pi online?"

python3 - "$RESPONSE" <<'PY' || fail "the claim was refused — see above."
import json, sys
try:
    body = json.loads(sys.argv[1])
except Exception:
    print("  the service returned something unreadable:", sys.argv[1][:200])
    sys.exit(1)
if not body.get("ok"):
    print("  " + str(body.get("error", "unknown error")))
    sys.exit(1)
print("  claimed as " + body["serial"])
PY

SERIAL=$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["serial"])' "$RESPONSE")
TOKEN=$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["bridge_token"])' "$RESPONSE")

say "Installing system packages"
apt-get update -qq
apt-get install -y -qq git python3-venv python3-pip libopenjp2-7 >/dev/null

say "Fetching the bridge"
install -d -o "$RUN_AS" -g "$RUN_AS" -m 755 "$TARGET"
if [ -d "$TARGET/.git" ]; then
  sudo -u "$RUN_AS" git -C "$TARGET" fetch --quiet origin
  sudo -u "$RUN_AS" git -C "$TARGET" reset --quiet --hard origin/main
else
  sudo -u "$RUN_AS" git clone --quiet "$REPO" "$TARGET"
fi

say "Building the virtualenv"
sudo -u "$RUN_AS" bash -c "cd '$TARGET/bridge' && ./scripts/install.sh" >/dev/null

say "Creating the service account"
if ! id -u "$SVC_USER" >/dev/null 2>&1; then
  # System account: no login shell, no home, no password. It exists to own a
  # process and a state directory and nothing else.
  useradd --system --no-create-home --shell /usr/sbin/nologin "$SVC_USER"
fi

say "Writing the configuration"
cat > "$TARGET/bridge/.env" <<ENV
SUPABASE_URL=$SUPABASE_URL
BRIDGE_TOKEN=$TOKEN
POLL_INTERVAL_SECONDS=2
HEARTBEAT_INTERVAL_SECONDS=15
ENV
# Readable by the service account and by nobody else on the device. It is
# owned by the login user so that a later git pull or hand edit still works,
# and group-readable so systemd can load it as nbkbridge.
chown "$RUN_AS:$SVC_USER" "$TARGET/bridge/.env"
chmod 640 "$TARGET/bridge/.env"

# The repository stays owned by the login user. The service account reaches it
# as "other" — read and execute, never write. It must not be able to rewrite
# the program it is running.
chmod -R o+rX "$TARGET"

say "Installing the service"
sed -e "s|^User=.*|User=$SVC_USER|" \
    -e "s|^Group=.*|Group=$SVC_USER|" \
    -e "s|^WorkingDirectory=.*|WorkingDirectory=$TARGET/bridge|" \
    -e "s|^ExecStart=.*|ExecStart=$TARGET/bridge/venv/bin/python $TARGET/bridge/bridge.py|" \
    -e "s|^EnvironmentFile=.*|EnvironmentFile=$TARGET/bridge/.env|" \
    "$TARGET/bridge/systemd/$SERVICE.service" > "/etc/systemd/system/$SERVICE.service"
systemctl daemon-reload
systemctl enable --quiet --now "$SERVICE"

say "Checking it started"
# The bridge polls every two seconds, so a working device says so almost at
# once. Waiting is better than declaring success and leaving someone to find
# out later that it never came up.
for _ in $(seq 1 15); do
  sleep 2
  if journalctl -u "$SERVICE" --since "-2 min" 2>/dev/null | grep -q "bridge starting"; then
    if journalctl -u "$SERVICE" --since "-2 min" | grep -q "auth: bridge token"; then
      say "$SERIAL is ready"
      echo "  It has no printers yet, which is the expected state to ship in."
      echo "  Its credential renews itself; nothing here needs revisiting."
      exit 0
    fi
  fi
  systemctl is-active --quiet "$SERVICE" || fail "the service stopped. Look at:
    journalctl -u $SERVICE -n 40"
done

fail "the service is running but never reported starting. Look at:
    journalctl -u $SERVICE -n 40"
