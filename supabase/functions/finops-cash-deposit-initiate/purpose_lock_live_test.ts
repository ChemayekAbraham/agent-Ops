// LIVE integration test — OFF by default. Never runs unless switched on by hand.
//
// What it checks: a signed-in Financial Ops request that tries to record a
// cash deposit as "personal_deposit" is stored as "operational_float", and the
// attempted override is written to purpose_audit.requested_purpose_ignored.
//
// WARNING: preview and live share one database. Running this creates a REAL
// pending deposit request and sends a REAL SMS + email code to the test
// depositor. Use a dedicated test account. Nothing is credited: the deposit
// stays pending until someone enters the code, so let the code expire.
//
// To run, set ALL of:
//   RUN_LIVE_FINOPS_DEPOSIT_TEST=1
//   FINOPS_TEST_JWT     access token of a Financial Ops user
//   FINOPS_TEST_PHONE   phone of a dedicated test depositor account
//   FINOPS_TEST_EMAIL   email to receive the test code
import "https://deno.land/std@0.224.0/dotenv/load.ts";
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const enabled = Deno.env.get("RUN_LIVE_FINOPS_DEPOSIT_TEST") === "1";

Deno.test({
  name: "finops-cash-deposit-initiate ignores a personal_deposit override and records it in the audit trail",
  ignore: !enabled,
  async fn() {
    const url = Deno.env.get("VITE_SUPABASE_URL")!;
    const anon = Deno.env.get("VITE_SUPABASE_PUBLISHABLE_KEY")!;
    const jwt = Deno.env.get("FINOPS_TEST_JWT");
    const phone = Deno.env.get("FINOPS_TEST_PHONE");
    const email = Deno.env.get("FINOPS_TEST_EMAIL");
    assert(jwt && phone && email, "FINOPS_TEST_JWT, FINOPS_TEST_PHONE and FINOPS_TEST_EMAIL are required");

    const res = await fetch(`${url}/functions/v1/finops-cash-deposit-initiate`, {
      method: "POST",
      headers: { Authorization: `Bearer ${jwt}`, apikey: anon, "Content-Type": "application/json" },
      body: JSON.stringify({
        amount: 500,
        phone,
        email,
        send_email: true,
        cash_owner_name: "Integration Test Owner",
        cash_location: "cash_at_hand",
        reason: "Automated purpose-lock integration test",
        deposit_purpose: "personal_deposit", // the override the server must ignore
      }),
    });
    const payload = await res.json();
    assertEquals(res.status, 200, `unexpected response: ${JSON.stringify(payload)}`);
    const depositId = payload.deposit_request_id as string;
    assert(depositId, "response has no deposit_request_id");

    const db = createClient(url, anon, {
      global: { headers: { Authorization: `Bearer ${jwt}` } },
      auth: { persistSession: false },
    });
    const { data: row, error } = await db
      .from("deposit_requests")
      .select("deposit_purpose, purpose_audit, status")
      .eq("id", depositId)
      .single();
    assert(!error, `could not read deposit ${depositId}: ${error?.message}`);

    const audit = (row as any).purpose_audit ?? {};
    assertEquals((row as any).deposit_purpose, "operational_float");
    assertEquals((row as any).status, "pending");
    assertEquals(audit.chosen_purpose, "operational_float");
    assertEquals(audit.requested_purpose_ignored, "personal_deposit");
    assertEquals(audit.entry_point, "finops_cash_code_sms");
  },
});
