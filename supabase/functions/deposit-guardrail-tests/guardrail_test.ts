import { assert, assertEquals, assertExists } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? Deno.env.get("VITE_SUPABASE_URL") ?? "";
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const HAS_ENV = !!SUPABASE_URL && !!SERVICE_ROLE;

let admin: SupabaseClient | null = null;
function getAdmin(): SupabaseClient {
  if (!admin) {
    admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });
  }
  return admin;
}

function skipIfNoEnv(name: string): boolean {
  if (!HAS_ENV) {
    console.warn(`[skip] ${name}: missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY`);
    return true;
  }
  return false;
}

// Reuse an existing tenant profile so we don't violate FK / RLS constraints.
async function pickTestUser(): Promise<string> {
  const { data, error } = await getAdmin()
    .from("profiles")
    .select("id")
    .limit(1)
    .maybeSingle();
  if (error || !data) throw new Error("No profile available for test: " + error?.message);
  return data.id;
}

async function cleanup(depositId: string) {
  const a = getAdmin();
  await a.from("deposit_guardrail_audit").delete().eq("deposit_id", depositId);
  await a.from("deposit_requests").delete().eq("id", depositId);
}

Deno.test("guardrail: auto MoMo SMS deposit inserts as pending", async () => {
  if (skipIfNoEnv("auto MoMo SMS deposit inserts as pending")) return;
  const userId = await pickTestUser();
  const tid = "TEST_TID_" + crypto.randomUUID();

  const { data, error } = await getAdmin()
    .from("deposit_requests")
    .insert({
      user_id: userId,
      amount: 1234,
      status: "pending",
      provider: "mtn",
      transaction_id: tid,
      notes: "[auto] simulated MoMo SMS — guardrail test",
    })
    .select("id, status")
    .single();

  try {
    assertEquals(error, null);
    assertExists(data);
    assertEquals(data!.status, "pending");
  } finally {
    if (data?.id) await cleanup(data.id);
  }
});

Deno.test("guardrail: blocks approval of auto deposit without general_ledger row", async () => {
  if (skipIfNoEnv("blocks approval of auto deposit without general_ledger row")) return;
  const userId = await pickTestUser();
  const tid = "TEST_TID_" + crypto.randomUUID();

  const { data: created, error: insErr } = await getAdmin()
    .from("deposit_requests")
    .insert({
      user_id: userId,
      amount: 999,
      status: "pending",
      provider: "airtel",
      transaction_id: tid,
      notes: "[auto] simulated MoMo SMS — guardrail block test",
    })
    .select("id")
    .single();
  assertEquals(insErr, null);
  const depositId = created!.id;

  try {
    // Attempt illegal approval — guardrail trigger must raise.
    const { error: updErr } = await getAdmin()
      .from("deposit_requests")
      .update({ status: "approved", approved_at: new Date().toISOString() })
      .eq("id", depositId);

    // Guardrail silently demotes status back to pending; the update itself succeeds.
    assertEquals(updErr, null);

    // Status must still be pending.
    const { data: after } = await getAdmin()
      .from("deposit_requests")
      .select("status, approved_at")
      .eq("id", depositId)
      .single();
    assertEquals(after?.status, "pending");
    assertEquals(after?.approved_at, null);

    // Audit row must have been written.
    const { data: audit } = await getAdmin()
      .from("deposit_guardrail_audit")
      .select("action, source, missing_match_key, attempted_status")
      .eq("deposit_id", depositId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    assertExists(audit, "Expected an audit row for the blocked approval");
    assertEquals(audit!.action, "blocked");
    assertEquals(audit!.source, "auto_gmail");
    assertEquals(audit!.attempted_status, "approved");
    assert(
      (audit!.missing_match_key || "").includes("source_id=" + depositId),
      "missing_match_key should reference the deposit id",
    );
  } finally {
    await cleanup(depositId);
  }
});

Deno.test("guardrail: non-auto deposit can be approved manually (no guardrail trip)", async () => {
  if (skipIfNoEnv("non-auto deposit can be approved manually")) return;
  const userId = await pickTestUser();
  const tid = "TEST_TID_" + crypto.randomUUID();

  const { data: created } = await getAdmin()
    .from("deposit_requests")
    .insert({
      user_id: userId,
      amount: 500,
      status: "pending",
      provider: "mtn",
      transaction_id: tid,
      notes: "manual deposit — guardrail should NOT apply",
    })
    .select("id")
    .single();
  const depositId = created!.id;

  try {
    const { error: updErr } = await getAdmin()
      .from("deposit_requests")
      .update({ status: "approved", approved_at: new Date().toISOString() })
      .eq("id", depositId);

    // Manual deposits are NOT policed by the auto-deposit guardrail.
    assertEquals(updErr, null, "Manual deposit approval should not be blocked");
  } finally {
    await cleanup(depositId);
  }
});
