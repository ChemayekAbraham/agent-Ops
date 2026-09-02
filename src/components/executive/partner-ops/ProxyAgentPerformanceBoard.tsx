import { useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Progress } from '@/components/ui/progress';
import { cn } from '@/lib/utils';
import { formatDynamic } from '@/lib/currencyFormat';
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  ChevronLeft,
  ChevronRight,
  RefreshCw,
  Search,
  Target,
  Users,
} from 'lucide-react';
import {
  PROXY_PV_BAND_META,
  monthStartISO,
  proxyPvBand,
  useProxyTeamPv,
  type ProxyPvSort,
  type ProxyPvTeamRow,
} from '@/hooks/useProxyAgentPerformance';
import { ProxyPerformanceSection } from '@/components/agent/ProxyPerformanceSection';
import { ProxyPvStandouts } from './ProxyPvStandouts';
import { explainProxyPv } from './proxyPvExplain';

const money = (v: unknown) => formatDynamic(v);
const PAGE_SIZE = 25;
const ROSTER_SIZE = 200;

const SORTS: { key: ProxyPvSort; label: string }[] = [
  { key: 'total_pv', label: 'Total PV' },
  { key: 'performance_pct', label: 'Pace %' },
  { key: 'commitments', label: 'Commitments' },
  { key: 'new_investment', label: 'New investment' },
  { key: 'topups', label: 'Top-ups' },
  { key: 'name', label: 'Name' },
];

const BAND_RANGE: Record<keyof typeof PROXY_PV_BAND_META, string> = {
  on_track: '100%+',
  near: '80–99%',
  lagging: '50–79%',
  critical: 'Below 50%',
};

function monthOptions(count = 6): string[] {
  const out: string[] = [];
  const now = new Date();
  for (let i = 0; i < count; i++) out.push(monthStartISO(new Date(now.getFullYear(), now.getMonth() - i, 1)));
  return out;
}

function monthLabel(iso: string) {
  return new Date(`${iso}T00:00:00`).toLocaleDateString('en-GB', { month: 'short', year: 'numeric' });
}

function BandChip({ pct }: { pct: number }) {
  const band = proxyPvBand(pct);
  const meta = PROXY_PV_BAND_META[band];
  return (
    <Badge variant="outline" className={cn('gap-1 whitespace-nowrap text-[10px] font-bold', meta.className)}>
      <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', meta.dot)} />
      {meta.label} · {pct}%
    </Badge>
  );
}

