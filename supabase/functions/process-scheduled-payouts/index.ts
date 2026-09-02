import "../_shared/smsFooterInterceptor.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { checkTreasuryGuard } from "../_shared/treasuryGuard.ts";
import { attemptYoolaPrimary } from "../_shared/yoolaPrimary.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function formatPhoneInternational(phone: string): string {
  const digits = phone.replace(/[^0-9]/g, "");
  if (digits.startsWith("256")) return `+${digits}`;
  if (digits.startsWith("0")) return `+256${digits.slice(1)}`;
  if (digits.length === 9) return `+256${digits}`;
  return `+${digits}`;
}

async function sendSMS(phone: string, message: string): Promise<boolean> {
  if (await attemptYoolaPrimary(phone, message, { source: "process-scheduled-payouts" })) return true;
  const apiKey = Deno.env.get("AFRICASTALKING_API_KEY");
  const username = Deno.env.get("AFRICASTALKING_USERNAME");
  if (!apiKey || !username) {
    console.error("[process-scheduled-payouts] Missing AT credentials");
    return false;
  }
  const isSandbox = username.toLowerCase() === "sandbox";
  const baseUrl = isSandbox
    ? "https://api.sandbox.africastalking.com/version1/messaging"
    : "https://api.africastalking.com/version1/messaging";
  try {
    const body = new URLSearchParams({
      username, from: "WELILE",
      to: formatPhoneInternational(phone),      message,
    });
    const res = await fetch(baseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        apiKey,
        Accept: "application/json",
      },
      body: body.toString(),
    });
    const raw = await res.text();
    let data: any;
    try { data = JSON.parse(raw); } catch { return false; }
    const recipients = data?.SMSMessageData?.Recipients || [];
    return recipients.some((r: any) => r.statusCode === 101 || r.statusCode === 100);
  } catch (err) {
    console.error("[process-scheduled-payouts] SMS error:", err);
    return false;
  }
}

