// Reading a ShulCloud form's own field list, so nobody has to transcribe
// element_30776892 out of a page of HTML.
//
// The codes are numbers a form builder assigned; the labels beside them are
// English written by the congregation. An operator can answer "which box is
// the email address" and cannot reasonably answer "which of these numbers is
// the email address", so the scan asks the page and offers the answer.
//
// Regex rather than a DOM: this runs in an Edge Function, which has no parser,
// and it is the same approach shulcloud-sync already uses on the same markup.

export interface ScannedField {
  /** The submitted name — element_30776892, or element_30776896[] for a group. */
  name: string;
  /** input type, or "select" / "textarea". */
  type: string;
  /** What the page prints beside it, or "" when it prints nothing. */
  label: string;
}

export interface ScannedForm {
  /** The form's id attribute, for the operator to recognise ("form_316106"). */
  formId: string | null;
  fields: ScannedField[];
  /** A proposed mapping, for the operator to confirm rather than construct. */
  suggested: Record<string, string>;
}

const attr = (tag: string, name: string): string | null => {
  const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, "i"));
  return m ? m[1] : null;
};

function decode(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

const text = (html: string) => decode(html.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();

/**
 * The page with its comments removed.
 *
 * Not fastidiousness. A comment that merely mentions a tag is still matched by
 * a regex, and an unclosed one then swallows everything up to the next real
 * closing tag — which cost this scanner the First Name field on its first run,
 * against a comment that said the word "label". Any page may talk about its
 * own markup; none of that is markup.
 */
const uncomment = (html: string) => html.replace(/<!--[\s\S]*?-->/g, " ");

/** Every `<label for=…>` on the page, by the id it points at. */
function labelsById(html: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of html.matchAll(/<label\b([^>]*)>([\s\S]*?)<\/label>/gi)) {
    const forId = attr("<label " + m[1], "for");
    if (forId && !out.has(forId)) out.set(forId, text(m[2]));
  }
  return out;
}

/**
 * The form that carries the visitor fields.
 *
 * Picked by the shape of its field names, not by position or size. The page
 * this was written against has five forms — a login, two Google search boxes,
 * a mailing-list signup and the real one — and exactly one of them names its
 * controls element_NNNN.
 *
 * Deliberately not "the form containing the configured first-name field",
 * which is how shulcloud-sync finds it. That test cannot be used here: it
 * needs the answer this function exists to produce.
 */
function visitorForm(html: string): { inner: string; formId: string | null } | null {
  for (const seg of html.split(/<form\b/i).slice(1)) {
    const whole = "<form " + seg;
    const inner = whole.split(/<\/form>/i)[0];
    if (/name\s*=\s*["']element_\d+/i.test(inner)) {
      return { inner, formId: attr(inner.slice(0, inner.indexOf(">") + 1), "id") };
    }
  }
  return null;
}

/** Which visitor detail a field looks like, from its type and its label. */
function suggest(fields: ScannedField[]): Record<string, string> {
  const out: Record<string, string> = {};
  const take = (key: string, pick: (f: ScannedField) => boolean) => {
    if (out[key]) return;
    const hit = fields.find((f) => !Object.values(out).includes(f.name) && pick(f));
    if (hit) out[key] = hit.name;
  };
  // Type first where the markup states it outright, then the label. An
  // input the page itself calls type="email" is better evidence than any
  // wording, and needs no guess about language or punctuation.
  take("field_email", (f) => f.type === "email");
  take("field_phone", (f) => f.type === "tel");
  take("field_first", (f) => /\bfirst\b/i.test(f.label));
  take("field_last", (f) => /\blast\b|\bsurname\b/i.test(f.label));
  take("field_email", (f) => /e-?mail/i.test(f.label));
  take("field_phone", (f) => /phone|mobile|cell/i.test(f.label));
  return out;
}

export function scanForm(raw: string): ScannedForm | null {
  const html = uncomment(raw);
  const form = visitorForm(html);
  if (!form) return null;

  const labels = labelsById(html);
  const fields: ScannedField[] = [];
  const seen = new Set<string>();

  for (const m of form.inner.matchAll(/<(input|select|textarea)\b([^>]*)>/gi)) {
    const tag = `<${m[1]} ${m[2]}>`;
    const name = attr(tag, "name");
    if (!name || !name.startsWith("element_")) continue;

    const type = (m[1].toLowerCase() === "input" ? attr(tag, "type") ?? "text" : m[1]).toLowerCase();
    // Hidden inputs are the form's own bookkeeping — form_id, sccsrf and an
    // empty element_. Offering them would bury four real choices in noise.
    if (type === "hidden" || type === "submit" || type === "button") continue;
    // A checkbox group shares one name across every box; it is one field.
    if (seen.has(name)) continue;
    seen.add(name);

    const id = attr(tag, "id");
    // A group's own label points at the stem: the boxes are
    // form_316106-element-9-0, -1, -2 … and the label says element-9. Without
    // this the seven interest checkboxes arrive with no label at all, or —
    // worse — wearing the text of whichever box happened to be first, which
    // reads as a field called "Adult Education & Learning".
    const stem = id?.replace(/-\d+$/, "");
    const label = (id && labels.get(id)) || (stem && labels.get(stem)) || "";
    fields.push({ name, type, label });
  }

  return { formId: form.formId, fields, suggested: suggest(fields) };
}
