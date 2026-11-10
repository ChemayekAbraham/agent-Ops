import { Suspense } from 'react';
import { lazyNamed } from '@/lib/lazyWithRetry';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { RefreshCw, FileText, CheckCircle2, Clock, Wallet, ChevronRight, LineChart } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import type { ProxyPerformanceDashboard, ProxyRange } from '@/hooks/useProxyPerformanceDashboard';

/** Minimal card: flat, outlined, rounded. No fills. */
const CARD = 'rounded-2xl border border-border/60 bg-card shadow-none';

export const ugx = (n: number) => `UGX ${Math.round(Number(n) || 0).toLocaleString('en-US')}`;
export const ugxShort = (n: number) => {
  const v = Number(n) || 0;
  if (Math.abs(v) >= 1_000_000_000) return `UGX ${(v / 1e9).toFixed(1)}B`;
  if (Math.abs(v) >= 1_000_000) return `UGX ${(v / 1e6).toFixed(1)}M`;
  if (Math.abs(v) >= 10_000) return `UGX ${(v / 1e3).toFixed(0)}K`;
  return ugx(v);
};
export const shortDate = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '—';

/* ---------- Shared status badges (one colour per state, workspace-wide) ---------- */
type Tone = 'success' | 'warning' | 'danger' | 'neutral' | 'primary';
const TONE: Record<Tone, string> = {
  success: 'bg-transparent text-success border-border',
  warning: 'bg-transparent text-warning border-border',
  danger: 'bg-transparent text-destructive border-border',
  neutral: 'bg-transparent text-muted-foreground border-border',
  primary: 'bg-transparent text-primary border-border',
};
export function StatusPill({ tone, children, className }: { tone: Tone; children: React.ReactNode; className?: string }) {
  return <span className={cn('inline-flex shrink-0 items-center rounded-full border px-2.5 py-0.5 text-[11px] font-medium', TONE[tone], className)}>{children}</span>;
}
export function NoteStatusPill({ status }: { status: string }) {
  if (status === 'activated') return <StatusPill tone="success">Brought In</StatusPill>;
  if (status === 'pending') return <StatusPill tone="warning">Pending</StatusPill>;
  if (status === 'expired' || status === 'rejected') return <StatusPill tone="danger">{status === 'expired' ? 'Expired' : 'Rejected'}</StatusPill>;
  return <StatusPill tone="neutral">{status.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())}</StatusPill>;
}

export function SectionError({ label, onRetry }: { label: string; onRetry: () => void }) {
  return (
    <Card className={cn(CARD, 'flex items-center justify-between gap-3 p-4')}>
      <p className="text-sm text-muted-foreground">Could not load {label}.</p>
      <Button size="sm" variant="outline" onClick={onRetry}><RefreshCw className="mr-1 h-3.5 w-3.5" />Retry</Button>
    </Card>
  );
}

export function EmptyState({ icon: Icon, title, action }: { icon: typeof FileText; title: string; action?: React.ReactNode }) {
  return (
    <Card className={cn(CARD, 'flex flex-col items-center gap-2 p-8 text-center')}>
      <Icon className="h-8 w-8 text-muted-foreground" />
      <p className="text-sm text-muted-foreground">{title}</p>
      {action}
    </Card>
  );
}

export function SectionTitle({ title, sub, action }: { title: string; sub?: string; action?: React.ReactNode }) {
  return (
    <div className="flex items-end justify-between gap-2">
      <div className="min-w-0">
        <h1 className="truncate text-2xl font-bold tracking-tight">{title}</h1>
        {sub && <p className="text-sm text-muted-foreground">{sub}</p>}
      </div>
      {action}
    </div>
  );
}

/* ---------- Today (compact, mobile-first) ---------- */
export function ProxyTodayCard({ d }: { d: ProxyPerformanceDashboard }) {
  const items: [string, string, string?][] = [
    ['Notes created', d.notes.created_today.toLocaleString()],
    ['Brought in', d.notes.brought_in_today.toLocaleString()],
    ['Amount', ugxShort(d.notes.brought_in_amount_today)],
    ['Earned', ugx(d.commission.today)],
  ];
  return (
    <Card className={cn(CARD, 'p-4')}>
      <p className="text-sm font-medium text-muted-foreground">Today</p>
      <div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-3">
        {items.map(([k, v, tone]) => (
          <div key={k} className="min-w-0">
            <p className="text-xs text-muted-foreground">{k}</p>
            <p className={cn('truncate text-lg font-bold tabular-nums', tone)}>{v}</p>
          </div>
        ))}
      </div>
    </Card>
  );
}

