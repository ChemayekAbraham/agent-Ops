import { useState, useEffect, useMemo } from 'react';
import { useQuery, keepPreviousData, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle,
  AlertDialogDescription, AlertDialogFooter, AlertDialogCancel, AlertDialogAction,
} from '@/components/ui/alert-dialog';
import { toast } from 'sonner';
import {
  Search, Users, Phone, X, Loader2, UserPlus, Activity,
  ChevronLeft, ChevronRight, LayoutList, Map, ChevronRight as Chevron,
  MapPin, Mail, BadgeCheck, Home, Network, CalendarClock, ShieldAlert, ShieldOff,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { AgentAvatar } from './AgentAvatar';
import { AgentRegionBreakdown } from './AgentRegionBreakdown';
import { AgentProfile360Sheet } from './AgentProfile360Sheet';

interface DirectoryRow {
  id: string;
  full_name: string | null;
  phone: string | null;
  email: string | null;
  avatar_url: string | null;
  verified: boolean;
  territory: string | null;
  region: string | null;
  district: string | null;
  agent_tier: string | null;
  created_at: string | null;
  last_active_at: string | null;
  agent_kind: 'agent' | 'sub_agent';
  total_tenants: number;
  sub_agents_count: number;
  houses_listed: number;
  daily_target: number;
  collected_today: number;
  outstanding: number;
  last_collection_at: string | null;
  status: 'active' | 'inactive' | 'frozen';
}

interface DirectoryResponse {
  kpis: { total_agents: number; total_sub_agents: number; total_active: number; total_all: number };
  total_matched: number;
  rows: DirectoryRow[];
}

const PAGE_SIZE = 50;
const TYPE_FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'agent', label: 'Agents' },
  { value: 'sub_agent', label: 'Sub-Agents' },
] as const;
const STATUS_FILTERS = [
  { value: 'all', label: 'Any status' },
  { value: 'active', label: 'Active' },
  { value: 'inactive', label: 'Inactive' },
  { value: 'frozen', label: 'Frozen' },
] as const;

const fmt = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : n.toLocaleString();

const ugx = (n: number) => `UGX ${Math.round(Number(n) || 0).toLocaleString()}`;

const relative = (iso: string | null) => {
  if (!iso) return 'never';
  const diff = Date.now() - new Date(iso).getTime();
  const d = Math.floor(diff / 86_400_000);
  if (d <= 0) return 'today';
  if (d === 1) return 'yesterday';
  if (d < 30) return `${d}d ago`;
  if (d < 365) return `${Math.floor(d / 30)}mo ago`;
  return `${Math.floor(d / 365)}y ago`;
};

const STATUS_STYLE: Record<string, string> = {
  active: 'bg-emerald-500/10 text-emerald-700 border-emerald-300',
  inactive: 'bg-muted text-muted-foreground border-border',
  frozen: 'bg-destructive/10 text-destructive border-destructive/30',
};

const GRID_LG =
  'lg:grid-cols-[minmax(0,2.2fr)_minmax(0,1.1fr)_minmax(0,0.9fr)_minmax(0,1.4fr)_minmax(0,1fr)_92px_20px]';

