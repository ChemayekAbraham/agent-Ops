import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { AgentAvatar } from './AgentAvatar';
import { formatUGX } from '@/lib/agentAdvanceCalculations';
import { Loader2, Phone, MapPin, ShieldCheck } from 'lucide-react';
import { cn } from '@/lib/utils';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { Button } from '@/components/ui/button';
import { AgentEligibilityHistoryStrip } from './AgentEligibilityHistoryStrip';
import { AgentRepaymentCalendar } from './AgentRepaymentCalendar';
import { AgentBioEditor } from './AgentBioEditor';

interface Props {
  agentId: string | null;
  onOpenChange: (open: boolean) => void;
  /** Render the profile inline (no side sheet) */
  inline?: boolean;
}

const dt = (v?: string | null) => (v ? new Date(v).toLocaleDateString() : '—');

type Period = 'today' | 'weekly' | 'monthly' | 'yearly';

function pct(a: number, b: number) { return b > 0 ? Math.round((a / b) * 100) : 0; }

function TargetCards({ agentId, dailyTarget }: { agentId: string | null; dailyTarget: number }) {
  const { data: rows = [] } = useQuery({
    queryKey: ['agent-target-cards', agentId],
    enabled: !!agentId,
    staleTime: 60_000,
    queryFn: async () => {
      const since = new Date();
      since.setDate(since.getDate() - 7);
      since.setHours(0, 0, 0, 0);
      const { data, error } = await supabase
        .from('agent_collections')
        .select('amount, created_at').is('reversed_at', null)
        .eq('agent_id', agentId as string)
        .gte('created_at', since.toISOString())
        .limit(5000);
      if (error) throw error;
      return (data ?? []) as { amount: number; created_at: string }[];
    },
  });

  const { today, yesterday, week } = useMemo(() => {
    const t0 = new Date(); t0.setHours(0, 0, 0, 0);
    const y0 = new Date(t0.getTime() - 86_400_000);
    const w0 = new Date(t0.getTime() - 6 * 86_400_000);
    let today = 0, yesterday = 0, week = 0;
    for (const r of rows) {
      const d = new Date(r.created_at); const a = Number(r.amount || 0);
      if (d >= t0) today += a;
      else if (d >= y0) yesterday += a;
      if (d >= w0) week += a;
    }
    return { today, yesterday, week };
  }, [rows]);

  const weekTarget = dailyTarget * 7;
  const todayPct = pct(today, dailyTarget);

  const cards = [
    { label: 'Today', value: today, target: dailyTarget, sub: `${todayPct}% of daily target` },
    { label: 'Yesterday', value: yesterday, target: dailyTarget, sub: `${pct(yesterday, dailyTarget)}% of daily target` },
    { label: 'This week (7d)', value: week, target: weekTarget, sub: `${pct(week, weekTarget)}% of weekly target` },
  ];

  return (
    <div className="space-y-2 mb-3">
      <div className={cn(
        'rounded-xl border p-3',
        todayPct >= 20 ? 'border-emerald-500/40 bg-emerald-500/5' : 'border-destructive/40 bg-destructive/5',
      )}>
        <p className={cn('text-sm font-bold', todayPct >= 20 ? 'text-emerald-600' : 'text-destructive')}>
          {todayPct >= 20 ? 'Can post new rent today' : 'Below posting threshold today'}
        </p>
        <p className="text-[11px] text-muted-foreground">Collected {todayPct}% of today’s target</p>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        {cards.map(c => (
          <div key={c.label} className="rounded-xl border border-border bg-background p-2.5">
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-medium">{c.label}</p>
            <p className="text-sm font-bold mt-1 tabular-nums">
              <span className={c.value > 0 ? 'text-emerald-600' : 'text-destructive'}>{formatUGX(c.value)}</span>
              <span className="text-muted-foreground font-normal"> / {formatUGX(c.target)}</span>
            </p>
            <p className="text-[11px] text-muted-foreground mt-0.5">{c.sub}</p>
          </div>
        ))}
      </div>
      {agentId && <AgentEligibilityHistoryStrip agentId={agentId} />}
      {agentId && <AgentRepaymentCalendar agentId={agentId} />}
    </div>
  );
}

