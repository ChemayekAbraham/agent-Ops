// When Financial Ops verifies a person's identity / payout destination, every
// open withdrawal they already submitted becomes visible + claimable to merchant
// agents. This function broadcasts those now-eligible withdrawals to eligible
// online merchant agents (same dispatch engine as a brand-new withdrawal).
//
// Callers: the Financial Ops verification panel (verified decision) and any
// server-side path holding the service role key.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { dispatchWithdrawal, OPEN_STATUSES } from "../_shared/dispatchMerchants.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const FINANCE_ROLES = ["financial_ops", "cfo", "manager", "super_admin"];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const admin = createClient(supabaseUrl, serviceKey);

    const body = await req.json().catch(() => ({}));
    const targetUserId = typeof body?.user_id === "string" ? body.user_id : null;
    const withdrawalId = typeof body?.withdrawal_id === "string" ? body.withdrawal_id : null;
    if (!targetUserId && !withdrawalId) {
      return new Response(JSON.stringify({ error: "user_id or withdrawal_id required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Authorisation: service role, or a signed-in finance operator.
    const authHeader = req.headers.get("Authorization") ?? "";
    const token = authHeader.replace("Bearer ", "").trim();
    if (token !== serviceKey) {
      const { data: authData } = await admin.auth.getUser(token);
      const caller = authData?.user;
      if (!caller) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const { data: roles } = await admin
        .from("user_roles")
        .select("role")
        .eq("user_id", caller.id);
      const allowed = (roles || []).some((r: any) => FINANCE_ROLES.includes(r.role));
      if (!allowed) {
        return new Response(JSON.stringify({ error: "Forbidden" }), {
          status: 403,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    // Resolve the owner from the withdrawal when only an id was passed.
    let ownerId = targetUserId;
    if (!ownerId && withdrawalId) {
      const { data: w } = await admin
        .from("withdrawal_requests")
        .select("user_id")
        .eq("id", withdrawalId)
        .maybeSingle();
      ownerId = w?.user_id ?? null;
    }
    if (!ownerId) {
      return new Response(JSON.stringify({ error: "withdrawal not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Only dispatch once the DB itself agrees the owner is fully ID-verified —
    // this is the same gate merchant RLS and claim_withdrawal_verified use.
    const { data: verified, error: gateError } = await admin.rpc(
      "withdrawal_user_id_verified",
      { p_user_id: ownerId },
    );
    if (gateError) throw gateError;
    if (verified !== true) {
      return new Response(
        JSON.stringify({ ok: true, skipped: "owner_not_verified", dispatched: 0 }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    let query = admin
      .from("withdrawal_requests")
      .select("id, amount")
      .eq("user_id", ownerId)
      .in("status", OPEN_STATUSES)
      .is("processed_at", null)
      .is("dispatch_claimed_by", null)
      .order("created_at", { ascending: true });
    if (withdrawalId) query = query.eq("id", withdrawalId);

    const { data: pending, error: listError } = await query;
    if (listError) throw listError;

    const results: Array<Record<string, unknown>> = [];
    for (const row of pending || []) {
      const result = await dispatchWithdrawal(admin, supabaseUrl, serviceKey, row.id, 1);
      results.push({ withdrawal_id: row.id, ...result });

      await admin.from("system_events").insert({
        event_type: "withdrawal_approved",
        user_id: ownerId,
        description:
          "Withdrawal became ID-verified and was dispatched to merchant agents for claiming",
        metadata: {
          withdrawal_id: row.id,
          amount: Number(row.amount) || 0,
          source: "notify-merchants-verified-withdrawals",
          eligible_agents: result.eligible ?? 0,
        },
      }).then(() => {}, () => {});
    }

    return new Response(
      JSON.stringify({ ok: true, dispatched: results.length, results }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err: any) {
    console.error("[notify-merchants-verified-withdrawals] error:", err);
    return new Response(JSON.stringify({ error: err?.message || "Internal error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
