import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Download, FileBarChart, Search, X, Users, HandCoins, TrendingUp, PiggyBank, Percent, Wallet, Info, Calendar, Filter, Trophy, AlertTriangle, Activity, Building } from 'lucide-react';
import { format } from 'date-fns';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { generateAgentPerformancePdf, AgentPerfRow, AgentPerfTotals } from '@/lib/agentPerformanceReportPdf';

type RangePreset = 'this-week' | 'last-week' | 'this-month' | 'last-7' | 'last-30' | 'last-90' | 'all';
type PaymentSource = 'all' | 'agent_collections' | 'repayments' | 'merchant';
type StatusFilter = 'all' | 'critical' | 'low' | 'moderate' | 'good' | 'excellent';

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

const kampalaMonthEnd = (date: string) => {
  const [year, month] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
};

const startOfKampalaWeek = (date: string) => {
  const noon = new Date(`${date}T12:00:00+03:00`);
  const mondayOffset = (noon.getUTCDay() + 6) % 7;
  return addKampalaDays(date, -mondayOffset);
};

const kampalaInstant = (date: string, endOfDay = false) =>
  new Date(`${date}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}+03:00`);

const getRange = (preset: RangePreset): { start: Date | null; end: Date } => {
  const today = kampalaDateString();
  switch (preset) {
    case 'this-week': {
      const start = startOfKampalaWeek(today);
      return { start: kampalaInstant(start), end: kampalaInstant(addKampalaDays(start, 6), true) };
    }
    case 'last-week': {
      const thisWeekStart = startOfKampalaWeek(today);
      const start = addKampalaDays(thisWeekStart, -7);
      return { start: kampalaInstant(start), end: kampalaInstant(addKampalaDays(start, 6), true) };
    }
    case 'this-month': {
      const start = `${today.slice(0, 8)}01`;
      return { start: kampalaInstant(start), end: kampalaInstant(kampalaMonthEnd(today), true) };
    }
    case 'last-30': {
      const start = addKampalaDays(today, -29);
      return { start: kampalaInstant(start), end: kampalaInstant(today, true) };
    }
    case 'last-90': {
      const start = addKampalaDays(today, -89);
      return { start: kampalaInstant(start), end: kampalaInstant(today, true) };
    }
    case 'all': return { start: null, end: kampalaInstant(today, true) };
    case 'last-7':
    default: {
      const start = addKampalaDays(today, -6);
      return { start: kampalaInstant(start), end: kampalaInstant(today, true) };
    }
  }
};

// Status is derived from EFFICIENCY % (collected ÷ expected weekly)
const statusForEfficiency = (eff: number): AgentPerfRow['status'] => {
  if (eff >= 100) return 'excellent';
  if (eff >= 80) return 'good';
  if (eff >= 60) return 'moderate';
  if (eff >= 40) return 'low';
  return 'critical';
};

const STATUS_BADGE: Record<AgentPerfRow['status'], { label: string; cls: string; dot: string }> = {
  excellent: { label: 'Excellent', cls: 'bg-emerald-100 text-emerald-700 border-emerald-300', dot: 'bg-emerald-700' },
  good:      { label: 'Good',      cls: 'bg-emerald-50 text-emerald-600 border-emerald-200',  dot: 'bg-emerald-500' },
  moderate:  { label: 'Moderate',  cls: 'bg-amber-100 text-amber-700 border-amber-300',       dot: 'bg-amber-500'   },
  low:       { label: 'Low',       cls: 'bg-orange-100 text-orange-700 border-orange-300',    dot: 'bg-orange-500'  },
  critical:  { label: 'Critical',  cls: 'bg-red-100 text-red-700 border-red-300',             dot: 'bg-red-500'     },
};

const fmt = (n: number) => Math.round(n).toLocaleString();
const fmtPct = (n: number) => `${n.toFixed(1)}%`;

// ============= Column-header filter helpers =============
type NumericKey =
  | 'tenants_total' | 'daily_portfolio' | 'expected_weekly' | 'collected'
  | 'efficiency' | 'gap' | 'payments' | 'pct_paid'
  | 'commission' | 'interest' | 'wallet_total'
  | 'daily_collection' | 'daily_commission' | 'rent_paid_out' | 'conversion_pct';
type Range = { min?: number; max?: number };
type StatusKey = AgentPerfRow['status'];
type ColFilters = {
  name: string;
  status: Set<StatusKey>;
  ranges: Partial<Record<NumericKey, Range>>;
};
const EMPTY_FILTERS: ColFilters = { name: '', status: new Set(), ranges: {} };

const isRangeActive = (r?: Range) =>
  !!r && ((r.min !== undefined && !Number.isNaN(r.min)) || (r.max !== undefined && !Number.isNaN(r.max)));

function HeaderFilter({
  active,
  align = 'center',
  children,
  onClear,
 }: { active: boolean; align?: 'start' | 'center' | 'end'; children: React.ReactNode; onClear?: () => void }) {
  return (
    <span className="inline-flex items-center gap-0.5">
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          onClick={(e) => e.stopPropagation()}
          className={cn(
            'inline-flex h-5 w-5 items-center justify-center rounded hover:bg-white/20 transition-colors relative',
            active && 'bg-white/25'
          )}
          aria-label="Filter column"
        >
          <Filter className="h-3 w-3" />
          {active && <span className="absolute -top-0.5 -right-0.5 h-1.5 w-1.5 rounded-full bg-yellow-300 ring-1 ring-slate-900" />}
        </button>
      </PopoverTrigger>
      <PopoverContent align={align} className="w-60 p-3 space-y-2">
        {children}
      </PopoverContent>
    </Popover>
    {active && onClear && (
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onClear(); }}
        className="inline-flex h-4 w-4 items-center justify-center rounded hover:bg-white/25 text-white/90"
        aria-label="Clear this filter"
        title="Clear this filter"
      >
        <X className="h-3 w-3" />
      </button>
    )}
    </span>
  );
}

