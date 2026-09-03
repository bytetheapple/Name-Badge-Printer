//   deno test --allow-read --allow-env supabase/functions/_shared/
import { assertEquals } from "jsr:@std/assert@1";
import { anyKnown, colName, COLUMNS, rowFor, sheetId, valuesFor } from "./sheetrow.ts";

const ENTRY = {
  first_name: "Ada",
  last_name: "Lovelace",
  email: "ada@example.org",
  phone: "555-0100",
  created_at: "2026-09-02T18:30:00Z",
  selfie_link: "https://drive.google.com/file/d/abc/view",
  printer: { name: "Lobby" },
};

Deno.test("takes the id out of a pasted address, or a bare id", () => {
  assertEquals(
    sheetId("https://docs.google.com/spreadsheets/d/1AbC-_dEfG12345678901/edit#gid=0"),
    "1AbC-_dEfG12345678901",
  );
  assertEquals(sheetId("1AbC-_dEfG12345678901"), "1AbC-_dEfG12345678901");
  assertEquals(sheetId("  "), null);
  assertEquals(sheetId("https://example.org/not-a-sheet"), null);
});

Deno.test("writes each value under its own heading", () => {
  assertEquals(rowFor([...COLUMNS], ENTRY), [
    "2026-09-02T18:30:00Z",
    "Ada",
    "Lovelace",
    "ada@example.org",
    "555-0100",
    "Lobby",
    "https://drive.google.com/file/d/abc/view",
  ]);
});

Deno.test("follows the sheet when the congregation reorders it", () => {
  // The whole reason this maps by heading. Writing by position would put the
  // phone number under Email here, silently, on every visitor after the change.
  assertEquals(rowFor(["Email", "First name"], ENTRY), ["ada@example.org", "Ada"]);
});

Deno.test("leaves a column of their own alone, without shifting the rest", () => {
  const row = rowFor(["First name", "Notes", "Email"], ENTRY);
  assertEquals(row, ["Ada", "", "ada@example.org"]);
  // The row must stay as wide as the header. Skipping the unknown column
  // instead of blanking it would slide Email one cell to the left.
  assertEquals(row.length, 3);
});

Deno.test("headings are matched however they are typed", () => {
  assertEquals(rowFor(["  EMAIL  ", "first NAME"], ENTRY), ["ada@example.org", "Ada"]);
});

Deno.test("a missing value is an empty cell, not the word null", () => {
  const bare = { ...ENTRY, last_name: null, phone: null, selfie_link: null, printer: null };
  assertEquals(rowFor(["Last name", "Phone", "Selfie", "Printer"], bare), ["", "", "", ""]);
});

Deno.test("a selfie that has not arrived yet leaves the cell empty", () => {
  // It is filled in later: the photo uploads after the sign-in is submitted,
  // so at append time there is genuinely nothing to write.
  assertEquals(valuesFor({ ...ENTRY, selfie_link: null })["selfie"], "");
});

Deno.test("a sheet with none of our headings is recognised as such", () => {
  assertEquals(anyKnown(["Name", "Notes", "Amount"]), false);
  assertEquals(anyKnown(["Notes", "Email"]), true);
  assertEquals(anyKnown([]), false);
});

Deno.test("column names carry past Z", () => {
  assertEquals(colName(0), "A");
  assertEquals(colName(25), "Z");
  assertEquals(colName(26), "AA");
  assertEquals(colName(51), "AZ");
  assertEquals(colName(52), "BA");
});
