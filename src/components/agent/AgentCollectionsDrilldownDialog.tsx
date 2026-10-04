import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { formatUGX } from '@/lib/rentCalculations';
import { cn } from '@/lib/utils';
import { format } from 'date-fns';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Calendar } from '@/components/ui/calendar';
import { User, Loader2, Receipt, CalendarClock, CalendarIcon, X, SlidersHorizontal, PiggyBank, Target, ArrowRight } from 'lucide-react';

type CollectionRow = {
  id: string;
  tenant_id: string | null;
  amount: number;
  created_at: string;
  payment_method: string | null;
};

type TenantGroup = {
  tenant_id: string | null;
  name: string;
  total: number;
  rows: CollectionRow[];
};

// Africa/Kampala is a fixed UTC+3 (no DST), so date formatting via Intl is stable.
const kampalaDate = (d: Date) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Kampala',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);

const kampalaTime = (iso: string) =>
  new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Kampala',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso));

function groupByTenant(
  rows: CollectionRow[],
  nameById: Map<string, string>,
): TenantGroup[] {
  const map = new Map<string, TenantGroup>();
  for (const r of rows) {
    const key = r.tenant_id || 'unknown';
    let g = map.get(key);
    if (!g) {
      g = {
        tenant_id: r.tenant_id,
        name: (r.tenant_id && nameById.get(r.tenant_id)) || 'Unknown tenant',
        total: 0,
        rows: [],
      };
      map.set(key, g);
    }
    g.total += Number(r.amount) || 0;
    g.rows.push(r);
  }
  return Array.from(map.values()).sort((a, b) => b.total - a.total);
}

