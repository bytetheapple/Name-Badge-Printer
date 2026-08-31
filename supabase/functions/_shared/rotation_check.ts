// Does a credential need replacing? Run: deno run _shared/rotation_check.ts
//
// A pure decision, tested on its own, because getting it wrong does not fail —
// it succeeds too often. The first version rotated on every poll and minted a
// hundred credentials in seven minutes before anyone noticed.
import { rotationDue } from "./rotation.ts";

const DAY = 86_400_000;
const now = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();

const base = {
  id: "t", org_id: "o", name: "n", printer_ids: null,
  superseded_at: null, superseded_by: null, rotation_failed_at: null,
};

const cases: Array<[string, Record<string, unknown>, boolean]> = [
  ["the imaged value, never used, is retired on contact",
   { ...base, first_used_at: null, replaces: null, created_at: iso(now - DAY) }, true],

  ["a replacement the device has just stored is NOT rotated again",
   { ...base, first_used_at: null, replaces: "prev", created_at: iso(now - 1000) }, false],

  ["a replacement in service is left alone",
   { ...base, first_used_at: iso(now - DAY), replaces: "prev", created_at: iso(now - DAY) }, false],

  ["a credential past its life is renewed",
   { ...base, first_used_at: iso(now - 100 * DAY), replaces: "prev",
     created_at: iso(now - 100 * DAY) }, true],

  ["a recent failure backs off instead of retrying every poll",
   { ...base, first_used_at: null, replaces: null, created_at: iso(now - DAY),
     rotation_failed_at: iso(now - 60_000) }, false],
];

let bad = 0;
for (const [label, row, want] of cases) {
  // deno-lint-ignore no-explicit-any
  const got = rotationDue(row as any, now);
  if (got === want) console.log(`  ok    ${label}`);
  else {
    bad++;
    console.log(`  FAIL  ${label} (wanted ${want}, got ${got})`);
  }
}
console.log(bad ? `\nRESULT: ${bad} failure(s)` : "\nRESULT: all checks passed");
if (bad) Deno.exit(1);
