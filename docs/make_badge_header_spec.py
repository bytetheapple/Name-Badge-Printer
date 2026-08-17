#!/usr/bin/env python3
"""Generate a one-page badge-header artwork spec PDF for a graphic designer."""
from reportlab.lib.pagesizes import letter
from reportlab.lib.units import inch
from reportlab.lib import colors
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.enums import TA_LEFT
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, HRFlowable, KeepInFrame,
)
from reportlab.graphics.shapes import Drawing, Rect, String

# ---- palette ---------------------------------------------------------------
INK = colors.HexColor("#1b1f3b")
ACCENT = colors.HexColor("#2b3a8f")
ACCENT_LT = colors.HexColor("#e9ecf8")
MUTED = colors.HexColor("#5c6270")
RULE = colors.HexColor("#d7dae5")
GOOD = colors.HexColor("#1f7a4d")
BAD = colors.HexColor("#b23b3b")
BANDFILL = colors.HexColor("#dfe4f6")

OUT = "Shir-Hadash-Badge-Header-Spec.pdf"

styles = getSampleStyleSheet()

def S(name, **kw):
    return ParagraphStyle(name, parent=styles["Normal"], **kw)

kicker = S("kicker", fontName="Helvetica-Bold", fontSize=8.5, textColor=ACCENT,
           spaceAfter=2, leading=11, tracking=1)
title = S("title", fontName="Helvetica-Bold", fontSize=19, textColor=INK,
          leading=22, spaceAfter=2)
intro = S("intro", fontName="Helvetica", fontSize=9.5, textColor=MUTED, leading=13,
          spaceBefore=2, spaceAfter=2)
h2 = S("h2", fontName="Helvetica-Bold", fontSize=10.5, textColor=ACCENT,
       leading=13, spaceBefore=6, spaceAfter=3)
body = S("body", fontName="Helvetica", fontSize=9, textColor=INK, leading=12.5)
small = S("small", fontName="Helvetica", fontSize=8, textColor=MUTED, leading=10.5)
lbl = S("lbl", fontName="Helvetica-Bold", fontSize=9, textColor=INK, leading=12)
val = S("val", fontName="Helvetica", fontSize=9, textColor=INK, leading=12)
listgood = S("listgood", fontName="Helvetica", fontSize=8.8, textColor=INK, leading=12.5,
             leftIndent=2)
caphead = S("caphead", fontName="Helvetica-Bold", fontSize=8.5, textColor=MUTED,
            leading=11, alignment=1, spaceBefore=3)


def spec_table():
    rows = [
        ("File format", "PNG with transparency (PNG-24). <b>Not JPEG.</b>"),
        ("Canvas size", "1200 &#215; 300 px (or larger at the same ratio)"),
        ("Aspect ratio", "~4:1, wide / horizontal (3:1&#8211;5:1 is fine)"),
        ("Colour", "Black &amp; white only &#8212; pure black <b>#000000</b>"),
        ("Background", "Transparent"),
        ("Max file size", "2 MB"),
    ]
    data = [[Paragraph(a, lbl), Paragraph(b, val)] for a, b in rows]
    t = Table(data, colWidths=[0.95 * inch, 2.35 * inch])
    t.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("TOPPADDING", (0, 0), (-1, -1), 3.5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 3.5),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("LINEBELOW", (0, 0), (-1, -2), 0.5, RULE),
    ]))
    return t


def badge_diagram():
    """A small schematic: portrait badge with the header band highlighted."""
    d = Drawing(150, 196)
    bx, by, bw, bh = 18, 12, 114, 172           # badge rect
    band_h = bh * 0.28
    band_y = by + bh - band_h
    # badge outline
    d.add(Rect(bx, by, bw, bh, rx=9, ry=9, fillColor=colors.white,
               strokeColor=colors.HexColor("#b9bed0"), strokeWidth=1.2))
    # header band
    d.add(Rect(bx, band_y, bw, band_h, fillColor=BANDFILL,
               strokeColor=ACCENT, strokeWidth=0.9, strokeDashArray=[3, 2]))
    d.add(String(bx + bw / 2, band_y + band_h / 2 + 5, "YOUR HEADER",
                 fontName="Helvetica-Bold", fontSize=7.5, fillColor=ACCENT,
                 textAnchor="middle"))
    d.add(String(bx + bw / 2, band_y + band_h / 2 - 6, "~4:1 wide",
                 fontName="Helvetica", fontSize=6.5, fillColor=MUTED,
                 textAnchor="middle"))
    # name placeholders
    d.add(String(bx + bw / 2, by + bh * 0.40, "First",
                 fontName="Helvetica-Bold", fontSize=15, fillColor=INK,
                 textAnchor="middle"))
    d.add(String(bx + bw / 2, by + bh * 0.27, "Last",
                 fontName="Helvetica", fontSize=9, fillColor=INK,
                 textAnchor="middle"))
    d.add(String(bx + bw / 2, by + 9, "Shir Hadash",
                 fontName="Helvetica", fontSize=6.5, fillColor=MUTED,
                 textAnchor="middle"))
    return d


