import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(
        JSON.stringify({ error: "Missing authorization header" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const userClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: { user }, error: userError } = await userClient.auth.getUser();
    if (userError || !user) {
      return new Response(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const adminClient = createClient(supabaseUrl, supabaseServiceKey);

    // Verify manager role
    const { data: managerRole } = await adminClient
      .from("user_roles")
      .select("role")
      .eq("user_id", user.id)
      .eq("role", "manager")
      .maybeSingle();

    if (!managerRole) {
      return new Response(
        JSON.stringify({ error: "Only managers can fund tenants from pool" }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const payload = await req.json() as { rent_request_id?: string; transaction_id?: string };
    const rent_request_id = payload.rent_request_id?.trim();
    const txDigits = (payload.transaction_id || "").replace(/\D/g, "");
    const transactionId = txDigits ? `TID${txDigits}` : "";

    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

    if (!rent_request_id || !uuidRegex.test(rent_request_id)) {
      return new Response(
        JSON.stringify({ error: "Valid rent_request_id is required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (!transactionId || txDigits.length < 5 || txDigits.length > 20) {
      return new Response(
        JSON.stringify({ error: "Valid transaction_id is required (TID + 5-20 digits)" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Get rent request (must be approved)
    const { data: rr, error: rrErr } = await adminClient
      .from("rent_requests")
      .select("*, landlords!rent_requests_landlord_id_fkey(id, name, phone, mobile_money_number)")
      .eq("id", rent_request_id)
      .eq("status", "approved")
      .single();

    if (rrErr || !rr) {
      return new Response(
        JSON.stringify({ error: "Rent request not found or not in approved status" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const fundAmount = rr.rent_amount || 0;

    // Calculate available pool balance
    // Pool IN = supporter_rent_fund (cash_out from supporter wallets into pool)
    // Pool OUT = pool_rent_deployment (cash_out from pool to landlords)
    const { data: poolInData } = await adminClient
      .from("general_ledger")
      .select("amount")
      .eq("category", "supporter_rent_fund");

    const { data: poolOutData } = await adminClient
      .from("general_ledger")
      .select("amount")
      .eq("category", "pool_rent_deployment");

    const totalPoolIn = (poolInData || []).reduce((s, r) => s + Number(r.amount), 0);
    const totalPoolOut = (poolOutData || []).reduce((s, r) => s + Number(r.amount), 0);
    const availablePool = totalPoolIn - totalPoolOut;

    if (availablePool < fundAmount) {
      return new Response(
        JSON.stringify({
          error: "Insufficient pool funds",
          available: availablePool,
          required: fundAmount,
        }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // PRE-PAYOUT LIQUIDITY GATE
    // Calculate upcoming 30-day supporter obligations (15% monthly on total active capital)
    // Active capital = total supporter_rent_fund minus any withdrawn/returned capital
    const { data: withdrawnData } = await adminClient
      .from("general_ledger")
      .select("amount")
      .eq("category", "supporter_capital_return");

    const totalWithdrawn = (withdrawnData || []).reduce((s, r) => s + Number(r.amount), 0);
    const activeCapital = totalPoolIn - totalWithdrawn;
    const monthly15Obligation = Math.round(activeCapital * 0.15);

    // Pool after this deployment
    const poolAfterDeploy = availablePool - fundAmount;

    if (poolAfterDeploy < monthly15Obligation) {
      return new Response(
        JSON.stringify({
          error: "Funding blocked: remaining pool would not cover upcoming supporter obligations",
          available: availablePool,
          required: fundAmount,
          pool_after_deploy: poolAfterDeploy,
          upcoming_obligation: monthly15Obligation,
          active_supporter_capital: activeCapital,
        }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const txGroupId = crypto.randomUUID();
    const landlordRecord = rr.landlords as any;
    const landlordPhone = landlordRecord?.phone;

    // Find landlord's user profile via phone
    let landlordUserId: string | null = null;
    if (landlordPhone) {
      const { data: landlordProfile } = await adminClient
        .from("profiles")
        .select("id")
        .eq("phone", landlordPhone)
        .maybeSingle();
      landlordUserId = landlordProfile?.id || null;
    }

    // Credit landlord wallet via RPC (trigger handles wallet balance)
    if (landlordUserId) {
      // Ensure wallet exists
      await adminClient
        .from("wallets")
        .upsert({ user_id: landlordUserId, balance: 0 }, { onConflict: "user_id", ignoreDuplicates: true });

      const txDate = new Date().toISOString();
      await adminClient.rpc('create_ledger_transaction', {
        entries: [
          {
            user_id: landlordUserId,
            amount: fundAmount,
            direction: "cash_in",
            category: "wallet_deposit",
            source_table: "rent_requests",
            source_id: rr.id,
            description: `Rent payment credited to landlord wallet`,
            currency: 'UGX',
            ledger_scope: "wallet",
            transaction_date: txDate,
          },
          {
            user_id: landlordUserId,
            amount: fundAmount,
            direction: "cash_out",
            category: "wallet_deposit",
            source_table: "rent_requests",
            source_id: rr.id,
            description: `Platform disbursement to landlord wallet`,
            currency: 'UGX',
            ledger_scope: "platform",
            transaction_date: txDate,
          },
        ],
      });

      // Notify landlord
      await adminClient.from("notifications").insert({
        user_id: landlordUserId,
        title: "💰 Rent Payment Received!",
        message: `UGX ${fundAmount.toLocaleString()} has been credited to your wallet as rent payment.`,
        type: "success",
        metadata: { rent_request_id: rr.id, amount: fundAmount },
      });
    }

    // Record pool deployment + receivable via RPC
    const now = new Date();
    const yy = String(now.getFullYear()).slice(-2);
    const mm = String(now.getMonth() + 1).padStart(2, "0");
    const dd = String(now.getDate()).padStart(2, "0");
    const seq = String(Math.floor(1000 + Math.random() * 9000));
    const referenceId = `WPD${yy}${mm}${dd}${seq}`;

    const totalRepayment = Number(rr.total_repayment) || fundAmount;
    await adminClient.rpc('create_ledger_transaction', {
      entries: [
        {
          user_id: user.id,
          amount: fundAmount,
          direction: "cash_out",
          category: "rent_disbursement",
          source_table: "rent_requests",
          source_id: rr.id,
          description: `Pool deployment: UGX ${fundAmount.toLocaleString()} to landlord ${landlordRecord?.name || "Unknown"} (TxID: ${transactionId})`,
          currency: 'UGX',
          ledger_scope: "platform",
          linked_party: landlordUserId || landlordRecord?.name || "Unknown Landlord",
          reference_id: transactionId,
          transaction_date: now.toISOString(),
        },
        {
          user_id: rr.tenant_id,
          amount: totalRepayment,
          direction: "cash_in",
          category: "rent_receivable_created",
          source_table: "rent_requests",
          source_id: rr.id,
          description: `Rent receivable - ${landlordRecord?.name || "landlord"} (${rr.duration_days || 30} days)`,
          currency: 'UGX',
          ledger_scope: "bridge",
          linked_party: landlordUserId,
          reference_id: rr.id,
          transaction_date: now.toISOString(),
        },
      ],
    });

    // Update rent request to funded
    await adminClient
      .from("rent_requests")
      .update({
        status: "funded",
        funded_at: now.toISOString(),
        updated_at: now.toISOString(),
      })
      .eq("id", rr.id);

    // === TREASURY FEE RECOGNITION (idempotent; non-fatal) ===
    // Creates the L7 funding-side credit that later instalment waterfall drawdowns debit against.
    const { error: treasuryErr } = await adminClient.rpc('recognise_funding_treasury', {
      p_rent_request_id: rr.id,
    });
    if (treasuryErr) {
      console.error('[fund-tenant-from-pool] Treasury recognition failed (non-fatal):', treasuryErr.message);
    } else {
      console.log('[fund-tenant-from-pool] Treasury recognition recorded for', rr.id);
    }

    // Create auto-charge subscription
    const durationDays = rr.duration_days || 30;
    let frequency: string;
    let chargeAmount: number;
    let totalCharges: number;

    if (durationDays <= 30 && rr.daily_repayment > 0) {
      frequency = "daily";
      chargeAmount = Math.round(Number(rr.daily_repayment));
      totalCharges = durationDays;
    } else if (durationDays <= 21) {
      frequency = "weekly";
      totalCharges = Math.ceil(durationDays / 7);
      chargeAmount = Math.round(totalRepayment / totalCharges);
    } else {
      frequency = "monthly";
      totalCharges = Math.ceil(durationDays / 30);
      chargeAmount = Math.round(totalRepayment / totalCharges);
    }

    const startDate = new Date();
    const nextChargeDate = new Date(startDate);
    if (frequency === "daily") nextChargeDate.setDate(nextChargeDate.getDate() + 1);
    else if (frequency === "weekly") nextChargeDate.setDate(nextChargeDate.getDate() + 7);
    else nextChargeDate.setMonth(nextChargeDate.getMonth() + 1);

    const endDate = new Date(startDate);
    endDate.setDate(endDate.getDate() + durationDays);

    await adminClient.from("subscription_charges").insert({
      tenant_id: rr.tenant_id,
      rent_request_id: rr.id,
      agent_id: rr.agent_id || null,
      service_type: "rent_facilitation",
      charge_amount: chargeAmount,
      frequency,
      next_charge_date: nextChargeDate.toISOString().split("T")[0],
      start_date: startDate.toISOString().split("T")[0],
      end_date: endDate.toISOString().split("T")[0],
      total_charges_due: totalRepayment,
      charges_remaining: totalCharges,
      status: "active",
      charge_agent_wallet: rr.tenant_no_smartphone === true,
    });

    // Notify tenant
    await adminClient.from("notifications").insert({
      user_id: rr.tenant_id,
      title: "🏠 Rent Funded!",
      message: `Your rent of UGX ${fundAmount.toLocaleString()} has been funded! Repayment: UGX ${chargeAmount.toLocaleString()} ${frequency} for ${totalCharges} payments.`,
      type: "success",
      metadata: { rent_request_id: rr.id, amount: fundAmount },
    });

    // Pay agent approval bonus (UGX 5,000) via RPC
    if (rr.agent_id) {
      // Ensure agent wallet exists
      await adminClient
        .from("wallets")
        .upsert({ user_id: rr.agent_id, balance: 0 }, { onConflict: "user_id", ignoreDuplicates: true });

      const bonusTxDate = new Date().toISOString();
      await adminClient.rpc('create_ledger_transaction', {
        entries: [
          {
            user_id: rr.agent_id,
            amount: 5000,
            direction: "cash_in",
            category: "agent_commission_earned",
            source_table: "rent_requests",
            source_id: rr.id,
            description: "Agent approval bonus for funded rent request",
            currency: 'UGX',
            ledger_scope: "wallet",
            transaction_date: bonusTxDate,
          },
          {
            user_id: rr.agent_id,
            amount: 5000,
            direction: "cash_out",
            category: "agent_commission_earned",
            source_table: "rent_requests",
            source_id: rr.id,
            description: "Platform payout: agent approval bonus",
            currency: 'UGX',
            ledger_scope: "platform",
            transaction_date: bonusTxDate,
          },
        ],
      });

      await adminClient.from("agent_earnings").insert({
        agent_id: rr.agent_id,
        amount: 5000,
        earning_type: "approval_bonus",
        rent_request_id: rr.id,
        description: "Agent approval bonus for funded rent request",
        source_user_id: rr.tenant_id,
      });
    }

    console.log(`[fund-tenant-from-pool] Manager ${user.id} funded tenant ${rr.tenant_id} with ${fundAmount} from pool. TxID: ${transactionId}. Ref: ${referenceId}`);

    return new Response(
      JSON.stringify({
        success: true,
        reference_id: referenceId,
        transaction_id: transactionId,
        amount: fundAmount,
        landlord_name: landlordRecord?.name || "Unknown",
        pool_remaining: availablePool - fundAmount,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    console.error("[fund-tenant-from-pool] Error:", msg);
    return new Response(
      JSON.stringify({ error: msg }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
