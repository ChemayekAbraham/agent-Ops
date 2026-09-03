import { useEffect, useMemo, useRef } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { KPICard } from '../KPICard';
import { ContactActions } from '@/components/ops/ContactActions';
import { LandlordCallDrawer } from './LandlordCallDrawer';
import { LandlordCallReportsPanel } from './LandlordCallReportsPanel';
import { formatUGX } from '@/lib/rentCalculations';
import { cn } from '@/lib/utils';
import { format } from 'date-fns';
import {
  CheckCircle2, ChevronRight, PhoneCall, PhoneMissed, RefreshCw, Search, Users,
} from 'lucide-react';
import { useSessionPersistedState } from '@/hooks/useSessionPersistedState';
import { useLandlordCallingList, type LandlordCallingRow, type LandlordCallScope } from '@/hooks/useLandlordCallingList';
import {
  LANDLORD_CALL_STATUS_LABEL,
  landlordCallStatusBadgeClass,
  type LandlordCallStatus,
} from '@/hooks/useLandlordCallReports';

type Tab = 'to_call' | 'pending' | 'closed' | 'missed' | 'all';
type SortBy = 'rent' | 'houses' | 'name';

const RECALL_OPTIONS = [3, 7, 14] as const;

const SCOPES: { key: LandlordCallScope; label: string }[] = [
  { key: 'plans', label: 'With rent plans' },
  { key: 'houses', label: 'With houses' },
  { key: 'all', label: 'All landlords' },
];

const statusOf = (r: LandlordCallingRow): LandlordCallStatus | null =>
  (r.call?.last_status || null) as LandlordCallStatus | null;

const daysSince = (iso?: string | null) =>
  iso ? Math.floor((Date.now() - new Date(iso).getTime()) / 86400000) : Infinity;

/**
 * Landlord Calling Hub — one complete calling list over the landlord
 * population, with three call statuses (Pending / Closed / Missed) plus an
 * optional comment. Call history is append-only and nothing about landlords,
 * houses or payouts is changed here.
 */
