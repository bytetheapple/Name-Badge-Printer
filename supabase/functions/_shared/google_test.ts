//   deno test supabase/functions/_shared/google_test.ts
import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { getAccessToken, pemBody } from "./google.ts";

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
