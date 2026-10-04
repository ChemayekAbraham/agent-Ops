import { useMemo, useState } from 'react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { UserDrilldownDrawer } from '@/components/ops/UserDrilldownDrawer';
import {
  useOpsCounterBreakdown, useOpsCounterItems, counterLevel,
  type CounterPath, type CounterWindow, type CounterKind, type CounterBreakdownRow,
} from '@/hooks/useWelileOpsCounters';
import {
  FileText, Home, UserCheck, Handshake, Globe, MapPin, ChevronRight,
  ChevronLeft, RefreshCw, User, ChevronDown, ChevronUp, Phone,
  Search, ArrowUpDown,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useOpsZoneAgents, useOpsZoneLandlords, type ZoneAgentRow, type ZoneLandlordRow } from '@/hooks/useWelileOpsCounters';
import { Activity } from 'lucide-react';

const KINDS: { kind: CounterKind; label: string; short: string; icon: React.ElementType; field: keyof CounterBreakdownRow; tone: string }[] = [
  { kind: 'rent', label: 'New rent requests', short: 'Rent', icon: FileText, field: 'rent_count', tone: 'text-emerald-600 bg-emerald-500/10' },
  { kind: 'landlord', label: 'Landlords by agents', short: 'Landlords', icon: Home, field: 'landlord_count', tone: 'text-[#9234EA] bg-[#9234EA]/10' },
  { kind: 'agent', label: 'Agents by agents', short: 'Agents', icon: UserCheck, field: 'agent_count', tone: 'text-blue-600 bg-blue-500/10' },
  { kind: 'promissory', label: 'Promissory notes', short: 'Notes', icon: Handshake, field: 'promissory_count', tone: 'text-amber-600 bg-amber-500/10' },
];

const WINDOWS: { id: CounterWindow; label: string }[] = [
  { id: '7d', label: '7 days' },
  { id: '30d', label: '30 days' },
  { id: 'all', label: 'All time' },
];

const LEVEL_LABEL: Record<string, string> = {
  continent: 'continent', country: 'country', city: 'city / town', agent: 'agent',
};
const LEVEL_ICON: Record<string, React.ElementType> = {
  continent: Globe, country: MapPin, city: MapPin, agent: User,
};

const REFRESH_OPTIONS = [5, 10, 30];

// Funnel / activation health classification (Booking funded% + Airbnb activation)
function pct(part: number, whole: number): number {
  return whole > 0 ? Math.round((part / whole) * 100) : 0;
}
function healthTone(fundedPct: number, hasDemand: boolean) {
  if (!hasDemand) return { label: 'No demand', cls: 'text-muted-foreground bg-muted', bar: 'bg-muted-foreground/40' };
  if (fundedPct >= 70) return { label: 'Healthy', cls: 'text-emerald-600 bg-emerald-500/10', bar: 'bg-emerald-500' };
  if (fundedPct >= 40) return { label: 'Watch', cls: 'text-amber-600 bg-amber-500/10', bar: 'bg-amber-500' };
  return { label: 'Stalled', cls: 'text-red-600 bg-red-500/10', bar: 'bg-red-500' };
}

