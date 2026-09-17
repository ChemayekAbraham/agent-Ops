// Agent Ops daily report — MERGED brief (field activity + credit advances).
//
// This single function replaces the former pair of 18:00 EAT emails
// (`agent-ops-daily-report` + `agent-advances-daily-report`). The advances
// brief was merged in here and its function/cron were removed.
//
// Section order:
//   1. Field activity today (collections, deposits, listings, landlords, visits)
//   2. Advance programme summary (adoption, agent base, tiers, request flow)
//   3. Repayment trend (today vs last month, daily series)
//   4. Arrears and advance demand
//   5. Receivables — projected principal & interest (interest projection LAST)
//
// Idempotent per EAT day via an `agent_ops_daily_report` system_event
// (bypass with { force: true }). Backfill via { date } or { dates }.
// Preview HTML with { preview: true, date }.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const REPORT_RECIPIENTS = ["benjamin@welile.com", "paphra.me@gmail.com", "jlukodda@gmail.com"];
const FROM = "Welile Reports <info@welile.com>";
const SENDER_DOMAIN = "notify.welile.com";

type Admin = any;

// ---------- utilities ----------

function fmtUGX(n: number): string {
  return `UGX ${Math.round(Number(n) || 0).toLocaleString("en-US")}`;
}
function num(n: number): string {
  return (Math.round(Number(n) || 0)).toLocaleString("en-US");
}
function pct(n: number): string {
  return `${(Math.round((Number(n) || 0) * 10) / 10).toLocaleString("en-US")}%`;
}
function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function chartUrl(config: unknown, w = 700, h = 320): string {
  return `https://quickchart.io/chart?w=${w}&h=${h}&bkg=white&devicePixelRatio=2&c=${encodeURIComponent(JSON.stringify(config))}`;
}
function generateToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function ensureUnsubscribeToken(admin: Admin, email: string): Promise<string> {
  const normalized = email.trim().toLowerCase();
  const { data: existing } = await admin.from("email_unsubscribe_tokens").select("token").eq("email", normalized).maybeSingle();
  if (existing?.token) return existing.token as string;
  const token = generateToken();
  await admin.from("email_unsubscribe_tokens").upsert({ token, email: normalized }, { onConflict: "email", ignoreDuplicates: true });
  const { data: stored } = await admin.from("email_unsubscribe_tokens").select("token").eq("email", normalized).maybeSingle();
  return (stored?.token as string) || token;
}

// PostgREST caps a plain select at 1000 rows — every bulk read MUST paginate or
// the report silently reports zeros. This helper walks the full result set.
async function fetchAll(
  admin: Admin,
  table: string,
  select: string,
  apply?: (q: any) => any,
  orderCol = "id",
): Promise<any[]> {
  const rows: any[] = [];
  const size = 1000;
  for (let page = 0; page < 60; page++) {
    let q: any = admin.from(table).select(select).order(orderCol, { ascending: true }).range(page * size, page * size + size - 1);
    if (apply) q = apply(q);
    const { data, error } = await q;
    if (error) {
      console.error(`[agent-ops-daily-report] fetchAll ${table} failed:`, error.message);
      break;
    }
    rows.push(...(data ?? []));
    if (!data || data.length < size) break;
  }
  return rows;
}

