// Bulk-verify house listings. The browser makes ONE call for the batch.
// This edge fn:
//   1. Authenticates the caller once and enforces the landlord-ops role gate
//      once (avoids N role-check queries).
//   2. Runs credit-listing-bonus per listing with bounded concurrency (6) so
//      ALL wallet / bonus / SMS / audit side-effects are preserved bit-for-bit.
//   3. Aggregates structured results per the Phase 2 spec:
//        { totalRequested, verified[], alreadyVerified[], ineligible[],
//          failed[], notificationsPending[] }
//
// Idempotency is enforced by the existing UNIQUE constraint on
// listing_bonus_approvals.listing_id + house_listings.listing_bonus_paid flag
// + row-level self-heal inside credit-listing-bonus. Retrying the same batch
// (double-click, network retry, resubmit) can never double-credit.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const MAX_BATCH = 500;
const CONCURRENCY = 6;

interface CreditListingBonusResult {
  success?: boolean;
  message?: string;
  error?: string;
  already_paid?: boolean;
  verified_now?: boolean;
  approval_id?: string;
  status?: string;
  bonus?: number;
  agent_id?: string;
  listing_title?: string;
  auto_paid?: boolean;
  resumed?: boolean;
  tx_group_id?: string;
  rolled_back?: boolean;
}

interface PerListingResult {
  id: string;
  status:
    | "verified"
    | "already_verified"
    | "ineligible"
    | "failed";
  approval_id?: string;
  agent_id?: string;
  bonus_credited: boolean;
  message?: string;
  error?: string;
  notification_ok: boolean;
}

function classify(res: CreditListingBonusResult, httpStatus: number): PerListingResult["status"] {
  if (res.success && res.already_paid) return "already_verified";
  if (res.success && res.auto_paid) return "verified";
  if (res.success && res.resumed) return "verified";
  if (res.success) return "verified";
  // 400 without success = ineligible (no agent, missing listing, etc.)
  if (httpStatus === 400 || httpStatus === 404) return "ineligible";
  return "failed";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

    const authHeader =
      req.headers.get("authorization") || req.headers.get("Authorization") || "";
    if (!authHeader.startsWith("Bearer ")) return json({ error: "Unauthorized" }, 401);

    // Resolve caller with the anon client so we honour the JWT.
    const anonClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: userErr } = await anonClient.auth.getUser();
    if (userErr || !user) return json({ error: "Unauthorized" }, 401);

    const adminClient = createClient(supabaseUrl, serviceKey);

    // One role check for the whole batch (avoids N repeated checks).
    const [roleRes, permRes] = await Promise.all([
      adminClient
        .from("user_roles")
        .select("role")
        .eq("user_id", user.id)
        .in("role", ["manager", "coo", "super_admin", "operations", "employee", "ceo", "cfo"])
        .limit(1),
      adminClient
        .from("staff_permissions")
        .select("permitted_dashboard")
        .eq("user_id", user.id)
        .eq("permitted_dashboard", "landlord_ops")
        .limit(1),
    ]);
    const hasBaseRole = (roleRes.data?.length ?? 0) > 0;
    const hasLandlordOpsPerm = (permRes.data?.length ?? 0) > 0;
    if (!hasBaseRole && !hasLandlordOpsPerm) {
      return json({ error: "Only internal staff can verify listings" }, 403);
    }

    // Parse body.
    let body: any;
    try { body = await req.json(); } catch { body = {}; }
    const rawIds = Array.isArray(body?.listing_ids) ? body.listing_ids : [];
    const notes: string | undefined = typeof body?.notes === "string" ? body.notes : undefined;

    // Dedupe + sanitize.
    const seen = new Set<string>();
    const listingIds: string[] = [];
    for (const id of rawIds) {
      if (typeof id !== "string") continue;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      listingIds.push(id);
    }
    if (listingIds.length === 0) return json({ error: "listing_ids required" }, 400);
    if (listingIds.length > MAX_BATCH) {
      return json({ error: `Too many listings (max ${MAX_BATCH})` }, 400);
    }

    // Bounded-concurrency worker pool that invokes credit-listing-bonus per id.
    // Reusing the deployed function guarantees identical wallet / ledger /
    // audit / SMS / push behaviour and preserves the UNIQUE-constraint
    // idempotency guarantee end-to-end.
    const creditUrl = `${supabaseUrl}/functions/v1/credit-listing-bonus`;
    const results: PerListingResult[] = new Array(listingIds.length);
    let cursor = 0;
    const workers = Array.from({ length: Math.min(CONCURRENCY, listingIds.length) }, async () => {
      while (cursor < listingIds.length) {
        const idx = cursor++;
        const listingId = listingIds[idx];
        try {
          const resp = await fetch(creditUrl, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              // Forward the caller's JWT so credit-listing-bonus's own auth check
              // records the real acting user (audit trail stays accurate).
              "Authorization": authHeader,
            },
            body: JSON.stringify({ listing_id: listingId, notes }),
          });
          let parsed: CreditListingBonusResult = {};
          try { parsed = await resp.json(); } catch { /* empty body */ }
          const status = classify(parsed, resp.status);
          const bonusCredited = status === "verified" && !!parsed.auto_paid || !!parsed.resumed;
          results[idx] = {
            id: listingId,
            status,
            approval_id: parsed.approval_id,
            agent_id: parsed.agent_id,
            bonus_credited: bonusCredited,
            message: parsed.message,
            error: parsed.error,
            // credit-listing-bonus handles notification internally (best-effort);
            // we cannot observe its outcome from here, so we mark it as attempted
            // (`true`) whenever verification succeeded. Genuine transport
            // failures surface as status='failed' above.
            notification_ok: status === "verified" || status === "already_verified",
          };
        } catch (err: any) {
          results[idx] = {
            id: listingId,
            status: "failed",
            bonus_credited: false,
            error: err?.message || "Network error",
            notification_ok: false,
          };
        }
      }
    });
    await Promise.all(workers);

    // Bucket into the response shape defined by Phase 2 spec.
    const verified: PerListingResult[] = [];
    const alreadyVerified: PerListingResult[] = [];
    const ineligible: PerListingResult[] = [];
    const failed: PerListingResult[] = [];
    const notificationsPending: PerListingResult[] = [];

    for (const r of results) {
      switch (r.status) {
        case "verified":
          verified.push(r);
          if (!r.notification_ok) notificationsPending.push(r);
          break;
        case "already_verified":
          alreadyVerified.push(r);
          break;
        case "ineligible":
          ineligible.push(r);
          break;
        case "failed":
          failed.push(r);
          break;
      }
    }

    return json({
      totalRequested: listingIds.length,
      verified,
      alreadyVerified,
      ineligible,
      failed,
      notificationsPending,
    }, 200);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return json({ error: message }, 500);
  }
});

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
