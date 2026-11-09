// Phone proof for promissory-note linking (Partner Returns Phase 4, F2).
// Run: deno test supabase/functions/_shared/phoneProof_test.ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { phoneProofRow, recordPhoneProofAndLink } from "./phoneProof.ts";

const USER = "11111111-2222-3333-4444-555555555555";

type Answer = { data?: unknown; error?: { message?: string } | null };
function fake(opts: { insert?: () => Answer; rpc?: () => Answer; throwInsert?: boolean } = {}) {
  const calls: { inserts: { table: string; rows: unknown }[]; rpc: { name: string; args: unknown }[] } = { inserts: [], rpc: [] };
  return {
    calls,
    from(table: string) {
      return {
        insert(rows: unknown) {
          calls.inserts.push({ table, rows });
          if (opts.throwInsert) throw new Error("network");
          return Promise.resolve(opts.insert ? opts.insert() : { error: null });
        },
      };
    },
    rpc(name: string, args: unknown) {
      calls.rpc.push({ name, args });
      return Promise.resolve(opts.rpc ? opts.rpc() : { data: 1, error: null });
    },
  };
}

const req = new Request("https://x.test", {
  headers: { origin: "https://welile.app", "x-forwarded-for": "1.2.3.4, 5.6.7.8", "user-agent": "UA" },
});

Deno.test("phoneProofRow: an otp_login_audit success row bound to the user, the number and the stage", () => {
  assertEquals(phoneProofRow({ userId: USER, phone: "256771234567", stage: "phone_signup" }, req), {
    phone: "256771234567",
    resolved_user_id: USER,
    outcome: "success",
    stage: "phone_signup",
    reason: "sms_code_verified",
    origin: "https://welile.app",
    ip_address: "1.2.3.4",
    user_agent: "UA",
    metadata: { proof: "promissory_note_contact", source: "phone_signup" },
  });
  const noReq = phoneProofRow({ userId: USER, phone: "+256771234567", stage: "first_phone" }, null);
  assertEquals([noReq?.origin, noReq?.ip_address, noReq?.user_agent, noReq?.stage], [null, null, null, "first_phone"]);
});

Deno.test("phoneProofRow: no row without a user id or a 9-digit number", () => {
  assertEquals(phoneProofRow({ userId: "", phone: "256771234567", stage: "phone_signup" }, null), null);
  assertEquals(phoneProofRow({ userId: "not-a-uuid", phone: "256771234567", stage: "phone_signup" }, null), null);
  assertEquals(phoneProofRow({ userId: USER, phone: "07712", stage: "phone_confirm" }, null), null);
});

Deno.test("recordPhoneProofAndLink: one insert, then the owner-run linker for that user", async () => {
  const c = fake({ rpc: () => ({ data: 2, error: null }) });
  assertEquals(await recordPhoneProofAndLink(c, { userId: USER, phone: "256771234567", stage: "phone_confirm" }, null), {
    proofRecorded: true,
    linked: 2,
  });
  assertEquals(c.calls.inserts.map((i) => i.table), ["otp_login_audit"]);
  assertEquals(c.calls.rpc, [{ name: "link_promissory_notes_for_user", args: { p_user: USER } }]);
});

Deno.test("recordPhoneProofAndLink: no proof -> no link; failures never throw", async () => {
  const bad = fake();
  assertEquals(await recordPhoneProofAndLink(bad, { userId: "x", phone: "1", stage: "phone_signup" }, null), { proofRecorded: false, linked: null });
  assertEquals([bad.calls.inserts.length, bad.calls.rpc.length], [0, 0]);

  const insertErr = fake({ insert: () => ({ error: { message: "denied" } }) });
  assertEquals(await recordPhoneProofAndLink(insertErr, { userId: USER, phone: "256771234567", stage: "phone_signup" }, null), { proofRecorded: false, linked: null });
  assertEquals(insertErr.calls.rpc.length, 0);

  const thrown = fake({ throwInsert: true });
  assertEquals(await recordPhoneProofAndLink(thrown, { userId: USER, phone: "256771234567", stage: "phone_signup" }, null), { proofRecorded: false, linked: null });
  assertEquals(thrown.calls.rpc.length, 0);

  const linkErr = fake({ rpc: () => ({ data: null, error: { message: "permission denied" } }) });
  assertEquals(await recordPhoneProofAndLink(linkErr, { userId: USER, phone: "256771234567", stage: "first_phone" }, null), { proofRecorded: true, linked: null });
});
