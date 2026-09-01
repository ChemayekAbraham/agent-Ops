import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  Building2, Home, Search, User, UserPlus, UserX, UserCog, ChevronDown, ChevronRight, ChevronUp, Loader2, X, Eye, EyeOff, Info, MapPin, Minus, Plus, Star,
} from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import { BindTenantToHouseDialog } from './BindTenantToHouseDialog';
import { RemoveTenantDialog } from './RemoveTenantDialog';
import { ReassignAgentDialog } from '@/components/shared/ReassignAgentDialog';
import { HouseActivityTimeline } from '@/components/shared/HouseActivityTimeline';
import { HighlightText } from '@/components/shared/HighlightText';
import { useFilterKeyboardShortcuts } from '@/hooks/useFilterKeyboardShortcuts';
import { useAuth } from '@/hooks/useAuth';
import { toast } from '@/hooks/use-toast';
import { LocationBrowser } from './LocationBrowser';
import { LocationReconciliationCard } from './LocationReconciliationCard';
import { HouseDetailsDialog } from './HouseDetailsDialog';

interface HouseRow {
  id: string;
  title: string;
  address: string;
  region: string;
  district: string | null;
  status: string;
  monthly_rent: number;
  daily_rate: number;
  agent_id: string;
  landlord_id: string | null;
  tenant_id: string | null;
  created_at: string;
  is_hidden: boolean;
}

interface LandlordGroup {
  landlord_id: string;
  landlord_name: string;
  landlord_phone: string | null;
  houses: HouseRow[];
  occupied: number;
  vacant: number;
}

const FILTERS_STORAGE_PREFIX = 'landlord-houses-panel:filters:v2';
const storageKeyFor = (uid: string | null | undefined) =>
  uid ? `${FILTERS_STORAGE_PREFIX}:${uid}` : `${FILTERS_STORAGE_PREFIX}:anon`;
type PanelFilters = {
  search: string;
  statusFilter: 'all' | 'occupied' | 'vacant';
  regionFilter: string;
  sortBy: 'newest' | 'oldest' | 'title' | 'region' | 'occupied_first' | 'vacant_first';
};
const DEFAULT_FILTERS: PanelFilters = { search: '', statusFilter: 'all', regionFilter: 'all', sortBy: 'newest' };
function loadFilters(key: string): PanelFilters {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return DEFAULT_FILTERS;
    return { ...DEFAULT_FILTERS, ...JSON.parse(raw) };
  } catch { return DEFAULT_FILTERS; }
}