/** Team-wide Performance Value board for Partnership Ops. */
export function ProxyAgentPerformanceBoard() {
  const [month, setMonth] = useState<string>(monthStartISO());
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<ProxyPvSort>('total_pv');
  const [dir, setDir] = useState<'asc' | 'desc'>('desc');
  const [page, setPage] = useState(0);
  const [drill, setDrill] = useState<ProxyPvTeamRow | null>(null);

  const q = useProxyTeamPv({ month, search, sort, dir, page, pageSize: PAGE_SIZE });
  const k = q.data?.kpis;
  const rows = q.data?.rows ?? [];
  const total = q.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  /** Whole-roster snapshot (unfiltered) so comparisons span every proxy agent, not just this page. */
  const roster = useProxyTeamPv({ month, sort: 'total_pv', dir: 'desc', page: 0, pageSize: ROSTER_SIZE });
  const rosterRows = roster.data?.rows ?? [];
  const teamAveragePv = rosterRows.length ? (roster.data?.kpis.team_total_pv ?? 0) / rosterRows.length : 0;
  const daysRemaining = k?.working_days_remaining ?? roster.data?.kpis.working_days_remaining;
  const rankOf = (id: string) => {
    const i = rosterRows.findIndex((r) => r.agent_user_id === id);
    return i >= 0 ? i + 1 : null;
  };

  const toggleSort = (key: ProxyPvSort) => {
    if (sort === key) setDir((d) => (d === 'desc' ? 'asc' : 'desc'));
    else { setSort(key); setDir(key === 'name' ? 'asc' : 'desc'); }
    setPage(0);
  };

  return (
    <div className="space-y-4">
      {/* Header + controls */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-black leading-tight">Proxy Performance Value</h2>
          <p className="text-xs text-muted-foreground">
            PV = commitments × reward + new investments 2% + top-ups 1% · month-to-date expected vs actual
          </p>
        </div>
        <Button variant="ghost" size="icon" onClick={() => void q.refetch()} aria-label="Refresh">
          <RefreshCw className={cn('h-4 w-4', q.isFetching && 'animate-spin')} />
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[180px] flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(0); }}
            placeholder="Search proxy agent or phone"
            className="h-9 pl-8 text-sm"
          />
        </div>
        <div className="flex flex-wrap gap-1.5">
          {monthOptions().map((m) => (
            <Button
              key={m}
              size="sm"
              variant={m === month ? 'default' : 'outline'}
              className="h-9 text-xs"
              onClick={() => { setMonth(m); setPage(0); }}
            >
              {monthLabel(m)}
            </Button>
          ))}
        </div>
      </div>

      {/* KPIs */}
      {q.isLoading ? (
        <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
          {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-24 rounded-2xl" />)}
        </div>
      ) : q.error ? (
        <Card><CardContent className="p-4 text-sm text-destructive">{(q.error as Error).message}</CardContent></Card>
      ) : k ? (
        <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
          {[
            { label: 'Team PV (MTD)', value: money(k.team_total_pv), sub: `Expected ${money(k.expected_mtd_pv)}` },
            { label: 'Monthly target / agent', value: money(k.monthly_pv_target), sub: `${money(k.daily_pv_target)} per working day` },
            { label: 'At or above pace', value: `${k.at_or_above_target} of ${k.agents_total}`, sub: `${k.below_target} behind pace` },
            { label: 'Working days', value: `${k.working_days_elapsed} of ${k.working_days}`, sub: `${k.working_days_remaining} remaining` },
          ].map((c) => (
            <Card key={c.label}>
              <CardContent className="p-3 space-y-1">
                <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">{c.label}</p>
                <p className="text-lg font-black tabular-nums leading-tight break-words">{c.value}</p>
                <p className="text-[10px] text-muted-foreground break-words">{c.sub}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : null}

      {/* Strongest vs falling behind, across the whole roster */}
      {!roster.error && (
        <ProxyPvStandouts
          rows={rosterRows}
          isLoading={roster.isLoading}
          teamAveragePv={teamAveragePv}
          workingDaysRemaining={daysRemaining}
          onSelect={setDrill}
        />
      )}

      {/* Band legend */}
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Pace bands</span>
        {(Object.keys(PROXY_PV_BAND_META) as (keyof typeof PROXY_PV_BAND_META)[]).map((b) => (
          <Badge key={b} variant="outline" className={cn('gap-1 whitespace-nowrap text-[10px]', PROXY_PV_BAND_META[b].className)}>
            <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', PROXY_PV_BAND_META[b].dot)} />
            {PROXY_PV_BAND_META[b].label} ({BAND_RANGE[b]})
          </Badge>
        ))}
      </div>

      {/* Sort controls */}
      <div className="flex flex-wrap gap-1.5">
        {SORTS.map((s) => (
          <Button
            key={s.key}
            size="sm"
            variant={sort === s.key ? 'secondary' : 'ghost'}
            className="h-8 gap-1 text-xs"
            onClick={() => toggleSort(s.key)}
          >
            {s.label}
            {sort === s.key && (dir === 'desc' ? <ArrowDown className="h-3 w-3" /> : <ArrowUp className="h-3 w-3" />)}
          </Button>
        ))}
      </div>

      {/* Team table */}
      <Card>
        <CardContent className="p-0">
          {q.isLoading ? (
            <div className="space-y-2 p-3">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-12 rounded-xl" />)}</div>
          ) : q.error ? (
            <div className="flex flex-col items-center gap-2 p-8 text-center">
              <AlertTriangle className="h-6 w-6 text-destructive" />
              <p className="text-sm font-bold">Couldn't load the performance table</p>
              <p className="max-w-md text-xs text-muted-foreground break-words">{(q.error as Error).message}</p>
            </div>
          ) : rows.length === 0 ? (
            <div className="flex flex-col items-center gap-2 p-8 text-center">
              <Users className="h-6 w-6 text-muted-foreground" />
              <p className="text-sm font-bold">No proxy agents match this view</p>
              <p className="max-w-md text-xs text-muted-foreground">
                Try a different month or clear the search. Agents appear here even with zero PV — only verified
                commitments and paid investment/top-up commissions count.
              </p>
            </div>
          ) : (
            <>
              {/* Desktop header */}
              <div className="hidden border-b border-border px-3 py-2 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground md:grid md:grid-cols-[1.6fr_repeat(5,1fr)_auto] md:gap-3">
                <span>Proxy agent</span>
                <span className="text-right">Commitments</span>
                <span className="text-right">New investment</span>
                <span className="text-right">Top-ups</span>
                <span className="text-right">Actual PV</span>
                <span className="text-right">Expected PV</span>
                <span className="text-right">Pace</span>
              </div>
              {rows.map((r) => {
                const why = explainProxyPv(r, { teamAveragePv, workingDaysRemaining: daysRemaining });
                const rank = rankOf(r.agent_user_id);
                return (
                <button
                  key={r.agent_user_id}
                  type="button"
                  onClick={() => setDrill(r)}
                  className="w-full border-b border-border/60 px-3 py-2.5 text-left last:border-0 hover:bg-muted/40 md:grid md:grid-cols-[1.6fr_repeat(5,1fr)_auto] md:items-start md:gap-3"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      {rank !== null && (
                        <span className="shrink-0 text-[10px] font-black tabular-nums text-muted-foreground">#{rank}</span>
                      )}
                      <p className="truncate text-sm font-bold">{r.name}</p>
                      {r.total_pv === 0 && r.commitments === 0 && (
                        <Badge variant="outline" className="shrink-0 border-warning/40 bg-warning/10 text-[9px] font-bold text-warning">
                          No verified activity
                        </Badge>
                      )}
                    </div>
                    <p className="truncate text-[10px] text-muted-foreground">
                      {r.phone || 'No phone'}{r.status ? ` · ${r.status}` : ''}
                    </p>
                    <p className="mt-1 text-[10px] leading-snug text-muted-foreground break-words">
                      <span className="font-semibold text-foreground">Why: </span>
                      {why.headline}
                      {why.leadSource ? ` Mostly from ${why.leadSource.toLowerCase()} (${why.mix[0].pct}%).` : ''}
                    </p>
                  </div>
                  <span className="hidden text-right text-xs font-semibold tabular-nums md:block">
                    {r.commitments}
                  </span>
                  <span className="hidden text-right text-xs tabular-nums md:block">{money(r.new_investment)}</span>
                  <span className="hidden text-right text-xs tabular-nums md:block">{money(r.topups)}</span>
                  <span className="hidden text-right text-xs font-black tabular-nums md:block">{money(r.total_pv)}</span>
                  <span className="hidden text-right text-xs tabular-nums text-muted-foreground md:block">
                    {money(r.expected_pv)}
                  </span>
                  <span className="hidden justify-end md:flex"><BandChip pct={r.performance_pct} /></span>

                  {/* Mobile summary */}
                  <div className="mt-1.5 space-y-1.5 md:hidden">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-black tabular-nums">{money(r.total_pv)} PV</span>
                      <div className="flex items-center gap-1.5">
                        {r.monthly_performance_pct > 100 && (
                          <span className="text-[10px] font-bold text-success">{r.monthly_performance_pct}%</span>
                        )}
                        <BandChip pct={r.performance_pct} />
                      </div>
                    </div>
                    <Progress
                      value={Math.min(r.monthly_performance_pct, 100)}
                      variant={r.monthly_performance_pct >= 100 ? 'success' : 'default'}
                      className="h-1.5"
                    />
                    {r.monthly_performance_pct > 100 && (
                      <p className="text-[10px] font-semibold text-success">
                        Target exceeded — {r.monthly_performance_pct}% achieved
                      </p>
                    )}
                    <p className="text-[10px] text-muted-foreground">
                      {r.commitments} commitments · {money(r.new_investment)} new · {money(r.topups)} top-ups · expected {money(r.expected_pv)}
                    </p>
                  </div>
                </button>
                );
              })}
            </>
          )}
        </CardContent>
      </Card>

      {total > 0 && (
        <div className="flex items-center justify-between">
          <Button variant="outline" size="sm" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
            <ChevronLeft className="h-4 w-4" /> Prev
          </Button>
          <span className="text-[11px] text-muted-foreground">Page {page + 1} of {pages} · {total} agents</span>
          <Button variant="outline" size="sm" disabled={page + 1 >= pages} onClick={() => setPage((p) => p + 1)}>
            Next <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      )}

      {/* Individual drill-down */}
      <Sheet open={!!drill} onOpenChange={(o) => { if (!o) setDrill(null); }}>
        <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-lg">
          <SheetHeader className="text-left">
            <SheetTitle className="flex items-center gap-2 text-base">
              <Target className="h-4 w-4 text-primary" /> {drill?.name}
            </SheetTitle>
            <SheetDescription className="text-xs">
              {monthLabel(month)} Performance Value · {drill?.phone || 'No phone'}
            </SheetDescription>
          </SheetHeader>
          <div className="space-y-3 pt-3">
            {drill && (() => {
              const why = explainProxyPv(drill, { teamAveragePv, workingDaysRemaining: daysRemaining });
              const rank = rankOf(drill.agent_user_id);
              return (
                <Card>
                  <CardContent className="space-y-2.5 p-3">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                        Why this score
                      </p>
                      {rank !== null && (
                        <Badge variant="outline" className="text-[10px] font-bold">
                          Rank #{rank} of {rosterRows.length}
                        </Badge>
                      )}
                    </div>
                    <p className="text-xs font-semibold leading-snug break-words">{why.headline}</p>
                    {why.mix.some((m) => m.pv > 0) && (
                      <div className="space-y-1">
                        {why.mix.filter((m) => m.pv > 0).map((m) => (
                          <div key={m.key} className="space-y-0.5">
                            <div className="flex items-center justify-between gap-2 text-[10px]">
                              <span className="text-muted-foreground">{m.label}</span>
                              <span className="font-bold tabular-nums">{money(m.pv)} · {m.pct}%</span>
                            </div>
                            <Progress value={m.pct} className="h-1" />
                          </div>
                        ))}
                      </div>
                    )}
                    {why.drivers.length > 0 && (
                      <div className="space-y-1">
                        <p className="text-[10px] font-semibold uppercase tracking-widest text-success">What is working</p>
                        <ul className="space-y-0.5 text-[11px] text-muted-foreground">
                          {why.drivers.map((d) => <li key={d} className="break-words">• {d}</li>)}
                        </ul>
                      </div>
                    )}
                    {why.gaps.length > 0 && (
                      <div className="space-y-1">
                        <p className="text-[10px] font-semibold uppercase tracking-widest text-warning">What is holding it back</p>
                        <ul className="space-y-0.5 text-[11px] text-muted-foreground">
                          {why.gaps.map((g) => <li key={g} className="break-words">• {g}</li>)}
                        </ul>
                      </div>
                    )}
                  </CardContent>
                </Card>
              );
            })()}
            {drill && <ProxyPerformanceSection agentId={drill.agent_user_id} month={month} hideHeading />}
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
