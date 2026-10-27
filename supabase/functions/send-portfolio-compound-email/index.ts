// Sends the "Portfolio Compounded" email from RECORDED facts.
//
// The COO page used to assemble this email in the browser at the moment of the
// click. That produced emails carrying the previous cycle's value and the
// account name instead of the portfolio code. Now the page only says "this
// portfolio was just compounded"; everything in the email is read from the
// recorded compounding event (public.portfolio_compound_email_facts).
//
// Body: { portfolio_id: uuid, reference?: "CMP-…", dry_run?: boolean }
//   reference omitted -> the latest compounding event of that portfolio.
//   dry_run: true     -> builds the exact payload and returns it. Nothing is sent.
//
// One email per compounding event: the idempotency key is the compounding
// reference, so a double click or a retry can never send it twice.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  buildCompoundEmailData,
  compoundEmailIdempotencyKey,
  type CompoundFacts,
} from "../_shared/compoundEmail.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const json = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Placeholder addresses created for partners who have no real email. */
const isRealEmail = (e: string | null | undefined): e is string =>
  !!e && e.includes("@") && !e.endsWith("@welile.user") && !e.endsWith("@noapp.welile.user");

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(supabaseUrl, serviceKey);

  // Caller must be signed-in Welile staff (the COO page), or the service role.
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) return json(401, { error: "Unauthorized" });
  if (token !== serviceKey) {
    const { data: { user }, error: authErr } = await admin.auth.getUser(token);
    if (authErr || !user) return json(401, { error: "Unauthorized" });
    const { data: isStaff } = await admin.rpc("is_welile_staff", { _user_id: user.id });
    if (isStaff !== true) return json(403, { error: "Staff only" });
  }

  let body: { portfolio_id?: string; reference?: string | null; dry_run?: boolean } = {};
  try { body = await req.json(); } catch { /* handled below */ }
  const portfolioId = String(body.portfolio_id ?? "");
  if (!UUID.test(portfolioId)) return json(400, { error: "portfolio_id must be a uuid" });
  const reference = body.reference ? String(body.reference) : null;

  const { data: facts, error: factsErr } = await admin.rpc("portfolio_compound_email_facts", {
    p_portfolio_id: portfolioId,
    p_reference: reference,
  });
  if (factsErr) return json(500, { error: `Could not read the compounding record: ${factsErr.message}` });
  if (!facts || (facts as CompoundFacts).error) {
    return json(404, { error: (facts as CompoundFacts | null)?.error ?? "compound_event_not_found" });
  }

  const f = facts as CompoundFacts;
  const to = f.partner?.email ?? null;
  const data = buildCompoundEmailData(f);
  const idempotencyKey = compoundEmailIdempotencyKey(
    String(f.partner?.id ?? ""), f.portfolio.id, String(f.compound.reference ?? f.compound.at),
  );

  if (body.dry_run === true) {
    return json(200, { dry_run: true, would_send_to: isRealEmail(to) ? to : null, idempotency_key: idempotencyKey, data });
  }

  if (!isRealEmail(to)) return json(200, { sent: false, reason: "partner_has_no_real_email" });

  const res = await fetch(`${supabaseUrl}/functions/v1/send-transactional-email`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${serviceKey}` },
    body: JSON.stringify({
      templateName: "partner-portfolio-compounded",
      recipientEmail: to,
      idempotencyKey,
      templateData: data,
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    console.warn("[send-portfolio-compound-email] send failed:", res.status, text.slice(0, 300));
    return json(502, { sent: false, error: `send-transactional-email returned ${res.status}` });
  }
  let out: Record<string, unknown> = {};
  try { out = await res.json(); } catch { /* body is optional */ }
  const suppressed = out.success === false && out.reason === "email_suppressed";
  return json(200, {
    sent: out.success === true && out.queued !== false,
    suppressed,
    reason: suppressed ? "email_suppressed" : (out.success === false ? String(out.reason ?? "not_sent") : undefined),
    idempotency_key: idempotencyKey,
  });
});
