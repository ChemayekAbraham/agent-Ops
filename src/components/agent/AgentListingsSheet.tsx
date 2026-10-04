import { useMemo, useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Home, MapPin, DoorOpen, CheckCircle, Clock, AlertTriangle, RotateCcw, Building2, ChevronDown, ChevronRight, ChevronLeft, ChevronUp, User, UserCog, Pencil, Search, X, MoreVertical, Eye, Trash2, Loader2, MessageCircle, Trophy, Sparkles } from 'lucide-react';
import { UserMinus, Repeat } from 'lucide-react';
import { Plus } from 'lucide-react';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { EditHouseListingDialog } from './EditHouseListingDialog';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useHouseListings, HouseListing } from '@/hooks/useHouseListings';
import { formatUGX } from '@/lib/rentCalculations';
import { motion } from 'framer-motion';
import { useAuth } from '@/hooks/useAuth';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';
import { TenantProfileView } from './TenantProfileView';
import { ReassignAgentDialog } from '@/components/shared/ReassignAgentDialog';
import { HouseActivityTimeline } from '@/components/shared/HouseActivityTimeline';
import { HouseBonusTimeline } from './HouseBonusTimeline';
import { HighlightText } from '@/components/shared/HighlightText';
import { useFilterKeyboardShortcuts } from '@/hooks/useFilterKeyboardShortcuts';
import { HouseDetailSheet } from './HouseDetailSheet';
import AgentRentRequestDialog from './AgentRentRequestDialog';
import { MoveInOfferBadge } from '@/components/house/MoveInOfferBadge';
import RegisterLandlordDialog from './RegisterLandlordDialog';

interface AgentListingsSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onListHouse?: () => void;
  /** When true (e.g. opened from the empty-house promo banner), force the
   *  "vacant / empty houses" filter so only campaign-eligible listings show. */
  vacantOnly?: boolean;
}

