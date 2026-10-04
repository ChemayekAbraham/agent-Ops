import "../_shared/smsFooterInterceptor.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { routeTenantNotification } from "../_shared/tenantChannelRouter.ts";
import {
  accessSentence,
  firstName,
  formatUGX,
  growthSentence,
  loadRentAccessCap,
  loadTenantPaymentMessageVars,
  nextLevelSentence,
} from "../_shared/tenantTemplates.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    // Authenticate tenant from JWT
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(
        JSON.stringify({ error: "Missing authorization header" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const anonClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: authError } = await anonClient.auth.getUser();
    if (authError || !user) {
      return new Response(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const callerId = user.id;

    // Parse and validate input
    const body = await req.json();
    const amount = Number(body.amount);
    if (!amount || amount <= 0) {
      return new Response(
        JSON.stringify({ error: "Amount must be greater than 0" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabaseAdmin = createClient(supabaseUrl, serviceKey);

    // Who is paying? The tenant themselves (self-pay from their own wallet), or
    // an authorised agent collecting FROM the tenant's wallet on their behalf
    // ("Auto-Collect from Tenant Wallet" in the agent tenant sheet).
    //
    // Before this, tenantId was always the caller's own id and `tenant_id` in
    // the body was silently ignored — so an agent tap read the AGENT's wallet
    // and the AGENT's own Rent Plan, and returned a non-2xx ("No active rent
    // request found") instead of collecting anything.
    const requestedTenantId =
      typeof (body as any)?.tenant_id === "string" && (body as any).tenant_id
        ? (body as any).tenant_id as string
        : callerId;
    const requestedRentRequestId =
      typeof (body as any)?.rent_request_id === "string" && (body as any).rent_request_id
        ? (body as any).rent_request_id as string
        : null;
    const onBehalf = requestedTenantId !== callerId;
    let collectingAgentId: string | null = null;

    if (onBehalf) {
      // The caller must either be an agent attached to this tenant's Rent Plan
      // or hold an operations role. Anything else is a 403 — never a silent
      // fallback to the caller's own wallet.
      const { data: linkedPlan } = await supabaseAdmin
        .from("rent_requests")
        .select("id")
        .eq("tenant_id", requestedTenantId)
        .or(`agent_id.eq.${callerId},assigned_agent_id.eq.${callerId}`)
        .limit(1)
        .maybeSingle();

      let authorised = !!linkedPlan;
      if (!authorised) {
        const { data: roles } = await supabaseAdmin
          .from("user_roles")
          .select("role")
          .eq("user_id", callerId);
        authorised = (roles || []).some((r: any) =>
          ["agent_ops", "manager", "operations", "super_admin", "tenant_ops"].includes(r.role)
        );
      }

      if (!authorised) {
        return new Response(
          JSON.stringify({ error: "Not permitted to collect from this tenant's wallet" }),
          { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      collectingAgentId = callerId;
    }

    const tenantId = requestedTenantId;

    // Get tenant's wallet balance from wallets table (source of truth)
    const { data: walletData, error: walletErr } = await supabaseAdmin
      .from("wallets")
      .select("balance")
      .eq("user_id", tenantId)
      .single();

    // Get tenant name for notifications
    const { data: profileData } = await supabaseAdmin
      .from("profiles")
      .select("full_name, phone")
      .eq("id", tenantId)
      .single();

    const walletBalance = walletData?.balance ?? 0;

    if (walletErr || !walletData) {
      return new Response(
        JSON.stringify({ error: "Could not find tenant wallet" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (walletBalance < amount) {
      return new Response(
        JSON.stringify({
          error: "Insufficient wallet balance",
          wallet_balance: walletBalance,
          requested: amount,
        }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Find the Rent Plan to pay. When the caller names one explicitly it is
    // still scoped to this tenant, so a bad id can never touch another plan.
    let planQuery = supabaseAdmin
      .from("rent_requests")
      .select("id, total_repayment, amount_repaid, landlord_id, status")
      .eq("tenant_id", tenantId);

    planQuery = requestedRentRequestId
      ? planQuery.eq("id", requestedRentRequestId)
      : planQuery
          .in("status", ["funded", "disbursed", "approved", "repaying"])
          .order("created_at", { ascending: false });

    const { data: rentRequest, error: rrErr } = await planQuery.limit(1).maybeSingle();

    if (rrErr) {
      return new Response(
        JSON.stringify({ error: "Error looking up rent request" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (!rentRequest) {
      return new Response(
        JSON.stringify({ error: "No active rent request found" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Landlord-paid gate RESTORED (2026-09-29), scoped to the 24-hour recall.
    //
    // A plan whose landlord float is still sitting with the agent is CANCELLED
    // by the recall at the 24-hour mark. Accepting a repayment inside that
    // window means taking the tenant's money for rent the landlord never
    // received, on a plan that is then unwound. `rent_plan_awaiting_landlord`
    // is the same predicate the agent's collection RPC uses, and it ignores
    // plans funded before the recall go-live so the pre-go-live backlog is not
    // frozen by it.
    const { data: awaitingLandlord, error: gateErr } = await supabaseAdmin.rpc(
      "rent_plan_awaiting_landlord",
      { p_rent_request_id: rentRequest.id },
    );
    if (gateErr) {
      // Fail closed. Money must not move on a gate we could not read.
      console.error("[tenant-pay-rent] landlord gate unreadable:", gateErr);
      return new Response(
        JSON.stringify({ error: "Could not verify landlord settlement. Please try again." }),
        { status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    if (awaitingLandlord === true) {
      return new Response(
        JSON.stringify({
          error_code: "AWAITING_LANDLORD_PAYMENT",
          error: "The landlord for this Rent Plan has not been paid yet. Repayment opens the moment the landlord is paid.",
        }),
        { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }


    const outstanding = rentRequest.total_repayment - rentRequest.amount_repaid;
    const payAmount = Math.min(amount, outstanding);

    if (payAmount <= 0) {
      return new Response(
        JSON.stringify({ error: "Rent is already fully paid" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 1. Insert balanced ledger entries via RPC (with idempotency).
    //
    // The key used to be `tenant-pay-<plan>-<amount>`, which collides on every
    // later collection of the same amount on the same plan — and daily
    // instalments are identical by design. create_ledger_transaction returns
    // the EXISTING group silently on a key hit, so the wallet was never debited
    // while the repayment below was recorded again. The key is now unique per
    // collection event, and a key hit is reported as a duplicate instead of
    // being replayed as a fresh repayment.
    const clientRef =
      typeof (body as any)?.client_ref === "string" && (body as any).client_ref
        ? (body as any).client_ref as string
        : `${callerId}-${new Date().toISOString().slice(0, 16)}`;
    const idempotencyKey = `tenant-pay-${rentRequest.id}-${payAmount}-${clientRef}`;

    const { data: priorLeg } = await supabaseAdmin
      .from("general_ledger")
      .select("transaction_group_id")
      .eq("idempotency_key", idempotencyKey)
      .limit(1)
      .maybeSingle();

    if (priorLeg?.transaction_group_id) {
      return new Response(
        JSON.stringify({
          success: true,
          duplicate: true,
          amount_paid: 0,
          message: "This payment was already recorded.",
          reference: `PAY-${String(priorLeg.transaction_group_id).slice(0, 8).toUpperCase()}`,
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const { data: txnGroupId, error: ledgerErr } = await supabaseAdmin.rpc('create_ledger_transaction', {
      entries: [
        {
          user_id: tenantId,
          amount: payAmount,
          direction: 'cash_out',
          category: 'tenant_repayment',
          ledger_scope: 'wallet',
          source_table: 'rent_requests',
          source_id: rentRequest.id,
          description: 'Rent payment from wallet',
          currency: 'UGX',
          linked_party: rentRequest.landlord_id,
          reference_id: rentRequest.id,
          transaction_date: new Date().toISOString(),
        },
        {
          direction: 'cash_in',
          amount: payAmount,
          category: 'tenant_repayment',
          ledger_scope: 'platform',
          source_table: 'rent_requests',
          source_id: rentRequest.id,
          description: 'Rent payment received from tenant wallet',
          currency: 'UGX',
          transaction_date: new Date().toISOString(),
        },
      ],
      idempotency_key: idempotencyKey,
    });

    if (ledgerErr) {
      console.error("Ledger RPC error:", ledgerErr);
      return new Response(
        JSON.stringify({ error: "Failed to record payment" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const txGroupId = txnGroupId;

    // 2. Record the repayment AND allocate the instalment waterfall.
    //
    // record_rent_request_repayment_v2 wraps three steps in ONE database
    // transaction: the L7 sequencing assertion, the original
    // record_rent_request_repayment logic, and post_instalment_waterfall.
    // Calling the waterfall as a separate RPC round-trip would NOT be atomic —
    // a failure between the two would leave a payment with no allocation, or an
    // allocation with no payment.
    //
    // Residual gap, deliberately not papered over: the ledger legs posted at
    // step 1 above are still a SEPARATE transaction. That gap is pre-existing
    // (see the "partial: true" response below, which long predates Phase 2) and
    // closing it needs all three calls folded into one function.
    //
    // The waterfall is idempotent on (rent_request_id, source_table, source_id),
    // so a retried payment cannot double-allocate or double-post.
    //
    // p_transaction_group_id must be passed EXPLICITLY as null: the live
    // function has no default for it, so omitting the argument made PostgREST
    // fail to resolve the function at all — the wallet was debited at step 1
    // and the repayment was never recorded (the non-2xx the agent sheet showed).
    // null is deliberate: the RPC's own ledger entry is audit-only (no wallet
    // trigger). p_rent_request_id pins the plan the caller actually opened.
    const { error: rpcErr } = await supabaseAdmin.rpc(
      "record_rent_request_repayment_v2",
      {
        p_tenant_id: tenantId,
        p_amount: payAmount,
        p_source_table: "tenant_pay_rent",
        p_source_id: txnGroupId,
        p_transaction_group_id: null,
        p_rent_request_id: rentRequest.id,
      }
    );

    if (rpcErr) {
      console.error("RPC error:", rpcErr);
      return new Response(
        JSON.stringify({ error: "Payment recorded but repayment update failed. Contact support.", partial: true }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 3. Credit the assigned agent's commission (non-blocking)
    const { error: commissionErr } = await supabaseAdmin.rpc(
      "credit_agent_rent_commission",
      {
        p_rent_request_id: rentRequest.id,
        p_repayment_amount: payAmount,
        p_tenant_id: tenantId,
        p_event_reference_id: `tenant-pay-${txnGroupId}`,
      }
    );
    if (commissionErr) {
      console.error("Commission error (non-blocking):", commissionErr);
    }

    // 3b. When an agent collected from the tenant's wallet, the collection must
    // land in agent_collections — "Today's capacity" reads only that table, so
    // without this row the agent's bar stays at 0 for money they did collect.
    if (collectingAgentId) {
      const { error: collErr } = await supabaseAdmin.from("agent_collections").insert({
        agent_id: collectingAgentId,
        tenant_id: tenantId,
        rent_request_id: rentRequest.id,
        amount: payAmount,
        payment_method: "in_app_wallet",
        collection_channel: "tenant_wallet",
        initiated_by: collectingAgentId,
        notes: "Auto-collected from tenant wallet",
      } as any);
      if (collErr) console.error("agent_collections insert failed (non-blocking):", collErr);
    }



    // 4. Get updated wallet balance
    const { data: updatedWallet } = await supabaseAdmin
      .from("wallets")
      .select("balance")
      .eq("user_id", tenantId)
      .single();

    // 4. Get updated rent request
    const { data: updatedRent } = await supabaseAdmin
      .from("rent_requests")
      .select("amount_repaid, total_repayment, status")
      .eq("id", rentRequest.id)
      .single();

    const remainingBalance = updatedRent
      ? updatedRent.total_repayment - updatedRent.amount_repaid
      : outstanding - payAmount;


    // Notify managers (fire-and-forget)
    fetch(`${supabaseUrl}/functions/v1/notify-managers`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${serviceKey}` },
      body: JSON.stringify({ title: "🏠 Rent Payment", body: "Activity: rent payment", url: "/dashboard/manager" }),
    }).catch(() => {});

    // Push notification to tenant (fire-and-forget)
    fetch(`${supabaseUrl}/functions/v1/send-push-notification`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${serviceKey}` },
      body: JSON.stringify({
        userIds: [tenantId],
        payload: { title: "✅ Rent Payment Confirmed", body: `UGX ${payAmount.toLocaleString()} rent payment processed`, url: "/dashboard/tenant", type: "success" },
      }),
    }).catch(() => {});

    // Branded "Rent Money You Can Get" SMS to tenant (fire-and-forget).
    // Mirrors the agent allocation flow so every rent payment — including
    // tenant-self-pay and one-tap renew — triggers the same confirmation card.
    //
    // Consolidated 2026-09-25 onto the same Stage-6 channel router and real
    // topup-eligibility wording every other tenant payment-confirmation SMS
    // already uses (tenant-payment-notices' PAYMENT_FULL/PAYMENT_PARTIAL) —
    // no more bespoke inline Yoola/Africa's Talking calls, no more hardcoded
    // flat "up to UGX 3,000,000" line. tenant_topup_eligibility_rules()'s
    // actual 70%/90% thresholds are reused unchanged via
    // loadTenantPaymentMessageVars/accessSentence/nextLevelSentence, which
    // never render a percentage to the tenant, only exact UGX amounts.
    (async () => {
      try {
        const phone = (profileData as any)?.phone as string | undefined;
        const fullName = (profileData as any)?.full_name as string | undefined;
        if (!phone) return;

        const siteBase = Deno.env.get("PUBLIC_SITE_URL") || "https://welileapp.com";
        const shareUrl = `${siteBase.replace(/\/+$/, "")}/limit/${tenantId}`;

        const planVars = await loadTenantPaymentMessageVars(supabaseAdmin, [tenantId]);
        const vars = planVars.get(tenantId);
        const accessCap = await loadRentAccessCap(supabaseAdmin);

        const outcome = await routeTenantNotification({
          admin: supabaseAdmin,
          tenantId,
          eventKey: "WALLET_RENT_PAYMENT_CONFIRMED",
          episodeKey: `wallet_payment:${txnGroupId}`,
          vars: {
            name: firstName(fullName),
            amount_paid: formatUGX(payAmount),
            balance: formatUGX(remainingBalance),
            access_now: accessSentence(vars),
            next_level: nextLevelSentence(vars),
            growth_note: growthSentence(accessCap),
            share_url: shareUrl,
          },
          phone,
          tenantName: fullName ?? null,
          payload: {
            mode: "tenant_pay_rent",
            paid_amount: payAmount,
            remaining_balance: remainingBalance,
            share_url: shareUrl,
          },
          linkPath: "/dashboard/tenant",
        });

        console.log(
          `[tenant-pay-rent] SMS routed tenant=${tenantId} sent=${outcome.smsSent} reason=${outcome.reason ?? "-"}`,
        );
      } catch (e) {
        console.warn("[tenant-pay-rent] branded SMS failed:", e);
      }
    })();


    return new Response(
      JSON.stringify({
        success: true,
        amount_paid: payAmount,
        remaining_balance: remainingBalance,
        new_wallet_balance: updatedWallet?.balance ?? walletBalance - payAmount,
        rent_status: updatedRent?.status ?? rentRequest.status,
        reference: `PAY-${txnGroupId.slice(0, 8).toUpperCase()}`,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("Unexpected error:", err);
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
