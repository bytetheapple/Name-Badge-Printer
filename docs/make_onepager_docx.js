const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  WidthType, BorderStyle, ShadingType, AlignmentType, LevelFormat, TableLayoutType,
} = require("docx");
const fs = require("fs");

// ---- palette (hex, no #) ----
const INK = "1A2140", MUTED = "586181", PRIMARY = "274A8C", ACCENT = "9C6C26";
const PANEL = "F4F6FB", PANEL2 = "EAEEF7", LINE = "DDE3EF", WHITE = "FFFFFF";
const DISPLAY = "Cambria", BODY = "Calibri";

const CONTENT = 10080;             // content width in DXA (Letter, 0.75" margins)
const NONE = { style: BorderStyle.NONE, size: 0, color: "auto" };
const HAIR = { style: BorderStyle.SINGLE, size: 4, color: LINE };
const noBorders = { top: NONE, bottom: NONE, left: NONE, right: NONE, insideH: NONE, insideV: NONE };

const run = (text, o = {}) => new TextRun({ text, font: o.font || BODY, size: o.size || 21, color: o.color || INK, bold: o.bold || false, italics: o.italics || false, characterSpacing: o.spacing });
const P = (children, o = {}) => new Paragraph({ children, spacing: o.spacing, alignment: o.align, border: o.border, keepNext: o.keepNext });

const cell = (children, o = {}) => new TableCell({
  children,
  width: { size: o.width, type: WidthType.DXA },
  columnSpan: o.span,
  shading: o.fill ? { type: ShadingType.CLEAR, color: "auto", fill: o.fill } : undefined,
  margins: { top: o.mt ?? 90, bottom: o.mb ?? 90, left: o.ml ?? 150, right: o.mr ?? 150 },
  borders: o.borders || noBorders,
  verticalAlign: o.valign,
});

// ---------- header ----------
const header = [
  P([run("SYNAGOGUE NAME-TAG PRINTING SYSTEM", { color: ACCENT, bold: true, size: 17, spacing: 30 })], { spacing: { after: 90 } }),
  P([run("Welcome every member and guest, by name.", { font: DISPLAY, bold: true, size: 52, color: INK })], { spacing: { after: 120 } }),
  P([run("A self-service welcome kiosk for your lobby. Visitors and members scan a QR code, type their name, and a printed name badge is ready in seconds — no volunteer at a table, no app to download, no handwriting on sticky labels.", { color: MUTED, size: 22 })],
    { spacing: { after: 160 }, border: { bottom: { style: BorderStyle.SINGLE, size: 8, color: PRIMARY, space: 10 } } }),
  P([run("")], { spacing: { after: 60 } }),
];

// ---------- steps ----------
const stepData = [
  ["1", "Scan", "A QR code by the door opens the sign-in page on any phone."],
  ["2", "Member or guest", "One tap chooses the right flow — members just give a name."],
  ["3", "Enter name", "Name, plus optional details like pronouns or a whole family."],
  ["4", "Badge prints", "A clean, professional name badge prints at the kiosk instantly."],
];
const stepsTable = new Table({
  width: { size: CONTENT, type: WidthType.DXA },
  columnWidths: [2520, 2520, 2520, 2520],
  layout: TableLayoutType.FIXED,
  borders: { ...noBorders, insideV: { style: BorderStyle.SINGLE, size: 4, color: WHITE } },
  rows: [new TableRow({
    children: stepData.map(([n, t, d]) => cell([
      P([run(n, { font: DISPLAY, bold: true, size: 30, color: PRIMARY })], { spacing: { after: 40 } }),
      P([run(t, { font: DISPLAY, bold: true, size: 22, color: INK })], { spacing: { after: 40 } }),
      P([run(d, { color: MUTED, size: 18 })]),
    ], { width: 2520, fill: PANEL, mt: 150, mb: 150, ml: 160, mr: 160 })),
  })],
});

// ---------- features ----------
const sectionLabel = (t) => P([run(t, { color: PRIMARY, bold: true, size: 18, spacing: 26 })],
  { spacing: { before: 220, after: 120 }, border: { bottom: { style: BorderStyle.SINGLE, size: 12, color: "F2E7D2", space: 6 } } });

function featureGroup(title, items) {
  const out = [P([run(title, { font: DISPLAY, bold: true, size: 24, color: INK })], { spacing: { before: 120, after: 40 }, keepNext: true })];
  for (const [main, detail] of items) {
    out.push(new Paragraph({
      numbering: { reference: "dots", level: 0 },
      spacing: { after: 40 },
      children: [run(main + " ", { size: 21, color: INK }), run(detail, { size: 21, color: MUTED })],
    }));
  }
  return out;
}
const features = [
  sectionLabel("What it does"),
  ...featureGroup("Simple and self-service", [
    ["Works on any phone through a QR code —", "nothing to install"],
    ["Separate member and visitor flows,", "each asking only what it needs"],
    ["Family sign-in", "prints a badge for everyone in the household at once"],
  ]),
  ...featureGroup("Warm and inclusive", [
    ["Optional pronouns field", "you can switch on for Pride or any event"],
    ["Your congregation's logo and wording", "on every badge"],
    ["Optional guest photo capture", "for a friendly welcome record"],
  ]),
  ...featureGroup("Easy for the office", [
    ["Attendance log", "with date filters and one-click Excel export"],
    ["Reprint, test-print, and manage printers", "from a simple admin console"],
    ["Run several kiosks", "— lobby, religious school, social hall"],
  ]),
];

