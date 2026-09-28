import { Area, AreaChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { RefreshCw, FileText, CheckCircle2, Clock, Wallet } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import type { ProxyPerformanceDashboard, ProxyRange } from '@/hooks/useProxyPerformanceDashboard';
import { ProxyHowItWorksDialog } from './ProxyHowItWorksDialog';

export const ugx = (n: number) => `UGX ${Math.round(Number(n) || 0).toLocaleString('en-US')}`;
export const ugxShort = (n: number) => {
  const v = Number(n) || 0;
  if (Math.abs(v) >= 1_000_000_000) return `UGX ${(v / 1e9).toFixed(1)}B`;
  if (Math.abs(v) >= 1_000_000) return `UGX ${(v / 1e6).toFixed(1)}M`;
  if (Math.abs(v) >= 10_000) return `UGX ${(v / 1e3).toFixed(0)}K`;
  return ugx(v);
};

export function SectionError({ label, onRetry }: { label: string; onRetry: () => void }) {
  return (
    <Card className="flex items-center justify-between gap-3 p-4">
      <p className="text-sm text-muted-foreground">Could not load {label}.</p>
      <Button size="sm" variant="outline" onClick={onRetry}><RefreshCw className="mr-1 h-3.5 w-3.5" />Retry</Button>
    </Card>
  );
}

export function ProxyDashboardHeader({ name, today, commission }: {
  name: string; today?: string; commission?: ProxyPerformanceDashboard['commission'];
}) {
  const h = new Date().getHours();
  const greet = h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
  const d = today ? new Date(`${today}T00:00:00`) : new Date();
  return (
    <div className="flex flex-wrap items-end justify-between gap-2">
      <div className="min-w-0">
        <h1 className="truncate text-xl font-bold tracking-tight md:text-2xl">{greet}, {name}</h1>
        <p className="text-xs text-muted-foreground md:text-sm">Supporting more tenants starts with the Promissory Notes you create and follow up.</p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Badge variant="secondary" className="shrink-0">Today · {d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</Badge>
        <ProxyHowItWorksDialog
          noteRate={commission?.note_rate}
          initialSupportPct={commission?.initial_support_pct}
          topUpPct={commission?.top_up_pct}
        />
      </div>
    </div>
  );
}

function Kpi({ label, value, sub, icon: Icon, tone }: { label: string; value: string; sub?: string; icon: typeof FileText; tone?: string }) {
  return (
    <Card className="p-3 md:p-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground md:text-xs">{label}</p>
        <Icon className={cn('h-4 w-4 text-muted-foreground', tone)} />
      </div>
      <p className="mt-1 text-2xl font-bold tabular-nums md:text-3xl">{value}</p>
      {sub && <p className="text-xs text-muted-foreground">{sub}</p>}
    </Card>
  );
}

export function ProxyKpiGrid({ d }: { d: ProxyPerformanceDashboard }) {
  const n = d.notes;
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <Kpi label="Notes Created" value={n.created.toLocaleString()} sub={`+${n.created_today} today`} icon={FileText} />
      <Kpi label="Brought In" value={n.brought_in.toLocaleString()} sub={n.brought_in_today ? `${n.brought_in_today} today` : ugxShort(n.brought_in_amount)} icon={CheckCircle2} tone="text-primary" />
      <Kpi label="Pending" value={n.pending.toLocaleString()} sub={n.other ? `${n.other} closed/other` : `${ugxShort(n.pending_amount)} promised`} icon={Clock} />
      <ProxyCommissionCard d={d} />
    </div>
  );
}

export function ProxyCommissionCard({ d }: { d: ProxyPerformanceDashboard }) {
  const c = d.commission;
  return (
    <Card className="p-3 md:p-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground md:text-xs">Earned Commission</p>
        <Wallet className="h-4 w-4 text-primary" />
      </div>
      <p className="mt-1 text-xl font-bold tabular-nums md:text-2xl">{ugxShort(c.earned)}</p>
    </Card>
  );
}

const Row = ({ k, v, muted }: { k: string; v: string; muted?: boolean }) => (
  <div className={cn('flex justify-between gap-2', muted && 'text-muted-foreground')}><dt className="min-w-0">{k}</dt><dd className="shrink-0 tabular-nums font-medium">{v}</dd></div>
);

export function ProxyDailyPerformance({ d }: { d: ProxyPerformanceDashboard }) {
  const items = [
    ['Notes created', d.notes.created_today.toLocaleString()],
    ['Brought in', d.notes.brought_in_today.toLocaleString()],
    ['Amount brought in', ugxShort(d.notes.brought_in_amount_today)],
    ['Commission earned', ugx(d.commission.today)],
  ];
  return (
    <Card className="p-4">
      <p className="text-sm font-semibold">Today's Performance</p>
      <div className="mt-3 grid grid-cols-2 gap-3">
        {items.map(([k, v]) => (
          <div key={k}><p className="text-xs text-muted-foreground">{k}</p><p className="text-lg font-bold tabular-nums">{v}</p></div>
        ))}
      </div>
    </Card>
  );
}

function targetStatus(done: number, target: number, expectedFraction: number) {
  if (target <= 0) return { label: 'No target', variant: 'secondary' as const };
  if (done > target) return { label: 'Target exceeded', variant: 'default' as const };
  if (done === target) return { label: 'Target reached', variant: 'default' as const };
  return done / target >= expectedFraction ? { label: 'On track', variant: 'secondary' as const } : { label: 'Behind target', variant: 'destructive' as const };
}

export function ProxyTargetCard({ title, done, target, unit, remainingText, expectedFraction }: {
  title: string; done: number; target: number; unit: string; remainingText?: string; expectedFraction: number;
}) {
  const pct = target > 0 ? Math.min(100, Math.round((done / target) * 100)) : 0;
  const left = Math.max(0, target - done);
  const st = targetStatus(done, target, expectedFraction);
  return (
    <Card className="p-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-semibold">{title}</p>
        <Badge variant={st.variant}>{st.label}</Badge>
      </div>
      <p className="mt-2 text-2xl font-bold tabular-nums">{done} <span className="text-base font-medium text-muted-foreground">/ {target} {unit}</span></p>
      <Progress value={pct} className="mt-2 h-2" />
      <div className="mt-2 flex justify-between gap-2 text-xs text-muted-foreground">
        <span>{pct}% complete{left > 0 ? ` · ${left} more to go` : ''}</span>
        {remainingText && <span className="shrink-0">{remainingText}</span>}
      </div>
    </Card>
  );
}

export function ProxyPerformanceChart({ d, range, onRange, fetching }: { d: ProxyPerformanceDashboard; range: ProxyRange; onRange: (r: ProxyRange) => void; fetching: boolean }) {
  const data = d.series.map((s) => ({
    ...s,
    label: new Date(`${s.date}T00:00:00`).toLocaleDateString('en-GB', range === '7d' ? { weekday: 'short' } : { day: 'numeric', month: 'short' }),
  }));
  return (
    <Card className="p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-semibold">Brought In vs Pending</p>
        <Select value={range} onValueChange={(v) => onRange(v as ProxyRange)}>
          <SelectTrigger className="h-8 w-[130px] rounded-lg px-3 text-xs" disabled={fetching} aria-label="Chart period">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="today">Today</SelectItem>
            <SelectItem value="yesterday">Yesterday</SelectItem>
            <SelectItem value="7d">7 Days</SelectItem>
            <SelectItem value="30d">30 Days</SelectItem>
            <SelectItem value="month">This Month</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="h-56 w-full md:h-64">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 4, right: 4, left: -24, bottom: 0 }}>
            <defs>
              <linearGradient id="biGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="hsl(142 71% 45%)" stopOpacity={0.35} />
                <stop offset="100%" stopColor="hsl(142 71% 45%)" stopOpacity={0.02} />
              </linearGradient>
              <linearGradient id="peGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="hsl(0 84% 60%)" stopOpacity={0.30} />
                <stop offset="100%" stopColor="hsl(0 84% 60%)" stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
            <XAxis dataKey="label" tick={{ fontSize: 11 }} interval="preserveStartEnd" minTickGap={12} stroke="hsl(var(--muted-foreground))" />
            <YAxis allowDecimals={false} tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" />
            <Tooltip contentStyle={{ background: 'hsl(var(--popover))', border: '1px solid hsl(var(--border))', borderRadius: 8, fontSize: 12 }} />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Area type="monotone" dataKey="brought_in" name="Brought In" stroke="hsl(142 71% 45%)" strokeWidth={2} fill="url(#biGrad)" dot={{ r: 2.5, fill: 'hsl(142 71% 45%)', strokeWidth: 0 }} activeDot={{ r: 4 }} />
            <Area type="monotone" dataKey="pending" name="Pending" stroke="hsl(0 84% 60%)" strokeWidth={2} fill="url(#peGrad)" dot={{ r: 2.5, fill: 'hsl(0 84% 60%)', strokeWidth: 0 }} activeDot={{ r: 4 }} />
          </AreaChart>
        </ResponsiveContainer>
      </div>
      <p className="mt-1 text-[11px] text-muted-foreground">Brought In by the day money was confirmed; Pending by the day the note was created.</p>
    </Card>
  );
}