function TextFilter({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="space-y-2">
      <Label className="text-xs font-semibold">Search agent name</Label>
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Contains…"
        className="h-8 text-sm"
        autoFocus
      />
      {value && (
        <Button variant="ghost" size="sm" className="h-7 w-full text-xs" onClick={() => onChange('')}>
          <X className="h-3 w-3 mr-1" /> Clear
        </Button>
      )}
    </div>
  );
}

function NumericRangeFilter({
  label, value, onChange,
}: { label: string; value?: Range; onChange: (r?: Range) => void }) {
  const [min, setMin] = useState<string>(value?.min !== undefined ? String(value.min) : '');
  const [max, setMax] = useState<string>(value?.max !== undefined ? String(value.max) : '');
  const apply = () => {
    const minN = min === '' ? undefined : Number(min);
    const maxN = max === '' ? undefined : Number(max);
    if (minN === undefined && maxN === undefined) { onChange(undefined); return; }
    onChange({ min: minN, max: maxN });
  };
  const clear = () => { setMin(''); setMax(''); onChange(undefined); };
  return (
    <div className="space-y-2">
      <Label className="text-xs font-semibold">{label}</Label>
      <div className="flex items-center gap-1.5">
        <Input type="number" inputMode="numeric" value={min} onChange={(e) => setMin(e.target.value)}
          placeholder="Min" className="h-8 text-sm" />
        <span className="text-muted-foreground text-xs">–</span>
        <Input type="number" inputMode="numeric" value={max} onChange={(e) => setMax(e.target.value)}
          placeholder="Max" className="h-8 text-sm" />
      </div>
      <div className="flex gap-1.5">
        <Button size="sm" className="h-7 flex-1 text-xs" onClick={apply}>Apply</Button>
        <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={clear}>Clear</Button>
      </div>
    </div>
  );
}

function StatusMultiFilter({
  value, onChange,
}: { value: Set<StatusKey>; onChange: (next: Set<StatusKey>) => void }) {
  const options: StatusKey[] = ['excellent', 'good', 'moderate', 'low', 'critical'];
  const toggle = (k: StatusKey) => {
    const next = new Set(value);
    if (next.has(k)) next.delete(k); else next.add(k);
    onChange(next);
  };
  return (
    <div className="space-y-2">
      <Label className="text-xs font-semibold">Filter by status</Label>
      <div className="space-y-1.5">
        {options.map((k) => (
          <label key={k} className="flex items-center gap-2 cursor-pointer text-sm">
            <Checkbox checked={value.has(k)} onCheckedChange={() => toggle(k)} />
            <span className={cn('inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-semibold border', STATUS_BADGE[k].cls)}>
              {STATUS_BADGE[k].label}
            </span>
          </label>
        ))}
      </div>
      {value.size > 0 && (
        <Button variant="ghost" size="sm" className="h-7 w-full text-xs" onClick={() => onChange(new Set())}>
          <X className="h-3 w-3 mr-1" /> Clear
        </Button>
      )}
    </div>
  );
}