// ---------- callout ----------
const callout = new Table({
  width: { size: CONTENT, type: WidthType.DXA },
  columnWidths: [CONTENT],
  layout: TableLayoutType.FIXED,
  borders: noBorders,
  rows: [new TableRow({
    children: [cell([
      P([run("CONNECTS TO YOUR SYSTEMS", { color: ACCENT, bold: true, size: 16, spacing: 24 })], { spacing: { after: 60 } }),
      P([run("Integrates with your member-tracking software.", { font: DISPLAY, bold: true, size: 24, color: INK })], { spacing: { after: 60 } }),
      P([run("Already rolling out new membership or CRM software? Sign-ins can flow straight into it through a simple integration, so your welcome desk and your member records stay in step automatically.", { color: MUTED, size: 21 })]),
    ], {
      width: CONTENT, fill: PANEL2, mt: 160, mb: 160, ml: 220, mr: 220,
      borders: { top: NONE, bottom: NONE, right: NONE, left: { style: BorderStyle.SINGLE, size: 24, color: ACCENT } },
    })],
  })],
});

// ---------- BOM ----------
const BOM_W = 7560, COL1 = 6000, COL2 = 1560;
const bomBorders = { top: HAIR, bottom: HAIR, left: HAIR, right: HAIR, insideH: HAIR, insideV: NONE };
const bandRow = (children, fill) => new TableRow({ children: [cell(children, { span: 2, width: BOM_W, fill, mt: 110, mb: 110, ml: 180, mr: 180 })] });
const groupRow = (label) => new TableRow({
  children: [cell([P([run(label, { color: PRIMARY, bold: true, size: 17, spacing: 20 })])], { span: 2, width: BOM_W, fill: PANEL2, mt: 80, mb: 80, ml: 180, mr: 180 })],
});
const itemRow = (name, detail, price, o = {}) => new TableRow({
  children: [
    cell([new Paragraph({ children: [run(name, { size: 21, bold: o.bold, color: INK }), ...(detail ? [run(detail, { size: 17, color: MUTED, break: 1 })] : [])] })],
      { width: COL1, fill: o.fill, ml: 180, mt: 100, mb: 100 }),
    cell([P([run(price, { size: o.priceSize || 21, bold: true, color: o.priceColor || INK, font: o.priceFont })], { align: AlignmentType.RIGHT })],
      { width: COL2, fill: o.fill, mr: 180, mt: 100, mb: 100 }),
  ],
});
const bomTable = new Table({
  width: { size: BOM_W, type: WidthType.DXA },
  columnWidths: [COL1, COL2],
  layout: TableLayoutType.FIXED,
  alignment: AlignmentType.CENTER,
  borders: bomBorders,
  rows: [
    bandRow([
      P([run("Rough cost breakdown", { font: DISPLAY, bold: true, size: 22, color: WHITE })], { spacing: { after: 20 } }),
      P([run("Indicative pricing (USD)", { size: 16, color: WHITE })]),
    ], PRIMARY),
    groupRow("ONE-TIME INFRASTRUCTURE"),
    itemRow("Raspberry Pi print server", "Drives the printer and connects to the app — shared by every kiosk", "$125"),
    groupRow("PER KIOSK"),
    itemRow("Brother label printer", "QL-820NWB networked label printer", "$250"),
    itemRow("Wall-mount bracket", "Tidy lobby installation", "$100"),
    itemRow("Subtotal per kiosk", null, "$350", { bold: true, fill: PANEL, priceColor: ACCENT, priceFont: DISPLAY, priceSize: 22 }),
    groupRow("ONGOING SUPPLY"),
    itemRow("Roll of name badges", "250 die-cut badges per roll", "$25"),
  ],
});
const bomNote = P([run("Badges are a low-cost consumable — about $25 per roll of 250. The web app runs on inexpensive cloud services with a modest monthly cost.", { size: 17, color: MUTED })],
  { spacing: { before: 100 }, align: AlignmentType.CENTER });

// ---------- CTA ----------
const cta = [
  P([run("")], { spacing: { after: 60 }, border: { top: { style: BorderStyle.SINGLE, size: 8, color: LINE, space: 10 } } }),
  P([run("Bring it to your congregation.", { font: DISPLAY, bold: true, size: 28, color: INK })], { spacing: { before: 120, after: 40 } }),
  P([run("A concept overview — happy to share how it works and help you set one up.  ", { color: MUTED, size: 21 }),
     run("Get in touch: ", { color: INK, bold: true, size: 21 }),
     run("name@yourcongregation.org", { color: PRIMARY, size: 21 })]),
];

const doc = new Document({
  creator: "Name Badge Kiosk",
  title: "Synagogue Name-Tag Kiosk",
  styles: { default: { document: { run: { font: BODY, size: 21, color: INK } } } },
  numbering: {
    config: [{
      reference: "dots",
      levels: [{
        level: 0, format: LevelFormat.BULLET, text: "▪", alignment: AlignmentType.LEFT,
        style: { run: { color: ACCENT }, paragraph: { indent: { left: 300, hanging: 200 } } },
      }],
    }],
  },
  sections: [{
    properties: {
      page: {
        size: { width: 12240, height: 15840 },
        margin: { top: 1080, bottom: 1000, left: 1080, right: 1080 },
      },
    },
    children: [
      ...header,
      stepsTable,
      ...features,
      P([run("")], { spacing: { after: 120 } }),
      callout,
      P([run("")], { spacing: { after: 160 } }),
      bomTable,
      bomNote,
      ...cta,
    ],
  }],
});

Packer.toBuffer(doc).then((buf) => {
  fs.writeFileSync("Synagogue-Name-Tag-Kiosk.docx", buf);
  console.log("wrote Synagogue-Name-Tag-Kiosk.docx", buf.length, "bytes");
});
