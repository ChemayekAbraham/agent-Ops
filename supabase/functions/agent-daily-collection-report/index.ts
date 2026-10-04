import "../_shared/smsFooterInterceptor.ts";
// Agent daily collection report.
//
// Runs once daily (20:00 EAT / 17:00 UTC) via pg_cron. For every active
// agent it computes the day's collection summary across their tenant
// allowlist (referrer_id + referrals + rent_requests.agent_id) and:
//   1. Inserts ONE row into `notifications` (in-app message)
//   2. Sends ONE SMS via Africa's Talking to the agent's phone
//
// Idempotent: skips an agent if today's report row already exists.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const AT_API_KEY = Deno.env.get("AFRICASTALKING_API_KEY") || "";
const AT_USERNAME = Deno.env.get("AFRICASTALKING_USERNAME") || "";

function fmtUGX(n: number): string {
  return `UGX ${Math.round(n).toLocaleString("en-US")}`;
}

function todayBoundsUTC(): { startISO: string; endISO: string; label: string } {
  // Day boundary anchored to East Africa Time (UTC+3) so "today" matches
  // what the agent sees on the ground.
  const now = new Date();
  const eatNow = new Date(now.getTime() + 3 * 60 * 60 * 1000);
  const y = eatNow.getUTCFullYear();
  const m = eatNow.getUTCMonth();
  const d = eatNow.getUTCDate();
  const startEAT = Date.UTC(y, m, d, 0, 0, 0) - 3 * 60 * 60 * 1000;
  const endEAT = startEAT + 24 * 60 * 60 * 1000;
  const label = new Date(startEAT).toISOString().slice(0, 10);
  return {
    startISO: new Date(startEAT).toISOString(),
    endISO: new Date(endEAT).toISOString(),
    label,
  };
}

function formatPhoneInternational(phone: string): string {
  const digits = (phone || "").replace(/[^0-9]/g, "");
  if (!digits) return "";
  if (digits.startsWith("256")) return `+${digits}`;
  if (digits.startsWith("0")) return `+256${digits.slice(1)}`;
  if (digits.length === 9) return `+256${digits}`;
  return `+${digits}`;
}

async function sendSMS(phone: string, message: string): Promise<boolean> {
  if (await attemptYoolaPrimary(phone, message, { source: "agent-daily-collection-report" })) return true;
  if (!AT_API_KEY || !AT_USERNAME) {
    console.warn("[agent-daily-collection-report] AT creds missing — skipping SMS");
    return false;
  }
  const formatted = formatPhoneInternational(phone);
  if (!formatted) return false;
  const isSandbox = AT_USERNAME.toLowerCase() === "sandbox";
  const baseUrl = isSandbox
    ? "https://api.sandbox.africastalking.com/version1/messaging"
    : "https://api.africastalking.com/version1/messaging";
  try {
    const body = new URLSearchParams({
      username: AT_USERNAME,
      to: formatted,      message,
    });
    const res = await fetch(baseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        apiKey: AT_API_KEY,
        Accept: "application/json",
      },
      body: body.toString(),
    });
    const txt = await res.text();
    let data: any = {};
    try { data = JSON.parse(txt); } catch { /* */ }
    const recipients = data?.SMSMessageData?.Recipients || [];
    return recipients.some((r: any) => r.statusCode === 101 || r.statusCode === 100);
  } catch (e) {
    console.error("[agent-daily-collection-report] SMS error", e);
    return false;
  }
}

