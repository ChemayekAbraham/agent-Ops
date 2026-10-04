import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Area, AreaChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { supabase } from '@/integrations/supabase/client';
import { formatUGX } from '@/lib/rentCalculations';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { Calendar } from '@/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import { formatDistanceToNow, format, startOfMonth, subDays } from 'date-fns';
import {
  Users, Handshake, Home, Building2, UserCheck, Banknote, TrendingUp,
  Target, Coins, RefreshCw, LineChart, ClipboardList, Loader2, CalendarDays,
} from 'lucide-react';
import type { DateRange } from 'react-day-picker';

interface Counts {
  agents: number;
  partners: number;
  tenants: number;
  landlords: number;
  employees: number;
}

interface Money {
  landlord_float_disbursed: number;
  agent_collected_total: number;
  expected_daily: number;
  outstanding_expected: number;
  partner_roi_paid: number;
  partner_compounded: number;
}

interface CollectionPoint {
  day: string;
  label: string;
  collected: number;
  expected: number;
}

interface PipelinePoint {
  day: string;
  label: string;
  requested: number;
  repaying: number;
  outstanding: number;
}

interface ReviewRequest {
  id: string;
  rent_amount: number;
  status: string;
  created_at: string;
  agent_name: string | null;
  agent_avatar_url: string | null;
  tenant_name: string | null;
}

interface PendingRoi {
  id: string;
  amount: number;
  created_at: string;
  description: string | null;
  partner_name: string | null;
  partner_avatar_url: string | null;
}

interface Snapshot {
  generated_at: string;
  days: number;
  range?: { from: string; to: string; bucket: 'day' | 'month' };
  counts: Counts;
  money: Money;
  collections_series: CollectionPoint[];
  pipeline_series: PipelinePoint[];
  review_requests: ReviewRequest[];
  pending_roi: PendingRoi[];
}

const STATUS_LABEL: Record<string, string> = {
  pending: 'New request',
  service_center_review: 'Service centre vetting',
  agent_ops_approved: 'Agent Ops cleared',
  tenant_ops_approved: 'Tenant Ops cleared',
  landlord_ops_approved: 'Pending COO approval',
};

function statusTone(status: string) {
  if (status === 'landlord_ops_approved') return 'bg-emerald-500/12 text-emerald-700 dark:text-emerald-400 border-emerald-500/30';
  if (status === 'pending' || status === 'service_center_review') return 'bg-amber-500/12 text-amber-700 dark:text-amber-400 border-amber-500/30';
  return 'bg-sky-500/12 text-sky-700 dark:text-sky-400 border-sky-500/30';
}

function initials(name?: string | null) {
  if (!name) return '—';
  return name.trim().split(/\s+/).slice(0, 2).map(p => p[0]?.toUpperCase() ?? '').join('') || '—';
}

function compactUGX(value: number) {
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`;
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${Math.round(value / 1_000)}K`;
  return String(Math.round(value));
}

function CountTile({
  label, value, icon: Icon, hint,
}: { label: string; value: number; icon: typeof Users; hint: string }) {
  return (
    <div className="rounded-xl border bg-card p-3">
      <div className="flex items-center justify-between">
        <Icon className="h-4 w-4 text-primary" />
        <span className="text-lg font-black tabular-nums">{value.toLocaleString()}</span>
      </div>
      <p className="mt-1.5 text-[11px] font-bold leading-tight">{label}</p>
      <p className="text-[10px] text-muted-foreground leading-snug">{hint}</p>
    </div>
  );
}

function MoneyTile({
  label, value, icon: Icon, hint, tone,
}: { label: string; value: number; icon: typeof Banknote; hint: string; tone: string }) {
  return (
    <div className={cn('rounded-xl border p-3', tone)}>
      <div className="flex items-center gap-2">
        <Icon className="h-4 w-4" />
        <p className="text-[10px] font-bold uppercase tracking-wider">{label}</p>
      </div>
      <p className="mt-1.5 text-base font-black tabular-nums leading-tight">{formatUGX(value)}</p>
      <p className="text-[10px] text-muted-foreground leading-snug mt-0.5">{hint}</p>
    </div>
  );
}

function ChartTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border bg-popover px-3 py-2 shadow-lg">
      <p className="text-[11px] font-bold mb-1">{label}</p>
      {payload.map((p: any) => (
        <p key={p.dataKey} className="text-[11px] tabular-nums" style={{ color: p.color }}>
          {p.name}: {formatUGX(Number(p.value || 0))}
        </p>
      ))}
    </div>
  );
}

type PresetId = 'all' | 'today' | 'yesterday' | 'month' | 'custom';

const PRESETS: { id: PresetId; label: string }[] = [
  { id: 'all', label: 'All time' },
  { id: 'today', label: 'Today' },
  { id: 'yesterday', label: 'Yesterday' },
  { id: 'month', label: 'This month' },
  { id: 'custom', label: 'Custom' },
];

const ALL_TIME_START = '2020-01-01';
const fmt = (d: Date) => format(d, 'yyyy-MM-dd');

function resolveRange(preset: PresetId, custom?: DateRange): { from: string; to: string } {
  const today = new Date();
  switch (preset) {
    case 'today':
      return { from: fmt(today), to: fmt(today) };
    case 'yesterday': {
      const y = subDays(today, 1);
      return { from: fmt(y), to: fmt(y) };
    }
    case 'month':
      return { from: fmt(startOfMonth(today)), to: fmt(today) };
    case 'custom':
      if (custom?.from) {
        return { from: fmt(custom.from), to: fmt(custom.to ?? custom.from) };
      }
      return { from: ALL_TIME_START, to: fmt(today) };
    case 'all':
    default:
      return { from: ALL_TIME_START, to: fmt(today) };
  }
}