function CollectionPerformance({ agentId, dailyTarget = 0 }: { agentId: string | null; dailyTarget?: number }) {
  const [period, setPeriod] = useState<Period>('weekly');

  const since = useMemo(() => {
    const d = new Date();
    if (period === 'today') d.setHours(0, 0, 0, 0);
    else if (period === 'weekly') d.setDate(d.getDate() - 6);
    else if (period === 'monthly') d.setDate(d.getDate() - 29);
    else d.setMonth(d.getMonth() - 11);
    if (period !== 'today') d.setHours(0, 0, 0, 0);
    return d.toISOString();
  }, [period]);

  const { data: rows = [], isLoading } = useQuery({
    queryKey: ['agent-collection-performance', agentId, period],
    enabled: !!agentId,
    staleTime: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('agent_collections')
        .select('amount, created_at').is('reversed_at', null)
        .eq('agent_id', agentId as string)
        .gte('created_at', since)
        .order('created_at', { ascending: true })
        .limit(5000);
      if (error) throw error;
      return (data ?? []) as { amount: number; created_at: string }[];
    },
  });

  const series = useMemo(() => {
    const buckets: { key: string; label: string; amount: number; count: number }[] = [];
    const index = new Map<string, number>();
    const push = (key: string, label: string) => {
      index.set(key, buckets.length);
      buckets.push({ key, label, amount: 0, count: 0 });
    };
    const now = new Date();
    if (period === 'today') {
      for (let h = 0; h <= now.getHours(); h++) push(String(h), `${String(h).padStart(2, '0')}:00`);
    } else if (period === 'yearly') {
      for (let i = 11; i >= 0; i--) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        push(`${d.getFullYear()}-${d.getMonth()}`, d.toLocaleDateString(undefined, { month: 'short' }));
      }
    } else {
      const days = period === 'weekly' ? 7 : 30;
      for (let i = days - 1; i >= 0; i--) {
        const d = new Date(now);
        d.setDate(d.getDate() - i);
        push(d.toDateString(), d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }));
      }
    }
    for (const r of rows) {
      const d = new Date(r.created_at);
      const key = period === 'today' ? String(d.getHours())
        : period === 'yearly' ? `${d.getFullYear()}-${d.getMonth()}`
        : d.toDateString();
      const i = index.get(key);
      if (i === undefined) continue;
      buckets[i].amount += Number(r.amount || 0);
      buckets[i].count += 1;
    }
    return buckets;
  }, [rows, period]);

  const total = series.reduce((s, b) => s + b.amount, 0);
  const count = series.reduce((s, b) => s + b.count, 0);
  const best = series.reduce((m, b) => (b.amount > (m?.amount ?? -1) ? b : m), series[0]);
  const active = series.filter(b => b.amount > 0).length;
  const avg = active > 0 ? total / active : 0;

  const options: { value: Period; label: string }[] = [
    { value: 'today', label: 'Today' },
    { value: 'weekly', label: 'Weekly' },
    { value: 'monthly', label: 'Monthly' },
    { value: 'yearly', label: 'Yearly' },
  ];

  return (
    <div className="rounded-xl border border-border bg-background p-3">
      <div className="flex items-center justify-between gap-2 flex-wrap mb-2">
        <div>
          <p className="text-xs font-semibold">Overall collection performance</p>
          <p className="text-[11px] text-muted-foreground">How this agent collects rent over time</p>
        </div>
        <div className="flex gap-1">
          {options.map(o => (
            <Button
              key={o.value}
              size="sm"
              variant={period === o.value ? 'default' : 'outline'}
              className="h-7 px-2 text-[11px]"
              onClick={() => setPeriod(o.value)}
            >
              {o.label}
            </Button>
          ))}
        </div>
      </div>

      <TargetCards agentId={agentId} dailyTarget={dailyTarget} />

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-3">
        <Stat label="Collected" value={formatUGX(total)} tone="text-emerald-600" />
        <Stat label="Payments" value={count} />
        <Stat label={period === 'today' ? 'Avg / active hour' : period === 'yearly' ? 'Avg / active month' : 'Avg / active day'} value={formatUGX(Math.round(avg))} />
        <Stat label="Best period" value={best && best.amount > 0 ? `${best.label} · ${formatUGX(best.amount)}` : '—'} />
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center h-40 text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /></div>
      ) : total === 0 ? (
        <p className="text-xs text-muted-foreground py-8 text-center">No collections in this period</p>
      ) : (
        <div className="h-48">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={series} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="agentCollGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.35} />
                  <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
              <XAxis dataKey="label" tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" interval="preserveStartEnd" />
              <YAxis tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" width={54}
                tickFormatter={(v: number) => (v >= 1_000_000 ? `${(v / 1_000_000).toFixed(1)}M` : v >= 1000 ? `${Math.round(v / 1000)}K` : String(v))} />
              <Tooltip
                contentStyle={{ fontSize: 12, borderRadius: 8, background: 'hsl(var(--popover))', border: '1px solid hsl(var(--border))', color: 'hsl(var(--popover-foreground))' }}
                formatter={(v: any, _n, p: any) => [`${formatUGX(Number(v))} · ${p?.payload?.count ?? 0} payments`, 'Collected']}
              />
              <Area type="monotone" dataKey="amount" stroke="hsl(var(--primary))" strokeWidth={2} fill="url(#agentCollGrad)" />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
function Stat({ label, value, tone }: { label: string; value: string | number; tone?: string }) {
  return (
    <div className="rounded-xl border border-border bg-background p-2.5">
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-medium truncate">{label}</p>
      <p className={cn('font-bold text-sm mt-1 tabular-nums', tone)}>{value}</p>
    </div>
  );
}

/** Full collections ledger for an agent: per-payment amount plus the tenant's
 *  total rent, cumulative repaid and remaining balance. */
function CollectionsLedger({ agentId }: { agentId: string | null }) {
  const [limit, setLimit] = useState(50);
  const [q, setQ] = useState('');
  useEffect(() => { setLimit(50); setQ(''); }, [agentId]);

  const { data, isLoading } = useQuery({
    queryKey: ['agent-collections-detail', agentId, limit],
    enabled: !!agentId,
    staleTime: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_agent_collections_detail' as any, {
        p_agent_id: agentId, p_limit: limit,
      });
      if (error) throw error;
      return data as any;
    },
  });

  const s = data?.summary ?? {};
  const p = data?.portfolio ?? {};
  const rows: any[] = data?.rows ?? [];
  const term = q.trim().toLowerCase();
  const filtered = term
    ? rows.filter(r => `${r.tenant_name ?? ''} ${r.tenant_phone ?? ''} ${r.momo_transaction_id ?? ''} ${r.amount}`.toLowerCase().includes(term))
    : rows;

  const rentTotal = Number(p.rent_total || 0);
  const repaidTotal = Number(p.repaid_total || 0);
  const outstandingTotal = Number(p.outstanding_total || 0);
  const collectedAll = Number(s.total || 0);

  if (isLoading) {
    return <div className="flex justify-center py-10"><Loader2 className="h-4 w-4 animate-spin text-primary" /></div>;
  }

  return (
    <div className="space-y-3">
      {/* Portfolio: total billed vs collected vs still owed */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <Stat label="Total rent (portfolio)" value={formatUGX(rentTotal)} />
        <Stat label="Total repaid" value={formatUGX(repaidTotal)} tone="text-emerald-600" />
        <Stat label="Outstanding" value={formatUGX(outstandingTotal)} tone="text-amber-600" />
        <Stat label="Repayment rate" value={`${pct(repaidTotal, rentTotal)}%`} />
      </div>

      {/* Collection activity */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <Stat label="Collections" value={Number(s.count || 0).toLocaleString()} />
        <Stat label="Tenants paid" value={Number(s.tenants_paid || 0).toLocaleString()} />
        <Stat label="Today" value={formatUGX(Number(s.today || 0))} />
        <Stat label="Last 7 days" value={formatUGX(Number(s.week || 0))} />
        <Stat label="Last 30 days" value={formatUGX(Number(s.last_30d || 0))} />
        <Stat label="Collected all time" value={formatUGX(collectedAll)} tone="text-emerald-600" />
        <Stat label="Average payment" value={formatUGX(Math.round(Number(s.avg_amount || 0)))} />
        <Stat label="Last collection" value={s.last_collection_at ? dt(s.last_collection_at) : '—'} />
      </div>

      {/* Channel split */}
      <div className="grid grid-cols-3 gap-2">
        <Stat label="Cash" value={formatUGX(Number(s.cash_total || 0))} />
        <Stat label="Mobile money" value={formatUGX(Number(s.momo_total || 0))} />
        <Stat label="In-app wallet" value={formatUGX(Number(s.wallet_total || 0))} />
      </div>

      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search tenant, phone, TID or amount…"
        className="w-full h-9 rounded-lg border border-border bg-background px-3 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      />

      <Table
        head={['Tenant', 'Phone', 'Paid', 'Total rent', 'Repaid', 'Balance', '% repaid', 'Daily', 'Method', 'Reference', 'When']}
        rows={filtered.map((r) => {
          const rent = Number(r.rent_total || 0);
          const repaid = Number(r.repaid_total || 0);
          return [
            r.tenant_name ?? '—',
            r.tenant_phone ?? '—',
            formatUGX(Number(r.amount || 0)),
            rent ? formatUGX(rent) : '—',
            repaid ? formatUGX(repaid) : '—',
            rent ? formatUGX(Number(r.outstanding || 0)) : '—',
            rent ? `${pct(repaid, rent)}%` : '—',
            Number(r.daily_repayment || 0) ? formatUGX(Number(r.daily_repayment)) : '—',
            (r.payment_method ?? '—').toString().replace(/_/g, ' '),
            r.momo_transaction_id || r.momo_provider || r.location_name || '—',
            r.created_at ? new Date(r.created_at).toLocaleString() : '—',
          ];
        })}
        empty={term ? 'No collections match that search' : 'No collections recorded'}
      />

      {rows.length >= limit && (
        <div className="flex justify-center">
          <Button size="sm" variant="outline" onClick={() => setLimit((l) => l + 50)}>Load more</Button>
        </div>
      )}
      <p className="text-[10px] text-muted-foreground text-center">
        Showing {filtered.length.toLocaleString()} of {Number(s.count || 0).toLocaleString()} recorded collections.
      </p>
    </div>
  );
}

function Table({ head, rows, empty }: { head: string[]; rows: (string | number)[][]; empty: string }) {
  if (!rows.length) return <p className="text-xs text-muted-foreground py-4 text-center">{empty}</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-muted-foreground">
            {head.map(h => <th key={h} className="text-left font-medium py-1.5 pr-3 whitespace-nowrap">{h}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-t border-border/60">
              {r.map((c, j) => <td key={j} className="py-1.5 pr-3 whitespace-nowrap tabular-nums">{c}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const FILTERS = ['all', 'active', 'pending', 'rejected', 'repaying'] as const;
type RentFilter = (typeof FILTERS)[number];

function statusMatches(filter: RentFilter, status: string = '') {
  const s = status.toLowerCase();
  if (filter === 'all') return true;
  if (filter === 'active') return ['active', 'funded', 'repaying', 'approved'].includes(s);
  if (filter === 'pending') return ['pending', 'in_review', 'review'].includes(s);
  if (filter === 'rejected') return ['rejected', 'declined'].includes(s);
  if (filter === 'repaying') return s === 'repaying';
  return true;
}

function RentRequestsTable({ rows }: { rows: any[] }) {
  const [filter, setFilter] = useState<RentFilter>('all');
  const filtered = useMemo(() => rows.filter(r => statusMatches(filter, r.status)), [rows, filter]);
  const countBy = (f: RentFilter) => (f === 'all' ? rows.length : rows.filter(r => statusMatches(f, r.status)).length);

  if (!rows.length) return <p className="text-xs text-muted-foreground py-4 text-center">No rent requests</p>;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5">
        {FILTERS.map(f => (
          <Button
            key={f}
            type="button"
            size="sm"
            variant={filter === f ? 'default' : 'outline'}
            className="h-7 text-[11px] capitalize"
            onClick={() => setFilter(f)}
          >
            {f.replace('_', ' ')}
            <span className="ml-1.5 inline-flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-background/20 px-1 text-[10px]">
              {countBy(f)}
            </span>
          </Button>
        ))}
      </div>
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-muted-foreground bg-muted/40">
              <th className="text-left font-medium py-2 px-3 whitespace-nowrap">Tenant</th>
              <th className="text-left font-medium py-2 px-3 whitespace-nowrap">Status</th>
              <th className="text-right font-medium py-2 px-3 whitespace-nowrap">Rent</th>
              <th className="text-right font-medium py-2 px-3 whitespace-nowrap">Repaid</th>
              <th className="text-right font-medium py-2 px-3 whitespace-nowrap">Daily</th>
              <th className="text-left font-medium py-2 px-3 whitespace-nowrap">Created</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((r, i) => (
              <tr key={i} className="border-t border-border/60">
                <td className="py-2 px-3 whitespace-nowrap font-semibold text-foreground">{r.tenant_name ?? '—'}</td>
                <td className="py-2 px-3 whitespace-nowrap capitalize text-muted-foreground">{r.status}</td>
                <td className="py-2 px-3 whitespace-nowrap text-right tabular-nums text-foreground">{formatUGX(Number(r.rent_amount || 0))}</td>
                <td className="py-2 px-3 whitespace-nowrap text-right tabular-nums text-emerald-600">{formatUGX(Number(r.amount_repaid || 0))}</td>
                <td className="py-2 px-3 whitespace-nowrap text-right tabular-nums text-primary">{formatUGX(Number(r.daily_repayment || 0))}</td>
                <td className="py-2 px-3 whitespace-nowrap text-muted-foreground">{dt(r.created_at)}</td>
              </tr>
            ))}
            {!filtered.length && (
              <tr>
                <td colSpan={6} className="py-4 text-center text-xs text-muted-foreground">No {filter} rent plans</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="text-[10px] text-muted-foreground text-center">Showing {filtered.length} of {rows.length} rent requests</p>
    </div>
  );
}

export function AgentProfile360Sheet({ agentId, onOpenChange, inline = false }: Props) {
  const [tab, setTab] = useState('overview');
  const [tenantPage, setTenantPage] = useState(0);
  const TENANTS_PER_PAGE = 15;
  useEffect(() => { setTenantPage(0); }, [agentId]);

  const { data, isLoading, error } = useQuery({
    queryKey: ['agent-profile-360', agentId],
    enabled: !!agentId,
    staleTime: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_agent_profile_360' as any, { p_agent_id: agentId });
      if (error) throw error;
      return data as any;
    },
  });

  const bio = data?.bio ?? {};
  const rr = data?.rent_requests ?? {};
  const rep = data?.repayments ?? {};
  const col = data?.collections ?? {};
  const rec = data?.recruitment ?? {};
  const lst = data?.listings ?? {};
  const perf = data?.performance ?? {};
  const wal = data?.wallet ?? {};
  const tenants: any[] = data?.tenants ?? [];

  const behaviour = useMemo(() => {
    const expected = Number(rep.expected_total || 0);
    const repaid = Number(rep.repaid_total || 0);
    const pct = expected > 0 ? Math.round((repaid / expected) * 100) : 0;
    return { pct, label: pct >= 80 ? 'Strong' : pct >= 50 ? 'Fair' : pct > 0 ? 'Weak' : 'No history' };
  }, [rep]);

  const body = (
    <>
        {isLoading ? (
          <div className="flex items-center justify-center py-16 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : error ? (
          <p className="text-sm text-destructive py-8 text-center">Failed to load profile. {(error as any)?.message}</p>
        ) : (
          <div className="space-y-4">
            {/* Identity */}
            <div className="flex items-start gap-3 rounded-2xl border border-border bg-background p-3">
              <AgentAvatar src={bio.avatar_url} name={bio.full_name} className="h-12 w-12" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="font-semibold text-sm truncate">{bio.full_name || 'Unknown'}</span>
                  {bio.verified && <ShieldCheck className="h-3.5 w-3.5 text-emerald-600" />}
                  <Badge variant={bio.agent_kind === 'sub_agent' ? 'secondary' : 'default'} className="text-[10px]">
                    {bio.agent_kind === 'sub_agent' ? 'Sub-Agent' : 'Agent'}
                  </Badge>
                  {bio.is_frozen && <Badge variant="destructive" className="text-[10px]">Frozen</Badge>}
                </div>
                <div className="flex items-center gap-3 text-xs text-muted-foreground mt-1 flex-wrap">
                  {bio.phone && <span className="flex items-center gap-1"><Phone className="h-3 w-3" />{bio.phone}</span>}
                  {(bio.district || bio.territory) && (
                    <span className="flex items-center gap-1"><MapPin className="h-3 w-3" />{bio.district || bio.territory}</span>
                  )}
                  <span>Joined {dt(bio.created_at)}</span>
                </div>
                {bio.parent_agent && (
                  <p className="text-[11px] text-muted-foreground mt-1">
                    Recruited by <strong className="text-foreground">{bio.parent_agent.full_name}</strong>
                  </p>
                )}
              </div>
            </div>

            <Tabs value={tab} onValueChange={setTab}>
              <TabsList className="w-full overflow-x-auto justify-start">
                <TabsTrigger value="profile" className="text-xs">Profile</TabsTrigger>
                <TabsTrigger value="overview" className="text-xs">Overview</TabsTrigger>
                <TabsTrigger value="rent" className="text-xs">Rent</TabsTrigger>
                <TabsTrigger value="collections" className="text-xs">Collections</TabsTrigger>
                <TabsTrigger value="network" className="text-xs">Recruitment</TabsTrigger>
                <TabsTrigger value="listings" className="text-xs">Listings</TabsTrigger>
                <TabsTrigger value="wallet" className="text-xs">Wallet</TabsTrigger>
                <TabsTrigger value="tenants" className="text-xs">Tenants</TabsTrigger>
              </TabsList>

              <TabsContent value="profile" className="mt-3">
                <AgentBioEditor agentId={agentId} bio={bio} />
              </TabsContent>

              <TabsContent value="overview" className="space-y-3 mt-3">
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  <Stat label="Rent requests" value={rr.total ?? 0} />
                  <Stat label="Tenants" value={tenants.length} />
                  <Stat label="Listings" value={lst.total ?? 0} />
                  <Stat label="Sub-agents" value={rec.sub_agents_total ?? 0} />
                  <Stat label="Collected (all time)" value={formatUGX(Number(col.total || 0))} />
                  <Stat label="Outstanding" value={formatUGX(Number(rep.outstanding_total || 0))} tone="text-amber-600" />
                  <Stat label="Daily target" value={formatUGX(Number(rep.daily_target || 0))} />
                  <Stat label="Earnings (all time)" value={formatUGX(Number(perf.earnings_total || 0))} tone="text-emerald-600" />
                </div>
                <div className="rounded-xl border border-border bg-background p-3">
                  <p className="text-xs font-semibold mb-1">Rent behaviour</p>
                  <p className="text-xs text-muted-foreground">
                    {behaviour.label} · {behaviour.pct}% of expected repayment recovered
                    ({formatUGX(Number(rep.repaid_total || 0))} of {formatUGX(Number(rep.expected_total || 0))})
                  </p>
                  <div className="h-2 rounded-full bg-muted mt-2 overflow-hidden">
                    <div className="h-full bg-primary" style={{ width: `${Math.min(100, behaviour.pct)}%` }} />
                  </div>
                </div>
                <CollectionPerformance agentId={agentId} dailyTarget={Number(rep.daily_target || 0)} />
              </TabsContent>

              <TabsContent value="rent" className="space-y-3 mt-3">
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  <Stat label="Total" value={rr.total ?? 0} />
                  <Stat label="Active" value={rr.active ?? 0} />
                  <Stat label="Pending" value={rr.pending ?? 0} />
                  <Stat label="Rejected" value={rr.rejected ?? 0} />
                </div>
                <RentRequestsTable rows={rr.recent ?? []} />
              </TabsContent>

              <TabsContent value="collections" className="space-y-3 mt-3">
                <CollectionsLedger agentId={agentId} />
              </TabsContent>

              <TabsContent value="network" className="space-y-3 mt-3">
                <div className="grid grid-cols-3 gap-2">
                  <Stat label="Sub-agents" value={rec.sub_agents_total ?? 0} />
                  <Stat label="Verified" value={rec.sub_agents_verified ?? 0} />
                  <Stat label="Referrals" value={rec.referrals_total ?? 0} />
                </div>
                <Table
                  head={['Name', 'Phone', 'Status', 'Joined']}
                  rows={(rec.sub_agents ?? []).map((s: any) => [s.full_name ?? '—', s.phone ?? '—', s.status ?? '—', dt(s.created_at)])}
                  empty="No sub-agents recruited"
                />
              </TabsContent>

              <TabsContent value="listings" className="space-y-3 mt-3">
                <div className="grid grid-cols-3 gap-2">
                  <Stat label="Listings" value={lst.total ?? 0} />
                  <Stat label="Verified" value={lst.verified ?? 0} />
                  <Stat label="Occupied" value={lst.occupied ?? 0} />
                </div>
                <Table
                  head={['Title', 'Category', 'Rent', 'District', 'Verified', 'Listed']}
                  rows={(lst.recent ?? []).map((h: any) => [
                    h.title ?? '—', h.house_category ?? '—', formatUGX(Number(h.monthly_rent || 0)),
                    h.district ?? '—', h.verified ? 'Yes' : 'No', dt(h.created_at),
                  ])}
                  empty="No house listings"
                />
              </TabsContent>

              <TabsContent value="wallet" className="space-y-3 mt-3">
                <div className="grid grid-cols-3 gap-2">
                  <Stat label="Withdrawable" value={formatUGX(Number(wal.withdrawable || 0))} tone="text-emerald-600" />
                  <Stat label="Float" value={formatUGX(Number(wal.float || 0))} />
                  <Stat label="Advance balance" value={formatUGX(Number(wal.advance_balance || 0))} tone="text-amber-600" />
                </div>
                <Table
                  head={['Principal', 'Outstanding', 'Arrears', 'Daily', 'Status', 'Issued']}
                  rows={(wal.advances ?? []).map((a: any) => [
                    formatUGX(Number(a.principal || 0)), formatUGX(Number(a.outstanding_balance || 0)),
                    formatUGX(Number(a.arrears_balance || 0)), formatUGX(Number(a.daily_installment || 0)),
                    a.status, dt(a.issued_at),
                  ])}
                  empty="No open advances"
                />
              </TabsContent>

              <TabsContent value="tenants" className="mt-3">
                <Table
                  head={['Tenant', 'Phone', 'Status', 'Rent', 'Outstanding']}
                  rows={tenants
                    .slice(tenantPage * TENANTS_PER_PAGE, tenantPage * TENANTS_PER_PAGE + TENANTS_PER_PAGE)
                    .map((t: any) => [
                      t.full_name ?? '—', t.phone ?? '—', t.agent_payment_status || t.status || '—',
                      formatUGX(Number(t.rent_amount || 0)), formatUGX(Number(t.outstanding || 0)),
                    ])}
                  empty="No tenants linked to this agent"
                />
                {tenants.length > TENANTS_PER_PAGE && (
                  <div className="flex items-center justify-between gap-2 pt-2 mt-2 border-t border-border">
                    <button
                      className="text-xs px-2.5 py-1.5 rounded-lg border border-border disabled:opacity-40"
                      disabled={tenantPage === 0}
                      onClick={() => setTenantPage(p => Math.max(0, p - 1))}
                    >
                      Prev
                    </button>
                    <span className="text-[11px] text-muted-foreground tabular-nums">
                      {tenantPage * TENANTS_PER_PAGE + 1}–{Math.min(tenants.length, (tenantPage + 1) * TENANTS_PER_PAGE)} of {tenants.length}
                    </span>
                    <button
                      className="text-xs px-2.5 py-1.5 rounded-lg border border-border disabled:opacity-40"
                      disabled={(tenantPage + 1) * TENANTS_PER_PAGE >= tenants.length}
                      onClick={() => setTenantPage(p => p + 1)}
                    >
                      Next
                    </button>
                  </div>
                )}
              </TabsContent>
            </Tabs>
          </div>
        )}
    </>
  );

  if (inline) return <div className="space-y-3">{body}</div>;

  return (
    <Sheet open={!!agentId} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-3xl overflow-y-auto p-4">
        <SheetHeader className="mb-3">
          <SheetTitle className="text-base">Agent profile</SheetTitle>
        </SheetHeader>
        {body}
      </SheetContent>
    </Sheet>
  );
}
