import { createClient } from "npm:@supabase/supabase-js@2";

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

// Shared email dispatch — used by both immediate and scheduled paths, and
// mirrored in `apply-scheduled-portfolio-renewals` so we only maintain one
// template contract.
async function sendPartnerRenewalEmail(opts: {
  supabaseUrl: string;
  serviceKey: string;
  variant: "renewed" | "scheduled";
  recipientEmail: string;
  partnerName: string;
  portfolioName: string;
  portfolioCode: string;
  amount: number;
  roiPercentage: number | string;
  durationMonths: number;
  effectiveDate: Date;
  maturityDate: Date;
  daysRemaining: number;
  idempotencyKey: string;
}) {
  const templateData = {
    partner_name: opts.partnerName || "Partner",
    portfolio_name: opts.portfolioName || opts.portfolioCode,
    portfolio_id: opts.portfolioCode,
    amount: opts.amount,
    old_principal: opts.amount,
    new_principal: opts.amount,
    return_rate: `${opts.roiPercentage}%`,
    renewal_date: fmtDate(opts.effectiveDate),
    maturity_date: fmtDate(opts.maturityDate),
    duration: `${opts.durationMonths} months`,
    currency: "UGX",
    company_name: "Welile",
    logo_url: "https://welileapp.com/welile-logo.png",
    unsubscribe_url: "https://welile.com/unsubscribe",
    terms_url: "https://welileapp.com/partners-terms",
    privacy_url: "https://welileapp.com/privacy",
    // consumed only by the scheduled variant (template gracefully ignores extras)
    scheduled: opts.variant === "scheduled",
    scheduled_date: fmtDate(opts.effectiveDate),
    // Countdown context — shown in both variants so the partner sees whether
    // the renewal is immediate ("today") or scheduled ("in N days").
    days_remaining: opts.daysRemaining,
    days_remaining_label:
      opts.daysRemaining <= 0
        ? "Applied today"
        : `Auto-applies in ${opts.daysRemaining} day${opts.daysRemaining === 1 ? "" : "s"}`,
  };

  const subjectOverride =
    opts.variant === "scheduled"
      ? `Portfolio Renewal Scheduled for ${fmtDate(opts.effectiveDate)} — ${opts.portfolioCode}`
      : undefined;

  const res = await fetch(`${opts.supabaseUrl}/functions/v1/send-transactional-email`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${opts.serviceKey}`,
    },
    body: JSON.stringify({
      templateName: "portfolio-renewal",
      recipientEmail: opts.recipientEmail,
      idempotencyKey: opts.idempotencyKey,
      subject: subjectOverride,
      templateData,
    }),
  });
  return { ok: res.ok, status: res.status, body: await res.text().catch(() => "") };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "Unauthorized" }, 401);

    const admin = createClient(supabaseUrl, serviceKey);
    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: userErr } = await userClient.auth.getUser();
    if (userErr || !user) return json({ error: "Unauthorized" }, 401);

    const { request_id } = await req.json().catch(() => ({}));
    if (!request_id) return json({ error: "request_id required" }, 400);

    // Load request + linked portfolio in one round-trip (no N+1)
    const { data: reqRow, error: reqErr } = await admin
      .from("portfolio_action_requests")
      .select(
        `id, portfolio_id, request_type, status, partner_id, partner_name, partner_email,
         portfolio_code, portfolio_name, portfolio_value, currency,
         portfolio:investor_portfolios!portfolio_action_requests_portfolio_id_fkey(
           id, portfolio_code, account_name, investor_id, investment_amount,
           roi_percentage, duration_months, maturity_date, payout_day, status
         )`,
      )
      .eq("id", request_id)
      .maybeSingle();

    if (reqErr || !reqRow) return json({ error: "request_not_found" }, 404);
    if (reqRow.request_type !== "RENEWAL_REQUEST")
      return json({ error: "not_a_renewal_request" }, 400);
    if (reqRow.status === "completed" || reqRow.status === "cancelled")
      return json({ error: `already_${reqRow.status}` }, 409);

    const portfolio: any = reqRow.portfolio;
    if (!portfolio) return json({ error: "portfolio_missing" }, 404);

    // Resolve recipient email (prefer request's snapshot, fall back to profile)
    let recipientEmail = reqRow.partner_email as string | null;
    let partnerName = (reqRow.partner_name as string | null) || "Partner";
    if (!recipientEmail && portfolio.investor_id) {
      const { data: prof } = await admin
        .from("profiles")
        .select("email, full_name")
        .eq("id", portfolio.investor_id)
        .maybeSingle();
      recipientEmail = prof?.email ?? null;
      if (prof?.full_name) partnerName = prof.full_name;
    }
    const isRealEmail =
      !!recipientEmail &&
      !recipientEmail.endsWith("@welile.user") &&
      !recipientEmail.endsWith("@noapp.welile.user");

    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const matDate = portfolio.maturity_date
      ? new Date(`${portfolio.maturity_date}T00:00:00Z`)
      : null;
    const daysRemaining = matDate
      ? Math.floor((matDate.getTime() - today.getTime()) / 86400000)
      : 0;

    // Path A: matured (day 0 or past) → renew now
    if (daysRemaining <= 0) {
      const { data: renewRes, error: renewErr } = await admin.rpc(
        "apply_portfolio_renewal",
        {
          p_portfolio_id: portfolio.id,
          p_renewed_by: user.id,
          p_reason: `Partner Ops approved renewal request ${request_id}`,
        },
      );
      if (renewErr) throw renewErr;

      await admin
        .from("portfolio_action_requests")
        .update({ status: "completed" })
        .eq("id", request_id);

      if (isRealEmail) {
        const nm = renewRes as any;
        await sendPartnerRenewalEmail({
          supabaseUrl,
          serviceKey,
          variant: "renewed",
          recipientEmail: recipientEmail!,
          partnerName,
          portfolioName: nm?.account_name || portfolio.account_name || portfolio.portfolio_code,
          portfolioCode: nm?.portfolio_code || portfolio.portfolio_code,
          amount: Number(nm?.investment_amount ?? portfolio.investment_amount ?? 0),
          roiPercentage: nm?.roi_percentage ?? portfolio.roi_percentage,
          durationMonths: Number(nm?.duration_months ?? portfolio.duration_months ?? 12),
          effectiveDate: new Date(nm?.new_start || Date.now()),
          maturityDate: new Date(`${nm?.new_maturity_date}T00:00:00Z`),
          daysRemaining: 0,
          idempotencyKey: `portfolio-renewed-${portfolio.id}-${request_id}`,
        });
      }

      return json({
        mode: "renewed_now",
        portfolio_id: portfolio.id,
        result: renewRes,
      });
    }

    // Path B: not yet matured → schedule + notify partner it's queued
    const effectiveDate = matDate!; // renew on maturity date
    const { error: updErr } = await admin
      .from("investor_portfolios")
      .update({
        pending_renewal_effective_date: portfolio.maturity_date,
        pending_renewal_duration_months: portfolio.duration_months,
        pending_renewal_request_id: request_id,
      })
      .eq("id", portfolio.id);
    if (updErr) throw updErr;

    await admin
      .from("portfolio_action_requests")
      .update({ status: "completed" })
      .eq("id", request_id);

    if (isRealEmail) {
      const projectedMaturity = new Date(effectiveDate);
      projectedMaturity.setMonth(
        projectedMaturity.getMonth() + (portfolio.duration_months || 12),
      );
      await sendPartnerRenewalEmail({
        supabaseUrl,
        serviceKey,
        variant: "scheduled",
        recipientEmail: recipientEmail!,
        partnerName,
        portfolioName: portfolio.account_name || portfolio.portfolio_code,
        portfolioCode: portfolio.portfolio_code,
        amount: Number(portfolio.investment_amount ?? 0),
        roiPercentage: portfolio.roi_percentage,
        durationMonths: portfolio.duration_months || 12,
        effectiveDate,
        maturityDate: projectedMaturity,
        daysRemaining,
        idempotencyKey: `portfolio-renewal-scheduled-${portfolio.id}-${request_id}`,
      });
    }

    return json({
      mode: "scheduled",
      portfolio_id: portfolio.id,
      effective_date: portfolio.maturity_date,
      days_remaining: daysRemaining,
    });
  } catch (err) {
    console.error("[process-portfolio-renewal] failed", err);
    return json({ error: (err as Error).message || "internal_error" }, 500);
  }
});