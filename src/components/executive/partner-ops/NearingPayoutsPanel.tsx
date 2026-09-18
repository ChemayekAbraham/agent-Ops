import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchNearingPayoutPortfoliosWithDedupe, type NearingPayoutPortfolioData } from '@/lib/supabaseBatchUtils';
import { formatDateOnlyForDisplay } from '@/lib/portfolioDates';
import { formatUGX } from '@/lib/rentCalculations';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import {
  ArrowDown, ArrowUp, CalendarClock, CheckCircle2, Clock, Layers, Loader2, RefreshCw, Repeat, Scissors, Search, Users,
} from 'lucide-react';
import { NearingPayoutsDialog } from '@/components/coo/COOPartnersPage';

const isCompounding = (mode: string) => /compound/i.test(mode || '');

interface Row {
  portfolioId: string;
  name: string;
  portfolioName: string;
  principal: number;
  roiPercentage: number;
  expected: number;
  roiMode: string;
  compounding: boolean;
  dueDate: string;
  daysUntil: number;
  state: 'paid' | 'pending' | 'awaiting';
}

type SortKey = 'name' | 'portfolioName' | 'principal' | 'expected' | 'daysUntil' | 'state';

/**
 * Both the display rows and the dialog's payout data come from the same
 * dedupe-aware fetch (fetchNearingPayoutPortfoliosWithDedupe) — one query,
 * one "already paid this cycle" answer, so the list and the Pay/Split dialog
 * can never disagree about which portfolios are still payable.
 */
async function loadNearingRows(): Promise<{ rows: Row[]; portfolios: NearingPayoutPortfolioData[] }> {
  const portfolios = await fetchNearingPayoutPortfoliosWithDedupe();
  const rows: Row[] = portfolios.map((p) => {
    const rate = p.roiPercentage;
    return {
      portfolioId: p.portfolioId,
      name: p.name,
      portfolioName: p.portfolioName,
      principal: p.investmentAmount,
      roiPercentage: rate,
      expected: Math.round((p.investmentAmount * rate) / 100),
      roiMode: p.roiMode,
      compounding: isCompounding(p.roiMode),
      dueDate: p.nextPayoutDate,
      daysUntil: p.daysUntil,
      state: p.processedState === 'credited' ? 'paid' : p.processedState === 'pending' ? 'pending' : 'awaiting',
    };
  });
  return { rows, portfolios };
}

const RANGES: { key: string; label: string; test: (d: number) => boolean }[] = [
  { key: 'overdue', label: 'Overdue', test: (d) => d < 0 },
  { key: 'today', label: 'Due today', test: (d) => d === 0 },
  { key: '7', label: 'Next 7 days', test: (d) => d >= 0 && d <= 7 },
  { key: '30', label: 'Next 30 days', test: (d) => d >= 0 && d <= 30 },
  { key: 'all', label: 'All upcoming', test: () => true },
];

