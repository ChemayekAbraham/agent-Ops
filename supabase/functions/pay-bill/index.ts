import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { checkTreasuryGuard } from "../_shared/treasuryGuard.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const ALLOWED_BILL_CATEGORIES = ["airtime", "electricity", "water", "internet", "tv"] as const;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Missing authorization" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const userClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: authErr } = await userClient.auth.getUser();
    if (authErr || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const admin = createClient(supabaseUrl, serviceKey);

    const guardBlock = await checkTreasuryGuard(admin, "debit", req.headers.get("Authorization"));
    if (guardBlock) return guardBlock;

    const body = await req.json();
    const category = String(body?.category || "").toLowerCase();
    const accountNumber = String(body?.account_number || "").trim();
    const amount = Number(body?.amount);

    if (!ALLOWED_BILL_CATEGORIES.includes(category as any)) {
      return new Response(JSON.stringify({ error: "Invalid bill category" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (!accountNumber) {
      return new Response(JSON.stringify({ error: "account_number is required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      return new Response(JSON.stringify({ error: "amount must be a positive number" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Pre-flight withdrawable check (server-authoritative)
    const { data: wallet } = await admin
      .from("wallets")
      .select("withdrawable_balance, advance_balance")
      .eq("user_id", user.id)
      .single();

    const spendable = Number(wallet?.withdrawable_balance ?? 0) + Number(wallet?.advance_balance ?? 0);
    if (spendable < amount) {
      return new Response(JSON.stringify({
        error: `Insufficient spendable balance. Available: UGX ${spendable.toLocaleString()}, Requested: UGX ${amount.toLocaleString()}.`,
      }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const reference = `BILL-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const description = `Bill payment (${category}) — ${accountNumber}`;

    // Balanced ledger pair: user wallet cash_out → platform clearing cash_in.
    // Category 'wallet_withdrawal' is in the strict-mode allowlist and routes
    // to the withdrawable bucket through the bucket router trigger.
    const { data: txnGroupId, error: ledgerErr } = await admin.rpc("create_ledger_transaction", {
      entries: [
        {
          user_id: user.id,
          amount,
          direction: "cash_out",
          category: "wallet_withdrawal",
          ledger_scope: "wallet",
          description,
          currency: "UGX",
          source_table: "bill_payments",
          reference_id: reference,
          transaction_date: new Date().toISOString(),
          metadata: JSON.stringify({ bill_category: category, account_number: accountNumber }),
        },
        {
          amount,
          direction: "cash_in",
          category: "wallet_withdrawal",
          ledger_scope: "platform",
          description: `Platform clearing for ${description}`,
          currency: "UGX",
          source_table: "bill_payments",
          reference_id: reference,
          transaction_date: new Date().toISOString(),
        },
      ],
    });

    if (ledgerErr) {
      console.error("[pay-bill] Ledger error:", ledgerErr);
      return new Response(JSON.stringify({ error: ledgerErr.message || "Ledger write failed" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    await admin.from("audit_logs").insert({
      user_id: user.id,
      action_type: "bill_payment",
      table_name: "bill_payments",
      record_id: reference,
      metadata: { category, account_number: accountNumber, amount, txn_group_id: txnGroupId },
    });

    return new Response(JSON.stringify({
      success: true, reference, txn_group_id: txnGroupId,
    }), {
      status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("[pay-bill] error:", err);
    return new Response(JSON.stringify({ error: (err as Error).message || "Internal error" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});