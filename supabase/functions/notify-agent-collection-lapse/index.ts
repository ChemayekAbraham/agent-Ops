// Scans active tenancies and warns agents (via web push) when they have not
// collected rent or made a float allocation for a tenant.
//
// Thresholds depend on the tenant's repayment cadence:
//   - daily   → warn at >= 5 idle days, lock at >= 8 idle days (>7).
//   - weekly  → warn at >= 10 idle days, lock at >= 15 idle days (>2 weeks).
// Cadence detection (in order):
//   1. subscription_charges.frequency (if a row exists for the rent_request)
//   2. median gap between the last up-to-5 agent_collections rows
//      (median gap >= 4 days → weekly, else daily)
//   3. If cadence cannot be determined (no subscription row AND fewer than
//      2 historical collections) we WARN but DO NOT LOCK — locking on an
//      unknown schedule is what the daily/weekly gate hiccup was doing.
// Tenants with any collection inside the grace window are considered active
// and are NEVER locked.
import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.89.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const DAILY_WARN_AFTER_DAYS = 5;
const DAILY_REASSIGN_AT_DAYS = 8; // strictly > 7 days idle
const WEEKLY_WARN_AFTER_DAYS = 10;
const WEEKLY_REASSIGN_AT_DAYS = 15; // strictly > 2 weeks idle

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, serviceKey);

  try {
    // Active tenancies with an assigned collecting agent.
    const { data: rr, error: rrErr } = await supabase
      .from("rent_requests")
      .select("id, tenant_id, agent_id, assigned_agent_id, funded_at, created_at, collection_locked_at")
      .eq("tenancy_status", "active")
      .is("collection_locked_at", null);

    if (rrErr) throw rrErr;
    const rows = rr ?? [];

    const now = Date.now();
    const todayKey = new Date().toISOString().slice(0, 10);
    let warned = 0;
    let skipped = 0;
      let locked = 0;

    // Cache tenant names.
    const tenantIds = [...new Set(rows.map((r: any) => r.tenant_id).filter(Boolean))];
    const nameById = new Map<string, string>();
    if (tenantIds.length) {
      const { data: profs } = await supabase
        .from("profiles")
        .select("id, full_name")
        .in("id", tenantIds);
      (profs ?? []).forEach((p: any) => nameById.set(p.id, p.full_name || "your tenant"));
    }

    // Cache subscription frequency per rent_request_id (active subs only).
    const rrIds = rows.map((r: any) => r.id).filter(Boolean);
    const freqByRr = new Map<string, string>();
    if (rrIds.length) {
      const { data: subs } = await supabase
        .from("subscription_charges")
        .select("rent_request_id, frequency, status")
        .in("rent_request_id", rrIds);
      (subs ?? []).forEach((s: any) => {
        if (!s.rent_request_id) return;
        // Prefer active rows; otherwise keep first seen.
        if (!freqByRr.has(s.rent_request_id) || s.status === "active") {
          freqByRr.set(s.rent_request_id, (s.frequency || "daily").toLowerCase());
        }
      });
    }

    for (const row of rows as any[]) {
      const agentId = row.agent_id || row.assigned_agent_id;
      if (!agentId || !row.tenant_id) continue;

      const subFreq = freqByRr.get(row.id);
      // Pull recent collections once — used both to derive lastCol and cadence.
      const { data: recentCols } = await supabase
        .from("agent_collections")
        .select("created_at")
        // Cadence is inferred from the gaps between real payments. A reversed
        // collection never happened, so counting it would read as a shorter
        // gap and could lock an agent against a schedule they never kept.
        .is("reversed_at", null)
        .eq("agent_id", agentId)
        .eq("tenant_id", row.tenant_id)
        .order("created_at", { ascending: false })
        .limit(5);

      let frequency: string;
      let cadenceKnown = true;
      if (subFreq) {
        frequency = subFreq;
      } else if ((recentCols?.length ?? 0) >= 2) {
        // Median gap in days between consecutive collections.
        const times = (recentCols ?? []).map((r: any) => new Date(r.created_at).getTime());
        const gaps: number[] = [];
        for (let i = 0; i < times.length - 1; i++) {
          gaps.push((times[i] - times[i + 1]) / 86_400_000);
        }
        gaps.sort((a, b) => a - b);
        const median = gaps[Math.floor(gaps.length / 2)];
        frequency = median >= 4 ? "weekly" : "daily";
      } else {
        // Unknown cadence — warn only, never lock.
        frequency = "weekly";
        cadenceKnown = false;
      }
      const isWeekly = frequency === "weekly";
      const WARN_AFTER_DAYS = isWeekly ? WEEKLY_WARN_AFTER_DAYS : DAILY_WARN_AFTER_DAYS;
      const REASSIGN_AT_DAYS = isWeekly ? WEEKLY_REASSIGN_AT_DAYS : DAILY_REASSIGN_AT_DAYS;

      const lastColIso = recentCols?.[0]?.created_at;
      const anchorIso: string = lastColIso || row.funded_at || row.created_at;
      if (!anchorIso) continue;

      const daysSince = Math.floor((now - new Date(anchorIso).getTime()) / 86_400_000);
      if (daysSince < WARN_AFTER_DAYS) continue;

      const idemKey = `collection_lapse:${row.tenant_id}:${todayKey}`;
      const daysLeft = Math.max(0, REASSIGN_AT_DAYS - daysSince);
      const tenantName = nameById.get(row.tenant_id) || "your tenant";

      // Collection lock feature retired — warnings only, never lock the tenant.

      const idleLabel = isWeekly
        ? `${Math.floor(daysSince / 7)} week${Math.floor(daysSince / 7) === 1 ? "" : "s"}`
        : `${daysSince} days`;
      const leftLabel = isWeekly
        ? `${Math.ceil(daysLeft / 7)} week${Math.ceil(daysLeft / 7) === 1 ? "" : "s"}`
        : `${daysLeft} day${daysLeft === 1 ? "" : "s"}`;

      const title = daysLeft > 0
        ? `Collect rent for ${tenantName}`
        : `${tenantName} locked — pending reassignment`;
      const body = daysLeft > 0
        ? `It's been ${idleLabel} since you last collected rent for ${tenantName} (${frequency} schedule). Your tenant will be transferred to an active agent in ${leftLabel}. Collect rent to keep the tenant.`
        : `It's been ${idleLabel} without a rent collection for ${tenantName} (${frequency} schedule). You can no longer collect for this tenant — Agent Ops will transfer them to an active agent.`;

      // Fire web push.
      await supabase.functions.invoke("send-push-notification", {
        body: {
          userIds: [agentId],
          payload: {
            title,
            body,
            type: daysLeft === 0 ? "error" : "warning",
            url: "/dashboard/agent",
            tag: `collection-lapse-${row.tenant_id}`,
            notificationId: idemKey,
          },
        },
      });

      warned++;
    }

    return new Response(
      JSON.stringify({ ok: true, scanned: rows.length, warned, locked, skipped }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    console.error("notify-agent-collection-lapse error", err);
    return new Response(
      JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});