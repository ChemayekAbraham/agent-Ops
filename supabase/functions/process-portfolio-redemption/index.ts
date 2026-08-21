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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "Unauthorized" }, 401);

    const admin = createClient(supabaseUrl, serviceKey);
    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: userErr } = await admin.auth.getUser(token);
    if (userErr || !user) return json({ error: "Unauthorized" }, 401);

    // Only ops roles may process a redemption
    const { data: roles } = await admin
      .from("user_roles")
      .select("role")
      .eq("user_id", user.id);
    const allowed = ["manager", "coo", "cfo", "ceo", "super_admin", "cto", "partner_ops"];
    const hasAccess = (roles || []).some((r: any) => allowed.includes(r.role));
    if (!hasAccess) return json({ error: "forbidden" }, 403);

    const body = await req.json().catch(() => ({}));
    const {
      request_id,
      scope,
      amount,
      note,
      dry_run = false,
      is_test = false,
      email_override,
      skip_email = false,
    } = body as Record<string, any>;

    if (!request_id) return json({ error: "request_id required" }, 400);
    if (scope !== "full" && scope !== "partial") return json({ error: "scope must be full or partial" }, 400);

    const { data: reqRow, error: reqErr } = await admin
      .from("portfolio_action_requests")
      .select(
        `id, portfolio_id, request_type, status, partner_id, partner_name, partner_email,
         portfolio_code, portfolio_name, portfolio_value, currency,
         portfolio:investor_portfolios!portfolio_action_requests_portfolio_id_fkey(
           id, portfolio_code, account_name, investor_id, investment_amount,
           roi_percentage, duration_months, maturity_date, next_roi_date, status
         )`,
      )
      .eq("id", request_id)
      .maybeSingle();

    if (reqErr || !reqRow) return json({ error: "request_not_found" }, 404);
    if (reqRow.request_type !== "REDEMPTION_REQUEST")
      return json({ error: "not_a_redemption_request" }, 400);
    if (reqRow.status === "completed" || reqRow.status === "cancelled")
      return json({ error: `already_${reqRow.status}` }, 409);

    const portfolio: any = reqRow.portfolio;
    if (!portfolio) return json({ error: "portfolio_missing" }, 404);

    const principal = Number(portfolio.investment_amount || 0);
    const redeemed = scope === "full" ? principal : Math.round(Number(amount || 0));
    if (scope === "partial") {
      if (!(redeemed > 0)) return json({ error: "amount_must_be_positive" }, 400);
      if (redeemed > principal) return json({ error: "amount_exceeds_principal" }, 400);
    }
    const remaining = principal - redeemed;

    // Preview only — no writes, no email.
    if (dry_run) {
      return json({
        dry_run: true,
        portfolio_code: portfolio.portfolio_code,
        scope: remaining === 0 ? "full" : "partial",
        previous_principal: principal,
        redeemed_amount: redeemed,
        remaining_principal: remaining,
      });
    }

    const { data: result, error: rpcErr } = await admin.rpc("apply_portfolio_redemption", {
      p_request_id: request_id,
      p_scope: scope,
      p_amount: scope === "partial" ? redeemed : null,
      p_note: note ?? null,
      p_processed_by: user.id,
      p_is_test: !!is_test,
    });
    if (rpcErr) throw rpcErr;

    const res: any = result;

    // Resolve recipient (request snapshot → profile), honouring an explicit
    // test override so smoke runs never mail a real partner.
    let recipientEmail: string | null = email_override || (reqRow.partner_email as string | null);
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

    const templateData = {
      partner_name: partnerName,
      portfolio_name: res?.account_name || portfolio.account_name || portfolio.portfolio_code,
      portfolio_id: res?.portfolio_code || portfolio.portfolio_code,
      scope: res?.scope || (remaining === 0 ? "full" : "partial"),
      redeemed_amount: Number(res?.redeemed_amount ?? redeemed),
      previous_principal: Number(res?.old_principal ?? principal),
      remaining_principal: Number(res?.remaining_principal ?? remaining),
      return_rate: `${res?.roi_percentage ?? portfolio.roi_percentage ?? 15}%`,
      maturity_date: portfolio.maturity_date ? fmtDate(new Date(`${portfolio.maturity_date}T00:00:00Z`)) : "",
      next_payout_date: portfolio.next_roi_date ? fmtDate(new Date(`${portfolio.next_roi_date}T00:00:00Z`)) : "",
      processed_date: fmtDate(new Date()),
      settlement_window_days: 90,
      expected_payout_by: fmtDate(new Date(Date.now() + 90 * 24 * 60 * 60 * 1000)),
      currency: reqRow.currency || "UGX",
      company_name: "Welile",
      logo_url: "https://welileapp.com/welile-logo.png",
      unsubscribe_url: "https://welile.com/unsubscribe",
      terms_url: "https://welileapp.com/partners-terms",
      privacy_url: "https://welileapp.com/privacy",
    };

    let emailStatus: unknown = "skipped";
    if (!skip_email && isRealEmail) {
      const mail = await fetch(`${supabaseUrl}/functions/v1/send-transactional-email`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${serviceKey}` },
        body: JSON.stringify({
          templateName: "portfolio-redemption",
          recipientEmail,
          idempotencyKey: `portfolio-redemption-${res?.redemption_id}`,
          templateData,
        }),
      });
      emailStatus = { ok: mail.ok, status: mail.status };
    }

    return json({
      ok: true,
      redemption: res,
      email: emailStatus,
      email_preview: templateData,
    });
  } catch (err) {
    console.error("[process-portfolio-redemption] failed", err);
    return json({ error: (err as Error).message || "internal_error" }, 500);
  }
});