export function AgentDirectory() {
  const queryClient = useQueryClient();
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [type, setType] = useState<'all' | 'agent' | 'sub_agent'>('all');
  const [status, setStatus] = useState<'all' | 'active' | 'inactive' | 'frozen'>('active');
  const [filtersOpen, setFiltersOpen] = useState(false);
  const activeFilterCount = (type !== 'all' ? 1 : 0) + (status !== 'active' ? 1 : 0);
  const [page, setPage] = useState(0);
  const [openAgentId, setOpenAgentId] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<'list' | 'region'>('region');
  const [freezeTarget, setFreezeTarget] = useState<DirectoryRow | null>(null);
  const [freezeReason, setFreezeReason] = useState('');
  const [freezing, setFreezing] = useState(false);

  const submitFreeze = async () => {
    if (!freezeTarget) return;
    const willFreeze = freezeTarget.status !== 'frozen';
    if (willFreeze && freezeReason.trim().length < 10) {
      toast.error('Reason must be at least 10 characters');
      return;
    }
    setFreezing(true);
    try {
      const { error } = await supabase.rpc('agent_ops_set_agent_frozen' as any, {
        p_agent_id: freezeTarget.id,
        p_frozen: willFreeze,
        p_reason: willFreeze ? freezeReason.trim() : null,
      });
      if (error) throw error;
      toast.success(
        `${freezeTarget.full_name || 'Agent'} ${willFreeze ? 'has been frozen' : 'has been unfrozen'}`,
      );
      setFreezeTarget(null);
      setFreezeReason('');
      await queryClient.invalidateQueries({ queryKey: ['agent-directory-v2'] });
    } catch (err: any) {
      console.error('Agent freeze toggle failed', err);
      toast.error(err?.message || 'Failed to update agent status');
    } finally {
      setFreezing(false);
    }
  };

  useEffect(() => {
    const t = setTimeout(() => { setSearch(searchInput.trim()); setPage(0); }, 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  useEffect(() => { setPage(0); }, [type, status]);

  const { data, isLoading, isFetching, error } = useQuery<DirectoryResponse>({
    queryKey: ['agent-directory-v2', search, type, status, page],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_agent_directory_v2' as any, {
        p_search: search || null,
        p_type: type,
        p_status: status,
        p_limit: PAGE_SIZE,
        p_offset: page * PAGE_SIZE,
      });
      if (error) throw error;
      return data as unknown as DirectoryResponse;
    },
    staleTime: 60_000,
    placeholderData: keepPreviousData,
  });

  const rows = data?.rows ?? [];
  const kpis = data?.kpis;
  const totalMatched = data?.total_matched ?? 0;
  const totalPages = Math.max(1, Math.ceil(totalMatched / PAGE_SIZE));
  const showingFrom = totalMatched === 0 ? 0 : page * PAGE_SIZE + 1;
  const showingTo = Math.min((page + 1) * PAGE_SIZE, totalMatched);

  const kpiCards = useMemo(() => ([
    { label: 'Total Agents', value: kpis ? fmt(kpis.total_agents) : '—', icon: Users, color: 'text-primary' },
    { label: 'Total Sub-Agents', value: kpis ? fmt(kpis.total_sub_agents) : '—', icon: UserPlus, color: 'text-violet-600' },
    { label: 'Active (Agents + Sub-Agents)', value: kpis ? fmt(kpis.total_active) : '—', icon: Activity, color: 'text-emerald-600' },
  ]), [kpis]);

  return (
    <div className="min-w-0 space-y-4">
      {openAgentId ? (
        <>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" className="h-11 min-h-11 text-sm sm:h-9 sm:min-h-9" onClick={() => setOpenAgentId(null)}>
              <ChevronLeft className="h-3.5 w-3.5 mr-1" /> Back to directory
            </Button>
            <h3 className="text-sm font-semibold">Agent profile</h3>
          </div>
          <AgentProfile360Sheet agentId={openAgentId} onOpenChange={(o) => !o && setOpenAgentId(null)} inline />
        </>
      ) : (
      <>
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-base font-semibold flex items-center gap-2 tracking-tight">
            <Users className="h-4 w-4 text-primary" />
            Agent Directory
            {kpis && <Badge variant="secondary" className="text-xs">{fmt(kpis.total_all)}</Badge>}
          </h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            Field force register — portfolio size, daily collection target and today&apos;s performance.
          </p>
        </div>
        {isFetching && !isLoading && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-1 sm:grid-cols-3 divide-y sm:divide-y-0 sm:divide-x divide-border border-y border-border">
        {kpiCards.map(k => (
          <div key={k.label} className="px-4 py-3">
            <div className="flex items-center gap-1.5">
              <k.icon className={cn('h-3.5 w-3.5', k.color)} />
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold truncate">{k.label}</p>
            </div>
            <p className="font-semibold text-2xl mt-1 tabular-nums tracking-tight">{k.value}</p>
          </div>
        ))}
      </div>

      {/* View mode toggle */}
      <div className="grid grid-cols-2 gap-1 rounded-lg bg-muted/50 p-1 sm:w-fit" role="group" aria-label="Directory view">
        <Button variant="ghost"
          onClick={() => setViewMode('list')}
          aria-pressed={viewMode === 'list'}
          className={cn('h-11 min-h-11 gap-2 text-sm px-4 rounded-md',
            viewMode === 'list' ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground')}
        >
          <LayoutList className="h-3.5 w-3.5" /> List
        </Button>
        <Button variant="ghost"
          onClick={() => setViewMode('region')}
          aria-pressed={viewMode === 'region'}
          className={cn('h-11 min-h-11 gap-2 text-sm px-4 rounded-md',
            viewMode === 'region' ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground')}
        >
          <Map className="h-3.5 w-3.5" /> By Region
        </Button>
      </div>

      {viewMode === 'region' ? (
        <AgentRegionBreakdown verifiedOnly={false} onOpenAgent={setOpenAgentId} />
      ) : (
        <>
          {/* Search + compact filter toggle (phone) */}
          <div className="flex gap-2">
          <div className="relative flex-1 min-w-0">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search by name, phone, district, email, or ID…"
              value={searchInput}
              onChange={e => setSearchInput(e.target.value)}
              aria-label="Search agents"
              className="pl-10 pr-12 h-12 text-base sm:h-11 sm:text-sm"
              autoComplete="off"
            />
            {searchInput && (
              <Button variant="ghost" size="icon"
                onClick={() => setSearchInput('')}
                className="absolute right-0.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                aria-label="Clear search"
              >
                <X className="h-4 w-4" />
              </Button>
            )}
          </div>
            <Button
              variant="outline"
              onClick={() => setFiltersOpen(o => !o)}
              aria-expanded={filtersOpen}
              aria-label="Show filters"
              className="sm:hidden h-12 px-3 gap-1.5 shrink-0"
            >
              <SlidersHorizontal className="h-4 w-4" />
              Filters
              {activeFilterCount > 0 && (
                <Badge className="h-5 min-w-5 px-1.5 text-[10px]">{activeFilterCount}</Badge>
              )}
            </Button>
          </div>

          {/* Active filter summary (phone, collapsed) */}
          {!filtersOpen && (
            <div className="sm:hidden flex flex-wrap items-center gap-1.5 text-xs">
              <Badge variant="secondary">{TYPE_FILTERS.find(t => t.value === type)?.label}</Badge>
              <Badge variant="secondary">{STATUS_FILTERS.find(s => s.value === status)?.label}</Badge>
              {activeFilterCount > 0 && (
                <Button variant="link" size="sm" className="h-8 px-1 text-xs"
                  onClick={() => { setType('all'); setStatus('active'); }}>
                  Reset
                </Button>
              )}
            </div>
          )}

          {/* Filters */}
          <div className={cn('flex-col gap-2 sm:flex sm:flex-row sm:flex-wrap sm:items-center rounded-xl sm:rounded-none border sm:border-0 border-border p-2 sm:p-0',
            filtersOpen ? 'flex' : 'hidden')}>
            <div className="grid grid-cols-3 gap-2 sm:flex" role="group" aria-label="Agent type">
              {TYPE_FILTERS.map(t => (
                <Button variant="outline"
                  key={t.value}
                  onClick={() => setType(t.value)}
                  aria-pressed={type === t.value}
                  className={cn('min-w-0 h-11 min-h-11 text-sm px-2 sm:px-3 rounded-lg border shadow-none',
                    type === t.value ? 'bg-primary text-primary-foreground border-primary'
                      : 'border-border text-muted-foreground hover:bg-muted')}
                >
                  {t.label}
                </Button>
              ))}
            </div>
            <div className="grid grid-cols-2 gap-2 sm:flex sm:ml-auto" role="group" aria-label="Agent status">
              {STATUS_FILTERS.map(s => (
                <Button variant="outline"
                  key={s.value}
                  onClick={() => setStatus(s.value)}
                  aria-pressed={status === s.value}
                  className={cn('min-w-0 h-11 min-h-11 text-sm px-3 rounded-lg border shadow-none',
                    status === s.value ? 'bg-secondary text-secondary-foreground border-border'
                      : 'border-border text-muted-foreground hover:bg-muted')}
                >
                  {s.label}
                </Button>
              ))}
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted-foreground">
            <span>Showing {fmt(totalMatched)} agents &amp; sub-agents</span>
            {totalMatched > 0 && (
              <span>{showingFrom.toLocaleString()}–{showingTo.toLocaleString()} of {totalMatched.toLocaleString()}</span>
            )}
          </div>

          {error && (
            <div className="text-center py-6 text-sm text-destructive">
              Failed to load agents. {(error as any)?.message}
            </div>
          )}

          {isLoading && !data ? (
            <div className="divide-y divide-border border-y border-border">
              {Array.from({ length: 8 }).map((_, i) => (
                <div key={i} className="h-16 bg-muted/40 animate-pulse" />
              ))}
            </div>
          ) : rows.length === 0 ? (
            <div className="text-center py-10 text-muted-foreground">
              <Search className="h-8 w-8 mx-auto mb-2 opacity-30" />
              <p className="text-sm font-medium">No agents match these filters</p>
            </div>
          ) : (
            <div className="divide-y divide-border border-y border-border">
              {/* Column head (desktop) */}
              <div className={cn('hidden lg:grid gap-3 px-3 py-2 text-[10px] uppercase tracking-wider text-muted-foreground font-semibold', GRID_LG)}>
                <span>Agent</span>
                <span>Location</span>
                <span>Role</span>
                <span>Portfolio</span>
                <span>Today vs target</span>
                <span>Status</span>
                <span />
              </div>
              {rows.map(a => {
                const target = Number(a.daily_target) || 0;
                const today = Number(a.collected_today) || 0;
                const pct = target > 0 ? Math.min(100, Math.round((today / target) * 100)) : 0;
                const place = [a.district, a.region].filter(Boolean).join(', ') || a.territory || null;
                return (
                <div
                  key={a.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => setOpenAgentId(a.id)}
                  onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); setOpenAgentId(a.id); } }}
                  className={cn('w-full min-w-0 text-left grid grid-cols-1 sm:grid-cols-2 gap-3 lg:items-center px-3 py-4 sm:py-3 hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring touch-manipulation transition-colors cursor-pointer', GRID_LG)}
                >
                  {/* Identity */}
                  <div className="flex items-center gap-3 min-w-0">
                    <AgentAvatar src={a.avatar_url} name={a.full_name} className="h-10 w-10" />
                    <div className="min-w-0">
                      <div className="flex items-start gap-1.5">
                        <Button
                          variant="link"
                          aria-label={`Open profile for ${a.full_name || 'Unknown Agent'}`}
                          onClick={(e) => { e.stopPropagation(); setOpenAgentId(a.id); }}
                          className="h-auto min-h-11 min-w-0 justify-start p-0 text-left font-semibold text-base whitespace-normal break-words underline underline-offset-4 lg:text-sm"
                        >
                          {a.full_name || 'Unknown Agent'}
                        </Button>
                        {a.verified && <BadgeCheck className="h-3.5 w-3.5 text-primary shrink-0" aria-label="Verified" />}
                      </div>
                      <span className="flex items-center gap-1.5 text-sm text-muted-foreground break-all lg:text-xs">
                        <Phone className="h-3 w-3 shrink-0" />{a.phone || '—'}
                      </span>
                      {a.email && (
                        <span className="mt-1 flex items-start gap-1.5 text-sm text-muted-foreground lg:text-[11px]">
                          <Mail className="h-3 w-3 shrink-0 mt-1" /><span className="break-all">{a.email}</span>
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Location */}
                  <div className="min-w-0 text-sm lg:text-xs">
                    <span className="flex items-start gap-1 text-foreground break-words">
                      <MapPin className="h-3 w-3 shrink-0 text-muted-foreground" />
                      {place || <span className="text-muted-foreground">No location</span>}
                    </span>
                    <span className="flex items-center gap-1 text-xs text-muted-foreground mt-1">
                      <CalendarClock className="h-3 w-3 shrink-0" />
                      Last collection {relative(a.last_collection_at)}
                    </span>
                  </div>

                  {/* Role */}
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge variant={a.agent_kind === 'sub_agent' ? 'secondary' : 'outline'} className="text-[10px]">
                      {a.agent_kind === 'sub_agent' ? 'Sub-Agent' : 'Agent'}
                    </Badge>
                    {a.agent_tier && (
                      <Badge variant="outline" className="text-[10px] capitalize">{a.agent_tier}</Badge>
                    )}
                  </div>

                  {/* Portfolio */}
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm lg:text-xs tabular-nums">
                    <span className="flex items-center gap-1" title="Tenants">
                      <Users className="h-3.5 w-3.5 text-muted-foreground" />
                      <span className="font-semibold">{a.total_tenants}</span><span className="text-muted-foreground lg:hidden">tenants</span>
                    </span>
                    <span className="flex items-center gap-1" title="Sub-agents recruited">
                      <Network className="h-3.5 w-3.5 text-muted-foreground" />
                      <span className="font-semibold">{a.sub_agents_count}</span><span className="text-muted-foreground lg:hidden">sub-agents</span>
                    </span>
                    <span className="flex items-center gap-1" title="Houses listed">
                      <Home className="h-3.5 w-3.5 text-muted-foreground" />
                      <span className="font-semibold">{a.houses_listed}</span><span className="text-muted-foreground lg:hidden">houses</span>
                    </span>
                    <span className="text-xs text-muted-foreground" title="Outstanding balance">
                      Out {ugx(a.outstanding)}
                    </span>
                  </div>

                  {/* Today vs target */}
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm lg:text-xs tabular-nums">
                      <span className={cn('font-semibold', today > 0 ? 'text-emerald-600' : 'text-muted-foreground')}>
                        <span className="font-normal text-muted-foreground lg:hidden">Today </span>{ugx(today)}
                      </span>
                      <span className="text-xs text-muted-foreground"><span className="lg:hidden">Target </span><span className="hidden lg:inline">/ </span>{ugx(target)}</span>
                    </div>
                    <div className="mt-1 h-1.5 w-full bg-muted overflow-hidden rounded-full">
                      <div
                        className={cn('h-full', pct >= 100 ? 'bg-emerald-500' : pct > 0 ? 'bg-primary' : 'bg-transparent')}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  </div>

                  {/* Status */}
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className={cn('text-[10px] px-2 py-0.5 rounded-full border capitalize w-fit', STATUS_STYLE[a.status])}>
                      {a.status}
                    </span>
                    <Button
                      variant={a.status === 'frozen' ? 'outline' : 'ghost'}
                      size="sm"
                      className={cn('h-11 min-h-11 px-3 text-sm lg:h-9 lg:min-h-9 lg:px-2 lg:text-xs', a.status !== 'frozen' && 'text-destructive hover:text-destructive')}
                      onClick={(e) => { e.stopPropagation(); setFreezeReason(''); setFreezeTarget(a); }}
                    >
                      {a.status === 'frozen'
                        ? <><ShieldOff className="h-3 w-3 mr-1" />Unfreeze</>
                        : <><ShieldAlert className="h-3 w-3 mr-1" />Freeze</>}
                    </Button>
                  </div>

                  <Chevron className="hidden lg:block h-4 w-4 text-muted-foreground shrink-0 justify-self-end" />
                </div>
                );
              })}
            </div>
          )}

          {totalMatched > PAGE_SIZE && (
            <div className="flex items-center justify-between gap-2 pt-2 border-t border-border">
              <Button variant="outline" size="sm" className="text-sm h-11 min-h-11"
                disabled={page === 0 || isFetching} onClick={() => setPage(p => Math.max(0, p - 1))}>
                <ChevronLeft className="h-3.5 w-3.5 mr-1" /> Prev
              </Button>
              <span className="text-xs text-muted-foreground">Page {page + 1} of {totalPages.toLocaleString()}</span>
              <Button variant="outline" size="sm" className="text-sm h-11 min-h-11"
                disabled={page >= totalPages - 1 || isFetching} onClick={() => setPage(p => p + 1)}>
                Next <ChevronRight className="h-3.5 w-3.5 ml-1" />
              </Button>
            </div>
          )}
        </>
      )}
      </>
      )}

      <AlertDialog open={!!freezeTarget} onOpenChange={(o) => { if (!o) { setFreezeTarget(null); setFreezeReason(''); } }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {freezeTarget?.status === 'frozen' ? 'Unfreeze agent account?' : 'Freeze agent account?'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {freezeTarget?.status === 'frozen'
                ? `${freezeTarget?.full_name || 'This agent'} will regain full access to the agent app.`
                : `${freezeTarget?.full_name || 'This agent'} will be blocked from all transactions until unfrozen.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {freezeTarget?.status !== 'frozen' && (
            <div className="space-y-1.5">
              <label className="text-xs font-medium">Reason (min 10 characters)</label>
              <Textarea
                value={freezeReason}
                onChange={(e) => setFreezeReason(e.target.value)}
                placeholder="Why is this agent being frozen?"
                rows={3}
              />
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={freezing}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => { e.preventDefault(); submitFreeze(); }}
              disabled={freezing}
              className={freezeTarget?.status === 'frozen' ? '' : 'bg-destructive text-destructive-foreground hover:bg-destructive/90'}
            >
              {freezing && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}
              {freezeTarget?.status === 'frozen' ? 'Unfreeze' : 'Freeze account'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
