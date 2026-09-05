"""Render a name badge to a PIL image.

The layout is a three-band design: a small header line at the top, the person's
name auto-sized to fill the middle, and a subtitle at the bottom. Dimensions and
text come from the badge_template JSON stored in printer_config (with sensible
defaults), so the look can be tuned from the admin console without code changes.
"""
import os
import sys
from datetime import datetime

from PIL import Image, ImageDraw, ImageFont

import config
from brother_ql.labels import ALL_LABELS

DPI = 300
MM = DPI / 25.4  # pixels per millimetre (~11.81)

_FONT_CACHE: dict = {}
_FONT_PATHS: dict = {}  # bold -> resolved file, so the directory walk happens once
_ASSETS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "assets")


def _load_header_image(name: str):
    """Load a header graphic (RGBA). An absolute path (e.g. a cached custom
    header) is used as-is; a bare name resolves inside bridge/assets/."""
    path = name if os.path.isabs(str(name)) else os.path.join(_ASSETS, str(name))
    try:
        return Image.open(path).convert("RGBA")
    except (OSError, ValueError):
        return None


def _white_mark(logo):
    """The same artwork in white, for printing on a dark banner.

    Composited over white first so a transparent PNG and a JPEG with a white
    background reduce to the same thing — dark ink on white — and then the dark
    pixels become the mask. That is what makes it work for both kinds of logo a
    congregation might upload, without asking them for a second one.
    """
    flat = Image.new("RGB", logo.size, "white")
    flat.paste(logo, (0, 0), logo if logo.mode == "RGBA" else None)
    # A hard threshold rather than a gradient: this prints on a thermal head at
    # one bit per dot, so anything in between is decided for us anyway, and
    # deciding it here keeps the edges where the artwork put them.
    mask = flat.convert("L").point(lambda v: 255 if v < 140 else 0, mode="L")
    return Image.new("RGB", logo.size, "white"), mask


_LABELS = {label.identifier: label for label in ALL_LABELS}
#: Unknown labels already reported, so a misconfiguration is said once.
_WARNED_LABELS: set = set()


def _label_render_size(label: str, length_mm: float) -> tuple[int, int]:
    """(width, height) in dots for the readable *landscape* badge image.

    width = feed/length direction, height = across the print head. Continuous
    rolls have a fixed head width and an admin-set length; die-cut labels are a
    fixed size in both dimensions.
    """
    # A length of zero renders a canvas of zero width, which fails inside PIL
    # as "height and width must be > 0" — a message about an image, given to
    # somebody whose actual problem is a setting. Seen in the field on an
    # organization whose badge length was never filled in.
    #
    # Clamped rather than raised: a badge at the default length is useful and a
    # traceback is not, and the warning says what to change.
    if not length_mm or length_mm <= 0:
        if "length" not in _WARNED_LABELS:
            _WARNED_LABELS.add("length")
            print(
                f"[badge] badge length is {length_mm!r} — rendering at 90 mm. "
                "Set the badge length for this organization.",
                file=sys.stderr,
                flush=True,
            )
        length_mm = 90.0

    def _sane(w: int, h: int) -> tuple[int, int]:
        """Never hand back a dimension that cannot be drawn.

        Everything above reads numbers out of a third-party label table, and a
        zero anywhere in it fails every badge for an organization with a
        message about images. One roll's metadata is not worth a lobby.
        """
        if w > 0 and h > 0:
            return w, h
        if "size" not in _WARNED_LABELS:
            _WARNED_LABELS.add("size")
            print(
                f"[badge] label '{label}' gave a canvas of {w}x{h} — "
                "rendering as 62 mm continuous instead.",
                file=sys.stderr,
                flush=True,
            )
        return round(length_mm * MM), 696

    spec = _LABELS.get(label)
    if spec is None:
        # Falling back silently means badges render at a size nobody chose and
        # come out looking almost right, because the printer positions to the
        # physical label whatever we send. Said once per unknown label rather
        # than once per badge.
        if label not in _WARNED_LABELS:
            _WARNED_LABELS.add(label)
            print(
                f"[badge] unknown label '{label}' — rendering as 62 mm continuous. "
                f"Known: {', '.join(sorted(_LABELS))}",
                file=sys.stderr,
                flush=True,
            )
        return _sane(round(length_mm * MM), 696)  # fallback: 62 mm continuous
    head_px, feed_px = spec.dots_printable
    # `.name`, not str(). Python 3.11 changed IntEnum.__str__ to return the
    # number rather than the member name, so "ENDLESS" in str(form_factor) is
    # True on 3.10 and False on 3.12 — for the same label, the same library and
    # the same code. A print server on Debian 13 therefore took the die-cut
    # branch for a continuous roll and rendered every badge on a canvas of no
    # width, while the machine this was written on printed perfectly.
    form = getattr(spec.form_factor, "name", None) or str(spec.form_factor)
    if "ENDLESS" in form:
        # A continuous roll has no fixed length, so one of these two numbers is
        # zero — and which one is not something every build of brother_ql
        # agrees on. Taking whichever is set beats trusting the order: reading
        # the zero as the head width produced a canvas with no height, and PIL
        # reported it as "height and width must be > 0", a sentence about an
        # image rather than about a label.
        head = head_px or feed_px
        return _sane(round(length_mm * MM), head)
    return _sane(feed_px, head_px)  # die-cut: fixed in both dimensions