export function AgentListingsSheet({ open, onOpenChange, onListHouse, vacantOnly = false }: AgentListingsSheetProps) {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { toast } = useToast();
  const { listings, loading, refresh } = useHouseListings({
    agentId: user?.id,
    status: undefined, // show all statuses for agent
    limit: 100,
  });
  const [relisting, setRelisting] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [timelineOpen, setTimelineOpen] = useState<Record<string, boolean>>({});
  const [viewingTenantId, setViewingTenantId] = useState<string | null>(null);
  const [detailListingId, setDetailListingId] = useState<string | null>(null);
  const [editingListing, setEditingListing] = useState<HouseListing | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<HouseListing | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [vacateTarget, setVacateTarget] = useState<HouseListing | null>(null);
  const [vacating, setVacating] = useState(false);
  // "Swap tenant" flow: confirm → vacate current tenant → open rent request
  // dialog with this house preselected so the new tenant is linked in one go.
  const [swapTarget, setSwapTarget] = useState<HouseListing | null>(null);
  const [swapping, setSwapping] = useState(false);
  const [swapHouseForLink, setSwapHouseForLink] = useState<{
    id: string; title: string; address: string | null; region: string | null;
    district: string | null; house_category: string | null; monthly_rent: number | null;
    short_code: string | null; latitude: number | null; longitude: number | null;
    landlord_id: string | null; landlord_name: string | null; landlord_phone: string | null;
    image_urls: string[] | null;
  } | null>(null);
  const [chipsCollapsed, setChipsCollapsed] = useState(false);
  const [registerLandlordOpen, setRegisterLandlordOpen] = useState(false);
  const emptyPrimaryRef = useRef<HTMLButtonElement>(null);
  const emptySecondaryRef = useRef<HTMLButtonElement>(null);
  // Remember the element that had focus before the sheet opened so we can
  // return focus to it when the sheet closes — keeps keyboard flow seamless.
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
  const [reassignTarget, setReassignTarget] = useState<{
    rentRequestId: string; tenantName: string; currentAgentId: string;
  } | null>(null);
  const FILTERS_STORAGE_PREFIX = 'agent-listings-sheet:filters:v2';
  const storageKey = user?.id
    ? `${FILTERS_STORAGE_PREFIX}:${user.id}`
    : `${FILTERS_STORAGE_PREFIX}:anon`;
  type SheetFilters = {
    search: string;
    statusFilter: 'all' | 'occupied' | 'vacant' | 'rejected';
    regionFilter: string;
    sortBy: 'newest' | 'oldest' | 'title' | 'region' | 'occupied_first' | 'vacant_first' | 'price_asc' | 'price_desc';
    minPrice: string;
    maxPrice: string;
  };
  const DEFAULT_FILTERS: SheetFilters = { search: '', statusFilter: 'all', regionFilter: 'all', sortBy: 'newest', minPrice: '', maxPrice: '' };
  const [search, setSearch] = useState(DEFAULT_FILTERS.search);
  const [statusFilter, setStatusFilter] = useState<SheetFilters['statusFilter']>(DEFAULT_FILTERS.statusFilter);
  const [regionFilter, setRegionFilter] = useState<string>(DEFAULT_FILTERS.regionFilter);
  const [sortBy, setSortBy] = useState<SheetFilters['sortBy']>(DEFAULT_FILTERS.sortBy);
  const [minPrice, setMinPrice] = useState<string>(DEFAULT_FILTERS.minPrice);
  const [maxPrice, setMaxPrice] = useState<string>(DEFAULT_FILTERS.maxPrice);
  const hydratedKeyRef = useRef<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTo({ top: 0, behavior: 'smooth' });
  }, [statusFilter, regionFilter, sortBy, minPrice, maxPrice, search]);

  // Re-hydrate filters whenever the active user (storage key) changes.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const raw = localStorage.getItem(storageKey);
      const next: SheetFilters = raw ? { ...DEFAULT_FILTERS, ...JSON.parse(raw) } : DEFAULT_FILTERS;
      setSearch(next.search);
      setStatusFilter(next.statusFilter);
      setRegionFilter(next.regionFilter);
      setSortBy(next.sortBy);
      setMinPrice(next.minPrice ?? '');
      setMaxPrice(next.maxPrice ?? '');
    } catch {
      setSearch(DEFAULT_FILTERS.search);
      setStatusFilter(DEFAULT_FILTERS.statusFilter);
      setRegionFilter(DEFAULT_FILTERS.regionFilter);
      setSortBy(DEFAULT_FILTERS.sortBy);
      setMinPrice(DEFAULT_FILTERS.minPrice);
      setMaxPrice(DEFAULT_FILTERS.maxPrice);
    }
    hydratedKeyRef.current = storageKey;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey]);

  useEffect(() => {
    if (hydratedKeyRef.current !== storageKey) return;
    try {
      localStorage.setItem(storageKey, JSON.stringify({ search, statusFilter, regionFilter, sortBy, minPrice, maxPrice }));
    } catch { /* ignore */ }
  }, [search, statusFilter, regionFilter, sortBy, minPrice, maxPrice, storageKey]);

  // Empty-house promo: when launched from the campaign banner, auto-apply the
  // "vacant" filter on open so agents land straight on their empty houses.
  useEffect(() => {
    if (open && vacantOnly) setStatusFilter('vacant');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, vacantOnly]);

  // Capture the element that has focus right before the sheet opens so we can
  // restore focus to it when the sheet dismisses (Escape, back-button, or tap-out).
  useEffect(() => {
    if (open) {
      previouslyFocusedRef.current = document.activeElement as HTMLElement | null;
    }
  }, [open]);

  // Enrich with landlord profile + tenant profile + active rent_request id for each occupied house.
  const [enrichment, setEnrichment] = useState<{
    landlords: Record<string, { name: string; phone: string | null }>;
    tenants: Record<string, { name: string; phone: string | null }>;
    activeRequestByTenant: Record<string, { id: string; agent_id: string | null }>;
  }>({ landlords: {}, tenants: {}, activeRequestByTenant: {} });

  useEffect(() => {
    let cancelled = false;
    async function run() {
      if (!listings.length) return;
      const landlordIds = Array.from(new Set(listings.map(l => l.landlord_id).filter(Boolean) as string[]));
      const tenantIds = Array.from(new Set(listings.map(l => l.tenant_id).filter(Boolean) as string[]));
      // Agents can't read arbitrary landlord/tenant `profiles` rows directly
      // (RLS only exposes tenants/landlords they personally referred). The
      // `get_agent_listing_parties` SECURITY DEFINER RPC returns the names +
      // phones of the landlords and tenants attached to THIS agent's own
      // listings — otherwise landlord group headers stay stuck on "Loading…".
      const [parties, reqs] = await Promise.all([
        user?.id
          ? (supabase as any).rpc('get_agent_listing_parties', { p_agent_id: user.id })
          : Promise.resolve({ data: [] as any }),
        tenantIds.length
          ? supabase.from('rent_requests').select('id,tenant_id,agent_id,created_at').in('tenant_id', tenantIds).order('created_at', { ascending: false })
          : Promise.resolve({ data: [] as any }),
      ]);
      if (cancelled) return;
      const partyMap = new Map<string, { full_name: string | null; phone: string | null }>(
        ((parties.data ?? []) as any[]).map((r) => [r.user_id, { full_name: r.full_name, phone: r.phone }]),
      );
      const lmap: Record<string, { name: string; phone: string | null }> = {};
      for (const id of landlordIds) {
        const p = partyMap.get(id);
        lmap[id] = { name: p?.full_name || 'Unknown landlord', phone: p?.phone ?? null };
      }
      const tmap: Record<string, { name: string; phone: string | null }> = {};
      for (const id of tenantIds) {
        const p = partyMap.get(id);
        tmap[id] = { name: p?.full_name || 'Unknown tenant', phone: p?.phone ?? null };
      }
      const rmap: Record<string, { id: string; agent_id: string | null }> = {};
      for (const r of (reqs.data ?? []) as any[]) {
        if (!rmap[r.tenant_id]) rmap[r.tenant_id] = { id: r.id, agent_id: r.agent_id };
      }
      setEnrichment({ landlords: lmap, tenants: tmap, activeRequestByTenant: rmap });
    }
    run();
    return () => { cancelled = true; };
  }, [listings, user?.id]);

  const handleRelist = async (listing: HouseListing) => {
    setRelisting(listing.id);
    try {
      const { error } = await supabase
        .from('house_listings')
        .update({ status: 'available' })
        .eq('id', listing.id);
      if (error) throw error;
      toast({ title: 'Relisted', description: `${listing.title} is now available again.` });
      refresh();
    } catch (err: any) {
      toast({ title: 'Failed', description: err.message, variant: 'destructive' });
    } finally {
      setRelisting(null);
    }
  };

  // Move the current tenant out of a house, freeing it so the agent can place a
  // new tenant. Clears tenant_id and flips the listing back to "available" — the
  // rent request flow's house search then finds it again for re-assignment.
  const handleVacate = async () => {
    if (!vacateTarget || !user?.id) return;
    setVacating(true);
    try {
      const { error } = await supabase
        .from('house_listings')
        .update({ tenant_id: null, status: 'available' })
        .eq('id', vacateTarget.id)
        .eq('agent_id', user.id);
      if (error) throw error;
      toast({
        title: 'Tenant moved out',
        description: `${vacateTarget.title} is now available — post a new rent request to link a new tenant.`,
      });
      setVacateTarget(null);
      refresh();
    } catch (err: any) {
      toast({ title: 'Could not move tenant out', description: err.message, variant: 'destructive' });
    } finally {
      setVacating(false);
    }
  };

  // Single "Swap tenant" flow: move the current tenant out and immediately open
  // the rent request dialog with this house preselected so the agent links the
  // new tenant without re-searching. One confirmation, then straight to the form.
  const handleSwap = async () => {
    if (!swapTarget || !user?.id) return;
    setSwapping(true);
    try {
      const { error } = await supabase
        .from('house_listings')
        .update({ tenant_id: null, status: 'available' })
        .eq('id', swapTarget.id)
        .eq('agent_id', user.id);
      if (error) throw error;
      const landlord = swapTarget.landlord_id ? enrichment.landlords[swapTarget.landlord_id] : null;
      setSwapHouseForLink({
        id: swapTarget.id,
        title: swapTarget.title,
        address: swapTarget.address ?? null,
        region: swapTarget.region ?? null,
        district: swapTarget.district ?? null,
        house_category: swapTarget.house_category ?? null,
        monthly_rent: swapTarget.monthly_rent ?? null,
        short_code: swapTarget.short_code ?? null,
        latitude: swapTarget.latitude ?? null,
        longitude: swapTarget.longitude ?? null,
        landlord_id: swapTarget.landlord_id ?? null,
        landlord_name: landlord?.name ?? null,
        landlord_phone: landlord?.phone ?? null,
        image_urls: swapTarget.image_urls ?? null,
      });
      setSwapTarget(null);
      refresh();
    } catch (err: any) {
      toast({ title: 'Could not swap tenant', description: err.message, variant: 'destructive' });
    } finally {
      setSwapping(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    if (deleteTarget.tenant_id) {
      toast({ title: 'Cannot remove', description: 'This house is occupied. Move the tenant out first.', variant: 'destructive' });
      return;
    }
    setDeleting(true);
    try {
      const { error } = await supabase.from('house_listings').delete().eq('id', deleteTarget.id);
      if (error) throw error;
      toast({ title: 'Listing removed', description: `${deleteTarget.title} was removed from your account.` });
      setDeleteTarget(null);
      refresh();
    } catch (err: any) {
      toast({ title: 'Remove failed', description: err.message, variant: 'destructive' });
    } finally {
      setDeleting(false);
    }
  };

  const shareOnWhatsApp = (l: HouseListing) => {
    const origin = typeof window !== 'undefined' ? window.location.origin : '';
    const link = `${origin}/house/${l.short_code || l.id}`;
    const lines = [
      `🏠 *${l.title}* is available for rent`,
      `📍 ${l.address}${l.region ? `, ${l.region}` : ''}`,
      `💰 ${formatUGX(l.monthly_rent)}/month  (≈ ${formatUGX(l.daily_rate)}/day on Welile)`,
      ``,
      `🎁 Move in TODAY — your first 7 days are FREE, then just pay daily.`,
      `Pay daily, weekly, or monthly through Welile — no big upfront deposit needed.`,
      `View & reserve here: ${link}`,
    ];
    const text = encodeURIComponent(lines.join('\n'));
    const url = `https://wa.me/?text=${text}`;
    window.open(url, '_blank', 'noopener,noreferrer');
  };

  const rejected = listings.filter(l => l.status === 'rejected');
  const others = listings.filter(l => l.status !== 'rejected');

  // Fetch the most recent rejection reason for each rejected listing so the
  // agent can see WHY it was rejected and fix it before relisting.
  const [rejectionReasons, setRejectionReasons] = useState<Record<string, { reason: string; rejected_at: string }>>({});
  useEffect(() => {
    let cancelled = false;
    async function loadReasons() {
      if (!user?.id || rejected.length === 0) { setRejectionReasons({}); return; }
      const ids = rejected.map(l => l.id);
      const { data, error } = await supabase
        .from('agent_listing_rejections')
        .select('listing_id, reason, rejected_at')
        .eq('agent_id', user.id)
        .in('listing_id', ids)
        .order('rejected_at', { ascending: false });
      if (cancelled || error || !data) return;
      const map: Record<string, { reason: string; rejected_at: string }> = {};
      for (const r of data as any[]) {
        if (r.listing_id && !map[r.listing_id]) {
          map[r.listing_id] = { reason: r.reason, rejected_at: r.rejected_at };
        }
      }
      setRejectionReasons(map);
    }
    loadReasons();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id, rejected.map(l => l.id).join(',')]);

  // Group `others` by landlord_id
  const grouped = useMemo(() => {
    type Group = { landlord_id: string | null; name: string; phone: string | null; houses: HouseListing[] };
    const map = new Map<string, Group>();
    for (const h of others) {
      const key = h.landlord_id ?? '__none__';
      const prof = h.landlord_id ? enrichment.landlords[h.landlord_id] : null;
      const g = map.get(key) ?? {
        landlord_id: h.landlord_id ?? null,
        name: prof?.name ?? (h.landlord_id ? 'Loading…' : 'No landlord on file'),
        phone: prof?.phone ?? null,
        houses: [],
      };
      g.houses.push(h);
      map.set(key, g);
    }
    return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
  }, [others, enrichment.landlords]);

  const regions = useMemo(() => {
    const set = new Set<string>();
    for (const l of listings) if (l.region) set.add(l.region);
    return Array.from(set).sort();
  }, [listings]);

  const q = search.trim().toLowerCase();
  const minPriceNum = minPrice.trim() ? Number(minPrice) : null;
  const maxPriceNum = maxPrice.trim() ? Number(maxPrice) : null;
  const matchHouse = (l: HouseListing) => {
    if (regionFilter !== 'all' && l.region !== regionFilter) return false;
    if (statusFilter === 'occupied' && !l.tenant_id) return false;
    if (statusFilter === 'vacant' && (l.tenant_id || l.status !== 'available')) return false;
    const rent = l.monthly_rent ?? 0;
    if (minPriceNum !== null && !Number.isNaN(minPriceNum) && rent < minPriceNum) return false;
    if (maxPriceNum !== null && !Number.isNaN(maxPriceNum) && rent > maxPriceNum) return false;
    if (!q) return true;
    const tenant = l.tenant_id ? enrichment.tenants[l.tenant_id] : null;
    const landlord = l.landlord_id ? enrichment.landlords[l.landlord_id] : null;
    return (
      l.title.toLowerCase().includes(q) ||
      l.address.toLowerCase().includes(q) ||
      (l.region ?? '').toLowerCase().includes(q) ||
      (tenant?.name.toLowerCase().includes(q) ?? false) ||
      (tenant?.phone ?? '').includes(q) ||
      (landlord?.name.toLowerCase().includes(q) ?? false) ||
      (landlord?.phone ?? '').includes(q)
    );
  };

  const sortHouses = (arr: HouseListing[]) => {
    const copy = [...arr];
    copy.sort((a, b) => {
      switch (sortBy) {
        case 'oldest': return (a.created_at || '').localeCompare(b.created_at || '');
        case 'title': return a.title.localeCompare(b.title);
        case 'region': return (a.region || '').localeCompare(b.region || '') || a.title.localeCompare(b.title);
        case 'occupied_first': return (a.tenant_id ? 0 : 1) - (b.tenant_id ? 0 : 1);
        case 'vacant_first': return (a.tenant_id ? 1 : 0) - (b.tenant_id ? 1 : 0);
        case 'price_asc': return (a.monthly_rent ?? 0) - (b.monthly_rent ?? 0);
        case 'price_desc': return (b.monthly_rent ?? 0) - (a.monthly_rent ?? 0);
        case 'newest':
        default: return (b.created_at || '').localeCompare(a.created_at || '');
      }
    });
    return copy;
  };

  const filteredGrouped = useMemo(() => {
    if (statusFilter === 'rejected') return [];
    return grouped
      .map(g => ({ ...g, houses: sortHouses(g.houses.filter(matchHouse)) }))
      .filter(g => g.houses.length > 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [grouped, search, statusFilter, regionFilter, enrichment, sortBy, minPrice, maxPrice]);

  const filteredRejected = useMemo(() => {
    if (statusFilter !== 'all' && statusFilter !== 'rejected') return [];
    return sortHouses(rejected.filter(matchHouse));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rejected, search, statusFilter, regionFilter, enrichment, sortBy, minPrice, maxPrice]);

  const hasActiveFilter = q.length > 0 || statusFilter !== 'all' || regionFilter !== 'all' || sortBy !== 'newest' || minPrice.trim() !== '' || maxPrice.trim() !== '';

  // Pagination over landlord groups
  const GROUPS_PER_PAGE = 5;
  const [page, setPage] = useState(1);
  const totalPages = Math.max(1, Math.ceil(filteredGrouped.length / GROUPS_PER_PAGE));
  useEffect(() => { setPage(1); }, [search, statusFilter, regionFilter, sortBy, minPrice, maxPrice, open]);
  useEffect(() => { if (page > totalPages) setPage(totalPages); }, [page, totalPages]);
  const pagedGrouped = useMemo(
    () => filteredGrouped.slice((page - 1) * GROUPS_PER_PAGE, page * GROUPS_PER_PAGE),
    [filteredGrouped, page]
  );

  const searchRef = useRef<HTMLInputElement>(null);
  const clearAll = () => { setSearch(''); setStatusFilter('all'); setRegionFilter('all'); setSortBy('newest'); setMinPrice(''); setMaxPrice(''); };
  useFilterKeyboardShortcuts({ inputRef: searchRef, onClear: clearAll, hasActiveFilter, enabled: open });

  return (
    <>
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        className="h-[90vh] rounded-t-3xl p-0 flex flex-col"
        // Keep focus inside the sheet on open. When the empty state is showing,
        // land focus on its primary CTA (falling back to the secondary CTA) so
        // keyboard + screen-reader users start *inside* the trapped sheet.
        onOpenAutoFocus={(e) => {
          if (!loading && listings.length === 0) {
            const target = emptyPrimaryRef.current ?? emptySecondaryRef.current;
            if (target) {
              e.preventDefault();
              target.focus();
            }
          }
        }}
        onCloseAutoFocus={(e) => {
          // Return focus to whatever element triggered the sheet so keyboard
          // users continue from where they left off. If the saved element is
          // no longer in the DOM (e.g. unmounted), fall back to document body.
          const target = previouslyFocusedRef.current;
          if (target && document.contains(target)) {
            e.preventDefault();
            target.focus();
          }
          previouslyFocusedRef.current = null;
        }}
      >
        <SheetHeader className="px-5 pt-5 pb-3 border-b border-border">
          <SheetTitle className="flex items-center gap-2">
            <Home className="h-5 w-5 text-primary" />
            List empty house or register new landlord
          </SheetTitle>
          {vacantOnly && (
            <div className="mt-2 rounded-lg bg-emerald-50 border border-emerald-200 px-3 py-2 flex items-start gap-2">
              <div className="mt-0.5 shrink-0 rounded-full bg-emerald-500 text-white p-1">
                <Trophy className="h-3.5 w-3.5" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="text-sm font-semibold text-emerald-900">Promo Mode</span>
                  <span className="inline-flex items-center rounded-full bg-amber-100 text-amber-800 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide border border-amber-200">
                    <Sparkles className="h-3 w-3 mr-1" />
                    Weekly Prize
                  </span>
                </div>
                <p className="text-xs text-emerald-700 mt-0.5 leading-relaxed">
                  You’re viewing your <span className="font-semibold text-emerald-900">empty houses</span> eligible for the campaign. Register more landlords with empty houses to hit <span className="font-bold text-emerald-900">10 this week</span> and win <span className="font-bold text-emerald-900">UGX 70,000</span>.
                </p>
              </div>
            </div>
          )}
          {!loading && listings.length > 0 && (
            <div className="space-y-2 pt-2">
              {(() => {
                const counts = {
                  all: listings.length,
                  vacant: listings.filter(l => !l.tenant_id && l.status === 'available').length,
                  occupied: listings.filter(l => !!l.tenant_id).length,
                  rejected: listings.filter(l => l.status === 'rejected').length,
                };
                return (
                  <Tabs value={statusFilter} onValueChange={(v: any) => setStatusFilter(v)}>
                    <TabsList className="w-full h-9 grid grid-cols-4">
                      <TabsTrigger value="all" className="text-xs">All <span className="ml-1 text-muted-foreground">{counts.all}</span></TabsTrigger>
                      <TabsTrigger value="vacant" className="text-xs">Available <span className="ml-1 text-muted-foreground">{counts.vacant}</span></TabsTrigger>
                      <TabsTrigger value="occupied" className="text-xs">Occupied <span className="ml-1 text-muted-foreground">{counts.occupied}</span></TabsTrigger>
                      <TabsTrigger value="rejected" className="text-xs">Rejected <span className="ml-1 text-muted-foreground">{counts.rejected}</span></TabsTrigger>
                    </TabsList>
                  </Tabs>
                );
              })()}
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  ref={searchRef}
                  placeholder="Search landlord, house, tenant, phone…  ( / focus · Esc clear )"
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  className="pl-9 pr-9 h-9"
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
                <Select value={regionFilter} onValueChange={setRegionFilter}>
                  <SelectTrigger className="h-8 w-auto min-w-[130px] text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All regions</SelectItem>
                    {regions.map(r => <SelectItem key={r} value={r}>{r}</SelectItem>)}
                  </SelectContent>
                </Select>
                <Select value={sortBy} onValueChange={(v: any) => setSortBy(v)}>
                  <SelectTrigger className="h-8 w-auto min-w-[140px] text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="newest">Newest first</SelectItem>
                    <SelectItem value="oldest">Oldest first</SelectItem>
                    <SelectItem value="title">Title (A–Z)</SelectItem>
                    <SelectItem value="region">Region (A–Z)</SelectItem>
                    <SelectItem value="occupied_first">Occupied first</SelectItem>
                    <SelectItem value="vacant_first">Vacant first</SelectItem>
                    <SelectItem value="price_asc">Price (low → high)</SelectItem>
                    <SelectItem value="price_desc">Price (high → low)</SelectItem>
                  </SelectContent>
                </Select>
                <Button
                  variant="outline" size="sm" className="h-8 text-xs gap-1"
                  onClick={clearAll}
                  disabled={!hasActiveFilter}
                  title="Reset search, status, region, and sort back to defaults"
                >
                  <X className="h-3 w-3" /> Reset filters
                </Button>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[11px] text-muted-foreground shrink-0">Rent UGX</span>
                <Input
                  type="number"
                  inputMode="numeric"
                  min={0}
                  placeholder="Min"
                  value={minPrice}
                  onChange={e => setMinPrice(e.target.value.replace(/[^0-9]/g, ''))}
                  className="h-8 text-xs"
                  aria-label="Minimum monthly rent in UGX"
                />
                <span className="text-xs text-muted-foreground">–</span>
                <Input
                  type="number"
                  inputMode="numeric"
                  min={0}
                  placeholder="Max"
                  value={maxPrice}
                  onChange={e => setMaxPrice(e.target.value.replace(/[^0-9]/g, ''))}
                  className="h-8 text-xs"
                  aria-label="Maximum monthly rent in UGX"
                />
                {(minPrice || maxPrice) && (
                  <Button
                    variant="ghost" size="icon" className="h-8 w-8 shrink-0"
                    aria-label="Clear price range"
                    onClick={() => { setMinPrice(''); setMaxPrice(''); }}
                  >
                    <X className="h-3.5 w-3.5" />
                  </Button>
                )}
              </div>
            </div>
          )}
        </SheetHeader>

        <div ref={scrollRef} className="flex-1 overflow-y-auto overscroll-contain px-4 py-4 space-y-3">
          {!loading && listings.length > 0 && hasActiveFilter && (() => {
            const SORT_LABELS: Record<SheetFilters['sortBy'], string> = {
              newest: 'Newest first',
              oldest: 'Oldest first',
              title: 'Title (A–Z)',
              region: 'Region (A–Z)',
              occupied_first: 'Occupied first',
              vacant_first: 'Vacant first',
              price_asc: 'Price (low → high)',
              price_desc: 'Price (high → low)',
            };
            const STATUS_LABELS: Record<SheetFilters['statusFilter'], string> = {
              all: 'All', vacant: 'Available', occupied: 'Occupied', rejected: 'Rejected',
            };
            type Chip = { key: string; label: string; onRemove: () => void };
            const chips: Chip[] = [];
            if (q) chips.push({ key: 'q', label: `“${search}”`, onRemove: () => setSearch('') });
            if (statusFilter !== 'all') chips.push({ key: 's', label: STATUS_LABELS[statusFilter], onRemove: () => setStatusFilter('all') });
            if (regionFilter !== 'all') chips.push({ key: 'r', label: regionFilter, onRemove: () => setRegionFilter('all') });
            if (minPrice || maxPrice) {
              const lo = minPrice ? formatUGX(Number(minPrice)) : 'Any';
              const hi = maxPrice ? formatUGX(Number(maxPrice)) : 'Any';
              chips.push({ key: 'p', label: `${lo} – ${hi}`, onRemove: () => { setMinPrice(''); setMaxPrice(''); } });
            }
            if (sortBy !== 'newest') chips.push({ key: 'sort', label: `Sort: ${SORT_LABELS[sortBy]}`, onRemove: () => setSortBy('newest') });
            if (chips.length === 0) return null;
            return (
              <div className="sticky top-0 z-10 -mx-4 -mt-4 px-4 pt-3 pb-2 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80 border-b border-border">
                {chipsCollapsed ? (
                  <button
                    onClick={() => setChipsCollapsed(false)}
                    className="inline-flex items-center gap-1.5 rounded-full bg-primary/10 text-primary border border-primary/20 px-2.5 py-1 text-[11px] font-medium hover:bg-primary/15 transition-colors"
                    aria-expanded={false}
                    aria-label="Show active filters"
                  >
                    <span>{chips.length} filter{chips.length === 1 ? '' : 's'} active</span>
                    <ChevronDown className="h-3 w-3" />
                  </button>
                ) : (
                  <div className="flex flex-wrap items-center gap-1.5">
                    {chips.map(c => (
                      <button
                        key={c.key}
                        onClick={c.onRemove}
                        className="inline-flex items-center gap-1 rounded-full bg-primary/10 text-primary border border-primary/20 px-2.5 py-1 text-[11px] font-medium hover:bg-primary/15 transition-colors"
                        aria-label={`Remove filter ${c.label}`}
                      >
                        <span className="truncate max-w-[160px]">{c.label}</span>
                        <X className="h-3 w-3 shrink-0" />
                      </button>
                    ))}
                    <button
                      onClick={clearAll}
                      className="text-[11px] text-muted-foreground hover:text-foreground underline-offset-2 hover:underline ml-1"
                    >
                      Clear all
                    </button>
                    <button
                      onClick={() => setChipsCollapsed(true)}
                      className="ml-auto inline-flex items-center gap-1 rounded-full px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                      aria-expanded={true}
                      aria-label="Hide active filters"
                    >
                      Hide <ChevronUp className="h-3 w-3" />
                    </button>
                  </div>
                )}
              </div>
            );
          })()}
          {loading ? (
            Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-28 w-full rounded-2xl" />
            ))
          ) : listings.length === 0 ? (
            <div
              className="text-center py-10 px-5 space-y-5 max-w-sm mx-auto"
              role="status"
              aria-live="polite"
              aria-label="No houses listed"
            >
              <div className="mx-auto h-20 w-20 rounded-3xl bg-primary/10 flex items-center justify-center" aria-hidden="true">
                <Home className="h-10 w-10 text-primary" />
              </div>
              <div className="space-y-2">
                <p className="font-bold text-lg" id="empty-state-title">No houses listed yet</p>
                <p className="text-sm text-muted-foreground leading-relaxed" id="empty-state-desc">
                  Start building your portfolio by listing an empty house.
                  Earn <span className="font-semibold text-foreground">UGX 5,000</span> every time a tenant moves in.
                </p>
              </div>

              <div className="space-y-2.5">
                {onListHouse && (
                  <Button
                    ref={emptyPrimaryRef}
                    aria-describedby="empty-state-desc"
                    onClick={() => { onOpenChange(false); onListHouse(); }}
                    className="w-full gap-2 h-12 text-base font-semibold"
                  >
                    <Plus className="h-5 w-5" aria-hidden="true" />
                    List your first house
                  </Button>
                )}
                <Button
                  variant="outline"
                  aria-describedby="empty-state-desc"
                  onClick={() => setRegisterLandlordOpen(true)}
                  className="w-full gap-2 h-12 text-base"
                >
                  <Building2 className="h-5 w-5" aria-hidden="true" />
                  Register new landlord
                </Button>
                <Button
                  variant="outline"
                  ref={emptySecondaryRef}
                  aria-describedby="empty-state-desc"
                  onClick={() => { onOpenChange(false); navigate('/find-a-house'); }}
                  className="w-full gap-2 h-12 text-base"
                >
                  <Search className="h-5 w-5" aria-hidden="true" />
                  Browse houses to rent
                </Button>
              </div>

              <div className="rounded-xl bg-muted/60 px-4 py-3 text-left space-y-1.5">
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Why list a house?</p>
                <ul className="text-sm text-muted-foreground space-y-1" aria-label="Benefits of listing a house">
                  <li className="flex items-start gap-2">
                    <CheckCircle className="h-4 w-4 text-emerald-500 shrink-0 mt-0.5" aria-hidden="true" />
                    <span>Get paid when tenants move in</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <CheckCircle className="h-4 w-4 text-emerald-500 shrink-0 mt-0.5" aria-hidden="true" />
                    <span>Earn 10% commission on rent collected</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <CheckCircle className="h-4 w-4 text-emerald-500 shrink-0 mt-0.5" aria-hidden="true" />
                    <span>Fill empty houses faster with daily rent</span>
                  </li>
                </ul>
              </div>
            </div>
          ) : (
            <>
              {filteredRejected.length === 0 && filteredGrouped.length === 0 && hasActiveFilter && (() => {
                const isSearching = q.length > 0 || regionFilter !== 'all';
                const tab = isSearching ? 'search' : statusFilter;
                const copy: Record<string, { icon: any; title: string; body: string; iconColor: string; bg: string }> = {
                  search:   { icon: Search,         iconColor: 'text-muted-foreground/60', bg: 'bg-muted',          title: 'No houses match your filters', body: 'Try a different search term or region, or reset your filters.' },
                  vacant:   { icon: CheckCircle,    iconColor: 'text-emerald-600',         bg: 'bg-emerald-500/10', title: 'No available houses right now', body: 'Every house in your portfolio is occupied or pending. Add a new empty house to keep earning placement bonuses.' },
                  occupied: { icon: DoorOpen,       iconColor: 'text-sky-600',             bg: 'bg-sky-500/10',     title: 'No occupied houses yet',        body: 'Once a tenant moves into one of your listed houses, you’ll see them here.' },
                  rejected: { icon: CheckCircle,    iconColor: 'text-emerald-600',         bg: 'bg-emerald-500/10', title: 'No rejected listings',          body: 'Great work — none of your listings need revisions right now.' },
                  all:      { icon: Home,           iconColor: 'text-primary',             bg: 'bg-primary/10',     title: 'No houses to show',             body: 'Try a different filter or list a new house.' },
                };
                const c = copy[tab] ?? copy.all;
                const Icon = c.icon;
                return (
                  <div className="text-center py-12 px-6 space-y-4 max-w-sm mx-auto">
                    <div className={`mx-auto h-14 w-14 rounded-2xl ${c.bg} flex items-center justify-center`}>
                      <Icon className={`h-7 w-7 ${c.iconColor}`} />
                    </div>
                    <div className="space-y-1">
                      <p className="font-semibold text-base">{c.title}</p>
                      <p className="text-sm text-muted-foreground">{c.body}</p>
                    </div>
                    <div className="flex flex-col sm:flex-row items-center justify-center gap-2 pt-1">
                      {hasActiveFilter && (
                        <Button variant="outline" size="sm" onClick={clearAll} className="gap-1">
                          <X className="h-3.5 w-3.5" /> Clear filters
                        </Button>
                      )}
                      {onListHouse && (
                        <Button
                          size="sm"
                          onClick={() => { onOpenChange(false); onListHouse(); }}
                          className="gap-1"
                        >
                          <Plus className="h-4 w-4" /> List a house
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setRegisterLandlordOpen(true)}
                        className="gap-1"
                      >
                        <Building2 className="h-4 w-4" /> Register landlord
                      </Button>
                    </div>
                  </div>
                );
              })()}
              {/* Rejected listings - shown prominently at top */}
              {filteredRejected.length > 0 && (
                <div className="space-y-2">
                  <div className="flex items-center gap-2 px-1">
                    <AlertTriangle className="h-4 w-4 text-destructive" />
                    <p className="text-xs font-bold text-destructive">
                      {filteredRejected.length} Rejected — needs revision
                    </p>
                  </div>
                  {filteredRejected.map(l => (
                    <motion.div
                      key={l.id}
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      className="rounded-xl border-2 border-destructive/30 bg-destructive/5 p-3 space-y-2"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <p className="font-semibold text-sm truncate"><HighlightText text={l.title} query={search} /></p>
                          <div className="flex items-center gap-1 text-xs text-muted-foreground">
                            <MapPin className="h-3 w-3" />
                            <span className="truncate"><HighlightText text={l.address} query={search} />, <HighlightText text={l.region} query={search} /></span>
                          </div>
                        </div>
                        <Badge variant="destructive" className="text-[10px] shrink-0">
                          <AlertTriangle className="h-3 w-3 mr-1" /> Rejected
                        </Badge>
                      </div>
                      {rejectionReasons[l.id]?.reason && (
                        <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-2">
                          <p className="text-[10px] font-semibold uppercase tracking-wide text-destructive mb-0.5">
                            Rejection reason
                          </p>
                          <p className="text-xs text-foreground/90 whitespace-pre-wrap break-words">
                            {rejectionReasons[l.id].reason}
                          </p>
                          <p className="text-[10px] text-muted-foreground mt-1">
                            {new Date(rejectionReasons[l.id].rejected_at).toLocaleString()}
                          </p>
                        </div>
                      )}
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-muted-foreground">{formatUGX(l.monthly_rent)}/mo</span>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-8 text-xs gap-1"
                          onClick={() => setEditingListing(l)}
                        >
                          <Pencil className="h-3 w-3" />
                          Edit House
                        </Button>
                      </div>
                    </motion.div>
                  ))}
                </div>
              )}

              {/* Houses grouped by landlord */}
              {pagedGrouped.map(g => {
                const key = g.landlord_id ?? '__none__';
                const isOpen = expanded[key] !== false; // default open
                return (
                  <div key={key} className="rounded-xl border border-border bg-card overflow-hidden">
                    <button
                      onClick={() => setExpanded(s => ({ ...s, [key]: !isOpen }))}
                      className="w-full text-left p-3 active:bg-muted/50 transition-colors flex items-center justify-between gap-2 min-h-[56px]"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <Building2 className="h-4 w-4 text-sky-600 shrink-0" />
                        <div className="min-w-0">
                          <p className="font-bold text-sm truncate"><HighlightText text={g.name} query={search} /></p>
                          <p className="text-[11px] text-muted-foreground">
                            {g.phone ? <><HighlightText text={g.phone} query={search} /> · </> : ''}{g.houses.length} house{g.houses.length === 1 ? '' : 's'}
                          </p>
                        </div>
                      </div>
                      {isOpen ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
                    </button>

                    {isOpen && (
                      <div className="border-t bg-muted/10 p-2 space-y-2">
                        {g.houses.map(l => {
                          const tenant = l.tenant_id ? enrichment.tenants[l.tenant_id] : null;
                          const req = l.tenant_id ? enrichment.activeRequestByTenant[l.tenant_id] : null;
                          return (
                            <motion.div
                              key={l.id}
                              initial={{ opacity: 0 }}
                              animate={{ opacity: 1 }}
                              role="button"
                              tabIndex={0}
                              aria-label={`Open details for ${l.title}`}
                              onClick={() => setDetailListingId(l.id)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter' || e.key === ' ') {
                                  e.preventDefault();
                                  setDetailListingId(l.id);
                                }
                              }}
                              className="rounded-lg border border-border bg-background p-3 space-y-2 cursor-pointer hover:bg-accent/30 active:bg-accent/40 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                            >
                              <div className="flex items-start justify-between gap-2">
                                <div className="min-w-0 flex-1">
                                  <p className="font-semibold text-sm truncate"><HighlightText text={l.title} query={search} /></p>
                                  <div className="flex items-center gap-1 text-xs text-muted-foreground">
                                    <MapPin className="h-3 w-3" />
                                    <span className="truncate"><HighlightText text={l.address} query={search} />, <HighlightText text={l.region} query={search} /></span>
                                  </div>
                                </div>
                                <div className="flex items-center gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
                                  <Badge variant={l.status === 'available' ? 'default' : 'secondary'} className="text-[10px]">
                                    {l.status === 'available' ? (
                                      <><CheckCircle className="h-3 w-3 mr-1" /> Available</>
                                    ) : l.status === 'occupied' ? (
                                      <><DoorOpen className="h-3 w-3 mr-1" /> Occupied</>
                                    ) : (
                                      <><Clock className="h-3 w-3 mr-1" /> {l.status}</>
                                    )}
                                  </Badge>
                                  <DropdownMenu>
                                    <DropdownMenuTrigger asChild>
                                      <Button
                                        size="icon"
                                        variant="ghost"
                                        className="h-7 w-7"
                                        aria-label={`Actions for ${l.title}`}
                                        onClick={(e) => e.stopPropagation()}
                                      >
                                        <MoreVertical className="h-4 w-4" />
                                      </Button>
                                    </DropdownMenuTrigger>
                                    <DropdownMenuContent align="end" className="w-44">
                                      <DropdownMenuItem onClick={() => setDetailListingId(l.id)}>
                                        <Eye className="h-4 w-4 mr-2" /> View details
                                      </DropdownMenuItem>
                                      <DropdownMenuItem onClick={() => setEditingListing(l)}>
                                        <Pencil className="h-4 w-4 mr-2" /> Edit listing
                                      </DropdownMenuItem>
                                      {!l.tenant_id && l.status === 'available' && (
                                        <DropdownMenuItem onClick={() => shareOnWhatsApp(l)}>
                                          <MessageCircle className="h-4 w-4 mr-2 text-emerald-600" /> Share on WhatsApp
                                        </DropdownMenuItem>
                                      )}
                                      {l.tenant_id && (
                                        <DropdownMenuItem onClick={() => setVacateTarget(l)}>
                                          <UserMinus className="h-4 w-4 mr-2 text-amber-600" /> Move tenant out
                                        </DropdownMenuItem>
                                      )}
                                      {l.tenant_id && (
                                        <DropdownMenuItem onClick={() => setSwapTarget(l)}>
                                          <Repeat className="h-4 w-4 mr-2 text-primary" /> Swap tenant
                                        </DropdownMenuItem>
                                      )}
                                      <DropdownMenuSeparator />
                                      <DropdownMenuItem
                                        className="text-destructive focus:text-destructive"
                                        disabled={!!l.tenant_id}
                                        onClick={() => setDeleteTarget(l)}
                                      >
                                        <Trash2 className="h-4 w-4 mr-2" /> Remove listing
                                      </DropdownMenuItem>
                                    </DropdownMenuContent>
                                  </DropdownMenu>
                                </div>
                              </div>

                              <div className="flex items-center justify-between text-xs">
                                <span className="text-muted-foreground">{formatUGX(l.monthly_rent)}/mo</span>
                                <span className="font-bold text-success">{formatUGX(l.daily_rate)}/day</span>
                              </div>

                              <MoveInOfferBadge className="w-full justify-center" />

                              <div onClick={(e) => e.stopPropagation()}>
                                <Button
                                  size="sm"
                                  className="w-full h-9 text-xs gap-1.5 bg-emerald-600 hover:bg-emerald-700 text-white"
                                  onClick={() => shareOnWhatsApp(l)}
                                >
                                  <MessageCircle className="h-3.5 w-3.5" />
                                  Share on WhatsApp
                                </Button>
                              </div>

                              <div className="rounded-md bg-muted/40 p-2 text-[11px] flex items-center gap-1.5">
                                <User className="h-3 w-3 shrink-0" />
                                <span className="font-medium">Tenant:</span>
                                <span className="truncate flex-1">
                                  {tenant ? (
                                    <>
                                      <HighlightText text={tenant.name} query={search} />
                                      {tenant.phone ? <> · <HighlightText text={tenant.phone} query={search} /></> : null}
                                    </>
                                  ) : '—'}
                                </span>
                              </div>

                              {l.tenant_id && (
                                <div className="flex flex-wrap gap-1.5" onClick={(e) => e.stopPropagation()}>
                                  <Button
                                    size="sm" variant="outline" className="h-8 text-xs gap-1"
                                    onClick={() => setViewingTenantId(l.tenant_id!)}
                                  >
                                    <Pencil className="h-3 w-3" /> Change tenant profile
                                  </Button>
                                  <Button
                                    size="sm" variant="outline"
                                    className="h-8 text-xs gap-1 border-amber-500/40 text-amber-700 hover:bg-amber-500/10"
                                    onClick={() => setVacateTarget(l)}
                                  >
                                    <UserMinus className="h-3 w-3" /> Move out & replace
                                  </Button>
                                  <Button
                                    size="sm"
                                    className="h-8 text-xs gap-1 bg-primary hover:bg-primary/90 text-primary-foreground"
                                    onClick={() => setSwapTarget(l)}
                                  >
                                    <Repeat className="h-3 w-3" /> Swap tenant
                                  </Button>
                                  {req && (
                                    <Button
                                      size="sm" variant="outline" className="h-8 text-xs gap-1"
                                      onClick={() => setReassignTarget({
                                        rentRequestId: req.id,
                                        tenantName: tenant?.name ?? 'tenant',
                                        currentAgentId: req.agent_id ?? (l.agent_id ?? ''),
                                      })}
                                    >
                                      <UserCog className="h-3 w-3" /> Reassign agent
                                    </Button>
                                  )}
                                </div>
                              )}
                              <div onClick={(e) => e.stopPropagation()}>
                                <div className="rounded-md border bg-success/5 border-success/20 p-2.5">
                                  <HouseBonusTimeline listing={l} />
                                </div>
                              </div>
                              <div onClick={(e) => e.stopPropagation()}>
                                <Button
                                  size="sm" variant="ghost" className="h-7 text-[11px] gap-1 px-2"
                                  onClick={() => setTimelineOpen(s => ({ ...s, [l.id]: !s[l.id] }))}
                                  aria-expanded={!!timelineOpen[l.id]}
                                >
                                  {timelineOpen[l.id] ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                                  Timeline
                                </Button>
                                {timelineOpen[l.id] && (
                                  <div className="mt-1 rounded-md border bg-muted/10 p-2">
                                    <HouseActivityTimeline houseId={l.id} />
                                  </div>
                                )}
                              </div>
                            </motion.div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}

              {filteredGrouped.length > GROUPS_PER_PAGE && (
                <div className="flex items-center justify-between gap-2 pt-1">
                  <p className="text-[11px] text-muted-foreground">
                    Landlords {(page - 1) * GROUPS_PER_PAGE + 1}–{Math.min(page * GROUPS_PER_PAGE, filteredGrouped.length)} of {filteredGrouped.length}
                  </p>
                  <div className="flex items-center gap-1.5">
                    <Button
                      size="sm" variant="outline" className="h-8 px-2 text-xs"
                      disabled={page === 1}
                      onClick={() => setPage(p => Math.max(1, p - 1))}
                    >
                      <ChevronLeft className="h-3.5 w-3.5" /> Prev
                    </Button>
                    <span className="text-[11px] text-muted-foreground px-1">{page} / {totalPages}</span>
                    <Button
                      size="sm" variant="outline" className="h-8 px-2 text-xs"
                      disabled={page >= totalPages}
                      onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                    >
                      Next <ChevronRight className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {/* Tenant profile editor */}
        {viewingTenantId && (
          <Sheet open={!!viewingTenantId} onOpenChange={(o) => !o && setViewingTenantId(null)}>
            <SheetContent side="bottom" className="h-[95vh] rounded-t-3xl p-0 flex flex-col overflow-y-auto">
              <TenantProfileView tenantId={viewingTenantId} onBack={() => setViewingTenantId(null)} />
            </SheetContent>
          </Sheet>
        )}

        {/* Reassign agent dialog */}
        {reassignTarget && (
          <ReassignAgentDialog
            open={!!reassignTarget}
            onOpenChange={(o) => !o && setReassignTarget(null)}
            target={{ kind: 'rent_request', ...reassignTarget }}
            onComplete={refresh}
          />
        )}
      </SheetContent>
    </Sheet>
    {(() => {
      const detailListing = detailListingId ? listings.find(l => l.id === detailListingId) ?? null : null;
      const detailTenant = detailListing?.tenant_id ? enrichment.tenants[detailListing.tenant_id] : null;
      const detailLandlord = detailListing?.landlord_id ? enrichment.landlords[detailListing.landlord_id] : null;
      const detailReq = detailListing?.tenant_id ? enrichment.activeRequestByTenant[detailListing.tenant_id] : null;
      return (
        <HouseDetailSheet
          open={!!detailListingId}
          onOpenChange={(o) => !o && setDetailListingId(null)}
          listing={detailListing}
          tenant={detailTenant}
          landlord={detailLandlord}
          activeRequest={detailReq}
          onChangeTenantProfile={(tid) => setViewingTenantId(tid)}
          onReassignAgent={(args) => setReassignTarget(args)}
        />
      );
    })()}
    <EditHouseListingDialog
      open={!!editingListing}
      onOpenChange={(o) => !o && setEditingListing(null)}
      listing={editingListing}
      onSaved={refresh}
    />
    <AlertDialog open={!!deleteTarget} onOpenChange={(o) => !o && !deleting && setDeleteTarget(null)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Remove this listing?</AlertDialogTitle>
          <AlertDialogDescription>
            {deleteTarget ? (
              <>
                <span className="font-medium text-foreground">{deleteTarget.title}</span> will be removed from your account.
                This action cannot be undone.
              </>
            ) : null}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => { e.preventDefault(); handleDelete(); }}
            disabled={deleting}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90 gap-2"
          >
            {deleting && <Loader2 className="h-4 w-4 animate-spin" />}
            Remove
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
    <AlertDialog open={!!vacateTarget} onOpenChange={(o) => !o && !vacating && setVacateTarget(null)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Move this tenant out?</AlertDialogTitle>
          <AlertDialogDescription>
            {vacateTarget ? (
              <>
                The current tenant will be removed from{' '}
                <span className="font-medium text-foreground">{vacateTarget.title}</span> and the house
                will become available again. You can then post a new rent request to link a new tenant.
              </>
            ) : null}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={vacating}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => { e.preventDefault(); handleVacate(); }}
            disabled={vacating}
            className="bg-amber-600 text-white hover:bg-amber-700 gap-2"
          >
            {vacating && <Loader2 className="h-4 w-4 animate-spin" />}
            Move tenant out
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
    <AlertDialog open={!!swapTarget} onOpenChange={(o) => !o && !swapping && setSwapTarget(null)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Swap the tenant in this house?</AlertDialogTitle>
          <AlertDialogDescription>
            {swapTarget ? (
              <>
                The current tenant will be moved out of{' '}
                <span className="font-medium text-foreground">{swapTarget.title}</span> and you'll go
                straight to linking a new tenant — the house is already filled in for you.
              </>
            ) : null}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={swapping}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => { e.preventDefault(); handleSwap(); }}
            disabled={swapping}
            className="gap-2"
          >
            {swapping && <Loader2 className="h-4 w-4 animate-spin" />}
            Swap tenant
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
    {swapHouseForLink && (
      <AgentRentRequestDialog
        open={!!swapHouseForLink}
        onOpenChange={(o) => { if (!o) setSwapHouseForLink(null); }}
        onSuccess={() => { setSwapHouseForLink(null); refresh(); }}
        preselectHouse={swapHouseForLink}
      />
    )}
    <RegisterLandlordDialog
      open={registerLandlordOpen}
      onOpenChange={setRegisterLandlordOpen}
      onSuccess={() => { refresh(); }}
    />
    </>
  );
}