export function LandlordHousesPanel() {
  const { user } = useAuth();
  const storageKey = storageKeyFor(user?.id);
  const [search, setSearch] = useState(DEFAULT_FILTERS.search);
  const [statusFilter, setStatusFilter] = useState<PanelFilters['statusFilter']>(DEFAULT_FILTERS.statusFilter);
  const [regionFilter, setRegionFilter] = useState<string>(DEFAULT_FILTERS.regionFilter);
  const [sortBy, setSortBy] = useState<PanelFilters['sortBy']>(DEFAULT_FILTERS.sortBy);
  const hydratedKeyRef = useRef<string | null>(null);

  // Re-hydrate when the active user (and therefore the scoped key) changes.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const next = loadFilters(storageKey);
    setSearch(next.search);
    setStatusFilter(next.statusFilter);
    setRegionFilter(next.regionFilter);
    setSortBy(next.sortBy);
    hydratedKeyRef.current = storageKey;
  }, [storageKey]);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [houseCollapsed, setHouseCollapsed] = useState<Record<string, boolean>>({});
  const [viewMode, setViewMode] = useState<'landlord' | 'location'>('location');
  const [detailsHouseId, setDetailsHouseId] = useState<string | null>(null);

  useEffect(() => {
    // Only persist after we have hydrated for this user — prevents writing
    // the previous user's filters under the new user's key.
    if (hydratedKeyRef.current !== storageKey) return;
    try {
      localStorage.setItem(storageKey, JSON.stringify({ search, statusFilter, regionFilter, sortBy }));
    } catch { /* ignore */ }
  }, [search, statusFilter, regionFilter, sortBy, storageKey]);

  const searchRef = useRef<HTMLInputElement>(null);
  const clearAll = () => { setSearch(''); setStatusFilter('all'); setRegionFilter('all'); setSortBy('newest'); };

  const housesQuery = useQuery({
    queryKey: ['landlord-houses-panel'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('house_listings')
        .select('id,title,address,region,district,status,monthly_rent,daily_rate,agent_id,landlord_id,tenant_id,created_at,is_hidden')
        .not('landlord_id', 'is', null)
        .order('created_at', { ascending: false })
        .limit(1000);
      if (error) throw error;
      return (data ?? []) as HouseRow[];
    },
  });

  const profilesQuery = useQuery({
    queryKey: ['landlord-houses-panel-profiles', housesQuery.data?.length ?? 0],
    enabled: !!housesQuery.data && housesQuery.data.length > 0,
    queryFn: async () => {
      const houses = housesQuery.data ?? [];
      const ids = Array.from(new Set([
        ...houses.map(h => h.landlord_id).filter(Boolean) as string[],
        ...houses.map(h => h.tenant_id).filter(Boolean) as string[],
        ...houses.map(h => h.agent_id),
      ]));
      if (!ids.length) return {} as Record<string, { name: string; phone: string | null }>;
      const { data } = await supabase.from('profiles').select('id,full_name,phone').in('id', ids);
      const out: Record<string, { name: string; phone: string | null }> = {};
      for (const p of (data ?? []) as Array<{ id: string; full_name: string | null; phone: string | null }>) {
        out[p.id] = { name: p.full_name || 'Unnamed', phone: p.phone ?? null };
      }
      return out;
    },
  });

  const groups = useMemo<LandlordGroup[]>(() => {
    const profs = profilesQuery.data ?? {};
    const byLandlord = new Map<string, LandlordGroup>();
    for (const h of housesQuery.data ?? []) {
      if (!h.landlord_id) continue;
      const g = byLandlord.get(h.landlord_id) ?? {
        landlord_id: h.landlord_id,
        landlord_name: profs[h.landlord_id]?.name ?? 'Unknown landlord',
        landlord_phone: profs[h.landlord_id]?.phone ?? null,
        houses: [],
        occupied: 0,
        vacant: 0,
      };
      g.houses.push(h);
      if (h.tenant_id) g.occupied += 1; else g.vacant += 1;
      byLandlord.set(h.landlord_id, g);
    }
    return Array.from(byLandlord.values()).sort((a, b) => a.landlord_name.localeCompare(b.landlord_name));
  }, [housesQuery.data, profilesQuery.data]);

  const regions = useMemo(() => {
    const set = new Set<string>();
    for (const h of housesQuery.data ?? []) if (h.region) set.add(h.region);
    return Array.from(set).sort();
  }, [housesQuery.data]);

  const profs = profilesQuery.data ?? {};

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const houseMatches = (h: HouseRow) => {
      if (regionFilter !== 'all' && h.region !== regionFilter) return false;
      if (statusFilter === 'occupied' && !h.tenant_id) return false;
      if (statusFilter === 'vacant' && h.tenant_id) return false;
      if (!q) return true;
      const tenant = h.tenant_id ? profs[h.tenant_id] : null;
      const agent = profs[h.agent_id];
      return (
        h.title.toLowerCase().includes(q) ||
        h.address.toLowerCase().includes(q) ||
        h.region.toLowerCase().includes(q) ||
        (tenant?.name.toLowerCase().includes(q) ?? false) ||
        (tenant?.phone ?? '').includes(q) ||
        (agent?.name.toLowerCase().includes(q) ?? false) ||
        (agent?.phone ?? '').includes(q)
      );
    };
    const landlordTextMatch = (g: LandlordGroup) =>
      !q || g.landlord_name.toLowerCase().includes(q) || (g.landlord_phone ?? '').includes(q);

    return groups
      .map(g => {
        const houses = g.houses.filter(houseMatches);
        if (houses.length === 0 && !landlordTextMatch(g)) return null;
        if (houses.length === 0) return null;
        const sorted = [...houses].sort((a, b) => {
          switch (sortBy) {
            case 'oldest': return a.created_at.localeCompare(b.created_at);
            case 'title': return a.title.localeCompare(b.title);
            case 'region': return (a.region || '').localeCompare(b.region || '') || a.title.localeCompare(b.title);
            case 'occupied_first': return (a.tenant_id ? 0 : 1) - (b.tenant_id ? 0 : 1);
            case 'vacant_first': return (a.tenant_id ? 1 : 0) - (b.tenant_id ? 1 : 0);
            case 'newest':
            default: return b.created_at.localeCompare(a.created_at);
          }
        });
        const occupied = sorted.filter(h => h.tenant_id).length;
        return { ...g, houses: sorted, occupied, vacant: sorted.length - occupied };
      })
      .filter(Boolean) as LandlordGroup[];
  }, [groups, search, statusFilter, regionFilter, profs, sortBy]);

  const hasActiveFilter = search.trim().length > 0 || statusFilter !== 'all' || regionFilter !== 'all' || sortBy !== 'newest';

  useFilterKeyboardShortcuts({ inputRef: searchRef, onClear: clearAll, hasActiveFilter });
  const totalHouses = filtered.reduce((s, g) => s + g.houses.length, 0);

  // ── Action dialog state ──
  const [bindFor, setBindFor] = useState<{ landlordId: string; landlordName: string; houseId: string; currentTenantId: string | null } | null>(null);
  const [removeFor, setRemoveFor] = useState<{ houseId: string; houseTitle: string } | null>(null);
  const [reassignFor, setReassignFor] = useState<{ houseId: string; houseTitle: string; currentAgentId: string } | null>(null);
  const [timelineOpen, setTimelineOpen] = useState<Record<string, boolean>>({});
  const [togglingHide, setTogglingHide] = useState<Record<string, boolean>>({});

  const refetch = () => {
    housesQuery.refetch();
  };

  const toggleHidden = async (h: HouseRow) => {
    const nextHidden = !h.is_hidden;
    const action = nextHidden ? 'hide' : 'unhide';
    const reason = window.prompt(
      `Reason to ${action} "${h.title}" (min 10 characters) — visible only to landlord ops & audit logs:`,
      nextHidden ? 'Hidden from tenant browse' : 'Restored to tenant browse'
    );
    if (reason === null) return;
    const trimmed = reason.trim();
    if (trimmed.length < 10) {
      toast({ title: 'Reason too short', description: 'Please enter at least 10 characters.', variant: 'destructive' });
      return;
    }
    setTogglingHide(s => ({ ...s, [h.id]: true }));
    try {
      const { error } = await supabase
        .from('house_listings')
        .update({ is_hidden: nextHidden })
        .eq('id', h.id);
      if (error) throw error;
      await supabase.from('audit_logs').insert({
        user_id: user?.id,
        action_type: nextHidden ? 'listing_hidden' : 'listing_unhidden',
        table_name: 'house_listings',
        record_id: h.id,
        metadata: { reason: trimmed, listing_title: h.title },
      });
      toast({
        title: nextHidden ? 'House hidden' : 'House visible',
        description: nextHidden
          ? `${h.title} is hidden from tenant browse.`
          : `${h.title} is back in tenant browse.`,
      });
      refetch();
    } catch (err: any) {
      toast({
        title: `Failed to ${action} house`,
        description: err?.message || 'Please try again.',
        variant: 'destructive',
      });
    } finally {
      setTogglingHide(s => ({ ...s, [h.id]: false }));
    }
  };

  if (housesQuery.isLoading) {
    return <div className="flex justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>;
  }

  return (
    <div className="space-y-3">
      <h2 className="text-lg font-bold flex items-center gap-2">
        <Building2 className="h-5 w-5 text-primary" />
        {viewMode === 'landlord' ? 'Houses by Landlord' : 'Houses by Location'}
      </h2>

      <div className="grid grid-cols-[1.6fr_1fr] gap-2">
        <button
          onClick={() => setViewMode('location')}
          className={`flex items-center gap-3 rounded-xl border p-4 text-left transition ${
            viewMode === 'location'
              ? 'border-primary bg-gradient-to-br from-primary/10 to-primary/5 shadow-md ring-1 ring-primary/20'
              : 'border-border bg-muted/20 hover:bg-muted/40'
          }`}
        >
          <div className={`flex h-10 w-10 items-center justify-center rounded-full ${viewMode === 'location' ? 'bg-primary/15 text-primary' : 'bg-muted text-muted-foreground'}`}>
            <MapPin className="h-5 w-5" />
          </div>
          <div className="flex-1 min-w-1">
            <p className="text-sm font-bold">Browse by Location</p>
            <p className="text-[11px] text-muted-foreground">Country → Region → District → Agent → Landlord</p>
            <div className="flex items-center gap-1 mt-1">
              <Badge variant="default" className="gap-1 text-[9px] h-4"><Star className="h-2.5 w-2.5 fill-current" aria-hidden="true" />Recommended</Badge>
              <span className="text-[10px] text-muted-foreground">Best for ops at scale</span>
            </div>
          </div>
        </button>
        <button
          onClick={() => setViewMode('landlord')}
          className={`flex items-center gap-2 rounded-lg border p-3 text-left transition ${
            viewMode === 'landlord'
              ? 'border-primary bg-primary/5 shadow-sm'
              : 'border-border bg-muted/20 hover:bg-muted/40'
          }`}
        >
          <Building2 className={`h-5 w-5 ${viewMode === 'landlord' ? 'text-primary' : 'text-muted-foreground'}`} />
          <div>
            <p className="text-sm font-semibold">Group by Landlord</p>
            <p className="text-[11px] text-muted-foreground">Each landlord and their houses</p>
          </div>
        </button>
      </div>

      {viewMode === 'location' && (
        <div className="space-y-3">
          <LocationReconciliationCard />
          <LocationBrowser />
        </div>
      )}

      {viewMode === 'landlord' && (
      <>
      <div className="space-y-2">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            ref={searchRef}
            placeholder="Search landlord, house, tenant, agent, phone…  ( / to focus, Esc to clear )"
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="pl-9 pr-9"
          />
          {search && (
            <button
              onClick={() => setSearch('')}
              aria-label="Clear search"
              className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-muted-foreground hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <Select value={statusFilter} onValueChange={(v: any) => setStatusFilter(v)}>
            <SelectTrigger className="h-9 w-auto min-w-[140px] text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All houses</SelectItem>
              <SelectItem value="occupied">Occupied only</SelectItem>
              <SelectItem value="vacant">Vacant only</SelectItem>
            </SelectContent>
          </Select>
          <Select value={regionFilter} onValueChange={setRegionFilter}>
            <SelectTrigger className="h-9 w-auto min-w-[140px] text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All regions</SelectItem>
              {regions.map(r => <SelectItem key={r} value={r}>{r}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={sortBy} onValueChange={(v: any) => setSortBy(v)}>
            <SelectTrigger className="h-9 w-auto min-w-[150px] text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="newest">Newest first</SelectItem>
              <SelectItem value="oldest">Oldest first</SelectItem>
              <SelectItem value="title">Title (A–Z)</SelectItem>
              <SelectItem value="region">Region (A–Z)</SelectItem>
              <SelectItem value="occupied_first">Occupied first</SelectItem>
              <SelectItem value="vacant_first">Vacant first</SelectItem>
            </SelectContent>
          </Select>
          <Button
            variant="outline" size="sm" className="h-9 text-xs gap-1"
            onClick={clearAll}
            disabled={!hasActiveFilter}
            title="Reset search, status, region, and sort back to defaults"
          >
            <X className="h-3 w-3" /> Reset filters
          </Button>
          <div className="ml-auto text-[11px] text-muted-foreground self-center">
            {filtered.length} landlord{filtered.length === 1 ? '' : 's'} · {totalHouses} house{totalHouses === 1 ? '' : 's'}
          </div>
        </div>
      </div>

      {filtered.length === 0 ? (
        <Card><CardContent className="py-10 text-center text-sm text-muted-foreground">No landlords match.</CardContent></Card>
      ) : (
        <div className="space-y-2">
          {filtered.map(g => {
            const isOpen = !!expanded[g.landlord_id];
            return (
              <Card key={g.landlord_id} className="overflow-hidden">
                <button
                  onClick={() => setExpanded(s => ({ ...s, [g.landlord_id]: !s[g.landlord_id] }))}
                  className="w-full text-left p-3 active:bg-muted/50 transition-colors min-h-[64px]"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <p className="font-bold text-sm flex items-center gap-1.5">
                        <Building2 className="h-4 w-4 text-sky-600 shrink-0" />
                        <HighlightText text={g.landlord_name} query={search} />
                      </p>
                      <div className="flex items-center gap-2 mt-0.5 text-[11px] text-muted-foreground">
                        {g.landlord_phone && <span><HighlightText text={g.landlord_phone} query={search} /></span>}
                        <span>· {g.houses.length} house{g.houses.length === 1 ? '' : 's'}</span>
                        <span className="text-success">· {g.occupied} occupied</span>
                        <span className="text-amber-600">· {g.vacant} vacant</span>
                      </div>
                    </div>
                    <div className="flex items-center gap-1 shrink-1">
                      {isOpen && g.houses.length > 1 && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            const allCollapsed = g.houses.every(h => houseCollapsed[h.id]);
                            setHouseCollapsed(s => {
                              const next = { ...s };
                              g.houses.forEach(h => { next[h.id] = !allCollapsed; });
                              return next;
                            });
                          }}
                          className="flex items-center gap-1 rounded-md bg-muted/60 px-2 py-1 text-[10px] font-medium text-muted-foreground hover:bg-muted transition"
                          title={g.houses.every(h => houseCollapsed[h.id]) ? 'Expand all houses' : 'Collapse all houses'}
                        >
                          {g.houses.every(h => houseCollapsed[h.id]) ? <Plus className="h-3 w-3" /> : <Minus className="h-3 w-3" />}
                          {g.houses.every(h => houseCollapsed[h.id]) ? 'Expand all' : 'Collapse all'}
                        </button>
                      )}
                      {isOpen ? <ChevronDown className="h-4 w-4 mt-1 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 mt-1 text-muted-foreground" />}
                    </div>
                  </div>
                </button>

                {isOpen && (
                  <div className="border-t bg-muted/20 p-3 space-y-2">
                    {g.houses.map(h => {
                      const tenant = h.tenant_id ? profs[h.tenant_id] : null;
                      const agent = profs[h.agent_id];
                      return (
                        <div key={h.id} className="rounded-lg border bg-background p-3 space-y-2">
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0 flex-1">
                              <p className="font-semibold text-sm flex items-center gap-1.5">
                                <Home className="h-4 w-4 text-primary shrink-0" />
                                <span className="truncate"><HighlightText text={h.title} query={search} /></span>
                              </p>
                              <p className="text-[11px] text-muted-foreground truncate"><HighlightText text={h.address} query={search} />, <HighlightText text={h.region} query={search} /></p>
                              <p className="text-[11px] text-muted-foreground">
                                {formatUGX(h.monthly_rent)}/mo · {formatUGX(h.daily_rate)}/day
                              </p>
                            </div>
                            <div className="flex flex-col items-end gap-1 shrink-1">
                              <div className="flex items-center gap-1">
                                <Badge variant={h.tenant_id ? 'default' : 'outline'} className="text-[10px]">
                                  {h.tenant_id ? 'Occupied' : 'Vacant'}
                                </Badge>
                                <button
                                  onClick={() => setHouseCollapsed(s => ({ ...s, [h.id]: !s[h.id] }))}
                                  className="p-1 rounded hover:bg-muted text-muted-foreground transition"
                                  title={houseCollapsed[h.id] ? 'Expand house details' : 'Collapse house details'}
                                >
                                  {houseCollapsed[h.id] ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronUp className="h-3.5 w-3.5" />}
                                </button>
                              </div>
                              {h.is_hidden && (
                                <Badge variant="secondary" className="text-[10px] gap-1 bg-amber-100 text-amber-800 border-amber-200">
                                  <EyeOff className="h-3 w-3" /> Hidden
                                </Badge>
                              )}
                            </div>
                          </div>

                          {!houseCollapsed[h.id] && (
                            <>
                              <div className="rounded-md bg-muted/40 p-2 text-[11px] space-y-1">
                                <p className="flex items-center gap-1">
                                  <User className="h-3 w-3" />
                                  <span className="font-medium">Tenant:</span>
                                  <span className="truncate">{tenant ? (
                                    <>
                                      <HighlightText text={tenant.name} query={search} />
                                      {tenant.phone ? <> · <HighlightText text={tenant.phone} query={search} /></> : null}
                                    </>
                                  ) : '—'}</span>
                                </p>
                                <p className="flex items-center gap-1">
                                  <UserCog className="h-3 w-3" />
                                  <span className="font-medium">Agent:</span>
                                  <span className="truncate">{agent ? (
                                    <>
                                      <HighlightText text={agent.name} query={search} />
                                      {agent.phone ? <> · <HighlightText text={agent.phone} query={search} /></> : null}
                                    </>
                                  ) : '—'}</span>
                                </p>
                              </div>

                              <div className="flex flex-wrap gap-1.5">
                                <Button
                                  size="sm" variant="outline" className="h-8 text-xs gap-1"
                                  onClick={() => setBindFor({
                                    landlordId: g.landlord_id, landlordName: g.landlord_name,
                                    houseId: h.id, currentTenantId: h.tenant_id,
                                  })}
                                >
                                  <UserPlus className="h-3 w-3" />
                                  {h.tenant_id ? 'Swap tenant' : 'Bind tenant'}
                                </Button>
                                {h.tenant_id && (
                                  <Button
                                    size="sm" variant="outline" className="h-8 text-xs gap-1 border-destructive/40 text-destructive hover:bg-destructive/10"
                                    onClick={() => setRemoveFor({ houseId: h.id, houseTitle: h.title })}
                                  >
                                    <UserX className="h-3 w-3" />
                                    Remove (absconded)
                                  </Button>
                                )}
                                <Button
                                  size="sm" variant="outline" className="h-8 text-xs gap-1"
                                  onClick={() => setReassignFor({ houseId: h.id, houseTitle: h.title, currentAgentId: h.agent_id })}
                                >
                                  <UserCog className="h-3 w-3" />
                                  Reassign agent
                                </Button>
                                <Button
                                  size="sm" variant="outline" className="h-8 text-xs gap-1"
                                  onClick={() => toggleHidden(h)}
                                  disabled={!!togglingHide[h.id]}
                                  title={h.is_hidden ? 'Show this house to tenants again' : 'Hide this house from tenant browse'}
                                >
                                  {togglingHide[h.id] ? (
                                    <Loader2 className="h-3 w-3 animate-spin" />
                                  ) : h.is_hidden ? (
                                    <Eye className="h-3 w-3" />
                                  ) : (
                                    <EyeOff className="h-3 w-3" />
                                  )}
                                  {h.is_hidden ? 'Unhide' : 'Hide'}
                                </Button>
                                <Button
                                  size="sm" variant="ghost" className="h-8 text-xs gap-1"
                                  onClick={() => setTimelineOpen(s => ({ ...s, [h.id]: !s[h.id] }))}
                                  aria-expanded={!!timelineOpen[h.id]}
                                >
                                  {timelineOpen[h.id] ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                                  Timeline
                                </Button>
                                <Button
                                  size="sm" variant="outline" className="h-8 text-xs gap-1 border-primary/40 text-primary hover:bg-primary/10"
                                  onClick={() => setDetailsHouseId(h.id)}
                                  title="See every detail the agent registered for this house"
                                >
                                  <Info className="h-3 w-3" /> Full details
                                </Button>
                              </div>
                              {timelineOpen[h.id] && (
                                <div className="rounded-md border bg-muted/10 p-2">
                                  <HouseActivityTimeline houseId={h.id} />
                                </div>
                              )}
                            </>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      )}
      </>
      )}

      {bindFor && (
        <BindTenantToHouseDialog
          open={!!bindFor}
          onOpenChange={(o) => !o && setBindFor(null)}
          landlordId={bindFor.landlordId}
          landlordName={bindFor.landlordName}
          preselectedHouseId={bindFor.houseId}
          currentTenantIdOnHouse={bindFor.currentTenantId}
          onComplete={refetch}
        />
      )}
      {removeFor && (
        <RemoveTenantDialog
          open={!!removeFor}
          onOpenChange={(o) => !o && setRemoveFor(null)}
          houseId={removeFor.houseId}
          houseTitle={removeFor.houseTitle}
          onComplete={refetch}
        />
      )}
      {reassignFor && (
        <ReassignAgentDialog
          open={!!reassignFor}
          onOpenChange={(o) => !o && setReassignFor(null)}
          target={{ kind: 'house', houseId: reassignFor.houseId, houseTitle: reassignFor.houseTitle, currentAgentId: reassignFor.currentAgentId }}
          onComplete={refetch}
        />
      )}
      <HouseDetailsDialog
        houseId={detailsHouseId}
        onOpenChange={(o) => !o && setDetailsHouseId(null)}
      />
    </div>
  );
}