def do_dont():
    do_items = [
        "Solid black (#000000) shapes, icons, and text",
        "Transparent background",
        "Bold, chunky strokes and lettering",
        "Wide, horizontal lock-up (~4:1)",
        "Supply an all-black version of a colour logo",
    ]
    avoid_items = [
        "Colour, gradients, greys, tints, or opacity",
        "Drop shadows, glows, or soft/feathered edges",
        "JPEG &#8212; its background prints as a block",
        "Hairlines and tiny fine detail",
        "Square or tall artwork (prints small)",
    ]
    def col(header, items, mark, mcol, hcol):
        cells = [[Paragraph(header, S("dh", fontName="Helvetica-Bold", fontSize=9.5,
                                      textColor=hcol, leading=12))]]
        for it in items:
            cells.append([Paragraph(
                f'<font color="#{mcol.hexval()[2:]}"><b>{mark}</b></font>&nbsp;&nbsp;{it}',
                listgood)])
        inner = Table(cells, colWidths=[3.05 * inch])
        inner.setStyle(TableStyle([
            ("LEFTPADDING", (0, 0), (-1, -1), 0),
            ("RIGHTPADDING", (0, 0), (-1, -1), 4),
            ("TOPPADDING", (0, 0), (-1, -1), 1.5),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 1.5),
        ]))
        return inner
    do_col = col("DO", do_items, "✔", GOOD, GOOD)
    no_col = col("AVOID", avoid_items, "✘", BAD, BAD)
    wrap = Table([[do_col, no_col]], colWidths=[3.35 * inch, 3.35 * inch])
    wrap.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (0, 0), 0),
        ("LEFTPADDING", (1, 0), (1, 0), 10),
        ("RIGHTPADDING", (0, 0), (-1, -1), 0),
        ("TOPPADDING", (0, 0), (-1, -1), 0),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
    ]))
    return wrap


doc = SimpleDocTemplate(OUT, pagesize=letter,
                        leftMargin=0.62 * inch, rightMargin=0.62 * inch,
                        topMargin=0.55 * inch, bottomMargin=0.5 * inch,
                        title="Custom Badge Header — Artwork Specification")

story = []
story.append(Paragraph("CONGREGATION SHIR HADASH &#183; NAME BADGE PRINTER", kicker))
story.append(Paragraph("Custom Badge Header — Artwork Specification", title))
story.append(HRFlowable(width="100%", thickness=2, color=ACCENT,
                        spaceBefore=4, spaceAfter=6, lineCap="round"))
story.append(Paragraph(
    "This sheet describes how to prepare a graphic that prints as the header at the "
    "top of a name badge. The badges are produced on a Brother QL-820NWB thermal "
    "label printer, which prints <b>black on a white label only</b> — that drives "
    "most of the requirements below.", intro))

# ---- specs + diagram side by side -----------------------------------------
left = [Paragraph("At a glance", h2), spec_table()]
right = [badge_diagram(), Paragraph("Where the header lands on the badge", caphead)]
sd = Table([[left, right]], colWidths=[3.55 * inch, 3.7 * inch])
sd.setStyle(TableStyle([
    ("VALIGN", (0, 0), (-1, -1), "TOP"),
    ("LEFTPADDING", (0, 0), (-1, -1), 0),
    ("RIGHTPADDING", (0, 0), (-1, -1), 0),
    ("ALIGN", (1, 0), (1, 0), "CENTER"),
]))
story.append(sd)
story.append(Spacer(1, 6))

# ---- placement -------------------------------------------------------------
story.append(Paragraph("How your artwork is placed", h2))
story.append(Paragraph(
    "The header sits in a short horizontal band across the top of the badge — about "
    "the top quarter of the badge by its full width. Your image is scaled to fit that "
    "band with its proportions kept intact; it is <b>never cropped or stretched</b>. "
    "A wide ~4:1 graphic fills the band nicely; a square or tall image is shrunk until "
    "its height fits and ends up small and centred, so please design it wide.", body))

# ---- black and white -------------------------------------------------------
story.append(Paragraph("Black &amp; white only — the most important part", h2))
story.append(Paragraph(
    "The printer has <b>no colour and no grey</b>. Every pixel is turned into either "
    "solid black or nothing: the artwork is judged by brightness, and anything darker "
    "than roughly 30% brightness prints as black while everything lighter simply "
    "disappears. There is no shading, dithering, or partial ink. Design in pure black "
    "and white so what you see is what prints.", body))
story.append(Spacer(1, 4))
story.append(do_dont())
story.append(Spacer(1, 7))

# ---- deliverable box -------------------------------------------------------
deliver = Paragraph(
    "<b>Deliver:</b> a transparent <b>PNG</b>, <b>1200&#215;300&nbsp;px</b>, pure black "
    "artwork, under 2&nbsp;MB. If you also have a layered source (AI/SVG/PSD), please "
    "include it so the logo can be re-scaled later if needed.",
    S("deliver", fontName="Helvetica", fontSize=9, textColor=INK, leading=13))
box = Table([[deliver]], colWidths=[7.26 * inch])
box.setStyle(TableStyle([
    ("BACKGROUND", (0, 0), (-1, -1), ACCENT_LT),
    ("BOX", (0, 0), (-1, -1), 0.8, ACCENT),
    ("LEFTPADDING", (0, 0), (-1, -1), 10),
    ("RIGHTPADDING", (0, 0), (-1, -1), 10),
    ("TOPPADDING", (0, 0), (-1, -1), 7),
    ("BOTTOMPADDING", (0, 0), (-1, -1), 7),
]))
story.append(box)
story.append(Spacer(1, 8))
story.append(HRFlowable(width="100%", thickness=0.6, color=RULE, spaceAfter=4))
story.append(Paragraph(
    "Tip: to preview how a design will print, flatten it to pure black on white — if any "
    "element looks light grey, it will not print. Questions about sizing or the band? "
    "Reply to the email that sent you this sheet.", small))

doc.build([KeepInFrame(7.26 * inch, 9.6 * inch, story, mode="shrink")])
print("wrote", OUT)
