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

    const body = await req.json().catch(() => ({}));
    const { rent_request_ids, coverage_type, funding_days } = body as {
      rent_request_ids?: string[];
      coverage_type?: string;
      funding_days?: number;
    };

    if (!rent_request_ids || !Array.isArray(rent_request_ids) || rent_request_ids.length === 0) {
      return new Response(
        JSON.stringify({ error: "No rent requests selected" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const adminClient = createClient(supabaseUrl, supabaseServiceKey);

    // Verify supporter role
    const { data: supporterRole } = await adminClient
      .from("user_roles")
      .select("role")
      .eq("user_id", user.id)
      .eq("role", "supporter")
      .maybeSingle();

    if (!supporterRole) {
      return new Response(
        JSON.stringify({ error: "Only supporters can fund tenants" }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Get selected rent requests (must be approved/pending funding)
    const { data: rentRequests, error: fetchErr } = await adminClient
      .from("rent_requests")
      .select("*, landlords!rent_requests_landlord_id_fkey(name, phone, mobile_money_number)")
      .in("id", rent_request_ids)
      .in("status", ["approved", "pending"]);

    if (fetchErr || !rentRequests || rentRequests.length === 0) {
      return new Response(
        JSON.stringify({ error: "No eligible rent requests found" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Calculate total funding needed
    let totalFunding = 0;
    for (const rr of rentRequests) {
      const rentAmount = rr.rent_amount || 0;
      if (coverage_type === "partial") {
        totalFunding += Math.round(rentAmount * 0.5);
      } else if (coverage_type === "daily" && funding_days) {
        totalFunding += Math.round(rentAmount * (funding_days / 30));
      } else {
        totalFunding += rentAmount;
      }
    }

    // Check supporter wallet balance
    const { data: supporterWallet } = await adminClient
      .from("wallets")
      .select("balance")
      .eq("user_id", user.id)
      .single();

    if (!supporterWallet || supporterWallet.balance < totalFunding) {
      return new Response(
        JSON.stringify({ 
          error: "Insufficient wallet balance",
          required: totalFunding,
          available: supporterWallet?.balance || 0
        }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const txGroupId = crypto.randomUUID();
    const results: Array<{ rent_request_id: string; tenant_id: string; landlord_name: string; amount: number }> = [];

    // Process each rent request
    for (const rr of rentRequests) {
      const rentAmount = rr.rent_amount || 0;
      let fundAmount = rentAmount;
      if (coverage_type === "partial") fundAmount = Math.round(rentAmount * 0.5);
      else if (coverage_type === "daily" && funding_days) fundAmount = Math.round(rentAmount * (funding_days / 30));

      // Check supporter balance (read-only, trigger handles updates)
      const { data: freshWallet } = await adminClient
        .from("wallets")
        .select("balance")
        .eq("user_id", user.id)
        .single();

      if (!freshWallet || freshWallet.balance < fundAmount) {
        console.error("Insufficient balance mid-transaction");
        break;
      }

      // Find landlord's linked user profile via phone
      const landlordRecord = rr.landlords as any;
      const landlordPhone = landlordRecord?.phone;

      let landlordUserId: string | null = null;
      if (landlordPhone) {
        const { data: landlordProfile } = await adminClient
          .from("profiles")
          .select("id")
          .eq("phone", landlordPhone)
          .maybeSingle();
        landlordUserId = landlordProfile?.id || null;
      }

      // Ensure landlord wallet exists if they have a profile
      if (landlordUserId) {
        await adminClient
          .from("wallets")
          .upsert({ user_id: landlordUserId, balance: 0 }, { onConflict: "user_id", ignoreDuplicates: true });
      }

      // Update rent request status to funded
      const fundedAt = new Date().toISOString();
      await adminClient
        .from("rent_requests")
        .update({
          status: "funded",
          funded_at: fundedAt,
          supporter_id: user.id,
          updated_at: fundedAt,
        })
        .eq("id", rr.id);

      // === TREASURY FEE RECOGNITION (idempotent; non-fatal) ===
      // Creates the L7 funding-side credit that later instalment waterfall drawdowns debit against.
      const { error: treasuryErr } = await adminClient.rpc('recognise_funding_treasury', {
        p_rent_request_id: rr.id,
      });
      if (treasuryErr) {
        console.error('[fund-tenants] Treasury recognition failed (non-fatal):', treasuryErr.message);
      } else {
        console.log('[fund-tenants] Treasury recognition recorded for', rr.id);
      }

      // Create auto-charge subscription for tenant wallet
      const totalRepayment = Number(rr.total_repayment) || fundAmount;
      const durationDays = rr.duration_days || 30;
      let frequency: string;
      let chargeAmount: number;
      let totalCharges: number;

      if (durationDays <= 30 && rr.daily_repayment > 0) {
        // Daily earner
        frequency = "daily";
        chargeAmount = Math.round(Number(rr.daily_repayment));
        totalCharges = durationDays;
      } else if (durationDays <= 21) {
        // Weekly earner
        frequency = "weekly";
        totalCharges = Math.ceil(durationDays / 7);
        chargeAmount = Math.round(totalRepayment / totalCharges);
      } else {
        // Monthly earner
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

      // Notify tenant about auto-charge schedule
      await adminClient.from("notifications").insert({
        user_id: rr.tenant_id,
        title: "📅 Repayment Schedule Active",
        message: `Your wallet will be auto-charged UGX ${chargeAmount.toLocaleString()} ${frequency} starting ${nextChargeDate.toLocaleDateString()}. Total: UGX ${totalRepayment.toLocaleString()} over ${totalCharges} payments.`,
        type: "info",
        metadata: {
          rent_request_id: rr.id,
          frequency,
          charge_amount: chargeAmount,
          total_charges: totalCharges,
        },
      });

      // Queue ledger entries for manager approval (double-entry)
      await adminClient.from("pending_wallet_operations").insert([
        {
          user_id: user.id,
          amount: fundAmount,
          direction: "cash_out",
          category: "rent facilitation payout",
          source_table: "rent_requests",
          source_id: rr.id,
          transaction_group_id: txGroupId,
          description: `Funded rent for tenant - ${landlordRecord?.name || "landlord"}`,
          linked_party: rr.tenant_id,
          status: "pending",
        },
        {
          user_id: landlordUserId || null,
          amount: fundAmount,
          direction: "cash_in",
          category: "rent facilitation payout",
          source_table: "rent_requests",
          source_id: rr.id,
          transaction_group_id: txGroupId,
          description: `Rent payment from supporter`,
          linked_party: user.id,
          status: "pending",
        },
      ]);

      // === POST TENANT OBLIGATION LEDGER ENTRY ===
      // This creates the audit trail showing the tenant owes this amount
      const totalRepaymentForLedger = Number(rr.total_repayment) || fundAmount;
      await adminClient.rpc('create_ledger_transaction', {
        entries: [
          {
            user_id: user.id,
            amount: totalRepaymentForLedger,
            direction: "cash_out",
            category: "rent_disbursement",
            source_table: "rent_requests",
            source_id: rr.id,
            description: `Rent disbursement - ${landlordRecord?.name || "landlord"} (${rr.duration_days || 30} days)`,
            currency: 'UGX',
            ledger_scope: "platform",
            linked_party: user.id,
            reference_id: rr.id,
            transaction_date: new Date().toISOString(),
          },
          {
            user_id: rr.tenant_id,
            amount: totalRepaymentForLedger,
            direction: "cash_in",
            category: "rent_receivable_created",
            source_table: "rent_requests",
            source_id: rr.id,
            description: `Rent receivable created - ${landlordRecord?.name || "landlord"} (${rr.duration_days || 30} days)`,
            currency: 'UGX',
            ledger_scope: "bridge",
            linked_party: user.id,
            reference_id: rr.id,
            transaction_date: new Date().toISOString(),
          },
        ],
      });
      console.log(`[fund-tenants] Posted rent obligation of ${totalRepaymentForLedger} for tenant ${rr.tenant_id}`);

      // Notify tenant
      await adminClient.from("notifications").insert({
        user_id: rr.tenant_id,
        title: "Rent Funded! 🏠",
        message: `Your rent of UGX ${fundAmount.toLocaleString()} has been funded by a supporter.`,
        type: "success",
        metadata: { rent_request_id: rr.id, amount: fundAmount },
      });

      results.push({
        rent_request_id: rr.id,
        tenant_id: rr.tenant_id,
        landlord_name: landlordRecord?.name || "Unknown",
        amount: fundAmount,
      });
    }

    // Notify supporter
    await adminClient.from("notifications").insert({
      user_id: user.id,
      title: "Funding Complete! 💚",
      message: `You've funded ${results.length} tenant(s) totaling UGX ${totalFunding.toLocaleString()}. Your 15% monthly reward will be credited automatically.`,
      type: "success",
      metadata: { total: totalFunding, count: results.length, tx_group: txGroupId },
    });

    console.log(`[fund-tenants] Supporter ${user.id} funded ${results.length} tenants, total: ${totalFunding}`);


    // Notify managers (fire-and-forget)
    fetch(`${supabaseUrl}/functions/v1/notify-managers`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${supabaseServiceKey}` },
      body: JSON.stringify({ title: "💚 Tenants Funded", body: "Activity: tenants funded", url: "/dashboard/manager" }),
    }).catch(() => {});


    return new Response(
      JSON.stringify({
        success: true,
        message: `Successfully funded ${results.length} tenant(s)`,
        details: {
          total_funded: totalFunding,
          tenants_funded: results.length,
          expected_roi: Math.round(totalFunding * 0.15),
          results,
        },
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    console.error("[fund-tenants] Error:", msg);
    return new Response(
      JSON.stringify({ error: msg }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
