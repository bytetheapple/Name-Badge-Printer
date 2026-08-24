"""Talk to the Brother QL-820NWB over the network (raw TCP, port 9100).

Three responsibilities:
  * check_reachable() — is the printer answering on its print port?
  * query_status()    — request and parse the 32-byte status response
  * print_image()     — rasterize a PIL image via brother_ql and send it

Note: the byte offsets in _parse_status follow Brother's QL-series raster command
reference. They are implemented from spec and should be validated against the
real printer (arriving tomorrow); check_reachable and print_image do not depend
on them.
"""
import socket

from brother_ql.backends.helpers import send
from brother_ql.conversion import convert
import labels  # registers DK-1234; must come before any label lookup
labels.register()
from brother_ql.raster import BrotherQLRaster

MODEL = "QL-820NWB"
STATUS_REQUEST = bytes([0x1B, 0x69, 0x53])  # ESC i S

# Brother error bitmasks (status response bytes 8 and 9).
_ERROR_1 = {
    0x01: "No media",
    0x02: "End of media",
    0x04: "Cutter jam",
    0x10: "Printer in use",
    0x40: "Printer turned off",
    0x80: "Fan error",
}
_ERROR_2 = {
    0x01: "Replace media",
    0x04: "Cover open",
    0x08: "Overheating",
}
_MEDIA_TYPES = {
    0x00: "No media",
    0x0A: "Continuous tape",
    0x0B: "Die-cut label",
    0x4A: "Continuous tape",
    0x4B: "Die-cut label",
    0xFF: "Incompatible tape",
}


def check_reachable(ip: str, port: int = 9100, timeout: float = 2.0) -> bool:
    if not ip:
        return False
    try:
        with socket.create_connection((ip, int(port)), timeout=timeout):
            return True
    except OSError:
        return False


def query_status(ip: str, port: int = 9100, timeout: float = 3.0) -> dict:
    """Return {reachable, error_state, media_type, media_width}."""
    down = {"reachable": False, "error_state": None, "media_type": None, "media_width": None}
    if not ip:
        return down

    # Reachability = can we open the print port. Do NOT tie it to the status read:
    # some QL-820NWB firmware/modes don't answer the status request even though
    # printing works fine, so a missing reply must not read as "unreachable".
    try:
        s = socket.create_connection((ip, int(port)), timeout=timeout)
    except OSError:
        return down

    data = b""
    try:
        s.sendall(STATUS_REQUEST)
        s.settimeout(timeout)
        data = s.recv(32)
    except OSError:
        data = b""
    finally:
        s.close()

    if data and len(data) >= 32:
        return _parse_status(data)
    # Connected but no parseable status -> reachable, media unknown.
    return {"reachable": True, "error_state": None, "media_type": None, "media_width": None}


def _parse_status(d: bytes) -> dict:
    err1, err2 = d[8], d[9]
    media_width = d[10]
    media_type = d[11]

    errors = [msg for bit, msg in _ERROR_1.items() if err1 & bit]
    errors += [msg for bit, msg in _ERROR_2.items() if err2 & bit]

    return {
        "reachable": True,
        "error_state": ", ".join(errors) if errors else None,
        "media_type": _MEDIA_TYPES.get(media_type, f"0x{media_type:02X}"),
        "media_width": f"{media_width} mm" if media_width else None,
    }


def _relax_media_validation(instructions: bytes) -> bytes:
    """Clear the media kind/width *validation* bits in the print-information
    command (ESC i z), so the printer prints with whatever roll is loaded.

    Some QL-820NWB units report "wrong roll type" and refuse to print even when
    the correct roll is installed and the job declares it correctly. Since our
    label size is fixed, we disable the printer-side media check. The declared
    width value stays in the command; only the "validate against sensed media"
    flags are cleared.
    """
    marker = b"\x1b\x69\x7a"  # ESC i z
    i = instructions.find(marker)
    if i < 0 or i + 3 >= len(instructions):
        return instructions
    flags = instructions[i + 3]
    relaxed = flags & ~0x02 & ~0x04  # clear PI_KIND and PI_WIDTH
    return instructions[: i + 3] + bytes([relaxed]) + instructions[i + 4 :]


def print_image(img, ip: str, port: int = 9100, label: str = "62", cut: bool = True, rotation: int = 90):
    """Rasterize and send a PIL image to the printer. Raises on failure.

    `img` is the readable landscape badge. We rotate it into the printer's raster
    orientation ourselves so the roll's fixed dimension (696 dots for a 62 mm roll)
    becomes the image width, then pass rotate="0" so brother_ql does not resample.
    `rotation` (90 or 270) sets which way is "up"; confirm on real hardware.
    """
    if not ip:
        raise RuntimeError("printer_ip is not configured")

    printable = img.rotate(rotation, expand=True) if rotation else img

    # A two-color roll (e.g. DK-22251 62mm black/red) is selected via a label id
    # ending in "red". It needs the two-color job format so the printer accepts
    # the roll, even when the badge itself is black-only (empty red plane).
    two_color = label.endswith("red")

    qlr = BrotherQLRaster(MODEL)
    qlr.exception_on_warning = True
    instructions = convert(
        qlr=qlr,
        images=[printable],
        label=label,
        rotate="0",
        threshold=70.0,
        dither=False,
        compress=False,
        red=two_color,
        dpi_600=False,
        hq=True,
        cut=cut,
    )
    # Some QL-820NWB units reject a matching roll as "wrong roll type"; disable
    # the printer-side media validation so it prints what's actually loaded.
    instructions = _relax_media_validation(instructions)
    result = send(
        instructions=instructions,
        printer_identifier=f"tcp://{ip}:{int(port)}",
        backend_identifier="network",
        blocking=True,
    )
    # This unit doesn't return status over the network, so brother_ql can't
    # confirm did_print/printer_state (both come back empty even on a successful
    # print). Treat a completed send as success; a genuine network failure raises
    # from send() above, or comes back with instructions_sent False.
    if isinstance(result, dict) and result.get("instructions_sent") is False:
        raise RuntimeError(f"printer send failed: {result}")
    return result
