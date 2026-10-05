import { useState, useMemo, useEffect, Fragment } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Loader2, CheckCircle2, Banknote, TrendingUp, Users, Wallet, AlertTriangle, XCircle, Search, MapPin, Filter, Eye, ArrowRight, ShieldCheck } from 'lucide-react';
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { TenantPaymentHistoryCard } from '@/components/executive/TenantPaymentHistoryCard';
import { TenantRelationshipBadge } from '@/components/rent/TenantRelationshipBadge';
import { useTenantRenewalMap } from '@/hooks/useTenantRenewalMap';
import {
  fetchPartnerReservedStages,
  PARTNER_RESERVED_HINT,
  PARTNER_RESERVED_LABEL,
  type PartnerReservedStage,
} from '@/lib/partnerReservedPlans';
import { format } from 'date-fns';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { TreasuryImpactBanner } from './TreasuryImpactBanner';
import { useAuth } from '@/hooks/useAuth';
import { UserDrilldownDrawer } from '@/components/ops/UserDrilldownDrawer';
import { LandlordAgreementHistory } from '@/components/landlord/agreement';
import { CfoApprovalGate } from '@/components/cfo/CfoApprovalGate';

const fmt = (n: number) => `UGX ${Math.round(Number(n) || 0).toLocaleString('en-US')}`;

interface ApprovedRentItem {
  id: string;
  rent_amount: number;
  tenant_id: string;
  landlord_id: string;
  agent_id: string | null;
  assigned_agent_id: string | null;
  access_fee: number;
  request_fee: number;
  total_repayment: number;
  created_at: string;
  tenant_name: string;
  landlord_name: string;
  agent_name: string;
  has_landlord_wallet: boolean;
  payout_target: 'landlord_wallet' | 'agent_float';
  request_country: string | null;
  request_city: string | null;
  request_district: string | null;
  /** Read-only tenant location / category attributes (for filtering only). */
  loc_town: string | null;
  loc_city: string | null;
  loc_sub_county: string | null;
  loc_parish: string | null;
  loc_village: string | null;
  loc_region: string | null;
  loc_house_category: string | null;
  /**
   * Set when a partner has claimed / committed / already funded this plan
   * (self-managed funding). Such rows stay visible but can never be ticked —
   * the DB also hard-blocks a company float allocation on them.
   */
  partner_reserved_stage: PartnerReservedStage | null;
}

/** Same category set the previous "Pay by Location / Category" picker offered. */
type CatFieldKey =
  | 'district'
  | 'town'
  | 'city'
  | 'sub_county'
  | 'parish'
  | 'village'
  | 'region'
  | 'house_category';

const CAT_FIELD_LABELS: Record<CatFieldKey, string> = {
  district: 'District',
  town: 'Town Council',
  city: 'City / Municipality',
  sub_county: 'Sub-county',
  parish: 'Parish',
  village: 'Village',
  region: 'Region',
  house_category: 'House category',
};

const CAT_FIELD_KEYS = Object.keys(CAT_FIELD_LABELS) as CatFieldKey[];

const catValueOf = (it: ApprovedRentItem, field: CatFieldKey): string => {
  const raw =
    field === 'district' ? it.request_district
    : field === 'town' ? it.loc_town
    : field === 'city' ? (it.loc_city ?? it.request_city)
    : field === 'sub_county' ? it.loc_sub_county
    : field === 'parish' ? it.loc_parish
    : field === 'village' ? it.loc_village
    : field === 'region' ? it.loc_region
    : it.loc_house_category;
  return (raw || '').toString().trim();
};

interface RentDisbursementQueueProps {
  /**
   * Optional: restrict the queue to these rent_request ids. Used by
   * "Pay by Location/Category", which only *selects* recipients — every
   * amount, validation, disbursement call and audit trail below stays
   * exactly the same as the normal General Payout queue.
   */
  restrictToIds?: string[];
  /** Optional: tick these rows on mount (same checkboxes as usual). */
  autoSelectIds?: string[];
  /** When true, the district and town/city filter controls are hidden. */
  /**
   * UI-only: show just the three location provisions
   * (Districts, Municipality/Town, All Agents) and hide the
   * category / country pickers. No filtering logic changes.
   */
  locationProvisionsOnly?: boolean;
}

