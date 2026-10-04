import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { KPICard } from '../KPICard';
import { formatUGX } from '@/lib/agentAdvanceCalculations';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  ResponsiveContainer, AreaChart, Area, BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts';
import {
  FilePlus2, CheckCircle2, XCircle, Banknote, Percent, CalendarRange,
  TrendingUp, Loader2, PieChart as PieIcon, BarChart3,
} from 'lucide-react';
import {
  startOfDay, startOfMonth, subDays, subMonths, eachDayOfInterval,
  format, isSameMonth,
} from 'date-fns';

/**
 * Statuses that represent a request that has been approved at (at least) one
 * pipeline stage and has not been rejected.
 */
const APPROVED_STATUSES = [
  'agent_ops_approved',
  'tenant_ops_approved',
  'landlord_ops_approved',
  'coo_approved',
  'cfo_approved',
];

interface AdvanceRow {
  id: string;
  status: string;
  principal: number | null;
  created_at: string;
  updated_at: string | null;
  agent_ops_reviewed_at: string | null;
  tenant_ops_reviewed_at: string | null;
  landlord_ops_reviewed_at: string | null;
  coo_approved_at: string | null;
  cfo_approved_at: string | null;
  cfo_paid_at: string | null;
}

const latestTs = (...values: (string | null)[]): Date | null => {
  const times = values.filter(Boolean).map((v) => new Date(v as string).getTime());
  return times.length ? new Date(Math.max(...times)) : null;
};

const approvedAt = (r: AdvanceRow): Date | null => {
  if (!APPROVED_STATUSES.includes(r.status)) return null;
  return (
    latestTs(r.cfo_approved_at, r.coo_approved_at, r.landlord_ops_reviewed_at, r.tenant_ops_reviewed_at, r.agent_ops_reviewed_at) ??
    (r.updated_at ? new Date(r.updated_at) : null)
  );
};

const rejectedAt = (r: AdvanceRow): Date | null => {
  if (r.status !== 'rejected') return null;
  return (
    latestTs(r.coo_approved_at, r.landlord_ops_reviewed_at, r.tenant_ops_reviewed_at, r.agent_ops_reviewed_at) ??
    (r.updated_at ? new Date(r.updated_at) : null)
  );
};

const disbursedAt = (r: AdvanceRow): Date | null => (r.cfo_paid_at ? new Date(r.cfo_paid_at) : null);

const inRange = (d: Date | null, start: Date, end: Date) =>
  !!d && d.getTime() >= start.getTime() && d.getTime() <= end.getTime();

const STATUS_META: Record<string, { label: string; color: string }> = {
  pending: { label: 'Pending', color: 'hsl(var(--warning))' },
  agent_ops_approved: { label: 'Agent Ops OK', color: 'hsl(var(--primary))' },
  tenant_ops_approved: { label: 'Tenant Ops OK', color: 'hsl(var(--primary) / 0.75)' },
  landlord_ops_approved: { label: 'Landlord Ops OK', color: 'hsl(var(--primary) / 0.55)' },
  coo_approved: { label: 'COO Approved', color: 'hsl(var(--success))' },
  cfo_approved: { label: 'CFO Approved', color: 'hsl(var(--success) / 0.7)' },
  rejected: { label: 'Rejected', color: 'hsl(var(--destructive))' },
};

const tooltipStyle = {
  backgroundColor: 'hsl(var(--card))',
  border: '1px solid hsl(var(--border))',
  borderRadius: '8px',
  fontSize: '12px',
};

