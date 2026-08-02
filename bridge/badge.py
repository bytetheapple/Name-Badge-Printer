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


def _wrap(draw, words, font, max_width):
    """Greedily wrap words into lines no wider than max_width."""
    lines: list[str] = []
    current = ""
    for word in words:
        trial = f"{current} {word}".strip()
        if not current or draw.textlength(trial, font=font) <= max_width:
            current = trial
        else:
            lines.append(current)
            current = word
    if current:
        lines.append(current)
    return lines


def _fit_multiline(draw, text, max_width, max_height, start_px, min_px, max_lines, bold=True):
    """Largest font (down to min_px) that fits text within max_width x max_height,
    wrapping into at most max_lines lines. Returns (lines, font, line_height)."""
    words = text.split() or [text]
    size = start_px
    while size >= min_px:
        font = _load_font(size, bold)
        lines = _wrap(draw, words, font, max_width)
        widest = max((draw.textlength(line, font=font) for line in lines), default=0)
        line_h = font.getbbox("Ag")[3]
        if len(lines) <= max_lines and widest <= max_width and len(lines) * line_h * 1.1 <= max_height:
            return lines, font, line_h
        size -= 2
    font = _load_font(min_px, bold)
    return _wrap(draw, words, font, max_width)[:max_lines], font, font.getbbox("Ag")[3]


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
    band = bottom - top
    lines, nf, line_h = _fit_multiline(
        draw,
        name,
        inner,
        band,
        round(float(t.get("name_max_mm", 24)) * MM),
        round(float(t.get("name_min_mm", 8)) * MM),
        int(t.get("name_max_lines", 2)),
        bold=True,
    )
    step = line_h * 1.1
    total_h = len(lines) * step
    center = (top + bottom) / 2
    for i, line in enumerate(lines):
        cy = center - total_h / 2 + step * (i + 0.5)
        draw.text((width / 2, cy), line, font=nf, fill="black", anchor="mm")

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
