// Runs against markup taken from a real ShulCloud form:
//   deno test --allow-read supabase/functions/_shared/formscan_test.ts
import { assert, assertEquals } from "jsr:@std/assert@1";
import { scanForm } from "./formscan.ts";

const html = await Deno.readTextFile(
  new URL("./testdata/shulcloud_welcome.html", import.meta.url),
);

Deno.test("picks the visitor form out of five on the page", () => {
  const r = scanForm(html)!;
  assert(r, "no form found");
  // A login form, two Google search boxes and a mailing-list signup share the
  // page. Choosing by size or position would eventually choose one of those.
  assertEquals(r.formId, "form_316106");
});

Deno.test("offers the fields by their labels, not their codes", () => {
  const r = scanForm(html)!;
  const byName = Object.fromEntries(r.fields.map((f) => [f.name, f.label]));
  assertEquals(byName["element_30776892"], "* First Name");
  assertEquals(byName["element_30776893"], "* Last Name");
  assertEquals(byName["element_30776894"], "* Email Address");
  assertEquals(byName["element_30776895"], "* Phone Number");
});

Deno.test("proposes the mapping so it is confirmed, not constructed", () => {
  const { suggested } = scanForm(html)!;
  assertEquals(suggested.field_first, "element_30776892");
  assertEquals(suggested.field_last, "element_30776893");
  // These two come from type="email" and type="tel", which the page states
  // outright — better evidence than any wording, and no guess about language.
  assertEquals(suggested.field_email, "element_30776894");
  assertEquals(suggested.field_phone, "element_30776895");
});

Deno.test("leaves out the form's own bookkeeping", () => {
  const names = scanForm(html)!.fields.map((f) => f.name);
  // form_id, form_name, sccsrf and an empty element_ are hidden inputs. Four
  // real choices buried in bookkeeping is the failure this replaces.
  assert(!names.includes("sccsrf"), names.join(","));
  assert(!names.includes("form_id"), names.join(","));
  assert(!names.some((n) => n === "element_"), names.join(","));
});

Deno.test("a checkbox group is one field, not seven", () => {
  const fields = scanForm(html)!.fields;
  const group = fields.filter((f) => f.name === "element_30776896[]");
  assertEquals(group.length, 1);
  // And it is still offered: a congregation may well want to record what a
  // visitor said they were interested in. Today nothing can, because the four
  // config keys are all there are.
  assert(group[0].label.length > 0, "the group lost its label");
});

Deno.test("a page with no such form is not forced into one", () => {
  // Answering with the login form would map a visitor's email onto somebody's
  // password box. Nothing is the correct answer.
  assertEquals(scanForm("<html><form action=/login><input name=email></form></html>"), null);
});

Deno.test("a comment mentioning a tag does not eat the field after it", () => {
  // How this was found: the fixture's own header comment used the word for a
  // label element, the regex matched it, and the non-greedy scan then ran to
  // the next real closing tag — swallowing First Name whole. Any page may
  // discuss its own markup.
  const r = scanForm(
    '<!-- a label element, described --><form>' +
      '<label for="a">Email Address</label><input id="a" name="element_9" type="text">' +
      "</form>",
  )!;
  assertEquals(r.fields[0].label, "Email Address");
});

Deno.test("a group is labelled by its own label, not by its first option", () => {
  const { fields } = scanForm(html)!;
  const group = fields.find((f) => f.name === "element_30776896[]")!;
  // The boxes are …element-9-0, -1, -2 and the label points at …element-9.
  // Falling back to the nearest text would title the field "Adult Education
  // & Learning", which is one of its options.
  assertEquals(group.label, "* Some of my interests include:");
});

Deno.test("a field with no label is offered by code rather than by a guess", () => {
  const r = scanForm(
    '<form><input name="element_1" type="text"><label for="x">Nowhere</label></form>',
  )!;
  assertEquals(r.fields[0].label, "");
  assertEquals(r.suggested.field_first, undefined);
});
