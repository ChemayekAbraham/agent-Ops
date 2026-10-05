// Partner Ops → approves a portfolio that was completed by the partner.
// Debits the partner wallet for the portfolio amount, flips
// 'pending_ops_approval' → 'active', and dispatches the standard
// partnership-agreement email (existing template) so the partner receives
// their final signed portfolio confirmation.
//
// Bug fix (2026-07-27): the invite flow previously activated portfolios
// WITHOUT ever debiting the partner wallet — money stayed in the wallet
// while the portfolio was live. Debit now happens here atomically before
// status flips to 'active'. Idempotency key `portfolio-funding-<id>`
// makes retries safe.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { buildPartnershipAgreementRequest, dispatchTransactionalEmail } from "../_shared/partnership-emails.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "Missing authorization header" }, 401);

    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user: caller }, error: authErr } = await userClient.auth.getUser();
    if (authErr || !caller) return json({ error: "Unauthorized" }, 401);

    let body: any;
    try { body = await req.json(); } catch { return json({ error: "Invalid JSON body" }, 400); }

    const portfolioId = String(body?.portfolio_id || "");
    if (!UUID.test(portfolioId)) return json({ error: "Invalid portfolio ID" }, 400);

    const admin = createClient(supabaseUrl, serviceKey);

    // AUTHORIZATION FIRST. The wallet debit below must never run for a caller
    // that the DB gate will reject, otherwise the partner is debited while the
    // portfolio stays pending.
    const { data: isOps, error: opsErr } = await admin.rpc("is_partner_ops", {
      _uid: caller.id,
    });
    if (opsErr) {
      console.error("[approve-pending-portfolio] role check failed:", opsErr);
      return json({ error: "Could not verify your permissions. Please retry." }, 500);
    }
    if (!isOps) {
      const { data: roleRows } = await admin
        .from("user_roles").select("role").eq("user_id", caller.id);
      const roles = (roleRows ?? []).map((r: any) => r.role).join(", ") || "none";
      console.warn("[approve-pending-portfolio] NOT_AUTHORIZED caller:", caller.id, caller.email, roles);
      return json({
        error: `Only Partner Operations can approve portfolios. You are signed in as ${caller.email ?? caller.id} with roles: ${roles}. Ask an administrator to grant the Partner Operations role to this exact account.`,
      }, 403);
    }

    // Load the portfolio + partner up-front so we can debit the wallet
    // BEFORE the RPC flips it to 'active'. This closes the historical
    // bug where invite-flow portfolios were activated without any wallet
    // deduction (see backfill list dated 2026-07-27).
    const { data: preRow, error: preErr } = await admin
      .from("investor_portfolios")
      .select("id, investor_id, investment_amount, portfolio_code, status")
      .eq("id", portfolioId).maybeSingle();
    if (preErr) return json({ error: `Portfolio lookup failed: ${preErr.message}` }, 500);
    if (!preRow) return json({ error: "Portfolio not found." }, 404);
    if (!["pending_ops_approval", "awaiting_partner_details"].includes(String(preRow.status))) {
      return json({ error: "This portfolio is not awaiting approval." }, 409);
    }

    const partnerId = String(preRow.investor_id);
    const amount = Number(preRow.investment_amount);
    const portfolioCode = String(preRow.portfolio_code || "");

    // Which funding path is this? Self-managed tenants / self-support houses are
    // funded from the partner's OPERATIONAL FLOAT bucket, and that debit is
    // posted inside `approve_pending_portfolio` (idempotency keys
    // `psm-commit-*` / `psh-commit-*`) atomically with the landlord float
    // release. Posting the generic withdrawable-bucket debit here as well would
    // charge the partner twice out of the wrong bucket, so it is skipped for
    // those sources — the rent-pool path keeps the pre-debit.
    const { data: prePending } = await admin
      .from("funder_pending_portfolios")
      .select("source")
      .eq("portfolio_id", portfolioId)
      .maybeSingle();
    const fundedFromFloatByRpc = ["self_managed", "self_managed_house"]
      .includes(String(prePending?.source || ""));

    const { data: isStaffReinvest, error: srErr } = await admin.rpc("hr_pay_is_staff_reinvest_portfolio", { _portfolio_id: portfolioId });
    if (srErr) {
      console.error("[approve-pending-portfolio] staff-reinvest check failed:", srErr);
      return json({ error: "Could not verify the portfolio's funding source. Portfolio was NOT activated. Please retry." }, 500);
    }
    const fundedFromPayroll = isStaffReinvest === true;

    // Skip re-debit if a partner_funding cash_out leg already exists for this
    // portfolio (defensive against retries or historical funding paths).
    const { data: existingDebit } = await admin
      .from("general_ledger")
      .select("id")
      .eq("source_table", "investor_portfolios")
      .eq("source_id", portfolioId)
      .eq("category", "partner_funding")
      .eq("direction", "cash_out")
      .limit(1)
      .maybeSingle();

    if (!existingDebit && !fundedFromFloatByRpc && !fundedFromPayroll) {

      // Funding source = OPERATIONAL FLOAT (never withdrawable).
      // `funder_float_available` subtracts `funder_pending_hold`, which holds
      // back every *pending* funder_pending_portfolios row without a wallet
      // debit yet — including THIS portfolio. Add its own hold back before
      // comparing; every other pending commitment stays held.
      const { data: floatAvailRaw, error: availErr } = await admin.rpc(
        "funder_float_available",
        { p_user_id: partnerId },
      );
      if (availErr) {
        console.error("[approve-pending-portfolio] float balance lookup failed:", availErr);
        return json({ error: "Could not verify partner operational float. Please retry." }, 500);
      }
      const { data: ownHoldRow } = await admin
        .from("funder_pending_portfolios")
        .select("amount")
        .eq("portfolio_id", portfolioId)
        .eq("funder_id", partnerId)
        .eq("status", "pending")
        .maybeSingle();
      const ownHold = Number(ownHoldRow?.amount ?? 0);
      const floatAvail = Number(floatAvailRaw ?? 0) + ownHold;
      if (floatAvail < amount) {
        return json({
          error: `Insufficient partner operational float. Need UGX ${amount.toLocaleString()}, but only UGX ${floatAvail.toLocaleString()} of float is available. Fund the partner's operational float before approving.`,
        }, 400);
      }

      const idempotencyKey = `portfolio-funding-${portfolioId}`;
      const { error: ledgerErr } = await admin.rpc("create_ledger_transaction", {
        idempotency_key: idempotencyKey,
        entries: [
          {
            user_id: partnerId,
            amount,
            direction: "cash_out",
            category: "partner_funding",
            ledger_scope: "wallet",
            recipient_type: "operational_wallet",
            wallet_bucket: "float",
            description: `Operational float deployed to portfolio ${portfolioCode} (float_usage=partner_portfolio_funding)`,
            source_table: "investor_portfolios",
            source_id: portfolioId,
            reference_id: portfolioCode,
            linked_party: "platform",
          },

          {
            amount,
            direction: "cash_in",
            category: "partner_funding",
            ledger_scope: "platform",
            description: `Platform capital received for portfolio ${portfolioCode}`,
            source_table: "investor_portfolios",
            source_id: portfolioId,
            reference_id: portfolioCode,
            linked_party: partnerId,
          },
        ],
      });
      if (ledgerErr) {
        console.error("[approve-pending-portfolio] wallet debit failed:", ledgerErr);
        const msg = (ledgerErr as any).message || "unknown error";
        return json({
          error: `Wallet deduction failed: ${msg}. Portfolio was NOT activated.`,
        }, 500);
      }
    } else if (fundedFromPayroll) {
      console.log("[approve-pending-portfolio] Staff salary reinvestment portfolio", portfolioId, "— funded by payroll; no wallet debit.");
    } else if (fundedFromFloatByRpc) {
      console.log(
        "[approve-pending-portfolio] Self-managed/self-support portfolio",
        portfolioId,
        "— operational float debit is posted by approve_pending_portfolio; skipping pre-debit.",
      );
    } else {
      console.log("[approve-pending-portfolio] Debit already posted for", portfolioId, "— skipping.");
    }


    // RPC enforces the Ops-role gate + status transition atomically.
    const { error: rpcErr } = await userClient.rpc("approve_pending_portfolio", {
      p_portfolio_id: portfolioId,
    });
    if (rpcErr) {
      const msg = rpcErr.message || "";
      console.error("[approve-pending-portfolio] RPC failed:", caller.id, caller.email, JSON.stringify(rpcErr));
      if (msg.includes("NOT_AUTHORIZED")) {
        // Two distinct gates can raise this: the Partner Ops gate in the RPC,
        // and the reviewer gate inside psm_disburse_landlord_float. Never
        // collapse them into one misleading "you are not Partner Ops".
        return json({
          error: `Approval was blocked by a permission gate: ${msg}. Signed in as ${caller.email ?? caller.id}.`,
        }, 403);
      }
      if (msg.includes("INVALID_STATUS")) return json({ error: "This portfolio is not awaiting approval." }, 409);
      if (msg.includes("PORTFOLIO_NOT_FOUND")) return json({ error: "Portfolio not found." }, 404);
      return json({ error: `Wallet was debited but portfolio activation failed: ${msg}. Contact operations.` }, 500);
    }

    // Fetch portfolio + partner for the final email.
    const { data: portfolio, error: pErr } = await admin
      .from("investor_portfolios")
      .select("id, investor_id, investment_amount, roi_percentage, roi_mode, duration_months, payout_day, portfolio_code, next_roi_date, created_at")
      .eq("id", portfolioId).maybeSingle();
    if (pErr || !portfolio) {
      console.warn("[approve-pending-portfolio] Portfolio lookup after approval failed:", pErr?.message);
      return json({ success: true, portfolio_id: portfolioId }, 200);
    }

    const { data: partner } = await admin
      .from("profiles").select("full_name, email").eq("id", portfolio.investor_id).maybeSingle();

    // Self-managed portfolios (partner picked the tenants themselves) get a
    // dedicated deployment confirmation instead of the managed agreement email.
    const { data: pendingRow } = await admin
      .from("funder_pending_portfolios")
      .select("source, commitment_id, term_months")
      .eq("portfolio_id", portfolioId)
      .maybeSingle();
    const source = String(pendingRow?.source || "");
    const isSelfManagedTenants = source === "self_managed";
    // Empty-house self support: no tenant, no landlord/agent float — but the
    // partner must receive the SAME deployment confirmation email.
    const isSelfManagedHouses = source === "self_managed_house";
    const isSelfManaged = isSelfManagedTenants || isSelfManagedHouses;

    // Self-managed approval has just released the principal as landlord float
    // (inside the approve_pending_portfolio transaction) and queued one SMS per
    // agent+landlord. Drain that queue now — fire and forget.
    // House support never disburses landlord/agent float, so it is skipped.
    if (isSelfManagedTenants && pendingRow?.commitment_id) {
      try {
        await fetch(`${supabaseUrl}/functions/v1/notify-partner-float-agents`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${serviceKey}` },
          body: JSON.stringify({ commitment_id: pendingRow.commitment_id }),
        });
      } catch (smsErr) {
        console.warn("[approve-pending-portfolio] agent float SMS dispatch failed:", smsErr);
      }
    }

    if (partner?.email && isSelfManaged) {
      const monthlyReward = Math.round(Number(portfolio.investment_amount) * (Number(portfolio.roi_percentage) / 100));
      let tenants: Array<Record<string, unknown>> = [];
      // Supported empty houses reuse the same template rows — each line is a
      // house instead of a tenant.
      try {
        if (isSelfManagedHouses && pendingRow?.commitment_id) {
          const { data: hrows } = await admin
            .from("partner_supported_houses")
            .select("principal, house_id")
            .eq("commitment_id", pendingRow.commitment_id);
          const houseIds = (hrows || []).map((h: any) => h.house_id).filter(Boolean);
          const houseById: Record<string, any> = {};
          if (houseIds.length) {
            const { data: listings } = await admin
              .from("house_listings")
              .select("id, title, house_category, address, village, district, image_urls")
              .in("id", houseIds);
            for (const l of (listings || []) as any[]) houseById[l.id] = l;
          }
          tenants = (hrows || []).map((h: any) => {
            const l = houseById[h.house_id] || {};
            const location = Array.from(
              new Set([l.address, l.village, l.district].map((v: any) => (typeof v === "string" ? v.trim() : "")).filter(Boolean)),
            ).join(", ");
            const label = l.title
              || (typeof l.house_category === "string" ? l.house_category.replace(/_/g, " ") : "")
              || "Empty house";
            return {
              tenant_name: label,
              tenant_location: location,
              tenant_photo_url: Array.isArray(l.image_urls) ? (l.image_urls[0] || "") : "",
              principal: Number(h.principal),
            };
          });
        } else if (pendingRow?.commitment_id) {
          const { data: lines } = await admin
            .from("partner_self_funding_lines")
            .select("principal, rent_request_id")
            .eq("commitment_id", pendingRow.commitment_id);
          const ids = (lines || []).map((l: any) => l.rent_request_id);
          const byId: Record<string, { name: string; location: string; photo: string }> = {};
          if (ids.length) {
            const { data: reqs, error: reqErr } = await admin
              .from("rent_requests")
              .select("id, tenant_id, request_city, tenant_photo_url, house_listing_id")
              .in("id", ids);
            if (reqErr) console.warn("[approve-pending-portfolio] rent_requests lookup:", reqErr.message);

            const tenantIds = (reqs || []).map((r: any) => r.tenant_id).filter(Boolean);
            const { data: profs } = tenantIds.length
              ? await admin
                  .from("profiles")
                  .select("id, full_name, avatar_url, village, district, city")
                  .in("id", tenantIds)
              : { data: [] as any[] };
            const profById: Record<string, any> = {};
            for (const p of (profs || []) as any[]) profById[p.id] = p;

            // House address (best location signal) comes from the linked listing.
            const listingIds = (reqs || []).map((r: any) => r.house_listing_id).filter(Boolean);
            const listingById: Record<string, any> = {};
            if (listingIds.length) {
              const { data: listings } = await admin
                .from("house_listings")
                .select("id, address, village, district")
                .in("id", listingIds);
              for (const l of (listings || []) as any[]) listingById[l.id] = l;
            }

            for (const r of (reqs || []) as any[]) {
              const prof = profById[r.tenant_id] || {};
              const listing = r.house_listing_id ? listingById[r.house_listing_id] || {} : {};
              const parts = [
                listing.address || listing.village || prof.village,
                listing.district || prof.district,
                r.request_city || prof.city,
              ]
                .map((v: any) => (typeof v === "string" ? v.trim() : ""))
                .filter(Boolean);
              const location = Array.from(new Set(parts)).join(", ");
              byId[r.id] = {
                name: prof.full_name || "Tenant",
                location,
                photo: r.tenant_photo_url || prof.avatar_url || "",
              };
            }
          }
          tenants = (lines || []).map((l: any) => ({
            tenant_name: byId[l.rent_request_id]?.name || "Tenant",
            tenant_location: byId[l.rent_request_id]?.location || "",
            tenant_photo_url: byId[l.rent_request_id]?.photo || "",
            principal: Number(l.principal),
          }));
        }
      } catch (e) {
        console.warn("[approve-pending-portfolio] tenant lines lookup failed:", (e as Error)?.message);
      }

      const fmtDate = (iso: string | null | undefined) => {
        if (!iso) return "";
        const d = new Date(iso);
        return isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-GB", { day: "2-digit", month: "long", year: "numeric" });
      };

      try {
        await dispatchTransactionalEmail(supabaseUrl, serviceKey, {
          templateName: "partner-self-managed-deployment",
          recipientEmail: partner.email,
          idempotencyKey: `partner-self-managed-deployment-${portfolioId}`,
          templateData: {
            partner_name: partner.full_name || "Partner",
            portfolio_reference: portfolio.portfolio_code || "",
            principal_amount: Number(portfolio.investment_amount),
            monthly_return_amount: monthlyReward,
            roi_percentage: Number(portfolio.roi_percentage),
            term_months: Number(pendingRow?.term_months || portfolio.duration_months || 1),
            deployment_date: fmtDate(portfolio.created_at),
            first_payout_date: fmtDate(portfolio.next_roi_date),
            tenants_count: tenants.length,
            tenants,
            currency: "UGX",
            company_name: "Welile",
            logo_url: "https://welileapp.com/welile-logo.png",
            dashboard_url: "https://welileapp.com/dashboard/funder",
          },
        });
      } catch (e) {
        console.warn("[approve-pending-portfolio] Self-managed deployment email failed:", (e as Error)?.message);
      }
    } else if (partner?.email) {
      const monthlyReward = Math.round(Number(portfolio.investment_amount) * (Number(portfolio.roi_percentage) / 100));
      try {
        await dispatchTransactionalEmail(
          supabaseUrl,
          serviceKey,
          buildPartnershipAgreementRequest({
            recipientEmail: partner.email,
            partnerName: partner.full_name,
            partnerId: portfolio.investor_id,
            portfolioId: portfolio.id,
            amount: Number(portfolio.investment_amount),
            monthlyReward,
            contributionDateIso: portfolio.created_at,
            firstPayoutDateIso: portfolio.next_roi_date || portfolio.created_at,
            payoutDay: portfolio.payout_day || 15,
            roiPercentage: Number(portfolio.roi_percentage),
          }),
        );
      } catch (e) {
        console.warn("[approve-pending-portfolio] Agreement email failed:", (e as Error)?.message);
      }
    }

    return json({ success: true, portfolio_id: portfolioId }, 200);
  } catch (e) {
    console.error("[approve-pending-portfolio] Fatal:", (e as Error)?.message);
    return json({ error: (e as Error)?.message || "Unexpected server error" }, 500);
  }
});