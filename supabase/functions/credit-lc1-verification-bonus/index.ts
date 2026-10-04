import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { checkTreasuryGuard } from "../_shared/treasuryGuard.ts";
import { notifyLc1Bonus } from "../_shared/notifyLc1Bonus.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

// Verification leg of the UGX 5,000 LC1 registration reward. Paid to the
// registering agent when Landlord Ops verifies the LC1 chairperson. Also flips
// the chairperson record to verified.
// Full LC1-registration commission. Paid in a SINGLE payment ONLY after
// Landlord Ops verifies the LC1 chairperson. There is no longer an instant
// leg — the previous UGX 1,000 registration reward has been retired so agents
// are not paid for records that never get approved.
const VERIFICATION_BONUS = 5000;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

    const authHeader = req.headers.get("authorization") || "";
    const anonClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user: caller }, error: userErr } = await anonClient.auth.getUser();
    if (userErr || !caller) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const verifierId = caller.id;

    const body = await req.json();
    const { lc1_id, notes } = body;
    if (!lc1_id || typeof lc1_id !== "string") {
      return new Response(JSON.stringify({ error: "lc1_id is required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const adminClient = createClient(supabaseUrl, supabaseServiceKey);

    // ─── ROLE CHECK: internal staff or landlord_ops permission ───
    const [roleRes, permRes] = await Promise.all([
      adminClient
        .from("user_roles")
        .select("role")
        .eq("user_id", verifierId)
        .in("role", ["manager", "coo", "super_admin", "operations", "employee", "ceo", "cfo"])
        .limit(1),
      adminClient
        .from("staff_permissions")
        .select("permitted_dashboard")
        .eq("user_id", verifierId)
        .eq("permitted_dashboard", "landlord_ops")
        .limit(1),
    ]);

    const hasBaseRole = (roleRes.data?.length ?? 0) > 0;
    const hasLandlordOpsPerm = (permRes.data?.length ?? 0) > 0;

    if (!hasBaseRole && !hasLandlordOpsPerm) {
      return new Response(JSON.stringify({
        error: "Only internal staff can verify LC1 chairpersons",
      }), {
        status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Treasury guard: credits agent wallet — block when paused
    const guardBlock = await checkTreasuryGuard(adminClient, "credit", authHeader);
    if (guardBlock) return guardBlock;

    // Load the LC1 record
    const { data: lc1, error: lc1Err } = await adminClient
      .from("lc1_chairpersons")
      .select("id, name, registered_by, verified, verification_bonus_paid")
      .eq("id", lc1_id)
      .single();

    if (lc1Err || !lc1) {
      return new Response(JSON.stringify({ error: "LC1 chairperson not found" }), {
        status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const now = new Date().toISOString();

    // Always ensure the record is flagged verified (even if bonus already paid
    // or there's no registering agent to reward).
    await adminClient
      .from("lc1_chairpersons")
      .update({ verified: true, verified_at: now, verified_by: verifierId })
      .eq("id", lc1_id);

    // Idempotency: only pay the verification bonus once.
    if (lc1.verification_bonus_paid) {
      return new Response(JSON.stringify({ success: true, verified: true, already_paid: true }), {
        status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const agentId = lc1.registered_by;
    // No registering agent (e.g. bulk-imported or ops-created) → verify only.
    if (!agentId) {
      await adminClient
        .from("lc1_chairpersons")
        .update({ verification_bonus_paid: true, verification_bonus_paid_at: now })
        .eq("id", lc1_id);
      return new Response(JSON.stringify({ success: true, verified: true, bonus: 0, no_agent: true }), {
        status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // The full UGX 5,000 reward is posted by the DB trigger
    // `trg_pay_lc1_registration_verified_bonus` when `verified` flips to true,
    // so this function no longer writes ledger entries (that would double-pay).
    // Mark paid for legacy idempotency bookkeeping.
    const { error: flagErr } = await adminClient
      .from("lc1_chairpersons")
      .update({ verification_bonus_paid: true, verification_bonus_paid_at: now })
      .eq("id", lc1_id)
      .eq("verification_bonus_paid", false);

    if (flagErr) {
      console.error("[credit-lc1-verification-bonus] Flag update failed (money already moved):", flagErr.message);
    }

    console.log(`[credit-lc1-verification-bonus] Credited UGX ${VERIFICATION_BONUS} to ${agentId} for LC1 ${lc1_id}; notes=${notes || ""}`);

    await notifyLc1Bonus(adminClient, {
      agentId,
      stage: "verified",
      lc1Name: lc1.name,
      lc1Id: lc1_id,
    }).catch((e) => console.error("[credit-lc1-verification-bonus] notify failed:", e));

    return new Response(JSON.stringify({ success: true, verified: true, bonus: VERIFICATION_BONUS }), {
      status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err: any) {
    console.error("[credit-lc1-verification-bonus] Error:", err);
    return new Response(JSON.stringify({ error: err.message || "Internal error" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
