// Partner confirmation email for an APPROVED self-managed portfolio top-up.
//
// Phase 2 (operational-float funding) requires that every capital deployment a
// partner makes produces a confirmation email. Portfolio creation/approval is
// already covered by approve-pending-portfolio; top-ups were not — this closes
// that gap. Fire-and-forget from the Partner Ops review screen: it never blocks
// or reverses an approval.
//
// Single round trip per entity, no N+1: one query for the top-up + commitment,
// one for the partner profile, one batched query for the funded tenants.
import { createClient } from "npm:@supabase/supabase-js@2";
import { dispatchTransactionalEmail } from "../_shared/partnership-emails.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function jsonRes(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

const fmtDate = (iso: string | null | undefined) => {
  if (!iso) return "";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-GB", { day: "2-digit", month: "long", year: "numeric" });
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const admin = createClient(supabaseUrl, serviceKey);

    const authHeader = req.headers.get("Authorization") ?? "";
    const token = authHeader.replace("Bearer ", "");
    const { data: userData } = await admin.auth.getUser(token);
    if (!userData?.user) return jsonRes({ error: "Not authenticated" }, 401);

    const body = await req.json().catch(() => ({}));
    const topupId = String(body?.topup_id ?? "");
    if (!UUID_RE.test(topupId)) return jsonRes({ error: "A valid top-up id is required" }, 400);

    const { data: topup, error: tErr } = await admin
      .from("partner_self_topups")
      .select(
        "id, partner_id, amount, status, effective_at, prorata_amount, rent_request_ids, " +
        "commitment:partner_self_commitments!inner(id, monthly_rate, term_months, term_end_at, next_payout_at)",
      )
      .eq("id", topupId)
      .maybeSingle();

    if (tErr) {
      console.error("[notify-self-topup-approved] lookup failed:", tErr.message);
      return jsonRes({ error: "Could not load the top-up" }, 500);
    }
    if (!topup) return jsonRes({ error: "Top-up not found" }, 404);
    if (topup.status !== "approved") {
      return jsonRes({ skipped: true, reason: `status=${topup.status}` }, 200);
    }

    const { data: partner } = await admin
      .from("profiles")
      .select("full_name, email")
      .eq("id", topup.partner_id)
      .maybeSingle();

    if (!partner?.email) return jsonRes({ skipped: true, reason: "no_partner_email" }, 200);

    // Batched tenant lookup — one query for every funded plan in this top-up.
    const ids: string[] = Array.isArray(topup.rent_request_ids) ? topup.rent_request_ids : [];
    let tenants: Array<{ tenant_name: string; tenant_location: string; principal: number }> = [];
    if (ids.length > 0) {
      const { data: plans } = await admin
        .from("rent_requests")
        .select("id, rent_amount, tenant:profiles!rent_requests_tenant_id_fkey(full_name, location)")
        .in("id", ids);
      tenants = (plans ?? []).map((p: any) => ({
        tenant_name: p.tenant?.full_name || "Tenant",
        tenant_location: p.tenant?.location || "",
        principal: Number(p.rent_amount ?? 0),
      }));
    }

    const commitment: any = Array.isArray(topup.commitment) ? topup.commitment[0] : topup.commitment;
    const rate = Number(commitment?.monthly_rate ?? 15);
    const amount = Number(topup.amount);

    try {
      await dispatchTransactionalEmail(supabaseUrl, serviceKey, {
        templateName: "partner-self-managed-deployment",
        recipientEmail: partner.email,
        idempotencyKey: `partner-self-managed-topup-${topupId}`,
        templateData: {
          partner_name: partner.full_name || "Partner",
          portfolio_reference: `Top-up · ${commitment?.id ?? ""}`.slice(0, 60),
          principal_amount: amount,
          monthly_return_amount: Math.round(amount * (rate / 100)),
          roi_percentage: rate,
          term_months: Number(commitment?.term_months ?? 1),
          deployment_date: fmtDate(topup.effective_at),
          first_payout_date: fmtDate(commitment?.next_payout_at),
          tenants_count: tenants.length,
          tenants,
          currency: "UGX",
          company_name: "Welile",
          logo_url: "https://welileapp.com/welile-logo.png",
          dashboard_url: "https://welileapp.com/dashboard/funder",
        },
      });
    } catch (e) {
      console.warn("[notify-self-topup-approved] email failed:", (e as Error)?.message);
      return jsonRes({ sent: false, error: (e as Error)?.message }, 200);
    }

    return jsonRes({ sent: true, recipient: partner.email, tenants: tenants.length }, 200);
  } catch (e) {
    console.error("[notify-self-topup-approved] fatal:", (e as Error)?.message);
    return jsonRes({ error: (e as Error)?.message ?? "Unexpected error" }, 500);
  }
});
