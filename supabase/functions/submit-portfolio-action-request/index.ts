import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PARTNERSHIP_TEAM_EMAIL = "weliletechnologies@gmail.com";

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

const fmtDate = (iso: string | null | undefined): string => {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "long", year: "numeric" });
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const authHeader = req.headers.get("Authorization") || "";
    const token = authHeader.replace("Bearer ", "").trim();
    if (!token) return json({ error: "Missing authorization header" }, 401);

    const adminClient = createClient(supabaseUrl, serviceKey);
    const { data: { user }, error: authErr } = await adminClient.auth.getUser(token);
    if (authErr || !user) return json({ error: "Unauthorized" }, 401);

    const body = await req.json().catch(() => ({})) as {
      portfolioId?: string;
      requestType?: string;
      message?: string;
    };

    const requestType = String(body.requestType || "").toUpperCase();
    if (requestType !== "RENEWAL_REQUEST" && requestType !== "REDEMPTION_REQUEST") {
      return json({ error: "Invalid request type" }, 400);
    }
    const portfolioRef = String(body.portfolioId || "").trim();
    if (!portfolioRef) return json({ error: "Portfolio reference is required" }, 400);

    const message = String(body.message || "").trim().slice(0, 4000);

    // Load the portfolio by UUID or portfolio_code
    const SELECT_COLS = "id, portfolio_code, account_name, investment_amount, total_roi_earned, maturity_date, display_currency, investor_id, agent_id, status";
    let portfolioQuery = adminClient.from("investor_portfolios").select(SELECT_COLS);
    portfolioQuery = UUID.test(portfolioRef)
      ? portfolioQuery.eq("id", portfolioRef)
      : portfolioQuery.eq("portfolio_code", portfolioRef);
    const { data: portfolio, error: pErr } = await portfolioQuery.maybeSingle();
    if (pErr) return json({ error: `Failed to load portfolio: ${pErr.message}` }, 500);
    if (!portfolio) return json({ error: "Portfolio not found" }, 404);

    // Ownership check — partner must own the portfolio (investor or agent on the record)
    if (portfolio.investor_id !== user.id && portfolio.agent_id !== user.id) {
      return json({ error: "You are not authorized to act on this portfolio" }, 403);
    }

    // Partner profile (name + email)
    const { data: profile } = await adminClient
      .from("profiles")
      .select("full_name, email")
      .eq("id", user.id)
      .maybeSingle();
    const partnerName = profile?.full_name || "Partner";
    const partnerEmail = (profile?.email || user.email || "").trim();

    // Duplicate-pending guard (also enforced by a unique index)
    const { data: existing } = await adminClient
      .from("portfolio_action_requests")
      .select("id")
      .eq("portfolio_id", portfolio.id)
      .eq("request_type", requestType)
      .eq("status", "pending")
      .maybeSingle();
    if (existing) {
      return json({
        error: requestType === "RENEWAL_REQUEST"
          ? "You already have a pending renewal request for this portfolio."
          : "You already have a pending redemption request for this portfolio.",
        duplicate: true,
      }, 409);
    }

    const portfolioCode = portfolio.portfolio_code || `PF-${String(portfolio.id).replace(/-/g, "").slice(0, 8).toUpperCase()}`;
    const portfolioName = portfolio.account_name || "Partnership Portfolio";
    const portfolioValue = Number(portfolio.investment_amount) || 0;
    const currency = portfolio.display_currency || "UGX";
    const submittedAtIso = new Date().toISOString();

    // Store the request
    const { data: inserted, error: insErr } = await adminClient
      .from("portfolio_action_requests")
      .insert({
        portfolio_id: portfolio.id,
        portfolio_code: portfolioCode,
        portfolio_name: portfolioName,
        portfolio_value: portfolioValue,
        maturity_date: portfolio.maturity_date,
        partner_id: user.id,
        partner_name: partnerName,
        partner_email: partnerEmail,
        request_type: requestType,
        status: "pending",
        message,
        currency,
      })
      .select("id, created_at")
      .single();

    if (insErr) {
      // Unique index violation = a concurrent duplicate slipped through
      if (/duplicate key|unique/i.test(insErr.message)) {
        return json({ error: "You already have a pending request of this type for this portfolio.", duplicate: true }, 409);
      }
      return json({ error: `Failed to store request: ${insErr.message}` }, 500);
    }

    const requestReference = `REQ-${String(inserted.id).replace(/-/g, "").slice(0, 8).toUpperCase()}`;
    const submittedAt = fmtDate(submittedAtIso);
    const maturityDate = fmtDate(portfolio.maturity_date);

    // Fire the emails (failures don't block the success response)
    const sendEmail = async (payload: Record<string, unknown>) => {
      try {
        await fetch(`${supabaseUrl}/functions/v1/send-transactional-email`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${serviceKey}` },
          body: JSON.stringify(payload),
        });
      } catch (e) {
        console.warn("[submit-portfolio-action-request] email failed:", e);
      }
    };

    // 1) Email to Partnership Team
    await sendEmail({
      templateName: "portfolio-request-team-alert",
      recipientEmail: PARTNERSHIP_TEAM_EMAIL,
      idempotencyKey: `portfolio-request-team-${inserted.id}`,
      templateData: {
        partner_name: partnerName,
        partner_email: partnerEmail,
        portfolio_name: portfolioName,
        portfolio_id: portfolioCode,
        portfolio_value: portfolioValue,
        maturity_date: maturityDate,
        request_type: requestType,
        request_reference: requestReference,
        submitted_at: submittedAt,
        message,
        currency,
        company_name: "Welile",
      },
    });

    // 2) Confirmation email to the partner
    if (partnerEmail) {
      await sendEmail({
        templateName: "portfolio-request-confirmation",
        recipientEmail: partnerEmail,
        idempotencyKey: `portfolio-request-confirm-${inserted.id}`,
        templateData: {
          partner_name: partnerName,
          portfolio_name: portfolioName,
          portfolio_id: portfolioCode,
          portfolio_value: portfolioValue,
          maturity_date: maturityDate,
          request_type: requestType,
          request_reference: requestReference,
          submitted_at: submittedAt,
          currency,
          company_name: "Welile",
        },
      });
    }

    return json({
      ok: true,
      requestId: inserted.id,
      requestReference,
      requestType,
    }, 200);
  } catch (err) {
    console.error("[submit-portfolio-action-request] fatal:", err);
    return json({ error: (err as Error)?.message || "Unexpected error" }, 500);
  }
});