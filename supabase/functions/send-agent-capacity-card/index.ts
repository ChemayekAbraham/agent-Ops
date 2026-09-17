// send-agent-capacity-card
//
// Computes each agent's daily eligibility / capacity snapshot (mirroring the
// in-app `useAgentCapacityMap` hook) and dispatches the "Daily Agent Capacity
// Card" email via the shared `send-transactional-email` function.
//
// Modes:
//   - Cron / bulk  (no body, or {})        → every agent with a real email
//   - Single agent ({ agentId, force? })   → one agent (used right after an
//     agent saves their email so they get their first card immediately)
//
// Scheduled for 19:00 EAT (16:00 UTC) daily via pg_cron.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// ---- Capacity law constants (kept in sync with useAgentCapacityMap.ts) ----
const ACTIVE_RENT_STATUSES = [
  "pending", "agent_verified", "tenant_ops_approved",
  "agent_ops_approved", "landlord_ops_approved",
  "coo_approved", "funded", "repaying",
];
const AGENT_RENT_CAP_UGX = 100_000_000;
const DAILY_ELIGIBILITY_THRESHOLD = 0.20;
const NEW_AGENT_TENANT_THRESHOLD = 10;
const NEW_AGENT_RENT_CAP_UGX = 2_000_000;
const AGENT_TIER_THRESHOLDS = { positive: 0.70, fair: 0.40, bad: 0.10 } as const;

// Synthetic placeholder email domains that are NOT real inboxes.
const PLACEHOLDER_DOMAIN_RE = /@(.*\.)?welile\.(user|agent|local|test)$/i;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function isRealEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const e = email.trim().toLowerCase();
  if (!EMAIL_RE.test(e)) return false;
  if (PLACEHOLDER_DOMAIN_RE.test(e)) return false;
  return true;
}