export function NearingPayoutsPanel() {
  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: ['partner-ops-nearing-payouts-list'],
    queryFn: loadNearingRows,
    staleTime: 60000,
  });
  const rows = data?.rows;
  const dialogPortfolios = data?.portfolios ?? [];

  const [payoutsDialogOpen, setPayoutsDialogOpen] = useState(false);

  const [range, setRange] = useState('7');
  const [mode, setMode] = useState('all');
  const [status, setStatus] = useState('all');
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('daysUntil');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');

  const rangeTest = RANGES.find((r) => r.key === range)?.test ?? (() => true);

  const scoped = useMemo(
    () => (rows || []).filter((r) => rangeTest(r.daysUntil)),
    [rows, range],
  );

  const kpis = useMemo(() => ({
    total: scoped.length,
    monthly: scoped.filter((r) => !r.compounding).length,
    compounding: scoped.filter((r) => r.compounding).length,
    paid: scoped.filter((r) => r.state === 'paid').length,
    pending: scoped.filter((r) => r.state === 'pending').length,
    expected: scoped.reduce((s, r) => s + r.expected, 0),
  }), [scoped]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = scoped.filter((r) => {
      if (mode === 'monthly' && r.compounding) return false;
      if (mode === 'compounding' && !r.compounding) return false;
      if (status !== 'all' && r.state !== status) return false;
      if (q && !`${r.name} ${r.portfolioName}`.toLowerCase().includes(q)) return false;
      return true;
    });
    const dir = sortDir === 'asc' ? 1 : -1;
    return [...list].sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
      return String(av).localeCompare(String(bv)) * dir;
    });
  }, [scoped, mode, status, search, sortKey, sortDir]);

  const toggleSort = (key: SortKey) => {
    if (key === sortKey) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortKey(key); setSortDir(key === 'name' || key === 'portfolioName' ? 'asc' : 'desc'); }
  };

  const SortHead = ({ k, label, className }: { k: SortKey; label: string; className?: string }) => (
    <button
      type="button"
      onClick={() => toggleSort(k)}
      className={cn('flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider text-muted-foreground hover:text-primary', className)}
    >
      {label}
      {sortKey === k && (sortDir === 'asc' ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />)}
    </button>
  );

  const kpiCards = [
    { label: 'Total portfolios', value: kpis.total, icon: Layers, tone: 'text-primary' },
    { label: 'Monthly payout', value: kpis.monthly, icon: Users, tone: 'text-blue-600' },
    { label: 'Compounding', value: kpis.compounding, icon: Repeat, tone: 'text-violet-600' },
    { label: 'Paid out', value: kpis.paid, icon: CheckCircle2, tone: 'text-emerald-600' },
    { label: 'Pending withdraw', value: kpis.pending, icon: Clock, tone: 'text-amber-600' },
  ];

  return (
    <div className="space-y-4">
      {/* ── Heading ── */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-2">
          <div className="rounded-xl bg-primary/10 p-2">
            <CalendarClock className="h-4 w-4 text-primary" />
          </div>
          <div>
            <h2 className="text-base font-black">Nearing Payouts</h2>
            <p className="text-xs text-muted-foreground">
              Portfolios whose next return date is approaching — sort, filter and track what has already been paid.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="default"
            size="sm"
            className="gap-1.5 text-xs"
            onClick={() => setPayoutsDialogOpen(true)}
            disabled={isLoading || dialogPortfolios.length === 0}
          >
            {isLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Scissors className="h-3.5 w-3.5" />}
            Pay / Split Payouts
          </Button>
          <Button variant="outline" size="sm" className="gap-1.5 text-xs" onClick={() => refetch()} disabled={isFetching}>
            <RefreshCw className={cn('h-3.5 w-3.5', isFetching && 'animate-spin')} /> Refresh
          </Button>
        </div>
      </div>

      {/* ── KPIs ── */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
        {kpiCards.map((k) => (
          <Card key={k.label} className="border-border/60">
            <CardContent className="flex items-center gap-2 p-3">
              <k.icon className={cn('h-4 w-4 shrink-0', k.tone)} />
              <div className="min-w-0">
                <p className="text-lg font-black leading-none">{isLoading ? '—' : k.value}</p>
                <p className="truncate text-[10px] text-muted-foreground">{k.label}</p>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* ── Filters ── */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Filters</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-2 pb-4 sm:grid-cols-2 lg:grid-cols-4">
          <Select value={range} onValueChange={setRange}>
            <SelectTrigger className="h-9 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              {RANGES.map((r) => <SelectItem key={r.key} value={r.key} className="text-xs">{r.label}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={mode} onValueChange={setMode}>
            <SelectTrigger className="h-9 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all" className="text-xs">All return modes</SelectItem>
              <SelectItem value="monthly" className="text-xs">Monthly payout</SelectItem>
              <SelectItem value="compounding" className="text-xs">Compounding</SelectItem>
            </SelectContent>
          </Select>
          <Select value={status} onValueChange={setStatus}>
            <SelectTrigger className="h-9 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all" className="text-xs">Any status</SelectItem>
              <SelectItem value="paid" className="text-xs">Paid out</SelectItem>
              <SelectItem value="pending" className="text-xs">Pending withdraw</SelectItem>
              <SelectItem value="awaiting" className="text-xs">Not processed</SelectItem>
            </SelectContent>
          </Select>
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search partner or portfolio"
              className="h-9 pl-8 text-xs"
            />
          </div>
        </CardContent>
      </Card>

      {/* ── List ── */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-2 pb-2">
          <CardTitle className="text-sm font-bold">
            {isLoading ? 'Loading…' : `${filtered.length} portfolio${filtered.length === 1 ? '' : 's'}`}
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            Expected returns: <span className="font-bold text-foreground">{formatUGX(kpis.expected)}</span>
          </p>
        </CardHeader>
        <CardContent className="space-y-2">
          {isLoading ? (
            <div className="space-y-2">
              {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-12 w-full rounded-lg" />)}
            </div>
          ) : filtered.length === 0 ? (
            <p className="py-8 text-center text-xs text-muted-foreground">No portfolios match these filters.</p>
          ) : (
            <>
              <div className="hidden grid-cols-12 gap-2 border-b px-3 pb-2 md:grid">
                <SortHead k="name" label="Partner" className="col-span-3" />
                <SortHead k="portfolioName" label="Portfolio" className="col-span-2" />
                <SortHead k="principal" label="Principal" className="col-span-2" />
                <SortHead k="expected" label="Expected" className="col-span-2" />
                <SortHead k="daysUntil" label="Due" className="col-span-2" />
                <SortHead k="state" label="Status" className="col-span-1" />
              </div>
              {filtered.map((r) => (
                <div
                  key={r.portfolioId}
                  className="grid grid-cols-2 items-center gap-2 rounded-lg bg-muted/40 px-3 py-2 md:grid-cols-12"
                >
                  <div className="col-span-2 min-w-0 md:col-span-3">
                    <p className="truncate text-xs font-semibold">{r.name}</p>
                    <p className="text-[10px] text-muted-foreground">{r.roiPercentage}% · {r.compounding ? 'Compounding' : 'Monthly payout'}</p>
                  </div>
                  <p className="col-span-1 truncate text-[11px] text-muted-foreground md:col-span-2">{r.portfolioName}</p>
                  <p className="col-span-1 text-[11px] font-semibold md:col-span-2">{formatUGX(r.principal)}</p>
                  <p className="col-span-1 text-[11px] font-black md:col-span-2">{formatUGX(r.expected)}</p>
                  <div className="col-span-1 md:col-span-2">
                    <p className="text-[11px] font-semibold">{formatDateOnlyForDisplay(r.dueDate)}</p>
                    <p className="text-[10px] text-muted-foreground">
                      {r.daysUntil < 0 ? `${Math.abs(r.daysUntil)}d overdue` : r.daysUntil === 0 ? 'due today' : `in ${r.daysUntil}d`}
                    </p>
                  </div>
                  <div className="col-span-2 md:col-span-1">
                    <Badge
                      variant="secondary"
                      className={cn(
                        'text-[9px]',
                        r.state === 'paid' && 'bg-emerald-500/15 text-emerald-700',
                        r.state === 'pending' && 'bg-amber-500/15 text-amber-700',
                      )}
                    >
                      {r.state === 'paid' ? 'Paid out' : r.state === 'pending' ? 'Pending' : 'Awaiting'}
                    </Badge>
                  </div>
                </div>
              ))}
            </>
          )}
        </CardContent>
      </Card>

      <NearingPayoutsDialog
        open={payoutsDialogOpen}
        onOpenChange={setPayoutsDialogOpen}
        portfolios={dialogPortfolios}
        onActionComplete={() => refetch()}
      />
    </div>
  );
}