export function ProxyNotesSummary({ d }: { d: ProxyPerformanceDashboard }) {
  const n = d.notes;
  return (
    <Card className="p-4">
      <p className="text-sm font-semibold">My Promissory Notes</p>
      <dl className="mt-3 space-y-2 text-sm">
        <Row k="Total created" v={n.created.toLocaleString()} />
        <Row k="Brought in" v={n.brought_in.toLocaleString()} />
        <Row k="Pending" v={n.pending.toLocaleString()} />
        <Row k="Amount brought in" v={ugx(n.brought_in_amount)} />
      </dl>
      <p className="mt-4 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Today</p>
      <dl className="mt-2 space-y-2 text-sm">
        <Row k="Created today" v={n.created_today.toLocaleString()} />
        <Row k="Brought in today" v={n.brought_in_today.toLocaleString()} />
        <Row k="Amount brought in" v={ugx(n.brought_in_amount_today)} />
      </dl>
    </Card>
  );
}

const STATUS: Record<string, { label: string; variant: 'default' | 'secondary' | 'outline' | 'destructive' }> = {
  activated: { label: 'Brought In', variant: 'default' },
  pending: { label: 'Pending', variant: 'secondary' },
};

export function ProxyRecentNotes({ d, onViewAll }: { d: ProxyPerformanceDashboard; onViewAll: () => void }) {
  return (
    <Card className="p-4">
      <div className="mb-2 flex items-center justify-between">
        <p className="text-sm font-semibold">Recent Promissory Notes</p>
        <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={onViewAll}>View All</Button>
      </div>
      {d.recent.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">No Promissory Notes yet — pick a house below to create your first.</p>
      ) : (
        <ul className="divide-y">
          {d.recent.map((r) => {
            const st = STATUS[r.status] ?? { label: r.status.replace(/_/g, ' '), variant: 'outline' as const };
            return (
              <li key={r.id} className="flex items-center justify-between gap-3 py-2.5">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{r.partner_name || 'Unnamed partner'}</p>
                  <p className="text-xs text-muted-foreground">
                    {new Date(r.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
                    {r.house_count > 0 ? ` · ${r.house_count} house${r.house_count === 1 ? '' : 's'}` : ''}
                    {r.commission > 0 ? ` · +${ugx(r.commission)}` : ''}
                  </p>
                </div>
                <div className="shrink-0 text-right">
                  <p className="text-sm font-semibold tabular-nums">{ugxShort(r.amount)}</p>
                  <Badge variant={st.variant} className="mt-0.5 text-[10px] capitalize">{st.label}</Badge>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

export function ProxyDashboardSkeleton() {
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-[92px] rounded-lg" />)}</div>
      <div className="grid gap-3 md:grid-cols-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-[130px] rounded-lg" />)}</div>
      <div className="grid gap-3 lg:grid-cols-3"><Skeleton className="h-72 rounded-lg lg:col-span-2" /><Skeleton className="h-72 rounded-lg" /></div>
    </div>
  );
}