function fmtUGX(n: number): string {
  return `UGX ${Math.round(Number(n) || 0).toLocaleString("en-US")}`;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

type Admin = ReturnType<typeof createClient>;

type Tier = "Positive" | "Fair" | "Bad" | "Very Bad" | "Starter";

interface Capacity {
  used: number;
  active_count: number;
  active_tenant_count: number;
  response_rate: number;
  expected_daily: number;
  paid_today: number;
  paid_yesterday: number;
  today_pct: number;
  effective_pct: number;
  headroom: number;
  tier: Tier;
  per_tenant_max: number;
  is_new_agent: boolean;
  can_post_rent_today: boolean;
}

function classifyAgent(active_count: number, response_rate: number): { tier: Tier; per_tenant_max: number } {
  if (active_count <= 0) return { tier: "Starter", per_tenant_max: 500_000 };
  if (response_rate >= AGENT_TIER_THRESHOLDS.positive) return { tier: "Positive", per_tenant_max: 6_000_000 };
  if (response_rate >= AGENT_TIER_THRESHOLDS.fair) return { tier: "Fair", per_tenant_max: 3_000_000 };
  if (response_rate >= AGENT_TIER_THRESHOLDS.bad) return { tier: "Bad", per_tenant_max: 1_000_000 };
  return { tier: "Very Bad", per_tenant_max: 0 };
}

type BadgeTone = "gold" | "green" | "blue" | "amber";
interface CardBadge { icon: string; label: string; tone: BadgeTone }

// Mirrors src/lib/agentBadges.ts deriveAgentBadges().
function deriveBadges(cap: Capacity): CardBadge[] {
  const badges: CardBadge[] = [];
  const tenants = cap.active_tenant_count || 0;
  const todayPct = cap.expected_daily > 0 ? cap.paid_today / cap.expected_daily : 0;
  const collectedToday = cap.paid_today > 0 && todayPct >= DAILY_ELIGIBILITY_THRESHOLD;

  if (tenants >= 30) badges.push({ icon: "👑", label: "Top Lister", tone: "gold" });
  else if (tenants >= 15) badges.push({ icon: "🏆", label: "Big Book", tone: "gold" });
  else if (tenants >= 5) badges.push({ icon: "📈", label: "Growing Book", tone: "blue" });

  if (todayPct >= 1) badges.push({ icon: "🎯", label: "Target Smashed", tone: "green" });
  else if (collectedToday) badges.push({ icon: "🔥", label: "Daily Collector", tone: "green" });

  if (cap.response_rate >= 0.7) badges.push({ icon: "💪", label: "Consistent", tone: "green" });
  if (cap.tier === "Positive") badges.push({ icon: "⭐", label: "Elite Agent", tone: "gold" });
  if (cap.is_new_agent) badges.push({ icon: "🌱", label: "Rising Star", tone: "amber" });

  if (badges.length === 0) badges.push({ icon: "✨", label: "On the Board", tone: "blue" });
  return badges;
}

// Computes capacity snapshots for the given agent ids, mirroring the
// useAgentCapacityMap hook server-side.
async function computeCapacities(admin: Admin, agentIds: string[]): Promise<Map<string, Capacity>> {
  const out = new Map<string, Capacity>();
  if (agentIds.length === 0) return out;
  const weekAgoISO = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  // 1) Server-side daily eligibility (Africa/Kampala TZ).
  const elig = new Map<string, { active_count: number; expected_daily: number; paid_today: number; paid_yesterday: number; today_pct: number; effective_pct: number }>();
  for (const ids of chunk(agentIds, 200)) {
    const { data, error } = await admin.rpc("get_agent_daily_eligibility", { p_agent_ids: ids });
    if (error) { console.error("[send-agent-capacity-card] eligibility RPC failed", error); continue; }
    (data || []).forEach((r: any) => elig.set(r.agent_id, {
      active_count: Number(r.active_count) || 0,
      expected_daily: Number(r.expected_daily) || 0,
      paid_today: Number(r.paid_today) || 0,
      paid_yesterday: Number(r.paid_yesterday) || 0,
      today_pct: Number(r.today_pct) || 0,
      effective_pct: Number(r.effective_pct) || 0,
    }));
  }

  // 2) Active rent_requests → exposure, expected daily, active tenants.
  const active: any[] = [];
  for (const ids of chunk(agentIds, 120)) {
    const { data } = await admin
      .from("rent_requests")
      .select("id, agent_id, tenant_id, total_repayment, amount_repaid, daily_repayment")
      .in("agent_id", ids)
      .in("status", ACTIVE_RENT_STATUSES);
    if (data) active.push(...data);
  }

  // 2a) Drop fully "marked not funded" rent_requests.
  const allActiveIds = active.map((r) => r.id);
  const reversedSet = new Set<string>();
  for (const ids of chunk(allActiveIds, 200)) {
    const { data } = await admin
      .from("agent_tenant_float_reversals")
      .select("rent_request_id")
      .in("rent_request_id", ids);
    (data || []).forEach((r: any) => reversedSet.add(r.rent_request_id));
  }

  const exposure = new Map<string, { used: number; count: number }>();
  const expectedDaily = new Map<string, number>();
  const activeIdToAgent = new Map<string, string>();
  const activeTenantsByAgent = new Map<string, Set<string>>();
  active.forEach((r) => {
    if (reversedSet.has(r.id) && (Number(r.amount_repaid) || 0) <= 0) return; // unfunded
    const owed = Math.max((Number(r.total_repayment) || 0) - (Number(r.amount_repaid) || 0), 0);
    const prev = exposure.get(r.agent_id) || { used: 0, count: 0 };
    exposure.set(r.agent_id, { used: prev.used + owed, count: prev.count + 1 });
    expectedDaily.set(r.agent_id, (expectedDaily.get(r.agent_id) || 0) + (Number(r.daily_repayment) || 0));
    activeIdToAgent.set(r.id, r.agent_id);
    if (r.tenant_id) {
      let s = activeTenantsByAgent.get(r.agent_id);
      if (!s) { s = new Set(); activeTenantsByAgent.set(r.agent_id, s); }
      s.add(r.tenant_id);
    }
  });

  // 3) Last 7-day Daily Response Rate (DRR) numerator.
  const respondingDaysByAgent = new Map<string, number>();
  const activeIds = Array.from(activeIdToAgent.keys());
  for (const slice of chunk(activeIds, 200)) {
    const { data: pays } = await admin
      .from("repayments")
      .select("rent_request_id, amount, created_at")
      .in("rent_request_id", slice)
      .gte("created_at", weekAgoISO);
    const dayKeyByRent = new Map<string, Set<string>>();
    (pays || []).forEach((p: any) => {
      if ((Number(p.amount) || 0) <= 0) return;
      const day = (p.created_at as string).slice(0, 10);
      let set = dayKeyByRent.get(p.rent_request_id);
      if (!set) { set = new Set(); dayKeyByRent.set(p.rent_request_id, set); }
      set.add(day);
    });
    dayKeyByRent.forEach((daySet, rentId) => {
      const agentId = activeIdToAgent.get(rentId);
      if (!agentId) return;
      respondingDaysByAgent.set(agentId, (respondingDaysByAgent.get(agentId) || 0) + daySet.size);
    });
  }

  agentIds.forEach((id) => {
    const exp = exposure.get(id) || { used: 0, count: 0 };
    const e = elig.get(id);
    const dailyExpected = e?.expected_daily ?? (expectedDaily.get(id) || 0);
    const expected_tenant_days = exp.count * 7;
    const responding_tenant_days = Math.min(respondingDaysByAgent.get(id) || 0, expected_tenant_days);
    const response_rate = expected_tenant_days > 0 ? Math.min(1, responding_tenant_days / expected_tenant_days) : 0;
    const active_tenant_count = activeTenantsByAgent.get(id)?.size || 0;
    const { tier, per_tenant_max: tierMax } = classifyAgent(exp.count, response_rate);
    const is_new_agent = active_tenant_count < NEW_AGENT_TENANT_THRESHOLD;
    const per_tenant_max = is_new_agent ? NEW_AGENT_RENT_CAP_UGX : tierMax;
    const headroom = Math.max(AGENT_RENT_CAP_UGX - exp.used, 0);
    const effective_pct = e?.effective_pct ?? 0;
    const daily_blocked = exp.count > 0 && effective_pct < DAILY_ELIGIBILITY_THRESHOLD;
    const can_post_rent_today = is_new_agent ? true : !daily_blocked;

    out.set(id, {
      used: exp.used,
      active_count: exp.count,
      active_tenant_count,
      response_rate,
      expected_daily: dailyExpected,
      paid_today: e?.paid_today ?? 0,
      paid_yesterday: e?.paid_yesterday ?? 0,
      today_pct: e?.today_pct ?? 0,
      effective_pct,
      headroom,
      tier,
      per_tenant_max,
      is_new_agent,
      can_post_rent_today,
    });
  });
  return out;
}

function buildTemplateData(name: string, dateLabel: string, cap: Capacity) {
  const canPost = cap.can_post_rent_today;
  const remainingSlots = canPost && cap.per_tenant_max > 0
    ? Math.floor(cap.headroom / cap.per_tenant_max)
    : 0;
  const pct = Math.max(0, Math.min(100, Math.round((cap.today_pct || 0) * 100)));
  const remaining = Math.max(0, (cap.expected_daily || 0) - (cap.paid_today || 0));
  const diff = (cap.paid_today || 0) - (cap.paid_yesterday || 0);
  const diffLabel = `${diff >= 0 ? "+" : "-"}${fmtUGX(Math.abs(diff))}`;
  return {
    agentName: name,
    dateLabel,
    paidTodayLabel: fmtUGX(cap.paid_today),
    expectedDailyLabel: fmtUGX(cap.expected_daily),
    pct,
    remainingLabel: remaining > 0 ? fmtUGX(remaining) : "",
    tenantCount: cap.active_tenant_count,
    remainingSlots,
    headroomLabel: fmtUGX(cap.headroom),
    perTenantMaxLabel: fmtUGX(cap.per_tenant_max),
    paidYesterdayLabel: fmtUGX(cap.paid_yesterday),
    diffLabel,
    canPost,
    badges: deriveBadges(cap),
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE);

    let single: string | null = null;
    let force = false;
    if (req.method === "POST") {
      try {
        const body = await req.json();
        single = body?.agentId || body?.agent_id || null;
        force = body?.force === true;
      } catch { /* empty body = bulk */ }
    }

    // EAT (UTC+3) date label, matching the in-app card.
    const dateLabel = new Date().toLocaleDateString("en-GB", {
      weekday: "short", day: "numeric", month: "short", year: "numeric",
      timeZone: "Africa/Kampala",
    });
    const dayKey = new Date(Date.now() + 3 * 3600 * 1000).toISOString().slice(0, 10);

    // 1) Resolve target agent ids.
    let agentIds: string[];
    if (single) {
      agentIds = [single];
    } else {
      const { data: roles, error: rolesErr } = await admin
        .from("user_roles").select("user_id").eq("role", "agent").eq("enabled", true);
      if (rolesErr) throw rolesErr;
      agentIds = Array.from(new Set((roles || []).map((r: any) => r.user_id))).filter(Boolean);
    }

    // Exclude anyone who ALSO holds the 'partner' or 'supporter' role — partners
    // and supporters must never receive the agent daily capacity card, even if
    // they were granted the agent role for internal ops.
    if (agentIds.length > 0) {
      const partnerIds = new Set<string>();
      for (const ids of chunk(agentIds, 200)) {
        const { data: partnerRows } = await admin
          .from("user_roles").select("user_id")
          .in("role", ["partner", "supporter"]).in("user_id", ids);
        (partnerRows || []).forEach((r: any) => r.user_id && partnerIds.add(r.user_id));
      }
      if (partnerIds.size > 0) {
        agentIds = agentIds.filter((id) => !partnerIds.has(id));
      }
    }


    if (agentIds.length === 0) {
      return new Response(JSON.stringify({
        success: true, sent: 0, skipped: 0, missingEmail: 0,
        message: single ? "Recipient is a partner — capacity card skipped." : "No non-partner agents to notify.",
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // 2) Profiles (name + email) for the targets.
    const profileById = new Map<string, { email: string | null; full_name: string | null }>();
    for (const ids of chunk(agentIds, 200)) {
      const { data } = await admin
        .from("profiles").select("id, email, full_name").in("id", ids);
      (data || []).forEach((p: any) => profileById.set(p.id, { email: p.email, full_name: p.full_name }));
    }

    // 3) Keep only agents with a real (non-placeholder) email.
    const recipients = agentIds.filter((id) => isRealEmail(profileById.get(id)?.email));
    const missingEmail = agentIds.length - recipients.length;

    if (recipients.length === 0) {
      return new Response(JSON.stringify({
        success: true, sent: 0, skipped: agentIds.length, missingEmail,
        message: single ? "Agent has no real email on file." : "No agents with real emails.",
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // 4) Capacity snapshots.
    const caps = await computeCapacities(admin, recipients);

    // 5) Dispatch one email per agent through the shared sender.
    const stats = { sent: 0, failed: 0, skipped: 0, missingEmail };
    for (const id of recipients) {
      const prof = profileById.get(id)!;
      const cap = caps.get(id);
      if (!cap) { stats.skipped++; continue; }
      const name = (prof.full_name || prof.email!.split("@")[0] || "Agent").trim();
      const templateData = buildTemplateData(name, dateLabel, cap);
      const idempotencyKey = force
        ? `daily-agent-card-${id}-${dayKey}-${Date.now()}`
        : `daily-agent-card-${id}-${dayKey}`;
      try {
        const { error } = await admin.functions.invoke("send-transactional-email", {
          body: {
            templateName: "daily-agent-card",
            recipientEmail: prof.email,
            idempotencyKey,
            templateData,
          },
        });
        if (error) { stats.failed++; console.error(`[send-agent-capacity-card] send failed for ${id}`, error); }
        else stats.sent++;
      } catch (e) {
        stats.failed++;
        console.error(`[send-agent-capacity-card] invoke error for ${id}`, e);
      }
    }

    return new Response(JSON.stringify({ success: true, ...stats, targeted: recipients.length }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("[send-agent-capacity-card] error", err);
    return new Response(JSON.stringify({ success: false, error: String(err) }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});