# Where fonts live, by platform. A badge is nothing but large text, so a missing
# font is a fatal error, not something to paper over: Pillow's load_default()
# returns a real FreeTypeFont locked at 10 pixels, which renders a full badge at
# an unreadable size while passing every check we could make about it.
_FONT_DIRS = (
    "/usr/share/fonts",
    "/usr/local/share/fonts",
    "/System/Library/Fonts/Supplemental",
    "/System/Library/Fonts",
    "/Library/Fonts",
    os.path.expanduser("~/.local/share/fonts"),
    os.path.expanduser("~/Library/Fonts"),
)

# Filenames worth having, best first. Any of them renders a legible badge.
_FONT_FILES = {
    True: (  # bold
        "DejaVuSans-Bold.ttf",
        "LiberationSans-Bold.ttf",
        "NotoSans-Bold.ttf",
        "FreeSansBold.ttf",
        "Arial Bold.ttf",
        "Helvetica.ttc",
    ),
    False: (
        "DejaVuSans.ttf",
        "LiberationSans-Regular.ttf",
        "NotoSans-Regular.ttf",
        "FreeSans.ttf",
        "Arial.ttf",
        "Helvetica.ttc",
    ),
}


def _find_font_file(bold: bool):
    """Locate a usable TrueType file, or None. Walks the font directories rather
    than hard-coding full paths, because the same font sits in a different place
    on Raspberry Pi OS, Debian and macOS."""
    wanted = _FONT_FILES[bold]
    found: dict = {}
    for root in _FONT_DIRS:
        if not os.path.isdir(root):
            continue
        for dirpath, _dirnames, filenames in os.walk(root):
            for name in filenames:
                if name in wanted and name not in found:
                    found[name] = os.path.join(dirpath, name)
        if len(found) == len(wanted):
            break
    for name in wanted:
        if name in found:
            return found[name]
    return None


