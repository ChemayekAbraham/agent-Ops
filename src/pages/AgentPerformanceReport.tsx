import { useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import {
  ArrowLeft, Users, CheckCircle2, PieChart as PieIcon, AlertTriangle, TrendingUp,
  Wallet, Banknote, ShieldAlert, Phone, MapPin, Calendar, UserCog, Printer, Download,
  XCircle, Clock, ArrowUpRight, Activity, Target, FileText,
  AlertCircle, Gauge, MapPinned, HandCoins, ListChecks,
} from 'lucide-react';
import {
  ResponsiveContainer, BarChart, Bar, CartesianGrid, XAxis, YAxis, Tooltip,
  PieChart, Pie, Cell,
} from 'recharts';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { Input } from '@/components/ui/input';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import welileLogo from '@/assets/welile-logo.png';
import { cn } from '@/lib/utils';
import { format, differenceInDays } from 'date-fns';
import { useState } from 'react';
import { Search } from 'lucide-react';

// ============= STYLING HELPERS =============
const toneText: Record<string, string> = {
  blue: 'text-blue-600',
  green: 'text-emerald-600',
  red: 'text-red-600',
  amber: 'text-amber-600',
};
const toneBg: Record<string, string> = {
  blue: 'bg-blue-50',
  green: 'bg-emerald-50',
  red: 'bg-red-50',
  amber: 'bg-amber-50',
};

const fmtUGX = (n: number) => `UGX ${Math.round(n).toLocaleString()}`;

const KAMPALA_TZ = 'Africa/Kampala';
const KAMPALA_PARTS = new Intl.DateTimeFormat('en-CA', {
  timeZone: KAMPALA_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const kampalaDateString = (date = new Date()) => {
  const parts = KAMPALA_PARTS.formatToParts(date);
  const year = parts.find((p) => p.type === 'year')?.value || '1970';
  const month = parts.find((p) => p.type === 'month')?.value || '01';
  const day = parts.find((p) => p.type === 'day')?.value || '01';
  return `${year}-${month}-${day}`;
};

const addKampalaDays = (date: string, days: number) => {
  const [year, month, day] = date.split('-').map(Number);
  const next = new Date(Date.UTC(year, month - 1, day + days));
  return next.toISOString().slice(0, 10);
};

const kampalaInstant = (date: string, endOfDay = false) =>
  new Date(`${date}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}+03:00`);

const isKampalaDateInRange = (timestamp: string | null | undefined, start: string, end: string) => {
  if (!timestamp) return false;
  const day = kampalaDateString(new Date(timestamp));
  return day >= start && day <= end;
};


const statusGuide = [
  { range: '85 – 100', status: 'Excellent', desc: 'Outstanding performance', color: 'text-emerald-600' },
  { range: '70 – 84', status: 'Good', desc: 'Good performance', color: 'text-green-600' },
  { range: '50 – 69', status: 'Warning', desc: 'Needs improvement', color: 'text-amber-600' },
  { range: 'Below 50', status: 'Critical', desc: 'Immediate action required', color: 'text-red-600' },
];

// ============= REUSABLE COMPONENTS =============
function SectionCard({ index, title, right, children }: { index: number; title: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-border bg-card shadow-sm overflow-hidden">
      <header className="flex items-center justify-between gap-3 px-4 sm:px-6 py-3 border-b border-border bg-slate-50/60">
        <div className="flex items-center gap-2.5 min-w-0">
          <span className="inline-flex items-center justify-center h-7 w-7 rounded-md bg-blue-600 text-white text-xs font-bold shrink-0">{index}</span>
          <h2 className="text-sm sm:text-base font-bold tracking-wide text-foreground uppercase truncate">{title}</h2>
        </div>
        {right}
      </header>
      <div className="p-4 sm:p-6">{children}</div>
    </section>
  );
}

function KpiCard({ icon: Icon, label, value, tone = 'blue', sub }: { icon?: any; label: string; value: string; tone?: string; sub?: string }) {
  return (
    <div className="group rounded-xl border border-border bg-card p-3.5 hover:shadow-md hover:border-border transition-all min-w-0">
      <div className="flex items-start gap-2.5">
        {Icon && (
          <div className={cn('h-8 w-8 rounded-lg flex items-center justify-center shrink-0', toneBg[tone])}>
            <Icon className={cn('h-4 w-4', toneText[tone])} />
          </div>
        )}
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-medium text-muted-foreground leading-tight uppercase tracking-wide">{label}</p>
          <p className={cn('text-lg sm:text-xl font-bold mt-1 leading-tight truncate', toneText[tone])}>{value}</p>
          {sub && <p className="text-[11px] text-muted-foreground mt-0.5">{sub}</p>}
        </div>
      </div>
    </div>
  );
}

function MiniMetric({ label, value, tone = 'blue' }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-xl border border-border bg-card p-3 hover:shadow-sm transition-all">
      <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide leading-tight">{label}</p>
      <p className={cn('text-lg sm:text-xl font-bold mt-0.5 leading-tight', toneText[tone])}>{value}</p>
    </div>
  );
}

function StatusBadge({ s }: { s: string }) {
  const map: Record<string, string> = {
    Paid: 'bg-emerald-100 text-emerald-700 border-emerald-200',
    Missed: 'bg-red-100 text-red-700 border-red-200',
    Partial: 'bg-amber-100 text-amber-700 border-amber-200',
  };
  return (
    <span className={cn('inline-flex items-center px-2.5 py-0.5 rounded-full text-[11px] font-semibold border', map[s] || 'bg-muted text-muted-foreground')}>
      {s}
    </span>
  );
}

function PerformanceGauge({ score }: { score: number }) {
  const angle = (score / 100) * 180;
  const rad = (180 - angle) * (Math.PI / 180);
  const cx = 110, cy = 110, r = 80;
  const needleX = cx + r * Math.cos(rad);
  const needleY = cy - r * Math.sin(rad);
  const status = score >= 85 ? 'EXCELLENT' : score >= 70 ? 'GOOD' : score >= 50 ? 'WARNING' : 'CRITICAL';
  const statusColor = score >= 85 ? 'text-emerald-600' : score >= 70 ? 'text-green-600' : score >= 50 ? 'text-amber-600' : 'text-red-600';
  return (
    <div className="flex flex-col items-center">
      <svg viewBox="0 0 220 140" className="w-full max-w-[260px]">
        <defs>
          <linearGradient id="gaugeGrad" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="#ef4444" />
            <stop offset="50%" stopColor="#f59e0b" />
            <stop offset="100%" stopColor="#10b981" />
          </linearGradient>
        </defs>
        <path d={`M 30 110 A 80 80 0 0 1 190 110`} fill="none" stroke="#e2e8f0" strokeWidth="18" strokeLinecap="round" />
        <path d={`M 30 110 A 80 80 0 0 1 190 110`} fill="none" stroke="url(#gaugeGrad)" strokeWidth="18" strokeLinecap="round" />
        <text x="20" y="130" className="fill-slate-500" fontSize="10">0</text>
        <text x="50" y="40" className="fill-slate-500" fontSize="10">25</text>
        <text x="105" y="22" className="fill-slate-500" fontSize="10">50</text>
        <text x="160" y="40" className="fill-slate-500" fontSize="10">75</text>
        <text x="190" y="130" className="fill-slate-500" fontSize="10">100</text>
        <line x1={cx} y1={cy} x2={needleX} y2={needleY} stroke="#0f172a" strokeWidth="3" strokeLinecap="round" />
        <circle cx={cx} cy={cy} r="6" fill="#0f172a" />
      </svg>
      <div className="text-center mt-1">
        <p className="text-3xl font-bold text-foreground">{score}<span className="text-base text-muted-foreground"> / 100</span></p>
        <p className={cn('text-sm font-bold tracking-wider mt-1', statusColor)}>{status}</p>
      </div>
    </div>
  );
}

// ============= DATA HOOK =============
async function fetchAgentReport(agentId: string) {
  const now = new Date();
  const today = kampalaDateString(now);
  const weekStartDay = addKampalaDays(today, -6);
  const historyStartDay = addKampalaDays(today, -120);
  const weekStart = kampalaInstant(weekStartDay);
  const historyStart = kampalaInstant(historyStartDay); // 120d window: covers aging + last-payment lookup

  // Agent profile + wallet + authoritative capped collection report
  const [profileRes, walletRes, todayReportRes, weekReportRes] = await Promise.all([
    supabase.from('profiles').select('id, full_name, phone, created_at, city, country').eq('id', agentId).maybeSingle(),
    supabase.from('wallets').select('withdrawable_balance, float_balance, balance').eq('user_id', agentId).maybeSingle(),
    supabase.rpc('agent_ops_report_agent', { p_agent_id: agentId, p_from: today, p_to: today }),
    supabase.rpc('agent_ops_report_agent', { p_agent_id: agentId, p_from: weekStartDay, p_to: today }),
  ]);
  if (todayReportRes.error) throw todayReportRes.error;
  if (weekReportRes.error) throw weekReportRes.error;

  // All rent_requests assigned to this agent (paginate to be safe)
  const rrAll: any[] = [];
  let from = 0;
  const PAGE = 1000;
  while (true) {
    const { data, error } = await supabase
      .from('rent_requests')
      .select('id, tenant_id, status, tenancy_status, registration_type, rent_amount, daily_repayment, total_repayment, amount_repaid, created_at, disbursed_at, request_city, house_category')
      .or(`agent_id.eq.${agentId},assigned_agent_id.eq.${agentId}`)
      .order('created_at', { ascending: false })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    if (!data?.length) break;
    rrAll.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }

  // Tenant profiles
  const tenantIds = [...new Set(rrAll.map(r => r.tenant_id))];
  const tenantNameMap = new Map<string, string>();
  const tenantPhoneMap = new Map<string, string>();
  for (let i = 0; i < tenantIds.length; i += 500) {
    const slice = tenantIds.slice(i, i + 500);
    const { data } = await supabase.from('profiles').select('id, full_name, phone').in('id', slice);
    (data || []).forEach(p => {
      tenantNameMap.set(p.id, p.full_name || 'Tenant');
      if (p.phone) tenantPhoneMap.set(p.id, p.phone);
    });
  }

  // Repayments for these rent_requests, last 120 days (for aging + true last-payment + week trend)
  const rrIds = rrAll.map(r => r.id);
  const repayments: any[] = [];
  if (rrIds.length) {
    for (let i = 0; i < rrIds.length; i += 300) {
      const slice = rrIds.slice(i, i + 300);
      const { data } = await supabase
        .from('repayments')
        .select('rent_request_id, tenant_id, amount, created_at')
        .in('rent_request_id', slice)
        .gte('created_at', historyStart.toISOString());
      if (data) repayments.push(...data);
    }
  }

  // Field activity: agent_visits (last 30 days)
  const visitsSince = kampalaInstant(addKampalaDays(today, -29)).toISOString();
  const { data: visitsData } = await supabase
    .from('agent_visits')
    .select('id, tenant_id, created_at, location_name')
    .eq('agent_id', agentId)
    .gte('created_at', visitsSince)
    .order('created_at', { ascending: false })
    .limit(500);

  // Agent earnings (commissions/bonuses) last 30 days
  const { data: earningsData } = await supabase
    .from('agent_earnings')
    .select('amount, earning_type, created_at')
    .eq('agent_id', agentId)
    .gte('created_at', visitsSince)
    .limit(2000);

  // Agent rent collections (recorded field collections) last 30 days
  const { data: agentCollectionsData } = await supabase
    .from('agent_collections')
    .select('amount, created_at, payment_method, tenant_id, momo_payer_name').is('reversed_at', null)
    .eq('agent_id', agentId)
    .gte('created_at', visitsSince)
    .order('created_at', { ascending: false })
    .limit(500);

  return {
    profile: profileRes.data,
    wallet: walletRes.data,
    rentRequests: rrAll,
    tenantNameMap,
    tenantPhoneMap,
    repayments,
    todayReport: todayReportRes.data as any,
    weekReport: weekReportRes.data as any,
    today,
    weekStartDay,
    visits: visitsData || [],
    earnings: earningsData || [],
    agentCollections: agentCollectionsData || [],
    now,
    weekStart,
  };
}

// ============= MAIN PAGE =============
export default function AgentPerformanceReport() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const agentId = params.get('id') || params.get('agent_id') || '';
  const overrideName = params.get('name');

  const { data, isLoading, error } = useQuery({
    queryKey: ['agent-perf-report', agentId],
    queryFn: () => fetchAgentReport(agentId),
    enabled: !!agentId,
    staleTime: 60_000,
  });

  const computed = useMemo(() => {
    if (!data) return null;
    const { profile, wallet, rentRequests, tenantNameMap, tenantPhoneMap, repayments, todayReport, weekReport, today, weekStartDay, visits, earnings, agentCollections, now, weekStart } = data;

    // Active = anyone still owing on a non-completed plan. Many active plans have NULL tenancy_status,
    // so we no longer require tenancy_status='active' — that filter was hiding most real tenants.
    const COMPLETED = new Set(['completed', 'closed', 'rejected', 'cancelled', 'declined']);
    const activeRR = rentRequests.filter(r => {
      if (COMPLETED.has(String(r.status || '').toLowerCase())) return false;
      const owed = Number(r.total_repayment || 0);
      const paid = Number(r.amount_repaid || 0);
      return owed === 0 || paid < owed; // owed=0 (not yet billed) is still an active relationship
    });

    const uniqueActiveTenants = new Set(activeRR.map(r => r.tenant_id));
    const uniqueAllTenants = new Set(rentRequests.map(r => r.tenant_id));

    // Today — same capped schedule basis as Tenant Ops Home / Agent Ops Reports.
    const todayKpis = (todayReport?.kpis || {}) as Record<string, unknown>;
    const todayTenantRows = Array.isArray(todayReport?.tenants) ? todayReport.tenants : [];
    const collectedToday = Number(todayKpis.collected_window || 0);
    const expectedToday = Number(todayKpis.expected_window || 0);
    const tenantsPaidToday = todayTenantRows.filter((t: any) => Number(t.collected || 0) > 0).length;
    const tenantsExpectedToday = todayTenantRows.length || activeRR.length;

    const allDailyTenants = todayTenantRows.map((t: any) => {
      const expected = Number(t.daily_repayment || 0);
      const paid = Number(t.collected || 0);
      const balance = Math.max(0, expected - paid);
      const status = paid >= expected && expected > 0 ? 'Paid' : paid > 0 ? 'Partial' : 'Missed';
      return {
        tenant: String(t.tenant_name || 'Tenant'),
        phone: String(t.tenant_phone || ''),
        unit: String(t.house_type || '—').slice(0, 6),
        expected,
        paid,
        balance,
        status,
      };
    });
    const dailyTenants = allDailyTenants.slice(0, 50);
    const totalExpectedToday = expectedToday;
    const totalPaidToday = collectedToday;
    const totalBalanceToday = Math.max(0, expectedToday - collectedToday);
    const missedToday = allDailyTenants.filter(t => t.status === 'Missed').length;
    const partialToday = allDailyTenants.filter(t => t.status === 'Partial').length;

    // Week (last 7 days) — capped to each tenant's schedule and zero-filled by the server.
    const weekKpis = (weekReport?.kpis || {}) as Record<string, unknown>;
    const weeklyExpected = Number(weekKpis.expected_window || 0);
    const weeklyCollected = Number(weekKpis.collected_window || 0);
    const weeklyOutstanding = Math.max(0, weeklyExpected - weeklyCollected);
    const weeklyEfficiency = weeklyExpected > 0 ? (weeklyCollected / weeklyExpected) * 100 : 0;

    const weeklyTrend = (Array.isArray(weekReport?.periods) ? weekReport.periods : []).map((period: any) => ({
      day: format(kampalaInstant(String(period.period)), 'MMM d'),
      Collected: Number(period.collected || 0),
    }));

    // True last-payment per rent_request (within the 120d history window)
    const lastPaymentByRR = new Map<string, string>();
    repayments.forEach(p => {
      const prev = lastPaymentByRR.get(p.rent_request_id);
      if (!prev || new Date(p.created_at) > new Date(prev)) lastPaymentByRR.set(p.rent_request_id, p.created_at);
    });

    // Outstanding per active rr — aging is days since LAST payment, not since disbursement.
    // If no payment in 120d, fall back to disbursed_at/created_at.
    const rrWithOutstanding = activeRR.map(r => {
      const outstanding = Math.max(0, Number(r.total_repayment || 0) - Number(r.amount_repaid || 0));
      const last = lastPaymentByRR.get(r.id);
      const anchor = last ? new Date(last) : new Date(r.disbursed_at || r.created_at);
      const ageDays = Math.max(0, differenceInDays(now, anchor));
      return { rr: r, outstanding, ageDays };
    });
    const totalOutstanding = rrWithOutstanding.reduce((s, x) => s + x.outstanding, 0);
    const tenantsInArrears = rrWithOutstanding.filter(x => x.outstanding > 0).length;
    const portfolioPctArrears = activeRR.length > 0 ? (tenantsInArrears / activeRR.length) * 100 : 0;
    const avgDebtPerTenant = tenantsInArrears > 0 ? totalOutstanding / tenantsInArrears : 0;
    const highestDebt = rrWithOutstanding.reduce((m, x) => Math.max(m, x.outstanding), 0);

    // Aging buckets (days since last payment)
    const buckets = { '0–30 Days': 0, '31–60 Days': 0, '61–90 Days': 0, '90+ Days': 0 } as Record<string, number>;
    rrWithOutstanding.forEach(x => {
      if (x.outstanding <= 0) return;
      if (x.ageDays <= 30) buckets['0–30 Days'] += x.outstanding;
      else if (x.ageDays <= 60) buckets['31–60 Days'] += x.outstanding;
      else if (x.ageDays <= 90) buckets['61–90 Days'] += x.outstanding;
      else buckets['90+ Days'] += x.outstanding;
    });
    const debtAging = [
      { name: '0–30 Days', value: buckets['0–30 Days'], color: '#3b82f6' },
      { name: '31–60 Days', value: buckets['31–60 Days'], color: '#f59e0b' },
      { name: '61–90 Days', value: buckets['61–90 Days'], color: '#fbbf24' },
      { name: '90+ Days', value: buckets['90+ Days'], color: '#ef4444' },
    ];

    // Top defaulters (with phone, last-payment, days-late)
    const topDefaulters = [...rrWithOutstanding]
      .filter(x => x.outstanding > 0)
      .sort((a, b) => b.outstanding - a.outstanding)
      .slice(0, 5)
      .map(x => ({
        tenant: tenantNameMap.get(x.rr.tenant_id) || 'Tenant',
        phone: tenantPhoneMap.get(x.rr.tenant_id) || '',
        debt: x.outstanding,
        daysLate: x.ageDays,
        last: lastPaymentByRR.get(x.rr.id) ? format(new Date(lastPaymentByRR.get(x.rr.id) as string), 'MMM d, yyyy') : '—',
      }));

    // Field activity aggregates
    const visitsToday = visits.filter(v => isKampalaDateInRange(v.created_at, today, today)).length;
    const visitsWeek = visits.filter(v => isKampalaDateInRange(v.created_at, weekStartDay, today)).length;
    const earningsToday = earnings
      .filter(e => isKampalaDateInRange(e.created_at, today, today))
      .reduce((s, e) => s + Number(e.amount || 0), 0);
    const earnings30d = earnings.reduce((s, e) => s + Number(e.amount || 0), 0);
    const collectionsToday = agentCollections.filter(c => isKampalaDateInRange(c.created_at, today, today)).length;
    const collections30d = agentCollections.length;

    // Scoring
    const dailyEff = expectedToday > 0 ? Math.min(100, (collectedToday / expectedToday) * 100) : 0;
    const recoveryScore = activeRR.length > 0
      ? Math.max(0, 100 - portfolioPctArrears)
      : 0;
    const retention = uniqueAllTenants.size > 0 ? (uniqueActiveTenants.size / uniqueAllTenants.size) * 100 : 0;
    const missedRate = tenantsExpectedToday > 0 ? 100 - (tenantsPaidToday / tenantsExpectedToday) * 100 : 0;

    const kpiScorecard = [
      { kpi: 'Today: money collected vs expected', weight: 35, score: Math.round(dailyEff) },
      { kpi: 'This week: collection rate', weight: 25, score: Math.round(weeklyEfficiency) },
      { kpi: 'Tenants paying on time', weight: 20, score: Math.round(recoveryScore) },
      { kpi: 'Tenants still with you', weight: 10, score: Math.round(retention) },
      { kpi: 'Tenants who paid today', weight: 10, score: Math.round(Math.max(0, 100 - missedRate)) },
    ];
    const totalScore = Math.round(kpiScorecard.reduce((s, r) => s + (r.score * r.weight) / 100, 0));
    const riskStatus = totalScore >= 70 ? 'HEALTHY' : totalScore >= 50 ? 'WARNING' : 'CRITICAL';
    const riskTone = totalScore >= 70 ? 'green' : totalScore >= 50 ? 'amber' : 'red';

    const summaryKpis = [
      { label: 'My active tenants', value: String(uniqueActiveTenants.size), icon: Users, tone: 'blue' },
      { label: 'Paid me today', value: String(tenantsPaidToday), icon: CheckCircle2, tone: 'green' },
      { label: 'Visits today', value: String(visitsToday), icon: MapPinned, tone: 'blue' },
      { label: 'My commission today', value: fmtUGX(earningsToday), icon: HandCoins, tone: 'green' },
      { label: 'Money tenants still owe', value: fmtUGX(totalOutstanding), icon: FileText, tone: 'red' },
      { label: 'My wallet (can withdraw)', value: fmtUGX(Number(wallet?.withdrawable_balance || 0)), icon: Wallet, tone: 'blue' },
      { label: 'My float (company money)', value: fmtUGX(Number(wallet?.float_balance || 0)), icon: Banknote, tone: 'green' },
      { label: 'My status', value: riskStatus, icon: ShieldAlert, tone: riskTone },
    ] as const;

    const dailyKpis = [
      { label: 'Money owed today', value: fmtUGX(expectedToday), tone: 'blue' },
      { label: 'Money you collected today', value: fmtUGX(collectedToday), tone: 'green' },
      { label: 'Still to collect today', value: fmtUGX(Math.max(0, expectedToday - collectedToday)), tone: 'red' },
      { label: 'Today % collected', value: `${dailyEff.toFixed(0)}%`, tone: 'amber' },
      { label: 'Tenants due today', value: String(tenantsExpectedToday), tone: 'blue' },
      { label: 'Tenants who paid you', value: String(tenantsPaidToday), tone: 'green' },
      { label: 'Tenants who missed', value: String(missedToday), tone: 'red' },
      { label: 'Tenants who paid partly', value: String(partialToday), tone: 'amber' },
    ];

    const weeklyKpis = [
      { label: 'Money owed this week', value: fmtUGX(weeklyExpected), tone: 'blue' },
      { label: 'Money you collected this week', value: fmtUGX(weeklyCollected), tone: 'green' },
      { label: 'Still owing this week', value: fmtUGX(weeklyOutstanding), tone: 'red' },
      { label: 'This week % collected', value: `${weeklyEfficiency.toFixed(1)}%`, tone: 'amber' },
      { label: 'Avg per day collected', value: fmtUGX(weeklyCollected / 7), tone: 'green' },
      { label: 'Visits this week', value: String(visitsWeek), tone: 'blue' },
    ];

    const debtSummary = [
      { label: 'Total tenants still owe', value: fmtUGX(totalOutstanding), icon: FileText, tone: 'red' },
      { label: 'Owed in the last 30 days', value: fmtUGX(buckets['0–30 Days']), icon: Calendar, tone: 'amber' },
      { label: 'Owed older than 30 days', value: fmtUGX(buckets['31–60 Days'] + buckets['61–90 Days'] + buckets['90+ Days']), icon: Clock, tone: 'red' },
      { label: 'Biggest single debt', value: fmtUGX(highestDebt), icon: AlertTriangle, tone: 'red' },
      { label: 'This week % collected', value: `${weeklyEfficiency.toFixed(0)}%`, icon: Activity, tone: 'amber' },
    ];

    const debtKpiStrip = [
      { label: 'Tenants who still owe', value: String(tenantsInArrears), sub: `(${portfolioPctArrears.toFixed(1)}%)`, icon: Users, tone: 'red' },
      { label: 'Average debt per tenant', value: fmtUGX(avgDebtPerTenant), icon: Banknote, tone: 'amber' },
      { label: '% of your tenants behind', value: `${portfolioPctArrears.toFixed(1)}%`, icon: Target, tone: 'red' },
      { label: 'Active rent plans', value: String(activeRR.length), icon: ArrowUpRight, tone: 'blue' },
    ];

    // Action checklist — concrete, ordered things the agent should do next
    const actionChecklist: { title: string; detail: string; tone: string }[] = [];
    if (missedToday > 0) {
      actionChecklist.push({ title: `Call ${missedToday} tenant${missedToday === 1 ? '' : 's'} who missed today`, detail: 'See the "Today" table below — tap the phone number.', tone: 'red' });
    }
    if (buckets['90+ Days'] > 0) {
      actionChecklist.push({ title: `Recover old debt (90+ days)`, detail: `${fmtUGX(buckets['90+ Days'])} sitting in 90+ days. Visit these tenants this week.`, tone: 'red' });
    }
    if (visitsToday === 0 && tenantsInArrears > 0) {
      actionChecklist.push({ title: 'Do at least 1 field visit today', detail: 'No visits recorded yet. Visits build your trust score and recover debt faster.', tone: 'amber' });
    }
    if (Number(wallet?.float_balance || 0) < 50_000) {
      actionChecklist.push({ title: 'Top up your float', detail: 'Your float is low — you may not be able to receive deposits from tenants.', tone: 'amber' });
    }
    if (actionChecklist.length === 0) {
      actionChecklist.push({ title: 'You are on track today — keep collecting!', detail: `${tenantsPaidToday} paid, ${fmtUGX(collectedToday)} collected.`, tone: 'green' });
    }

    // Field activity feed (last 30d): merge visits + collections, newest first, cap 8
    const activityFeed = [
      ...visits.map(v => ({ when: v.created_at, kind: 'Visit', label: tenantNameMap.get(v.tenant_id) || 'Tenant', meta: v.location_name || '' })),
      ...agentCollections.map(c => ({ when: c.created_at, kind: 'Collection', label: tenantNameMap.get(c.tenant_id) || c.momo_payer_name || 'Tenant', meta: `${fmtUGX(Number(c.amount || 0))} · ${c.payment_method || ''}` })),
    ].sort((a, b) => new Date(b.when).getTime() - new Date(a.when).getTime()).slice(0, 8);

    const periodLabel = `${format(weekStart, 'MMM d')} – ${format(kampalaInstant(today), 'MMM d, yyyy')}`;
    const generatedLabel = format(now, 'MMM d, yyyy HH:mm');

    return {
      profile,
      summaryKpis,
      dailyKpis,
      dailyTenants,
      totals: { totalExpectedToday, totalPaidToday, totalBalanceToday },
      weeklyKpis,
      weeklyTrend,
      weeklyExpected,
      weeklyCollected,
      weeklyEfficiency,
      debtSummary,
      debtAging,
      topDefaulters,
      debtKpiStrip,
      kpiScorecard,
      totalScore,
      recoveryScore: Math.round(recoveryScore),
      totalDebt: totalOutstanding,
      actionChecklist,
      activityFeed,
      visitsToday,
      visitsWeek,
      earningsToday,
      earnings30d,
      collectionsToday,
      collections30d,
      periodLabel,
      generatedLabel,
    };
  }, [data]);

  const displayName = computed?.profile?.full_name || overrideName || 'Agent';
  const period = computed ? { range: computed.periodLabel, generated: computed.generatedLabel } : { range: '—', generated: '—' };
  const totalScore = computed?.totalScore ?? 0;
  const recoveryScore = computed?.recoveryScore ?? 0;
  const totalDebt = computed?.totalDebt ?? 0;

  if (!agentId) {
    return <AgentPicker onPick={(id) => navigate(`/agent-performance-report?id=${id}`)} onBack={() => navigate(-1)} />;
  }

  return (
    <div className="min-h-screen bg-slate-50/60 print:bg-card">
      {/* ===== STICKY HEADER ===== */}
      <header className="sticky top-0 z-30 bg-white/90 backdrop-blur border-b border-border shadow-sm print:static print:shadow-none">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-3 flex items-center gap-4">
          <Button variant="ghost" size="icon" onClick={() => navigate(-1)} className="shrink-0 print:hidden">
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <img src={welileLogo} alt="Welile" className="h-9 w-auto shrink-0" />
          <div className="hidden md:block flex-1 text-center min-w-0">
            <h1 className="text-lg lg:text-2xl font-bold tracking-tight text-foreground truncate">AGENT PERFORMANCE REPORT</h1>
            <p className="text-xs text-muted-foreground">Performance Overview and Collection Intelligence</p>
          </div>
          <div className="hidden sm:block text-right shrink-0">
            <p className="text-[10px] uppercase font-semibold text-muted-foreground tracking-wider">Report Period</p>
            <p className="text-sm font-bold text-blue-600">{period.range}</p>
            <p className="text-[10px] text-muted-foreground mt-0.5">Generated: {period.generated}</p>
          </div>
          <div className="flex items-center gap-2 shrink-0 print:hidden">
            <Button variant="outline" size="sm" onClick={() => window.print()} className="gap-1.5">
              <Printer className="h-4 w-4" /> <span className="hidden sm:inline">Print</span>
            </Button>
            <Button size="sm" className="gap-1.5">
              <Download className="h-4 w-4" /> <span className="hidden sm:inline">Export PDF</span>
            </Button>
          </div>
        </div>
        <div className="md:hidden text-center pb-2 px-4">
          <h1 className="text-base font-bold tracking-tight text-foreground">AGENT PERFORMANCE REPORT</h1>
          <p className="text-[11px] text-muted-foreground">{period.range}</p>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 py-6 space-y-5">
        {error && (
          <div className="rounded-xl border border-red-300 bg-red-50 p-4 flex items-start gap-3">
            <XCircle className="h-5 w-5 text-red-600 shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-bold text-red-900">Failed to load agent data</p>
              <p className="text-xs text-red-800 mt-0.5">{(error as Error).message}</p>
            </div>
          </div>
        )}

        {/* ===== ACTION CHECKLIST (what to do now) ===== */}
        {computed && (
          <section className="rounded-2xl border-2 border-blue-200 bg-gradient-to-br from-blue-50 to-white p-4 sm:p-5">
            <div className="flex items-center gap-2 mb-3">
              <span className="inline-flex items-center justify-center h-7 w-7 rounded-md bg-blue-600 text-white">
                <ListChecks className="h-4 w-4" />
              </span>
              <h2 className="text-sm sm:text-base font-bold text-foreground uppercase tracking-wide">What to do now</h2>
            </div>
            <ul className="space-y-2">
              {computed.actionChecklist.map((a, i) => (
                <li key={i} className={cn('flex items-start gap-3 p-3 rounded-xl border', toneBg[a.tone], 'border-border')}>
                  <span className={cn('h-6 w-6 rounded-full flex items-center justify-center text-xs font-bold shrink-0 bg-card border', toneText[a.tone])}>{i + 1}</span>
                  <div className="min-w-0 flex-1">
                    <p className={cn('text-sm font-bold', toneText[a.tone])}>{a.title}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">{a.detail}</p>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* ===== SECTION 1: AGENT SUMMARY ===== */}
        <SectionCard index={1} title="Agent Summary">
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
            <div className="lg:col-span-4 rounded-xl border border-border bg-gradient-to-br from-slate-50 to-white p-4 flex flex-col sm:flex-row lg:flex-col items-center sm:items-start lg:items-center gap-4 text-center sm:text-left lg:text-center">
              <div className="h-24 w-24 rounded-full bg-gradient-to-br from-blue-500 to-blue-700 text-white flex items-center justify-center text-3xl font-bold shrink-0 ring-4 ring-blue-100">
                {displayName.split(' ').map(n => n[0]).slice(0, 2).join('')}
              </div>
              <div className="min-w-0 flex-1">
                <h3 className="text-lg font-bold text-foreground">{displayName}</h3>
                <p className="text-sm text-muted-foreground">Agent ID: <span className="text-blue-600 font-semibold">{agentId.slice(0, 8).toUpperCase()}</span></p>
                <ul className="mt-3 space-y-1.5 text-sm text-muted-foreground text-left">
                  <li className="flex items-center gap-2"><MapPin className="h-3.5 w-3.5 text-muted-foreground" /> Branch: {computed?.profile?.city || '—'}</li>
                  <li className="flex items-center gap-2"><Phone className="h-3.5 w-3.5 text-muted-foreground" /> {computed?.profile?.phone || '—'}</li>
                  <li className="flex items-center gap-2"><Calendar className="h-3.5 w-3.5 text-muted-foreground" /> Joined: {computed?.profile?.created_at ? format(new Date(computed.profile.created_at), 'd MMM yyyy') : '—'}</li>
                  <li className="flex items-center gap-2"><UserCog className="h-3.5 w-3.5 text-muted-foreground" /> Country: {computed?.profile?.country || '—'}</li>
                </ul>
              </div>
            </div>
            <div className="lg:col-span-8">
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
                {isLoading || !computed
                  ? Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-[88px] rounded-xl" />)
                  : computed.summaryKpis.map(k => (
                      <KpiCard key={k.label} icon={k.icon} label={k.label} value={k.value} tone={k.tone} />
                    ))}
              </div>
            </div>
          </div>

          <div className="mt-5 grid grid-cols-1 md:grid-cols-2 gap-4 pt-4 border-t border-border">
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-xs font-semibold text-muted-foreground">Recovery Score</span>
                <span className="text-xs font-bold text-red-600">{recoveryScore}/100</span>
              </div>
              <Progress value={recoveryScore} className="h-2 [&>div]:bg-red-500" />
            </div>
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-xs font-semibold text-muted-foreground">Performance Score</span>
                <span className="text-xs font-bold text-amber-600">{totalScore}/100</span>
              </div>
              <Progress value={totalScore} className="h-2 [&>div]:bg-amber-500" />
            </div>
          </div>
        </SectionCard>

        {/* ===== SECTIONS 2 & 3 ===== */}
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
          <SectionCard index={2} title="Daily Performance" right={<span className="text-xs text-muted-foreground hidden sm:inline">Date: {format(new Date(), 'MMM d, yyyy')} (Today)</span>}>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {isLoading || !computed
                ? Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-[68px] rounded-xl" />)
                : computed.dailyKpis.map(k => <MiniMetric key={k.label} label={k.label} value={k.value} tone={k.tone} />)}
            </div>

            <div className="mt-5">
              <h4 className="text-xs font-bold text-muted-foreground uppercase tracking-wide mb-2">Daily Tenant Breakdown</h4>
              <div className="rounded-xl border border-border overflow-hidden max-h-[320px] overflow-y-auto">
                <Table>
                  <TableHeader className="bg-muted sticky top-0 z-10">
                    <TableRow>
                      <TableHead className="text-xs">Tenant</TableHead>
                      <TableHead className="text-xs">Phone</TableHead>
                      <TableHead className="text-xs">Type</TableHead>
                      <TableHead className="text-xs text-right">Expected</TableHead>
                      <TableHead className="text-xs text-right">Paid</TableHead>
                      <TableHead className="text-xs text-right">Balance</TableHead>
                      <TableHead className="text-xs">Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(computed?.dailyTenants || []).map((t, i) => (
                      <TableRow key={i} className={cn('hover:bg-blue-50/40', i % 2 === 1 && 'bg-slate-50/60')}>
                        <TableCell className="font-medium text-sm">{t.tenant}</TableCell>
                        <TableCell className="text-xs">
                          {t.phone ? (
                            <a href={`tel:${t.phone}`} className="inline-flex items-center gap-1 text-blue-600 hover:underline">
                              <Phone className="h-3 w-3" />{t.phone}
                            </a>
                          ) : <span className="text-muted-foreground">—</span>}
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">{t.unit}</TableCell>
                        <TableCell className="text-right text-sm tabular-nums">{Math.round(t.expected).toLocaleString()}</TableCell>
                        <TableCell className="text-right text-sm tabular-nums">{Math.round(t.paid).toLocaleString()}</TableCell>
                        <TableCell className="text-right text-sm tabular-nums font-semibold">{Math.round(t.balance).toLocaleString()}</TableCell>
                        <TableCell><StatusBadge s={t.status} /></TableCell>
                      </TableRow>
                    ))}
                    {computed && (
                      <TableRow className="bg-blue-50/50 font-bold">
                        <TableCell colSpan={3} className="text-blue-700 text-sm">TOTAL</TableCell>
                        <TableCell className="text-right text-sm tabular-nums text-blue-700">{Math.round(computed.totals.totalExpectedToday).toLocaleString()}</TableCell>
                        <TableCell className="text-right text-sm tabular-nums text-blue-700">{Math.round(computed.totals.totalPaidToday).toLocaleString()}</TableCell>
                        <TableCell className="text-right text-sm tabular-nums text-blue-700">{Math.round(computed.totals.totalBalanceToday).toLocaleString()}</TableCell>
                        <TableCell></TableCell>
                      </TableRow>
                    )}
                    {computed && computed.dailyTenants.length === 0 && (
                      <TableRow><TableCell colSpan={7} className="text-center text-sm text-muted-foreground py-6">No active tenants for this agent.</TableCell></TableRow>
                    )}
                  </TableBody>
                </Table>
              </div>
            </div>
          </SectionCard>

          <SectionCard index={3} title="Weekly Performance" right={<span className="text-xs text-muted-foreground hidden sm:inline">{period.range}</span>}>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              {isLoading || !computed
                ? Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-[68px] rounded-xl" />)
                : computed.weeklyKpis.map(k => <MiniMetric key={k.label} label={k.label} value={k.value} tone={k.tone} />)}
            </div>

            <div className="mt-5">
              <h4 className="text-xs font-bold text-muted-foreground uppercase tracking-wide mb-2">Money you collected each day (last 7 days)</h4>
              <div className="rounded-xl border border-border bg-card p-3">
                <ResponsiveContainer width="100%" height={260}>
                  <BarChart data={computed?.weeklyTrend || []} margin={{ top: 10, right: 10, left: -10, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
                    <XAxis dataKey="day" stroke="#94a3b8" fontSize={11} />
                    <YAxis stroke="#94a3b8" fontSize={11} tickFormatter={(v) => `${Math.round(v / 1000)}K`} />
                    <Tooltip formatter={(v: number) => fmtUGX(v)} contentStyle={{ borderRadius: 12, border: '1px solid #e2e8f0', fontSize: 12 }} />
                    <Bar dataKey="Collected" fill="#10b981" radius={[6, 6, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
                {computed && (
                  <div className="flex flex-wrap items-center gap-x-5 gap-y-1 pt-2 px-2 text-xs border-t border-border mt-2">
                    <span className="text-muted-foreground">Total this week: <span className="font-bold text-emerald-600">{fmtUGX(computed.weeklyCollected)}</span></span>
                    <span className="text-muted-foreground">% of money owed: <span className="font-bold text-amber-600">{computed.weeklyEfficiency.toFixed(1)}%</span></span>
                  </div>
                )}
              </div>
            </div>
          </SectionCard>
        </div>

        {/* ===== SECTION 4: DEBT ===== */}
        <SectionCard index={4} title="Outstanding Balance / Debt Summary">
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
            <div className="lg:col-span-4 space-y-2.5">
              {(computed?.debtSummary || []).map(d => (
                <div key={d.label} className="flex items-center gap-3 p-3 rounded-lg border border-border bg-card hover:shadow-sm transition-all">
                  <div className={cn('h-9 w-9 rounded-lg flex items-center justify-center shrink-0', toneBg[d.tone])}>
                    <d.icon className={cn('h-4 w-4', toneText[d.tone])} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-xs text-muted-foreground">{d.label}</p>
                  </div>
                  <p className={cn('text-sm font-bold tabular-nums shrink-0', toneText[d.tone])}>{d.value}</p>
                </div>
              ))}
            </div>
            <div className="lg:col-span-4">
              <h4 className="text-xs font-bold text-muted-foreground uppercase tracking-wide mb-2 text-center">Debt Aging Analysis</h4>
              <div className="relative">
                <ResponsiveContainer width="100%" height={240}>
                  <PieChart>
                    <Pie data={computed?.debtAging || []} dataKey="value" nameKey="name" cx="50%" cy="50%" innerRadius={55} outerRadius={90} paddingAngle={2}>
                      {(computed?.debtAging || []).map((d, i) => <Cell key={i} fill={d.color} />)}
                    </Pie>
                    <Tooltip formatter={(v: number) => fmtUGX(v)} contentStyle={{ borderRadius: 12, fontSize: 12 }} />
                  </PieChart>
                </ResponsiveContainer>
                <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
                  <p className="text-xl font-bold text-foreground">{(totalDebt / 1_000_000).toFixed(2)}M</p>
                  <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Total Debt</p>
                </div>
              </div>
              <ul className="mt-2 space-y-1">
                {(computed?.debtAging || []).map(d => {
                  const pct = totalDebt > 0 ? ((d.value / totalDebt) * 100).toFixed(1) : '0.0';
                  return (
                    <li key={d.name} className="flex items-center justify-between text-xs">
                      <span className="flex items-center gap-2"><span className="h-2.5 w-2.5 rounded-full" style={{ background: d.color }} />{d.name}</span>
                      <span className="tabular-nums text-muted-foreground"><span className="font-semibold text-foreground">{Math.round(d.value).toLocaleString()}</span> ({pct}%)</span>
                    </li>
                  );
                })}
              </ul>
            </div>
            <div className="lg:col-span-4">
              <h4 className="text-xs font-bold text-muted-foreground uppercase tracking-wide mb-2">Top Defaulters</h4>
              <div className="rounded-xl border border-border overflow-hidden">
                <Table>
                  <TableHeader className="bg-muted">
                    <TableRow>
                      <TableHead className="text-xs">Tenant</TableHead>
                      <TableHead className="text-xs">Phone</TableHead>
                      <TableHead className="text-xs text-right">Debt</TableHead>
                      <TableHead className="text-xs text-right">Days Late</TableHead>
                      <TableHead className="text-xs">Last Payment</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(computed?.topDefaulters || []).map((t, i) => (
                      <TableRow key={i} className="hover:bg-red-50/30">
                        <TableCell className="text-sm font-medium">{t.tenant}</TableCell>
                        <TableCell className="text-xs">
                          {t.phone ? (
                            <a href={`tel:${t.phone}`} className="inline-flex items-center gap-1 text-blue-600 hover:underline">
                              <Phone className="h-3 w-3" />{t.phone}
                            </a>
                          ) : <span className="text-muted-foreground">—</span>}
                        </TableCell>
                        <TableCell className="text-right text-sm tabular-nums font-semibold">{Math.round(t.debt).toLocaleString()}</TableCell>
                        <TableCell className="text-right text-sm tabular-nums">
                          <span className={cn('font-bold', t.daysLate >= 40 ? 'text-red-600' : t.daysLate >= 30 ? 'text-orange-600' : 'text-amber-600')}>{t.daysLate}</span>
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">{t.last}</TableCell>
                      </TableRow>
                    ))}
                    {computed && computed.topDefaulters.length === 0 && (
                      <TableRow><TableCell colSpan={5} className="text-center text-sm text-muted-foreground py-6">No defaulters.</TableCell></TableRow>
                    )}
                  </TableBody>
                </Table>
              </div>
            </div>
          </div>

          <div className="mt-5 pt-5 border-t border-border grid grid-cols-2 lg:grid-cols-4 gap-3">
            {(computed?.debtKpiStrip || []).map(k => (
              <KpiCard key={k.label} icon={k.icon} label={k.label} value={k.value} tone={k.tone} sub={k.sub} />
            ))}
          </div>
        </SectionCard>

        {/* ===== SECTION 5 ===== */}
        <SectionCard index={5} title="Performance Scoring">
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
            <div>
              <h4 className="text-xs font-bold text-muted-foreground uppercase tracking-wide mb-2">KPI Scorecard</h4>
              <div className="rounded-xl border border-border overflow-hidden">
                <Table>
                  <TableHeader className="bg-muted">
                    <TableRow>
                      <TableHead className="text-xs">KPI</TableHead>
                      <TableHead className="text-xs text-right">Weight</TableHead>
                      <TableHead className="text-xs text-right">Score</TableHead>
                      <TableHead className="text-xs text-right">Weighted</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(computed?.kpiScorecard || []).map((r, i) => (
                      <TableRow key={i} className="hover:bg-slate-50/60">
                        <TableCell className="text-sm font-medium">{r.kpi}</TableCell>
                        <TableCell className="text-right text-sm tabular-nums">{r.weight}%</TableCell>
                        <TableCell className="text-right text-sm tabular-nums">{r.score}%</TableCell>
                        <TableCell className="text-right text-sm tabular-nums font-semibold">{((r.score * r.weight) / 100).toFixed(1)}</TableCell>
                      </TableRow>
                    ))}
                    <TableRow className="bg-blue-50/60 font-bold">
                      <TableCell colSpan={3} className="text-sm text-blue-700">TOTAL PERFORMANCE SCORE</TableCell>
                      <TableCell className="text-right text-sm text-red-600 tabular-nums">{totalScore} / 100</TableCell>
                    </TableRow>
                  </TableBody>
                </Table>
              </div>
            </div>
            <div className="rounded-xl border border-border bg-gradient-to-br from-slate-50 to-white p-4">
              <h4 className="text-xs font-bold text-muted-foreground uppercase tracking-wide mb-2 text-center flex items-center justify-center gap-1.5">
                <Gauge className="h-3.5 w-3.5" /> Performance Gauge
              </h4>
              <PerformanceGauge score={totalScore} />
            </div>
            <div>
              <h4 className="text-xs font-bold text-muted-foreground uppercase tracking-wide mb-2">Performance Status Guide</h4>
              <div className="rounded-xl border border-border overflow-hidden">
                <Table>
                  <TableHeader className="bg-muted">
                    <TableRow>
                      <TableHead className="text-xs">Score Range</TableHead>
                      <TableHead className="text-xs">Status</TableHead>
                      <TableHead className="text-xs">Description</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {statusGuide.map((s, i) => (
                      <TableRow key={i} className="hover:bg-slate-50/60">
                        <TableCell className="text-sm tabular-nums">{s.range}</TableCell>
                        <TableCell className={cn('text-sm font-bold', s.color)}>{s.status}</TableCell>
                        <TableCell className="text-xs text-muted-foreground">{s.desc}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>
          </div>
        </SectionCard>

        {/* ===== SECTION 6: YOUR FIELD ACTIVITY (real actions, last 30 days) ===== */}
        {computed && (
          <SectionCard
            index={6}
            title="Your field activity (last 30 days)"
            right={<span className="text-xs text-muted-foreground hidden sm:inline">Visits, deposits & commissions you actually recorded</span>}
          >
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
              <MiniMetric label="Visits today" value={String(computed.visitsToday)} tone="blue" />
              <MiniMetric label="Visits this week" value={String(computed.visitsWeek)} tone="blue" />
              <MiniMetric label="Deposits taken (30d)" value={String(computed.collections30d)} tone="green" />
              <MiniMetric label="My commission (30d)" value={fmtUGX(computed.earnings30d)} tone="amber" />
            </div>
            <div className="rounded-xl border border-border overflow-hidden">
              <Table>
                <TableHeader className="bg-muted">
                  <TableRow>
                    <TableHead className="text-xs">When</TableHead>
                    <TableHead className="text-xs">What</TableHead>
                    <TableHead className="text-xs">Tenant / Detail</TableHead>
                    <TableHead className="text-xs">Location / Amount</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {computed.activityFeed.length === 0 && (
                    <TableRow><TableCell colSpan={4} className="text-center text-sm text-muted-foreground py-6">No visits or deposits recorded in the last 30 days. Start a field visit to build your trust score.</TableCell></TableRow>
                  )}
                  {computed.activityFeed.map((a, i) => (
                    <TableRow key={i} className="hover:bg-slate-50/60">
                      <TableCell className="text-xs text-muted-foreground whitespace-nowrap">{format(new Date(a.when), 'MMM d, HH:mm')}</TableCell>
                      <TableCell>
                        <span className={cn('inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold border',
                          a.kind === 'Visit' ? 'bg-blue-50 text-blue-700 border-blue-200' : 'bg-emerald-50 text-emerald-700 border-emerald-200')}>
                          {a.kind}
                        </span>
                      </TableCell>
                      <TableCell className="text-sm font-medium">{a.label}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">{a.meta || '—'}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </SectionCard>
        )}

        {computed && (
          <div className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 flex items-start gap-3">
            <AlertCircle className="h-5 w-5 text-amber-600 shrink-0 mt-0.5" />
            <p className="text-sm text-amber-900">
              <span className="font-bold">Insight:</span>{' '}
              {totalScore >= 70
                ? `${displayName} is performing well — keep momentum on collections.`
                : `${displayName} needs attention — collection efficiency is ${computed.weeklyEfficiency.toFixed(0)}% with ${fmtUGX(totalDebt)} outstanding.`}
            </p>
          </div>
        )}

        <footer className="flex items-center justify-between text-[11px] text-muted-foreground pt-2 pb-6">
          <span>Generated by Welile</span>
          <span>Page 1 of 1</span>
        </footer>
      </main>
    </div>
  );
}

// ============= AGENT PICKER (fallback when no ?id) =============
function AgentPicker({ onPick, onBack }: { onPick: (id: string) => void; onBack: () => void }) {
  const [search, setSearch] = useState('');

  const { data: agents, isLoading } = useQuery({
    queryKey: ['agent-picker-list'],
    queryFn: async () => {
      // Get user_ids of agents from user_roles
      const { data: roles } = await supabase
        .from('user_roles')
        .select('user_id')
        .eq('role', 'agent')
        .limit(2000);
      const ids = [...new Set((roles || []).map((r) => r.user_id))];
      if (!ids.length) return [];
      const profiles: any[] = [];
      for (let i = 0; i < ids.length; i += 500) {
        const slice = ids.slice(i, i + 500);
        const { data } = await supabase
          .from('profiles')
          .select('id, full_name, phone, city')
          .in('id', slice);
        if (data) profiles.push(...data);
      }
      return profiles.sort((a, b) => (a.full_name || '').localeCompare(b.full_name || ''));
    },
    staleTime: 300_000,
  });

  const filtered = (agents || []).filter((a) => {
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return (
      (a.full_name || '').toLowerCase().includes(q) ||
      (a.phone || '').toLowerCase().includes(q) ||
      (a.city || '').toLowerCase().includes(q)
    );
  });

  return (
    <div className="min-h-screen bg-slate-50/60 p-4 sm:p-6">
      <div className="max-w-3xl mx-auto">
        <div className="flex items-center gap-3 mb-4">
          <Button variant="ghost" size="icon" onClick={onBack}>
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div>
            <h1 className="text-xl font-bold text-foreground">Select an Agent</h1>
            <p className="text-sm text-muted-foreground">Pick an agent to view their performance report.</p>
          </div>
        </div>

        <div className="rounded-2xl border border-border bg-card shadow-sm overflow-hidden">
          <div className="p-3 border-b border-border bg-slate-50/60">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search by name, phone, or city…"
                className="pl-9"
                autoFocus
              />
            </div>
          </div>
          <div className="max-h-[70vh] overflow-y-auto">
            {isLoading ? (
              <div className="p-4 space-y-2">
                {Array.from({ length: 6 }).map((_, i) => (
                  <Skeleton key={i} className="h-14 w-full rounded-lg" />
                ))}
              </div>
            ) : filtered.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-10">No agents found.</p>
            ) : (
              <ul className="divide-y divide-border">
                {filtered.map((a) => (
                  <li key={a.id}>
                    <button
                      type="button"
                      onClick={() => onPick(a.id)}
                      className="w-full text-left px-4 py-3 flex items-center gap-3 hover:bg-blue-50/60 transition-colors"
                    >
                      <div className="h-10 w-10 rounded-full bg-gradient-to-br from-blue-500 to-blue-700 text-white flex items-center justify-center font-bold text-sm shrink-0">
                        {(a.full_name || '?').split(' ').map((n: string) => n[0]).slice(0, 2).join('')}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-semibold text-foreground truncate">{a.full_name || 'Unnamed'}</p>
                        <p className="text-xs text-muted-foreground truncate">{a.phone || '—'} {a.city ? `· ${a.city}` : ''}</p>
                      </div>
                      <span className="text-xs text-blue-600 font-semibold shrink-0">Open →</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="px-4 py-2 border-t border-border text-[11px] text-muted-foreground">
            {filtered.length} agent{filtered.length === 1 ? '' : 's'}
          </div>
        </div>
      </div>
    </div>
  );
}