/* ---------- KPI cards: neutral, one accent ---------- */
function Kpi({ label, value, sub, icon: Icon, surface, iconTone, valueTone, onClick }: {
  label: string; value: string; sub?: React.ReactNode; icon: typeof FileText; surface: string; iconTone: string; valueTone?: string; onClick?: () => void;
}) {
  const Comp = onClick ? 'button' : 'div';
  return (
    <Comp onClick={onClick} className={cn('rounded-2xl border p-4 text-left transition-colors', surface, onClick && 'active:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring')}>
      <div className="flex items-center justify-between gap-2">
        <p className="truncate text-sm font-medium text-muted-foreground">{label}</p>
        <span className={cn('flex h-8 w-8 shrink-0 items-center justify-center rounded-full', iconTone)}><Icon className="h-4 w-4" /></span>
      </div>
      <p className={cn('mt-2 truncate text-2xl font-bold tabular-nums', valueTone)}>{value}</p>
      {sub && <div className="truncate text-xs text-muted-foreground">{sub}</div>}
    </Comp>
  );
}

export function ProxyKpiGrid({ d, onEarnings }: { d: ProxyPerformanceDashboard; onEarnings: () => void }) {
  const n = d.notes;
  return (
    <div className="grid grid-cols-2 gap-2.5">
      <Kpi label="Notes Created" value={n.created.toLocaleString()} sub={`+${n.created_today} today`} icon={FileText}
        surface="bg-card border-border/60" iconTone="bg-muted text-muted-foreground" />
      <Kpi label="Brought In" value={n.brought_in.toLocaleString()} sub={ugxShort(n.brought_in_amount)} icon={CheckCircle2}
        surface="bg-card border-border/60" iconTone="bg-muted text-muted-foreground" />
      <Kpi label="Pending" value={n.pending.toLocaleString()} sub={`${ugxShort(n.pending_amount)} promised`} icon={Clock}
        surface="bg-card border-border/60" iconTone="bg-muted text-muted-foreground" />
      <Kpi label="Earned" value={ugxShort(d.commission.earned)} icon={Wallet} onClick={onEarnings}
        sub={<span className="inline-flex items-center text-primary">View breakdown<ChevronRight className="h-3 w-3" /></span>}
        surface="bg-card border-border/60" iconTone="bg-muted text-muted-foreground" />
    </div>
  );
}

/* ---------- Targets ---------- */
function targetStatus(done: number, target: number, expectedFraction: number): { label: string; tone: Tone } {
  if (target <= 0) return { label: 'No target', tone: 'neutral' };
  if (done > target) return { label: 'Exceeded', tone: 'success' };
  if (done === target) return { label: 'Target reached', tone: 'success' };
  const ratio = done / target;
  if (ratio >= expectedFraction) return { label: 'On track', tone: 'success' };
  return ratio >= expectedFraction * 0.6 ? { label: 'Slightly behind', tone: 'warning' } : { label: 'Behind target', tone: 'danger' };
}

export function ProxyTargetCard({ title, done, target, remainingText, expectedFraction }: {
  title: string; done: number; target: number; unit?: string; remainingText?: string; expectedFraction: number;
}) {
  const pct = target > 0 ? Math.min(100, Math.round((done / target) * 100)) : 0;
  const left = Math.max(0, target - done);
  const st = targetStatus(done, target, expectedFraction);
  return (
    <Card className={cn(CARD, 'p-4')}>
      <div className="flex items-center justify-between gap-2">
        <p className="min-w-0 truncate text-sm font-medium text-muted-foreground">{title}</p>
        <StatusPill tone={st.tone} className="max-w-[60%] truncate">{st.label}</StatusPill>
      </div>
      <p className="mt-2 truncate text-2xl font-bold tabular-nums">{done} <span className="text-sm font-medium text-muted-foreground">/ {target}</span></p>
      <Progress value={pct} className="mt-2 h-1.5" />
      <div className="mt-1.5 flex justify-between gap-2 text-xs text-muted-foreground">
        <span className="min-w-0 truncate">{left > 0 ? `${left} more to go` : 'Done'}</span>
        {remainingText && <span className="shrink-0">{remainingText}</span>}
      </div>
    </Card>
  );
}

/* ---------- Chart: green Brought In, amber Pending ---------- */
// recharts is heavy: it loads after the cards, not with them.
const ProxyChartGraph = lazyNamed(() => import('./ProxyChartGraph'), 'ProxyChartGraph');

