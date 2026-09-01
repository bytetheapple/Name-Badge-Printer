#!/usr/bin/env bash
#
# Converge this print server on the version the service says it should run.
#
# Run by a systemd timer, as root, because the bridge itself deliberately
# cannot write its own code. That separation is the reason this is a separate
# script rather than something the bridge does to itself.
#
# What it will do: fetch this repository and check out one commit from it.
# What it will never do: run anything the server sends. The server names a git
# ref and nothing else — there is no command channel here, and adding one would
# turn a fleet of appliances into a fleet of remote shells.
#
# If the bridge does not come back after an update, this puts the old commit
# back and says so. A device in a locked building has to recover without
# anybody visiting it.
set -uo pipefail

REPO_DIR="/opt/name-badge-printer"
BRIDGE_DIR="$REPO_DIR/bridge"
STATE_DIR="/var/lib/name-badge-bridge"
SERVICE="name-badge-bridge"
SUPABASE_URL="https://xesgdkwwhszdtcgcdjjw.supabase.co"

log() { printf '%s update: %s\n' "$(date -Is)" "$*"; }

[ "$(id -u)" -eq 0 ] || { log "must run as root"; exit 1; }
cd "$BRIDGE_DIR" 2>/dev/null || { log "no checkout at $BRIDGE_DIR"; exit 1; }

# Git runs as the account that owns the checkout, never as root.
#
# The installer clones as the login user, so root operating on that tree is
# refused outright by git as "dubious ownership" — which it did, on every
# device, every fifteen minutes, since this script shipped. Whitelisting the
# path with safe.directory would silence the refusal and let root write objects
# into somebody else's tree, which is the thing the check exists to prevent.
#
# runuser rather than sudo: we are already root, this needs no policy lookup,
# and it does not care whether a tty exists.
OWNER=$(stat -c '%U' "$REPO_DIR")
as_owner() {
  if command -v runuser >/dev/null 2>&1; then
    runuser -u "$OWNER" -- "$@"
  else
    sudo -u "$OWNER" "$@"
  fi
}

# The live credential, which is the rotated one on disk if there is one and the
# bootstrap value in .env otherwise — the same precedence the bridge uses.
TOKEN=""
[ -r "$STATE_DIR/token" ] && TOKEN=$(tr -d '\r\n' < "$STATE_DIR/token")
if [ -z "$TOKEN" ] && [ -r "$BRIDGE_DIR/.env" ]; then
  TOKEN=$(grep -E '^BRIDGE_TOKEN=' "$BRIDGE_DIR/.env" | head -1 | cut -d= -f2- | tr -d '\r\n')
fi
[ -n "$TOKEN" ] || { log "no bridge credential; nothing to ask with"; exit 0; }

HOSTNAME_NOW=$(hostname)
RUNNING=$(as_owner git -C "$REPO_DIR" rev-parse --short HEAD 2>/dev/null || echo "")
# Said out loud. This was silently empty on every device for weeks, reported as
# a blank version in the console, and the only trace was the word "unknown" in
# a log line nobody had reason to read.
[ -n "$RUNNING" ] || log "cannot read the running version from $REPO_DIR"
# Cleared once an update succeeds; sent so a failure stays visible in the
# console until it does.
PENDING_ERROR=""
[ -r "$STATE_DIR/update_error" ] && PENDING_ERROR=$(head -c 400 "$STATE_DIR/update_error")

ASK=$(curl -sS --max-time 30 -X POST "$SUPABASE_URL/functions/v1/bridge-release" \
  -H "x-bridge-key: $TOKEN" -H "Content-Type: application/json" \
  -d "$(printf '{"hostname":"%s","running":"%s","error":"%s"}' \
        "$HOSTNAME_NOW" "$RUNNING" "${PENDING_ERROR//\"/\'}")" ) || {
  log "could not reach the service; leaving this device alone"
  exit 0
}

TARGET=$(printf '%s' "$ASK" | python3 -c 'import json,sys
try:
    print(json.load(sys.stdin).get("ref") or "")
except Exception:
    print("")')

[ -n "$TARGET" ] || { log "no release set; staying on ${RUNNING:-unknown}"; exit 0; }

# Refuse anything that is not a plain git object name. The server is trusted to
# name a version, not to be creative — and a ref with a shell metacharacter in
# it is either a bug or an attack.
#
# The leading-hyphen case is separate and easy to miss: "--upload-pack" passes
# a character-class check and is then read by git as an option rather than a
# ref. Defence in depth — only a platform admin can set a release — but a guard
# that stops at metacharacters is not the guard it looks like.
case "$TARGET" in
  -*)                 log "refusing a ref that begins with a hyphen: $TARGET"; exit 1 ;;
  *[!A-Za-z0-9._/-]*) log "refusing a ref that is not a plain git name: $TARGET"; exit 1 ;;
esac

if [ "$TARGET" = "$RUNNING" ]; then
  # Said out loud. A silent exit is indistinguishable in the journal from a run
  # that did nothing for some other reason, which is exactly the ambiguity that
  # made a broken updater look like a working one for weeks.
  log "already on $TARGET; nothing to do"
  rm -f "$STATE_DIR/update_error"
  exit 0
fi

log "moving from ${RUNNING:-unknown} to $TARGET"
PREVIOUS="$RUNNING"

as_owner git -C "$REPO_DIR" fetch --quiet --tags origin || { log "fetch failed"; exit 1; }
if ! as_owner git -C "$REPO_DIR" checkout --quiet --detach "$TARGET" 2>/dev/null; then
  log "no such ref in this repository: $TARGET"
  printf 'no such ref: %s' "$TARGET" > "$STATE_DIR/update_error"
  exit 1
fi

# Dependencies can move with the code. Doing this every time is a few seconds
# and avoids the failure where a new import is missing on exactly the devices
# that updated unattended.
if ! as_owner "$BRIDGE_DIR/venv/bin/pip" install -q \
     -r "$BRIDGE_DIR/requirements.txt"; then
  log "dependency install failed"
fi

# The service account reaches the checkout as "other"; a fresh checkout can
# carry modes that leave it unable to read a new file.
chmod -R o+rX "$REPO_DIR"

systemctl restart "$SERVICE"

# Did it actually come back? A device that updates into a crash loop and says
# nothing is worse than one that never updated.
sleep 10
HEALTHY=false
for _ in 1 2 3 4 5 6; do
  if systemctl is-active --quiet "$SERVICE" &&
     journalctl -u "$SERVICE" --since "-2 min" 2>/dev/null | grep -q "bridge starting"; then
    HEALTHY=true
    break
  fi
  sleep 5
done

if [ "$HEALTHY" = true ]; then
  log "now on $TARGET"
  rm -f "$STATE_DIR/update_error"
  exit 0
fi

log "the bridge did not come back on $TARGET; reverting to ${PREVIOUS:-the previous commit}"
if [ -n "$PREVIOUS" ] && as_owner git -C "$REPO_DIR" checkout --quiet --detach "$PREVIOUS"; then
  chmod -R o+rX "$REPO_DIR"
  systemctl restart "$SERVICE"
  printf 'update to %s failed to start; reverted to %s' "$TARGET" "$PREVIOUS" \
    > "$STATE_DIR/update_error"
else
  printf 'update to %s failed to start and could not be reverted' "$TARGET" \
    > "$STATE_DIR/update_error"
fi
exit 1