async function buildAgentTenantIds(
  admin: ReturnType<typeof createClient>,
  agentId: string,
): Promise<string[]> {
  // Mirror the My Tenants allowlist: referrer_id ∪ referrals ∪ rent_requests.agent_id
  const [profiles, referrals, requests] = await Promise.all([
    admin.from("profiles").select("id").eq("referrer_id", agentId),
    admin.from("referrals").select("referred_id").eq("referrer_id", agentId),
    admin.from("rent_requests").select("tenant_id").eq("agent_id", agentId),
  ]);
  const ids = new Set<string>();
  (profiles.data || []).forEach((p: any) => p?.id && ids.add(p.id));
  (referrals.data || []).forEach((r: any) => r?.referred_id && ids.add(r.referred_id));
  (requests.data || []).forEach((r: any) => r?.tenant_id && ids.add(r.tenant_id));
  return Array.from(ids);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  try {
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE);
    const { startISO, endISO, label } = todayBoundsUTC();

    // 1. All active agents (enabled agent role only)
    const { data: agentRoles, error: rolesErr } = await admin
      .from("user_roles")
      .select("user_id")
      .eq("role", "agent")
      .eq("enabled", true);
    if (rolesErr) throw rolesErr;

    let agentIds = Array.from(new Set((agentRoles || []).map((r: any) => r.user_id))).filter(Boolean);

    // Partners / supporters must never receive agent daily reports.
    if (agentIds.length > 0) {
      const excluded = new Set<string>();
      for (let i = 0; i < agentIds.length; i += 200) {
        const { data: rows } = await admin
          .from("user_roles").select("user_id")
          .in("role", ["partner", "supporter"])
          .in("user_id", agentIds.slice(i, i + 200));
        (rows || []).forEach((r: any) => r.user_id && excluded.add(r.user_id));
      }
      if (excluded.size > 0) agentIds = agentIds.filter((id) => !excluded.has(id));
    }

    const stats = { agents: 0, smsSent: 0, notifications: 0, skipped: 0 };

    for (const agentId of agentIds) {
      stats.agents++;

      // Idempotency: skip if today's report already filed for this agent.
      const { data: existing } = await admin
        .from("notifications")
        .select("id")
        .eq("user_id", agentId)
        .eq("type", "agent_daily_collection")
        .gte("created_at", startISO)
        .lt("created_at", endISO)
        .maybeSingle();
      if (existing) { stats.skipped++; continue; }

      const tenantIds = await buildAgentTenantIds(admin, agentId);
      if (tenantIds.length === 0) { stats.skipped++; continue; }

      // Today's repayments for those tenants
      const { data: todays } = await admin
        .from("repayments")
        .select("tenant_id, amount, created_at")
        .in("tenant_id", tenantIds)
        .gte("created_at", startISO)
        .lt("created_at", endISO);

      const collected = (todays || []).reduce((s, r: any) => s + Number(r.amount || 0), 0);
      const tenantsCollected = new Set((todays || []).map((r: any) => r.tenant_id)).size;

      // Owing + daily expected from active rent_requests
      const { data: requests } = await admin
        .from("rent_requests")
        .select("tenant_id, total_repayment, amount_repaid, daily_repayment, status")
        .in("tenant_id", tenantIds)
        .in("status", ["approved", "funded", "disbursed", "repaying"]);

      let expected = 0;
      const owingTenants = new Set<string>();
      (requests || []).forEach((rr: any) => {
        const owing = Number(rr.total_repayment || 0) - Number(rr.amount_repaid || 0);
        if (owing > 0) {
          owingTenants.add(rr.tenant_id);
          expected += Number(rr.daily_repayment || 0);
        }
      });
      const tenantsOwing = owingTenants.size;
      const rate = expected > 0 ? Math.min(100, Math.round((collected / expected) * 100)) : 0;

      const summary =
        `Welile daily report (${label})\n` +
        `Collected: ${fmtUGX(collected)} from ${tenantsCollected} tenant(s)\n` +
        `Expected: ${fmtUGX(expected)} (${rate}% achieved)\n` +
        `Still owing: ${tenantsOwing} tenant(s)`;

      // 2. In-app notification
      const { error: notifErr } = await admin.from("notifications").insert({
        user_id: agentId,
        title: `Daily Collection Report — ${label}`,
        message: summary,
        type: "agent_daily_collection",
        metadata: {
          report_date: label,
          collected_amount: collected,
          tenants_collected: tenantsCollected,
          tenants_owing: tenantsOwing,
          expected_amount: expected,
          collection_rate: rate,
        },
      });
      if (!notifErr) stats.notifications++;
      else console.error("[agent-daily-collection-report] notification insert failed", notifErr);

      // 3. SMS
      const { data: profile } = await admin
        .from("profiles")
        .select("phone")
        .eq("id", agentId)
        .maybeSingle();
      if (profile?.phone) {
        const ok = await sendSMS(profile.phone, summary);
        if (ok) stats.smsSent++;
      }
    }

    return new Response(JSON.stringify({ success: true, ...stats }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("[agent-daily-collection-report] error", err);
    return new Response(
      JSON.stringify({ success: false, error: String(err) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});