export function ProxyPerformanceChart({ d, range, onRange, fetching }: { d: ProxyPerformanceDashboard; range: ProxyRange; onRange: (r: ProxyRange) => void; fetching: boolean }) {
  const data = d.series.map((s) => ({
    ...s,
    label: new Date(`${s.date}T00:00:00`).toLocaleDateString('en-GB', range === '7d' ? { weekday: 'short' } : { day: 'numeric', month: 'short' }),
  }));
  const empty = data.every((s) => !s.brought_in && !s.pending);
  const max = Math.max(1, ...data.map((s) => Math.max(s.brought_in, s.pending)));
  return (
    <Card className={cn(CARD, 'p-4')}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="text-sm font-medium text-muted-foreground">Brought In vs Pending</p>
        <Select value={range} onValueChange={(v) => onRange(v as ProxyRange)}>
          <SelectTrigger className="h-8 w-[120px] rounded-lg px-3 text-xs" disabled={fetching} aria-label="Chart period"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="today">Today</SelectItem>
            <SelectItem value="yesterday">Yesterday</SelectItem>
            <SelectItem value="7d">7 Days</SelectItem>
            <SelectItem value="30d">30 Days</SelectItem>
            <SelectItem value="month">This Month</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="mb-1 flex gap-3 text-xs">
        <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-primary" />Brought In</span>
        <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-muted-foreground/50" />Pending</span>
      </div>
      {empty ? (
        <div className="flex h-28 flex-col items-center justify-center gap-1 text-sm text-muted-foreground">
          <LineChart className="h-6 w-6" />No activity yet for this period.
        </div>
      ) : (
        <div className="h-48 w-full md:h-60">
          <Suspense fallback={<Skeleton className="h-full w-full rounded-xl" />}>
            <ProxyChartGraph data={data} max={max} />
          </Suspense>
        </div>
      )}
      <p className="mt-1 text-[11px] text-muted-foreground">Brought In by the day the money came in; Pending by the day each note was created.</p>
    </Card>
  );
}

/* ---------- Snapshots (desktop side column) ---------- */
export function ProxyEarningsSnapshot({ d, onOpen }: { d: ProxyPerformanceDashboard; onOpen: () => void }) {
  const c = d.commission;
  const rows: [string, number][] = [['Promissory Notes', c.notes], ['Initial Support', c.initial_support], ['Top-ups', c.top_ups]];
  return (
    <Card className="p-4">
      <div className="flex items-center justify-between"><p className="text-sm font-semibold">Earnings</p>
        <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={onOpen}>Details</Button></div>
      <p className="mt-1 text-2xl font-bold tabular-nums">{ugx(c.earned)}</p>
      <dl className="mt-2 space-y-1.5 text-sm">
        {rows.map(([k, v]) => <div key={k} className="flex justify-between"><dt className="text-muted-foreground">{k}</dt><dd className="tabular-nums font-medium">{ugx(v)}</dd></div>)}
        <div className="flex justify-between"><dt className="text-muted-foreground">Pending</dt><dd className="tabular-nums font-medium">{ugx(c.pending)}</dd></div>
      </dl>
    </Card>
  );
}

export function ProxyRecentNotes({ d, onViewAll }: { d: ProxyPerformanceDashboard; onViewAll: () => void }) {
  return (
    <Card className={cn(CARD, 'p-4')}>
      <div className="mb-1 flex items-center justify-between">
        <p className="text-sm font-medium text-muted-foreground">Recent Promissory Notes</p>
        <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={onViewAll}>View all<ChevronRight className="ml-0.5 h-3 w-3" /></Button>
      </div>
      {d.recent.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">You haven't created a Promissory Note yet.</p>
      ) : (
        <ul className="divide-y divide-border/60">
          {d.recent.slice(0, 5).map((r) => (
            <li key={r.id} className="flex items-center justify-between gap-3 py-2.5">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{r.partner_name || 'Unnamed partner'}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {shortDate(r.created_at)}
                  {r.house_count > 0 ? ` · ${r.house_count} house${r.house_count === 1 ? '' : 's'}` : ''}
                  {r.commission > 0 ? ` · +${ugx(r.commission)}` : ''}
                </p>
              </div>
              <div className="flex shrink-0 flex-col items-end gap-0.5">
                <p className="text-sm font-semibold tabular-nums">{ugxShort(r.amount)}</p>
                <NoteStatusPill status={r.status} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export function ProxyDashboardSkeleton() {
  return (
    <div className="space-y-3">
      <Skeleton className="h-28 rounded-2xl" />
      <div className="grid grid-cols-2 gap-2.5">{[0, 1].map((i) => <Skeleton key={i} className="h-[104px] rounded-2xl" />)}</div>
      <div className="grid grid-cols-2 gap-2.5">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-[92px] rounded-2xl" />)}</div>
      <Skeleton className="h-64 rounded-2xl" />
    </div>
  );
}

export function ListSkeleton({ rows = 4 }: { rows?: number }) {
  return <div className="space-y-2">{Array.from({ length: rows }).map((_, i) => <Skeleton key={i} className="h-24 rounded-xl" />)}</div>;
}
