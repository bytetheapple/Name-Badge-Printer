"""Render a name badge to a PIL image.

The layout is a three-band design: a small header line at the top, the person's
name auto-sized to fill the middle, and a subtitle at the bottom. Dimensions and
text come from the badge_template JSON stored in printer_config (with sensible
defaults), so the look can be tuned from the admin console without code changes.
"""
from datetime import datetime

from PIL import Image, ImageDraw, ImageFont

import config

DPI = 300
MM = DPI / 25.4  # pixels per millimetre (~11.81)

_FONT_CACHE: dict = {}


def _load_font(size_px: int, bold: bool = True) -> ImageFont.FreeTypeFont:
    key = (size_px, bold)
    cached = _FONT_CACHE.get(key)
    if cached is not None:
        return cached

    override = config.FONT_BOLD if bold else config.FONT_REGULAR
    candidates = [override] if override else []
    if bold:
        candidates += [
            "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",  # Raspberry Pi OS
            "/System/Library/Fonts/Supplemental/Arial Bold.ttf",  # macOS
            "/Library/Fonts/Arial Bold.ttf",
        ]
    else:
        candidates += [
            "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
            "/System/Library/Fonts/Supplemental/Arial.ttf",
            "/Library/Fonts/Arial.ttf",
        ]
    candidates += ["/System/Library/Fonts/Helvetica.ttc"]  # macOS fallback (both weights)

    for path in candidates:
        if not path:
            continue
        try:
            font = ImageFont.truetype(path, size_px)
            _FONT_CACHE[key] = font
            return font
        except OSError:
            continue

    font = ImageFont.load_default()
    _FONT_CACHE[key] = font
    return font


def _fit_line(draw, text, max_width, start_px, min_px, bold=True):
    """Largest single-line font (down to min_px) whose width fits max_width."""
    size = start_px
    while size > min_px:
        font = _load_font(size, bold)
        if draw.textlength(text, font=font) <= max_width:
            return font
        size -= 2
    return _load_font(min_px, bold)


def _text_h(font, text):
    box = font.getbbox(text)
    return box[3] - box[1]


def render_badge(name: str, template: dict | None = None) -> Image.Image:
    t = template or {}
    header = t.get("header", "WELCOME")
    subtitle = t.get("subtitle", "Shir Hadash")

    # The badge length (feed direction) is variable; the roll's cross-direction is
    # a fixed number of printable dots (696 for a 62 mm roll at 300 dpi). Rendering
    # the roll dimension in exact dots avoids brother_ql resampling the image.
    width = round(float(t.get("length_mm", 90)) * MM)
    height = int(t.get("roll_px", 696))
    margin = round(float(t.get("margin_mm", 6)) * MM)
    inner = width - 2 * margin

    img = Image.new("RGB", (width, height), "white")
    draw = ImageDraw.Draw(img)

    top = margin
    bottom = height - margin

    if header:
        hf = _load_font(round(float(t.get("header_mm", 4)) * MM), bold=True)
        draw.text((width / 2, top), str(header).upper(), font=hf, fill="black", anchor="ma")
        top += hf.getbbox(str(header).upper())[3] + round(2.5 * MM)

    if subtitle:
        sf = _load_font(round(float(t.get("subtitle_mm", 6)) * MM), bold=False)
        draw.text((width / 2, bottom), str(subtitle), font=sf, fill="black", anchor="md")
        box = sf.getbbox(str(subtitle))
        bottom -= (box[3] - box[1]) + round(2.5 * MM)

    name = (name or "").strip() or " "
    # First name large; last name (remaining words) smaller beneath it. Both
    # centered, and the pair centered vertically in the available band.
    parts = name.split()
    first = parts[0] if parts else name
    last = " ".join(parts[1:])

    first_font = _fit_line(
        draw,
        first,
        inner,
        round(float(t.get("first_name_max_mm", 30)) * MM),
        round(float(t.get("first_name_min_mm", 12)) * MM),
        bold=True,
    )
    last_font = (
        _fit_line(
            draw,
            last,
            inner,
            round(float(t.get("last_name_max_mm", 15)) * MM),
            round(float(t.get("last_name_min_mm", 9)) * MM),
            bold=True,
        )
        if last
        else None
    )

    first_h = _text_h(first_font, first)
    gap = round(float(t.get("name_gap_mm", 3)) * MM) if last else 0
    last_h = _text_h(last_font, last) if last else 0
    total_h = first_h + gap + last_h

    # Shrink both proportionally if the stacked name is taller than the band
    # between the header and subtitle (so it never collides with them).
    band = (bottom - top) * 0.96
    if total_h > band > 0:
        scale = band / total_h
        first_font = _load_font(max(8, int(first_font.size * scale)), bold=True)
        if last_font is not None:
            last_font = _load_font(max(8, int(last_font.size * scale)), bold=True)
        first_h = _text_h(first_font, first)
        gap = round(gap * scale)
        last_h = _text_h(last_font, last) if last else 0
        total_h = first_h + gap + last_h

    start_y = (top + bottom) / 2 - total_h / 2
    draw.text((width / 2, start_y), first, font=first_font, fill="black", anchor="ma")
    if last:
        draw.text(
            (width / 2, start_y + first_h + gap), last, font=last_font, fill="black", anchor="ma"
        )

    return img


def render_test_badge(template: dict | None = None) -> Image.Image:
    """A badge used by the admin 'test print' button."""
    t = dict(template or {})
    stamp = datetime.now().strftime("%Y-%m-%d %H:%M")
    return render_badge(stamp, {**t, "header": "TEST PRINT", "subtitle": "Name Badge Printer"})


if __name__ == "__main__":
    import sys

    who = sys.argv[1] if len(sys.argv) > 1 else "Sarah Goldberg"
    out = sys.argv[2] if len(sys.argv) > 2 else "sample-badge.png"
    image = render_badge(who, {})
    image.save(out)
    print(f"wrote {out} {image.size}")
