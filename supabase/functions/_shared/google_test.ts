//   deno test supabase/functions/_shared/google_test.ts
import { assertEquals, assertRejects, assertStringIncludes } from "jsr:@std/assert@1";
import { explainGoogleError, getAccessToken, pemBody } from "./google.ts";

// Not a real key: base64 of "hello-there-a-key", padded to look the part.
const B64 = "aGVsbG8tdGhlcmUtYS1rZXk=";

Deno.test("accepts a key with real newlines", () => {
  assertEquals(
    pemBody(`-----BEGIN PRIVATE KEY-----\n${B64}\n-----END PRIVATE KEY-----\n`),
    B64,
  );
});

Deno.test("accepts a key copied straight out of the JSON file", () => {
  // The one that actually happens: the newlines are the two characters
  // backslash-n, which survive a whitespace strip and corrupt the base64.
  assertEquals(
    pemBody("-----BEGIN PRIVATE KEY-----\\n" + B64 + "\\n-----END PRIVATE KEY-----\\n"),
    B64,
  );
});

Deno.test("accepts it without the BEGIN and END lines", () => {
  assertEquals(pemBody(B64), B64);
  assertEquals(pemBody(`  ${B64}  `), B64);
});

Deno.test("accepts it wrapped across lines, as PEM usually is", () => {
  assertEquals(pemBody(`-----BEGIN PRIVATE KEY-----\naGVsbG8t\ndGhlcmUt\nYS1rZXk=\n-----END PRIVATE KEY-----`), B64);
});

Deno.test("an empty key is empty rather than something that fails later", () => {
  assertEquals(pemBody(""), "");
  assertEquals(pemBody("-----BEGIN PRIVATE KEY-----\n-----END PRIVATE KEY-----"), "");
});

Deno.test("a mangled key says so, instead of InvalidCharacterError", async () => {
  // Through the real path: pemToPkcs8 throws inside getAccessToken, before any
  // network call, so this is the message an operator would actually be shown.
  await assertRejects(
    () => getAccessToken("svc@example.iam.gserviceaccount.com", "!!! not a key !!!", "scope"),
    Error,
    "not valid base64",
  );
});

Deno.test("an empty key is refused by name", async () => {
  await assertRejects(
    () => getAccessToken("svc@example.iam.gserviceaccount.com", "", "scope"),
    Error,
    "empty",
  );
});

const SA = "guestbadgeprinter@guest-badge-printer.iam.gserviceaccount.com";

// The body Google actually returned, trimmed. Kept verbatim because the whole
// point is reading what it says rather than assuming what a 403 means.
const SERVICE_DISABLED = {
  error: {
    code: 403,
    message:
      "Google Sheets API has not been used in project 1031003591147 before or it is " +
      "disabled. Enable it by visiting https://console.developers.google.com/apis/api/" +
      "sheets.googleapis.com/overview?project=1031003591147 then retry.",
    status: "PERMISSION_DENIED",
    details: [{
      reason: "SERVICE_DISABLED",
      domain: "googleapis.com",
      metadata: { service: "sheets.googleapis.com", consumer: "projects/1031003591147" },
    }],
  },
};

const NOT_SHARED = {
  error: {
    code: 403,
    message: "The caller does not have permission",
    status: "PERMISSION_DENIED",
    details: [{ reason: "PERMISSION_DENIED", domain: "googleapis.com" }],
  },
};

Deno.test("an API that is switched off is not reported as an unshared sheet", () => {
  // What happened in the field: this was answered with "press Share and give
  // this address Editor access", which cannot possibly have helped.
  const out = explainGoogleError(403, SERVICE_DISABLED, SA);
  assertStringIncludes(out, "not switched on");
  assertStringIncludes(out, "1031003591147");
  assertStringIncludes(out, "Enabling Drive does not enable Sheets");
  assertEquals(out.includes("press Share"), false);
});

Deno.test("a genuinely unshared sheet still names the address to share with", () => {
  const out = explainGoogleError(403, NOT_SHARED, SA);
  assertStringIncludes(out, "Share");
  assertStringIncludes(out, SA);
  assertEquals(out.includes("not switched on"), false);
});

Deno.test("a wrong or deleted link is told apart from a permission problem", () => {
  const out = explainGoogleError(404, { error: { message: "Requested entity was not found." } }, SA);
  assertStringIncludes(out, "No sheet with that address");
});

Deno.test("a rejected service account points at the credentials, not the sheet", () => {
  const out = explainGoogleError(401, { error: { message: "Invalid Credentials" } }, SA);
  assertStringIncludes(out, SA);
  assertStringIncludes(out, "same service account JSON");
});

Deno.test("an unrecognised failure repeats what Google said rather than inventing", () => {
  assertEquals(
    explainGoogleError(500, { error: { message: "Internal error encountered." } }, SA),
    "Internal error encountered.",
  );
  assertStringIncludes(explainGoogleError(503, {}, SA), "HTTP 503");
});
