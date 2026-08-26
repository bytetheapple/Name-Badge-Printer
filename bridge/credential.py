"""Where the bridge keeps its own credential.

The token in `.env` is what someone typed while imaging the card. It is used
once, and the server immediately replaces it — so from then on the live
credential is machine-managed and lives here instead.

Two files rather than one on purpose. `.env` is a human's file: hand-edited,
occasionally hand-copied between devices, and not something a daemon should be
rewriting at three in the morning. `token` is the machine's, and nothing but
this module touches it.

Precedence is therefore: this file first, `.env` only as the bootstrap.
"""
from __future__ import annotations

import os
import stat
import tempfile

import config

#: Written by the bridge, read by nothing else.
TOKEN_FILE = os.path.join(config.STATE_DIR, "token")

#: Where it used to live, beside the code. A device that rotated before the
#: state directory existed is holding its only working credential there — the
#: value in .env was retired the first time it connected — so losing track of
#: it would take that device off the air until somebody re-imaged it.
LEGACY_TOKEN_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "token")


def _read(path: str) -> str:
    try:
        with open(path, encoding="utf-8") as fh:
            return fh.read().strip()
    except FileNotFoundError:
        return ""
    except OSError:
        # Unreadable is not the same as absent, but the caller can do nothing
        # different about it: either way we fall back to the bootstrap token.
        return ""


def stored() -> str:
    """The rotated credential, or "" if the device has never rotated.

    The old location is still read, and only as a fallback. A device that
    rotated before the state directory existed keeps working; the next
    rotation writes to the new home and the old file stops mattering.
    """
    return _read(TOKEN_FILE) or _read(LEGACY_TOKEN_FILE)


def store(token: str) -> None:
    """Write a new credential, or raise if it cannot be made durable.

    Durability is the whole point of this function. The server has already
    minted this token and will retire the current one as soon as it is used, so
    "written" has to mean survives-losing-power, not handed-to-the-OS. Written
    to a temporary file, flushed, fsynced, then renamed — rename is atomic
    within a filesystem, so a reader sees either the old token or the new one
    and never a half-written line.

    Raises OSError. The caller reports the failure upstream and keeps using the
    credential it already has, which is still valid precisely because the
    server has not revoked it yet.
    """
    if not token or not token.strip():
        raise ValueError("refusing to store an empty credential")

    directory = os.path.dirname(TOKEN_FILE)
    os.makedirs(directory, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=directory, prefix=".token-")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(token.strip() + "\n")
            fh.flush()
            os.fsync(fh.fileno())
        # Nobody else on the device has any business reading this.
        os.chmod(tmp, stat.S_IRUSR | stat.S_IWUSR)
        os.replace(tmp, TOKEN_FILE)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise

    # The rename is only durable once the directory entry is too.
    try:
        dir_fd = os.open(directory, os.O_RDONLY)
        try:
            os.fsync(dir_fd)
        finally:
            os.close(dir_fd)
    except OSError:
        # Some filesystems refuse to fsync a directory. The file itself is
        # already synced, so this is a smaller guarantee, not no guarantee.
        pass


def current(bootstrap: str) -> str:
    """The credential to authenticate with: the rotated one, else the bootstrap."""
    return stored() or bootstrap
