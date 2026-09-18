import "../_shared/smsFooterInterceptor.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { attemptYoolaPrimary } from "../_shared/yoolaPrimary.ts";

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

    // Landlord-paid gate: if the landlord float released to the agent still
    // holds money (paid_out < allocated), the landlord has not been paid and
    // collection must stay closed — even when the request reads 'repaying'.
    const { data: unpaidAlloc } = await supabaseAdmin
      .from("agent_landlord_float_allocations")
      .select("id")
      .eq("rent_request_id", rentRequest.id)
      .gt("remaining_amount", 0)
      .limit(1)
      .maybeSingle();

    if (unpaidAlloc) {
      return new Response(
        JSON.stringify({
          error: "The landlord has not been paid yet for this Rent Plan. Collection opens once the landlord is paid.",
          error_code: "LANDLORD_NOT_PAID",
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
    (async () => {
      try {
        const phone = (profileData as any)?.phone as string | undefined;
        const fullName = (profileData as any)?.full_name as string | undefined;
        if (!phone || !fullName) return;
        const apiKey = Deno.env.get("AFRICASTALKING_API_KEY");
        const username = Deno.env.get("AFRICASTALKING_USERNAME");
        if (!apiKey || !username) {
          console.warn("[tenant-pay-rent] Skipping SMS — AT credentials missing");
          return;
        }
        const siteBase = Deno.env.get("PUBLIC_SITE_URL") || "https://welileapp.com";
        const shareUrl = `${siteBase.replace(/\/+$/, "")}/limit/${tenantId}`;
        const firstName = fullName.split(" ")[0];
        const fmt = (n: number) => `UGX ${Math.max(0, Math.round(n)).toLocaleString("en-UG")}`;
        const message = [
          "WELILE — Rent Money You Can Get",
          "",
          `Hello ${firstName},`,
          "",
          `You have paid ${fmt(payAmount)} toward your rent. Your remaining balance is ${fmt(remainingBalance)}.`,
          "",
          "Continue paying your rent on time to qualify for future rent support of up to UGX 3,000,000.",
          "",
          "View your rent card here:",
          shareUrl,
          "",
          "Pay on time, your rent limit increases daily!",
        ].join("\n");

        // Yoola is the primary SMS provider; fall through to AT only if it fails.
        if (await attemptYoolaPrimary(phone, message, { source: "tenant-pay-rent" })) return;

        const digits = phone.replace(/[^0-9]/g, "");
        const to = digits.startsWith("256")
          ? `+${digits}`
          : digits.startsWith("0")
            ? `+256${digits.slice(1)}`
            : digits.length === 9
              ? `+256${digits}`
              : `+${digits}`;

        const isSandbox = username.toLowerCase() === "sandbox";
        const baseUrl = isSandbox
          ? "https://api.sandbox.africastalking.com/version1/messaging"
          : "https://api.africastalking.com/version1/messaging";

        const res = await fetch(baseUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            apiKey,
            Accept: "application/json",
          },
          body: new URLSearchParams({ username, from: "WELILE", to, message }).toString(),
        });
        const raw = await res.text();
        console.log(`[tenant-pay-rent] SMS to=${to} status=${res.status} body=${raw}`);

        await supabaseAdmin.from("system_events").insert({
          event_type: "rent_access_limit.sms.sent",
          actor_id: tenantId,
          subject_id: tenantId,
          payload: {
            mode: "tenant_pay_rent",
            paid_amount: payAmount,
            remaining_balance: remainingBalance,
            share_url: shareUrl,
            http_status: res.status,
          },
        });
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
