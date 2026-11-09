// activate-promissory-note: RPC error -> HTTP answer (design v2 section 3.4.1).
// Run: deno test supabase/functions/activate-promissory-note/mapError_test.ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { mapError } from "./mapError.ts";

const status = (code: string | null, message: string) => mapError({ code, message }).status;

Deno.test("session problems -> 401", () => {
  assertEquals(status("42501", "AUTH_REQUIRED: please sign in to activate this note"), 401);
  assertEquals(status("PGRST301", "JWT expired"), 401);
  assertEquals(status("PGRST302", "anything"), 401);
  assertEquals(status(null, "invalid JWT"), 401);
  // The anon key reached the RPC (no session): only authenticated may execute it.
  assertEquals(status("42501", "permission denied for function activate_promissory_note"), 401);
});

Deno.test("the RPC's own errors map to their statuses, before the generic 42501 check", () => {
  assertEquals(status("P0002", "NOTE_NOT_FOUND"), 404);
  const linked = mapError({ code: "42501", message: "NOTE_LINKED_ELSEWHERE: this note is already linked to another account" });
  assertEquals(linked, { status: 403, body: { error: "This note is already linked to another account", code: "NOTE_LINKED_ELSEWHERE" } });
  const mismatch = mapError({ code: "42501", message: "NOTE_CONTACT_MISMATCH: this note was written for another phone number or email; Partner Ops can link it" });
  assertEquals(mismatch.status, 403);
  assertEquals(mismatch.body.code, "NOTE_CONTACT_MISMATCH");
  assertEquals(mismatch.body.error, "This note was written for another phone number or email. Partner Ops can link it for you.");
  assertEquals(mapError({ code: "22023", message: "NOTE_NOT_OPEN: note is already redeemed" }).body.error, "Note is already redeemed");
  assertEquals(status("22023", "NOTE_NOT_OPEN: note is already cancelled"), 400);
});

Deno.test("races -> 409; anything else -> 500 without the raw message", () => {
  for (const c of ["55P03", "40001", "40P01"]) assertEquals(status(c, "lock timeout"), 409);
  const other = mapError({ code: "XX000", message: "secret internals" });
  assertEquals(other, { status: 500, body: { error: "Activation failed. Please try again.", code: "ACTIVATION_FAILED" } });
  assertEquals(mapError(null).status, 500);
});
