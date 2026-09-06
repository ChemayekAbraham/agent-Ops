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
  const [page, setPage] = useState(0);
  const [openAgentId, setOpenAgentId] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<'list' | 'region'>('list');
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
    <div className="space-y-4">
      {openAgentId ? (
        <>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" className="h-8 text-xs" onClick={() => setOpenAgentId(null)}>
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
      <div className="flex items-center gap-1 rounded-full bg-muted/50 p-0.5 w-fit">
        <button
          onClick={() => setViewMode('list')}
          className={cn('flex items-center gap-1 text-xs px-3 py-1.5 rounded-full transition-colors',
            viewMode === 'list' ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground')}
        >
          <LayoutList className="h-3.5 w-3.5" /> List
        </button>
        <button
          onClick={() => setViewMode('region')}
          className={cn('flex items-center gap-1 text-xs px-3 py-1.5 rounded-full transition-colors',
            viewMode === 'region' ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground')}
        >
          <Map className="h-3.5 w-3.5" /> By Region
        </button>
      </div>

      {viewMode === 'region' ? (
        <AgentRegionBreakdown verifiedOnly={false} />
      ) : (
        <>
          {/* Search */}
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search by name, phone, email, territory, or ID…"
              value={searchInput}
              onChange={e => setSearchInput(e.target.value)}
              className="pl-10 pr-10 h-10 text-sm"
              autoComplete="off"
            />
            {searchInput && (
              <button
                onClick={() => setSearchInput('')}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                aria-label="Clear search"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>

          {/* Filters */}
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1">
              {TYPE_FILTERS.map(t => (
                <button
                  key={t.value}
                  onClick={() => setType(t.value)}
                  className={cn('text-xs px-2.5 py-1.5 rounded-full border whitespace-nowrap transition-colors',
                    type === t.value ? 'bg-primary text-primary-foreground border-primary'
                      : 'border-border text-muted-foreground hover:bg-muted')}
                >
                  {t.label}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-1 ml-auto">
              {STATUS_FILTERS.map(s => (
                <button
                  key={s.value}
                  onClick={() => setStatus(s.value)}
                  className={cn('text-xs px-2.5 py-1.5 rounded-full border whitespace-nowrap transition-colors',
                    status === s.value ? 'bg-secondary text-secondary-foreground border-border'
                      : 'border-border text-muted-foreground hover:bg-muted')}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </div>

          <div className="flex items-center justify-between text-[11px] text-muted-foreground">
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
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpenAgentId(a.id); } }}
                  className={cn('w-full text-left grid grid-cols-1 sm:grid-cols-2 gap-3 lg:items-center px-3 py-3 hover:bg-muted/50 transition-colors cursor-pointer', GRID_LG)}
                >
                  {/* Identity */}
                  <div className="flex items-center gap-3 min-w-0">
                    <AgentAvatar src={a.avatar_url} name={a.full_name} className="h-10 w-10" />
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="font-semibold text-sm truncate">{a.full_name || 'Unknown Agent'}</span>
                        {a.verified && <BadgeCheck className="h-3.5 w-3.5 text-primary shrink-0" aria-label="Verified" />}
                      </div>
                      <span className="flex items-center gap-1 text-xs text-muted-foreground truncate">
                        <Phone className="h-3 w-3 shrink-0" />{a.phone || '—'}
                      </span>
                      {a.email && (
                        <span className="hidden lg:flex items-center gap-1 text-[11px] text-muted-foreground/80 truncate">
                          <Mail className="h-3 w-3 shrink-0" /><span className="truncate">{a.email}</span>
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Location */}
                  <div className="min-w-0 text-xs">
                    <span className="flex items-center gap-1 text-foreground truncate">
                      <MapPin className="h-3 w-3 shrink-0 text-muted-foreground" />
                      {place || <span className="text-muted-foreground">No location</span>}
                    </span>
                    <span className="flex items-center gap-1 text-[11px] text-muted-foreground mt-0.5">
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
                  <div className="flex items-center gap-3 text-xs tabular-nums">
                    <span className="flex items-center gap-1" title="Tenants">
                      <Users className="h-3.5 w-3.5 text-muted-foreground" />
                      <span className="font-semibold">{a.total_tenants}</span>
                    </span>
                    <span className="flex items-center gap-1" title="Sub-agents recruited">
                      <Network className="h-3.5 w-3.5 text-muted-foreground" />
                      <span className="font-semibold">{a.sub_agents_count}</span>
                    </span>
                    <span className="flex items-center gap-1" title="Houses listed">
                      <Home className="h-3.5 w-3.5 text-muted-foreground" />
                      <span className="font-semibold">{a.houses_listed}</span>
                    </span>
                    <span className="text-[11px] text-muted-foreground" title="Outstanding balance">
                      Out {ugx(a.outstanding)}
                    </span>
                  </div>

                  {/* Today vs target */}
                  <div className="min-w-0">
                    <div className="flex items-baseline justify-between gap-2 text-xs tabular-nums">
                      <span className={cn('font-semibold', today > 0 ? 'text-emerald-600' : 'text-muted-foreground')}>
                        {ugx(today)}
                      </span>
                      <span className="text-[11px] text-muted-foreground">/ {ugx(target)}</span>
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
                      className={cn('h-6 px-2 text-[10px]', a.status !== 'frozen' && 'text-destructive hover:text-destructive')}
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
              <Button variant="outline" size="sm" className="text-xs h-8"
                disabled={page === 0 || isFetching} onClick={() => setPage(p => Math.max(0, p - 1))}>
                <ChevronLeft className="h-3.5 w-3.5 mr-1" /> Prev
              </Button>
              <span className="text-xs text-muted-foreground">Page {page + 1} of {totalPages.toLocaleString()}</span>
              <Button variant="outline" size="sm" className="text-xs h-8"
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
