import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { formatUGX } from '@/lib/rentCalculations';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { RefreshCw, CreditCard } from 'lucide-react';
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  PieChart,
  Pie,
  Legend,
} from 'recharts';

// Chart palette — mirrors the daily email report colours.
const C = {
  purple: 'hsl(var(--primary))',
  green: '#16a34a',
  amber: '#d97706',
  red: '#dc2626',
  blue: '#2563eb',
};

// ---- EAT (UTC+3, no DST) date helpers, mirroring the edge function ----
function eatToday(): string {
  return new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
function eatDayBounds(dateStr: string): { startISO: string; endISO: string } {
  const [y, m, d] = dateStr.split('-').map(Number);
  const startEAT = Date.UTC(y, m - 1, d, 0, 0, 0) - 3 * 60 * 60 * 1000;
  const endEAT = startEAT + 24 * 60 * 60 * 1000;
  return {
    startISO: new Date(startEAT).toISOString(),
    endISO: new Date(endEAT).toISOString(),
  };
}
function eatDateOf(iso: string): string {
  return new Date(new Date(iso).getTime() + 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
function prettyEatDate(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

function isApproved(status: string, cfoPaidAt: unknown): boolean {
  const s = String(status || '').toLowerCase();
  return (
    !!cfoPaidAt ||
    s.includes('approved') ||
    s === 'disbursed' ||
    s === 'active' ||
    s === 'repaying'
  );
}
const isRejected = (s: string) => String(s || '').toLowerCase().includes('reject');
const isPending = (s: string) => String(s || '').toLowerCase() === 'pending';

function reasonBucket(raw: string): string {
  const r = String(raw || '').trim().toLowerCase();
  if (!r) return 'No reason given';
  if (r.includes('test')) return 'Feature under test';
  if (r.includes('agent ops')) return 'Rejected at agent ops stage';
  if (r.includes('tenant')) return 'Rejected at tenant ops stage';
  if (r.includes('landlord')) return 'Rejected at landlord ops stage';
  if (r.includes('duplicate')) return 'Duplicate request';
  if (r.includes('eligib') || r.includes('limit')) return 'Not eligible / over limit';
  if (r.includes('document') || r.includes('kyc') || r.includes('id')) return 'Documents / KYC';
  if (r.includes('outstanding') || r.includes('overdue') || r.includes('debt')) return 'Existing debt / overdue';
  return raw.trim().slice(0, 40);
}

const pct = (n: number) => `${(Math.round((Number(n) || 0) * 10) / 10).toLocaleString('en-US')}%`;

interface AdvanceReport {
  date: string;
  totalAgents: number;
  agentsWithAdvances: number;
  agentsWithActiveAdvances: number;
  adoption: number;
  payingBackCount: number;
  unpaidCount: number;
  totalArrears: number;
  requestsTotal: number;
  requestsToday: number;
  approvedTotal: number;
  approvedToday: number;
  rejectedTotal: number;
  rejectedToday: number;
  pendingTotal: number;
  reasonsToday: { label: string; count: number }[];
  reasonsAllTime: { label: string; count: number }[];
  monthTrend: { day: string; full: string; count: number }[];
  activeCount: number;
  activeOutstanding: number;
  overdueCount: number;
  overdueOutstanding: number;
  completedCount: number;
  totalPrincipalIssued: number;
  totalRepaid: number;
  repaidToday: number;
  repaidThisMonth: number;
  repaymentRate: number;
  topOverdue: { name: string; phone: string; outstanding: number }[];
}

async function buildReport(): Promise<AdvanceReport> {
  const date = eatToday();
  const { startISO, endISO } = eatDayBounds(date);
  const monthStartISO = new Date(
    Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, 1) - 3 * 60 * 60 * 1000,
  ).toISOString();
  const monthStartDate = `${date.slice(0, 7)}-01`;

  const [reqRes, advRes, ledgerRes, qualifyingRes, monitorRes] = await Promise.all([
    supabase
      .from('agent_advance_requests')
      .select('id, agent_id, principal, status, rejection_reason, cfo_paid_at, created_at')
      .limit(20000),
    supabase
      .from('agent_advances')
      .select('id, agent_id, principal, outstanding_balance, status, issued_at')
      .limit(20000),
    supabase.from('agent_advance_ledger').select('advance_id, amount_deducted, date').limit(50000),
    supabase.rpc('agent_ops_qualifying_agent_ids'),
    // Same RPC the Agent Ops "Advance Repayment Monitor" card calls.
    // Using it as the single source of truth so the CEO card, the Agent Ops
    // Monitor and the daily email report all show identical numbers.
    supabase.rpc('get_agent_advance_repayment_monitor', { _days: 7 } as any),
  ]);

  const requests = (reqRes.data ?? []) as any[];
  const advances = (advRes.data ?? []) as any[];
  const ledger = (ledgerRes.data ?? []) as any[];
  const monitor = ((monitorRes as any)?.data ?? []) as any[];
  const totalAgents = new Set(
    ((qualifyingRes.data ?? []) as Array<{ agent_id: string }>).map((r) => r.agent_id).filter(Boolean),
  ).size;

  const inDay = (iso: string) => iso >= startISO && iso < endISO;
  const todays = requests.filter((r) => inDay(r.created_at));

  const requestsTotal = requests.length;
  const requestsToday = todays.length;
  const approvedTotal = requests.filter((r) => isApproved(r.status, r.cfo_paid_at)).length;
  const approvedToday = todays.filter((r) => isApproved(r.status, r.cfo_paid_at)).length;
  const rejectedTotal = requests.filter((r) => isRejected(r.status)).length;
  const rejectedToday = todays.filter((r) => isRejected(r.status)).length;
  const pendingTotal = requests.filter((r) => isPending(r.status)).length;

  const tallyReasons = (rows: any[]) => {
    const m: Record<string, number> = {};
    for (const r of rows) {
      if (!isRejected(r.status)) continue;
      const label = reasonBucket(r.rejection_reason);
      m[label] = (m[label] || 0) + 1;
    }
    return Object.entries(m)
      .sort(([, a], [, b]) => b - a)
      .map(([label, count]) => ({ label, count }));
  };
  const reasonsToday = tallyReasons(todays);
  const reasonsAllTime = tallyReasons(requests).slice(0, 8);

  // Month trend (new requests per EAT day this month)
  const monthMap: Record<string, number> = {};
  for (const r of requests) {
    if (r.created_at < monthStartISO || r.created_at >= endISO) continue;
    const d = eatDateOf(r.created_at);
    monthMap[d] = (monthMap[d] || 0) + 1;
  }
  const todayDayNum = Number(date.slice(8, 10));
  const daysInMonth = new Date(Number(date.slice(0, 4)), Number(date.slice(5, 7)), 0).getDate();
  const monthTrend: { day: string; full: string; count: number }[] = [];
  for (let d = 1; d <= Math.min(daysInMonth, todayDayNum); d++) {
    const full = `${date.slice(0, 7)}-${String(d).padStart(2, '0')}`;
    monthTrend.push({ day: String(d), full, count: monthMap[full] || 0 });
  }

  const agentsWithAdvances = new Set(advances.map((a) => a.agent_id).filter(Boolean)).size;
  const completed = advances.filter((a) => String(a.status) === 'completed');
  const totalPrincipalIssued = advances.reduce((s, a) => s + Number(a.principal || 0), 0);

  // ---- Repayment KPIs sourced from the Agent Ops Monitor RPC ----
  // Mirrors AgentAdvanceRepaymentMonitor.stats exactly so CEO + Agent Ops
  // dashboards and the daily email report always agree.
  const num = (v: any) => Number(v ?? 0);
  const paidRows = monitor.filter((r) => r.paid_today);
  const unpaidRows = monitor.filter((r) => !r.paid_today);
  const overdueRows = monitor.filter((r) => r.is_overdue);
  const nonOverdueRows = monitor.filter((r) => !r.is_overdue);
  const agentsWithActiveAdvances = new Set(
    monitor.map((r) => r.agent_id).filter(Boolean),
  ).size;
  const activeCount = nonOverdueRows.length;
  const overdueCount = overdueRows.length;
  const activeOutstanding = nonOverdueRows.reduce((s, r) => s + num(r.outstanding_balance), 0);
  const overdueOutstanding = overdueRows.reduce((s, r) => s + num(r.outstanding_balance), 0);
  const totalArrears = monitor.reduce((s, r) => s + num(r.arrears_balance), 0);
  const payingBackCount = paidRows.length;
  const unpaidCount = unpaidRows.length;
  const repaymentRate = monitor.length ? (payingBackCount / monitor.length) * 100 : 0;

  const totalRepaid = ledger.reduce((s, l) => s + Number(l.amount_deducted || 0), 0);
  // Match monitor's collectedToday (sum of paid.repaid_today) instead of raw
  // ledger sum so the "Repaid today" figure stays in lock-step.
  const repaidToday = paidRows.reduce((s, r) => s + num(r.repaid_today), 0);
  const repaidThisMonth = ledger
    .filter((l) => l.date >= monthStartDate && l.date <= date)
    .reduce((s, l) => s + Number(l.amount_deducted || 0), 0);

  // Top overdue — read straight from the monitor so names/phones match the
  // Agent Ops "Not repaid today" list without needing a profiles lookup.
  const overdueSorted = [...overdueRows]
    .sort((a, b) => num(b.outstanding_balance) - num(a.outstanding_balance))
    .slice(0, 8);
  const topOverdue = overdueSorted.map((r) => ({
    name: (r.full_name || '').trim() || 'Unknown agent',
    phone: r.phone || '—',
    outstanding: Math.round(num(r.outstanding_balance)),
  }));

  return {
    date,
    totalAgents,
    agentsWithAdvances,
    agentsWithActiveAdvances,
    adoption: totalAgents ? (agentsWithActiveAdvances / totalAgents) * 100 : 0,
    payingBackCount,
    unpaidCount,
    totalArrears,
    requestsTotal,
    requestsToday,
    approvedTotal,
    approvedToday,
    rejectedTotal,
    rejectedToday,
    pendingTotal,
    reasonsToday,
    reasonsAllTime,
    monthTrend,
    activeCount,
    activeOutstanding,
    overdueCount,
    overdueOutstanding,
    completedCount: completed.length,
    totalPrincipalIssued,
    totalRepaid,
    repaidToday,
    repaidThisMonth,
    repaymentRate,
    topOverdue,
  };
}

function Kpi({
  label,
  value,
  sub,
  color,
}: {
  label: string;
  value: string;
  sub?: string;
  color?: string;
}) {
  return (
    <div className="rounded-lg bg-muted/50 p-3 text-center">
      <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-1 text-lg font-bold leading-tight" style={color ? { color } : undefined}>
        {value}
      </div>
      {sub && <div className="mt-0.5 text-[10px] text-muted-foreground">{sub}</div>}
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h3 className="mb-2 mt-1 text-sm font-semibold text-foreground">{children}</h3>;
}

export function AgentAdvancesDailyReportCard() {
  const [refreshing, setRefreshing] = useState(false);
  const { data: r, isLoading, refetch } = useQuery({
    queryKey: ['agent-advances-daily-report'],
    queryFn: buildReport,
    staleTime: 300000,
  });

  const handleRefresh = async () => {
    setRefreshing(true);
    await refetch();
    setRefreshing(false);
  };

  const outcomeData = useMemo(
    () =>
      r
        ? [
            { name: 'Approved', value: r.approvedTotal, color: C.green },
            { name: 'Rejected', value: r.rejectedTotal, color: C.red },
            { name: 'Pending', value: r.pendingTotal, color: C.amber },
          ].filter((d) => d.value > 0)
        : [],
    [r],
  );
  const portfolioData = useMemo(
    () =>
      r
        ? [
            { name: 'Active (paying)', value: r.activeCount, color: C.blue },
            { name: 'Overdue', value: r.overdueCount, color: C.red },
            { name: 'Completed', value: r.completedCount, color: C.green },
          ].filter((d) => d.value > 0)
        : [],
    [r],
  );

  return (
    <Card className="w-full border-primary/20">
      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-3">
        <div className="flex items-center gap-2">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <CreditCard className="h-5 w-5" />
          </div>
          <div>
            <CardTitle className="text-base">Agent Advances — Daily Report</CardTitle>
            <p className="text-xs text-muted-foreground">
              Live mirror of the 18:00 EAT email · {r ? prettyEatDate(r.date) : '—'}
            </p>
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={handleRefresh} disabled={refreshing || isLoading}>
          <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
      </CardHeader>

      <CardContent className="space-y-6">
        {isLoading || !r ? (
          <div className="py-10 text-center text-sm text-muted-foreground">Loading advance metrics…</div>
        ) : (
          <>
            {/* Agent base & adoption */}
            <div>
              <SectionTitle>Agent base &amp; adoption</SectionTitle>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <Kpi label="Qualifying agents" value={r.totalAgents.toLocaleString('en-US')} sub="Meet agent criteria" />
                <Kpi label="Active advances" value={String(r.agentsWithActiveAdvances)} color={C.purple} sub={`${r.agentsWithAdvances} ever`} />
                <Kpi
                  label="Advance adoption"
                  value={pct(r.adoption)}
                  color={r.adoption < 1 ? C.red : C.green}
                  sub={`${r.agentsWithActiveAdvances}/${r.totalAgents.toLocaleString('en-US')} qualifying agents`}
                />
                <Kpi
                  label="Paid today"
                  value={String(r.payingBackCount)}
                  color={C.green}
                  sub={`${r.unpaidCount} not paid · ${pct(r.repaymentRate)}`}
                />
              </div>
            </div>

            {/* Requests today vs system */}
            <div>
              <SectionTitle>Requests — today vs. system</SectionTitle>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <Kpi label="New requests" value={String(r.requestsToday)} color={C.purple} sub={`${r.requestsTotal} all-time`} />
                <Kpi label="Approved" value={String(r.approvedToday)} color={C.green} sub={`${r.approvedTotal} all-time`} />
                <Kpi label="Rejected" value={String(r.rejectedToday)} color={C.red} sub={`${r.rejectedTotal} all-time`} />
                <Kpi label="Pending" value={String(r.pendingTotal)} color={C.amber} sub="awaiting review" />
              </div>
            </div>

            {/* Month trend */}
            <div>
              <SectionTitle>New advance requests this month (EAT)</SectionTitle>
              <ResponsiveContainer width="100%" height={240}>
                <BarChart data={r.monthTrend} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                  <XAxis dataKey="day" tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" />
                  <YAxis allowDecimals={false} tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" />
                  <Tooltip
                    contentStyle={{
                      background: 'hsl(var(--popover))',
                      border: '1px solid hsl(var(--border))',
                      borderRadius: 8,
                      fontSize: 12,
                    }}
                    labelFormatter={(l) => `Day ${l}`}
                    formatter={(v: number) => [v, 'Requests']}
                  />
                  <Bar dataKey="count" radius={[4, 4, 0, 0]}>
                    {r.monthTrend.map((d) => (
                      <Cell key={d.full} fill={d.full === r.date ? C.green : C.purple} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>

            {/* Outcome + portfolio doughnuts */}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <SectionTitle>All requests by outcome</SectionTitle>
                <ResponsiveContainer width="100%" height={220}>
                  <PieChart>
                    <Pie data={outcomeData} dataKey="value" nameKey="name" innerRadius={45} outerRadius={75} paddingAngle={2}>
                      {outcomeData.map((d) => (
                        <Cell key={d.name} fill={d.color} />
                      ))}
                    </Pie>
                    <Tooltip
                      contentStyle={{
                        background: 'hsl(var(--popover))',
                        border: '1px solid hsl(var(--border))',
                        borderRadius: 8,
                        fontSize: 12,
                      }}
                    />
                    <Legend wrapperStyle={{ fontSize: 12 }} />
                  </PieChart>
                </ResponsiveContainer>
              </div>
              <div>
                <SectionTitle>Advance book status</SectionTitle>
                <ResponsiveContainer width="100%" height={220}>
                  <PieChart>
                    <Pie data={portfolioData} dataKey="value" nameKey="name" innerRadius={45} outerRadius={75} paddingAngle={2}>
                      {portfolioData.map((d) => (
                        <Cell key={d.name} fill={d.color} />
                      ))}
                    </Pie>
                    <Tooltip
                      contentStyle={{
                        background: 'hsl(var(--popover))',
                        border: '1px solid hsl(var(--border))',
                        borderRadius: 8,
                        fontSize: 12,
                      }}
                    />
                    <Legend wrapperStyle={{ fontSize: 12 }} />
                  </PieChart>
                </ResponsiveContainer>
              </div>
            </div>

            {/* Repayment health */}
            <div>
              <SectionTitle>Repayment health</SectionTitle>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <Kpi label="Repayment rate" value={pct(r.repaymentRate)} color={r.repaymentRate >= 70 ? C.green : C.amber} />
                <Kpi label="Repaid today" value={formatUGX(r.repaidToday)} color={C.green} />
                <Kpi label="Repaid this month" value={formatUGX(r.repaidThisMonth)} color={C.green} />
                <Kpi label="Repaid all-time" value={formatUGX(r.totalRepaid)} />
                <Kpi label="Active advances" value={String(r.activeCount)} color={C.blue} sub={formatUGX(r.activeOutstanding)} />
                <Kpi label="Overdue advances" value={String(r.overdueCount)} color={C.red} sub={formatUGX(r.overdueOutstanding)} />
                <Kpi label="Total arrears" value={formatUGX(r.totalArrears)} color={r.totalArrears > 0 ? C.amber : C.green} sub="Missed daily deductions" />
                <Kpi label="Completed" value={String(r.completedCount)} color={C.green} sub={`${formatUGX(r.totalPrincipalIssued)} principal issued`} />
              </div>
            </div>

            {/* Rejection reasons all-time */}
            {r.reasonsAllTime.length > 0 && (
              <div>
                <SectionTitle>Rejection reasons (all-time)</SectionTitle>
                <ResponsiveContainer width="100%" height={Math.max(160, r.reasonsAllTime.length * 34)}>
                  <BarChart
                    layout="vertical"
                    data={r.reasonsAllTime}
                    margin={{ top: 4, right: 16, left: 8, bottom: 4 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" horizontal={false} />
                    <XAxis type="number" allowDecimals={false} tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" />
                    <YAxis
                      type="category"
                      dataKey="label"
                      width={150}
                      tick={{ fontSize: 11 }}
                      stroke="hsl(var(--muted-foreground))"
                    />
                    <Tooltip
                      contentStyle={{
                        background: 'hsl(var(--popover))',
                        border: '1px solid hsl(var(--border))',
                        borderRadius: 8,
                        fontSize: 12,
                      }}
                      formatter={(v: number) => [v, 'Rejections']}
                    />
                    <Bar dataKey="count" fill={C.red} radius={[0, 4, 4, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}

            {/* Two tables */}
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <div>
                <SectionTitle>Today's rejection reasons</SectionTitle>
                <div className="overflow-hidden rounded-lg border border-border">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="bg-muted/60 text-left text-xs text-muted-foreground">
                        <th className="px-3 py-2 font-medium">Reason</th>
                        <th className="px-3 py-2 text-right font-medium">Count</th>
                      </tr>
                    </thead>
                    <tbody>
                      {r.reasonsToday.length ? (
                        r.reasonsToday.map((x, i) => (
                          <tr key={x.label} className={i % 2 ? 'bg-muted/20' : ''}>
                            <td className="px-3 py-2">{x.label}</td>
                            <td className="px-3 py-2 text-right font-semibold">{x.count}</td>
                          </tr>
                        ))
                      ) : (
                        <tr>
                          <td colSpan={2} className="px-3 py-4 text-center text-muted-foreground">
                            No rejections today.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>

              <div>
                <SectionTitle>Overdue advances — recovery focus</SectionTitle>
                <div className="overflow-hidden rounded-lg border border-border">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="bg-muted/60 text-left text-xs text-muted-foreground">
                        <th className="px-3 py-2 font-medium">Agent</th>
                        <th className="px-3 py-2 font-medium">Phone</th>
                        <th className="px-3 py-2 text-right font-medium">Outstanding</th>
                      </tr>
                    </thead>
                    <tbody>
                      {r.topOverdue.length ? (
                        r.topOverdue.map((a, i) => (
                          <tr key={`${a.name}-${i}`} className={i % 2 ? 'bg-muted/20' : ''}>
                            <td className="px-3 py-2">{a.name}</td>
                            <td className="px-3 py-2 text-muted-foreground">{a.phone}</td>
                            <td className="px-3 py-2 text-right font-semibold" style={{ color: C.red }}>
                              {formatUGX(a.outstanding)}
                            </td>
                          </tr>
                        ))
                      ) : (
                        <tr>
                          <td colSpan={3} className="px-3 py-4 text-center text-muted-foreground">
                            No overdue advances. 🎉
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}