export function LandlordCallingHub() {
  const [scope, setScope] = useSessionPersistedState<LandlordCallScope>('llcall:scope', 'plans');
  const { rows, isLoading, refetch } = useLandlordCallingList(scope);
  const [tab, setTab] = useSessionPersistedState<Tab>('llcall:tab', 'to_call');
  const [search, setSearch] = useSessionPersistedState<string>('llcall:search', '');
  const [sortBy, setSortBy] = useSessionPersistedState<SortBy>('llcall:sort', 'rent');
  const [recallDays, setRecallDays] = useSessionPersistedState<(typeof RECALL_OPTIONS)[number]>('llcall:recall', 3);
  const [openId, setOpenId] = useSessionPersistedState<string | null>('llcall:openId', null);
  const [scrollY, setScrollY] = useSessionPersistedState<number>('llcall:scrollY', 0);
  const restoredScroll = useRef(false);

  const open = useMemo(
    () => (openId ? rows.find(r => r.landlord_id === openId) || null : null),
    [openId, rows],
  );

  /** Remember where the officer was, so a `tel:` round-trip lands back in place. */
  useEffect(() => {
    const save = () => setScrollY(window.scrollY);
    window.addEventListener('pagehide', save);
    window.addEventListener('visibilitychange', save);
    return () => {
      window.removeEventListener('pagehide', save);
      window.removeEventListener('visibilitychange', save);
      save();
    };
  }, [setScrollY]);

  useEffect(() => {
    if (restoredScroll.current || isLoading || !rows.length) return;
    restoredScroll.current = true;
    if (scrollY > 0) window.scrollTo({ top: scrollY });
  }, [isLoading, rows.length, scrollY]);


  /** A landlord needs calling when never called, or the last call still needs a
   *  follow-up (Pending/Missed) and is older than the re-call window. */
  const needsCall = (r: LandlordCallingRow) => {
    const s = statusOf(r);
    if (!s) return true;
    if (s === 'closed') return false;
    const follow = r.call?.last_follow_up_at;
    if (follow) return new Date(follow).getTime() <= Date.now();
    return daysSince(r.call?.last_call_at) >= recallDays;
  };

  const buckets = useMemo(() => {
    const b = { to_call: [] as LandlordCallingRow[], pending: [] as LandlordCallingRow[], closed: [] as LandlordCallingRow[], missed: [] as LandlordCallingRow[] };
    rows.forEach(r => {
      const s = statusOf(r);
      if (s === 'pending') b.pending.push(r);
      if (s === 'closed') b.closed.push(r);
      if (s === 'missed') b.missed.push(r);
      if (needsCall(r)) b.to_call.push(r);
    });
    return b;
  }, [rows, recallDays]);

  const calledToday = useMemo(
    () => rows.filter(r => r.call?.last_call_at && daysSince(r.call.last_call_at) === 0).length,
    [rows],
  );

  const visible = useMemo(() => {
    const base = tab === 'all' ? rows : buckets[tab];
    const q = search.trim().toLowerCase();
    const filtered = q
      ? base.filter(r =>
          r.landlord_name.toLowerCase().includes(q) ||
          r.phone.includes(q) ||
          (r.agent_name || '').toLowerCase().includes(q) ||
          (r.district || '').toLowerCase().includes(q) ||
          (r.village || '').toLowerCase().includes(q))
      : base;
    const sorted = [...filtered];
    sorted.sort((a, b) =>
      sortBy === 'name'
        ? a.landlord_name.localeCompare(b.landlord_name)
        : sortBy === 'houses'
          ? b.houses - a.houses
          : b.plan_rent_total - a.plan_rent_total);
    return sorted;
  }, [tab, rows, buckets, search, sortBy]);

  const tabs: { key: Tab; label: string; count: number }[] = [
    { key: 'to_call', label: 'To call', count: buckets.to_call.length },
    { key: 'pending', label: 'Pending', count: buckets.pending.length },
    { key: 'closed', label: 'Closed', count: buckets.closed.length },
    { key: 'missed', label: 'Missed', count: buckets.missed.length },
    { key: 'all', label: 'All landlords', count: rows.length },
  ];

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-5">
        <KPICard title="To call" value={isLoading ? '—' : buckets.to_call.length.toLocaleString('en-US')} icon={PhoneCall} color="bg-primary/10 text-primary" subtitle="Still need a call" />
        <KPICard title="Pending follow-up" value={isLoading ? '—' : buckets.pending.length.toLocaleString('en-US')} icon={PhoneCall} color="bg-amber-500/10 text-amber-600" />
        <KPICard title="Closed" value={isLoading ? '—' : buckets.closed.length.toLocaleString('en-US')} icon={CheckCircle2} color="bg-emerald-500/10 text-emerald-600" />
        <KPICard title="Missed" value={isLoading ? '—' : buckets.missed.length.toLocaleString('en-US')} icon={PhoneMissed} color="bg-destructive/10 text-destructive" />
        <KPICard title="Calls logged today" value={isLoading ? '—' : calledToday.toLocaleString('en-US')} icon={Users} color="bg-blue-500/10 text-blue-600" />
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <span className="flex items-center gap-2"><PhoneCall className="h-4 w-4 text-primary" /> Calling list</span>
            <Button variant="outline" size="sm" className="h-8 text-xs" onClick={() => refetch()}>
              <RefreshCw className="mr-1.5 h-3 w-3" /> Refresh
            </Button>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground">Population</span>
            {SCOPES.map(s => (
              <Button
                key={s.key}
                size="sm"
                variant={scope === s.key ? 'default' : 'outline'}
                className="h-7 px-2 text-[11px]"
                onClick={() => setScope(s.key)}
              >
                {s.label}
              </Button>
            ))}
          </div>

          <Tabs value={tab} onValueChange={v => setTab(v as Tab)}>
            <TabsList className="h-auto w-full flex-wrap justify-start gap-1">
              {tabs.map(t => (
                <TabsTrigger key={t.key} value={t.key} className="text-[11px] data-[state=active]:font-bold">
                  {t.label}
                  <span className="ml-1.5 rounded-full bg-muted px-1.5 text-[10px] tabular-nums">{t.count.toLocaleString('en-US')}</span>
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>

          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-[180px] flex-1">
              <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Search name, phone, agent, village or district…"
                className="h-8 pl-9 text-xs"
              />
            </div>
            {(['rent', 'houses', 'name'] as SortBy[]).map(s => (
              <Button
                key={s}
                size="sm"
                variant={sortBy === s ? 'default' : 'outline'}
                className="h-8 text-[11px]"
                onClick={() => setSortBy(s)}
              >
                {s === 'rent' ? 'Highest rent value' : s === 'houses' ? 'Most houses' : 'Name'}
              </Button>
            ))}
            {tab === 'to_call' && (
              <div className="flex items-center gap-1">
                <span className="text-[11px] text-muted-foreground">Call again after</span>
                {RECALL_OPTIONS.map(d => (
                  <Button
                    key={d}
                    size="sm"
                    variant={recallDays === d ? 'default' : 'outline'}
                    className="h-8 px-2 text-[11px]"
                    onClick={() => setRecallDays(d)}
                  >
                    {d}d
                  </Button>
                ))}
              </div>
            )}
          </div>

          {isLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-16 w-full" />)}
            </div>
          ) : visible.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              {tab === 'to_call' ? 'Everyone in this window has been called.' : 'Nothing here yet.'}
            </p>
          ) : (
            <ul className="space-y-1.5">
              {visible.slice(0, 300).map(r => {
                const s = statusOf(r);
                return (
                  <li key={r.landlord_id}>
                    <button
                      onClick={() => setOpenId(r.landlord_id)}
                      className="flex w-full items-center gap-2.5 rounded-lg border border-border bg-card p-2.5 text-left transition-colors hover:border-primary/40 hover:bg-muted/40 sm:gap-3 sm:p-3"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <p className="text-xs font-semibold break-words">{r.landlord_name}</p>
                          {s && (
                            <Badge variant="outline" className={cn('px-1.5 text-[9px]', landlordCallStatusBadgeClass(s))}>
                              {LANDLORD_CALL_STATUS_LABEL[s]}
                            </Badge>
                          )}
                          {!r.verified && (
                            <Badge variant="outline" className="border-amber-500/30 bg-amber-500/10 px-1.5 text-[9px] text-amber-600">
                              Unverified
                            </Badge>
                          )}
                          {r.empty_houses > 0 && (
                            <Badge variant="outline" className="px-1.5 text-[9px]">
                              {r.empty_houses} empty
                            </Badge>
                          )}
                        </div>
                        <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground break-words">
                          {r.phone || 'No phone'} · Agent {r.agent_name} · {r.district || r.village || '—'}
                        </p>
                        <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
                          {r.houses} house{r.houses === 1 ? '' : 's'} · {r.plans} plan{r.plans === 1 ? '' : 's'}
                          {' · '}Rent value <span className="font-semibold text-foreground tabular-nums">{formatUGX(r.plan_rent_total)}</span>
                          {' · '}Paid <span className="tabular-nums">{formatUGX(r.paid_total)}</span>
                          {r.call?.last_call_at && ` · Last call ${format(new Date(r.call.last_call_at), 'dd MMM')}`}
                        </p>
                      </div>
                      <ContactActions phone={r.phone} size="xs" />
                      <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {visible.length > 300 && (
            <p className="text-center text-[11px] text-muted-foreground">
              Showing the first 300 of {visible.length.toLocaleString('en-US')} — narrow the search to see more.
            </p>
          )}
        </CardContent>
      </Card>

      <LandlordCallReportsPanel
        rows={rows}
        filteredRows={visible}
        filterLabel={tabs.find(t => t.key === tab)?.label}
        searchLabel={search.trim() || undefined}
      />

      <LandlordCallDrawer row={open} open={!!open} onClose={() => setOpenId(null)} />
    </div>
  );
}
