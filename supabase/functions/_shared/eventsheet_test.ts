//   deno test --allow-read --allow-env supabase/functions/_shared/
//
// Matching somebody at a registration desk against a pre-registration list.
//
// Worth pinning tightly, because both ways of being wrong are expensive and
// neither is visible at the desk. A missed match records a guest who paid in
// advance as a walk-in and prints ON-SITE on their badge, so an administrator
// asks them for money they have already given. A false match checks off
// somebody else and lets a stranger through as pre-registered.
import { assertEquals } from "jsr:@std/assert@1";
import { emailKey, findAttendee, nameKey, phoneKey } from "./eventsheet.ts";

Deno.test("a phone number matches however it was typed", () => {
  // A sheet is typed by a person and the form formats as you type. Comparing
  // those literally never matches.
  assertEquals(phoneKey("(555)123-4567"), "5551234567");
  assertEquals(phoneKey("555-123-4567"), "5551234567");
  assertEquals(phoneKey("+1 555 123 4567"), "5551234567");
  assertEquals(phoneKey("15551234567"), "5551234567");
  assertEquals(phoneKey(""), "");
});

Deno.test("email and name are compared without case or padding", () => {
  assertEquals(emailKey("  Miriam@Example.COM "), "miriam@example.com");
  assertEquals(nameKey(" Miriam ", "Rosenbaum"), "miriam rosenbaum");
});

/** Stand in for the Sheets API with a fixed pre-registration tab. */
function sheetOf(rows: string[][]) {
  const original = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("/values/")) {
      return Promise.resolve(
        new Response(JSON.stringify({ values: rows }), { status: 200 }),
      );
    }
    return Promise.resolve(new Response("{}", { status: 200 }));
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

const LIST = [
  // First | Last | Cell | Email | Checked in
  ["Dan", "Cohen", "", "dan@example.com", ""],
  ["Miriam", "Rosenbaum", "(555)123-4567", "miriam@example.com", ""],
  ["Dan", "Cohen", "555 987 6543", "", ""],
  ["Ruth", "Levy", "", "", "2026-09-05T18:00:00Z"],
];

Deno.test("a phone match wins wherever it sits in the sheet", async () => {
  const restore = sheetOf(LIST);
  try {
    // Two Dan Cohens is ordinary at one event. The one with the matching phone
    // is the right one even though a name match sits above it.
    const hit = await findAttendee("t", "s", {
      first_name: "Dan",
      last_name: "Cohen",
      phone: "(555)987-6543",
      email: "someone-else@example.com",
    });
    assertEquals(hit?.on, "phone");
    assertEquals(hit?.row, 4); // third data row, plus the header
  } finally {
    restore();
  }
});

Deno.test("no phone on the list falls through to email", async () => {
  const restore = sheetOf(LIST);
  try {
    // The organizer never collected phone numbers for this guest. Email is
    // the next best evidence and must not be skipped just because the person
    // in front of us did give a phone.
    const hit = await findAttendee("t", "s", {
      first_name: "Daniel",
      last_name: "Cohen",
      phone: "(555)000-0000",
      email: "dan@example.com",
    });
    assertEquals(hit?.on, "email");
    assertEquals(hit?.row, 2);
  } finally {
    restore();
  }
});

Deno.test("neither on the list falls through to first and last name", async () => {
  const restore = sheetOf(LIST);
  try {
    const hit = await findAttendee("t", "s", {
      first_name: "miriam",
      last_name: "ROSENBAUM",
      phone: "(555)000-0000",
      email: "new-address@example.com",
    });
    assertEquals(hit?.on, "name");
    assertEquals(hit?.row, 3);
  } finally {
    restore();
  }
});

Deno.test("a blank field never matches a blank cell", async () => {
  // The failure this exists to prevent: an empty phone compared against an
  // empty phone checks off the first incomplete row in the sheet, which is
  // somebody else entirely.
  const restore = sheetOf([["", "", "", "", ""], ["Ruth", "Levy", "", "", ""]]);
  try {
    const hit = await findAttendee("t", "s", {
      first_name: "Sara",
      last_name: "Green",
      phone: "",
      email: "",
    });
    assertEquals(hit, null);
  } finally {
    restore();
  }
});

Deno.test("somebody not on the list is not on the list", async () => {
  const restore = sheetOf(LIST);
  try {
    const hit = await findAttendee("t", "s", {
      first_name: "Sara",
      last_name: "Green",
      phone: "(555)222-3333",
      email: "sara@example.com",
    });
    assertEquals(hit, null);
  } finally {
    restore();
  }
});

Deno.test("an existing check-in time is reported, not overwritten", async () => {
  const restore = sheetOf(LIST);
  try {
    // People lose badges and come back. Reprinting is fine; moving their
    // arrival time to the second visit is not.
    const hit = await findAttendee("t", "s", {
      first_name: "Ruth",
      last_name: "Levy",
      phone: "",
      email: "",
    });
    assertEquals(hit?.on, "name");
    assertEquals(hit?.already, true);
  } finally {
    restore();
  }
});

Deno.test("a short sheet row does not throw", async () => {
  // Google omits trailing empty cells, so a row that has only a name comes
  // back as an array of length two.
  const restore = sheetOf([["Ruth", "Levy"]]);
  try {
    const hit = await findAttendee("t", "s", {
      first_name: "Ruth",
      last_name: "Levy",
      phone: "(555)111-2222",
      email: "ruth@example.com",
    });
    assertEquals(hit?.on, "name");
    assertEquals(hit?.already, false);
  } finally {
    restore();
  }
});