function SummaryBar({
  total,
  expectedDaily,
  headroom,
  perTenantMax,
  label,
}: {
  total: number;
  expectedDaily: number;
  headroom: number;
  perTenantMax: number;
  label: string;
}) {
  const remainingTarget = Math.max(0, expectedDaily - total);
  const remainingSlots =
    perTenantMax > 0 && headroom > 0
      ? Math.floor(Math.min(headroom, remainingTarget) / perTenantMax)
      : 0;
  const pct = expectedDaily > 0 ? Math.min(100, Math.round((total / expectedDaily) * 100)) : 0;
  const barColor = pct >= 50 ? 'bg-emerald-500' : pct >= 20 ? 'bg-amber-500' : 'bg-destructive';

  return (
    <div className="rounded-xl border border-border bg-card p-3 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-muted-foreground">
          <PiggyBank className="h-3.5 w-3.5 text-primary" />
          {label} total
        </div>
        <span className="text-sm font-extrabold tabular-nums text-foreground">{formatUGX(total)}</span>
      </div>
      {expectedDaily > 0 && (
        <>
          <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
            <div className={`h-full ${barColor} transition-all`} style={{ width: `${pct}%` }} />
          </div>
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground">
              <Target className="h-3 w-3 inline-block mr-1 -mt-0.5 text-primary" />
              {formatUGX(remainingTarget)} remaining to target
            </span>
            {remainingSlots > 0 && (
              <span className="font-semibold text-foreground">
                {remainingSlots} {remainingSlots === 1 ? 'slot' : 'slots'} left
              </span>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function MethodSummary({ rows }: { rows: CollectionRow[] }) {
  const byMethod = useMemo(() => {
    const map = new Map<string, number>();
    for (const r of rows) {
      const m = (r.payment_method || 'Other').replace(/_/g, ' ');
      map.set(m, (map.get(m) || 0) + (Number(r.amount) || 0));
    }
    return Array.from(map.entries())
      .sort((a, b) => b[1] - a[1]);
  }, [rows]);

  if (byMethod.length === 0) return null;

  return (
    <div className="rounded-xl border border-border bg-card p-3 space-y-2">
      <div className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-muted-foreground">
        <Receipt className="h-3.5 w-3.5 text-primary" />
        By method
      </div>
      <div className="flex flex-wrap gap-2">
        {byMethod.map(([method, amt]) => (
          <div
            key={method}
            className="flex items-center gap-1.5 rounded-lg bg-muted px-2.5 py-1 text-xs"
          >
            <span className="font-medium text-foreground">{method}</span>
            <span className="font-extrabold tabular-nums text-primary">{formatUGX(amt)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function CollectionList({ groups }: { groups: TenantGroup[] }) {
  if (groups.length === 0) {
    return (
      <div className="py-10 text-center text-sm text-muted-foreground">
        No collections match these filters.
      </div>
    );
  }
  return (
    <div className="space-y-3">
      {groups.map((g) => (
        <div key={g.tenant_id || 'unknown'} className="rounded-xl border border-border bg-card">
          <div className="flex items-center justify-between gap-3 p-3 border-b border-border">
            <div className="flex items-center gap-2.5 min-w-0">
              <div className="h-9 w-9 rounded-full bg-primary/15 flex items-center justify-center shrink-0">
                <User className="h-4 w-4 text-primary" />
              </div>
              <div className="min-w-0">
                <p className="text-sm font-bold text-foreground truncate">{g.name}</p>
                <p className="text-xs text-muted-foreground">
                  {g.rows.length} {g.rows.length === 1 ? 'allocation' : 'allocations'}
                </p>
              </div>
            </div>
            <span className="text-sm font-extrabold tabular-nums text-foreground shrink-0">
              {formatUGX(g.total)}
            </span>
          </div>
          <ul className="divide-y divide-border/60">
            {g.rows
              .slice()
              .sort((a, b) => b.created_at.localeCompare(a.created_at))
              .map((r) => (
                <li key={r.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                  <span className="flex items-center gap-2 text-muted-foreground min-w-0">
                    <Receipt className="h-3.5 w-3.5 shrink-0" />
                    <span className="truncate">
                      {kampalaTime(r.created_at)}
                      {r.payment_method && <> · {r.payment_method.replace(/_/g, ' ')}</>}
                    </span>
                  </span>
                  <span className="font-semibold tabular-nums text-foreground shrink-0">
                    {formatUGX(Number(r.amount) || 0)}
                  </span>
                </li>
              ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

export function AgentCollectionsDrilldownDialog({
  open,
  onOpenChange,
  agentId,
  expectedDaily = 0,
  headroom = 0,
  perTenantMax = 0,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agentId: string;
  expectedDaily?: number;
  headroom?: number;
  perTenantMax?: number;
}) {
  // ----- Filters -----
  const [methodFilter, setMethodFilter] = useState<string>('all');
  const [minAmount, setMinAmount] = useState<string>('');
  const [fromDate, setFromDate] = useState<Date | undefined>();
  const [toDate, setToDate] = useState<Date | undefined>();

  const { data, isLoading } = useQuery({
    queryKey: ['agent-collections-drilldown', agentId],
    enabled: open && !!agentId,
    staleTime: 15_000,
    queryFn: async () => {
      // Fetch a 31-day window so date-range filtering has data to work with,
      // then bucket today/yesterday precisely by Kampala date.
      const sinceISO = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
      const { data: rows, error } = await supabase
        .from('agent_collections')
        .select('id, tenant_id, amount, created_at, payment_method').is('reversed_at', null)
        .eq('agent_id', agentId)
        .gte('created_at', sinceISO)
        .order('created_at', { ascending: false });
      if (error) throw error;

      const allRows = (rows || []) as CollectionRow[];
      const tenantIds = Array.from(
        new Set(allRows.map((r) => r.tenant_id).filter(Boolean)),
      ) as string[];
      const nameById = new Map<string, string>();
      if (tenantIds.length > 0) {
        const { data: profs } = await supabase
          .from('profiles')
          .select('id, full_name, phone')
          .in('id', tenantIds);
        (profs || []).forEach((p: any) => {
          nameById.set(p.id, p.full_name || p.phone || 'Tenant');
        });
      }

      return { rows: allRows, nameById };
    },
  });

  const now = new Date();
  const todayStr = kampalaDate(now);
  const yesterdayStr = kampalaDate(new Date(now.getTime() - 24 * 60 * 60 * 1000));

  // Distinct payment methods available across the loaded window.
  const methods = useMemo(() => {
    const set = new Set<string>();
    (data?.rows ?? []).forEach((r) => { if (r.payment_method) set.add(r.payment_method); });
    return Array.from(set).sort();
  }, [data?.rows]);

  // Apply method + amount + date-range filters to the raw rows.
  const filteredRows = useMemo(() => {
    const min = Number(minAmount) || 0;
    const fromStr = fromDate ? kampalaDate(fromDate) : null;
    const toStr = toDate ? kampalaDate(toDate) : null;
    return (data?.rows ?? []).filter((r) => {
      if (methodFilter !== 'all' && r.payment_method !== methodFilter) return false;
      if (min > 0 && (Number(r.amount) || 0) < min) return false;
      if (fromStr || toStr) {
        const d = kampalaDate(new Date(r.created_at));
        if (fromStr && d < fromStr) return false;
        if (toStr && d > toStr) return false;
      }
      return true;
    });
  }, [data?.rows, methodFilter, minAmount, fromDate, toDate]);

  const nameById = data?.nameById ?? new Map<string, string>();

  const todayRows = useMemo(
    () => filteredRows.filter((r) => kampalaDate(new Date(r.created_at)) === todayStr),
    [filteredRows, todayStr],
  );
  const yesterdayRows = useMemo(
    () => filteredRows.filter((r) => kampalaDate(new Date(r.created_at)) === yesterdayStr),
    [filteredRows, yesterdayStr],
  );

  const sum = (rows: CollectionRow[]) => rows.reduce((s, r) => s + (Number(r.amount) || 0), 0);
  const todayTotal = sum(todayRows);
  const yesterdayTotal = sum(yesterdayRows);
  const rangeTotal = sum(filteredRows);

  const hasFilters = methodFilter !== 'all' || !!minAmount || !!fromDate || !!toDate;
  const clearFilters = () => {
    setMethodFilter('all');
    setMinAmount('');
    setFromDate(undefined);
    setToDate(undefined);
  };

  const dateDisabled = (d: Date) => d > now;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg p-0 gap-0 overflow-hidden">
        <DialogHeader className="p-4 pb-3 border-b border-border">
          <DialogTitle className="flex items-center gap-2 text-base">
            <CalendarClock className="h-5 w-5 text-primary" />
            Collections breakdown
          </DialogTitle>
          <DialogDescription>
            Which tenants and allocations make up your collected total.
          </DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <div className="py-16 flex items-center justify-center gap-2 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
            <span className="text-sm">Loading collections…</span>
          </div>
        ) : (
          <Tabs defaultValue="today" className="w-full">
            {/* Filter bar */}
            <div className="px-4 pt-3 space-y-2.5">
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-muted-foreground">
                  <SlidersHorizontal className="h-3.5 w-3.5" /> Filters
                </span>
                {hasFilters && (
                  <button
                    type="button"
                    onClick={clearFilters}
                    className="flex items-center gap-1 text-xs font-semibold text-primary hover:underline"
                  >
                    <X className="h-3.5 w-3.5" /> Clear
                  </button>
                )}
              </div>

              <div className="grid grid-cols-2 gap-2">
                <Popover>
                  <PopoverTrigger asChild>
                    <Button
                      variant="outline"
                      size="sm"
                      className={cn('h-9 justify-start font-normal', !fromDate && 'text-muted-foreground')}
                    >
                      <CalendarIcon className="h-3.5 w-3.5" />
                      {fromDate ? format(fromDate, 'd MMM') : 'From'}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-0" align="start">
                    <Calendar
                      mode="single"
                      selected={fromDate}
                      onSelect={setFromDate}
                      disabled={dateDisabled}
                      initialFocus
                      className={cn('p-3 pointer-events-auto')}
                    />
                  </PopoverContent>
                </Popover>
                <Popover>
                  <PopoverTrigger asChild>
                    <Button
                      variant="outline"
                      size="sm"
                      className={cn('h-9 justify-start font-normal', !toDate && 'text-muted-foreground')}
                    >
                      <CalendarIcon className="h-3.5 w-3.5" />
                      {toDate ? format(toDate, 'd MMM') : 'To'}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-0" align="start">
                    <Calendar
                      mode="single"
                      selected={toDate}
                      onSelect={setToDate}
                      disabled={dateDisabled}
                      initialFocus
                      className={cn('p-3 pointer-events-auto')}
                    />
                  </PopoverContent>
                </Popover>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <Select value={methodFilter} onValueChange={setMethodFilter}>
                  <SelectTrigger className="h-9">
                    <SelectValue placeholder="Method" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All methods</SelectItem>
                    {methods.map((m) => (
                      <SelectItem key={m} value={m}>
                        {m.replace(/_/g, ' ')}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Input
                  type="number"
                  inputMode="numeric"
                  min={0}
                  placeholder="Min amount"
                  value={minAmount}
                  onChange={(e) => setMinAmount(e.target.value)}
                  className="h-9"
                />
              </div>
            </div>

            <div className="px-4 pt-3">
              <TabsList className="grid w-full grid-cols-3">
                <TabsTrigger value="today" className="text-xs">
                  Today · {formatUGX(todayTotal)}
                </TabsTrigger>
                <TabsTrigger value="yesterday" className="text-xs">
                  Yesterday · {formatUGX(yesterdayTotal)}
                </TabsTrigger>
                <TabsTrigger value="range" className="text-xs">
                  Range · {formatUGX(rangeTotal)}
                </TabsTrigger>
              </TabsList>
            </div>
            <ScrollArea className="max-h-[55vh]">
              <div className="p-4">
                <TabsContent value="today" className="mt-0 space-y-3">
                  <SummaryBar total={todayTotal} expectedDaily={expectedDaily} headroom={headroom} perTenantMax={perTenantMax} label="Today" />
                  <MethodSummary rows={todayRows} />
                  <CollectionList groups={groupByTenant(todayRows, nameById)} />
                </TabsContent>
                <TabsContent value="yesterday" className="mt-0 space-y-3">
                  <SummaryBar total={yesterdayTotal} expectedDaily={expectedDaily} headroom={headroom} perTenantMax={perTenantMax} label="Yesterday" />
                  <MethodSummary rows={yesterdayRows} />
                  <CollectionList groups={groupByTenant(yesterdayRows, nameById)} />
                </TabsContent>
                <TabsContent value="range" className="mt-0 space-y-3">
                  <SummaryBar total={rangeTotal} expectedDaily={expectedDaily} headroom={headroom} perTenantMax={perTenantMax} label="Range" />
                  <MethodSummary rows={filteredRows} />
                  <CollectionList groups={groupByTenant(filteredRows, nameById)} />
                </TabsContent>
              </div>
            </ScrollArea>
          </Tabs>
        )}
      </DialogContent>
    </Dialog>
  );
}

export default AgentCollectionsDrilldownDialog;