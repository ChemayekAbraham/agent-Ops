// ═══════════════════════════════════════════════════════════════════════════
// Resend Portfolio Invite
// Partner Ops → re-sends the completion invite for a portfolio still sitting
// at `awaiting_partner_details`. The original link expires after 7 days with
// no resend path, which stranded invites (partner wallet already debited at
// creation) — this mints a FRESH token, extends the expiry, and re-emails the
// invite with a unique idempotency key so the second/third invite is never
// deduped or perceived as the same message.
// ═══════════════════════════════════════════════════════════════════════════
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function generateToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "Missing authorization header" }, 401);
    const token = authHeader.replace("Bearer ", "");

    const admin = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const { data: authData, error: authErr } = await admin.auth.getUser(token);
    const caller = authData?.user;
    if (authErr || !caller) return json({ error: "Not authenticated" }, 401);

    const { data: isOps, error: opsErr } = await admin.rpc("is_partner_ops", { _uid: caller.id });
    if (opsErr) {
      console.error("[resend-portfolio-invite] role check failed:", opsErr);
      return json({ error: "Could not verify your permissions. Please retry." }, 500);
    }
    if (!isOps) return json({ error: "You do not have permission to resend portfolio invites." }, 403);

    let body: { portfolio_id?: string; copy_to?: string };
    try { body = await req.json(); } catch { return json({ error: "Invalid request." }, 400); }
    const portfolioId = String(body.portfolio_id || "");
    if (!UUID.test(portfolioId)) return json({ error: "A valid portfolio is required." }, 400);
    const copyTo = String(body.copy_to || "").trim().toLowerCase();
    if (copyTo && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(copyTo)) {
      return json({ error: "The copy recipient email is invalid." }, 400);
    }

    const { data: portfolio, error: pErr } = await admin
      .from("investor_portfolios")
      .select("id, investor_id, portfolio_code, investment_amount, roi_percentage, roi_mode, duration_months, status, created_at")
      .eq("id", portfolioId)
      .maybeSingle();
    if (pErr) return json({ error: `Portfolio lookup failed: ${pErr.message}` }, 500);
    if (!portfolio) return json({ error: "Portfolio not found." }, 404);
    if (portfolio.status !== "awaiting_partner_details" && portfolio.status !== "pending_ops_approval") {
      return json({
        error: `This portfolio is at "${portfolio.status}" — it can only be resent while awaiting partner details or pending Ops approval.`,
      }, 400);
    }

    const { data: partner, error: prErr } = await admin
      .from("profiles")
      .select("id, full_name, email, phone, frozen_at")
      .eq("id", portfolio.investor_id)
      .maybeSingle();
    if (prErr) return json({ error: `Partner lookup failed: ${prErr.message}` }, 500);
    if (!partner?.email) return json({ error: "Partner has no email on file — add one before resending." }, 400);
    if ((partner as { frozen_at?: string | null }).frozen_at) {
      return json({ error: "This partner's account is suspended. Unfreeze it before resending the invite." }, 403);
    }

    const origin = req.headers.get("origin") || "https://welileapp.com";

    // Both pipeline statuses use the completion invite. A pending Ops row can
    // originate from an older flow that never created a token, so UPSERT rather
    // than UPDATE: this guarantees a real, fresh 7-day link in every resend.
    const rawToken = generateToken();
    const tokenHash = await sha256Hex(rawToken);
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

    const { error: tokErr } = await admin
      .from("portfolio_completion_tokens")
      .upsert({
        portfolio_id: portfolioId,
        partner_id: portfolio.investor_id,
        token_hash: tokenHash,
        expires_at: expiresAt,
        consumed_at: null,
        email_snapshot: partner.email,
        phone_snapshot: partner.phone,
        created_by: caller.id,
      }, { onConflict: "portfolio_id" });
    if (tokErr) {
      console.error("[resend-portfolio-invite] token rotation failed:", tokErr);
      return json({ error: `Could not refresh the invite link: ${tokErr.message}` }, 500);
    }

    const completionUrl =
      `${origin}/partners/${portfolio.investor_id}/portfolios/${portfolioId}/complete?token=${encodeURIComponent(rawToken)}`;
    const recipients = [partner.email, ...(copyTo && copyTo !== partner.email.toLowerCase() ? [copyTo] : [])];

    for (const recipientEmail of recipients) {
      const { error: emailErr } = await admin.functions.invoke("send-transactional-email", {
        body: {
          templateName: "partner-portfolio-invite",
          recipientEmail,
          // Unique per resend so the pipeline never treats it as a duplicate.
          idempotencyKey: `portfolio-invite-${portfolioId}-${recipientEmail}-${Date.now()}`,
          templateData: {
            partner_name: partner.full_name || "Partner",
            portfolio_code: portfolio.portfolio_code,
            amount: Number(portfolio.investment_amount || 0),
            duration_months: portfolio.duration_months,
            roi_percentage: portfolio.roi_percentage,
            roi_mode: portfolio.roi_mode,
            completion_url: completionUrl,
            currency: "UGX",
            company_name: "Welile",
          },
        },
      });
      if (emailErr) {
        console.error("[resend-portfolio-invite] email dispatch failed:", emailErr);
        return json({
          error: "The invite link was refreshed, but the email could not be sent. Please retry.",
        }, 502);
      }
    }

    await admin.from("audit_logs").insert({
      user_id: caller.id,
      action_type: "resend_portfolio_invite",
      table_name: "investor_portfolios",
      record_id: portfolioId,
      metadata: {
        partner_id: portfolio.investor_id,
        portfolio_code: portfolio.portfolio_code,
        recipient_email: partner.email,
        copy_to: copyTo || null,
        expires_at: expiresAt,
        reason: "partner_requested_fresh_completion_invite",
      },
    });

    return json({
      success: true,
      portfolio_id: portfolioId,
      portfolio_code: portfolio.portfolio_code,
      partner_email: partner.email,
      copied_to: copyTo || null,
      expires_at: expiresAt,
    }, 200);
  } catch (e) {
    console.error("[resend-portfolio-invite] unexpected error:", e);
    return json({ error: (e as Error)?.message || "Unexpected error" }, 500);
  }
});
