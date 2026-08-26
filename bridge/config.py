"""Environment-backed configuration for the print bridge."""
import os

from dotenv import load_dotenv

load_dotenv()  # loads bridge/.env if present

SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
# The scoped per-device credential (preferred). Issued in the admin under
# Print servers, and shown only once.
BRIDGE_TOKEN = os.environ.get("BRIDGE_TOKEN", "")
# Deprecated: the project-wide key, which bypasses RLS and can reach every
# tenant. Only used when no BRIDGE_TOKEN is set.
SERVICE_ROLE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")

#: Where the bridge writes what it owns: its rotated credential, and its cache
#: of downloaded header images.
#:
#: Separate from the code so the service account can be given write access to
#: its state without write access to the program it runs. Defaults to the
#: bridge directory, which is what a development checkout and every install
#: made before this existed will keep using.
STATE_DIR = os.environ.get("BRIDGE_STATE_DIR") or os.path.dirname(os.path.abspath(__file__))

POLL_INTERVAL = float(os.environ.get("POLL_INTERVAL_SECONDS", "2"))
HEARTBEAT_INTERVAL = float(os.environ.get("HEARTBEAT_INTERVAL_SECONDS", "15"))

FONT_BOLD = os.environ.get("FONT_BOLD", "")
FONT_REGULAR = os.environ.get("FONT_REGULAR", "")


def require():
    """Exit with a clear message if the configuration cannot work."""
    if not SUPABASE_URL:
        raise SystemExit(
            "Missing required env: SUPABASE_URL. "
            "Copy bridge/.env.example to bridge/.env and fill it in."
        )
    # A device that has rotated no longer needs BRIDGE_TOKEN in .env — the
    # bootstrap value has been retired and replaced by bridge/token.
    import credential

    if not BRIDGE_TOKEN and not SERVICE_ROLE_KEY and not credential.stored():
        raise SystemExit(
            "Missing credentials: set BRIDGE_TOKEN (issue one in the admin under "
            "Print servers). See bridge/.env.example."
        )