export function RentDisbursementQueue({ restrictToIds, autoSelectIds, locationProvisionsOnly = false }: RentDisbursementQueueProps = {}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [agentFilter, setAgentFilter] = useState<string>('all');
  const [countryFilter, setCountryFilter] = useState<string>('all');
  const [districtFilter, setDistrictFilter] = useState<string>('all');
  const [cityFilter, setCityFilter] = useState<string>('all');
  const [catField, setCatField] = useState<CatFieldKey>('district');
  const [catValue, setCatValue] = useState<string>('all');
  const [dateFilter, setDateFilter] = useState<'all' | '7d' | '30d'>('all');
  const [search, setSearch] = useState('');
  const [batchRef, setBatchRef] = useState('');
  const [bulkReviewOpen, setBulkReviewOpen] = useState(false);
  const [rejectTarget, setRejectTarget] = useState<ApprovedRentItem | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [reviewTarget, setReviewTarget] = useState<ApprovedRentItem | null>(null);
  const [drilldownAgentId, setDrilldownAgentId] = useState<string | null>(null);
  const qc = useQueryClient();
  const { user } = useAuth();

  const { data: items = [], isLoading } = useQuery({
    queryKey: ['rent-disbursement-queue'],
    queryFn: async () => {
      // Get COO-approved rent requests
      const { data: requests, error } = await supabase
        .from('rent_requests')
        .select('id, rent_amount, tenant_id, landlord_id, agent_id, assigned_agent_id, access_fee, request_fee, total_repayment, created_at, request_country, request_city, house_listing_id')
        .eq('status', 'coo_approved')
        .order('created_at', { ascending: true });
      if (error) throw error;
      if (!requests?.length) return [];

      // Plans claimed / committed / already funded by a partner (self-managed
      // funding) stay VISIBLE but carry a "Partner claimed" badge and cannot be
      // ticked: Partner Ops approval sends the principal straight to the agent's
      // landlord float, and the DB hard-blocks a company allocation on them.
      const reservedStages = await fetchPartnerReservedStages(requests.map(r => r.id as string));
      const disbursable = requests;

      // Gather unique IDs
      const tenantIds = [...new Set(disbursable.map(r => r.tenant_id))];
      const landlordIds = [...new Set(disbursable.map(r => r.landlord_id).filter(Boolean))];
      const agentIds = [...new Set(disbursable.flatMap(r => [r.agent_id, r.assigned_agent_id].filter(Boolean) as string[]))];

      // Fetch profiles for tenants and agents
      const allUserIds = [...new Set([...tenantIds, ...agentIds])];
      const profileMap = new Map<string, string>();
      const tenantLocMap = new Map<string, any>();
      if (allUserIds.length) {
        const { data: profiles } = await supabase
          .from('profiles')
          .select('id, full_name, town, city, sub_county, parish, village, region, district, tenant_house_category')
          .in('id', allUserIds);
        for (const p of profiles || []) {
          profileMap.set(p.id, (p as any).full_name || 'Unknown');
          tenantLocMap.set(p.id, p);
        }
      }

      // Fetch landlord names
      const landlordMap = new Map<string, string>();
      if (landlordIds.length) {
        const { data: landlords } = await supabase.from('landlords').select('id, name').in('id', landlordIds);
        for (const l of landlords || []) landlordMap.set(l.id, l.name || 'Unknown');
      }

      // Check which landlords have wallets (via profiles matching landlord user references)
      // Landlords in our system may or may not have user accounts with wallets
      const walletSet = new Set<string>();
      if (landlordIds.length) {
        const { data: wallets } = await supabase
          .from('wallets')
          .select('user_id')
          .in('user_id', landlordIds);
        for (const w of wallets || []) walletSet.add(w.user_id);
      }

      // Read-only enrichment so the existing table can be filtered by district.
      const listingIds = [...new Set(disbursable.map(r => (r as any).house_listing_id).filter(Boolean) as string[])];
      const districtMap = new Map<string, string>();
      if (listingIds.length) {
        const { data: listings } = await supabase
          .from('house_listings')
          .select('id, district')
          .in('id', listingIds);
        for (const l of listings || []) if (l.district) districtMap.set(l.id, l.district);
      }

      return disbursable.map(r => {
        const agentId = r.assigned_agent_id || r.agent_id;
        const hasWallet = walletSet.has(r.landlord_id);
        const loc: any = tenantLocMap.get(r.tenant_id) || {};
        return {
          ...r,
          partner_reserved_stage: reservedStages.get(r.id as string) ?? null,
          access_fee: r.access_fee ?? 0,
          request_fee: r.request_fee ?? 0,
          total_repayment: r.total_repayment ?? 0,
          tenant_name: profileMap.get(r.tenant_id) || 'Unknown Tenant',
          landlord_name: landlordMap.get(r.landlord_id) || 'Unknown Landlord',
          agent_name: agentId ? (profileMap.get(agentId) || 'Unknown Agent') : 'No Agent',
          has_landlord_wallet: hasWallet,
          payout_target: hasWallet ? 'landlord_wallet' as const : 'agent_float' as const,
          request_country: (r as any).request_country ?? null,
          request_city: (r as any).request_city ?? null,
          request_district: loc.district ?? districtMap.get((r as any).house_listing_id) ?? null,
          loc_town: loc.town ?? null,
          loc_city: loc.city ?? null,
          loc_sub_county: loc.sub_county ?? null,
          loc_parish: loc.parish ?? null,
          loc_village: loc.village ?? null,
          loc_region: loc.region ?? null,
          loc_house_category: loc.tenant_house_category ?? null,
        };
      });
    },
    staleTime: 15_000,
  });

  const selectedItems = useMemo(() => items.filter(i => selected.has(i.id)), [items, selected]);
  // New tenant / Renewing tag per row — presentation only, from real prior plans.
  const { data: renewalMap } = useTenantRenewalMap(
    useMemo(() => items.map(i => i.tenant_id), [items]),
    useMemo(() => items.map(i => i.id), [items]),
  );

  // Pre-tick rows handed over by the location/category recipient picker.
  useEffect(() => {
    if (!autoSelectIds?.length) return;
    const reserved = new Set(items.filter(i => i.partner_reserved_stage).map(i => i.id));
    setSelected(new Set(autoSelectIds.filter(id => !reserved.has(id))));
  }, [autoSelectIds?.join(','), items]);

  const effectiveRestrictIds = useMemo(
    () => (restrictToIds && restrictToIds.length ? restrictToIds : null),
    [restrictToIds?.join(',')],
  );
  const restrictSet = useMemo(
    () => (effectiveRestrictIds && effectiveRestrictIds.length ? new Set(effectiveRestrictIds) : null),
    [effectiveRestrictIds?.join(',')],
  );
  const totalRent = useMemo(() => selectedItems.reduce((s, i) => s + i.rent_amount, 0), [selectedItems]);
  const totalRevenue = useMemo(() => selectedItems.reduce((s, i) => s + i.access_fee + i.request_fee, 0), [selectedItems]);
  const totalRepaymentExpected = useMemo(() => selectedItems.reduce((s, i) => s + i.total_repayment, 0), [selectedItems]);

  const toggle = (id: string) => {
    // Partner-claimed plans are never fundable from company float.
    if (items.find(i => i.id === id)?.partner_reserved_stage) return;
    const next = new Set(selected);
    next.has(id) ? next.delete(id) : next.add(id);
    setSelected(next);
  };

  // Date-window + text-search filter: which requests are within the chosen
  // lookback and match the CFO's search (tenant, landlord, or agent name).
  const filteredItems = useMemo(() => {
    const cutoff = dateFilter === 'all'
      ? null
      : Date.now() - (dateFilter === '7d' ? 7 : 30) * 24 * 60 * 60 * 1000;
    const q = search.trim().toLowerCase();
    return items.filter(it => {
      if (restrictSet && !restrictSet.has(it.id)) return false;
      if (cutoff !== null && new Date(it.created_at).getTime() < cutoff) return false;
      if (districtFilter !== 'all' && ((it.request_district || '').trim() || 'Unknown') !== districtFilter) return false;
      if (cityFilter !== 'all' && ((it.request_city || '').trim() || 'Unknown') !== cityFilter) return false;
      if (catValue !== 'all' && (catValueOf(it, catField) || 'Unknown') !== catValue) return false;
      if (q) {
        const haystack = `${it.tenant_name} ${it.landlord_name} ${it.agent_name}`.toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    });
  }, [items, dateFilter, search, restrictSet, districtFilter, cityFilter, catField, catValue]);

  // Category option list for the currently chosen category type.
  const catOptions = useMemo(() => {
    const map = new Map<string, number>();
    for (const it of items) {
      const key = catValueOf(it, catField) || 'Unknown';
      map.set(key, (map.get(key) ?? 0) + 1);
    }
    return [...map.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => a.name.localeCompare(b.name));
  }, [items, catField]);

  // Location option lists, derived from the same rows the table shows.
  const districtOptions = useMemo(() => {
    const map = new Map<string, number>();
    for (const it of items) {
      const key = (it.request_district || '').trim() || 'Unknown';
      map.set(key, (map.get(key) ?? 0) + 1);
    }
    return [...map.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => a.name.localeCompare(b.name));
  }, [items]);

  const cityOptions = useMemo(() => {
    const map = new Map<string, number>();
    for (const it of items) {
      if (districtFilter !== 'all' && ((it.request_district || '').trim() || 'Unknown') !== districtFilter) continue;
      const key = (it.request_city || '').trim() || 'Unknown';
      map.set(key, (map.get(key) ?? 0) + 1);
    }
    return [...map.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => a.name.localeCompare(b.name));
  }, [items, districtFilter]);

  const locationScoped = districtFilter !== 'all' || cityFilter !== 'all' || countryFilter !== 'all';
  const locationScopeLabel = [
    districtFilter !== 'all' ? districtFilter : null,
    cityFilter !== 'all' ? cityFilter : null,
    countryFilter !== 'all' ? countryFilter : null,
  ].filter(Boolean).join(' · ');
  const clearLocation = () => {
    setDistrictFilter('all');
    setCityFilter('all');
    setCountryFilter('all');
    setCatValue('all');
  };

  // Group rows by agent so CFO can pick one tenant, a few, or all of an
  // agent's tenants at a glance.
  const grouped = useMemo(() => {
    const map = new Map<string, { agent_id: string; agent_name: string; rows: ApprovedRentItem[]; latest: number }>();
    for (const it of filteredItems) {
      const key = it.assigned_agent_id || it.agent_id || 'unassigned';
      const ts = new Date(it.created_at).getTime();
      const g = map.get(key) ?? { agent_id: key, agent_name: it.agent_name, rows: [], latest: 0 };
      g.rows.push(it);
      if (ts > g.latest) g.latest = ts;
      map.set(key, g);
    }
    // Newest request first, so an agent that just posted jumps to the top.
    // Within each agent, show their newest tenant request first too.
    for (const g of map.values()) {
      g.rows.sort(
        (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
      );
    }
    return [...map.values()].sort((a, b) => b.latest - a.latest);
  }, [filteredItems]);

  // Country breakdown — counts + total rent per country across the filtered queue.
  const countryStats = useMemo(() => {
    const map = new Map<string, { country: string; count: number; total: number }>();
    for (const it of filteredItems) {
      const key = (it.request_country || '').trim() || 'Unknown';
      const s = map.get(key) ?? { country: key, count: 0, total: 0 };
      s.count += 1;
      s.total += it.rent_amount;
      map.set(key, s);
    }
    return [...map.values()].sort((a, b) => b.total - a.total);
  }, [filteredItems]);

  const countryFilteredGroups = useMemo(() => {
    if (countryFilter === 'all') return grouped;
    return grouped
      .map(g => ({
        ...g,
        rows: g.rows.filter(r => ((r.request_country || '').trim() || 'Unknown') === countryFilter),
      }))
      .filter(g => g.rows.length > 0);
  }, [grouped, countryFilter]);

  const visibleGroups = useMemo(
    () => (agentFilter === 'all' ? countryFilteredGroups : countryFilteredGroups.filter(g => g.agent_id === agentFilter)),
    [countryFilteredGroups, agentFilter],
  );
  const visibleItems = useMemo(() => visibleGroups.flatMap(g => g.rows), [visibleGroups]);
  /** Rows the CFO may actually fund (partner-claimed plans excluded). */
  const selectableItems = useMemo(
    () => visibleItems.filter(i => !i.partner_reserved_stage),
    [visibleItems],
  );
  const selectedVisibleCount = useMemo(
    () => selectableItems.filter(i => selected.has(i.id)).length,
    [selectableItems, selected],
  );
  const selectAllForPayment = () => {
    if (selectableItems.length === 0) return;
    setSelected(new Set(selectableItems.map(i => i.id)));
    setBulkReviewOpen(true);
  };

  const batchDisburse = useMutation({
    mutationFn: async () => {
      if (!batchRef.trim()) throw new Error('Enter a batch reference');
      const requestedIds = Array.from(selected);
      if (requestedIds.length === 0) throw new Error('Select at least one tenant');

      // Safety re-check: selection may be several minutes old by confirmation.
      // Refuse the whole batch if any request is no longer COO-approved or has
      // since been reserved for partner funding. This read happens before any
      // payment function is invoked, so a stale review cannot partially pay.
      const { data: latestRequests, error: latestError } = await supabase
        .from('rent_requests')
        .select('id, status')
        .in('id', requestedIds);
      if (latestError) throw latestError;

      const latestApprovedIds = new Set(
        (latestRequests || []).filter(request => request.status === 'coo_approved').map(request => request.id),
      );
      const latestReserved = await fetchPartnerReservedStages(requestedIds);
      const stillEligible = requestedIds.filter(id => latestApprovedIds.has(id) && !latestReserved.has(id));
      if (stillEligible.length !== requestedIds.length) {
        throw new Error('The payment queue changed. Close this review and select eligible tenants again.');
      }

      const errors: string[] = [];
      for (const id of stillEligible) {
        const { error } = await supabase.functions.invoke('fund-agent-landlord-float', {
          body: { rent_request_id: id, notes: `Batch: ${batchRef}` },
        });
        if (error) errors.push(`${id.slice(0, 8)}: ${error.message}`);
      }
      if (errors.length) throw new Error(`${errors.length} failed: ${errors[0]}`);
    },
    onSuccess: () => {
      toast.success(`Funded ${selected.size} agent float${selected.size === 1 ? '' : 's'} — agents will complete the MoMo payouts.`);
      setBulkReviewOpen(false);
      setSelected(new Set());
      setBatchRef('');
      qc.invalidateQueries({ queryKey: ['rent-disbursement-queue'] });
      qc.invalidateQueries({ queryKey: ['batch-payout-pending'] });
      qc.invalidateQueries({ queryKey: ['treasury-cash-snapshot'] });
      qc.invalidateQueries({ queryKey: ['cfo-overview'] });
    },
    onError: (e: any) => toast.error(e.message || 'Batch disbursement failed'),
  });

  const singleDisburse = useMutation({
    mutationFn: async (id: string) => {
      const { error, data } = await supabase.functions.invoke('fund-agent-landlord-float', {
        body: { rent_request_id: id, notes: 'Single CFO disbursement' },
      });
      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      return data;
    },
    onSuccess: () => {
      toast.success('Funded agent float — agent will complete the MoMo payout.');
      qc.invalidateQueries({ queryKey: ['rent-disbursement-queue'] });
      qc.invalidateQueries({ queryKey: ['treasury-cash-snapshot'] });
      qc.invalidateQueries({ queryKey: ['cfo-overview'] });
    },
    onError: (e: any) => toast.error(e.message || 'Disbursement failed'),
  });

  const rejectMutation = useMutation({
    mutationFn: async ({ id, reason }: { id: string; reason: string }) => {
      if (!user) throw new Error('Not authenticated');
      if (reason.trim().length < 10) throw new Error('Reason must be at least 10 characters');

      const { error } = await supabase.rpc('return_rent_request_for_correction', {
        p_request_id: id,
        p_stage: 'coo_approved',
        p_reason: reason.trim(),
      });
      if (error) throw error;

      // Stamp CFO reviewer + comment for audit trail (mirrors RentPipelineQueue)
      await supabase
        .from('rent_requests')
        .update({
          cfo_reviewed_by: user.id,
          cfo_reviewed_at: new Date().toISOString(),
          approval_comment: reason.trim(),
        })
        .eq('id', id);
    },
    onSuccess: () => {
      toast.success('Rent request returned to agent with your comment.');
      setRejectTarget(null);
      setRejectReason('');
      qc.invalidateQueries({ queryKey: ['rent-disbursement-queue'] });
      qc.invalidateQueries({ queryKey: ['rent-pipeline'] });
      qc.invalidateQueries({ queryKey: ['agent-rejected-rent-requests'] });
    },
    onError: (e: any) => toast.error(e.message || 'Failed to reject'),
  });

  // Summary totals for the currently filtered queue.
  const queueTotalRent = useMemo(() => filteredItems.reduce((s, i) => s + i.rent_amount, 0), [filteredItems]);
  const queueTotalRevenue = useMemo(() => filteredItems.reduce((s, i) => s + i.access_fee + i.request_fee, 0), [filteredItems]);
  const queueTotalRepaymentExpected = useMemo(() => filteredItems.reduce((s, i) => s + i.total_repayment, 0), [filteredItems]);

  const dateFilterLabel: Record<string, string> = { all: 'All time', '7d': 'Last 7 days', '30d': 'Last 30 days' };

  return (
    <Card className="overflow-hidden rounded-2xl border-border/70 shadow-sm">
      <CardHeader className="pb-0 space-y-0 p-0">
        {filteredItems.length > 0 && (
          <div className="flex items-center justify-end gap-3 px-5 pt-5 pb-4">
            <span className="inline-flex items-center gap-2 rounded-full border border-emerald-200 bg-emerald-50 px-3.5 py-2 text-sm font-semibold text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-400">
              <CheckCircle2 className="h-4 w-4" />
              {filteredItems.length} approved · {fmt(queueTotalRent)}
            </span>
          </div>
        )}

        {/* Filter band */}
        <div className="border-y border-border/70 bg-muted/20 px-5 py-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-3 items-center">
            <div className="relative w-full">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => { setSearch(e.target.value); setSelected(new Set()); }}
                placeholder="Search tenant, landlord, agent…"
                className="h-11 rounded-xl text-sm pl-9 bg-background border-border/70"
              />
            </div>
            <Select
                value={districtFilter}
                onValueChange={(v) => { setDistrictFilter(v); setCityFilter('all'); setSelected(new Set()); }}
              >
                <SelectTrigger className="h-11 rounded-xl text-sm w-full bg-background border-border/70">
                  <MapPin className="h-4 w-4 mr-2 text-muted-foreground" />
                  <SelectValue placeholder="All districts" />
                </SelectTrigger>
                <SelectContent className="max-h-[320px]">
                  <SelectItem value="all">All districts ({items.length})</SelectItem>
                  {districtOptions.map(o => (
                    <SelectItem key={o.name} value={o.name}>
                      <span className="truncate">{o.name} · {o.count}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
            </Select>
            <Select value={cityFilter} onValueChange={(v) => { setCityFilter(v); setSelected(new Set()); }}>
                <SelectTrigger className="h-11 rounded-xl text-sm w-full bg-background border-border/70">
                  <SelectValue placeholder="All municipalities/towns" />
                </SelectTrigger>
                <SelectContent className="max-h-[320px]">
                  <SelectItem value="all">All municipalities/towns</SelectItem>
                  {cityOptions.map(o => (
                    <SelectItem key={o.name} value={o.name}>
                      <span className="truncate">{o.name} · {o.count}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
            </Select>
            <Select value={agentFilter} onValueChange={setAgentFilter}>
              <SelectTrigger className="h-11 rounded-xl text-sm w-full bg-background border-border/70">
                <Users className="h-4 w-4 mr-2 text-muted-foreground" />
                <SelectValue placeholder="Filter by agent" />
              </SelectTrigger>
              <SelectContent className="max-h-[320px]">
                <SelectItem value="all">All agents ({grouped.length})</SelectItem>
                {grouped.map(g => {
                  const gTotal = g.rows.reduce((s, r) => s + r.rent_amount, 0);
                  return (
                    <SelectItem key={g.agent_id} value={g.agent_id}>
                      <span className="truncate">
                        {g.agent_name} · {g.rows.length} · {fmt(gTotal)}
                      </span>
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
            {!locationProvisionsOnly && (
            <Select value={catField} onValueChange={(v) => { setCatField(v as CatFieldKey); setCatValue('all'); setSelected(new Set()); }}>
              <SelectTrigger className="h-11 rounded-xl text-sm w-full bg-background border-border/70">
                <MapPin className="h-4 w-4 mr-2 text-muted-foreground" />
                <SelectValue placeholder="Category type" />
              </SelectTrigger>
              <SelectContent className="max-h-[320px]">
                {CAT_FIELD_KEYS.map(k => (
                  <SelectItem key={k} value={k}>{CAT_FIELD_LABELS[k]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            )}
            {!locationProvisionsOnly && (
            <Select value={catValue} onValueChange={(v) => { setCatValue(v); setSelected(new Set()); }}>
              <SelectTrigger className="h-11 rounded-xl text-sm w-full bg-background border-border/70">
                <SelectValue placeholder={CAT_FIELD_LABELS[catField]} />
              </SelectTrigger>
              <SelectContent className="max-h-[320px]">
                <SelectItem value="all">All {CAT_FIELD_LABELS[catField].toLowerCase()}</SelectItem>
                {catOptions.map(o => (
                  <SelectItem key={o.name} value={o.name}>
                    <span className="truncate">{o.name} · {o.count}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            )}
            {(agentFilter !== 'all' || locationScoped) && (
              <button
                type="button"
                className="text-xs font-medium text-primary hover:underline justify-self-start sm:col-span-2 lg:col-span-3 xl:col-span-6"
                onClick={() => { setAgentFilter('all'); clearLocation(); }}
              >
                Clear agent &amp; location
              </button>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4 p-5">
        {/* Location scope chip — the same table below is simply filtered. */}
        {locationScoped && (
          <div className="flex items-center gap-2 flex-wrap">
            <Badge variant="outline" className="text-[11px] rounded-full px-2.5 py-0.5 bg-primary/10 text-primary border-primary/30">
              <MapPin className="h-3 w-3 mr-1" />
              {locationScopeLabel}
            </Badge>
            <button
              type="button"
              className="text-xs font-medium text-primary hover:underline"
              onClick={clearLocation}
            >
              Show whole queue
            </button>
          </div>
        )}
        {isLoading ? (
          <div className="flex justify-center py-8"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
        ) : filteredItems.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground">
            <CheckCircle2 className="h-10 w-10 mx-auto mb-2 text-emerald-500" />
            <p className="font-medium">No Pending Rent Payouts</p>
            <p className="text-xs">
              {dateFilter !== 'all'
                ? `No requests match ${dateFilterLabel[dateFilter]}. `
                : 'All approved rent requests have been disbursed'}
              {dateFilter !== 'all' && (
                <button type="button" className="text-primary hover:underline" onClick={() => setDateFilter('all')}>
                  Show all
                </button>
              )}
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {/* Revenue summary for selection or location scope */}
            {(selected.size > 0 || locationScoped) && (
              <div className="rounded-lg border-2 border-emerald-200 bg-emerald-50 dark:bg-emerald-950/20 p-3 space-y-2">
                <p className="text-xs font-bold flex items-center gap-1.5 text-emerald-700 dark:text-emerald-400">
                  <TrendingUp className="h-3.5 w-3.5" />
                  Revenue from this disbursement
                  {locationScoped && (
                    <span className="ml-2 text-[10px] font-normal text-emerald-600/80">
                      · Scoped by location
                    </span>
                  )}
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-center">
                  <div className="rounded-md bg-background/60 py-2">
                    <p className="text-[10px] text-muted-foreground">Rent Out</p>
                    <p className="font-bold text-sm text-orange-600">{fmt(selected.size > 0 ? totalRent : queueTotalRent)}</p>
                  </div>
                  <div className="rounded-md bg-background/60 py-2">
                    <p className="text-[10px] text-muted-foreground">We Earn (Fees)</p>
                    <p className="font-bold text-sm text-emerald-600">{fmt(selected.size > 0 ? totalRevenue : queueTotalRevenue)}</p>
                  </div>
                  <div className="rounded-md bg-background/60 py-2">
                    <p className="text-[10px] text-muted-foreground">Total Repayment</p>
                    <p className="font-bold text-sm text-primary">{fmt(selected.size > 0 ? totalRepaymentExpected : queueTotalRepaymentExpected)}</p>
                  </div>
                </div>
                <TreasuryImpactBanner payoutAmount={selected.size > 0 ? totalRent : queueTotalRent} />
              </div>

            )}

            {/* Country breakdown — click a chip to filter the queue by country */}
            {!locationProvisionsOnly && countryStats.length > 0 && (
              <div className="rounded-xl border border-border/70 bg-muted/20 p-3">
                <div className="flex items-center justify-between mb-1.5 px-1">
                  <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">
                    Requests by country
                  </p>
                  {countryFilter !== 'all' && (
                    <button
                      type="button"
                      className="text-[11px] text-primary hover:underline"
                      onClick={() => setCountryFilter('all')}
                    >
                      Clear
                    </button>
                  )}
                </div>
                <div className="flex flex-wrap gap-1.5">
                  <button
                    type="button"
                    onClick={() => setCountryFilter('all')}
                    className={cn(
                      'px-3 py-1.5 rounded-full text-xs font-medium border transition-colors',
                      countryFilter === 'all'
                        ? 'bg-primary text-primary-foreground border-primary'
                        : 'bg-background hover:bg-muted border-border',
                    )}
                  >
                    🌍 All · {filteredItems.length} · {fmt(queueTotalRent)}
                  </button>
                  {countryStats.map(c => (
                    <button
                      key={c.country}
                      type="button"
                      onClick={() => setCountryFilter(c.country)}
                      className={cn(
                        'px-3 py-1.5 rounded-full text-xs font-medium border transition-colors',
                        countryFilter === c.country
                          ? 'bg-primary text-primary-foreground border-primary'
                          : 'bg-background hover:bg-muted border-border',
                      )}
                    >
                      <span className="font-semibold">{c.country}</span>
                      <span className="opacity-80"> · {c.count} · {fmt(c.total)}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Helper hint */}
            <p className="text-[11px] text-muted-foreground px-1">
              Tip: open a tenant with the Review button to approve and fund the payout.
            </p>


            {/* Grouped list (by agent) */}
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <span className="text-xs text-muted-foreground">
                {visibleGroups.length} agent{visibleGroups.length === 1 ? '' : 's'} shown
              </span>
              <div className="flex items-center gap-2 flex-wrap">
                <Button
                  type="button"
                  size="sm"
                  className="h-9 rounded-lg gap-2"
                  disabled={selectableItems.length === 0}
                  onClick={selectAllForPayment}
                >
                  <Banknote className="h-4 w-4" />
                  {selectedVisibleCount > 0
                    ? `${selectedVisibleCount} Tenant${selectedVisibleCount === 1 ? '' : 's'} Selected — Review Payment`
                    : 'Select All for Payment'}
                  <ArrowRight className="h-4 w-4" />
                </Button>
                <Popover>
                <PopoverTrigger asChild>
                  <Button variant="outline" size="sm" className="h-9 rounded-xl gap-2">
                    <Filter className="h-4 w-4" />
                    Filter
                    {(agentFilter !== 'all' || countryFilter !== 'all' || dateFilter !== 'all' || districtFilter !== 'all' || cityFilter !== 'all' || catValue !== 'all') && (
                      <Badge className="h-5 min-w-5 px-1.5 text-[10px] bg-primary text-primary-foreground border-0">
                        {[agentFilter !== 'all', countryFilter !== 'all', dateFilter !== 'all', districtFilter !== 'all', cityFilter !== 'all', catValue !== 'all'].filter(Boolean).length}
                      </Badge>
                    )}
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="end" className="w-72 space-y-3 p-3">
                  <div className="space-y-1.5">
                      <p className="text-xs font-semibold text-muted-foreground">District</p>
                      <Select
                        value={districtFilter}
                        onValueChange={(v) => { setDistrictFilter(v); setCityFilter('all'); setSelected(new Set()); }}
                      >
                        <SelectTrigger className="h-9 rounded-lg text-sm">
                          <SelectValue placeholder="All districts" />
                        </SelectTrigger>
                        <SelectContent className="max-h-[280px]">
                          <SelectItem value="all">All districts</SelectItem>
                          {districtOptions.map(o => (
                            <SelectItem key={o.name} value={o.name}>
                              <span className="truncate">{o.name} · {o.count}</span>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                  </div>
                  <div className="space-y-1.5">
                      <p className="text-xs font-semibold text-muted-foreground">Municipality / Town</p>
                      <Select value={cityFilter} onValueChange={(v) => { setCityFilter(v); setSelected(new Set()); }}>
                        <SelectTrigger className="h-9 rounded-lg text-sm">
                          <SelectValue placeholder="All municipalities/towns" />
                        </SelectTrigger>
                        <SelectContent className="max-h-[280px]">
                          <SelectItem value="all">All municipalities/towns</SelectItem>
                          {cityOptions.map(o => (
                            <SelectItem key={o.name} value={o.name}>
                              <span className="truncate">{o.name} · {o.count}</span>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                  </div>
                  {!locationProvisionsOnly && (
                  <div className="space-y-1.5">
                    <p className="text-xs font-semibold text-muted-foreground">Category type</p>
                    <Select value={catField} onValueChange={(v) => { setCatField(v as CatFieldKey); setCatValue('all'); setSelected(new Set()); }}>
                      <SelectTrigger className="h-9 rounded-lg text-sm">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent className="max-h-[280px]">
                        {CAT_FIELD_KEYS.map(k => (
                          <SelectItem key={k} value={k}>{CAT_FIELD_LABELS[k]}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  )}
                  {!locationProvisionsOnly && (
                  <div className="space-y-1.5">
                    <p className="text-xs font-semibold text-muted-foreground">{CAT_FIELD_LABELS[catField]}</p>
                    <Select value={catValue} onValueChange={(v) => { setCatValue(v); setSelected(new Set()); }}>
                      <SelectTrigger className="h-9 rounded-lg text-sm">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent className="max-h-[280px]">
                        <SelectItem value="all">All {CAT_FIELD_LABELS[catField].toLowerCase()}</SelectItem>
                        {catOptions.map(o => (
                          <SelectItem key={o.name} value={o.name}>
                            <span className="truncate">{o.name} · {o.count}</span>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  )}
                  <div className="space-y-1.5">
                    <p className="text-xs font-semibold text-muted-foreground">Agent</p>
                    <Select value={agentFilter} onValueChange={setAgentFilter}>
                      <SelectTrigger className="h-9 rounded-lg text-sm">
                        <SelectValue placeholder="Filter by agent" />
                      </SelectTrigger>
                      <SelectContent className="max-h-[280px]">
                        <SelectItem value="all">All agents ({grouped.length})</SelectItem>
                        {grouped.map(g => (
                          <SelectItem key={g.agent_id} value={g.agent_id}>
                            <span className="truncate">{g.agent_name} · {g.rows.length}</span>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  {!locationProvisionsOnly && (
                  <div className="space-y-1.5">
                    <p className="text-xs font-semibold text-muted-foreground">Country</p>
                    <Select value={countryFilter} onValueChange={setCountryFilter}>
                      <SelectTrigger className="h-9 rounded-lg text-sm">
                        <SelectValue placeholder="All countries" />
                      </SelectTrigger>
                      <SelectContent className="max-h-[280px]">
                        <SelectItem value="all">All countries</SelectItem>
                        {countryStats.map(c => (
                          <SelectItem key={c.country} value={c.country}>
                            <span className="truncate">{c.country} · {c.count}</span>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  )}
                  <button
                    type="button"
                    className="text-xs font-medium text-primary hover:underline"
                    onClick={() => { setAgentFilter('all'); setDateFilter('all'); clearLocation(); }}
                  >
                    Clear all filters
                  </button>
                </PopoverContent>
                </Popover>
              </div>
            </div>
            <div className="rounded-xl border border-border/70 overflow-hidden bg-card">
              <div className="overflow-x-auto max-h-[560px] overflow-y-auto">
                <table className="w-full text-sm min-w-[64rem]">
                  <thead className="sticky top-0 z-10">
                    <tr className="border-b border-border/70 bg-muted/40 text-[10px] uppercase tracking-wider text-muted-foreground">
                      <th className="w-12 px-2 py-2 text-center font-semibold">Select</th>
                      <th className="w-10 px-2 py-2 text-center font-semibold">#</th>
                      <th className="px-2 py-2 text-left font-semibold">Tenant</th>
                      <th className="px-2 py-2 text-left font-semibold">Landlord</th>
                      <th className="px-2 py-2 text-left font-semibold">Agent</th>
                      <th className="px-2 py-2 text-left font-semibold">Location</th>
                      <th className="px-2 py-2 text-left font-semibold">Payout to</th>
                      <th className="px-2 py-2 text-left font-semibold">Approved</th>
                      <th className="px-2 py-2 text-right font-semibold">Rent out</th>
                      <th className="px-2 py-2 text-right font-semibold">Fees</th>
                      <th className="px-2 py-2 text-right font-semibold">Repayment</th>
                      <th className="px-2 py-2 text-right font-semibold">Review</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleItems.length === 0 && (
                      <tr>
                        <td colSpan={12} className="text-center py-6 text-xs text-muted-foreground">
                          No tenants match the current filters.{' '}
                          <button
                            type="button"
                            className="text-primary hover:underline"
                            onClick={() => { setAgentFilter('all'); setDateFilter('all'); clearLocation(); }}
                          >
                            Clear all filters
                          </button>
                        </td>
                      </tr>
                    )}
                    {visibleItems.map((item, index) => {
                      const isSel = selected.has(item.id);
                      const reserved = item.partner_reserved_stage;
                      const locationLabel = [item.request_city, item.request_country].filter(Boolean).join(', ');
                      const isNew = Date.now() - new Date(item.created_at).getTime() < 24 * 60 * 60 * 1000;
                      const rowNumber = index + 1;
                      return (
                        <Fragment key={item.id}>
                          <tr
                            onClick={() => setReviewTarget(item)}
                            className={cn(
                              'border-b border-border/70 last:border-0 cursor-pointer transition-colors',
                              isSel
                                ? 'bg-primary/[0.07] shadow-[inset_3px_0_0_0_hsl(var(--primary))]'
                                : 'hover:bg-muted/40'
                            )}
                          >
                            <td className="w-8 px-2 py-2.5 align-middle text-center" onClick={e => e.stopPropagation()}>
                              <Checkbox
                                aria-label={`Select ${item.tenant_name}`}
                                disabled={!!reserved}
                                checked={isSel}
                                onCheckedChange={() => toggle(item.id)}
                              />
                            </td>
                            <td className="w-10 px-2 py-2.5 align-middle text-center">
                              <span className="inline-flex h-5 min-w-[1.25rem] items-center justify-center rounded-full bg-muted/60 text-[10px] font-medium text-muted-foreground">
                                {rowNumber}
                              </span>
                            </td>
                            <td className="px-2 py-2.5 align-middle">
                              <div className="flex items-center gap-1.5 min-w-0">
                                <span className={cn('truncate', isSel ? 'font-bold' : 'font-semibold')}>{item.tenant_name}</span>
                                {renewalMap?.get(item.tenant_id) && (
                                  <TenantRelationshipBadge
                                    relationship={renewalMap.get(item.tenant_id)!.relationship}
                                    approvedPlans={renewalMap.get(item.tenant_id)!.approvedPlans}
                                  />
                                )}
                                {isNew && (
                                  <Badge className="text-[9px] px-1.5 py-0 shrink-0 bg-emerald-500 text-white border-0">
                                    NEW
                                  </Badge>
                                )}
                                {reserved && (
                                  <Badge className="text-[9px] px-1.5 py-0 shrink-0 rounded-full bg-violet-100 text-violet-700 border-violet-200">
                                    {PARTNER_RESERVED_LABEL[reserved]}
                                  </Badge>
                                )}
                              </div>
                            </td>
                            <td className="px-2 py-2.5 align-middle font-semibold text-primary truncate max-w-[10rem]">
                              {item.landlord_name}
                            </td>
                            <td className="px-2 py-2.5 align-middle truncate max-w-[10rem]">
                              {item.agent_name}
                            </td>
                            <td className="px-2 py-2.5 align-middle text-[11px] text-muted-foreground whitespace-nowrap">
                              {locationLabel || '—'}
                            </td>
                            <td className="px-2 py-2.5 align-middle whitespace-nowrap">
                              {item.payout_target === 'landlord_wallet' ? (
                                <Badge className="text-[9px] px-2 py-0 rounded-full bg-emerald-100 text-emerald-700 border-emerald-200">
                                  <Wallet className="h-2.5 w-2.5 mr-0.5" />
                                  Landlord Wallet
                                </Badge>
                              ) : (
                                <Badge className="text-[9px] px-2 py-0 rounded-full bg-amber-100 text-amber-700 border-amber-200">
                                  <AlertTriangle className="h-2.5 w-2.5 mr-0.5" />
                                  Agent Float
                                </Badge>
                              )}
                            </td>
                            <td className="px-2 py-2.5 align-middle text-[11px] text-muted-foreground whitespace-nowrap">
                              {format(new Date(item.created_at), 'dd MMM yyyy')}
                            </td>
                            <td className="px-2 py-2.5 align-middle text-right font-bold text-orange-600 whitespace-nowrap">
                              {fmt(item.rent_amount)}
                            </td>
                            <td className="px-2 py-2.5 align-middle text-right font-semibold text-emerald-600 whitespace-nowrap">
                              {fmt(item.access_fee + item.request_fee)}
                            </td>
                            <td className="px-2 py-2.5 align-middle text-right font-semibold whitespace-nowrap">
                              {fmt(item.total_repayment)}
                            </td>
                            <td className="px-2 py-2.5 align-middle text-right whitespace-nowrap" onClick={e => e.stopPropagation()}>
                              <Button
                                size="sm"
                                variant="outline"
                                className="shrink-0 text-xs h-8 rounded-lg"
                                onClick={() => setReviewTarget(item)}
                              >
                                <Eye className="h-3 w-3 mr-1" />
                                Review
                              </Button>
                            </td>
                          </tr>
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>

          </div>
        )}
      </CardContent>

      <Sheet open={bulkReviewOpen} onOpenChange={setBulkReviewOpen}>
        <SheetContent side="center" className="max-h-[88vh] w-[94vw] max-w-3xl sm:max-w-3xl lg:max-w-3xl xl:max-w-3xl overflow-y-auto rounded-xl p-0">
          <div className="space-y-5 p-5 sm:p-6">
            <SheetHeader>
              <SheetTitle className="text-xl">Review bulk payment</SheetTitle>
              <SheetDescription>
                Review every selected tenant before authorising the payment.
              </SheetDescription>
            </SheetHeader>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="rounded-lg border border-primary/30 bg-primary/5 p-4">
                <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
                  <Users className="h-4 w-4 text-primary" />
                  Tenants selected
                </div>
                <p className="mt-2 text-3xl font-bold text-foreground">{selectedItems.length}</p>
              </div>
              <div className="rounded-lg border border-primary/30 bg-primary/5 p-4">
                <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
                  <Banknote className="h-4 w-4 text-primary" />
                  Total payment
                </div>
                <p className="mt-2 text-3xl font-bold text-primary">{fmt(totalRent)}</p>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              <div className="rounded-lg border border-border/70 p-3">
                <p className="text-xs text-muted-foreground">Landlord Wallet</p>
                <p className="mt-1 font-semibold">
                  {selectedItems.filter(item => item.payout_target === 'landlord_wallet').length} tenant(s)
                </p>
              </div>
              <div className="rounded-lg border border-border/70 p-3">
                <p className="text-xs text-muted-foreground">Agent Float</p>
                <p className="mt-1 font-semibold">
                  {selectedItems.filter(item => item.payout_target === 'agent_float').length} tenant(s)
                </p>
              </div>
              <div className="rounded-lg border border-border/70 p-3">
                <p className="text-xs text-muted-foreground">Expected repayment</p>
                <p className="mt-1 font-semibold">{fmt(totalRepaymentExpected)}</p>
              </div>
            </div>

            <TreasuryImpactBanner payoutAmount={totalRent} />

            <div className="space-y-2">
              <div className="flex items-center justify-between gap-3">
                <p className="text-sm font-semibold">Payment details</p>
                <Badge variant="outline">Fees: {fmt(totalRevenue)}</Badge>
              </div>
              <div className="max-h-64 overflow-y-auto rounded-lg border border-border/70 divide-y divide-border/60">
                {selectedItems.map(item => (
                  <label key={item.id} className="flex cursor-pointer items-center gap-3 px-3 py-3 hover:bg-muted/30">
                    <Checkbox
                      checked={selected.has(item.id)}
                      onCheckedChange={() => toggle(item.id)}
                      aria-label={`Remove ${item.tenant_name} from payment`}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold">{item.tenant_name}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {item.agent_name} · {item.payout_target === 'landlord_wallet' ? 'Landlord Wallet' : 'Agent Float'}
                      </span>
                    </span>
                    <span className="shrink-0 text-sm font-bold">{fmt(item.rent_amount)}</span>
                  </label>
                ))}
                {selectedItems.length === 0 && (
                  <div className="px-4 py-8 text-center text-sm text-muted-foreground">
                    No tenants selected. Close this review and select eligible tenants again.
                  </div>
                )}
              </div>
            </div>

            <div className="space-y-2">
              <label htmlFor="bulk-payment-reference" className="text-sm font-semibold">Batch reference</label>
              <Input
                id="bulk-payment-reference"
                value={batchRef}
                onChange={event => setBatchRef(event.target.value)}
                placeholder="Enter the payment batch reference"
                autoComplete="off"
              />
              <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
                <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
                No payment is made until you click Confirm &amp; Pay Selected.
              </p>
            </div>

            <SheetFooter className="border-t border-border/70 pt-4">
              <Button type="button" variant="outline" onClick={() => setBulkReviewOpen(false)} disabled={batchDisburse.isPending}>
                Back to list
              </Button>
              <CfoApprovalGate>
                <Button
                  type="button"
                  onClick={() => batchDisburse.mutate()}
                  disabled={batchDisburse.isPending || selectedItems.length === 0 || !batchRef.trim()}
                >
                  {batchDisburse.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Banknote className="h-4 w-4" />}
                  Confirm &amp; Pay Selected
                </Button>
              </CfoApprovalGate>
            </SheetFooter>
          </div>
        </SheetContent>
      </Sheet>

      <Sheet open={!!reviewTarget} onOpenChange={(o) => { if (!o) setReviewTarget(null); }}>
        <SheetContent side="center" className="max-h-[80vh] w-[92vw] max-w-md sm:max-w-md lg:max-w-md xl:max-w-md overflow-y-auto rounded-xl p-5">
          {reviewTarget && (
            <div className="space-y-4">
              <SheetHeader>
                <SheetTitle>Rent disbursement review</SheetTitle>
                <SheetDescription>
                  COO-approved payout for {reviewTarget.tenant_name} → {reviewTarget.landlord_name}.
                </SheetDescription>
              </SheetHeader>

              {/* Tenant status first: renewal vs new tenant, with existing payment history */}
              <TenantPaymentHistoryCard tenantId={reviewTarget.tenant_id} currentRequestId={reviewTarget.id} />
              <LandlordAgreementHistory
                landlordId={reviewTarget.landlord_id}
                landlordName={reviewTarget.landlord_name}
                landlordPhone=""
                canAdd={false}
              />

            



              <div className="rounded-xl border border-border/70 divide-y divide-border/60 text-sm">
                {[
                  { label: 'Tenant', value: reviewTarget.tenant_name },
                  { label: 'Landlord', value: reviewTarget.landlord_name },
                  { label: 'Agent', value: reviewTarget.agent_name },
                  {
                    label: 'Location',
                    value:
                      [reviewTarget.request_city, reviewTarget.request_district, reviewTarget.request_country]
                        .filter(Boolean)
                        .join(', ') || '—',
                  },
                  { label: 'Approved', value: format(new Date(reviewTarget.created_at), 'dd MMM yyyy') },
                  { label: 'Request reference', value: reviewTarget.id },
                ].map(row => (
                  <div key={row.label} className="flex items-start justify-between gap-3 px-3 py-2">
                    <span className="text-xs text-muted-foreground shrink-0">{row.label}</span>
                    <span className="font-medium text-right break-all">{row.value}</span>
                  </div>
                ))}
                <div className="flex items-center justify-between gap-3 px-3 py-2">
                  <span className="text-xs text-muted-foreground">Payout to</span>
                  {reviewTarget.payout_target === 'landlord_wallet' ? (
                    <Badge className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 border-emerald-200">
                      <Wallet className="h-3 w-3 mr-1" />
                      Landlord Wallet
                    </Badge>
                  ) : (
                    <Badge className="text-[10px] px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 border-amber-200">
                      <AlertTriangle className="h-3 w-3 mr-1" />
                      Agent Float
                    </Badge>
                  )}
                </div>
                {reviewTarget.partner_reserved_stage && (
                  <div className="flex items-center justify-between gap-3 px-3 py-2">
                    <span className="text-xs text-muted-foreground">Partner status</span>
                    <Badge className="text-[10px] px-2 py-0.5 rounded-full bg-violet-100 text-violet-700 border-violet-200">
                      {PARTNER_RESERVED_LABEL[reviewTarget.partner_reserved_stage]}
                    </Badge>
                  </div>
                )}
              </div>

              <div className="grid grid-cols-3 gap-2 text-center">
                <div className="rounded-lg bg-muted/40 py-2">
                  <p className="text-[10px] text-muted-foreground">Rent out</p>
                  <p className="font-bold text-sm text-orange-600">{fmt(reviewTarget.rent_amount)}</p>
                </div>
                <div className="rounded-lg bg-muted/40 py-2">
                  <p className="text-[10px] text-muted-foreground">Fees</p>
                  <p className="font-bold text-sm text-emerald-600">{fmt(reviewTarget.access_fee + reviewTarget.request_fee)}</p>
                </div>
                <div className="rounded-lg bg-muted/40 py-2">
                  <p className="text-[10px] text-muted-foreground">Repayment</p>
                  <p className="font-bold text-sm text-primary">{fmt(reviewTarget.total_repayment)}</p>
                </div>
              </div>

              {reviewTarget.partner_reserved_stage && (
                <p className="text-[11px] text-muted-foreground leading-relaxed">
                  {PARTNER_RESERVED_HINT[reviewTarget.partner_reserved_stage]}
                </p>
              )}

              <CfoApprovalGate>
              <div className="flex flex-col sm:flex-row gap-2">
                <Button
                  className="flex-1 h-10 rounded-xl font-semibold"
                  onClick={() => {
                    singleDisburse.mutate(reviewTarget.id);
                    setReviewTarget(null);
                  }}
                  disabled={singleDisburse.isPending || !!reviewTarget.partner_reserved_stage}
                  title={
                    reviewTarget.partner_reserved_stage
                      ? PARTNER_RESERVED_HINT[reviewTarget.partner_reserved_stage]
                      : `Fund this tenant on ${reviewTarget.agent_name}'s float`
                  }
                >
                  {singleDisburse.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : <Banknote className="h-3.5 w-3.5 mr-1" />}
                  Fund this float
                </Button>
                <Button
                  variant="outline"
                  className="flex-1 h-10 rounded-xl text-destructive hover:text-destructive hover:bg-destructive/10"
                  onClick={() => {
                    setRejectTarget(reviewTarget);
                    setRejectReason('');
                    setReviewTarget(null);
                  }}
                >
                  <XCircle className="h-3.5 w-3.5 mr-1" />
                  Reject
                </Button>
              </div>
              </CfoApprovalGate>

              {reviewTarget.assigned_agent_id || reviewTarget.agent_id ? (
                <button
                  type="button"
                  className="text-xs font-medium text-primary hover:underline"
                  onClick={() => setDrilldownAgentId(reviewTarget.assigned_agent_id || reviewTarget.agent_id)}
                >
                  Open agent profile
                </button>
              ) : null}
            </div>
          )}
        </SheetContent>
      </Sheet>

      <Dialog
        open={!!rejectTarget}
        onOpenChange={(o) => { if (!o) { setRejectTarget(null); setRejectReason(''); } }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reject rent request</DialogTitle>
            <DialogDescription>
              {rejectTarget && (
                <>
                  Returning <b>{fmt(rejectTarget.rent_amount)}</b> for{' '}
                  <b>{rejectTarget.tenant_name}</b> → <b>{rejectTarget.landlord_name}</b> back to{' '}
                  <b>{rejectTarget.agent_name}</b>. Your comment will appear in the agent's
                  Rejected submissions.
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <label className="text-xs font-medium">Reason / comment (min 10 characters)</label>
            <Textarea
              rows={4}
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              placeholder="e.g. Landlord MoMo number doesn't match name on record — please re-verify and resubmit."
            />
            {rejectReason.trim().length > 0 && rejectReason.trim().length < 10 && (
              <p className="text-[11px] text-destructive">
                {10 - rejectReason.trim().length} more character{10 - rejectReason.trim().length === 1 ? '' : 's'} required
              </p>
            )}
          </div>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => { setRejectTarget(null); setRejectReason(''); }}
              disabled={rejectMutation.isPending}
            >
              Cancel
            </Button>
            <CfoApprovalGate>
            <Button
              variant="destructive"
              onClick={() => rejectTarget && rejectMutation.mutate({ id: rejectTarget.id, reason: rejectReason })}
              disabled={rejectMutation.isPending || rejectReason.trim().length < 10}
            >
              {rejectMutation.isPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />
              ) : (
                <XCircle className="h-3.5 w-3.5 mr-1" />
              )}
              Reject & return to agent
            </Button>
            </CfoApprovalGate>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <UserDrilldownDrawer
        open={!!drilldownAgentId}
        onOpenChange={(v) => { if (!v) setDrilldownAgentId(null); }}
        agentId={drilldownAgentId}
        defaultTab="agent"
      />
    </Card>
  );
}