export function AdvanceAnalyticsPanel() {
  const { data: rows = [], isLoading } = useQuery({
    queryKey: ['advance-analytics-rows'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('agent_advance_requests_privileged')
        .select('id, status, principal, created_at, updated_at, agent_ops_reviewed_at, tenant_ops_reviewed_at, landlord_ops_reviewed_at, coo_approved_at, cfo_approved_at, cfo_paid_at')
        .order('created_at', { ascending: false })
        .limit(3000);
      if (error) throw error;
      return (data || []) as AdvanceRow[];
    },
    staleTime: 60_000,
  });

  const stats = useMemo(() => {
    const now = new Date();
    const dayStart = startOfDay(now);
    const monthStart = startOfMonth(now);

    const count = (fn: (r: AdvanceRow) => Date | null, start: Date) =>
      rows.filter((r) => inRange(fn(r), start, now)).length;
    const sumPrincipal = (fn: (r: AdvanceRow) => Date | null, start: Date) =>
      rows.filter((r) => inRange(fn(r), start, now)).reduce((s, r) => s + Number(r.principal || 0), 0);

    const createdAt = (r: AdvanceRow) => new Date(r.created_at);

    // Today
    const newToday = count(createdAt, dayStart);
    const approvedToday = count(approvedAt, dayStart);
    const rejectedToday = count(rejectedAt, dayStart);
    const disbursedToday = count(disbursedAt, dayStart);
    const disbursedTodayAmt = sumPrincipal(disbursedAt, dayStart);

    // This month
    const newMonth = count(createdAt, monthStart);
    const approvedMonth = count(approvedAt, monthStart);
    const rejectedMonth = count(rejectedAt, monthStart);
    const disbursedMonth = count(disbursedAt, monthStart);
    const disbursedMonthAmt = sumPrincipal(disbursedAt, monthStart);
    const decidedMonth = approvedMonth + rejectedMonth;
    const approvalRate = decidedMonth > 0 ? Math.round((approvedMonth / decidedMonth) * 100) : 0;
    const rejectionRate = decidedMonth > 0 ? 100 - approvalRate : 0;

    const dayOfMonth = Math.max(1, now.getDate());
    const avgPerDay = Math.round((newMonth / dayOfMonth) * 10) / 10;

    // 30-day trend
    const days = eachDayOfInterval({ start: subDays(dayStart, 29), end: dayStart });
    const trend = days.map((day) => {
      const dStart = startOfDay(day);
      const dEnd = new Date(dStart.getTime() + 86_400_000 - 1);
      return {
        date: format(day, 'd MMM'),
        New: rows.filter((r) => inRange(createdAt(r), dStart, dEnd)).length,
        Approved: rows.filter((r) => inRange(approvedAt(r), dStart, dEnd)).length,
        Rejected: rows.filter((r) => inRange(rejectedAt(r), dStart, dEnd)).length,
      };
    });

    // Status breakdown (current)
    const statusCounts: Record<string, number> = {};
    rows.forEach((r) => { statusCounts[r.status] = (statusCounts[r.status] || 0) + 1; });
    const breakdown = Object.entries(statusCounts)
      .map(([status, value]) => ({
        status,
        name: STATUS_META[status]?.label || status,
        value,
        color: STATUS_META[status]?.color || 'hsl(var(--muted-foreground))',
      }))
      .sort((a, b) => b.value - a.value);

    // Last 6 months breakdown
    const monthly = Array.from({ length: 6 }).map((_, i) => {
      const m = subMonths(monthStart, 5 - i);
      const mStart = startOfMonth(m);
      const mEnd = new Date(startOfMonth(subMonths(m, -1)).getTime() - 1);
      return {
        month: format(m, 'MMM'),
        New: rows.filter((r) => inRange(createdAt(r), mStart, mEnd)).length,
        Approved: rows.filter((r) => inRange(approvedAt(r), mStart, mEnd)).length,
        Rejected: rows.filter((r) => inRange(rejectedAt(r), mStart, mEnd)).length,
        _isThis: isSameMonth(m, now),
      };
    });

    return {
      newToday, approvedToday, rejectedToday, disbursedToday, disbursedTodayAmt,
      newMonth, approvedMonth, rejectedMonth, disbursedMonth, disbursedMonthAmt,
      approvalRate, rejectionRate, avgPerDay, total: rows.length,
      trend, breakdown, monthly,
    };
  }, [rows]);

  if (isLoading) {
    return (
      <div className="flex justify-center py-10">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* ── TODAY ───────────────────────────────── */}
      <div>
        <div className="flex items-center gap-2 mb-2 px-1">
          <TrendingUp className="h-4 w-4 text-primary" />
          <h3 className="text-sm font-bold">Advance Requests · Today</h3>
        </div>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 sm:gap-3">
          <KPICard title="New Requests" value={stats.newToday} icon={FilePlus2} color="bg-primary/10 text-primary" subtitle="Submitted today" />
          <KPICard title="Approved" value={stats.approvedToday} icon={CheckCircle2} color="bg-success/10 text-success" subtitle="Advanced a stage today" />
          <KPICard title="Disbursed" value={stats.disbursedToday} icon={Banknote} color="bg-emerald-500/10 text-emerald-600" subtitle={formatUGX(stats.disbursedTodayAmt)} />
          <KPICard title="Rejected" value={stats.rejectedToday} icon={XCircle} color="bg-destructive/10 text-destructive" subtitle="Declined today" />
        </div>
      </div>

      {/* ── THIS MONTH ──────────────────────────── */}
      <div>
        <div className="flex items-center gap-2 mb-2 px-1">
          <CalendarRange className="h-4 w-4 text-primary" />
          <h3 className="text-sm font-bold">This Month</h3>
        </div>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 sm:gap-3">
          <KPICard title="Requests" value={stats.newMonth} icon={FilePlus2} color="bg-primary/10 text-primary" subtitle={`Avg ${stats.avgPerDay}/day`} />
          <KPICard title="Approved" value={stats.approvedMonth} icon={CheckCircle2} color="bg-success/10 text-success" subtitle={`${stats.approvalRate}% approval rate`} />
          <KPICard title="Rejected" value={stats.rejectedMonth} icon={XCircle} color="bg-destructive/10 text-destructive" subtitle={`${stats.rejectionRate}% rejection rate`} />
          <KPICard title="Disbursed" value={stats.disbursedMonth} icon={Percent} color="bg-emerald-500/10 text-emerald-600" subtitle={formatUGX(stats.disbursedMonthAmt)} />
        </div>
      </div>

      {/* ── DAILY TREND (30d) ───────────────────── */}
      <Card className="border shadow-sm">
        <CardHeader className="pb-2 px-3 sm:px-4">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <TrendingUp className="h-4 w-4 text-primary" />
            Daily Trend · Last 30 Days
          </CardTitle>
        </CardHeader>
        <CardContent className="px-1 sm:px-3 pb-3">
          <div className="h-[240px]">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={stats.trend} margin={{ top: 6, right: 8, left: -18, bottom: 0 }}>
                <defs>
                  <linearGradient id="advNew" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.35} />
                    <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="advAppr" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="hsl(var(--success))" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="hsl(var(--success))" stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="advRej" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="hsl(var(--destructive))" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="hsl(var(--destructive))" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" className="stroke-border/50" />
                <XAxis dataKey="date" tick={{ fontSize: 9 }} className="fill-muted-foreground" interval={4} />
                <YAxis tick={{ fontSize: 10 }} allowDecimals={false} className="fill-muted-foreground" />
                <Tooltip contentStyle={tooltipStyle} />
                <Legend wrapperStyle={{ fontSize: '11px' }} />
                <Area type="monotone" dataKey="New" stroke="hsl(var(--primary))" strokeWidth={2} fill="url(#advNew)" />
                <Area type="monotone" dataKey="Approved" stroke="hsl(var(--success))" strokeWidth={2} fill="url(#advAppr)" />
                <Area type="monotone" dataKey="Rejected" stroke="hsl(var(--destructive))" strokeWidth={2} fill="url(#advRej)" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* ── STATUS BREAKDOWN ──────────────────── */}
        <Card className="border shadow-sm">
          <CardHeader className="pb-2 px-3 sm:px-4">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <PieIcon className="h-4 w-4 text-primary" />
              Status Breakdown · {stats.total} total
            </CardTitle>
          </CardHeader>
          <CardContent className="px-1 sm:px-3 pb-3">
            <div className="h-[240px]">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={stats.breakdown}
                    dataKey="value"
                    nameKey="name"
                    cx="50%"
                    cy="50%"
                    innerRadius={55}
                    outerRadius={85}
                    paddingAngle={2}
                  >
                    {stats.breakdown.map((entry) => (
                      <Cell key={entry.status} fill={entry.color} />
                    ))}
                  </Pie>
                  <Tooltip contentStyle={tooltipStyle} />
                  <Legend wrapperStyle={{ fontSize: '11px' }} />
                </PieChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>

        {/* ── MONTHLY BREAKDOWN ─────────────────── */}
        <Card className="border shadow-sm">
          <CardHeader className="pb-2 px-3 sm:px-4">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <BarChart3 className="h-4 w-4 text-primary" />
              Monthly · Last 6 Months
            </CardTitle>
          </CardHeader>
          <CardContent className="px-1 sm:px-3 pb-3">
            <div className="h-[240px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={stats.monthly} margin={{ top: 6, right: 8, left: -18, bottom: 0 }} barGap={2}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-border/50" />
                  <XAxis dataKey="month" tick={{ fontSize: 10 }} className="fill-muted-foreground" />
                  <YAxis tick={{ fontSize: 10 }} allowDecimals={false} className="fill-muted-foreground" />
                  <Tooltip contentStyle={tooltipStyle} />
                  <Legend wrapperStyle={{ fontSize: '11px' }} />
                  <Bar dataKey="New" fill="hsl(var(--primary))" radius={[3, 3, 0, 0]} />
                  <Bar dataKey="Approved" fill="hsl(var(--success))" radius={[3, 3, 0, 0]} />
                  <Bar dataKey="Rejected" fill="hsl(var(--destructive))" radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

export default AdvanceAnalyticsPanel;