// Compute the next run timestamp from the current run time + recurrence config.
function computeNextRun(from: Date, payout: any): Date {
  const next = new Date(from);
  switch (payout.frequency) {
    case "daily":
      next.setDate(next.getDate() + 1);
      return next;
    case "weekly": {
      const target = ((Number(payout.day_of_week ?? 1) % 7) + 7) % 7;
      let diff = (target - next.getDay() + 7) % 7;
      if (diff === 0) diff = 7;
      next.setDate(next.getDate() + diff);
      return next;
    }
    case "interval":
      next.setDate(next.getDate() + Math.max(1, Number(payout.interval_days ?? 1)));
      return next;
    case "monthly":
    default:
      next.setMonth(next.getMonth() + 1);
      return next;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const adminClient = createClient(supabaseUrl, serviceKey);

  // Treasury guard: scheduled payouts must respect maintenance freeze
  const guardBlock = await checkTreasuryGuard(adminClient, "any");
  if (guardBlock) return guardBlock;

  try {
    const now = new Date();

    // Optional scoping: `{ "payout_id": "<uuid>" }` restricts this run to a
    // single standing order. Used for targeted restorations so no other
    // scheduled payout is executed.
    let onlyPayoutId: string | null = null;
    try {
      const body = req.method === "POST" ? await req.json() : null;
      const pid = body?.payout_id;
      if (typeof pid === "string" && /^[0-9a-f-]{36}$/i.test(pid)) onlyPayoutId = pid;
    } catch (_) { /* no body -> full scheduled sweep */ }

    // Find all enabled scheduled payouts where next_run_at <= now
    let dueQuery = adminClient
      .from("scheduled_payouts")
      .select("*")
      .eq("enabled", true)
      .lte("next_run_at", now.toISOString());
    if (onlyPayoutId) dueQuery = dueQuery.eq("id", onlyPayoutId);
    const { data: duePays, error: fetchErr } = await dueQuery;

    if (fetchErr) {
      console.error("[process-scheduled-payouts] Fetch error:", fetchErr.message);
      throw fetchErr;
    }

    if (!duePays?.length) {
      return new Response(JSON.stringify({ processed: 0, message: "No due payouts" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    let processed = 0;
    let failed = 0;

    for (const payout of duePays) {
      try {
        // ── Per-cycle idempotency ────────────────────────────────────────
        // A cycle is identified by its scheduled next_run_at. If a successful
        // run already exists at/after that timestamp, the cycle is paid and
        // must never be credited twice (e.g. on a manual re-trigger).
        const { data: alreadyPaid } = await adminClient
          .from("scheduled_payout_runs")
          .select("id")
          .eq("scheduled_payout_id", payout.id)
          .eq("status", "success")
          .gte("ran_at", payout.next_run_at)
          .maybeSingle();
        if (alreadyPaid) {
          console.log(`[process-scheduled-payouts] cycle already paid for ${payout.id}, skipping`);
          const skipNext = computeNextRun(new Date(payout.next_run_at), payout);
          await adminClient.from("scheduled_payouts")
            .update({ next_run_at: skipNext.toISOString() })
            .eq("id", payout.id);
          continue;
        }

        // Look up category config to get wallet/platform categories
        const catMap: Record<string, { walletCat: string; platformCat: string; impact: string }> = {
          roi_payout: { walletCat: 'roi_wallet_credit', platformCat: 'roi_expense', impact: 'expense' },
          agent_commission: { walletCat: 'agent_commission_earned', platformCat: 'agent_commission_earned', impact: 'expense' },
          payroll: { walletCat: 'salary_payout', platformCat: 'payroll_expense', impact: 'expense' },
          // Wallet leg uses `wallet_deposit` (user-visible), NOT
          // `system_balance_correction` — that category is excluded from the
          // nightly `reconcile_wallet_cache_to_ledger` reconciliation, which
          // wipes it back out of withdrawable_balance every night at 02:15
          // UTC. `system_balance_correction` is reserved for one-off admin
          // corrections/write-offs, not recurring operational payouts. The
          // platform leg keeps `system_balance_correction` — it's the
          // company's own ledger, not a user wallet, and isn't affected.
          marketing_expenses: { walletCat: 'wallet_deposit', platformCat: 'system_balance_correction', impact: 'expense' },
          research_development: { walletCat: 'wallet_deposit', platformCat: 'system_balance_correction', impact: 'expense' },
          operational_expense: { walletCat: 'wallet_deposit', platformCat: 'system_balance_correction', impact: 'expense' },
          correction_credit: { walletCat: 'system_balance_correction', platformCat: 'system_balance_correction', impact: 'neutral' },
          wallet_transfer_out: { walletCat: 'wallet_transfer', platformCat: 'wallet_transfer', impact: 'neutral' },
        };

        const catConfig = catMap[payout.category_id] || catMap['operational_expense'];
        const subLabel = payout.sub_category ? ` → ${payout.sub_category}` : '';

        // Resolve recipient name for run history + SMS.
        const { data: recipientProfile } = await adminClient
          .from("profiles")
          .select("phone, full_name")
          .eq("id", payout.target_user_id)
          .maybeSingle();
        const recipientName = recipientProfile?.full_name ?? null;

        // Call cfo-direct-credit via internal fetch with service role
        const res = await fetch(`${supabaseUrl}/functions/v1/cfo-direct-credit`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${serviceKey}`,
          },
          body: JSON.stringify({
            // Server-to-server call: cfo-direct-credit only accepts the
            // service-role bearer when this flag is present.
            system_requisition_credit: true,
            target_user_id: payout.target_user_id,
            amount: Number(payout.amount),
            reason: `[Automated] ${payout.reason}${subLabel}`,
            operation: 'credit',
            recipient_type: 'user',
            wallet_category: catConfig.walletCat,
            platform_category: catConfig.platformCat,
            financial_impact: catConfig.impact,
            category_label: `Auto: ${payout.category_id}${subLabel}`,
            sub_category: payout.sub_category,
          }),
        });

        if (!res.ok) {
          const errBody = await res.text();
          console.error(`[process-scheduled-payouts] Failed for payout ${payout.id}:`, errBody);
          await adminClient.from("scheduled_payout_runs").insert({
            scheduled_payout_id: payout.id,
            target_user_id: payout.target_user_id,
            recipient_name: recipientName,
            amount: Number(payout.amount),
            reason: payout.reason,
            category_id: payout.category_id,
            status: 'failed',
            error_message: errBody?.slice(0, 500) ?? 'Unknown error',
          });
          failed++;
          continue;
        }

        // Record the successful automated run for per-individual history.
        // Customer advance recovery from ROI (only for ROI payouts).
        if (payout.category_id === 'roi_payout') {
          try {
            await adminClient.rpc('apply_roi_advance_recovery', {
              p_user_id: payout.target_user_id,
              p_roi_amount: Number(payout.amount),
              p_source_id: null,
              p_idempotency_key: `sched-${payout.id}-${now.toISOString().slice(0, 10)}`,
            });
          } catch (recErr) {
            console.error(`[process-scheduled-payouts] ROI advance recovery failed for ${payout.id}:`, recErr);
          }
        }

        await adminClient.from("scheduled_payout_runs").insert({
          scheduled_payout_id: payout.id,
          target_user_id: payout.target_user_id,
          recipient_name: recipientName,
          amount: Number(payout.amount),
          reason: payout.reason,
          category_id: payout.category_id,
          status: 'success',
        });

        // Notify the recipient via SMS to pull them onto the platform/wallet.
        try {
          const profile = recipientProfile;
          if (profile?.phone) {
            const firstName = (profile.full_name || "there").split(" ")[0];
            const amountStr = Number(payout.amount).toLocaleString();
            const msg = `Hi ${firstName}, UGX ${amountStr} has landed in your WELILE wallet (${payout.reason}). Log in to view & cash out: welileapp.com`;
            await sendSMS(profile.phone, msg);
          }
        } catch (smsErr) {
          console.error(`[process-scheduled-payouts] SMS notify failed for ${payout.id}:`, smsErr);
        }

        // Advance next_run_at based on the schedule frequency.
        const nextRun = computeNextRun(new Date(payout.next_run_at), payout);

        await adminClient.from("scheduled_payouts").update({
          last_run_at: now.toISOString(),
          next_run_at: nextRun.toISOString(),
        }).eq("id", payout.id);

        processed++;
      } catch (innerErr) {
        console.error(`[process-scheduled-payouts] Error processing ${payout.id}:`, innerErr);
        failed++;
      }
    }

    return new Response(JSON.stringify({ processed, failed, total: duePays.length }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("[process-scheduled-payouts] Error:", e.message);
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