// Calendar date (YYYY-MM-DD) in East Africa Time (UTC+3, no DST).
function eatToday(): string {
  return new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
function eatDayBounds(dateStr: string): { startISO: string; endISO: string } {
  const [y, m, d] = dateStr.split("-").map(Number);
  const startEAT = Date.UTC(y, m - 1, d, 0, 0, 0) - 3 * 60 * 60 * 1000;
  const endEAT = startEAT + 24 * 60 * 60 * 1000;
  return { startISO: new Date(startEAT).toISOString(), endISO: new Date(endEAT).toISOString() };
}
function eatHour(iso: string): number {
  return new Date(new Date(iso).getTime() + 3 * 60 * 60 * 1000).getUTCHours();
}

// Brand palette
const PURPLE = "#6c21c4";
const PURPLE_DK = "#4c1696";
const GREEN = "#16a34a";
const AMBER = "#d97706";
const SKY = "#0284c7";
const RED = "#dc2626";
const BLUE = "#2563eb";

// ---------- classification helpers ----------

function isApproved(status: string, cfoPaidAt: unknown): boolean {
  const s = String(status || "").toLowerCase();
  return !!cfoPaidAt || s.includes("approved") || s === "disbursed" || s === "active" || s === "repaying" || s === "cfo_paid";
}
function isRejected(status: string): boolean {
  return String(status || "").toLowerCase().includes("reject");
}
function isPending(status: string): boolean {
  return String(status || "").toLowerCase() === "pending";
}
function reasonBucket(raw: string): string {
  const r = String(raw || "").trim().toLowerCase();
  if (!r) return "No reason given";
  if (r.includes("test")) return "Feature under test";
  if (r.includes("duplicate")) return "Duplicate request";
  if (r.includes("eligib") || r.includes("limit") || r.includes("over")) return "Not eligible / over limit";
  if (r.includes("document") || r.includes("kyc") || r.includes("id")) return "Documents / KYC";
  if (r.includes("outstanding") || r.includes("overdue") || r.includes("debt")) return "Existing debt / overdue";
  if (r.includes("agent ops")) return "Rejected at agent ops stage";
  if (r.includes("tenant")) return "Rejected at tenant ops stage";
  if (r.includes("landlord")) return "Rejected at landlord ops stage";
  return raw.trim().slice(0, 40);
}
function purposeBucket(raw: string): string {
  const r = String(raw || "").trim().toLowerCase();
  if (!r) return "Not specified";
  if (/rent|tenant|landlord|deposit|house/.test(r)) return "Fund tenant rent / deposit";
  if (/stock|goods|business|shop|merchand|inventory/.test(r)) return "Business stock / merchandise";
  if (/school|fees|tuition|educat/.test(r)) return "School fees";
  if (/medic|hospital|health|treatment/.test(r)) return "Medical";
  if (/food|feed|family|home|domestic/.test(r)) return "Household / food";
  if (/transport|fuel|boda|vehicle|car/.test(r)) return "Transport / fuel";
  if (/emerg/.test(r)) return "Emergency";
  if (/personal/.test(r)) return "Personal";
  return raw.trim().slice(0, 40);
}

// Human label for an agent. `profiles` has `full_name`, `phone`, `email` —
// there is NO `phone_number` column (selecting it errors the whole query and
// used to make every row render as "Unknown agent").
function displayName(p: any, id?: string): string {
  const full = String(p?.full_name ?? "").trim();
  if (full) return full;
  const phone = String(p?.phone ?? "").trim();
  if (phone) return phone;
  const email = String(p?.email ?? "").trim();
  if (email) return email;
  return id ? `Agent ${String(id).slice(0, 8)}` : "Agent (no profile)";
}
function displayPhone(p: any): string {
  const phone = String(p?.phone ?? "").trim();
  return phone || "No phone on file";
}

// ---------- receivables projection ----------

interface AdvanceRow {
  id: string;
  agent_id: string;
  outstanding_balance: number;
  daily_installment: number;
  monthly_rate: number;
  cycle_days: number;
  status: string;
  arrears_balance: number;
}
interface WindowBucket {
  label: string;
  days: number;
  principal: number;
  interest: number;
  total: number;
  contributing: number;
}

function projectAdvance(a: AdvanceRow, maxDays: number): Array<{ day: number; principal: number; interest: number }> {
  const out: Array<{ day: number; principal: number; interest: number }> = [];
  let balance = Math.max(0, Number(a.outstanding_balance) || 0);
  const install = Math.max(0, Number(a.daily_installment) || 0);
  const monthly = Math.max(0, Number(a.monthly_rate) || 0.33);
  if (balance <= 0 || install <= 0) return out;
  const dailyRate = Math.pow(1 + monthly, 1 / 30) - 1;
  for (let d = 1; d <= maxDays; d++) {
    if (balance <= 0.5) break;
    const accrued = balance * dailyRate;
    const gross = balance + accrued;
    const payment = Math.min(install, gross);
    const interestPaid = Math.min(payment, accrued);
    const principalPaid = Math.max(0, payment - interestPaid);
    out.push({ day: d, principal: principalPaid, interest: interestPaid });
    balance = Math.max(0, gross - payment);
  }
  return out;
}

function bucketReceivables(advances: AdvanceRow[]): WindowBucket[] {
  const windows = [1, 7, 30, 60, 90];
  const buckets: WindowBucket[] = windows.map((d) => ({
    label: d === 1 ? "Next 1 day" : `Next ${d} days`,
    days: d, principal: 0, interest: 0, total: 0, contributing: 0,
  }));
  for (const a of advances) {
    const proj = projectAdvance(a, 90);
    if (!proj.length) continue;
    const touched = new Set<number>();
    for (const step of proj) {
      for (const b of buckets) {
        if (step.day <= b.days) {
          b.principal += step.principal;
          b.interest += step.interest;
          b.total += step.principal + step.interest;
          touched.add(b.days);
        }
      }
    }
    for (const b of buckets) if (touched.has(b.days)) b.contributing += 1;
  }
  return buckets;
}

// ---------- report shape ----------

interface ArrearsRow {
  agent_id: string;
  name: string;
  phone: string;
  arrears: number;
  paidToday: number;
  outstanding: number;
  daysInArrears: number;
}
interface ActivityBlock {
  listingsCreated: number;
  listingsVerified: number;
  listingsRejected: number;
  landlordsOnboarded: number;
  landlordsVerified: number;
  subAgentsRecruited: number;
  subAgentsVerified: number;
  campaignRegistrations: number;
  fieldVisits: number;
  visitingAgents: number;
  landlordPayoutsCount: number;
  landlordPayoutsAmount: number;
  advanceRepaymentsCount: number;
  advanceRepaymentsAmount: number;
  advanceInterestAccrued: number;
}
interface Report {
  date: string;
  // Field activity
  collectionsCount: number;
  collectionsTotal: number;
  depositsCount: number;
  depositsTotal: number;
  uniqueAgents: number;
  hourly: number[];
  topAgents: { name: string; total: number; count: number }[];
  perAgent: { name: string; phone: string; collections: number; collected: number; deposits: number; deposited: number }[];
  activity: ActivityBlock;
  // Advance base
  totalUsers: number;
  qualifyingAgents: number;
  criteriaCounts: Record<string, number>;
  agentsWithAdvancesEver: number;
  agentsWithActiveAdvances: number;
  adoptionPct: number;
  tierDistribution: Array<{ label: string; count: number; limit: number }>;
  // Requests
  requestsToday: number;
  requestsMonth: number;
  requestsTotal: number;
  approvedToday: number;
  approvedMonth: number;
  rejectedToday: number;
  rejectedMonth: number;
  pendingTotal: number;
  reasonsMonth: Array<{ label: string; count: number }>;
  purposesMonth: Array<{ label: string; count: number }>;
  // Repayment trend
  repaidToday: number;
  repaymentsTodayCount: number;
  agentsRepaidToday: number;
  repaidSameDayLastMonth: number;
  repaidThisMonth: number;
  repaidLastMonthSameWindow: number;
  monthDaysLabels: string[];
  monthDaysSeries: number[];
  lastMonthSeries: number[];
  // Arrears
  arrears: ArrearsRow[];
  totalArrears: number;
  arrearsClearedToday: number;
  // Receivables
  buckets: WindowBucket[];
  activeAdvances: number;
  totalOutstanding: number;
}

// ---------- data fetch + compute ----------

async function buildReport(admin: Admin, dateStr: string): Promise<Report> {
  const { startISO, endISO } = eatDayBounds(dateStr);
  const monthStartDate = `${dateStr.slice(0, 7)}-01`;
  const monthStartISO = eatDayBounds(monthStartDate).startISO;

  const dayNum = Number(dateStr.slice(8, 10));
  const prevMonthDate = (() => {
    const y = Number(dateStr.slice(0, 4));
    const m = Number(dateStr.slice(5, 7));
    const py = m === 1 ? y - 1 : y;
    const pm = m === 1 ? 12 : m - 1;
    const lastDayPrev = new Date(Date.UTC(py, pm, 0)).getUTCDate();
    const clamped = Math.min(dayNum, lastDayPrev);
    return `${py}-${String(pm).padStart(2, "0")}-${String(clamped).padStart(2, "0")}`;
  })();
  const prevMonthStart = `${prevMonthDate.slice(0, 7)}-01`;

  const [
    collections,
    deposits,
    requests,
    advancesRaw,
    ledger,
    ledgerToday,
    qualifyingRes,
    listings,
    promissory,
    behalfReqs,
    allCollections,
    subagents,
    usersRes,
    everAdvances,
  ] = await Promise.all([
    fetchAll(admin, "agent_collections", "id, agent_id, amount, created_at",
      // Reversed collections are not money collected.
      (q) => q.is("reversed_at", null).gte("created_at", startISO).lt("created_at", endISO)),
    fetchAll(admin, "wallet_deposits", "id, agent_id, amount, created_at",
      (q) => q.gte("created_at", startISO).lt("created_at", endISO)),
    fetchAll(admin, "agent_advance_requests", "id, agent_id, principal, status, rejection_reason, reason, cfo_paid_at, created_at"),
    fetchAll(admin, "agent_advances", "id, agent_id, outstanding_balance, daily_installment, monthly_rate, cycle_days, status, arrears_balance",
      (q) => q.in("status", ["active", "overdue"])),
    fetchAll(admin, "agent_advance_ledger", "id, date, amount_deducted, interest_accrued, advance_id",
      (q) => q.gte("date", prevMonthStart).lte("date", dateStr)),
    fetchAll(admin, "agent_advance_ledger", "id, date, amount_deducted, interest_accrued, advance_id",
      (q) => q.eq("date", dateStr)),
    admin.rpc("agent_ops_qualifying_agent_ids"),
    fetchAll(admin, "house_listings", "id, agent_id", (q) => q.not("agent_id", "is", null)),
    fetchAll(admin, "promissory_notes", "id, agent_id", (q) => q.not("agent_id", "is", null)),
    fetchAll(admin, "rent_requests", "id, agent_id, tenant_id", (q) => q.not("agent_id", "is", null)),
    fetchAll(admin, "agent_collections", "id, agent_id", (q) => q.not("agent_id", "is", null)),
    fetchAll(admin, "agent_subagents", "id, parent_agent_id, sub_agent_id, status, accepted_at"),
    admin.from("profiles").select("id", { count: "exact", head: true }),
    fetchAll(admin, "agent_advances", "id, agent_id"),
  ]);

  const advances: AdvanceRow[] = (advancesRaw as any[]).map((a) => ({
    ...a,
    outstanding_balance: Number(a.outstanding_balance) || 0,
    daily_installment: Number(a.daily_installment) || 0,
    monthly_rate: Number(a.monthly_rate) || 0.33,
    cycle_days: Number(a.cycle_days) || 30,
    arrears_balance: Number(a.arrears_balance) || 0,
  }));

  const qualifyingIds = new Set(
    ((qualifyingRes.data ?? []) as Array<{ agent_id: string }>).map((r) => r.agent_id).filter(Boolean),
  );
  const totalUsers = usersRes.count ?? 0;
  const qualifyingAgents = qualifyingIds.size;

  // ---- Field activity (today) ----
  const collectionsTotal = collections.reduce((s, c) => s + Number(c.amount ?? 0), 0);
  const depositsTotal = deposits.reduce((s, d) => s + Number(d.amount ?? 0), 0);
  const uniqueAgents = new Set([...collections, ...deposits].map((r) => r.agent_id).filter(Boolean)).size;

  const hourly = new Array(24).fill(0);
  for (const c of collections) hourly[eatHour(c.created_at)] += 1;

  const byAgent: Record<string, { collected: number; collections: number; deposited: number; deposits: number }> = {};
  const bump = (id: string) => (byAgent[id] ??= { collected: 0, collections: 0, deposited: 0, deposits: 0 });
  for (const c of collections) {
    if (!c.agent_id) continue;
    const a = bump(c.agent_id); a.collected += Number(c.amount ?? 0); a.collections += 1;
  }
  for (const d of deposits) {
    if (!d.agent_id) continue;
    const a = bump(d.agent_id); a.deposited += Number(d.amount ?? 0); a.deposits += 1;
  }

  // ---- Arrears roster (from advances directly, netted against today) ----
  const paidTodayByAdvance: Record<string, number> = {};
  for (const l of ledgerToday) {
    paidTodayByAdvance[l.advance_id] = (paidTodayByAdvance[l.advance_id] || 0) + (Number(l.amount_deducted) || 0);
  }
  const paidTodayByAgent: Record<string, number> = {};
  for (const a of advances) {
    const p = paidTodayByAdvance[a.id] || 0;
    if (p > 0) paidTodayByAgent[a.agent_id] = (paidTodayByAgent[a.agent_id] || 0) + p;
  }

  // Names for every agent that appears anywhere in the email.
  const nameIds = Array.from(new Set([
    ...Object.keys(byAgent),
    ...advances.map((a) => a.agent_id),
  ].filter(Boolean)));
  const profilesMap: Record<string, any> = {};
  for (let i = 0; i < nameIds.length; i += 500) {
    const slice = nameIds.slice(i, i + 500);
    const { data, error } = await admin.from("profiles").select("id, full_name, phone, email").in("id", slice);
    if (error) console.error("[agent-ops-daily-report] profiles lookup failed:", error.message);
    (data ?? []).forEach((p: any) => (profilesMap[p.id] = p));
  }

  const topAgents = Object.entries(byAgent)
    .sort(([, a], [, b]) => b.collected - a.collected)
    .slice(0, 8)
    .map(([id, v]) => ({ name: displayName(profilesMap[id], id), total: Math.round(v.collected), count: v.collections }));

  const perAgent = Object.entries(byAgent)
    .sort(([, a], [, b]) => (b.collected + b.deposited) - (a.collected + a.deposited))
    .map(([id, v]) => ({
      name: displayName(profilesMap[id], id),
      phone: displayPhone(profilesMap[id]),
      collections: v.collections,
      collected: Math.round(v.collected),
      deposits: v.deposits,
      deposited: Math.round(v.deposited),
    }));

  // ---- Agent-base criteria breakdown ----
  const uniqIn = (rows: any[], key = "agent_id") => {
    const s = new Set<string>();
    for (const r of rows) if (r?.[key] && qualifyingIds.has(r[key])) s.add(r[key]);
    return s;
  };
  const listedHouses = uniqIn(listings);
  const promissorySet = uniqIn(promissory);
  const behalfSet = (() => {
    const s = new Set<string>();
    for (const r of behalfReqs) {
      if (r?.agent_id && r?.tenant_id && r.agent_id !== r.tenant_id && qualifyingIds.has(r.agent_id)) s.add(r.agent_id);
    }
    return s;
  })();
  const collectedSet = uniqIn(allCollections);

  const activeSubCount = new Map<string, number>();
  const parentsWithActiveSub = new Set<string>();
  for (const s of subagents) {
    const parent = s?.parent_agent_id;
    const sub = s?.sub_agent_id;
    if (!parent || !sub) continue;
    const accepted = s.accepted_at || ["active", "verified"].includes(String(s.status));
    if (!accepted) continue;
    if (!qualifyingIds.has(sub)) continue;
    activeSubCount.set(parent, (activeSubCount.get(parent) || 0) + 1);
    parentsWithActiveSub.add(parent);
  }

  const criteriaCounts: Record<string, number> = {
    "Has active sub-agent": parentsWithActiveSub.size,
    "Posted promissory note": promissorySet.size,
    "Rent request on behalf": behalfSet.size,
    "Rent collection from tenant": collectedSet.size,
    "Listed a house": listedHouses.size,
  };

  const tiers = [
    { label: "0 active", min: 0, max: 0, limit: 50000 },
    { label: "1-2 active", min: 1, max: 2, limit: 200000 },
    { label: "3-5 active", min: 3, max: 5, limit: 500000 },
    { label: "6-10 active", min: 6, max: 10, limit: 1500000 },
    { label: "11-20 active", min: 11, max: 20, limit: 5000000 },
    { label: "21+ active", min: 21, max: Infinity, limit: 10000000 },
  ];
  const tierDistribution = tiers.map((t) => ({ label: t.label, count: 0, limit: t.limit }));
  for (const agentId of qualifyingIds) {
    const cnt = activeSubCount.get(agentId) || 0;
    for (let i = 0; i < tiers.length; i++) {
      if (cnt >= tiers[i].min && cnt <= tiers[i].max) { tierDistribution[i].count += 1; break; }
    }
  }

  // ---- Requests ----
  const inDay = (iso: string) => iso >= startISO && iso < endISO;
  const inMonth = (iso: string) => iso >= monthStartISO && iso < endISO;
  const todays = requests.filter((r) => inDay(r.created_at));
  const months = requests.filter((r) => inMonth(r.created_at));
  const tallyReasons = (rows: any[]) => {
    const m: Record<string, number> = {};
    for (const r of rows) {
      if (!isRejected(r.status)) continue;
      const label = reasonBucket(r.rejection_reason);
      m[label] = (m[label] || 0) + 1;
    }
    return Object.entries(m).sort(([, a], [, b]) => b - a).map(([label, count]) => ({ label, count }));
  };
  const purposeMap: Record<string, number> = {};
  for (const r of months) {
    const label = purposeBucket(r.reason);
    purposeMap[label] = (purposeMap[label] || 0) + 1;
  }

  // ---- Repayment trend ----
  const ledgerByDate: Record<string, number> = {};
  for (const l of ledger) {
    const d = String(l.date).slice(0, 10);
    ledgerByDate[d] = (ledgerByDate[d] || 0) + (Number(l.amount_deducted) || 0);
  }
  const repaidToday = ledgerToday.reduce((s, l) => s + (Number(l.amount_deducted) || 0), 0);
  ledgerByDate[dateStr] = repaidToday;
  const repaymentsTodayCount = ledgerToday.filter((l) => Number(l.amount_deducted) > 0).length;
  const agentsRepaidToday = Object.keys(paidTodayByAgent).length;
  const interestAccruedToday = ledgerToday.reduce((s, l) => s + (Number(l.interest_accrued) || 0), 0);
  const repaidSameDayLastMonth = ledgerByDate[prevMonthDate] || 0;
  const sumRange = (from: string, to: string) => {
    let s = 0;
    for (const [d, v] of Object.entries(ledgerByDate)) if (d >= from && d <= to) s += v;
    return s;
  };
  const repaidThisMonth = sumRange(monthStartDate, dateStr);
  const repaidLastMonthSameWindow = sumRange(prevMonthStart, prevMonthDate);

  const monthDaysLabels: string[] = [];
  const monthDaysSeries: number[] = [];
  const lastMonthSeries: number[] = [];
  for (let d = 1; d <= dayNum; d++) {
    const dStr = `${dateStr.slice(0, 7)}-${String(d).padStart(2, "0")}`;
    const pStr = `${prevMonthStart.slice(0, 7)}-${String(d).padStart(2, "0")}`;
    monthDaysLabels.push(String(d));
    monthDaysSeries.push(Math.round(ledgerByDate[dStr] || 0));
    lastMonthSeries.push(Math.round(ledgerByDate[pStr] || 0));
  }

  // Arrears carried on the advance are only rewritten by the nightly deduction
  // job, so net them against what the agent actually paid today. Otherwise an
  // agent who cleared their arrears this afternoon still shows the full amount.
  let arrearsClearedToday = 0;
  const arrearsRows: ArrearsRow[] = [];
  for (const a of advances) {
    const paid = paidTodayByAdvance[a.id] || 0;
    const raw = a.arrears_balance;
    const netted = Math.max(0, Math.min(raw, a.outstanding_balance) - paid);
    arrearsClearedToday += Math.max(0, Math.min(raw, paid));
    if (netted <= 0) continue;
    const install = a.daily_installment;
    arrearsRows.push({
      agent_id: a.agent_id,
      name: displayName(profilesMap[a.agent_id], a.agent_id),
      phone: displayPhone(profilesMap[a.agent_id]),
      arrears: Math.round(netted),
      paidToday: Math.round(paid),
      outstanding: Math.round(a.outstanding_balance),
      daysInArrears: install > 0 ? Math.round(netted / install) : 0,
    });
  }
  arrearsRows.sort((a, b) => b.arrears - a.arrears);
  const totalArrears = arrearsRows.reduce((s, r) => s + r.arrears, 0);

  const agentsWithActiveAdvances = new Set(advances.map((a) => a.agent_id).filter(Boolean)).size;
  const agentsWithAdvancesEver = new Set(everAdvances.map((r) => r.agent_id).filter(Boolean)).size;
  const adoptionPct = qualifyingAgents ? (agentsWithActiveAdvances / qualifyingAgents) * 100 : 0;
  const totalOutstanding = advances.reduce((s, a) => s + a.outstanding_balance, 0);

  const activity = await buildActivityBlock(admin, startISO, endISO, {
    repaymentsCount: repaymentsTodayCount,
    repaymentsAmount: repaidToday,
    interestAccrued: interestAccruedToday,
  });

  return {
    date: dateStr,
    collectionsCount: collections.length,
    collectionsTotal,
    depositsCount: deposits.length,
    depositsTotal,
    uniqueAgents,
    hourly,
    topAgents,
    perAgent,
    activity,
    totalUsers, qualifyingAgents, criteriaCounts,
    agentsWithAdvancesEver, agentsWithActiveAdvances, adoptionPct,
    tierDistribution,
    requestsToday: todays.length,
    requestsMonth: months.length,
    requestsTotal: requests.length,
    approvedToday: todays.filter((r) => isApproved(r.status, r.cfo_paid_at)).length,
    approvedMonth: months.filter((r) => isApproved(r.status, r.cfo_paid_at)).length,
    rejectedToday: todays.filter((r) => isRejected(r.status)).length,
    rejectedMonth: months.filter((r) => isRejected(r.status)).length,
    pendingTotal: requests.filter((r) => isPending(r.status)).length,
    reasonsMonth: tallyReasons(months).slice(0, 8),
    purposesMonth: Object.entries(purposeMap).sort(([, a], [, b]) => b - a).slice(0, 8).map(([label, count]) => ({ label, count })),
    repaidToday,
    repaymentsTodayCount,
    agentsRepaidToday,
    repaidSameDayLastMonth,
    repaidThisMonth,
    repaidLastMonthSameWindow,
    monthDaysLabels, monthDaysSeries, lastMonthSeries,
    arrears: arrearsRows,
    totalArrears,
    arrearsClearedToday: Math.round(arrearsClearedToday),
    buckets: bucketReceivables(advances),
    activeAdvances: advances.length,
    totalOutstanding: Math.round(totalOutstanding),
  };
}

async function buildActivityBlock(
  admin: Admin,
  startISO: string,
  endISO: string,
  repay: { repaymentsCount: number; repaymentsAmount: number; interestAccrued: number },
): Promise<ActivityBlock> {
  const countIn = async (table: string, dateCol: string, extra?: (q: any) => any): Promise<number> => {
    let q: any = admin.from(table).select("id", { count: "exact", head: true })
      .gte(dateCol, startISO).lt(dateCol, endISO);
    if (extra) q = extra(q);
    const { count, error } = await q;
    if (error) {
      console.error(`[agent-ops-daily-report] count ${table}.${dateCol} failed:`, error.message);
      return 0;
    }
    return count ?? 0;
  };

  const [
    listingsCreated, listingsVerified, listingsRejected,
    landlordsOnboarded, landlordsVerified,
    subAgentsRecruited, subAgentsVerified, campaignRegistrations,
  ] = await Promise.all([
    countIn("house_listings", "created_at"),
    countIn("house_listings", "verified_at", (q) => q.eq("verified", true)),
    countIn("house_listings", "updated_at", (q) => q.eq("status", "rejected")),
    countIn("landlords", "created_at"),
    countIn("landlords", "verified_at", (q) => q.eq("verified", true)),
    countIn("agent_subagents", "created_at"),
    countIn("agent_subagents", "verified_at"),
    countIn("recruitment_campaign_registrations", "registered_at"),
  ]);

  const visits = await fetchAll(admin, "agent_visits", "id, agent_id",
    (q) => q.gte("created_at", startISO).lt("created_at", endISO));
  const payouts = await fetchAll(admin, "landlord_payouts", "id, amount",
    (q) => q.gte("updated_at", startISO).lt("updated_at", endISO).in("status", ["completed", "paid", "success"]));

  return {
    listingsCreated, listingsVerified, listingsRejected,
    landlordsOnboarded, landlordsVerified,
    subAgentsRecruited, subAgentsVerified, campaignRegistrations,
    fieldVisits: visits.length,
    visitingAgents: new Set(visits.map((v) => v.agent_id).filter(Boolean)).size,
    landlordPayoutsCount: payouts.length,
    landlordPayoutsAmount: Math.round(payouts.reduce((s, p) => s + Number(p.amount ?? 0), 0)),
    advanceRepaymentsCount: repay.repaymentsCount,
    advanceRepaymentsAmount: Math.round(repay.repaymentsAmount),
    advanceInterestAccrued: Math.round(repay.interestAccrued),
  };
}

// ---------- HTML rendering ----------

function kpiCell(label: string, value: string, color = "#1a1a2e", sub?: string): string {
  return `<td style="padding:12px 8px;background:#f7f3ff;border-radius:8px;text-align:center;vertical-align:top;">
    <div style="font-size:11px;color:#666;text-transform:uppercase;letter-spacing:.4px;">${esc(label)}</div>
    <div style="font-size:19px;font-weight:700;color:${color};margin-top:4px;">${esc(value)}</div>
    ${sub ? `<div style="font-size:10px;color:#888;margin-top:2px;">${sub}</div>` : ""}
  </td>`;
}
function tableRow(cells: string[], zebra: boolean, align?: string[]): string {
  return `<tr style="background:${zebra ? "#faf7ff" : "#ffffff"}">${cells
    .map((c, i) => `<td style="padding:8px 10px;border-bottom:1px solid #eee;text-align:${align?.[i] ?? "left"};">${c}</td>`)
    .join("")}</tr>`;
}

function buildHtml(r: Report, prettyDate: string): string {
  const hourLabels = Array.from({ length: 24 }, (_, i) => `${i}:00`);
  const avgPerAgent = r.uniqueAgents ? r.collectionsTotal / r.uniqueAgents : 0;

  const hourlyChart = chartUrl({
    type: "bar",
    data: { labels: hourLabels, datasets: [{ label: "Collections", data: r.hourly, backgroundColor: PURPLE }] },
    options: {
      plugins: { title: { display: true, text: "Rent collections by hour (EAT)" }, legend: { display: false } },
      scales: { y: { title: { display: true, text: "Count" }, beginAtZero: true } },
    },
  }, 700, 320);

  const topChart = r.topAgents.length
    ? chartUrl({
        type: "horizontalBar",
        data: {
          labels: r.topAgents.map((a) => a.name.slice(0, 20)),
          datasets: [{ label: "Collected (UGX)", data: r.topAgents.map((a) => a.total), backgroundColor: PURPLE_DK }],
        },
        options: { plugins: { title: { display: true, text: "Top agents by collected volume" }, legend: { display: false } }, scales: { x: { beginAtZero: true } } },
      }, 700, 300)
    : "";

  const perAgentRows = r.perAgent.length
    ? r.perAgent.map((a, i) => tableRow([
        esc(a.name),
        `<span style="color:#555;">${esc(a.phone)}</span>`,
        num(a.collections),
        `<strong>${fmtUGX(a.collected)}</strong>`,
        num(a.deposits),
        fmtUGX(a.deposited),
      ], i % 2 === 1, ["left", "left", "right", "right", "right", "right"])).join("")
    : `<tr><td colspan="6" style="padding:14px;text-align:center;color:#888;">No agent field activity recorded for this day.</td></tr>`;

  const criteriaChart = chartUrl({
    type: "doughnut",
    data: {
      labels: Object.keys(r.criteriaCounts),
      datasets: [{ data: Object.values(r.criteriaCounts), backgroundColor: [PURPLE, BLUE, GREEN, AMBER, SKY] }],
    },
    options: { plugins: { title: { display: true, text: "Agent base by activity" }, legend: { position: "bottom" } } },
  }, 340, 300);

  const tierChart = chartUrl({
    type: "bar",
    data: {
      labels: r.tierDistribution.map((t) => t.label),
      datasets: [{ label: "Agents", data: r.tierDistribution.map((t) => t.count), backgroundColor: PURPLE }],
    },
    options: { plugins: { title: { display: true, text: "Advance-limit tier by active sub-agents" }, legend: { display: false } }, scales: { y: { beginAtZero: true } } },
  }, 340, 300);

  const reasonChart = r.reasonsMonth.length
    ? chartUrl({
        type: "horizontalBar",
        data: {
          labels: r.reasonsMonth.map((x) => x.label.slice(0, 26)),
          datasets: [{ label: "Rejections (MTD)", data: r.reasonsMonth.map((x) => x.count), backgroundColor: RED }],
        },
        options: { plugins: { title: { display: true, text: "Rejection reasons - month to date" }, legend: { display: false } }, scales: { x: { beginAtZero: true } } },
      }, 700, 300)
    : "";

  const trendChart = chartUrl({
    type: "line",
    data: {
      labels: r.monthDaysLabels,
      datasets: [
        { label: "This month", data: r.monthDaysSeries, borderColor: PURPLE, backgroundColor: "rgba(108,33,196,0.15)", fill: true, lineTension: 0.25 },
        { label: "Last month", data: r.lastMonthSeries, borderColor: AMBER, backgroundColor: "rgba(217,119,6,0.05)", fill: false, borderDash: [4, 3], lineTension: 0.25 },
      ],
    },
    options: {
      plugins: { title: { display: true, text: "Advance repayments per day - this month vs last month (EAT)" }, legend: { position: "bottom" } },
      scales: { y: { beginAtZero: true, title: { display: true, text: "UGX repaid" } } },
    },
  }, 700, 320);

  const receivablesChart = chartUrl({
    type: "bar",
    data: {
      labels: r.buckets.map((b) => b.label),
      datasets: [
        { label: "Principal", data: r.buckets.map((b) => Math.round(b.principal)), backgroundColor: BLUE, stack: "s" },
        { label: "Interest", data: r.buckets.map((b) => Math.round(b.interest)), backgroundColor: PURPLE, stack: "s" },
      ],
    },
    options: {
      plugins: { title: { display: true, text: "Projected receivables - principal vs interest" }, legend: { position: "bottom" } },
      scales: { xAxes: [{ stacked: true }], yAxes: [{ stacked: true, ticks: { beginAtZero: true } }], x: { stacked: true }, y: { stacked: true, beginAtZero: true } },
    },
  }, 700, 340);

  const criteriaRows = Object.entries(r.criteriaCounts).map(([label, count], i) => tableRow([
    esc(label), `<strong>${num(count)}</strong>`,
    `<span style="color:#666;">${pct(r.qualifyingAgents ? (count / r.qualifyingAgents) * 100 : 0)}</span>`,
  ], i % 2 === 1, ["left", "right", "right"])).join("");

  const tierRows = r.tierDistribution.map((t, i) => tableRow([
    esc(t.label), `<strong>${num(t.count)}</strong>`,
    `<span style="color:${PURPLE};font-weight:600;">${fmtUGX(t.limit)}</span>`,
  ], i % 2 === 1, ["left", "right", "right"])).join("");

  const reasonMonthRows = r.reasonsMonth.length
    ? r.reasonsMonth.map((x, i) => tableRow([esc(x.label), `<strong>${num(x.count)}</strong>`], i % 2 === 1, ["left", "right"])).join("")
    : `<tr><td colspan="2" style="padding:12px;text-align:center;color:#888;">No rejections this month.</td></tr>`;

  const arrearsTop = r.arrears.slice(0, 25);
  const arrearsRows = arrearsTop.length
    ? arrearsTop.map((a, i) => tableRow([
        esc(a.name),
        `<span style="color:#555;">${esc(a.phone)}</span>`,
        `<span style="color:${RED};font-weight:700;">${fmtUGX(a.arrears)}</span>`,
        `<span style="color:${a.paidToday > 0 ? GREEN : "#888"};">${a.paidToday > 0 ? fmtUGX(a.paidToday) : "-"}</span>`,
        `<span style="color:#666;">${a.daysInArrears}d</span>`,
        fmtUGX(a.outstanding),
      ], i % 2 === 1, ["left", "left", "right", "right", "right", "right"])).join("")
    : `<tr><td colspan="6" style="padding:12px;text-align:center;color:#888;">No advances currently in arrears.</td></tr>`;
  const arrearsFooter = r.arrears.length > 25
    ? `<tr><td colspan="6" style="padding:8px 10px;color:#888;font-style:italic;">and ${num(r.arrears.length - 25)} more agents in arrears (total ${fmtUGX(r.totalArrears)}).</td></tr>`
    : "";

  const purposeRows = r.purposesMonth.length
    ? r.purposesMonth.map((x, i) => tableRow([esc(x.label), `<strong>${num(x.count)}</strong>`], i % 2 === 1, ["left", "right"])).join("")
    : `<tr><td colspan="2" style="padding:12px;text-align:center;color:#888;">No requests this month.</td></tr>`;

  const receivablesRows = r.buckets.map((b, i) => tableRow([
    `<strong>${esc(b.label)}</strong>`,
    `<span style="color:${BLUE};font-weight:600;">${fmtUGX(b.principal)}</span>`,
    `<span style="color:${PURPLE};font-weight:600;">${fmtUGX(b.interest)}</span>`,
    `<strong>${fmtUGX(b.total)}</strong>`,
    `<span style="color:#666;">${num(b.contributing)}</span>`,
  ], i % 2 === 1, ["left", "right", "right", "right", "right"])).join("");

  const trendDelta = (a: number, b: number) => {
    if (!b) return a > 0 ? "new" : "-";
    const diff = ((a - b) / b) * 100;
    const color = diff >= 0 ? GREEN : RED;
    return `<span style="color:${color};">${diff >= 0 ? "+" : "-"}${Math.abs(Math.round(diff))}%</span>`;
  };

  const sectionTitle = (n: number, text: string) =>
    `<h2 style="font-size:16px;margin:26px 0 8px;color:${PURPLE_DK};border-bottom:2px solid #ece5fb;padding-bottom:6px;">${n} &middot; ${esc(text)}</h2>`;

  const activityCell = (label: string, value: string, sub?: string, color = PURPLE_DK) => `
    <td style="padding:12px 10px;background:#faf7ff;border:1px solid #ece5fb;border-radius:10px;text-align:center;vertical-align:top;">
      <div style="font-size:11px;color:#666;text-transform:uppercase;letter-spacing:.4px;">${esc(label)}</div>
      <div style="font-size:20px;font-weight:800;color:${color};margin-top:4px;">${esc(value)}</div>
      ${sub ? `<div style="font-size:10px;color:#888;margin-top:3px;">${esc(sub)}</div>` : ""}
    </td>`;
  const a = r.activity;

  return `<!doctype html><html><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /></head>
  <body style="margin:0;background:#f4f1fa;font-family:Arial,Helvetica,sans-serif;color:#1a1a2e;">
  <div style="max-width:800px;margin:0 auto;padding:20px;">
    <div style="background:${PURPLE};color:#fff;border-radius:12px 12px 0 0;padding:22px 26px;">
      <h1 style="margin:0;font-size:21px;">Agent Ops Daily Report</h1>
      <p style="margin:6px 0 0;font-size:13px;opacity:.9;">${esc(prettyDate)} (East Africa Time)</p>
      <p style="margin:8px 0 0;font-size:12px;opacity:.85;">Field activity, credit advances, repayments and receivables in one brief.</p>
    </div>
    <div style="background:#fff;padding:22px 26px;border:1px solid #e7e0f5;border-top:0;border-radius:0 0 12px 12px;">

      ${sectionTitle(1, "Field activity today")}
      <table role="presentation" style="width:100%;border-collapse:separate;border-spacing:6px;margin-bottom:8px;">
        <tr>
          ${kpiCell("Active agents", num(r.uniqueAgents), "#1a1a2e", "collected or deposited today")}
          ${kpiCell("Rent collections", num(r.collectionsCount), PURPLE)}
          ${kpiCell("Collected", fmtUGX(r.collectionsTotal), GREEN)}
          ${kpiCell("Avg per active agent", fmtUGX(avgPerAgent))}
        </tr>
        <tr>
          ${kpiCell("Wallet deposits", num(r.depositsCount))}
          ${kpiCell("Deposited", fmtUGX(r.depositsTotal), GREEN)}
          ${kpiCell("Advance requests today", num(r.requestsToday), PURPLE, `${num(r.approvedToday)} approved &middot; ${num(r.rejectedToday)} rejected`)}
          ${kpiCell("Pending requests", num(r.pendingTotal), AMBER, "awaiting review")}
        </tr>
      </table>

      <table role="presentation" style="width:100%;border-collapse:separate;border-spacing:6px;margin-bottom:6px;">
        <tr>
          ${activityCell("Houses listed", num(a.listingsCreated))}
          ${activityCell("Houses verified", num(a.listingsVerified), undefined, GREEN)}
          ${activityCell("Houses rejected", num(a.listingsRejected), undefined, RED)}
          ${activityCell("Landlords added", num(a.landlordsOnboarded))}
        </tr>
        <tr>
          ${activityCell("Landlords verified", num(a.landlordsVerified), undefined, GREEN)}
          ${activityCell("Sub-agents recruited", num(a.subAgentsRecruited))}
          ${activityCell("Sub-agents verified", num(a.subAgentsVerified), undefined, GREEN)}
          ${activityCell("Campaign sign-ups", num(a.campaignRegistrations), undefined, SKY)}
        </tr>
        <tr>
          ${activityCell("Field visits", num(a.fieldVisits), `${num(a.visitingAgents)} agents`)}
          ${activityCell("Landlord payouts", num(a.landlordPayoutsCount), fmtUGX(a.landlordPayoutsAmount), GREEN)}
          ${activityCell("Advance repayments", num(a.advanceRepaymentsCount), fmtUGX(a.advanceRepaymentsAmount), GREEN)}
          ${activityCell("Interest accrued today", fmtUGX(a.advanceInterestAccrued), "on active advances", AMBER)}
        </tr>
      </table>

      <div style="margin:18px 0;">
        <img src="${hourlyChart}" alt="Rent collections by hour" width="700" style="width:100%;max-width:700px;border:1px solid #eee;border-radius:8px;" />
      </div>
      ${topChart ? `<div style="margin:14px 0;"><img src="${topChart}" alt="Top agents by collected volume" width="700" style="width:100%;max-width:700px;border:1px solid #eee;border-radius:8px;" /></div>` : ""}

      <h3 style="font-size:13px;margin:16px 0 6px;color:#444;">Per-agent breakdown (today)</h3>
      <table style="width:100%;border-collapse:collapse;font-size:13px;table-layout:fixed;">
        <thead>
          <tr style="background:${PURPLE};color:#fff;text-align:left;">
            <th style="padding:8px 10px;width:26%;">Agent</th>
            <th style="padding:8px 10px;width:18%;">Phone</th>
            <th style="padding:8px 10px;width:13%;text-align:right;">Collections</th>
            <th style="padding:8px 10px;width:17%;text-align:right;">Collected</th>
            <th style="padding:8px 10px;width:11%;text-align:right;">Deposits</th>
            <th style="padding:8px 10px;width:15%;text-align:right;">Deposited</th>
          </tr>
        </thead>
        <tbody>${perAgentRows}</tbody>
      </table>

      ${sectionTitle(2, "Advance programme summary")}
      <table role="presentation" style="width:100%;border-collapse:separate;border-spacing:6px;margin-bottom:8px;">
        <tr>
          ${kpiCell("Adoption rate", pct(r.adoptionPct), r.adoptionPct < 5 ? AMBER : GREEN, `${num(r.agentsWithActiveAdvances)} of ${num(r.qualifyingAgents)} qualifying agents`)}
          ${kpiCell("Agents with active advance", num(r.agentsWithActiveAdvances), PURPLE, `${num(r.agentsWithAdvancesEver)} have ever held one`)}
          ${kpiCell("Qualifying agents", num(r.qualifyingAgents), "#1a1a2e", `of ${num(r.totalUsers)} total users`)}
          ${kpiCell("Total outstanding", fmtUGX(r.totalOutstanding), AMBER, `${num(r.activeAdvances)} active advances`)}
        </tr>
      </table>

      <h3 style="font-size:13px;margin:14px 0 6px;color:#444;">Agent base breakdown</h3>
      <table style="width:100%;border-collapse:collapse;font-size:13px;table-layout:fixed;">
        <thead>
          <tr style="background:#f7f3ff;text-align:left;">
            <th style="padding:8px 10px;width:52%;">Activity criterion</th>
            <th style="padding:8px 10px;width:24%;text-align:right;">Qualifying agents</th>
            <th style="padding:8px 10px;width:24%;text-align:right;">Share of base</th>
          </tr>
        </thead>
        <tbody>${criteriaRows}</tbody>
      </table>

      <h3 style="font-size:13px;margin:14px 0 6px;color:#444;">Advance-limit tier by active sub-agents</h3>
      <p style="margin:0 0 8px;font-size:12px;color:#666;">A sub-agent counts as active only if they themselves qualify as an agent. Rent collections, listings and promissory notes top up the base tier.</p>
      <table style="width:100%;border-collapse:collapse;font-size:13px;table-layout:fixed;">
        <thead>
          <tr style="background:#f7f3ff;text-align:left;">
            <th style="padding:8px 10px;width:34%;">Active sub-agents</th>
            <th style="padding:8px 10px;width:33%;text-align:right;">Agents in tier</th>
            <th style="padding:8px 10px;width:33%;text-align:right;">Tier advance ceiling</th>
          </tr>
        </thead>
        <tbody>${tierRows}</tbody>
      </table>

      <table role="presentation" style="width:100%;border-collapse:collapse;margin:14px 0;">
        <tr>
          <td style="width:50%;vertical-align:top;padding-right:8px;">
            <img src="${criteriaChart}" alt="Agent base by activity" width="340" style="width:100%;max-width:340px;border:1px solid #eee;border-radius:8px;" />
          </td>
          <td style="width:50%;vertical-align:top;padding-left:8px;">
            <img src="${tierChart}" alt="Advance-limit tier distribution" width="340" style="width:100%;max-width:340px;border:1px solid #eee;border-radius:8px;" />
          </td>
        </tr>
      </table>

      <h3 style="font-size:13px;margin:14px 0 6px;color:#444;">Request flow - today vs month to date</h3>
      <table role="presentation" style="width:100%;border-collapse:separate;border-spacing:6px;margin-bottom:8px;">
        <tr>
          ${kpiCell("Received today", num(r.requestsToday), PURPLE, `${num(r.requestsMonth)} MTD &middot; ${num(r.requestsTotal)} all-time`)}
          ${kpiCell("Approved today", num(r.approvedToday), GREEN, `${num(r.approvedMonth)} MTD`)}
          ${kpiCell("Rejected today", num(r.rejectedToday), RED, `${num(r.rejectedMonth)} MTD`)}
          ${kpiCell("Pending", num(r.pendingTotal), AMBER, "awaiting review")}
        </tr>
      </table>
      ${reasonChart ? `<div style="margin:12px 0;"><img src="${reasonChart}" alt="Rejection reasons" width="700" style="width:100%;max-width:700px;border:1px solid #eee;border-radius:8px;" /></div>` : ""}
      <h4 style="font-size:12px;margin:12px 0 4px;color:#555;">Top rejection reasons (MTD)</h4>
      <table style="width:100%;border-collapse:collapse;font-size:13px;table-layout:fixed;">
        <thead><tr style="background:${RED};color:#fff;text-align:left;"><th style="padding:8px 10px;width:80%;">Reason</th><th style="padding:8px 10px;width:20%;text-align:right;">Count</th></tr></thead>
        <tbody>${reasonMonthRows}</tbody>
      </table>

      ${sectionTitle(3, "Repayment trend")}
      <table role="presentation" style="width:100%;border-collapse:separate;border-spacing:6px;margin-bottom:8px;">
        <tr>
          ${kpiCell("Repaid today", fmtUGX(r.repaidToday), GREEN, `${num(r.agentsRepaidToday)} agents &middot; ${num(r.repaymentsTodayCount)} deductions`)}
          ${kpiCell("Same day last month", fmtUGX(r.repaidSameDayLastMonth), "#1a1a2e", trendDelta(r.repaidToday, r.repaidSameDayLastMonth))}
          ${kpiCell("Month to date", fmtUGX(r.repaidThisMonth), GREEN, `${trendDelta(r.repaidThisMonth, r.repaidLastMonthSameWindow)} vs last month`)}
          ${kpiCell("Last month (same window)", fmtUGX(r.repaidLastMonthSameWindow), "#1a1a2e")}
        </tr>
      </table>
      <div style="margin:14px 0;"><img src="${trendChart}" alt="Repayment trend" width="700" style="width:100%;max-width:700px;border:1px solid #eee;border-radius:8px;" /></div>

      ${sectionTitle(4, "Arrears and advance demand")}
      <p style="margin:0 0 10px;font-size:12px;color:#666;">Arrears are shown net of what the agent has already repaid today, so an agent who settled this afternoon is no longer listed.</p>
      <table role="presentation" style="width:100%;border-collapse:separate;border-spacing:6px;margin-bottom:8px;">
        <tr>
          ${kpiCell("Agents in arrears", num(r.arrears.length), r.arrears.length ? RED : GREEN)}
          ${kpiCell("Total arrears", fmtUGX(r.totalArrears), r.totalArrears > 0 ? AMBER : GREEN, "after today's repayments")}
          ${kpiCell("Arrears cleared today", fmtUGX(r.arrearsClearedToday), GREEN)}
          ${kpiCell("Longest overdue", r.arrears.length ? `${r.arrears[0].daysInArrears} days` : "-", r.arrears.length ? RED : GREEN, r.arrears.length ? esc(r.arrears[0].name) : "")}
        </tr>
      </table>
      <h4 style="font-size:12px;margin:12px 0 4px;color:#555;">Advances in arrears (top 25 by amount)</h4>
      <table style="width:100%;border-collapse:collapse;font-size:13px;table-layout:fixed;">
        <thead>
          <tr style="background:${PURPLE};color:#fff;text-align:left;">
            <th style="padding:8px 10px;width:24%;">Agent</th>
            <th style="padding:8px 10px;width:17%;">Phone</th>
            <th style="padding:8px 10px;width:16%;text-align:right;">Arrears</th>
            <th style="padding:8px 10px;width:16%;text-align:right;">Paid today</th>
            <th style="padding:8px 10px;width:9%;text-align:right;">Age</th>
            <th style="padding:8px 10px;width:18%;text-align:right;">Outstanding</th>
          </tr>
        </thead>
        <tbody>${arrearsRows}${arrearsFooter}</tbody>
      </table>

      <h4 style="font-size:12px;margin:16px 0 4px;color:#555;">Why agents are requesting advances (MTD)</h4>
      <table style="width:100%;border-collapse:collapse;font-size:13px;table-layout:fixed;">
        <thead><tr style="background:#f7f3ff;text-align:left;"><th style="padding:8px 10px;width:80%;">Purpose</th><th style="padding:8px 10px;width:20%;text-align:right;">Requests</th></tr></thead>
        <tbody>${purposeRows}</tbody>
      </table>

      ${sectionTitle(5, "Receivables - projected principal and interest")}
      <p style="margin:0 0 10px;font-size:12px;color:#666;">Projected forward from every active and overdue advance using its scheduled daily instalment and monthly compounding rate. Total outstanding today: ${esc(fmtUGX(r.totalOutstanding))} across ${num(r.activeAdvances)} advances.</p>
      <table style="width:100%;border-collapse:collapse;font-size:13px;table-layout:fixed;">
        <thead>
          <tr style="background:${PURPLE};color:#fff;text-align:left;">
            <th style="padding:8px 10px;width:20%;">Window</th>
            <th style="padding:8px 10px;width:20%;text-align:right;">Principal</th>
            <th style="padding:8px 10px;width:20%;text-align:right;">Interest</th>
            <th style="padding:8px 10px;width:22%;text-align:right;">Total receivable</th>
            <th style="padding:8px 10px;width:18%;text-align:right;">Advances</th>
          </tr>
        </thead>
        <tbody>${receivablesRows}</tbody>
      </table>
      <div style="margin:18px 0 0;"><img src="${receivablesChart}" alt="Projected receivables" width="700" style="width:100%;max-width:700px;border:1px solid #eee;border-radius:8px;" /></div>

      <p style="margin:24px 0 0;font-size:11px;color:#999;">
        Generated automatically for Agent Ops from Welile field activity and credit-advance data for the reporting day (Africa/Kampala). Internal operations report.
      </p>
    </div>
  </div>
  </body></html>`;
}

function buildText(r: Report, prettyDate: string): string {
  const lines: string[] = [];
  const a = r.activity;
  lines.push(`Agent Ops Daily Report - ${prettyDate} (EAT)`);
  lines.push("");
  lines.push("1. Field activity today");
  lines.push(`   Active agents: ${num(r.uniqueAgents)}`);
  lines.push(`   Rent collections: ${num(r.collectionsCount)} (${fmtUGX(r.collectionsTotal)})`);
  lines.push(`   Wallet deposits: ${num(r.depositsCount)} (${fmtUGX(r.depositsTotal)})`);
  lines.push(`   Houses: ${num(a.listingsCreated)} listed, ${num(a.listingsVerified)} verified, ${num(a.listingsRejected)} rejected`);
  lines.push(`   Landlords: ${num(a.landlordsOnboarded)} added, ${num(a.landlordsVerified)} verified`);
  lines.push(`   Sub-agents: ${num(a.subAgentsRecruited)} recruited, ${num(a.subAgentsVerified)} verified`);
  lines.push(`   Field visits: ${num(a.fieldVisits)} by ${num(a.visitingAgents)} agents`);
  lines.push(`   Landlord payouts: ${num(a.landlordPayoutsCount)} (${fmtUGX(a.landlordPayoutsAmount)})`);
  lines.push("");
  lines.push("2. Advance programme summary");
  lines.push(`   Adoption: ${pct(r.adoptionPct)} (${num(r.agentsWithActiveAdvances)}/${num(r.qualifyingAgents)} qualifying agents)`);
  lines.push(`   Outstanding: ${fmtUGX(r.totalOutstanding)} across ${num(r.activeAdvances)} advances`);
  lines.push(`   Requests: ${num(r.requestsToday)} today (${num(r.approvedToday)} approved, ${num(r.rejectedToday)} rejected), ${num(r.requestsMonth)} MTD, ${num(r.pendingTotal)} pending`);
  lines.push("");
  lines.push("3. Repayment trend");
  lines.push(`   Repaid today: ${fmtUGX(r.repaidToday)} from ${num(r.agentsRepaidToday)} agents (${num(r.repaymentsTodayCount)} deductions)`);
  lines.push(`   Same day last month: ${fmtUGX(r.repaidSameDayLastMonth)}`);
  lines.push(`   Month to date: ${fmtUGX(r.repaidThisMonth)} vs ${fmtUGX(r.repaidLastMonthSameWindow)} last month same window`);
  lines.push("");
  lines.push("4. Arrears and advance demand");
  lines.push(`   Agents in arrears: ${num(r.arrears.length)} - total ${fmtUGX(r.totalArrears)} (net of today's repayments)`);
  lines.push(`   Arrears cleared today: ${fmtUGX(r.arrearsClearedToday)}`);
  for (const x of r.arrears.slice(0, 15)) {
    lines.push(`   - ${x.name} (${x.phone}): arrears ${fmtUGX(x.arrears)}, paid today ${fmtUGX(x.paidToday)}, outstanding ${fmtUGX(x.outstanding)}`);
  }
  lines.push("");
  lines.push("5. Receivables - projected principal and interest");
  for (const b of r.buckets) {
    lines.push(`   ${b.label}: principal ${fmtUGX(b.principal)}, interest ${fmtUGX(b.interest)}, total ${fmtUGX(b.total)} (${num(b.contributing)} advances)`);
  }
  return lines.join("\n");
}

// ---------- send ----------

async function sendForDate(admin: Admin, dateStr: string, force: boolean): Promise<Record<string, unknown>> {
  if (!force) {
    const { data: existing } = await admin
      .from("system_events")
      .select("id")
      .eq("event_type", "agent_ops_daily_report")
      .contains("metadata", { date: dateStr })
      .limit(1)
      .maybeSingle();
    if (existing) return { date: dateStr, skipped: true, reason: "Already sent" };
  }

  const report = await buildReport(admin, dateStr);
  const prettyDate = new Date(`${dateStr}T00:00:00Z`).toLocaleDateString("en-GB", {
    weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC",
  });

  const html = buildHtml(report, prettyDate);
  const text = buildText(report, prettyDate);
  const subject = `Agent Ops - ${prettyDate}: ${num(report.collectionsCount)} collections (${fmtUGX(report.collectionsTotal)}), ${fmtUGX(report.repaidToday)} advance repayments`;

  const results: Record<string, string> = {};
  for (const to of REPORT_RECIPIENTS) {
    const messageId = crypto.randomUUID();
    const unsubscribeToken = await ensureUnsubscribeToken(admin, to);
    const payload = {
      message_id: messageId,
      to,
      from: FROM,
      sender_domain: SENDER_DOMAIN,
      subject,
      html,
      text,
      purpose: "transactional",
      label: "agent-ops-daily-report",
      idempotency_key: `agent-ops-daily-report:${dateStr}:${to}`,
      unsubscribe_token: unsubscribeToken,
      queued_at: new Date().toISOString(),
    };

    await admin.from("email_send_log").insert({
      message_id: messageId,
      template_name: "agent-ops-daily-report",
      recipient_email: to,
      status: "pending",
      metadata: { subject, date: dateStr },
    });

    const { error: enqErr } = await admin.rpc("enqueue_email", {
      queue_name: "transactional_emails",
      payload,
    });
    results[to] = enqErr ? `error: ${enqErr.message}` : "queued";
    if (enqErr) console.error("[agent-ops-daily-report] enqueue error:", to, enqErr);
  }

  await admin.from("system_events").insert({
    event_type: "agent_ops_daily_report",
    metadata: {
      date: dateStr,
      recipients: REPORT_RECIPIENTS,
      collections: report.collectionsCount,
      collected: report.collectionsTotal,
      deposits: report.depositsCount,
      unique_agents: report.uniqueAgents,
      repaid_today: report.repaidToday,
      arrears_total: report.totalArrears,
      results,
    },
  });

  return {
    date: dateStr,
    recipients: REPORT_RECIPIENTS,
    collections: report.collectionsCount,
    collected: report.collectionsTotal,
    unique_agents: report.uniqueAgents,
    repaid_today: report.repaidToday,
    arrears_total: report.totalArrears,
    results,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE);

    let body: any = {};
    try { body = await req.json(); } catch (_) { body = {}; }

    const force = body?.force === true;
    const preview = body?.preview === true;
    let dates: string[];
    if (Array.isArray(body?.dates) && body.dates.length) {
      dates = body.dates.map((d: string) => String(d).slice(0, 10));
    } else if (typeof body?.date === "string" && body.date) {
      dates = [body.date.slice(0, 10)];
    } else {
      dates = [eatToday()];
    }

    if (preview) {
      const dateStr = dates[0];
      const report = await buildReport(admin, dateStr);
      const prettyDate = new Date(`${dateStr}T00:00:00Z`).toLocaleDateString("en-GB", {
        weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC",
      });
      return new Response(buildHtml(report, prettyDate), {
        headers: { ...corsHeaders, "Content-Type": "text/html; charset=utf-8" },
      });
    }

    const out: Record<string, unknown>[] = [];
    for (const d of dates) out.push(await sendForDate(admin, d, force));

    fetch(`${SUPABASE_URL}/functions/v1/process-email-queue`, {
      method: "POST",
      headers: { Authorization: `Bearer ${SERVICE_ROLE}`, "Content-Type": "application/json" },
      body: "{}",
    }).catch((e) => console.error("[agent-ops-daily-report] dispatch trigger failed:", e));

    return new Response(JSON.stringify({ success: true, reports: out }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("[agent-ops-daily-report] Fatal:", err);
    return new Response(JSON.stringify({ success: false, error: String(err) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