export function WelileOpsCounterBand() {
  const [win, setWin] = useState<CounterWindow>('7d');
  const [path, setPath] = useState<CounterPath>({});
  const [collapsed, setCollapsed] = useState(false);
  const [items, setItems] = useState<{ agentId: string; agentName: string; kind: CounterKind } | null>(null);
  const [drawer, setDrawer] = useState<{ tenantId?: string | null; agentId?: string | null; landlordId?: string | null; tab: 'tenant' | 'agent' | 'landlord' } | null>(null);
  const [funnel, setFunnel] = useState<{ path: CounterPath; label: string } | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [refreshSec, setRefreshSec] = useState(10);

  const intervalMs = autoRefresh ? refreshSec * 1000 : false;
  const level = counterLevel(path);
  const { data: rows, isLoading, isFetching, refetch } = useOpsCounterBreakdown(path, win, intervalMs) as any;
  const list: CounterBreakdownRow[] = rows ?? [];

  const totals = useMemo(() => {
    return list.reduce(
      (acc, r) => {
        acc.rent += r.rent_count; acc.landlord += r.landlord_count;
        acc.agent += r.agent_count; acc.promissory += r.promissory_count;
        acc.funded += r.rent_funded_count ?? 0;
        return acc;
      },
      { rent: 0, landlord: 0, agent: 0, promissory: 0, funded: 0 },
    );
  }, [list]);

  // Zone-level agent activation is summed only at the agent level (distinct per bucket);
  // at higher levels we approximate from the deepest distinct agents available.
  const agentTotals = useMemo(() => {
    return list.reduce(
      (acc, r) => {
        acc.distinct += r.distinct_agents ?? 0;
        acc.active += r.active_agents ?? 0;
        return acc;
      },
      { distinct: 0, active: 0 },
    );
  }, [list]);

  const fundedPctAll = pct(totals.funded, totals.rent);
  const activationPctAll = pct(agentTotals.active, agentTotals.distinct);
  const healthAll = healthTone(fundedPctAll, totals.rent > 0);

  const crumbs: { label: string; onClick: () => void }[] = [
    { label: 'All', onClick: () => setPath({}) },
  ];
  if (path.continent) crumbs.push({ label: path.continent, onClick: () => setPath({ continent: path.continent }) });
  if (path.country) crumbs.push({ label: path.country, onClick: () => setPath({ continent: path.continent, country: path.country }) });
  if (path.city) crumbs.push({ label: path.city, onClick: () => setPath({ ...path }) });

  const drillInto = (row: CounterBreakdownRow) => {
    if (level === 'continent') setPath({ continent: row.bucket_key });
    else if (level === 'country') setPath({ ...path, country: row.bucket_key });
    else if (level === 'city') setPath({ ...path, city: row.bucket_key });
  };

  const zonePathFor = (row: CounterBreakdownRow): CounterPath => {
    if (level === 'continent') return { continent: row.bucket_key };
    if (level === 'country') return { continent: path.continent, country: row.bucket_key };
    if (level === 'city') return { ...path, city: row.bucket_key };
    return { ...path };
  };

  const goBack = () => {
    if (path.city) setPath({ continent: path.continent, country: path.country });
    else if (path.country) setPath({ continent: path.continent });
    else if (path.continent) setPath({});
  };

  const totalAll = totals.rent + totals.landlord + totals.agent + totals.promissory;

  return (
    <Card className="p-3 sm:p-4 border-border">
      {/* Header */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="min-w-0">
          <h3 className="text-sm font-extrabold leading-tight flex items-center gap-1.5">
            <Globe className="h-4 w-4 text-primary" /> Operations Counter
          </h3>
          <p className="text-[11px] text-muted-foreground">
            New activity across every continent, country, city &amp; agent — drill to the source &amp; profile.
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          {autoRefresh && (
            <div className="flex items-center gap-1">
              {REFRESH_OPTIONS.map((sec) => (
                <button
                  key={sec}
                  onClick={() => setRefreshSec(sec)}
                  className={cn(
                    'px-1.5 py-0.5 rounded text-[10px] font-semibold border transition',
                    refreshSec === sec
                      ? 'bg-primary text-primary-foreground border-primary'
                      : 'bg-card text-muted-foreground border-border hover:bg-muted/40',
                  )}
                >
                  {sec}s
                </button>
              ))}
            </div>
          )}
          <div className="flex items-center gap-1.5 rounded-lg border border-border px-2 py-0.5 bg-card">
            <span className={cn('text-[10px] font-semibold', autoRefresh ? 'text-emerald-600' : 'text-muted-foreground')}>
              {autoRefresh ? 'Live' : 'Auto'}
            </span>
            <Switch
              checked={autoRefresh}
              onCheckedChange={setAutoRefresh}
              className="scale-75"
            />
          </div>
          <div className="flex rounded-lg border border-border overflow-hidden">
            {WINDOWS.map((w) => (
              <button
                key={w.id}
                onClick={() => setWin(w.id)}
                className={cn(
                  'px-2.5 py-1 text-[11px] font-semibold transition',
                  win === w.id ? 'bg-primary text-primary-foreground' : 'bg-card hover:bg-muted/40',
                )}
              >
                {w.label}
              </button>
            ))}
          </div>
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => refetch()}>
            <RefreshCw className={cn('h-4 w-4', (isFetching || isLoading) && 'animate-spin')} />
          </Button>
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setCollapsed((c) => !c)}>
            {collapsed ? <ChevronDown className="h-4 w-4" /> : <ChevronUp className="h-4 w-4" />}
          </Button>
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-3">
        {KINDS.map((k) => {
          const Icon = k.icon;
          const val = k.kind === 'rent' ? totals.rent : k.kind === 'landlord' ? totals.landlord : k.kind === 'agent' ? totals.agent : totals.promissory;
          return (
            <div key={k.kind} className="rounded-xl border border-border bg-card p-2.5 flex items-center gap-2">
              <div className={cn('p-1.5 rounded-lg shrink-0', k.tone)}><Icon className="h-4 w-4" /></div>
              <div className="min-w-0">
                <p className="text-lg font-bold leading-none">{isLoading ? '—' : val.toLocaleString()}</p>
                <p className="text-[10px] text-muted-foreground truncate">{k.label}</p>
              </div>
            </div>
          );
        })}
      </div>

      {/* Zone health: funnel (funded%) + activation (producing agents) */}
      {!isLoading && (totals.rent > 0 || agentTotals.distinct > 0) && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-2">
          <div className="rounded-xl border border-border bg-card p-2.5">
            <div className="flex items-center justify-between mb-1">
              <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">Rent funded</p>
              <Badge className={cn('text-[10px]', healthAll.cls)}>{healthAll.label}</Badge>
            </div>
            <div className="flex items-baseline gap-1.5">
              <span className="text-lg font-bold leading-none">{fundedPctAll}%</span>
              <span className="text-[11px] text-muted-foreground">{totals.funded.toLocaleString()} / {totals.rent.toLocaleString()} requests</span>
            </div>
            <div className="h-1.5 rounded-full bg-muted mt-1.5 overflow-hidden">
              <div className={cn('h-full rounded-full transition-all', healthAll.bar)} style={{ width: `${fundedPctAll}%` }} />
            </div>
          </div>
          <div className="rounded-xl border border-border bg-card p-2.5">
            <div className="flex items-center justify-between mb-1">
              <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">Agents producing</p>
              <Badge variant="outline" className="text-[10px]">{activationPctAll}% active</Badge>
            </div>
            <div className="flex items-baseline gap-1.5">
              <span className="text-lg font-bold leading-none">{agentTotals.active.toLocaleString()}</span>
              <span className="text-[11px] text-muted-foreground">of {agentTotals.distinct.toLocaleString()} contributing agents funded ≥1</span>
            </div>
            <div className="h-1.5 rounded-full bg-muted mt-1.5 overflow-hidden">
              <div className="h-full rounded-full bg-blue-500 transition-all" style={{ width: `${activationPctAll}%` }} />
            </div>
          </div>
        </div>
      )}

      {!collapsed && (
        <>
          {/* Breadcrumbs */}
          <div className="flex items-center gap-1 mt-3 flex-wrap text-xs">
            {(path.continent) && (
              <Button variant="ghost" size="sm" className="h-7 px-2 gap-1" onClick={goBack}>
                <ChevronLeft className="h-3.5 w-3.5" /> Back
              </Button>
            )}
            {crumbs.map((c, i) => (
              <span key={i} className="flex items-center gap-1">
                {i > 0 && <ChevronRight className="h-3 w-3 text-muted-foreground" />}
                <button
                  onClick={c.onClick}
                  className={cn('px-1.5 py-0.5 rounded hover:bg-muted/50', i === crumbs.length - 1 ? 'font-bold' : 'text-muted-foreground')}
                >
                  {c.label}
                </button>
              </span>
            ))}
            <Badge variant="outline" className="ml-1 text-[10px]">
              by {LEVEL_LABEL[level]}
            </Badge>
          </div>

          {/* Tiles */}
          <div className="mt-2 space-y-1.5">
            {isLoading ? (
              Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-14 w-full" />)
            ) : list.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-6">No activity in this window.</p>
            ) : (
              list.map((row) => {
                const RowIcon = LEVEL_ICON[level];
                const isAgent = level === 'agent';
                const rowFundedPct = pct(row.rent_funded_count ?? 0, row.rent_count ?? 0);
                const rowHealth = healthTone(rowFundedPct, (row.rent_count ?? 0) > 0);
                const rowActivePct = pct(row.active_agents ?? 0, row.distinct_agents ?? 0);
                return (
                  <div
                    key={row.bucket_key}
                    className={cn(
                      'rounded-xl border border-border bg-card p-2.5',
                      !isAgent && 'hover:bg-muted/40 cursor-pointer transition',
                    )}
                    onClick={!isAgent ? () => drillInto(row) : undefined}
                  >
                    <div className="flex items-center gap-2">
                      <RowIcon className="h-4 w-4 text-muted-foreground shrink-0" />
                      <span className="font-semibold text-sm truncate flex-1">{row.bucket_label}</span>
                      {(row.rent_count ?? 0) > 0 && (
                        <Badge className={cn('shrink-0 text-[10px]', rowHealth.cls)}>{rowHealth.label}</Badge>
                      )}
                      <Badge className="shrink-0">{row.total_count.toLocaleString()}</Badge>
                      {!isAgent && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6 shrink-0"
                          title="View activation funnel"
                          onClick={(e) => { e.stopPropagation(); setFunnel({ path: zonePathFor(row), label: row.bucket_label }); }}
                        >
                          <Activity className="h-3.5 w-3.5" />
                        </Button>
                      )}
                      {!isAgent && <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />}
                    </div>
                    {((row.rent_count ?? 0) > 0 || (row.distinct_agents ?? 0) > 0) && (
                      <div className="flex items-center gap-3 mt-2">
                        {(row.rent_count ?? 0) > 0 && (
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center justify-between text-[10px] text-muted-foreground mb-0.5">
                              <span>Funded {rowFundedPct}%</span>
                              <span>{(row.rent_funded_count ?? 0).toLocaleString()}/{(row.rent_count ?? 0).toLocaleString()}</span>
                            </div>
                            <div className="h-1 rounded-full bg-muted overflow-hidden">
                              <div className={cn('h-full rounded-full', rowHealth.bar)} style={{ width: `${rowFundedPct}%` }} />
                            </div>
                          </div>
                        )}
                        {(row.distinct_agents ?? 0) > 0 && (
                          <div className="shrink-0 text-right">
                            <p className="text-[10px] text-muted-foreground leading-none mb-0.5">Producing</p>
                            <p className="text-[11px] font-semibold leading-none">
                              {(row.active_agents ?? 0).toLocaleString()}/{(row.distinct_agents ?? 0).toLocaleString()}
                              <span className="text-muted-foreground font-normal"> · {rowActivePct}%</span>
                            </p>
                          </div>
                        )}
                      </div>
                    )}
                    <div className="flex flex-wrap gap-1.5 mt-2">
                      {KINDS.map((k) => {
                        const v = (row[k.field] as number) ?? 0;
                        const clickable = isAgent && v > 0 && !!row.agent_id;
                        return (
                          <button
                            key={k.kind}
                            disabled={!clickable}
                            onClick={clickable ? (e) => {
                              e.stopPropagation();
                              setItems({ agentId: row.agent_id!, agentName: row.bucket_label, kind: k.kind });
                            } : undefined}
                            className={cn(
                              'flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium border border-border',
                              v === 0 ? 'opacity-40' : k.tone,
                              clickable && 'hover:ring-1 hover:ring-primary cursor-pointer',
                            )}
                          >
                            <k.icon className="h-3 w-3" />
                            {k.short}: {v.toLocaleString()}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              })
            )}
          </div>
          {level === 'agent' && list.length > 0 && (
            <p className="text-[10px] text-muted-foreground mt-2">Tap a counter chip above to open its source list and profiles.</p>
          )}
        </>
      )}

      <ItemsDialog
        target={items}
        win={win}
        refetchIntervalMs={intervalMs}
        onClose={() => setItems(null)}
        onOpenProfile={(row) => {
          if (row.drawer_tab === 'landlord') setDrawer({ landlordId: row.profile_id, tab: 'landlord' });
          else if (row.drawer_tab === 'agent') setDrawer({ agentId: row.profile_id, tab: 'agent' });
          else setDrawer({ tenantId: row.profile_id, tab: 'tenant' });
        }}
      />

      <ZoneFunnelDialog
        target={funnel}
        win={win}
        refetchIntervalMs={intervalMs}
        onClose={() => setFunnel(null)}
        onOpenAgent={(agentId) => setDrawer({ agentId, tab: 'agent' })}
        onOpenLandlord={(landlordId) => setDrawer({ landlordId, tab: 'landlord' })}
      />

      <UserDrilldownDrawer
        open={!!drawer}
        onOpenChange={(v) => { if (!v) setDrawer(null); }}
        tenantId={drawer?.tenantId ?? null}
        agentId={drawer?.agentId ?? null}
        landlordId={drawer?.landlordId ?? null}
        defaultTab={drawer?.tab ?? 'tenant'}
      />
    </Card>
  );
}

function ItemsDialog({
  target, win, refetchIntervalMs, onClose, onOpenProfile,
}: {
  target: { agentId: string; agentName: string; kind: CounterKind } | null;
  win: CounterWindow;
  refetchIntervalMs?: number | false;
  onClose: () => void;
  onOpenProfile: (row: import('@/hooks/useWelileOpsCounters').CounterItemRow) => void;
}) {
  const meta = KINDS.find((k) => k.kind === target?.kind);
  const { data, isLoading } = useOpsCounterItems(target?.agentId ?? null, target?.kind ?? null, win, refetchIntervalMs);

  return (
    <Dialog open={!!target} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-w-md p-0 gap-0">
        <DialogHeader className="p-4 pb-2">
          <DialogTitle className="text-base flex items-center gap-2">
            {meta && <meta.icon className="h-4 w-4" />}
            {meta?.label} · {target?.agentName}
          </DialogTitle>
        </DialogHeader>
        <ScrollArea className="max-h-[60vh] px-4 pb-4">
          {isLoading ? (
            <div className="space-y-2">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-14 w-full" />)}</div>
          ) : !data || data.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-6">No records found.</p>
          ) : (
            <ul className="space-y-1.5">
              {data.map((row) => (
                <li
                  key={row.item_id}
                  onClick={() => row.profile_id && onOpenProfile(row)}
                  className={cn(
                    'rounded-lg border border-border bg-card p-3 flex items-center gap-2',
                    row.profile_id ? 'hover:bg-muted/40 cursor-pointer' : 'opacity-70',
                  )}
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold truncate">{row.title}</p>
                    <p className="text-xs text-muted-foreground truncate flex items-center gap-1">
                      {row.subtitle?.match(/^\+?\d/) ? <Phone className="h-3 w-3" /> : null}
                      {row.subtitle || '—'}
                    </p>
                  </div>
                  {row.profile_id && <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />}
                </li>
              ))}
            </ul>
          )}
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: '2-digit' });
}

