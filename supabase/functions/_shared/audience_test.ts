//   deno test --allow-read --allow-env supabase/functions/_shared/
import { assertEquals } from "jsr:@std/assert@1";
import { audienceAllows, audienceOf } from "./integration.ts";

const interested = { visitor_type: "visitor", wants_followup: true };
const visitor = { visitor_type: "visitor", wants_followup: false };
const member = { visitor_type: "member", wants_followup: false };

const takes = (audience: unknown, entry: Parameters<typeof audienceAllows>[1]) =>
  audienceAllows(audience === undefined ? {} : { audience }, entry).ok;

Deno.test("an unset destination takes only the visitors who asked", () => {
  // The default matters more than the others: it is what every destination
  // configured before this existed will read as, and the wrong default here
  // sends people who declined.
  assertEquals(audienceOf({}), "interested");
  assertEquals(takes(undefined, interested), true);
  assertEquals(takes(undefined, visitor), false);
  assertEquals(takes(undefined, member), false);
});

Deno.test("anything unrecognised falls back to the narrowest", () => {
  // Including a value someone typed into the config by hand. Widening who is
  // sent must never be the result of a spelling mistake.
  assertEquals(audienceOf({ audience: "everyone" }), "interested");
  assertEquals(audienceOf({ audience: "" }), "interested");
  assertEquals(takes("EVERYONE", member), false);
});

Deno.test("all visitors means whether or not they asked", () => {
  assertEquals(takes("visitors", interested), true);
  assertEquals(takes("visitors", visitor), true);
  assertEquals(takes("visitors", member), false);
});

Deno.test("all sign-ins includes members", () => {
  assertEquals(takes("all", interested), true);
  assertEquals(takes("all", visitor), true);
  assertEquals(takes("all", member), true);
});

Deno.test("a refusal says which rule refused it", () => {
  const m = audienceAllows({ audience: "visitors" }, member);
  assertEquals(m.ok, false);
  if (!m.ok) assertEquals(m.reason.includes("member"), true);

  const v = audienceAllows({}, visitor);
  assertEquals(v.ok, false);
  if (!v.ok) assertEquals(v.reason.includes("did not ask"), true);
});

Deno.test("a missing visitor_type is not treated as a visitor", () => {
  assertEquals(takes("visitors", { wants_followup: true }), false);
  assertEquals(takes("all", { wants_followup: true }), true);
});