export default function COOOverviewSnapshot() {
  const [preset, setPreset] = useState<PresetId>('month');
  const [custom, setCustom] = useState<DateRange | undefined>();
  const [pickerOpen, setPickerOpen] = useState(false);

  const range = useMemo(() => resolveRange(preset, custom), [preset, custom]);

  const { data, isLoading, isFetching, refetch, error } = useQuery({
    queryKey: ['coo-overview-snapshot', range.from, range.to],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_coo_overview_snapshot', {
        p_days: 14,
        p_from: range.from,
        p_to: range.to,
      } as any);
      if (error) throw error;
      return data as unknown as Snapshot;
    },
    staleTime: 60_000,
  });

  const rangeLabel =
    preset === 'all' ? 'All time'
      : preset === 'custom' && custom?.from
        ? `${format(custom.from, 'dd MMM yyyy')} – ${format(custom.to ?? custom.from, 'dd MMM yyyy')}`
        : PRESETS.find(p => p.id === preset)?.label ?? '';

  const filterBar = (
    <section className="rounded-xl border bg-card p-2.5">
      <div className="flex flex-wrap items-center gap-1.5">
        {PRESETS.filter(p => p.id !== 'custom').map(p => (
          <Button
            key={p.id}
            size="sm"
            variant={preset === p.id ? 'default' : 'outline'}
            className="h-7 rounded-full px-3 text-[11px] font-bold"
            onClick={() => setPreset(p.id)}
          >
            {p.label}
          </Button>
        ))}
        <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
          <PopoverTrigger asChild>
            <Button
              size="sm"
              variant={preset === 'custom' ? 'default' : 'outline'}
              className="h-7 rounded-full px-3 text-[11px] font-bold"
            >
              <CalendarDays className="mr-1 h-3.5 w-3.5" />
              {preset === 'custom' && custom?.from ? rangeLabel : 'Custom range'}
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-auto p-0 z-[60]" align="start">
            <Calendar
              mode="range"
              selected={custom}
              onSelect={(r) => {
                setCustom(r);
                setPreset('custom');
                if (r?.from && r?.to) setPickerOpen(false);
              }}
              numberOfMonths={1}
              disabled={{ after: new Date() }}
              initialFocus
            />
          </PopoverContent>
        </Popover>
        <span className="ml-auto text-[10px] font-semibold text-muted-foreground">
          Showing: {rangeLabel}
        </span>
      </div>
    </section>
  );

  if (isLoading) {
    return (
      <div className="space-y-3">
        {filterBar}
        <Skeleton className="h-24 w-full rounded-xl" />
        <Skeleton className="h-56 w-full rounded-xl" />
        <Skeleton className="h-40 w-full rounded-xl" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="space-y-3">
        {filterBar}
        <div className="rounded-xl border-2 border-red-500/40 bg-red-500/8 p-4 text-sm">
          Could not load the operations snapshot.
          <button onClick={() => refetch()} className="ml-2 font-bold underline">Try again</button>
        </div>
      </div>
    );
  }

  const { counts, money, collections_series, pipeline_series, review_requests, pending_roi } = data;

  return (
    <div className="space-y-4">
      {/* Network size */}
      <section>
        <div className="flex items-center justify-between mb-2 px-0.5">
          <p className="text-xs font-bold uppercase tracking-widest text-muted-foreground">Network</p>
          <button
            onClick={() => refetch()}
            className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-muted-foreground hover:text-foreground active:scale-95"
          >
            {isFetching ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            Refresh
          </button>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2.5">
          <CountTile label="Agents" value={counts.agents} icon={Users} hint="Collects or repays rent for tenants" />
          <CountTile label="Partners" value={counts.partners} icon={Handshake} hint="With one or more portfolios" />
          <CountTile label="Tenants" value={counts.tenants} icon={Home} hint="Has a repayment record" />
          <CountTile label="Landlords" value={counts.landlords} icon={Building2} hint="Ever received landlord float" />
          <CountTile label="Employees" value={counts.employees} icon={UserCheck} hint="Active employee role" />
        </div>
      </section>

      {filterBar}

      {/* Money position */}
      <section>
        <p className="text-xs font-bold uppercase tracking-widest text-muted-foreground mb-2 px-0.5">
          Money position · {rangeLabel}
        </p>
        <div className="grid grid-cols-2 lg:grid-cols-3 gap-2.5">
          <MoneyTile
            label="Landlord float sent" value={money.landlord_float_disbursed} icon={Banknote}
            hint="Rent paid out to landlords in range" tone="border-emerald-500/30 bg-emerald-500/8"
          />
          <MoneyTile
            label="Agent collections" value={money.agent_collected_total} icon={Coins}
            hint="Repayments collected in range" tone="border-primary/30 bg-primary/8"
          />
          <MoneyTile
            label="Expected daily" value={money.expected_daily} icon={Target}
            hint="Today's collection target" tone="border-sky-500/30 bg-sky-500/8"
          />
          <MoneyTile
            label="Still to collect" value={money.outstanding_expected} icon={ClipboardList}
            hint="Outstanding on active rent plans" tone="border-amber-500/30 bg-amber-500/8"
          />
          <MoneyTile
            label="Partner returns paid" value={money.partner_roi_paid} icon={TrendingUp}
            hint="Returns credited to partners in range" tone="border-violet-500/30 bg-violet-500/8"
          />
          <MoneyTile
            label="Partner compounded" value={money.partner_compounded} icon={LineChart}
            hint="Returns reinvested in range" tone="border-fuchsia-500/30 bg-fuchsia-500/8"
          />
        </div>
      </section>

      {/* Collections vs expected */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-bold">Agent collections vs expected · {rangeLabel}</CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          <div className="h-64 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={collections_series} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="cooCollected" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="hsl(160 84% 39%)" stopOpacity={0.45} />
                    <stop offset="100%" stopColor="hsl(160 84% 39%)" stopOpacity={0.04} />
                  </linearGradient>
                  <linearGradient id="cooExpected" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="hsl(217 91% 60%)" stopOpacity={0.4} />
                    <stop offset="100%" stopColor="hsl(217 91% 60%)" stopOpacity={0.04} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" className="stroke-border" vertical={false} />
                <XAxis dataKey="label" tick={{ fontSize: 10 }} interval="preserveStartEnd" />
                <YAxis tick={{ fontSize: 10 }} width={48} tickFormatter={compactUGX} />
                <Tooltip content={<ChartTooltip />} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Area
                  type="monotone" dataKey="expected" name="Expected" strokeWidth={2}
                  stroke="hsl(217 91% 60%)" fill="url(#cooExpected)"
                />
                <Area
                  type="monotone" dataKey="collected" name="Collected" strokeWidth={2}
                  stroke="hsl(160 84% 39%)" fill="url(#cooCollected)"
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </CardContent>
      </Card>

      {/* Latest rent requests pending COO approval */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-bold">Rent requests pending COO approval · {rangeLabel}</CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          {review_requests.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">No rent requests pending COO approval.</p>
          ) : (
            <ul className="divide-y">
              {review_requests.map(r => (
                <li key={r.id} className="flex items-center gap-3 py-2.5">
                  <Avatar className="h-9 w-9 shrink-0">
                    {r.agent_avatar_url ? <AvatarImage src={r.agent_avatar_url} alt={r.agent_name ?? 'Agent'} /> : null}
                    <AvatarFallback className="text-[11px] font-bold">{initials(r.agent_name)}</AvatarFallback>
                  </Avatar>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold truncate">{r.tenant_name || 'Unnamed tenant'}</p>
                    <p className="text-[11px] text-muted-foreground truncate">
                      {r.agent_name || 'Self-posted'} · {formatDistanceToNow(new Date(r.created_at), { addSuffix: true })}
                    </p>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="text-sm font-black tabular-nums">{formatUGX(r.rent_amount)}</p>
                    <Badge variant="outline" className={cn('mt-0.5 text-[9px] font-bold', statusTone(r.status))}>
                      {STATUS_LABEL[r.status] ?? r.status}
                    </Badge>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* Requests vs repaying vs outstanding */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-bold">Rent requested vs repaying vs still to collect · {rangeLabel}</CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          <div className="h-64 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={pipeline_series} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="cooRequested" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="hsl(271 81% 56%)" stopOpacity={0.4} />
                    <stop offset="100%" stopColor="hsl(271 81% 56%)" stopOpacity={0.04} />
                  </linearGradient>
                  <linearGradient id="cooRepaying" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="hsl(160 84% 39%)" stopOpacity={0.4} />
                    <stop offset="100%" stopColor="hsl(160 84% 39%)" stopOpacity={0.04} />
                  </linearGradient>
                  <linearGradient id="cooOutstanding" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="hsl(38 92% 50%)" stopOpacity={0.4} />
                    <stop offset="100%" stopColor="hsl(38 92% 50%)" stopOpacity={0.04} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" className="stroke-border" vertical={false} />
                <XAxis dataKey="label" tick={{ fontSize: 10 }} interval="preserveStartEnd" />
                <YAxis tick={{ fontSize: 10 }} width={48} tickFormatter={compactUGX} />
                <Tooltip content={<ChartTooltip />} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Area type="monotone" dataKey="outstanding" name="Still to collect" strokeWidth={2}
                  stroke="hsl(38 92% 50%)" fill="url(#cooOutstanding)" />
                <Area type="monotone" dataKey="requested" name="Requested" strokeWidth={2}
                  stroke="hsl(271 81% 56%)" fill="url(#cooRequested)" />
                <Area type="monotone" dataKey="repaying" name="Repaid" strokeWidth={2}
                  stroke="hsl(160 84% 39%)" fill="url(#cooRepaying)" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </CardContent>
      </Card>

      {/* Pending partner return approvals */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-bold">Pending partner return approvals</CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          {pending_roi.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">No partner returns waiting for your approval.</p>
          ) : (
            <ul className="divide-y">
              {pending_roi.map(r => (
                <li key={r.id} className="flex items-center gap-3 py-2.5">
                  <Avatar className="h-9 w-9 shrink-0">
                    {r.partner_avatar_url ? <AvatarImage src={r.partner_avatar_url} alt={r.partner_name ?? 'Partner'} /> : null}
                    <AvatarFallback className="text-[11px] font-bold">{initials(r.partner_name)}</AvatarFallback>
                  </Avatar>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold truncate">{r.partner_name || 'Unnamed partner'}</p>
                    <p className="text-[11px] text-muted-foreground truncate">
                      {formatDistanceToNow(new Date(r.created_at), { addSuffix: true })}
                    </p>
                  </div>
                  <p className="text-sm font-black tabular-nums shrink-0">{formatUGX(r.amount)}</p>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}