def _load_font(size_px: int, bold: bool = True) -> ImageFont.FreeTypeFont:
    key = (size_px, bold)
    cached = _FONT_CACHE.get(key)
    if cached is not None:
        return cached

    override = config.FONT_BOLD if bold else config.FONT_REGULAR
    if bold not in _FONT_PATHS:  # "not found" is cached too; the walk is not cheap
        _FONT_PATHS[bold] = override or _find_font_file(bold)
    path = _FONT_PATHS[bold]

    if not path:
        raise RuntimeError(
            "no TrueType font found on this machine, so a badge would print at "
            "an unreadable size. Install one with: "
            "sudo apt-get install -y fonts-dejavu-core "
            "(or set FONT_BOLD and FONT_REGULAR in .env to font files)"
        )

    try:
        font = ImageFont.truetype(path, size_px)
    except OSError as exc:
        raise RuntimeError(f"could not load the font at {path}: {exc}") from exc
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
    visitor: bool = False,
    corner: str = "",
) -> Image.Image:
    """Render one badge.

    `visitor` inverts the header into a dark banner with the logo or wording in
    white and "Visitor" in the corner, so the two kinds of badge are told apart
    across a room rather than by reading them. Members are unchanged: the
    ordinary badge is the one most people get, and it stays the quiet one.

    `corner` overrides the word in that corner, and puts one there on a badge
    that is not inverted. An event desk uses it for ON-SITE, to mark someone
    who was not on the pre-registration list -- often the difference between a
    badge that is handed over and one that is handed over after payment. The
    slot is shared rather than duplicated: one corner that carries whichever
    word applies beats a second corner per case.
    """
    t = template or {}
    header = t.get("header", "WELCOME")
    # No subtitle unless one is configured. This defaulted to a congregation's
    # name — the same fault the built-in logo had, in the line above it, fixed
    # in "the badge logo belongs to the organization, not to the build" and
    # missed here. bridge.py only sets `subtitle` when the printer has one, so
    # any organization that had not filled it in printed somebody else's name
    # on every badge.
    subtitle = t.get("subtitle", "")

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
    #
    # For a visitor the whole header sits on a black band running edge to edge,
    # with the mark or the wording knocked out in white. The band is measured
    # from the header's own height rather than being a fixed depth, so a logo
    # and a line of text each get a banner that fits them.
    header_image = t.get("header_image")
    logo = _load_header_image(str(header_image)) if header_image else None
    ink = "white" if visitor else "black"
    banner_h = 0

    if logo is not None:
        target_h = round(height * float(t.get("header_image_frac", 0.28)))
        logo_w = round(target_h * logo.width / logo.height)
        if logo_w > inner:
            logo_w = inner
            target_h = round(logo_w * logo.height / logo.width)
        banner_h = top + target_h + round(2.5 * MM)
        if visitor:
            draw.rectangle([0, 0, width, banner_h], fill="black")
        logo_r = logo.resize((logo_w, target_h), Image.LANCZOS)
        if visitor:
            mark, mask = _white_mark(logo_r)
            img.paste(mark, ((width - logo_w) // 2, top), mask)
        else:
            img.paste(logo_r, ((width - logo_w) // 2, top), logo_r)
        top += target_h + round(4 * MM)
    elif header:
        hf = _load_font(round(float(t.get("header_mm", 4)) * MM), bold=True)
        text = str(header).upper()
        banner_h = top + hf.getbbox(text)[3] + round(2.5 * MM)
        if visitor:
            draw.rectangle([0, 0, width, banner_h], fill="black")
        draw.text((width / 2, top), text, font=hf, fill=ink, anchor="ma")
        top += hf.getbbox(text)[3] + round(2.5 * MM)

    # The word itself, in the corner of the band. Small, because the inversion
    # is what carries across a room and this is what confirms it up close.
    #
    # An explicit `corner` wins over the visitor label and works with or
    # without the band: on an event badge the header is never inverted, so the
    # word is drawn in black on white and is the only thing distinguishing the
    # two kinds of badge on that desk.
    word = (corner or "").strip() or (str(t.get("visitor_label", "Visitor")) if visitor else "")
    if word and banner_h:
        # Smaller than the header wording: the inversion is what reads across a
        # room, and this only has to confirm it once someone is close enough to
        # shake a hand.
        vf = _load_font(round(float(t.get("visitor_mm", 2.4)) * MM), bold=True)
        draw.text(
            (width - margin, round(2 * MM)),
            word,
            font=vf,
            fill=("white" if visitor else "black"),
            anchor="ra",
        )

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
    """A badge used by the admin 'test print' button.

    It shows the organization's own header and subtitle, because the question
    a test print answers is "what will our badges look like" — and one that
    substitutes its own wording answers a different question.

    It used to print the date as the first name and the time as the last, over
    a header reading TEST PRINT and a subtitle carrying this project's former
    name. That looked nothing like a badge, hid whether the congregation's own
    header graphic worked, and — because a ten-character date has to shrink to
    fit — printed the name at half the size a real one gets. Somebody testing
    their setup reasonably concluded the text was too small.

    The timestamp moves to the pronouns line, which is small and already
    positioned for a short note. It is the one thing a test badge must carry:
    proof that this label came out now rather than being one found on a desk.
    """
    t = dict(template or {})
    now = datetime.now()
    return render_badge(
        "Test",
        "Print",
        t,
        label,
        pronouns=now.strftime("%d %b %Y, %H:%M"),
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
