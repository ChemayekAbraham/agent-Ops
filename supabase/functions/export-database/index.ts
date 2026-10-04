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
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // Auth gate: this endpoint dumps the entire database, so it must require a
    // valid manager/cto/super_admin JWT. Reject anything unauthenticated.
    const authHeader = req.headers.get("Authorization");
    const token = authHeader?.replace("Bearer ", "").trim() ?? "";
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    if (!token) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (token !== serviceKey) {
      const { data: authData, error: authError } = await supabase.auth.getUser(token);
      if (authError || !authData?.user) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const { data: roleRows } = await supabase
        .from("user_roles")
        .select("role")
        .eq("user_id", authData.user.id)
        .eq("enabled", true)
        .in("role", ["manager", "cto", "super_admin"]);
      if (!roleRows?.length) {
        return new Response(JSON.stringify({ error: "Forbidden" }), {
          status: 403,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    // Get all public tables
    const { data: tables } = await supabase.rpc("get_export_tables");

    if (!tables || tables.length === 0) {
      // Fallback: query information_schema directly
      const { data: tableList } = await supabase
        .from("profiles")
        .select("id")
        .limit(0);
    }

    // We'll build the dump by querying each table
    const allTables = [
      "ledger_account_groups", "ledger_accounts", "profiles", "user_roles", "wallets",
      "landlords", "lc1_chairpersons", "vendors", "product_categories", "products",
      "product_images", "conversations", "conversation_participants", "messages",
      "notifications", "referrals", "referral_rewards", "agent_advances",
      "agent_advance_ledger", "agent_advance_topups", "agent_collections",
      "agent_commission_payouts", "agent_earnings", "agent_float_limits",
      "agent_goals", "agent_rebalance_records", "agent_receipts", "agent_subagents",
      "agent_visits", "ai_chat_messages", "audit_logs", "cart_items",
      "credit_access_limits", "credit_request_details", "deposit_requests",
      "earning_baselines", "earning_predictions", "float_requests", "general_ledger",
      "investment_withdrawal_requests", "investor_portfolios",
      "landlord_ambassador_referrals", "ledger_entries", "ledger_transactions",
      "liquidity_alerts", "loan_applications", "location_requests",
      "money_requests", "onboarding_targets", "operations_departments",
      "opportunity_summaries", "otp_verifications", "payment_tokens",
      "pending_wallet_operations", "product_orders", "product_reviews",
      "push_subscriptions", "receipt_numbers", "rent_history_records",
      "rent_requests", "repayments", "review_images", "review_responses",
      "review_votes", "staff_profiles", "subscription_charge_logs",
      "subscription_charges", "supporter_agreement_acceptance", "supporter_invites",
      "supporter_referrals", "supporter_roi_payments", "system_events",
      "tenant_agreement_acceptance", "tenant_merchant_payments", "tenant_ratings",
      "tenant_replacements", "transaction_approvals", "user_activity_log",
      "user_loan_repayments", "user_loans", "user_locations", "user_receipts",
      "user_reviews", "user_risk_scores", "voided_ledger_entries",
      "wallet_deposits", "wallet_transactions", "welile_homes_subscriptions",
      "wishlists", "withdrawal_requests"
    ];

    let dump = `-- Welile Database Export\n-- Generated: ${new Date().toISOString()}\n-- Environment: Test\n\nBEGIN;\n\n`;

    // Get enum types
    const { data: enums } = await supabase.from("profiles").select("id").limit(0);

    // Add known enums
    dump += `-- Custom Types / Enums\n`;
    dump += `DO $$ BEGIN\n  CREATE TYPE public.collection_payment_method AS ENUM ('cash', 'mobile_money');\nEXCEPTION WHEN duplicate_object THEN NULL;\nEND $$;\n\n`;
    dump += `DO $$ BEGIN\n  CREATE TYPE public.app_role AS ENUM ('admin', 'moderator', 'user');\nEXCEPTION WHEN duplicate_object THEN NULL;\nEND $$;\n\n`;

    // Get table DDL via information_schema
    for (const tableName of allTables) {
      console.log(`Exporting table: ${tableName}`);

      // Get columns
      const { data: columns, error: colErr } = await supabase.rpc("get_table_columns", { p_table: tableName });

      if (colErr || !columns) {
        // Fallback: just export data
        dump += `-- Table: ${tableName} (schema not available, data only)\n`;
      }

      // Get all data (handle pagination for large tables)
      let allRows: any[] = [];
      let offset = 0;
      const pageSize = 1000;
      let hasMore = true;

      while (hasMore) {
        const { data: rows, error } = await supabase
          .from(tableName)
          .select("*")
          .range(offset, offset + pageSize - 1);

        if (error) {
          dump += `-- Error reading ${tableName}: ${error.message}\n\n`;
          hasMore = false;
          break;
        }

        if (rows && rows.length > 0) {
          allRows = allRows.concat(rows);
          offset += pageSize;
          hasMore = rows.length === pageSize;
        } else {
          hasMore = false;
        }
      }

      if (allRows.length > 0) {
        const cols = Object.keys(allRows[0]);
        dump += `-- Table: ${tableName} (${allRows.length} rows)\n`;
        dump += `DELETE FROM public.${tableName};\n`;

        for (const row of allRows) {
          const values = cols.map(c => {
            const v = row[c];
            if (v === null || v === undefined) return "NULL";
            if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
            if (typeof v === "number") return String(v);
            if (typeof v === "object") return `'${JSON.stringify(v).replace(/'/g, "''")}'::jsonb`;
            return `'${String(v).replace(/'/g, "''")}'`;
          });
          dump += `INSERT INTO public.${tableName} (${cols.map(c => `"${c}"`).join(", ")}) VALUES (${values.join(", ")}) ON CONFLICT DO NOTHING;\n`;
        }
        dump += `\n`;
      } else {
        dump += `-- Table: ${tableName} (0 rows)\n\n`;
      }
    }

    dump += `COMMIT;\n`;

    return new Response(dump, {
      headers: {
        ...corsHeaders,
        "Content-Type": "application/sql",
        "Content-Disposition": `attachment; filename="welile_export_${new Date().toISOString().split('T')[0]}.sql"`,
      },
    });
  } catch (error) {
    console.error("Export error:", error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
