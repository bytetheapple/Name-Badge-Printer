"""Environment-backed configuration for the print bridge."""
import os

from dotenv import load_dotenv

load_dotenv()  # loads bridge/.env if present

SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SERVICE_ROLE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")

POLL_INTERVAL = float(os.environ.get("POLL_INTERVAL_SECONDS", "2"))
HEARTBEAT_INTERVAL = float(os.environ.get("HEARTBEAT_INTERVAL_SECONDS", "15"))

FONT_BOLD = os.environ.get("FONT_BOLD", "")
FONT_REGULAR = os.environ.get("FONT_REGULAR", "")


def require():
    """Exit with a clear message if required env vars are missing."""
    missing = [
        name
        for name, value in {
            "SUPABASE_URL": SUPABASE_URL,
            "SUPABASE_SERVICE_ROLE_KEY": SERVICE_ROLE_KEY,
        }.items()
        if not value
    ]
    if missing:
        raise SystemExit(
            f"Missing required env: {', '.join(missing)}. "
            "Copy bridge/.env.example to bridge/.env and fill it in."
        )