export function AgentPerformanceReport() {
  const [preset, setPreset] = useState<RangePreset>('last-7');
  const [paymentSource, setPaymentSource] = useState<PaymentSource>('all');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [agentSearch, setAgentSearch] = useState('');
  const [minCollected, setMinCollected] = useState('');
  // Per-column header filters
  const [colFilters, setColFilters] = useState<ColFilters>(EMPTY_FILTERS);
  const setRange = (key: NumericKey, range?: Range) =>
    setColFilters(prev => {
      const ranges = { ...prev.ranges };
      if (!range) delete ranges[key]; else ranges[key] = range;
      return { ...prev, ranges };
    });
  const range = useMemo(() => getRange(preset), [preset]);
  const startISO = range.start ? range.start.toISOString() : null;
  const endISO = range.end.toISOString();
  const periodLabel = range.start
    ? `${format(range.start, 'MMM d')} – ${format(range.end, 'MMM d, yyyy')}`
    : `All time · as of ${format(range.end, 'MMM d, yyyy')}`;

  const rpcStartISO = (range.start || kampalaInstant('2020-01-01')).toISOString();

  const { data, isLoading } = useQuery({
    queryKey: ['agent-perf-report-home-basis', rpcStartISO, endISO],
    queryFn: async () => {
      const { data: report, error } = await supabase.rpc('agent_performance_home_basis_range', {
        p_start: rpcStartISO,
        p_end: endISO,
      });

      if (error) {
        console.error('[AgentPerformanceReport] home-basis RPC failed:', error);
        toast.error(`Report query failed: ${error.message}`);
        throw error;
      }

      const payload = (report || {}) as { rows?: unknown[]; totals?: Record<string, unknown>; range?: Record<string, unknown> };
      const num = (value: unknown) => Number(value || 0);
      const rows: AgentPerfRow[] = (Array.isArray(payload.rows) ? payload.rows : []).map((row, index) => {
        const r = row as Record<string, unknown>;
        const efficiency = num(r.efficiency);
        return {
          rank: index + 1,
          agent_name: String(r.agent_name || 'Agent'),
          tenants_paid: num(r.tenants_paid),
          tenants_total: num(r.tenants_total),
          pct_paid: num(r.pct_paid),
          collected: num(r.collected),
          payments: num(r.payments),
          commission: num(r.commission),
          interest: num(r.interest),
          wallet_total: num(r.wallet_total),
          rate: num(r.rate),
          status: statusForEfficiency(efficiency),
          source_breakdown: (r.source_breakdown as AgentPerfRow['source_breakdown']) || { agent_collections: num(r.collected), repayments: 0, merchant: 0 },
          daily_portfolio: num(r.daily_portfolio),
          expected_weekly: num(r.expected_period ?? r.expected_weekly),
          efficiency,
          gap: num(r.gap),
          daily_collection: num(r.daily_collection),
          daily_commission: num(r.daily_commission),
          rent_paid_out: num(r.rent_paid_out),
          conversion_pct: num(r.conversion_pct),
        };
      });

      const t = payload.totals || {};
      const totals: AgentPerfTotals = {
        collected: num(t.collected),
        payments: num(t.payments),
        commission: num(t.commission),
        interest: num(t.interest),
        wallet_total: num(t.wallet_total),
        tenants_paid: num(t.tenants_paid),
        tenants_total: num(t.tenants_total),
        daily_portfolio: num(t.daily_portfolio),
        expected_weekly: num(t.expected_period ?? t.expected),
        gap: num(t.gap),
        daily_collection: num(t.daily_collection),
        daily_commission: num(t.daily_commission),
        rent_paid_out: num(t.rent_paid_out),
      };

      return { rows, totals, windowDays: num(payload.range?.bill_days) || 1 };
    },
    staleTime: 60_000,
  });

  const rawRows = data?.rows || [];
  // Apply client-side filters
  const minColNum = Number(minCollected) || 0;
  const search = agentSearch.trim().toLowerCase();
  const rows = useMemo(() => {
    let out = rawRows;
    if (statusFilter !== 'all') out = out.filter(r => r.status === statusFilter);
    if (search) out = out.filter(r => r.agent_name.toLowerCase().includes(search));
    if (minColNum > 0) out = out.filter(r => r.collected >= minColNum);
    // Column-header filters (AND-combined)
    const nameQ = colFilters.name.trim().toLowerCase();
    if (nameQ) out = out.filter(r => r.agent_name.toLowerCase().includes(nameQ));
    if (colFilters.status.size > 0) out = out.filter(r => colFilters.status.has(r.status));
    for (const [key, rng] of Object.entries(colFilters.ranges) as [NumericKey, Range][]) {
      if (!isRangeActive(rng)) continue;
      out = out.filter(r => {
        const v = Number((r as any)[key] ?? 0);
        if (rng.min !== undefined && !Number.isNaN(rng.min) && v < rng.min) return false;
        if (rng.max !== undefined && !Number.isNaN(rng.max) && v > rng.max) return false;
        return true;
      });
    }
    // Re-rank after filtering
    return out.map((r, i) => ({ ...r, rank: i + 1 }));
  }, [rawRows, statusFilter, search, minColNum, colFilters]);
  const totals: AgentPerfTotals = useMemo(() => rows.reduce((t, r) => ({
    collected: t.collected + r.collected,
    payments: t.payments + r.payments,
    commission: t.commission + r.commission,
    interest: t.interest + r.interest,
    wallet_total: t.wallet_total + r.wallet_total,
    tenants_paid: t.tenants_paid + r.tenants_paid,
    tenants_total: t.tenants_total + r.tenants_total,
    daily_portfolio: (t.daily_portfolio || 0) + (r.daily_portfolio || 0),
    expected_weekly: (t.expected_weekly || 0) + (r.expected_weekly || 0),
    gap: (t.gap || 0) + (r.gap || 0),
    daily_collection: (t.daily_collection || 0) + (r.daily_collection || 0),
    daily_commission: (t.daily_commission || 0) + (r.daily_commission || 0),
    rent_paid_out: (t.rent_paid_out || 0) + (r.rent_paid_out || 0),
  }), { collected: 0, payments: 0, commission: 0, interest: 0, wallet_total: 0, tenants_paid: 0, tenants_total: 0, daily_portfolio: 0, expected_weekly: 0, gap: 0, daily_collection: 0, daily_commission: 0, rent_paid_out: 0 }), [rows]);

  const overallEfficiency = (totals.expected_weekly || 0) > 0 ? (totals.collected / (totals.expected_weekly || 1)) * 100 : 0;

  // Best & Worst performer (by efficiency, must have collected > 0 to count)
  const performersByEff = useMemo(() => rows.filter(r => r.collected > 0).slice(), [rows]);
  const bestPerformer = useMemo(() =>
    performersByEff.length ? [...performersByEff].sort((a, b) => (b.efficiency || 0) - (a.efficiency || 0))[0] : null
  , [performersByEff]);
  const worstPerformer = useMemo(() =>
    performersByEff.length ? [...performersByEff].sort((a, b) => (a.efficiency || 0) - (b.efficiency || 0))[0] : null
  , [performersByEff]);
  const topConversion = useMemo(() => rows.reduce((m, r) => Math.max(m, r.conversion_pct || 0), 0), [rows]);

  const activeColFilterCount =
    (colFilters.name ? 1 : 0) +
    (colFilters.status.size > 0 ? 1 : 0) +
    Object.values(colFilters.ranges).filter(isRangeActive).length;

  const activeFilterCount =
    (statusFilter !== 'all' ? 1 : 0) +
    (search ? 1 : 0) +
    (minColNum > 0 ? 1 : 0) +
    activeColFilterCount;

  const handleDownloadPdf = async () => {
    if (!rows.length) { toast.error('No data to export'); return; }
    try {
      const blob = await generateAgentPerformancePdf({
        rows, totals, periodLabel, startDate: range.start || range.end, endDate: range.end,
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `agent_performance_${range.start ? format(range.start, 'yyyy-MM-dd') + '_' : ''}${format(range.end, 'yyyy-MM-dd')}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success('PDF downloaded');
    } catch (e: any) {
      toast.error('Failed to generate PDF', { description: e?.message });
    }
  };

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 rounded-2xl border border-border bg-card p-4">
        <div className="flex items-center gap-3">
          <div className="p-2.5 rounded-xl bg-teal-600 text-white shadow-sm">
            <FileBarChart className="h-5 w-5" />
          </div>
          <div>
            <h2 className="text-base sm:text-lg font-bold leading-tight">Agent Performance & Wallet Earnings</h2>
            <p className="text-xs text-muted-foreground">{periodLabel}</p>
          </div>
        </div>
        <div className="flex gap-2 items-center">
          <Select value={preset} onValueChange={(v) => setPreset(v as RangePreset)}>
            <SelectTrigger className="w-[140px] h-9"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Time</SelectItem>
              <SelectItem value="last-7">Last 7 Days</SelectItem>
              <SelectItem value="last-30">Last 30 Days</SelectItem>
              <SelectItem value="last-90">Last 90 Days</SelectItem>
              <SelectItem value="this-week">This Week</SelectItem>
              <SelectItem value="last-week">Last Week</SelectItem>
              <SelectItem value="this-month">This Month</SelectItem>
            </SelectContent>
          </Select>
          <Button onClick={handleDownloadPdf} className="h-9 gap-2" disabled={isLoading || !rows.length}>
            <Download className="h-4 w-4" />
            <span className="hidden sm:inline">Download PDF</span>
          </Button>
        </div>
      </div>

      {/* Filters bar */}
      <div className="rounded-2xl border border-border bg-card p-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative flex-1 min-w-[180px]">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              value={agentSearch}
              onChange={(e) => setAgentSearch(e.target.value)}
              placeholder="Search agent…"
              className="pl-8 h-9 text-sm"
            />
          </div>
          <Select value={paymentSource} onValueChange={(v) => setPaymentSource(v as PaymentSource)}>
            <SelectTrigger className="w-[170px] h-9"><SelectValue placeholder="Payment source" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Payment Sources</SelectItem>
              <SelectItem value="agent_collections">Agent Cash Collections</SelectItem>
              <SelectItem value="repayments">Tenant Repayments</SelectItem>
              <SelectItem value="merchant">Merchant Pay-ins</SelectItem>
            </SelectContent>
          </Select>
          <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as StatusFilter)}>
            <SelectTrigger className="w-[140px] h-9"><SelectValue placeholder="Status" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Statuses</SelectItem>
              <SelectItem value="excellent">Excellent</SelectItem>
              <SelectItem value="good">Good</SelectItem>
              <SelectItem value="moderate">Moderate</SelectItem>
              <SelectItem value="low">Low</SelectItem>
              <SelectItem value="critical">Critical</SelectItem>
            </SelectContent>
          </Select>
          <Input
            type="number"
            inputMode="numeric"
            value={minCollected}
            onChange={(e) => setMinCollected(e.target.value)}
            placeholder="Min UGX collected"
            className="w-[160px] h-9 text-sm"
          />
          {activeFilterCount > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="h-9 gap-1 text-xs"
              onClick={() => { setPaymentSource('all'); setStatusFilter('all'); setAgentSearch(''); setMinCollected(''); setColFilters(EMPTY_FILTERS); }}
            >
              <X className="h-3 w-3" /> Clear ({activeFilterCount})
            </Button>
          )}
          <span className="text-[11px] text-muted-foreground ml-auto">
            Showing {rows.length} of {rawRows.length} agents
          </span>
        </div>
      </div>

      {/* KPI strip — 6 colored summary cards (mimics the reference) */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
        {[
          { icon: Users,       label: 'Total Active Tenants', value: String(totals.tenants_total),                      tint: 'bg-blue-600',    text: 'text-blue-700' },
          { icon: HandCoins,   label: 'Total Daily Portfolio', value: `UGX ${fmt(totals.daily_portfolio || 0)}`,        tint: 'bg-emerald-600', text: 'text-emerald-700' },
          { icon: TrendingUp,  label: 'Expected Period', value: `UGX ${fmt(totals.expected_weekly || 0)}`,    tint: 'bg-purple-600',  text: 'text-purple-700' },
          { icon: PiggyBank,   label: 'Total Collected',      value: `UGX ${fmt(totals.collected)}`,                    tint: 'bg-sky-600',     text: 'text-sky-700' },
          { icon: Percent,     label: 'Overall Efficiency',   value: fmtPct(overallEfficiency),                         tint: 'bg-orange-500',  text: 'text-orange-600' },
          { icon: Wallet,      label: 'Total Wallet',         value: `UGX ${fmt(totals.wallet_total)}`,                 tint: 'bg-teal-600',    text: 'text-teal-700' },
          { icon: Activity,    label: 'Daily Collections (Σ)', value: `UGX ${fmt(totals.daily_collection || 0)}`,       tint: 'bg-cyan-600',    text: 'text-cyan-700' },
          { icon: HandCoins,   label: 'Daily Commissions (Σ)', value: `UGX ${fmt(totals.daily_commission || 0)}`,       tint: 'bg-fuchsia-600', text: 'text-fuchsia-700' },
          { icon: Building,    label: 'Rent Paid Out (Period)', value: `UGX ${fmt(totals.rent_paid_out || 0)}`,         tint: 'bg-indigo-600',  text: 'text-indigo-700' },
          { icon: Percent,     label: 'Top Conversion %',     value: fmtPct(topConversion),                             tint: 'bg-rose-600',    text: 'text-rose-700' },
        ].map((kpi, idx) => (
          <div key={idx} className="rounded-xl border border-border bg-card p-3 flex items-center gap-3">
            <div className={cn('h-10 w-10 rounded-full flex items-center justify-center text-white shrink-0', kpi.tint)}>
              <kpi.icon className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold leading-tight">{kpi.label}</div>
              <div className={cn('text-base font-extrabold mt-0.5 truncate', kpi.text)}>{kpi.value}</div>
            </div>
          </div>
        ))}
      </div>

      {/* Best / Worst spotlight */}
      {(bestPerformer || worstPerformer) && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {bestPerformer && (
            <div className="rounded-2xl border-2 border-emerald-500/40 bg-gradient-to-br from-emerald-50 to-card dark:from-emerald-950/30 p-4 flex items-center gap-4">
              <div className="h-12 w-12 rounded-xl bg-emerald-600 text-white flex items-center justify-center shrink-0">
                <Trophy className="h-6 w-6" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-[10px] uppercase tracking-wide font-bold text-emerald-700 dark:text-emerald-400">Top Performer</div>
                <div className="text-base font-extrabold truncate">{bestPerformer.agent_name}</div>
                <div className="text-xs text-muted-foreground mt-0.5">
                  Collected <span className="font-semibold text-foreground">UGX {fmt(bestPerformer.collected)}</span> · Efficiency <span className="font-semibold text-emerald-700">{fmtPct(bestPerformer.efficiency || 0)}</span> · Conversion <span className="font-semibold">{fmtPct(bestPerformer.conversion_pct || 0)}</span>
                </div>
              </div>
            </div>
          )}
          {worstPerformer && worstPerformer !== bestPerformer && (
            <div className="rounded-2xl border-2 border-red-500/40 bg-gradient-to-br from-red-50 to-card dark:from-red-950/30 p-4 flex items-center gap-4">
              <div className="h-12 w-12 rounded-xl bg-red-600 text-white flex items-center justify-center shrink-0">
                <AlertTriangle className="h-6 w-6" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-[10px] uppercase tracking-wide font-bold text-red-700 dark:text-red-400">Needs Attention</div>
                <div className="text-base font-extrabold truncate">{worstPerformer.agent_name}</div>
                <div className="text-xs text-muted-foreground mt-0.5">
                  Collected <span className="font-semibold text-foreground">UGX {fmt(worstPerformer.collected)}</span> · Efficiency <span className="font-semibold text-red-700">{fmtPct(worstPerformer.efficiency || 0)}</span> · Gap <span className="font-semibold text-red-700">UGX {fmt(worstPerformer.gap || 0)}</span>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Table — desktop */}
      <div className="hidden md:block rounded-2xl border border-border bg-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-white sticky top-0">
              {/* Group row */}
              <tr className="text-[11px] uppercase tracking-wide">
                <th className="bg-slate-800 px-2 py-2 text-center font-bold border-r border-slate-700" colSpan={2}>&nbsp;</th>
                <th className="bg-blue-700 px-2 py-2 text-center font-bold border-r border-blue-800" colSpan={3}>Portfolio (What They Manage)</th>
                <th className="bg-emerald-700 px-2 py-2 text-center font-bold border-r border-emerald-800" colSpan={4}>Collection Performance</th>
                <th className="bg-amber-600 px-2 py-2 text-center font-bold border-r border-amber-700" colSpan={3}>Activity</th>
                <th className="bg-purple-700 px-2 py-2 text-center font-bold border-r border-purple-800" colSpan={5}>Earnings & Payouts</th>
                <th className="bg-slate-800 px-2 py-2 text-center font-bold">Status<br/><span className="text-[9px] font-normal normal-case opacity-80">(By Efficiency)</span></th>
              </tr>
              {/* Sub-header row */}
              <tr className="text-[11px]">
                <th className="bg-slate-700 px-2 py-2 text-center font-semibold w-10">#</th>
                <th className="bg-slate-700 px-2 py-2 text-left font-semibold">
                  <span className="inline-flex items-center gap-1.5">Agent Name
                    <HeaderFilter active={!!colFilters.name} align="start" onClear={() => setColFilters(p => ({ ...p, name: '' }))}>
                      <TextFilter value={colFilters.name} onChange={(v) => setColFilters(p => ({ ...p, name: v }))} />
                    </HeaderFilter>
                  </span>
                </th>
                <th className="bg-blue-600 px-2 py-2 text-center font-semibold">
                  <span className="inline-flex items-center gap-1.5">Active<br/>Tenants
                    <HeaderFilter active={isRangeActive(colFilters.ranges.tenants_total)} onClear={() => setRange('tenants_total', undefined)}>
                      <NumericRangeFilter label="Active Tenants" value={colFilters.ranges.tenants_total} onChange={(r) => setRange('tenants_total', r)} />
                    </HeaderFilter>
                  </span>
                </th>
                <th className="bg-blue-600 px-2 py-2 text-right font-semibold">
                  <span className="inline-flex items-center gap-1.5 justify-end">Daily Portfolio<br/>(UGX)
                    <HeaderFilter active={isRangeActive(colFilters.ranges.daily_portfolio)} align="end" onClear={() => setRange('daily_portfolio', undefined)}>
                      <NumericRangeFilter label="Daily Portfolio (UGX)" value={colFilters.ranges.daily_portfolio} onChange={(r) => setRange('daily_portfolio', r)} />
                    </HeaderFilter>
                  </span>
                </th>
                <th className="bg-blue-600 px-2 py-2 text-right font-semibold">
                  <span className="inline-flex items-center gap-1.5 justify-end">Expected Period<br/>(UGX)
                    <HeaderFilter active={isRangeActive(colFilters.ranges.expected_weekly)} align="end" onClear={() => setRange('expected_weekly', undefined)}>
                      <NumericRangeFilter label="Expected Period (UGX)" value={colFilters.ranges.expected_weekly} onChange={(r) => setRange('expected_weekly', r)} />
                    </HeaderFilter>
                  </span>
                </th>
                <th className="bg-emerald-600 px-2 py-2 text-right font-semibold">
                  <span className="inline-flex items-center gap-1.5 justify-end">Collected<br/>(UGX)
                    <HeaderFilter active={isRangeActive(colFilters.ranges.collected)} align="end" onClear={() => setRange('collected', undefined)}>
                      <NumericRangeFilter label="Collected (UGX)" value={colFilters.ranges.collected} onChange={(r) => setRange('collected', r)} />
                    </HeaderFilter>
                  </span>
                </th>
                <th className="bg-emerald-600 px-2 py-2 text-right font-semibold">
                  <span className="inline-flex items-center gap-1.5 justify-end">Daily Avg<br/>Collection (UGX)
                    <HeaderFilter active={isRangeActive(colFilters.ranges.daily_collection)} align="end" onClear={() => setRange('daily_collection', undefined)}>
                      <NumericRangeFilter label="Daily Avg Collection (UGX)" value={colFilters.ranges.daily_collection} onChange={(r) => setRange('daily_collection', r)} />
                    </HeaderFilter>
                  </span>
                </th>
                <th className="bg-emerald-600 px-2 py-2 text-right font-semibold">
                  <span className="inline-flex items-center gap-1.5 justify-end">Efficiency<br/>(%)
                    <HeaderFilter active={isRangeActive(colFilters.ranges.efficiency)} align="end" onClear={() => setRange('efficiency', undefined)}>
                      <NumericRangeFilter label="Efficiency (%)" value={colFilters.ranges.efficiency} onChange={(r) => setRange('efficiency', r)} />
                    </HeaderFilter>
                  </span>
                </th>
                <th className="bg-emerald-600 px-2 py-2 text-right font-semibold">
                  <span className="inline-flex items-center gap-1.5 justify-end">Gap<br/>(UGX)
                    <HeaderFilter active={isRangeActive(colFilters.ranges.gap)} align="end" onClear={() => setRange('gap', undefined)}>
                      <NumericRangeFilter label="Gap (UGX)" value={colFilters.ranges.gap} onChange={(r) => setRange('gap', r)} />
                    </HeaderFilter>
                  </span>
                </th>
                <th className="bg-amber-500 px-2 py-2 text-right font-semibold">
                  <span className="inline-flex items-center gap-1.5 justify-end">Activities<br/>(Count)
                    <HeaderFilter active={isRangeActive(colFilters.ranges.payments)} align="end" onClear={() => setRange('payments', undefined)}>
                      <NumericRangeFilter label="Activities (Count)" value={colFilters.ranges.payments} onChange={(r) => setRange('payments', r)} />
                    </HeaderFilter>
                  </span>
                </th>
                <th className="bg-amber-500 px-2 py-2 text-right font-semibold">
                  <span className="inline-flex items-center gap-1.5 justify-end">% Paid
                    <HeaderFilter active={isRangeActive(colFilters.ranges.pct_paid)} align="end" onClear={() => setRange('pct_paid', undefined)}>
                      <NumericRangeFilter label="% Paid" value={colFilters.ranges.pct_paid} onChange={(r) => setRange('pct_paid', r)} />
                    </HeaderFilter>
                  </span>
                </th>
                <th className="bg-amber-500 px-2 py-2 text-right font-semibold">
                  <span className="inline-flex items-center gap-1.5 justify-end">Conversion<br/>(%)
                    <HeaderFilter active={isRangeActive(colFilters.ranges.conversion_pct)} align="end" onClear={() => setRange('conversion_pct', undefined)}>
                      <NumericRangeFilter label="Conversion (%)" value={colFilters.ranges.conversion_pct} onChange={(r) => setRange('conversion_pct', r)} />
                    </HeaderFilter>
                  </span>
                </th>
                <th className="bg-purple-600 px-2 py-2 text-right font-semibold">
                  <span className="inline-flex items-center gap-1.5 justify-end">10% Commission<br/>(UGX)
                    <HeaderFilter active={isRangeActive(colFilters.ranges.commission)} align="end" onClear={() => setRange('commission', undefined)}>
                      <NumericRangeFilter label="Commission (UGX)" value={colFilters.ranges.commission} onChange={(r) => setRange('commission', r)} />
                    </HeaderFilter>
                  </span>
                </th>
                <th className="bg-purple-600 px-2 py-2 text-right font-semibold">
                  <span className="inline-flex items-center gap-1.5 justify-end">Daily Commission<br/>(UGX)
                    <HeaderFilter active={isRangeActive(colFilters.ranges.daily_commission)} align="end" onClear={() => setRange('daily_commission', undefined)}>
                      <NumericRangeFilter label="Daily Commission (UGX)" value={colFilters.ranges.daily_commission} onChange={(r) => setRange('daily_commission', r)} />
                    </HeaderFilter>
                  </span>
                </th>
                <th className="bg-purple-600 px-2 py-2 text-right font-semibold">
                  <span className="inline-flex items-center gap-1.5 justify-end">0.5% Interest<br/>(UGX)
                    <HeaderFilter active={isRangeActive(colFilters.ranges.interest)} align="end" onClear={() => setRange('interest', undefined)}>
                      <NumericRangeFilter label="Interest (UGX)" value={colFilters.ranges.interest} onChange={(r) => setRange('interest', r)} />
                    </HeaderFilter>
                  </span>
                </th>
                <th className="bg-purple-600 px-2 py-2 text-right font-semibold">
                  <span className="inline-flex items-center gap-1.5 justify-end">Rent Paid<br/>Out (UGX)
                    <HeaderFilter active={isRangeActive(colFilters.ranges.rent_paid_out)} align="end" onClear={() => setRange('rent_paid_out', undefined)}>
                      <NumericRangeFilter label="Rent Paid Out (UGX)" value={colFilters.ranges.rent_paid_out} onChange={(r) => setRange('rent_paid_out', r)} />
                    </HeaderFilter>
                  </span>
                </th>
                <th className="bg-purple-600 px-2 py-2 text-right font-semibold">
                  <span className="inline-flex items-center gap-1.5 justify-end">Total Wallet<br/>(UGX)
                    <HeaderFilter active={isRangeActive(colFilters.ranges.wallet_total)} align="end" onClear={() => setRange('wallet_total', undefined)}>
                      <NumericRangeFilter label="Total Wallet (UGX)" value={colFilters.ranges.wallet_total} onChange={(r) => setRange('wallet_total', r)} />
                    </HeaderFilter>
                  </span>
                </th>
                <th className="bg-slate-700 px-2 py-2 text-center font-semibold">
                  <span className="inline-flex items-center gap-1.5 justify-center">Status
                    <HeaderFilter active={colFilters.status.size > 0} align="end" onClear={() => setColFilters(p => ({ ...p, status: new Set() }))}>
                      <StatusMultiFilter value={colFilters.status} onChange={(s) => setColFilters(p => ({ ...p, status: s }))} />
                    </HeaderFilter>
                  </span>
                </th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                Array.from({ length: 6 }).map((_, i) => (
                  <tr key={i} className="border-b border-border">
                    {Array.from({ length: 18 }).map((_, j) => (
                      <td key={j} className="px-3 py-2.5"><Skeleton className="h-4 w-full" /></td>
                    ))}
                  </tr>
                ))
              ) : rows.length === 0 ? (
                <tr><td colSpan={18} className="px-3 py-12 text-center text-muted-foreground">No agent activity in this period</td></tr>
              ) : (
                rows.map((r, i) => {
                  const eff = r.efficiency || 0;
                  const effCls = eff >= 100 ? 'text-emerald-700 font-bold'
                    : eff >= 80 ? 'text-emerald-600 font-semibold'
                    : eff >= 60 ? 'text-amber-600 font-semibold'
                    : eff >= 40 ? 'text-orange-600 font-semibold'
                    : 'text-red-600 font-semibold';
                  const gap = r.gap || 0;
                  const gapCls = gap > 0 ? 'text-red-600' : gap < 0 ? 'text-emerald-600' : 'text-muted-foreground';
                  const pctPaidCls = r.pct_paid >= 75 ? 'text-emerald-600 font-semibold' : r.pct_paid >= 50 ? 'text-amber-600' : r.pct_paid >= 25 ? 'text-orange-600' : 'text-red-600';
                  const conv = r.conversion_pct || 0;
                  const convCls = conv >= 75 ? 'text-emerald-700 font-bold' : conv >= 50 ? 'text-amber-600 font-semibold' : conv >= 25 ? 'text-orange-600 font-semibold' : 'text-red-600 font-semibold';
                  return (
                    <tr key={i} className={cn('border-b border-border hover:bg-muted/40 transition-colors', i % 2 === 0 ? 'bg-card' : 'bg-muted/20')}>
                      <td className="px-2 py-2 text-center text-muted-foreground">{r.rank}</td>
                      <td className="px-2 py-2 font-semibold whitespace-nowrap">{r.agent_name}</td>
                      <td className="px-2 py-2 text-center font-medium">{r.tenants_total}</td>
                      <td className="px-2 py-2 text-right font-mono">{fmt(r.daily_portfolio || 0)}</td>
                      <td className="px-2 py-2 text-right font-mono">{fmt(r.expected_weekly || 0)}</td>
                      <td className="px-2 py-2 text-right font-mono font-semibold">{fmt(r.collected)}</td>
                      <td className="px-2 py-2 text-right font-mono text-emerald-700">{fmt(r.daily_collection || 0)}</td>
                      <td className={cn('px-2 py-2 text-right font-mono', effCls)}>{fmtPct(eff)}</td>
                      <td className={cn('px-2 py-2 text-right font-mono', gapCls)}>{fmt(gap)}</td>
                      <td className="px-2 py-2 text-right">{r.payments}</td>
                      <td className={cn('px-2 py-2 text-right font-mono', pctPaidCls)}>{fmtPct(r.pct_paid)}</td>
                      <td className={cn('px-2 py-2 text-right font-mono', convCls)}>{fmtPct(conv)}</td>
                      <td className="px-2 py-2 text-right font-mono text-emerald-700">{fmt(r.commission)}</td>
                      <td className="px-2 py-2 text-right font-mono text-fuchsia-700">{fmt(r.daily_commission || 0)}</td>
                      <td className="px-2 py-2 text-right font-mono text-blue-600">{fmt(r.interest)}</td>
                      <td className="px-2 py-2 text-right font-mono text-indigo-700">{fmt(r.rent_paid_out || 0)}</td>
                      <td className="px-2 py-2 text-right font-mono font-bold">{fmt(r.wallet_total)}</td>
                      <td className="px-2 py-2 text-center">
                        <span className={cn('inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-semibold border', STATUS_BADGE[r.status].cls)}>
                          {STATUS_BADGE[r.status].label}
                        </span>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
            {!isLoading && rows.length > 0 && (
              <tfoot>
                <tr className="bg-slate-800 text-white font-bold">
                  <td className="px-2 py-3" />
                  <td className="px-2 py-3">TOTALS</td>
                  <td className="px-2 py-3 text-center">{totals.tenants_total}</td>
                  <td className="px-2 py-3 text-right font-mono">{fmt(totals.daily_portfolio || 0)}</td>
                  <td className="px-2 py-3 text-right font-mono">{fmt(totals.expected_weekly || 0)}</td>
                  <td className="px-2 py-3 text-right font-mono">{fmt(totals.collected)}</td>
                  <td className="px-2 py-3 text-right font-mono">{fmt(totals.daily_collection || 0)}</td>
                  <td className="px-2 py-3 text-right font-mono">{fmtPct(overallEfficiency)}</td>
                  <td className="px-2 py-3 text-right font-mono">{fmt(totals.gap || 0)}</td>
                  <td className="px-2 py-3 text-right">{totals.payments}</td>
                  <td className="px-2 py-3 text-right font-mono">{totals.tenants_total ? fmtPct((totals.tenants_paid / totals.tenants_total) * 100) : '0.0%'}</td>
                  <td className="px-2 py-3 text-right font-mono">{totals.tenants_total ? fmtPct((totals.tenants_paid / totals.tenants_total) * 100) : '0.0%'}</td>
                  <td className="px-2 py-3 text-right font-mono">{fmt(totals.commission)}</td>
                  <td className="px-2 py-3 text-right font-mono">{fmt(totals.daily_commission || 0)}</td>
                  <td className="px-2 py-3 text-right font-mono">{fmt(totals.interest)}</td>
                  <td className="px-2 py-3 text-right font-mono">{fmt(totals.rent_paid_out || 0)}</td>
                  <td className="px-2 py-3 text-right font-mono">{fmt(totals.wallet_total)}</td>
                  <td className="px-2 py-3 text-center">—</td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
        {/* Status Guide footer */}
        <div className="border-t border-border bg-muted/30 px-4 py-3 flex flex-wrap items-center gap-x-5 gap-y-2 text-[11px]">
          <span className="font-bold uppercase tracking-wide text-muted-foreground">Status Guide (By Efficiency %)</span>
          <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full bg-emerald-700" /> Excellent: ≥ 100%</span>
          <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full bg-emerald-500" /> Good: 80% – 99%</span>
          <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full bg-amber-500" /> Moderate: 60% – 79%</span>
          <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full bg-orange-500" /> Low: 40% – 59%</span>
          <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full bg-red-500" /> Critical: &lt; 40%</span>
          <span className="ml-auto flex items-center gap-1.5 text-muted-foreground"><Info className="h-3.5 w-3.5" /> Expected Period uses the same capped schedule as Home · Efficiency = Collected ÷ Expected · Gap = Expected − Collected</span>
          <span className="flex items-center gap-1.5 text-muted-foreground"><Calendar className="h-3.5 w-3.5" /> {periodLabel}</span>
        </div>
      </div>

      {/* Mobile cards */}
      <div className="md:hidden space-y-2">
        {isLoading ? (
          Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-32 w-full rounded-xl" />)
        ) : rows.length === 0 ? (
          <div className="rounded-xl border border-border bg-card p-6 text-center text-muted-foreground text-sm">No agent activity in this period</div>
        ) : (
          <>
            {rows.map((r, i) => (
              <div key={i} className="rounded-xl border border-border bg-card p-3 space-y-2">
                <div className="flex justify-between items-start">
                  <div>
                    <div className="text-xs text-muted-foreground">#{r.rank}</div>
                    <div className="font-semibold">{r.agent_name}</div>
                  </div>
                  <span className={cn('px-2 py-0.5 rounded-md text-[10px] font-semibold border', STATUS_BADGE[r.status].cls)}>
                    {STATUS_BADGE[r.status].label}
                  </span>
                </div>
                <div className="grid grid-cols-3 gap-2 text-xs">
                  <div><div className="text-muted-foreground">Tenants</div><div className="font-semibold">{r.tenants_paid}/{r.tenants_total}</div></div>
                  <div><div className="text-muted-foreground">Collected</div><div className="font-semibold">{fmt(r.collected)}</div></div>
                  <div><div className="text-muted-foreground">Activities</div><div className="font-semibold">{r.payments}</div></div>
                  <div><div className="text-muted-foreground">Daily Avg</div><div className="font-semibold text-emerald-700">{fmt(r.daily_collection || 0)}</div></div>
                  <div><div className="text-muted-foreground">Conversion</div><div className="font-semibold">{fmtPct(r.conversion_pct || 0)}</div></div>
                  <div><div className="text-muted-foreground">Rent Paid Out</div><div className="font-semibold text-indigo-700">{fmt(r.rent_paid_out || 0)}</div></div>
                  <div><div className="text-muted-foreground">Commission</div><div className="font-semibold text-emerald-600">{fmt(r.commission)}</div></div>
                  <div><div className="text-muted-foreground">Interest</div><div className="font-semibold text-blue-600">{fmt(r.interest)}</div></div>
                  <div><div className="text-muted-foreground">Wallet</div><div className="font-bold">{fmt(r.wallet_total)}</div></div>
                </div>
              </div>
            ))}
            <div className="rounded-xl border-2 border-blue-600 bg-blue-50 dark:bg-blue-950/30 p-3 space-y-2">
              <div className="font-bold text-blue-700 dark:text-blue-400">TOTALS</div>
              <div className="grid grid-cols-3 gap-2 text-xs">
                <div><div className="text-muted-foreground">Tenants</div><div className="font-bold">{totals.tenants_paid}/{totals.tenants_total}</div></div>
                <div><div className="text-muted-foreground">Collected</div><div className="font-bold">{fmt(totals.collected)}</div></div>
                <div><div className="text-muted-foreground">Wallet</div><div className="font-bold">{fmt(totals.wallet_total)}</div></div>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
