#!/usr/bin/env bash
# Set up the print bridge virtualenv and dependencies.
# Run on the machine that will talk to the printer (the Raspberry Pi).
set -euo pipefail

cd "$(dirname "$0")/.."  # -> bridge/

# A badge is almost entirely text, and Raspberry Pi OS Lite ships with no
# TrueType fonts at all. Without one the bridge now refuses to render rather
# than printing a badge at an unreadable size.
if command -v apt-get >/dev/null 2>&1; then
  echo "Installing fonts..."
  sudo apt-get install -y fonts-dejavu-core
fi

echo "Creating virtualenv..."
python3 -m venv venv
./venv/bin/pip install --upgrade pip
echo "Installing dependencies (this can take a few minutes on a Pi)..."
./venv/bin/pip install -r requirements.txt

echo
echo "Done."
echo "Next:"
echo "  1. cp .env.example .env"
echo "     Issue a token in the admin under Print Server -> Print servers and put"
echo "     it in .env as BRIDGE_TOKEN. It is shown once and cannot be read back."
echo "     Do NOT use SUPABASE_SERVICE_ROLE_KEY: it reaches every organization,"
echo "     and exists only so an already-deployed Pi can be cut over."
echo "  2. Test:  ./venv/bin/python bridge.py"
echo "  3. Install as a service (edit paths/User in systemd/name-badge-bridge.service first):"
echo "       sudo cp systemd/name-badge-bridge.service /etc/systemd/system/"
echo "       sudo systemctl daemon-reload"
echo "       sudo systemctl enable --now name-badge-bridge"
echo "       journalctl -u name-badge-bridge -f"
