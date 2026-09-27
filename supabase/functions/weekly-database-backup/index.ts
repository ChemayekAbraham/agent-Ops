import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const RECIPIENTS = ["joshwanda17@gmail.com", "weliletechnologies@gmail.com", "ssenkaali.pius@welile.com"];
const SIGNED_URL_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days
// Previously this function built every INSERT statement row-by-row in JS, which
// burned the worker CPU budget (546 WORKER_RESOURCE_LIMIT) and forced a 20s soft
// deadline that truncated the dump to ~39 tables. We now stream CSV straight from
// PostgREST so Postgres does the serialization and the worker only copies bytes —
// this is near-zero CPU and lets the full dump complete.
const SOFT_DEADLINE_MS = 55_000;
// Safety caps so a single huge table (e.g. general_ledger at 40M+ scale) can never
// produce an unbounded file. Streaming bytes is cheap, so these can be generous.
const MAX_TOTAL_ROWS = 3_000_000;
const MAX_ROWS_PER_TABLE = 1_000_000;

const TABLES = [
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
  "wishlists", "withdrawal_requests", "backup_runs",
];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  // Resolve actor (user who triggered the backup) for the notification email.
  let actorName = "System (scheduled cron)";
  const actorUserAgent = req.headers.get("user-agent") || "n/a";
  const actorTimestamp = new Date().toISOString();
  try {
    const authHeader = req.headers.get("Authorization") || "";
    const token = authHeader.replace(/^Bearer\s+/i, "").trim();
    if (token) {
      const { data: userData } = await supabase.auth.getUser(token);
      const uid = userData?.user?.id;
      if (uid) {
        const { data: profile } = await supabase
          .from("profiles")
          .select("full_name, email, phone_number")
          .eq("id", uid)
          .maybeSingle();
        actorName = profile?.full_name
          || profile?.email
          || profile?.phone_number
          || userData.user.email
          || uid;
      }
    }
  } catch (_) { /* fall back to system actor */ }

  const startedAt = new Date();
  const stamp = startedAt.toISOString().replace(/[:.]/g, "-");
  const fileName = `welile_export_${stamp}.csv`;
  const storagePath = `${startedAt.getUTCFullYear()}/${fileName}`;

  let totalRows = 0;
  let tablesProcessed = 0;
  let sizeBytes = 0;
  let truncated = false;

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        const push = (s: string) => {
          const b = encoder.encode(s);
          sizeBytes += b.byteLength;
          controller.enqueue(b);
        };
        const pushBytes = (b: Uint8Array) => {
          sizeBytes += b.byteLength;
          controller.enqueue(b);
        };
        try {
          push(`-- Welile Weekly Database Backup (CSV bundle)\n-- Generated: ${startedAt.toISOString()}\n`);
          push(`-- Format: one CSV section per table. Restore each section with: \\copy public.<table> FROM '...' WITH (FORMAT csv, HEADER true)\n\n`);

          for (const tableName of TABLES) {
            if (Date.now() - startedAt.getTime() > SOFT_DEADLINE_MS || totalRows >= MAX_TOTAL_ROWS) {
              truncated = true;
              push(`\n-- !! Time budget reached before processing "${tableName}". Remaining tables were skipped to keep this backup valid.\n\n`);
              break;
            }
            tablesProcessed++;

            // Stream the whole table as CSV directly from PostgREST. Postgres builds
            // the CSV, so the worker only forwards bytes (near-zero CPU).
            const resp = await fetch(
              `${supabaseUrl}/rest/v1/${tableName}?select=*`,
              {
                headers: {
                  apikey: serviceKey,
                  Authorization: `Bearer ${serviceKey}`,
                  Accept: "text/csv",
                  "Range-Unit": "items",
                  Range: `0-${MAX_ROWS_PER_TABLE - 1}`,
                  Prefer: "count=exact",
                },
              },
            );

            if (!resp.ok) {
              const txt = await resp.text().catch(() => "");
              push(`-- Error reading ${tableName}: ${resp.status} ${txt}\n\n`);
              continue;
            }

            // Content-Range looks like "0-499/12345" — grab the exact total.
            const cr = resp.headers.get("content-range") || "";
            const totalForTable = Number(cr.split("/")[1]) || 0;
            const fetchedForTable = Math.min(totalForTable, MAX_ROWS_PER_TABLE);
            totalRows += fetchedForTable;

            push(`\n-- ===== TABLE: ${tableName} (${fetchedForTable}${totalForTable > fetchedForTable ? ` of ${totalForTable}` : ""} rows) =====\n`);

            if (resp.body) {
              const reader = resp.body.getReader();
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                if (value) pushBytes(value);
              }
            }
            push(`\n`);

            if (totalForTable > fetchedForTable) {
              truncated = true;
              push(`-- !! "${tableName}" has ${totalForTable} rows; capped at ${MAX_ROWS_PER_TABLE}.\n`);
            }
          }
          push(`\n-- End of backup.\n`);
          controller.close();
        } catch (e) {
          controller.error(e);
        }
      },
    });

    const uploadResp = await fetch(
      `${supabaseUrl}/storage/v1/object/db-backups/${storagePath}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${serviceKey}`,
          apikey: serviceKey,
          "Content-Type": "text/csv",
          "x-upsert": "false",
        },
        body: stream,
        // @ts-ignore - Deno fetch supports duplex for streaming bodies
        duplex: "half",
      },
    );
    if (!uploadResp.ok) {
      const txt = await uploadResp.text();
      throw new Error(`Upload failed: ${uploadResp.status} ${txt}`);
    }
    await uploadResp.text();

    const { data: signed, error: signErr } = await supabase.storage
      .from("db-backups")
      .createSignedUrl(storagePath, SIGNED_URL_TTL_SECONDS);
    if (signErr || !signed) throw new Error(`Sign failed: ${signErr?.message}`);

    const sizeMb = (sizeBytes / (1024 * 1024)).toFixed(2);

    // Send email to each recipient
    for (const email of RECIPIENTS) {
      try {
        await supabase.functions.invoke("send-transactional-email", {
          body: {
            templateName: "database-backup-ready",
            recipientEmail: email,
            idempotencyKey: `db-backup-${stamp}-${email}`,
            templateData: {
              downloadUrl: signed.signedUrl,
              fileName,
              sizeMb,
              tableCount: tablesProcessed,
              rowCount: totalRows,
              generatedAt: startedAt.toISOString(),
              expiresInHours: 168,
            actorName,
            actorTimestamp,
            actorUserAgent,
            },
          },
        });
      } catch (e) {
        console.error(`Failed to email ${email}:`, e);
      }
    }

    await supabase.from("backup_runs").insert({
      storage_path: storagePath,
      size_bytes: sizeBytes,
      table_count: tablesProcessed,
      row_count: totalRows,
      status: truncated ? "partial" : "success",
      recipients: RECIPIENTS,
    });

    return new Response(JSON.stringify({
      success: true,
      truncated,
      storagePath,
      signedUrl: signed.signedUrl,
      fileName,
      sizeBytes,
      tableCount: tablesProcessed,
      rowCount: totalRows,
      generatedAt: startedAt.toISOString(),
      expiresInHours: 168,
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("Backup failed:", msg);
    await supabase.from("backup_runs").insert({
      storage_path: storagePath, status: "failed", error_message: msg, recipients: RECIPIENTS,
    });
    return new Response(JSON.stringify({ success: false, error: msg }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});