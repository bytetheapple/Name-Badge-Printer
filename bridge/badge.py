"""Render a name badge to a PIL image.

The layout is a three-band design: a small header line at the top, the person's
name auto-sized to fill the middle, and a subtitle at the bottom. Dimensions and
text come from the badge_template JSON stored in printer_config (with sensible
defaults), so the look can be tuned from the admin console without code changes.
"""
import os
from datetime import datetime

from PIL import Image, ImageDraw, ImageFont

import config
from brother_ql.labels import ALL_LABELS

DPI = 300
MM = DPI / 25.4  # pixels per millimetre (~11.81)

_FONT_CACHE: dict = {}
_ASSETS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "assets")


def _load_header_image(name: str):
    """Load a header graphic (RGBA). An absolute path (e.g. a cached custom
    header) is used as-is; a bare name resolves inside bridge/assets/."""
    path = name if os.path.isabs(str(name)) else os.path.join(_ASSETS, str(name))
    try:
        return Image.open(path).convert("RGBA")
    except (OSError, ValueError):
        return None


_LABELS = {label.identifier: label for label in ALL_LABELS}


def _label_render_size(label: str, length_mm: float) -> tuple[int, int]:
    """(width, height) in dots for the readable *landscape* badge image.

    width = feed/length direction, height = across the print head. Continuous
    rolls have a fixed head width and an admin-set length; die-cut labels are a
    fixed size in both dimensions.
    """
    spec = _LABELS.get(label)
    if spec is None:
        return round(length_mm * MM), 696  # fallback: 62 mm continuous
    head_px, feed_px = spec.dots_printable
    if "ENDLESS" in str(spec.form_factor):
        return round(length_mm * MM), head_px
    return feed_px, head_px  # die-cut: fixed in both dimensions


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


def render_badge(
    first: str,
    last: str = "",
    template: dict | None = None,
    label: str = "62",
    pronouns: str = "",
) -> Image.Image:
    t = template or {}
    header = t.get("header", "WELCOME")
    subtitle = t.get("subtitle", "Shir Hadash")

    # Size the readable landscape image to the label: continuous rolls use the
    # admin length, die-cut labels (e.g. 60x86 / DK-1234) are fixed. Rendering at
    # the label's exact printable dots avoids brother_ql resampling the image.
    width, height = _label_render_size(label, float(t.get("length_mm", 90)))
    margin = round(float(t.get("margin_mm", 6)) * MM)
    inner = width - 2 * margin

    img = Image.new("RGB", (width, height), "white")
    draw = ImageDraw.Draw(img)

    top = margin
    bottom = height - margin

    # Header: a logo image (if header_image is set and found) takes priority over
    # the text header. Either advances `top` so the name sits below it.
    header_image = t.get("header_image")
    logo = _load_header_image(str(header_image)) if header_image else None
    if logo is not None:
        target_h = round(height * float(t.get("header_image_frac", 0.28)))
        logo_w = round(target_h * logo.width / logo.height)
        if logo_w > inner:
            logo_w = inner
            target_h = round(logo_w * logo.height / logo.width)
        logo_r = logo.resize((logo_w, target_h), Image.LANCZOS)
        img.paste(logo_r, ((width - logo_w) // 2, top), logo_r)
        top += target_h + round(4 * MM)
    elif header:
        hf = _load_font(round(float(t.get("header_mm", 4)) * MM), bold=True)
        draw.text((width / 2, top), str(header).upper(), font=hf, fill="black", anchor="ma")
        top += hf.getbbox(str(header).upper())[3] + round(2.5 * MM)

    if subtitle:
        sf = _load_font(round(float(t.get("subtitle_mm", 6)) * MM), bold=False)
        draw.text((width / 2, bottom), str(subtitle), font=sf, fill="black", anchor="md")
        box = sf.getbbox(str(subtitle))
        bottom -= (box[3] - box[1]) + round(2.5 * MM)

    # First name large; last name smaller beneath it; optional pronouns smaller
    # still. All centered, and the stack centered vertically in the available band.
    first = (first or "").strip() or " "
    last = (last or "").strip()
    pronouns = (pronouns or "").strip()

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
            bold=False,
        )
        if last
        else None
    )
    pronouns_font = (
        _fit_line(
            draw,
            pronouns,
            inner,
            round(float(t.get("pronouns_max_mm", 10)) * MM),
            round(float(t.get("pronouns_min_mm", 7)) * MM),
            bold=False,
        )
        if pronouns
        else None
    )

    first_h = _text_h(first_font, first)
    gap = round(float(t.get("name_gap_mm", 3)) * MM) if last else 0
    last_h = _text_h(last_font, last) if last else 0
    pgap = round(float(t.get("pronouns_gap_mm", 2)) * MM) if pronouns else 0
    pronouns_h = _text_h(pronouns_font, pronouns) if pronouns else 0
    total_h = first_h + gap + last_h + pgap + pronouns_h

    # Shrink the whole stack proportionally if it is taller than the band between
    # the header and subtitle (so it never collides with them).
    band = (bottom - top) * 0.96
    if total_h > band > 0:
        scale = band / total_h
        first_font = _load_font(max(8, int(first_font.size * scale)), bold=True)
        if last_font is not None:
            last_font = _load_font(max(8, int(last_font.size * scale)), bold=False)
        if pronouns_font is not None:
            pronouns_font = _load_font(max(8, int(pronouns_font.size * scale)), bold=False)
        first_h = _text_h(first_font, first)
        gap = round(gap * scale)
        last_h = _text_h(last_font, last) if last else 0
        pgap = round(pgap * scale)
        pronouns_h = _text_h(pronouns_font, pronouns) if pronouns else 0
        total_h = first_h + gap + last_h + pgap + pronouns_h

    y = (top + bottom) / 2 - total_h / 2
    draw.text((width / 2, y), first, font=first_font, fill="black", anchor="ma")
    y += first_h
    if last:
        y += gap
        draw.text((width / 2, y), last, font=last_font, fill="black", anchor="ma")
        y += last_h
    if pronouns:
        y += pgap
        draw.text((width / 2, y), pronouns, font=pronouns_font, fill="black", anchor="ma")

    return img


def render_test_badge(template: dict | None = None, label: str = "62") -> Image.Image:
    """A badge used by the admin 'test print' button."""
    t = dict(template or {})
    now = datetime.now()
    return render_badge(
        now.strftime("%Y-%m-%d"),
        now.strftime("%H:%M"),
        {**t, "header": "TEST PRINT", "subtitle": "Name Badge Printer"},
        label,
    )


if __name__ == "__main__":
    import sys

    first = sys.argv[1] if len(sys.argv) > 1 else "Sarah"
    last = sys.argv[2] if len(sys.argv) > 2 else "Goldberg"
    out = sys.argv[3] if len(sys.argv) > 3 else "sample-badge.png"
    label = sys.argv[4] if len(sys.argv) > 4 else "62"
    image = render_badge(first, last, {}, label)
    image.save(out)
    print(f"wrote {out} {image.size}")
