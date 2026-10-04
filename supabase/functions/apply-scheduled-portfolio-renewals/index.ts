import { createClient } from "npm:@supabase/supabase-js@2";
import { evaluateRenewalPayoutGate } from "../_shared/renewalPayoutGate.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const fmtDate = (d: Date) =>
  d.toLocaleDateString("en-GB", { day: "2-digit", month: "long", year: "numeric" });

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const admin = createClient(supabaseUrl, serviceKey);

    const today = new Date();
    const todayStr = today.toISOString().slice(0, 10);

    // Batch-fetch every portfolio whose scheduled effective date has arrived,
    // joining the investor profile so we resolve name + email in one round-trip.
    const { data: scheduledDue, error: dueErr } = await admin
      .from("investor_portfolios")
      .select(
        `id, portfolio_code, account_name, investor_id, investment_amount,
         roi_percentage, duration_months, maturity_date, pending_renewal_effective_date,
         pending_renewal_request_id, next_roi_date, created_at, payout_day,
         investor:profiles!investor_portfolios_investor_id_fkey(email, full_name)`,
      )
      .not("pending_renewal_effective_date", "is", null)
      .lte("pending_renewal_effective_date", todayStr)
      .limit(1000);

    if (dueErr) throw dueErr;

    // Also auto-renew any ACTIVE portfolio that has silently passed its
    // maturity date without a scheduled renewal — otherwise expired portfolios
    // sit un-rolled and payouts run against a matured principal.
    const { data: expiredNoSchedule, error: expErr } = await admin
      .from("investor_portfolios")
      .select(
        `id, portfolio_code, account_name, investor_id, investment_amount,
         roi_percentage, duration_months, maturity_date, pending_renewal_effective_date,
         pending_renewal_request_id, next_roi_date, created_at, payout_day,
         investor:profiles!investor_portfolios_investor_id_fkey(email, full_name)`,
      )
      .eq("status", "active")
      .not("maturity_date", "is", null)
      .lte("maturity_date", todayStr)
      .is("pending_renewal_effective_date", null)
      .limit(1000);
    if (expErr) throw expErr;

    // And portfolios explicitly parked in the `matured` status — these are the
    // "pending renewal" rows Partner Ops sees; they must roll automatically.
    const { data: maturedStatus, error: matErr } = await admin
      .from("investor_portfolios")
      .select(
        `id, portfolio_code, account_name, investor_id, investment_amount,
         roi_percentage, duration_months, maturity_date, pending_renewal_effective_date,
         pending_renewal_request_id, next_roi_date, created_at, payout_day,
         investor:profiles!investor_portfolios_investor_id_fkey(email, full_name)`,
      )
      .eq("status", "matured")
      .limit(1000);
    if (matErr) throw matErr;

    const seen = new Set<string>();
    const due = [
      ...(scheduledDue || []),
      ...(expiredNoSchedule || []),
      ...(maturedStatus || []),
    ].filter((r: any) => {
      if (seen.has(r.id)) return false;
      seen.add(r.id);
      return true;
    });

    // Resolve a system actor once (cron has no auth.uid())
    let systemActor: string | null = null;
    const { data: cfo } = await admin
      .from("user_roles")
      .select("user_id")
      .eq("role", "cfo")
      .limit(1)
      .maybeSingle();
    systemActor = cfo?.user_id ?? null;
    if (!systemActor) {
      const { data: mgr } = await admin
        .from("user_roles")
        .select("user_id")
        .eq("role", "manager")
        .limit(1)
        .maybeSingle();
      systemActor = mgr?.user_id ?? null;
    }
    if (!systemActor) return json({ error: "no_system_actor" }, 500);

    let renewed = 0;
    let emailed = 0;
    let skipped = 0;
    let deferredForPayout = 0;
    const deferred: Array<{ portfolio_id: string; reason: string; cycle_date: string }> = [];
    const errors: Array<{ portfolio_id: string; error: string }> = [];

    for (const row of due ?? []) {
      try {
        // Payout-completion gate: never renew ahead of a due ROI payout.
        // Renewal resets next_roi_date/total_roi_earned, so renewing first makes
        // the 09:00 EAT payout run read the portfolio as "not due" and skip the
        // final-cycle ROI. Defer instead — the payout run renews it afterwards.
        const gate = await evaluateRenewalPayoutGate(admin, {
          id: row.id,
          next_roi_date: (row as any).next_roi_date ?? null,
          created_at: (row as any).created_at,
          payout_day: (row as any).payout_day ?? null,
        });
        if (!gate.allowed) {
          deferredForPayout++;
          deferred.push({ portfolio_id: row.id, reason: gate.reason, cycle_date: gate.cycleDate });
          console.log(
            `[apply-scheduled-portfolio-renewals] Deferred ${row.portfolio_code} — ${gate.reason} (cycle ${gate.cycleDate})`,
          );
          continue;
        }

        const { data: res, error: renewErr } = await admin.rpc(
          "apply_portfolio_renewal",
          {
            p_portfolio_id: row.id,
            p_renewed_by: systemActor,
            p_reason: "Nightly auto-renewal at scheduled maturity",
            p_source: "nightly_cron",
            p_is_auto: true,
          },
        );
        if (renewErr) throw renewErr;
        if ((res as any)?.skipped) {
          skipped++;
          continue;
        }
        renewed++;

        const investor: any = (row as any).investor;
        const email: string | null = investor?.email ?? null;
        const isRealEmail =
          !!email &&
          !email.endsWith("@welile.user") &&
          !email.endsWith("@noapp.welile.user");
        if (isRealEmail) {
          const r: any = res;
          const emailRes = await fetch(
            `${supabaseUrl}/functions/v1/send-transactional-email`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${serviceKey}`,
              },
              body: JSON.stringify({
                templateName: "portfolio-renewal",
                recipientEmail: email,
                idempotencyKey: `portfolio-auto-renewed-${row.id}-${todayStr}`,
                templateData: {
                  partner_name: investor?.full_name || "Partner",
                  portfolio_name:
                    r?.account_name || row.account_name || row.portfolio_code,
                  portfolio_id: r?.portfolio_code || row.portfolio_code,
                  amount: Number(r?.investment_amount ?? row.investment_amount ?? 0),
                  new_principal: Number(
                    r?.investment_amount ?? row.investment_amount ?? 0,
                  ),
                  return_rate: `${r?.roi_percentage ?? row.roi_percentage}%`,
                  renewal_date: fmtDate(new Date(r?.new_start || Date.now())),
                  maturity_date: fmtDate(
                    new Date(`${r?.new_maturity_date}T00:00:00Z`),
                  ),
                  duration: `${r?.duration_months ?? row.duration_months} months`,
                  currency: "UGX",
                  company_name: "Welile",
                  logo_url: "https://welileapp.com/welile-logo.png",
                  unsubscribe_url: "https://welile.com/unsubscribe",
                  terms_url: "https://welileapp.com/partners-terms",
                  privacy_url: "https://welileapp.com/privacy",
                  days_remaining: 0,
                  days_remaining_label: "Applied today",
                },
              }),
            },
          );
          if (emailRes.ok) emailed++;
        }
      } catch (e) {
        errors.push({ portfolio_id: row.id, error: (e as Error).message });
      }
    }

    return json({
      ok: true,
      due_count: due?.length ?? 0,
      renewed,
      skipped,
      deferred_for_payout: deferredForPayout,
      deferred,
      emailed,
      errors,
    });
  } catch (err) {
    console.error("[apply-scheduled-portfolio-renewals] failed", err);
    return json({ error: (err as Error).message || "internal_error" }, 500);
  }
});