function ZoneFunnelDialog({
  target, win, refetchIntervalMs, onClose, onOpenAgent, onOpenLandlord,
}: {
  target: { path: CounterPath; label: string } | null;
  win: CounterWindow;
  refetchIntervalMs?: number | false;
  onClose: () => void;
  onOpenAgent: (agentId: string) => void;
  onOpenLandlord: (landlordId: string) => void;
}) {
  const [tab, setTab] = useState<'agents' | 'landlords'>('agents');
  const [landlordSearch, setLandlordSearch] = useState('');
  type LandlordSort = 'name_asc' | 'name_desc' | 'activity_desc' | 'activity_asc' | 'producing' | 'rent_desc';
  const [landlordSort, setLandlordSort] = useState<LandlordSort>('activity_desc');
  const { data: agentData, isLoading: agentsLoading } = useOpsZoneAgents(target?.path ?? null, win, !!target, refetchIntervalMs);
  const { data: landlordData, isLoading: landlordsLoading } =
    useOpsZoneLandlords(target?.path ?? null, win, !!target && tab === 'landlords', refetchIntervalMs);
  const agents: ZoneAgentRow[] = agentData ?? [];
  const landlords: ZoneLandlordRow[] = landlordData ?? [];

  const searchLower = landlordSearch.trim().toLowerCase();
  const filteredLandlords = useMemo(() => {
    let result = [...landlords];
    if (searchLower) {
      result = result.filter((l) =>
        (l.landlord_name?.toLowerCase().includes(searchLower) ?? false) ||
        (l.landlord_phone?.toLowerCase().includes(searchLower) ?? false) ||
        (l.agent_name?.toLowerCase().includes(searchLower) ?? false) ||
        (l.is_producing && searchLower === 'producing') ||
        (!l.is_producing && searchLower === 'dormant')
      );
    }
    result.sort((a, b) => {
      switch (landlordSort) {
        case 'name_asc': return (a.landlord_name || '').localeCompare(b.landlord_name || '');
        case 'name_desc': return (b.landlord_name || '').localeCompare(a.landlord_name || '');
        case 'activity_desc': return new Date(b.last_activity || 0).getTime() - new Date(a.last_activity || 0).getTime();
        case 'activity_asc': return new Date(a.last_activity || 0).getTime() - new Date(b.last_activity || 0).getTime();
        case 'producing': return (b.is_producing ? 1 : 0) - (a.is_producing ? 1 : 0);
        case 'rent_desc': return (b.rent_count || 0) - (a.rent_count || 0);
        default: return 0;
      }
    });
    return result;
  }, [landlords, searchLower, landlordSort]);

  const agg = agents.reduce(
    (a, r) => {
      a.rent += r.rent_count; a.funded += r.rent_funded_count;
      a.landlord += r.landlord_count; a.agentReg += r.agent_count; a.promissory += r.promissory_count;
      a.distinct += 1; if (r.is_producing) a.producing += 1;
      return a;
    },
    { rent: 0, funded: 0, landlord: 0, agentReg: 0, promissory: 0, distinct: 0, producing: 0 },
  );
  const fundedPct = pct(agg.funded, agg.rent);
  const activationPct = pct(agg.producing, agg.distinct);
  const health = healthTone(fundedPct, agg.rent > 0);
  const producingLandlords = landlords.filter((l) => l.is_producing).length;

  const FUNNEL_STAGES = [
    { label: 'Requests', value: agg.rent, tone: 'bg-emerald-500' },
    { label: 'Funded', value: agg.funded, tone: 'bg-emerald-600' },
    { label: 'Producing agents', value: agg.producing, tone: 'bg-blue-500' },
  ];
  const funnelMax = Math.max(agg.rent, 1);

  return (
    <Dialog open={!!target} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-w-lg p-0 gap-0">
        <DialogHeader className="p-4 pb-2">
          <DialogTitle className="text-base flex items-center gap-2">
            <Activity className="h-4 w-4 text-primary" />
            Activation funnel · {target?.label}
          </DialogTitle>
        </DialogHeader>
        <ScrollArea className="max-h-[68vh] px-4 pb-4">
          {agentsLoading ? (
            <div className="space-y-2">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-14 w-full" />)}</div>
          ) : agents.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-6">No activity in this window.</p>
          ) : (
            <>
              {/* Funnel summary */}
              <div className="rounded-xl border border-border bg-card p-3 mb-3">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">Funnel</span>
                  <div className="flex items-center gap-1.5">
                    <Badge className={cn('text-[10px]', health.cls)}>{health.label}</Badge>
                    <Badge variant="outline" className="text-[10px]">{fundedPct}% funded</Badge>
                    <Badge variant="outline" className="text-[10px]">{activationPct}% active</Badge>
                  </div>
                </div>
                <div className="space-y-1.5">
                  {FUNNEL_STAGES.map((s) => (
                    <div key={s.label}>
                      <div className="flex items-center justify-between text-[11px] mb-0.5">
                        <span className="text-muted-foreground">{s.label}</span>
                        <span className="font-semibold">{s.value.toLocaleString()}</span>
                      </div>
                      <div className="h-2 rounded-full bg-muted overflow-hidden">
                        <div className={cn('h-full rounded-full transition-all', s.tone)} style={{ width: `${pct(s.value, funnelMax)}%` }} />
                      </div>
                    </div>
                  ))}
                </div>
                <div className="flex flex-wrap gap-1.5 mt-2 text-[10px] text-muted-foreground">
                  <span>Landlords: <b className="text-foreground">{agg.landlord}</b></span>
                  <span>· Agents: <b className="text-foreground">{agg.agentReg}</b></span>
                  <span>· Notes: <b className="text-foreground">{agg.promissory}</b></span>
                  <span>· Agents: <b className="text-foreground">{agg.producing}/{agg.distinct} producing</b></span>
                </div>
              </div>

              {/* Agents / Landlords toggle */}
              <div className="flex rounded-lg border border-border overflow-hidden mb-2 w-full">
                <button
                  onClick={() => setTab('agents')}
                  className={cn('flex-1 px-2.5 py-1.5 text-[11px] font-semibold transition flex items-center justify-center gap-1',
                    tab === 'agents' ? 'bg-primary text-primary-foreground' : 'bg-card hover:bg-muted/40')}
                >
                  <UserCheck className="h-3.5 w-3.5" /> Agents ({agents.length})
                </button>
                <button
                  onClick={() => setTab('landlords')}
                  className={cn('flex-1 px-2.5 py-1.5 text-[11px] font-semibold transition flex items-center justify-center gap-1',
                    tab === 'landlords' ? 'bg-primary text-primary-foreground' : 'bg-card hover:bg-muted/40')}
                >
                  <Home className="h-3.5 w-3.5" /> Landlords{landlords.length > 0 ? ` (${landlords.length})` : ''}
                </button>
              </div>

              {tab === 'agents' ? (
              <>
              <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide mb-1.5">
                Contributing agents ({agents.length})
              </p>
              <ul className="space-y-1.5">
                {agents.map((a) => {
                  const aFundedPct = pct(a.rent_funded_count, a.rent_count);
                  return (
                    <li
                      key={a.agent_id}
                      onClick={() => onOpenAgent(a.agent_id)}
                      className="rounded-lg border border-border bg-card p-3 hover:bg-muted/40 cursor-pointer"
                    >
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-sm truncate flex-1">{a.agent_name || 'Unknown agent'}</span>
                        {a.is_producing ? (
                          <Badge className="text-[10px] text-emerald-600 bg-emerald-500/10 shrink-0">Producing</Badge>
                        ) : (
                          <Badge variant="outline" className="text-[10px] shrink-0">Dormant</Badge>
                        )}
                        <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
                      </div>
                      {a.agent_phone && (
                        <p className="text-[11px] text-muted-foreground flex items-center gap-1 mt-0.5">
                          <Phone className="h-3 w-3" /> {a.agent_phone}
                        </p>
                      )}
                      <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-1.5 text-[10px] text-muted-foreground">
                        <span>Rent: <b className="text-foreground">{a.rent_funded_count}/{a.rent_count}</b> ({aFundedPct}%)</span>
                        <span>Landlords: <b className="text-foreground">{a.landlord_count}</b></span>
                        <span>Agents: <b className="text-foreground">{a.agent_count}</b></span>
                        <span>Notes: <b className="text-foreground">{a.promissory_count}</b></span>
                      </div>
                      <p className="text-[10px] text-muted-foreground mt-1">
                        First {fmtDate(a.first_activity)} · Last {fmtDate(a.last_activity)}
                      </p>
                    </li>
                  );
                })}
              </ul>
              </>
              ) : (
              <>
              {/* Search + sort controls */}
              <div className="flex items-center gap-2 mb-2">
                <div className="relative flex-1 min-w-0">
                  <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
                  <Input
                    value={landlordSearch}
                    onChange={(e) => setLandlordSearch(e.target.value)}
                    placeholder="Search landlords, agents…"
                    className="pl-7 h-8 text-xs"
                  />
                </div>
                <div className="flex rounded-lg border border-border overflow-hidden shrink-0">
                  {([
                    { key: 'activity_desc', label: 'Recent' },
                    { key: 'name_asc', label: 'A–Z' },
                    { key: 'rent_desc', label: 'Rent' },
                    { key: 'producing', label: 'Active' },
                  ] as { key: LandlordSort; label: string }[]).map((s) => (
                    <button
                      key={s.key}
                      onClick={() => setLandlordSort(s.key)}
                      className={cn(
                        'px-2 py-1 text-[10px] font-semibold transition whitespace-nowrap',
                        landlordSort === s.key ? 'bg-primary text-primary-foreground' : 'bg-card hover:bg-muted/40'
                      )}
                    >
                      {s.label}
                    </button>
                  ))}
                </div>
              </div>
              <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide mb-1.5">
                Landlords {filteredLandlords.length > 0 ? `(${filteredLandlords.filter((l) => l.is_producing).length}/${filteredLandlords.length})` : ''}
                {landlordSearch && filteredLandlords.length !== landlords.length && (
                  <span className="font-normal normal-case ml-1">· {landlords.length} total</span>
                )}
              </p>
              {landlordsLoading ? (
                <div className="space-y-2">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-14 w-full" />)}</div>
              ) : filteredLandlords.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-6">
                  {landlords.length === 0 ? 'No landlords in this window.' : 'No landlords match your search.'}
                </p>
              ) : (
                <ul className="space-y-1.5">
                  {filteredLandlords.map((l) => {
                    const lFundedPct = pct(l.rent_funded_count, l.rent_count);
                    return (
                      <li
                        key={l.landlord_id}
                        onClick={() => onOpenLandlord(l.landlord_id)}
                        className="rounded-lg border border-border bg-card p-3 hover:bg-muted/40 cursor-pointer"
                      >
                        <div className="flex items-center gap-2">
                          <span className="font-semibold text-sm truncate flex-1">{l.landlord_name || 'Landlord'}</span>
                          {l.is_producing ? (
                            <Badge className="text-[10px] text-emerald-600 bg-emerald-500/10 shrink-0">Producing</Badge>
                          ) : (
                            <Badge variant="outline" className="text-[10px] shrink-0">Dormant</Badge>
                          )}
                          <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
                        </div>
                        {l.landlord_phone && (
                          <p className="text-[11px] text-muted-foreground flex items-center gap-1 mt-0.5">
                            <Phone className="h-3 w-3" /> {l.landlord_phone}
                          </p>
                        )}
                        <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-1.5 text-[10px] text-muted-foreground">
                          <span>Rent: <b className="text-foreground">{l.rent_funded_count}/{l.rent_count}</b> ({lFundedPct}%)</span>
                          {l.agent_name && <span>By <b className="text-foreground">{l.agent_name}</b></span>}
                        </div>
                        <p className="text-[10px] text-muted-foreground mt-1">
                          First {fmtDate(l.first_activity)} · Last {fmtDate(l.last_activity)}
                        </p>
                      </li>
                    );
                  })}
                </ul>
              )}
              </>
              )}
            </>
          )}
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}

export default WelileOpsCounterBand;