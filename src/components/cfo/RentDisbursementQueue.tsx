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
import { Loader2, CheckCircle2, Banknote, TrendingUp, Users, Wallet, AlertTriangle, XCircle, Search, MapPin, Filter, Eye, ArrowRight, ShieldCheck, RefreshCw, MoreHorizontal, ChevronLeft, ChevronRight, Download } from 'lucide-react';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { TenantPaymentHistoryCard } from '@/components/executive/TenantPaymentHistoryCard';
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
import { filterByRentDesk, useRentDeskOrder, withRentDeskScores, type RentDeskScoreFields } from '@/hooks/useRentDeskOrder';
import { useRentDeskUrlState } from '@/hooks/useRentDeskUrlState';
import { RentDeskControls } from '@/components/rent-desk/RentDeskControls';
import { PaymentLabelChip } from '@/components/rent-desk/PaymentLabelChip';
import { RENT_DESK_SORTS, RENT_DESK_SORT_LABELS, type RentDeskSort } from '@/lib/rentDeskFilters';
import { groupPayoutRows } from '@/lib/payoutDeskGrouping';
import { AgentWeekPct } from '@/components/rent-desk/AgentWeekPct';
import { useAgentWeekPct } from '@/hooks/useAgentWeekPct';
import { agentWeekSummary } from '@/lib/agentWeekPct';
import { RenewalListTags, RenewalReviewPanel } from '@/components/rent/RenewalReviewPanel';
import { AboveSuggestionToggle } from '@/components/rent/AboveSuggestionToggle';
import { useAboveSuggestionFilter } from '@/hooks/useAboveSuggestionFilter';
import { useLandlordFloatBudgetActions, useLandlordFloatBudgetStatus } from '@/hooks/useLandlordFloatBudget';
import { landlordFloatErrorText, landlordFloatExcess } from '@/lib/landlordFloatBudget';
import { extractFromErrorObject } from '@/lib/extractEdgeFunctionError';
import { LandlordFloatExcessBanner } from '@/components/shared/LandlordFloatBudgetPosition';
import { useRentRequestTiming } from '@/hooks/useRentRequestTiming';
import { RentTimingRow } from '@/components/rent-desk/RentTimingRow';
import { TIMING_BATCH_LIMIT } from '@/lib/rentTiming';

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
  /** Renewals: what changed and why, as the agent filed it and the server advised (rent_requests.renewal_*). */
  registration_type?: string | null;
  duration_days?: number | null;
  renewal_previous_rent?: number | null;
  renewal_previous_days?: number | null;
  renewal_advice_snapshot?: unknown;
  renewal_above_suggestion?: boolean | null;
  renewal_above_by?: number | null;
  renewal_change_reason_code?: string | null;
  renewal_change_explanation?: string | null;
  renewal_evidence_url?: string | null;
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
        .select('id, rent_amount, tenant_id, landlord_id, agent_id, assigned_agent_id, access_fee, request_fee, total_repayment, created_at, request_country, request_city, house_listing_id, duration_days, registration_type, renewal_previous_rent, renewal_previous_days, renewal_advice_snapshot, renewal_above_suggestion, renewal_above_by, renewal_change_reason_code, renewal_change_explanation, renewal_evidence_url')
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

  // Good-paying tenants first for payouts: the server ranks the loaded requests by each tenant's payment score (best payers
  // first by default; newest / oldest are one click away) and says which match the paying-label and arrival filters. Display
  // order and visibility only: what can be selected and every payment step below are unchanged. Sort and filters live in the URL.
  const deskUrl = useRentDeskUrlState();
  const { only: aboveOnly, setOnly: setAboveOnly } = useAboveSuggestionFilter();
  const itemIds = useMemo(() => items.map(i => i.id), [items]);
  const deskOrder = useRentDeskOrder(itemIds, deskUrl.sort, deskUrl.filters);
  const scoredItems = useMemo(() => withRentDeskScores(items, deskOrder.data), [items, deskOrder.data]);
  // The registering agent's collection % for this Thursday-Wednesday week (one read-only call for the whole queue). Shown next to the agent's name and,
  // in the default sort, lists the agent with the highest % first. If it fails no % shows and the previous order stays.
  const agentWeek = useAgentWeekPct(itemIds);
  const showLoading = isLoading || (itemIds.length > 0 && deskOrder.isLoading) || (deskUrl.sort === 'agent_week' && itemIds.length > 0 && agentWeek.isLoading);
  const weekChip = (item: { agent_id: string | null; assigned_agent_id: string | null }) => (
    <AgentWeekPct
      week={item.agent_id ? agentWeek.byAgent.get(item.agent_id) : undefined}
      loading={agentWeek.isLoading}
      forName={item.assigned_agent_id && item.assigned_agent_id !== item.agent_id ? 'the agent who registered the tenant' : undefined}
    />
  );

  const selectedItems = useMemo(() => items.filter(i => selected.has(i.id)), [items, selected]);

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
    return filterByRentDesk(scoredItems, deskOrder.data).filter(it => {
      if (restrictSet && !restrictSet.has(it.id)) return false;
      if (aboveOnly && !it.renewal_above_suggestion) return false;
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
  }, [scoredItems, deskOrder.data, dateFilter, search, restrictSet, districtFilter, cityFilter, catField, catValue, aboveOnly]);

  // How long each request has been on the CFO desk, and its total time in the system: one call for the rows on screen (first 200), read-only.
  const deskTiming = useRentRequestTiming(useMemo(() => filteredItems.slice(0, TIMING_BATCH_LIMIT).map(i => i.id), [filteredItems]));

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
  // Agents' tenants listed in the server's order (best payers first by default), agents by their best-ranked tenant; the previous
  // newest-first layout while the order is loading or if it failed. See src/lib/payoutDeskGrouping.ts.
  const grouped = useMemo(
    () => groupPayoutRows(filteredItems, deskOrder.data, deskUrl.sort === 'agent_week' ? (row) => (row.agent_id ? agentWeekSummary(agentWeek.byAgent.get(row.agent_id)).primary?.pct ?? null : null) : undefined),
    [filteredItems, deskOrder.data, deskUrl.sort, agentWeek.byAgent],
  );

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
    // Tenants already ticked: review exactly those — never widen the
    // selection to every eligible row. Only pick all when nothing is ticked.
    if (selectedVisibleCount === 0) {
      setSelected(new Set(selectableItems.map(i => i.id)));
    }
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
      // Send payments in parallel with a small concurrency cap: sequential calls
      // made large batches very slow; each request is funded independently server-side.
      const CONCURRENCY = 5;
      let cursor = 0;
      const worker = async () => {
        while (cursor < stillEligible.length) {
          const id = stillEligible[cursor++];
          const { error } = await supabase.functions.invoke('fund-agent-landlord-float', {
            body: { rent_request_id: id, notes: `Batch: ${batchRef}` },
          });
          if (error) {
            errors.push(`${id.slice(0, 8)}: ${await extractFromErrorObject(error, 'Funding failed')}`);
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, stillEligible.length) }, worker));
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
      if (error) throw new Error(await extractFromErrorObject(error, 'Disbursement failed'));
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

  // Landlord float budget cap: a CFO rejection here returns the request to the COO step (not the agent) and gives
  // its amount back to the budget. landlordFloatOver.any drives the "exceeds budget by UGX X" banner (UI: Gemini).
  const landlordFloatBudget = useLandlordFloatBudgetStatus();
  const landlordFloatOver = landlordFloatExcess(landlordFloatBudget.data);
  const { returnToCoo } = useLandlordFloatBudgetActions();

  const rejectMutation = useMutation({
    mutationFn: async ({ id, reason }: { id: string; reason: string }) => {
      if (!user) throw new Error('Not authenticated');
      if (reason.trim().length < 10) throw new Error('Reason must be at least 10 characters');
      // One RPC: status back to the COO step, CFO reviewer + comment stamped, budget allocation released.
      const res = await returnToCoo.mutateAsync({ requestIds: [id], reason });
      if (res.returned.length === 0) {
        throw new Error(res.skipped[0]?.message || 'This rent request could not be returned to the COO');
      }
    },
    onSuccess: () => {
      toast.success('Returned to the COO with your comment. Its amount is back in the landlord float budget.');
      setRejectTarget(null);
      setRejectReason('');
      qc.invalidateQueries({ queryKey: ['rent-disbursement-queue'] });
      qc.invalidateQueries({ queryKey: ['rent-pipeline'] });
    },
    onError: (e: any) => toast.error(landlordFloatErrorText(e)),
  });

  // Summary totals for the currently filtered queue.
  const queueTotalRent = useMemo(() => filteredItems.reduce((s, i) => s + i.rent_amount, 0), [filteredItems]);
  const queueTotalRevenue = useMemo(() => filteredItems.reduce((s, i) => s + i.access_fee + i.request_fee, 0), [filteredItems]);
  const queueTotalRepaymentExpected = useMemo(() => filteredItems.reduce((s, i) => s + i.total_repayment, 0), [filteredItems]);

  const PAGE_SIZE = 15;
  const [page, setPage] = useState(1);
  const pageCount = Math.max(1, Math.ceil(visibleItems.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount);
  const pageStart = (safePage - 1) * PAGE_SIZE;
  const pageItems = visibleItems.slice(pageStart, pageStart + PAGE_SIZE);

  const getPageNumbers = () => {
    if (pageCount <= 7) return Array.from({ length: pageCount }, (_, i) => i + 1);
    if (safePage <= 4) return [1, 2, 3, 4, 5, '...', pageCount];
    if (safePage >= pageCount - 3) return [1, '...', pageCount - 4, pageCount - 3, pageCount - 2, pageCount - 1, pageCount];
    return [1, '...', safePage - 1, safePage, safePage + 1, '...', pageCount];
  };

  const handleResetFilters = () => {
    setSearch('');
    setAgentFilter('all');
    setCountryFilter('all');
    setDateFilter('all');
    clearLocation();
    setSelected(new Set());
    setPage(1);
  };

  const exportCsv = () => {
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const head = ['#', 'Tenant', 'Property', 'Landlord', 'Agent', 'Location', 'Payout Amount (UGX)', 'Status', 'Approved'];
    const rows = visibleItems.map((i, n) => [
      n + 1,
      i.tenant_name,
      [i.loc_village || i.loc_parish, i.loc_house_category].filter(Boolean).join(' · '),
      i.landlord_name,
      i.agent_name,
      [i.request_city, i.request_country].filter(Boolean).join(', '),
      Math.round(i.rent_amount),
      i.partner_reserved_stage
        ? PARTNER_RESERVED_LABEL[i.partner_reserved_stage]
        : i.payout_target === 'landlord_wallet'
        ? 'Landlord Wallet'
        : 'Agent Float',
      format(new Date(i.created_at), 'dd MMM yyyy'),
    ]);
    const csv = [head, ...rows].map(r => r.map(esc).join(',')).join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `rent-disbursement-${format(new Date(), 'yyyy-MM-dd')}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const dateFilterLabel: Record<string, string> = { all: 'All time', '7d': 'Last 7 days', '30d': 'Last 30 days' };

  return (
    <Card className="overflow-hidden rounded-2xl border-border/70 shadow-sm bg-card">
      <CardHeader className="pb-0 space-y-0 p-0">
        {landlordFloatOver.any && (
          <div className="p-4 bg-muted/20 border-b border-border/60">
            <LandlordFloatExcessBanner daily={landlordFloatOver.daily} weekly={landlordFloatOver.weekly} />
          </div>
        )}

        {/* Executive Header */}
        <div className="px-6 pt-6 pb-5 space-y-5">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div className="flex items-center gap-3.5">
              <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-primary/20 via-primary/10 to-primary/5 text-primary shadow-sm ring-1 ring-primary/25">
                <Banknote className="h-6 w-6" />
              </div>
              <div>
                <div className="flex items-center gap-2.5 flex-wrap">
                  <h2 className="text-2xl font-bold tracking-tight text-foreground">Rent Disbursement</h2>
                  <Badge variant="outline" className="text-[11px] font-semibold px-2.5 py-0.5 rounded-full bg-primary/10 text-primary border-primary/20">
                    CFO Execution Desk
                  </Badge>
                  {locationScoped && (
                    <Badge variant="secondary" className="text-[11px] font-medium px-2.5 py-0.5 rounded-full flex items-center gap-1">
                      <MapPin className="h-3 w-3" />
                      {locationScopeLabel}
                    </Badge>
                  )}
                </div>
                <p className="text-sm text-muted-foreground mt-0.5">
                  Review COO-approved rent requests, select tenants, and disburse payouts into landlord wallets or agent float.
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2 shrink-0">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-9 rounded-xl gap-2 border-border/70 shadow-xs hover:bg-muted"
                onClick={() => {
                  qc.invalidateQueries({ queryKey: ['rent-disbursement-queue'] });
                  toast.success('Queue refreshed');
                }}
              >
                <RefreshCw className="h-4 w-4" />
                Refresh
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-9 rounded-xl gap-2 border-border/70 shadow-xs hover:bg-muted"
                disabled={visibleItems.length === 0}
                onClick={exportCsv}
              >
                <Download className="h-4 w-4" />
                Export CSV
              </Button>
            </div>
          </div>

          {/* KPI Strip */}
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3.5">
            {[
              {
                icon: Users,
                label: 'Total Tenants',
                value: String(filteredItems.length),
                hint: visibleItems.length === filteredItems.length ? 'Showing all in view' : `Showing ${visibleItems.length} of ${filteredItems.length}`,
                badge: `${visibleGroups.length} Agents`,
                tone: 'bg-blue-500/10 text-blue-600 dark:text-blue-400 ring-1 ring-blue-500/20',
              },
              {
                icon: Banknote,
                label: 'Total Payout Amount',
                value: fmt(queueTotalRent),
                hint: 'Rent principal for this queue',
                badge: 'Principal',
                tone: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 ring-1 ring-emerald-500/20',
              },
              {
                icon: TrendingUp,
                label: 'Platform Fees',
                value: fmt(queueTotalRevenue),
                hint: `Repayment expected: ${fmt(queueTotalRepaymentExpected)}`,
                badge: 'Revenue',
                tone: 'bg-amber-500/10 text-amber-600 dark:text-amber-400 ring-1 ring-amber-500/20',
              },
              {
                icon: CheckCircle2,
                label: 'Selected for Disbursement',
                value: `${selectedVisibleCount} / ${selectableItems.length}`,
                hint: selected.size > 0 ? fmt(totalRent) : 'Tick tenants to batch fund',
                badge: selected.size > 0 ? `${selected.size} active` : 'Ready',
                tone: selected.size > 0 ? 'bg-primary/15 text-primary ring-1 ring-primary/30' : 'bg-muted text-muted-foreground ring-1 ring-border/50',
              },
            ].map((t) => (
              <div
                key={t.label}
                className="relative overflow-hidden flex flex-col justify-between rounded-2xl border border-border/70 bg-gradient-to-br from-card via-card to-card/60 p-4 shadow-xs hover:shadow-sm transition-all duration-200"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className={cn('flex h-10 w-10 shrink-0 items-center justify-center rounded-xl shadow-xs', t.tone)}>
                    <t.icon className="h-5 w-5" />
                  </span>
                  <Badge variant="outline" className="text-[10px] font-semibold px-2 py-0.5 rounded-full border-border/60">
                    {t.badge}
                  </Badge>
                </div>
                <div className="mt-3 min-w-0">
                  <p className="text-xs font-medium text-muted-foreground truncate">{t.label}</p>
                  <p className="text-xl sm:text-2xl font-bold tracking-tight text-foreground truncate mt-0.5">{t.value}</p>
                  <p className="text-[11px] text-muted-foreground truncate mt-1">{t.hint}</p>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Filter Toolbar */}
        <div className="border-y border-border/70 bg-muted/20 px-6 py-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-7 gap-3 items-center">
            {/* Search */}
            <div className="relative w-full">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => { setSearch(e.target.value); setSelected(new Set()); setPage(1); }}
                placeholder="Search tenant, landlord, agent…"
                className="h-10 rounded-xl text-sm pl-9 pr-8 bg-background border-border/70 shadow-xs focus-visible:ring-primary/20"
              />
              {search && (
                <button
                  type="button"
                  onClick={() => { setSearch(''); setPage(1); }}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground text-xs"
                >
                  ✕
                </button>
              )}
            </div>

            {/* District Filter */}
            <Select
              value={districtFilter}
              onValueChange={(v) => { setDistrictFilter(v); setCityFilter('all'); setSelected(new Set()); setPage(1); }}
            >
              <SelectTrigger className="h-10 rounded-xl text-sm w-full bg-background border-border/70 shadow-xs">
                <MapPin className="h-4 w-4 mr-2 text-muted-foreground shrink-0" />
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

            {/* Municipality/Town Filter */}
            <Select
              value={cityFilter}
              onValueChange={(v) => { setCityFilter(v); setSelected(new Set()); setPage(1); }}
            >
              <SelectTrigger className="h-10 rounded-xl text-sm w-full bg-background border-border/70 shadow-xs">
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

            {/* Agent Filter */}
            <Select
              value={agentFilter}
              onValueChange={(v) => { setAgentFilter(v); setPage(1); }}
            >
              <SelectTrigger className="h-10 rounded-xl text-sm w-full bg-background border-border/70 shadow-xs">
                <Users className="h-4 w-4 mr-2 text-muted-foreground shrink-0" />
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

            {/* Optional Category Pickers */}
            {!locationProvisionsOnly && (
              <Select
                value={catField}
                onValueChange={(v) => { setCatField(v as CatFieldKey); setCatValue('all'); setSelected(new Set()); setPage(1); }}
              >
                <SelectTrigger className="h-10 rounded-xl text-sm w-full bg-background border-border/70 shadow-xs">
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
              <Select
                value={catValue}
                onValueChange={(v) => { setCatValue(v); setSelected(new Set()); setPage(1); }}
              >
                <SelectTrigger className="h-10 rounded-xl text-sm w-full bg-background border-border/70 shadow-xs">
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

            {/* Reset Filters button */}
            <Button
              type="button"
              variant="outline"
              className="h-10 rounded-xl text-sm gap-2 border-border/70 shadow-xs hover:bg-muted"
              onClick={handleResetFilters}
            >
              <RefreshCw className="h-4 w-4 text-muted-foreground" />
              Reset Filters
            </Button>
          </div>

          {(agentFilter !== 'all' || locationScoped || catValue !== 'all' || search) && (
            <div className="flex items-center gap-2 pt-3 flex-wrap text-xs">
              <span className="text-muted-foreground font-medium">Active filters:</span>
              {search && (
                <Badge variant="secondary" className="gap-1 rounded-md text-[11px] font-normal">
                  Search: "{search}"
                </Badge>
              )}
              {districtFilter !== 'all' && (
                <Badge variant="secondary" className="gap-1 rounded-md text-[11px] font-normal">
                  District: {districtFilter}
                </Badge>
              )}
              {cityFilter !== 'all' && (
                <Badge variant="secondary" className="gap-1 rounded-md text-[11px] font-normal">
                  Town: {cityFilter}
                </Badge>
              )}
              {agentFilter !== 'all' && (
                <Badge variant="secondary" className="gap-1 rounded-md text-[11px] font-normal">
                  Agent: {grouped.find(g => g.agent_id === agentFilter)?.agent_name || agentFilter}
                </Badge>
              )}
              {catValue !== 'all' && (
                <Badge variant="secondary" className="gap-1 rounded-md text-[11px] font-normal">
                  {CAT_FIELD_LABELS[catField]}: {catValue}
                </Badge>
              )}
              <button
                type="button"
                className="text-xs font-medium text-primary hover:underline ml-1"
                onClick={handleResetFilters}
              >
                Clear all filters
              </button>
            </div>
          )}
        </div>
      </CardHeader>

      <CardContent className="space-y-4 p-6">
        {/* Rent Desk Controls & Suggestions */}
        <div className="rounded-xl border border-border/70 bg-card p-4 space-y-3">
          <RentDeskControls
            filters={deskUrl.filters}
            onFiltersChange={(f) => { deskUrl.setFilters(f); setSelected(new Set()); setPage(1); }}
            onClear={() => { deskUrl.clearFilters(); setSelected(new Set()); setPage(1); }}
            sort={deskUrl.sort}
            onSortChange={(v) => { deskUrl.setSort(v as RentDeskSort); setPage(1); }}
            sortOptions={RENT_DESK_SORTS.map((value) => ({ value, label: RENT_DESK_SORT_LABELS[value] }))}
            matchCount={deskOrder.data?.matchCount}
            totalCount={deskOrder.data?.totalCount}
            error={deskOrder.isError}
          />
          <AboveSuggestionToggle
            className="pt-1"
            on={aboveOnly}
            onChange={(on) => { setAboveOnly(on); setSelected(new Set()); setPage(1); }}
            count={items.filter((i) => i.renewal_above_suggestion).length}
          />
        </div>

        {showLoading ? (
          <div className="flex flex-col items-center justify-center py-16 gap-3">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
            <p className="text-sm font-medium text-muted-foreground">Loading rent disbursement queue…</p>
          </div>
        ) : filteredItems.length === 0 ? (
          <div className="text-center py-16 px-4 rounded-xl border border-dashed border-border/70 bg-muted/10">
            <CheckCircle2 className="h-12 w-12 mx-auto mb-3 text-emerald-500 opacity-90" />
            <p className="text-base font-semibold text-foreground">No Pending Rent Payouts</p>
            <p className="text-sm text-muted-foreground mt-1 max-w-md mx-auto">
              {dateFilter !== 'all'
                ? `No requests match ${dateFilterLabel[dateFilter]}.`
                : 'All approved rent requests have been disbursed to agent float or landlord wallets.'}
            </p>
            {(dateFilter !== 'all' || agentFilter !== 'all' || locationScoped || search) && (
              <Button
                variant="outline"
                size="sm"
                className="mt-4 rounded-xl text-xs gap-1.5"
                onClick={handleResetFilters}
              >
                <RefreshCw className="h-3.5 w-3.5" />
                Reset all filters
              </Button>
            )}
          </div>
        ) : (
          <div className="space-y-4">
            {/* Revenue summary — only while no tenants are ticked for payment */}
            {locationScoped && selected.size === 0 && (
              <div className="rounded-2xl border border-emerald-500/30 bg-gradient-to-br from-emerald-500/10 via-emerald-500/5 to-transparent p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <p className="text-xs font-bold flex items-center gap-1.5 text-emerald-700 dark:text-emerald-400">
                    <TrendingUp className="h-4 w-4" />
                    Revenue from this disbursement
                    <span className="ml-1 text-[11px] font-normal text-emerald-600/80 dark:text-emerald-400/80">
                      · Scoped by location ({locationScopeLabel})
                    </span>
                  </p>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-center">
                  <div className="rounded-xl border border-emerald-500/20 bg-background/80 p-3 shadow-xs">
                    <p className="text-[11px] font-medium text-muted-foreground">Rent Out (Principal)</p>
                    <p className="font-bold text-base text-orange-600 dark:text-orange-400 mt-0.5">
                      {fmt(selected.size > 0 ? totalRent : queueTotalRent)}
                    </p>
                  </div>
                  <div className="rounded-xl border border-emerald-500/20 bg-background/80 p-3 shadow-xs">
                    <p className="text-[11px] font-medium text-muted-foreground">Platform Earnings (Fees)</p>
                    <p className="font-bold text-base text-emerald-600 dark:text-emerald-400 mt-0.5">
                      {fmt(selected.size > 0 ? totalRevenue : queueTotalRevenue)}
                    </p>
                  </div>
                  <div className="rounded-xl border border-emerald-500/20 bg-background/80 p-3 shadow-xs">
                    <p className="text-[11px] font-medium text-muted-foreground">Total Repayment Expected</p>
                    <p className="font-bold text-base text-primary mt-0.5">
                      {fmt(selected.size > 0 ? totalRepaymentExpected : queueTotalRepaymentExpected)}
                    </p>
                  </div>
                </div>
                <TreasuryImpactBanner payoutAmount={selected.size > 0 ? totalRent : queueTotalRent} />
              </div>
            )}

            {/* Table Toolbar */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pt-1">
              <div className="flex items-center gap-2.5 flex-wrap">
                <span className="text-base font-bold text-foreground">
                  {visibleItems.length} tenant{visibleItems.length === 1 ? '' : 's'} awaiting payout
                </span>
                <span className="rounded-full bg-muted/80 px-2.5 py-0.5 text-xs text-muted-foreground border border-border/50">
                  {visibleItems.length === filteredItems.length
                    ? `Showing all ${visibleItems.length}`
                    : `Showing ${visibleItems.length} of ${filteredItems.length}`} · {visibleGroups.length} agent{visibleGroups.length === 1 ? '' : 's'}
                </span>
              </div>

              <div className="flex items-center gap-2 flex-wrap">
                {selectedVisibleCount > 0 ? (
                  <Button
                    type="button"
                    size="sm"
                    className="h-9 rounded-xl gap-2 font-semibold shadow-sm bg-primary text-primary-foreground hover:bg-primary/90"
                    onClick={() => setBulkReviewOpen(true)}
                  >
                    <Banknote className="h-4 w-4" />
                    Review &amp; Pay {selectedVisibleCount} Selected ({fmt(totalRent)})
                    <ArrowRight className="h-4 w-4" />
                  </Button>
                ) : (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-9 rounded-xl gap-2 font-medium border-border/70 shadow-xs hover:bg-muted"
                    disabled={selectableItems.length === 0}
                    onClick={selectAllForPayment}
                  >
                    <Banknote className="h-4 w-4 text-primary" />
                    Select All for Disbursement
                  </Button>
                )}

                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-9 rounded-xl gap-2 border-border/70 shadow-xs hover:bg-muted"
                  disabled={visibleItems.length === 0}
                  onClick={exportCsv}
                >
                  <Download className="h-4 w-4 text-muted-foreground" />
                  Export
                </Button>

                <Popover>
                  <PopoverTrigger asChild>
                    <Button variant="outline" size="sm" className="h-9 rounded-xl gap-2 border-border/70 shadow-xs hover:bg-muted">
                      <Filter className="h-4 w-4 text-muted-foreground" />
                      Filter
                      {(agentFilter !== 'all' || countryFilter !== 'all' || dateFilter !== 'all' || districtFilter !== 'all' || cityFilter !== 'all' || catValue !== 'all') && (
                        <Badge className="h-5 min-w-5 px-1.5 text-[10px] bg-primary text-primary-foreground border-0 rounded-full">
                          {[agentFilter !== 'all', countryFilter !== 'all', dateFilter !== 'all', districtFilter !== 'all', cityFilter !== 'all', catValue !== 'all'].filter(Boolean).length}
                        </Badge>
                      )}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent align="end" className="w-72 space-y-3 p-4 rounded-xl shadow-lg border-border/80">
                    <div className="space-y-1.5">
                      <p className="text-xs font-semibold text-muted-foreground">District</p>
                      <Select
                        value={districtFilter}
                        onValueChange={(v) => { setDistrictFilter(v); setCityFilter('all'); setSelected(new Set()); setPage(1); }}
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
                      <Select value={cityFilter} onValueChange={(v) => { setCityFilter(v); setSelected(new Set()); setPage(1); }}>
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
                        <Select value={catField} onValueChange={(v) => { setCatField(v as CatFieldKey); setCatValue('all'); setSelected(new Set()); setPage(1); }}>
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
                        <Select value={catValue} onValueChange={(v) => { setCatValue(v); setSelected(new Set()); setPage(1); }}>
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
                      <Select value={agentFilter} onValueChange={(v) => { setAgentFilter(v); setPage(1); }}>
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
                        <Select value={countryFilter} onValueChange={(v) => { setCountryFilter(v); setPage(1); }}>
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
                      className="text-xs font-medium text-primary hover:underline block pt-1"
                      onClick={handleResetFilters}
                    >
                      Clear all filters
                    </button>
                  </PopoverContent>
                </Popover>
              </div>
            </div>

            {/* Table Container */}
            <div className="rounded-xl border border-border/70 bg-card overflow-hidden shadow-xs">
              <div className="overflow-x-auto">
                <table className="w-full text-sm min-w-[68rem]">
                  <thead>
                    <tr className="border-b border-border/60 bg-muted/40 text-[11px] uppercase tracking-wider text-muted-foreground font-semibold">
                      <th className="w-12 px-3.5 py-3.5 text-center">
                        <Checkbox
                          aria-label="Select all on this page"
                          checked={pageItems.length > 0 && pageItems.filter(i => !i.partner_reserved_stage).every(i => selected.has(i.id))}
                          onCheckedChange={(v) =>
                            setSelected(prev => {
                              const n = new Set(prev);
                              pageItems.forEach(i => {
                                if (i.partner_reserved_stage) return;
                                if (v) n.add(i.id);
                                else n.delete(i.id);
                              });
                              return n;
                            })
                          }
                        />
                      </th>
                      <th className="w-10 px-3 py-3.5 text-center">#</th>
                      <th className="px-4 py-3.5 text-left">Tenant</th>
                      <th className="px-3 py-3.5 text-left">Property</th>
                      <th className="px-3 py-3.5 text-left">Landlord</th>
                      <th className="px-3 py-3.5 text-left">Agent</th>
                      <th className="px-3 py-3.5 text-left">Location</th>
                      <th className="px-4 py-3.5 text-right">Payout Amount</th>
                      <th className="px-3 py-3.5 text-center">Channel</th>
                      <th className="px-3 py-3.5 text-left">Approved</th>
                      <th className="w-16 px-3 py-3.5 text-center">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/50">
                    {visibleItems.length === 0 && (
                      <tr>
                        <td colSpan={11} className="text-center py-12 text-sm text-muted-foreground">
                          <div className="max-w-sm mx-auto flex flex-col items-center">
                            <CheckCircle2 className="h-10 w-10 text-emerald-500 mb-2 opacity-80" />
                            <p className="font-semibold text-foreground">No rent payouts match your filters</p>
                            <p className="text-xs text-muted-foreground mt-1">Try resetting your search query, location, or agent filters.</p>
                            <Button
                              variant="outline"
                              size="sm"
                              className="mt-3.5 rounded-lg text-xs"
                              onClick={handleResetFilters}
                            >
                              Clear all filters
                            </Button>
                          </div>
                        </td>
                      </tr>
                    )}
                    {pageItems.map((item, index) => {
                      const isSel = selected.has(item.id);
                      const reserved = item.partner_reserved_stage;
                      const locationLabel = [item.request_city, item.request_country].filter(Boolean).join(', ');
                      const propertyLabel = [item.loc_village || item.loc_parish, item.loc_house_category].filter(Boolean).join(' · ');
                      const rowNumber = pageStart + index + 1;
                      return (
                        <tr
                          key={item.id}
                          onClick={() => setReviewTarget(item)}
                          className={cn(
                            'cursor-pointer transition-colors',
                            isSel ? 'bg-primary/[0.05] hover:bg-primary/[0.08]' : 'hover:bg-muted/40'
                          )}
                        >
                          <td className="px-3.5 py-3.5 align-middle text-center" onClick={e => e.stopPropagation()}>
                            <Checkbox
                              aria-label={`Select ${item.tenant_name}`}
                              disabled={!!reserved}
                              checked={isSel}
                              onCheckedChange={() => toggle(item.id)}
                            />
                          </td>
                          <td className="px-3 py-3.5 align-middle text-center text-xs font-mono text-muted-foreground">{rowNumber}</td>
                          <td className="px-4 py-3.5 align-middle">
                            <p className="font-semibold text-foreground truncate max-w-[13rem]">{item.tenant_name}</p>
                            <div className="mt-1 flex items-center gap-1.5 flex-wrap">
                              <PaymentLabelChip label={(item as RentDeskScoreFields).payment_label} score={(item as RentDeskScoreFields).payment_score} reason={(item as RentDeskScoreFields).payment_reason} showReason={false} />
                              <RenewalListTags request={{ ...item, duration_days: item.duration_days ?? 0 }} />
                            </div>
                          </td>
                          <td className="px-3 py-3.5 align-middle text-xs text-muted-foreground max-w-[9rem]">
                            <span className="line-clamp-2">{propertyLabel || '—'}</span>
                          </td>
                          <td className="px-3 py-3.5 align-middle text-xs font-medium text-foreground max-w-[8rem] truncate">
                            {item.landlord_name}
                          </td>
                          <td className="px-3 py-3.5 align-middle text-xs max-w-[11rem]">
                            <span className="font-medium text-foreground block truncate">{item.agent_name}</span>
                            <div className="mt-0.5">{weekChip(item)}</div>
                          </td>
                          <td className="px-3 py-3.5 align-middle text-xs text-muted-foreground max-w-[9rem] truncate">
                            {locationLabel || '—'}
                          </td>
                          <td className="px-4 py-3.5 align-middle text-right font-bold text-foreground whitespace-nowrap">
                            {fmt(item.rent_amount)}
                          </td>
                          <td className="px-3 py-3.5 align-middle text-center whitespace-nowrap">
                            {reserved ? (
                              <Badge variant="outline" className="text-[11px] px-2.5 py-0.5 rounded-full bg-violet-500/10 text-violet-700 dark:text-violet-300 border-violet-500/30 font-medium">
                                {PARTNER_RESERVED_LABEL[reserved]}
                              </Badge>
                            ) : item.payout_target === 'landlord_wallet' ? (
                              <Badge variant="outline" className="text-[11px] px-2.5 py-0.5 rounded-full bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/30 font-medium inline-flex items-center gap-1">
                                <Wallet className="h-3 w-3" />Landlord Wallet
                              </Badge>
                            ) : (
                              <Badge variant="outline" className="text-[11px] px-2.5 py-0.5 rounded-full bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/30 font-medium inline-flex items-center gap-1">
                                <AlertTriangle className="h-3 w-3" />Agent Float
                              </Badge>
                            )}
                          </td>
                          <td className="px-3 py-3.5 align-middle text-xs text-muted-foreground whitespace-nowrap">
                            {format(new Date(item.created_at), 'dd MMM yyyy')}
                          </td>
                          <td className="px-3 py-3.5 align-middle text-center" onClick={e => e.stopPropagation()}>
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button size="icon" variant="ghost" className="h-8 w-8 rounded-lg hover:bg-muted" aria-label={`Actions for ${item.tenant_name}`}>
                                  <MoreHorizontal className="h-4 w-4 text-muted-foreground" />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end" className="w-52 rounded-xl shadow-lg border-border/80">
                                <DropdownMenuItem onClick={() => setReviewTarget(item)} className="gap-2 cursor-pointer">
                                  <Eye className="h-4 w-4 text-primary" />Review Details
                                </DropdownMenuItem>
                                {!reserved && (
                                  <DropdownMenuItem onClick={() => toggle(item.id)} className="gap-2 cursor-pointer">
                                    <CheckCircle2 className="h-4 w-4 text-emerald-600" />{isSel ? 'Unselect' : 'Select for disbursement'}
                                  </DropdownMenuItem>
                                )}
                                <DropdownMenuItem
                                  onClick={() => {
                                    setRejectTarget(item);
                                    setRejectReason('');
                                  }}
                                  className="gap-2 cursor-pointer text-destructive focus:text-destructive"
                                >
                                  <XCircle className="h-4 w-4" />Return to COO
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* Pagination Controls */}
              <div className="flex flex-col sm:flex-row items-center justify-between gap-3 px-5 py-3.5 border-t border-border/60 bg-muted/20 text-xs text-muted-foreground">
                <div>
                  {visibleItems.length === 0
                    ? 'Showing 0 tenants'
                    : `Showing ${pageStart + 1}–${Math.min(pageStart + PAGE_SIZE, visibleItems.length)} of ${visibleItems.length} tenants (Page ${safePage} of ${pageCount})`}
                </div>
                {pageCount > 1 && (
                  <div className="flex items-center gap-1.5">
                    <Button
                      size="icon"
                      variant="outline"
                      className="h-8 w-8 rounded-lg border-border/70 shadow-xs"
                      disabled={safePage <= 1}
                      onClick={() => setPage(safePage - 1)}
                      aria-label="Previous page"
                    >
                      <ChevronLeft className="h-4 w-4" />
                    </Button>
                    {getPageNumbers().map((n, idx) =>
                      typeof n === 'number' ? (
                        <Button
                          key={n}
                          size="icon"
                          variant={n === safePage ? 'default' : 'outline'}
                          className={cn('h-8 w-8 rounded-lg font-medium text-xs', n === safePage ? 'shadow-xs' : 'border-border/70 shadow-xs')}
                          onClick={() => setPage(n)}
                        >
                          {n}
                        </Button>
                      ) : (
                        <span key={`ellipsis-${idx}`} className="px-1 text-muted-foreground select-none">
                          …
                        </span>
                      )
                    )}
                    <Button
                      size="icon"
                      variant="outline"
                      className="h-8 w-8 rounded-lg border-border/70 shadow-xs"
                      disabled={safePage >= pageCount}
                      onClick={() => setPage(safePage + 1)}
                      aria-label="Next page"
                    >
                      <ChevronRight className="h-4 w-4" />
                    </Button>
                  </div>
                )}
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
                      <span className="block">{weekChip(item)}</span>
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
              <RenewalReviewPanel request={{ ...reviewTarget, duration_days: reviewTarget.duration_days ?? 0 }} />
              <LandlordAgreementHistory
                landlordId={reviewTarget.landlord_id}
                landlordName={reviewTarget.landlord_name}
                landlordPhone=""
                canAdd={false}
              />

            



              <RentTimingRow
                requestId={reviewTarget.id}
                timing={deskTiming.byId.get(reviewTarget.id)}
                loading={deskTiming.isLoading}
                error={deskTiming.error}
                onRetry={deskTiming.refetch}
                ownDesk
                className="mt-0 mb-3"
              />

              <div className="rounded-xl border border-border/70 divide-y divide-border/60 text-sm">
                {[
                  { label: 'Tenant', value: reviewTarget.tenant_name },
                  { label: 'Landlord', value: reviewTarget.landlord_name },
                  { label: 'Agent', value: <span className="inline-flex flex-wrap items-center justify-end gap-1.5"><span>{reviewTarget.agent_name}</span>{weekChip(reviewTarget)}</span> },
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
                    <Badge variant="outline" className="text-[10px] px-2.5 py-0.5 rounded-full bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/30 font-medium">
                      <Wallet className="h-3 w-3 mr-1" />
                      Landlord Wallet
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="text-[10px] px-2.5 py-0.5 rounded-full bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/30 font-medium">
                      <AlertTriangle className="h-3 w-3 mr-1" />
                      Agent Float
                    </Badge>
                  )}
                </div>
                {reviewTarget.partner_reserved_stage && (
                  <div className="flex items-center justify-between gap-3 px-3 py-2">
                    <span className="text-xs text-muted-foreground">Partner status</span>
                    <Badge variant="outline" className="text-[10px] px-2.5 py-0.5 rounded-full bg-violet-500/10 text-violet-700 dark:text-violet-300 border-violet-500/30 font-medium">
                      {PARTNER_RESERVED_LABEL[reviewTarget.partner_reserved_stage]}
                    </Badge>
                  </div>
                )}
              </div>

              <div className="grid grid-cols-3 gap-2.5 text-center">
                <div className="rounded-xl border border-border/70 bg-muted/30 p-2.5 shadow-xs">
                  <p className="text-[10px] font-medium text-muted-foreground">Rent out</p>
                  <p className="font-bold text-sm text-orange-600 dark:text-orange-400 mt-0.5">{fmt(reviewTarget.rent_amount)}</p>
                </div>
                <div className="rounded-xl border border-border/70 bg-muted/30 p-2.5 shadow-xs">
                  <p className="text-[10px] font-medium text-muted-foreground">Fees</p>
                  <p className="font-bold text-sm text-emerald-600 dark:text-emerald-400 mt-0.5">{fmt(reviewTarget.access_fee + reviewTarget.request_fee)}</p>
                </div>
                <div className="rounded-xl border border-border/70 bg-muted/30 p-2.5 shadow-xs">
                  <p className="text-[10px] font-medium text-muted-foreground">Repayment</p>
                  <p className="font-bold text-sm text-primary mt-0.5">{fmt(reviewTarget.total_repayment)}</p>
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
                  Return to COO
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
            <DialogTitle>Return to COO</DialogTitle>
            <DialogDescription>
              {rejectTarget && (
                <>
                  Returning <b>{fmt(rejectTarget.rent_amount)}</b> for{' '}
                  <b>{rejectTarget.tenant_name}</b> → <b>{rejectTarget.landlord_name}</b> back to{' '}
                  <b>the COO</b> for review. This releases the request's allocation back into the landlord float budget.
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
              Return to COO
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
