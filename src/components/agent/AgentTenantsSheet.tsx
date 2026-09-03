import { useState, useEffect, useCallback, useMemo, useRef, useDeferredValue } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover';
import { Loader2, Search, Phone, PhoneCall, FileDown, MessageCircle, Users, RefreshCw, Banknote, MapPin, Home, User, TrendingUp, ArrowLeft, Shield, ArrowUp, ArrowDown, ArrowUpDown, Wallet, DollarSign, AlertCircle, CheckCircle2, CreditCard, Eye, Building2, SlidersHorizontal, Plus, Check, ChevronsUpDown, Map as MapIcon, Navigation, List, X, CalendarClock, Star, RotateCcw } from 'lucide-react';
import { Settings } from 'lucide-react';
import { PropertyMapView } from './PropertyMapView';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator } from '@/components/ui/command';
import { formatUGX, calculateRentRepayment } from '@/lib/rentCalculations';
import { getEffectiveRentRequestAmounts } from '@/lib/rentRequestAmounts';
import { generateWelileAiId, getRiskTierLabel } from '@/lib/welileAiId';
import { format, startOfDay, formatDistanceToNowStrict } from 'date-fns';
import { motion, AnimatePresence } from 'framer-motion';
import { downloadRepaymentPdf, shareRepaymentPdfWhatsApp } from '@/lib/repaymentSchedulePdf';
import { downloadRentStatement, buildRentStatementWhatsApp } from '@/lib/receiptPdf';
import { shareDailyAllocationPdf, type AllocationRow } from '@/lib/dailyAllocationPdf';
import { useToast } from '@/hooks/use-toast';
import { toast as sonnerToast } from 'sonner';
import AgentRentRequestDialog from './AgentRentRequestDialog';
import { AgentTenantCollectDialog } from './AgentTenantCollectDialog';
import { TenantBehaviorCard } from './TenantBehaviorCard';
import { TenantProfileView } from './TenantProfileView';
import { TenantFieldCollectDialog } from './TenantFieldCollectDialog';
import { AgentRequestPipelineView } from './AgentRequestPipelineView';
import { MarkNotFundedDialog } from './MarkNotFundedDialog';
import { AgentRentCapacitySelfCard } from './AgentRentCapacitySelfCard';
import { AgentCapacityBreakdownPanel } from './AgentCapacityBreakdownPanel';
import { useCreditAccessLimit, formatCreditAmount } from '@/hooks/useCreditAccessLimit';
import { AgentAdvanceRequestForm } from './AgentAdvanceRequestForm';
import { Sparkles, Zap, ArrowDownAZ, ListChecks, CheckSquare } from 'lucide-react';
import { addEntry, newClientUuid, type FieldEntry } from '@/lib/fieldCollectStore';

interface Tenant {
  id: string;
  full_name: string;
  phone: string;
  email: string;
  created_at: string;
  monthly_rent: number | null;
  verified: boolean;
}

interface TenantRentRequest {
  id: string;
  rent_amount: number;
  total_repayment: number;
  duration_days: number;
  daily_repayment: number;
  amount_repaid: number;
  status: string | null;
  created_at: string;
  disbursed_at: string | null;
  registration_type: string | null;
  initial_outstanding_balance?: number | null;
  outstanding_grace_days?: number | null;
  landlord_id?: string | null;
  lc1_id?: string | null;
  house_category?: string | null;
  tenant_no_smartphone?: boolean | null;
  request_latitude?: number | null;
  request_longitude?: number | null;
  landlord?: { name: string; property_address: string; house_category?: string; latitude?: number; longitude?: number } | null;
}

interface AgentTenantsSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Which view to land on when the sheet opens. Defaults to 'tenants'. */
  initialView?: 'tenants' | 'pipeline';
  /** When opening directly into the pipeline, which sub-tab to show. */
  initialPipelineTab?: 'submitted' | 'approved' | 'rejected' | 'landlords';
  /** Record id to scroll to and highlight when opening into the pipeline. */
  initialHighlightId?: string | null;
  /** When set on open, jump straight to this tenant's profile (payments + outstanding). */
  initialProfileTenantId?: string | null;
}

type FilterTab = 'owing' | 'paid-up' | 'all';
type LifecycleFilter = 'any' | 'active' | 'pending' | 'settled';
type RiskFilter = 'all' | 'good' | 'standard' | 'caution' | 'new';
type SortKey = 'risk' | 'aiId' | 'property' | 'balance' | 'daily' | 'property-daily' | 'property-balance' | 'lastCollected' | 'recent' | 'name';
type SortDir = 'asc' | 'desc';

// Simple Mode language — English or Luganda. Lets agents who read little flip
// the picture-first labels into their own language. Persisted in prefs.
type SimpleLang = 'en' | 'lg';

type SimpleTextKey =
  | 'toCollect' | 'paid' | 'allPaid' | 'searchTenant'
  | 'showAll' | 'showOwing' | 'showPaid'
  | 'sortBiggest' | 'sortName'
  | 'selectMany' | 'stopSelecting'
  | 'selected' | 'markPaid' | 'collect' | 'call'
  | 'markNPaid' | 'recordsFull' | 'totalToRecord' | 'confirm' | 'cancel'
  | 'langName';

const SIMPLE_TEXT: Record<SimpleTextKey, { en: string; lg: string }> = {
  toCollect:     { en: 'To collect',   lg: 'Ebbanja' },
  paid:          { en: 'Paid',         lg: 'Ezasasulwa' },
  allPaid:       { en: 'All paid',     lg: 'Yamaze' },
  searchTenant:  { en: 'Search tenant…', lg: 'Noonya omupangisa…' },
  showAll:       { en: 'Show all tenants', lg: 'Laga bonna' },
  showOwing:     { en: 'Show tenants who must pay', lg: 'Laga ab’ebbanja' },
  showPaid:      { en: 'Show tenants who paid', lg: 'Laga abasasudde' },
  sortBiggest:   { en: 'Sort by biggest amount first', lg: 'Ssente ennene mu maaso' },
  sortName:      { en: 'Sort by name A to Z', lg: 'Erinnya A okutuuka Z' },
  selectMany:    { en: 'Select many to collect', lg: 'Londa bangi okusooza' },
  stopSelecting: { en: 'Stop selecting', lg: 'Lekera awo' },
  selected:      { en: 'selected',      lg: 'abalondedwa' },
  markPaid:      { en: 'Mark paid',     lg: 'Basasudde' },
  collect:       { en: 'Collect',       lg: 'Sooza' },
  call:          { en: 'Call',          lg: 'Kuba essimu' },
  markNPaid:     { en: 'Mark {n} paid?', lg: 'Teeka {n} nti basasudde?' },
  recordsFull:   { en: 'Records full payment for each selected tenant. Works offline.', lg: 'Kiwandiika nti buli omu asasudde byonna. Kikola ne awatali yintaneeti.' },
  totalToRecord: { en: 'Total to record', lg: 'Omugatte ogusasulwa' },
  confirm:       { en: 'Confirm',       lg: 'Kakasa' },
  cancel:        { en: 'Cancel',        lg: 'Sazaamu' },
  langName:      { en: 'English',       lg: 'Luganda' },
};

const PREFS_KEY = 'agent-tenants-sheet:prefs:v2';
const RECENT_PROPERTIES_KEY = 'agent-tenants-sheet:recent-properties:v1';
const MAX_RECENT_PROPERTIES = 5;

function loadRecentProperties(): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(RECENT_PROPERTIES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

type RecentCollectionFilter = 'all' | '1' | '3' | '7' | '14' | '30' | 'never';

interface SheetPrefs {
  search?: string;
  activeFilter?: FilterTab;
  riskFilter?: RiskFilter;
  propertyFilter?: string;
  sortKey?: SortKey;
  sortDir?: SortDir;
  recentCollectionFilter?: RecentCollectionFilter;
  groupByProperty?: boolean;
  lifecycleFilter?: LifecycleFilter;
  simpleMode?: boolean;
  simpleLang?: SimpleLang;
}

function loadPrefs(): SheetPrefs {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(PREFS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as SheetPrefs;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

// ───── Saved filter presets ─────
// Agents can snapshot their usual Owing/Paid up/All + search + sort setup and
// jump back to it in one tap. Persisted separately from the live prefs.
const PRESETS_KEY = 'agent-tenants-sheet:presets:v1';

interface SheetPreset {
  id: string;
  name: string;
  search: string;
  activeFilter: FilterTab;
  lifecycleFilter: LifecycleFilter;
  riskFilter: RiskFilter;
  propertyFilter: string;
  sortKey: SortKey;
  sortDir: SortDir;
  recentCollectionFilter: RecentCollectionFilter;
  groupByProperty: boolean;
}

function loadPresets(): SheetPreset[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(PRESETS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as SheetPreset[]) : [];
  } catch {
    return [];
  }
}

function savePresets(presets: SheetPreset[]) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(PRESETS_KEY, JSON.stringify(presets));
  } catch {
    /* ignore quota / serialization errors */
  }
}

const RISK_ORDER: Record<'good' | 'standard' | 'caution' | 'new', number> = {
  caution: 0,
  standard: 1,
  good: 2,
  new: 3,
};

const TENANT_DETAIL_REQUEST_FILTER =
  'status.in.(pending,approved,funded,disbursed,repaying,completed),registration_type.eq.outstanding_balance';

// Escape regex special characters before building a search-highlight pattern.
function escapeRegex(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Render `text` with all case-insensitive occurrences of `query` wrapped in a
 * highlight span. Falls back to plain text when there's no query / no match.
 *
 * In addition to plain case-insensitive substring matching, this also
 * highlights:
 *   - phone digits typed without separators (e.g. "772123" against
 *     "+256 772 123 456" highlights just the "772 123" span)
 *   - reference-ID / Welile AI ID fragments typed without dashes
 *     (e.g. "ab129x" against "WID-AB12-9X")
 *   - UUID prefixes typed without dashes
 * so the exact characters that matched are visually called out — even when
 * the stored value is formatted differently than what the agent typed.
 */
function findNormalizedRange(
  text: string,
  query: string,
  normalize: (ch: string) => string,
): [number, number] | null {
  const nq = normalize(query);
  if (!nq) return null;
  let normalized = '';
  const map: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const n = normalize(text[i]);
    for (let k = 0; k < n.length; k++) map.push(i);
    normalized += n;
  }
  const idx = normalized.indexOf(nq);
  if (idx === -1) return null;
  return [map[idx], map[idx + nq.length - 1] + 1];
}

const normLower = (s: string) => s.toLowerCase();
const normDigits = (s: string) => s.replace(/\D+/g, '');
const normAlnumLower = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');

function Highlight({ text, query }: { text?: string | null; query: string }) {
  const value = text ?? '';
  const q = query.trim();
  if (!q || !value) return <>{value}</>;

  // Try matchers in priority order. First hit wins — this guarantees we
  // highlight the most precise span (e.g. plain substring before a looser
  // digits-only / alnum-only match).
  const range =
    findNormalizedRange(value, q, normLower) ||
    (normDigits(q).length > 0
      ? findNormalizedRange(value, q, normDigits)
      : null) ||
    (normAlnumLower(q).length >= 3
      ? findNormalizedRange(value, q, normAlnumLower)
      : null);

  if (!range) return <>{value}</>;
  const [start, end] = range;
  return (
    <>
      {start > 0 && <span>{value.slice(0, start)}</span>}
      <mark className="bg-warning/30 text-foreground rounded px-0.5 py-0 font-semibold">
        {value.slice(start, end)}
      </mark>
      {end < value.length && <span>{value.slice(end)}</span>}
    </>
  );
}

export function AgentTenantsSheet({ open, onOpenChange, initialView, initialPipelineTab, initialHighlightId, initialProfileTenantId }: AgentTenantsSheetProps) {
  const { user } = useAuth();
  const { toast } = useToast();
  const [view, setView] = useState<'tenants' | 'pipeline'>(initialView ?? 'tenants');
  // When the sheet is (re)opened with a requested initial view (e.g. straight
  // to "Submissions" after registering a landlord), honour it each time.
  useEffect(() => {
    if (open && initialView) setView(initialView);
  }, [open, initialView]);
  // When the sheet is opened by tapping a specific tenant, jump straight to
  // that tenant's profile so the agent sees their payments + outstanding.
  useEffect(() => {
    if (open && initialProfileTenantId) setProfileTenantId(initialProfileTenantId);
  }, [open, initialProfileTenantId]);
  const [applyAdvanceOpen, setApplyAdvanceOpen] = useState(false);
  const { limit: advanceLimit, loading: advanceLoading } = useCreditAccessLimit(user?.id);
  const allocatedTotal = Math.max(0, Math.round((advanceLimit.bonusFromAgentAllocations || 0) / 2));
  const bonusFromAlloc = advanceLimit.bonusFromAgentAllocations || 0;
  const MAX_CAP = 30_000_000;
  const capProgress = Math.min(100, (advanceLimit.totalLimit / MAX_CAP) * 100);
  // Track increases to the borrow limit so we can flash a "+UGX X added"
  // badge over the hero card the instant an allocation lands.
  const prevLimitRef = useRef<number | null>(null);
  const [limitBump, setLimitBump] = useState<{ amount: number; id: number; prev: number; next: number } | null>(null);
  useEffect(() => {
    const current = advanceLimit.totalLimit || 0;
    const prev = prevLimitRef.current;
    if (prev !== null && current > prev) {
      const delta = current - prev;
      const refId = `WID-${Date.now().toString(36).toUpperCase()}`;
      setLimitBump({ amount: delta, id: Date.now(), prev, next: current });
      sonnerToast.success(
        `You unlocked ${formatCreditAmount(delta)} extra credit`,
        { description: `Ref: ${refId}`, duration: 5000 }
      );
      const t = setTimeout(() => setLimitBump(null), 7000);
      prevLimitRef.current = current;
      return () => clearTimeout(t);
    }
    prevLimitRef.current = current;
  }, [advanceLimit.totalLimit]);
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [loading, setLoading] = useState(false);
  const fetchTenantsSeqRef = useRef(0);
  const [search, setSearch] = useState(() => loadPrefs().search ?? '');
  // Defer the search query so filtering / highlighting follow the input
  // smoothly while the user is still typing — React keeps the input
  // responsive and only re-runs the heavy filter on the latest value.
  const deferredSearch = useDeferredValue(search);
  const isSearchPending = deferredSearch !== search;
  const [expandedTenantId, setExpandedTenantId] = useState<string | null>(null);
  const [tenantRequests, setTenantRequests] = useState<Record<string, TenantRentRequest[]>>({});
  const [loadingRequests, setLoadingRequests] = useState<string | null>(null);
  const [activeFilter, setActiveFilter] = useState<FilterTab>(() => loadPrefs().activeFilter ?? 'owing');
  // Lifecycle quick filter — narrows the visible tenants by the stage of
  // their rent requests (active = currently repaying, pending = awaiting
  // disbursement, settled = fully completed with no balance).
  const [lifecycleFilter, setLifecycleFilter] = useState<LifecycleFilter>(() => loadPrefs().lifecycleFilter ?? 'any');
  const [riskFilter, setRiskFilter] = useState<RiskFilter>(() => loadPrefs().riskFilter ?? 'all');
  const [sortKey, setSortKey] = useState<SortKey>(() => loadPrefs().sortKey ?? 'balance');
  const [sortDir, setSortDir] = useState<SortDir>(() => loadPrefs().sortDir ?? 'desc');
  const [propertyFilter, setPropertyFilter] = useState<string>(() => loadPrefs().propertyFilter ?? 'all');
  const [tenantBalances, setTenantBalances] = useState<Record<string, number>>({});
  const [tenantDaily, setTenantDaily] = useState<Record<string, number>>({});
  const [tenantTotals, setTenantTotals] = useState<Record<string, { total: number; paid: number }>>({});
  const [tenantStatuses, setTenantStatuses] = useState<Record<string, Set<string>>>({});
  const [tenantLastPaid, setTenantLastPaid] = useState<Record<string, { date: string; amount: number }>>({});
  // Today-only repayments cache (created_at within today, by this agent's tenants)
  // Used to power the "Today's Collection" status strip at the top of the sheet.
  const [todayRepayments, setTodayRepayments] = useState<Array<{ tenant_id: string; amount: number; created_at: string }>>([]);
  // Per-tenant context for richer search/filter (latest landlord & address)
  const [tenantContext, setTenantContext] = useState<Record<string, { landlordName: string; propertyAddress: string; completedCount: number; totalRequests: number }>>({});
  const [propertyLocations, setPropertyLocations] = useState<Record<string, { lat: number; lng: number; address: string }>>({});
  const [renewDialogOpen, setRenewDialogOpen] = useState(false);
  const [renewPrefill, setRenewPrefill] = useState<{ name: string; phone: string; amount: string } | null>(null);
  const [renewingReqId, setRenewingReqId] = useState<string | null>(null);
  const [collectDialogOpen, setCollectDialogOpen] = useState(false);
  const [collectTarget, setCollectTarget] = useState<{ tenant: Tenant; reqId: string; owing: number } | null>(null);
  const [fieldCollectTarget, setFieldCollectTarget] = useState<Tenant | null>(null);
  const [notFundedTarget, setNotFundedTarget] = useState<{ tenantName: string; reqId: string } | null>(null);
  const [behaviorCardOpen, setBehaviorCardOpen] = useState(false);
  const [behaviorData, setBehaviorData] = useState<any>(null);
  const [profileTenantId, setProfileTenantId] = useState<string | null>(null);
  const [profileAutoEdit, setProfileAutoEdit] = useState(false);
  const [showMoreFilters, setShowMoreFilters] = useState(false);
  const [propertyPickerOpen, setPropertyPickerOpen] = useState(false);
  const [recentProperties, setRecentProperties] = useState<string[]>(() => loadRecentProperties());
  const [groupByProperty, setGroupByProperty] = useState<boolean>(() => loadPrefs().groupByProperty ?? false);
  // Simple Mode — strips the page down to large photo-first tenant cards with
  // one big "Collect" + "Call" action each. Built for agents who don't like
  // reading, don't notice fine detail, and use cheap phones. Persisted.
  const [simpleMode, setSimpleMode] = useState<boolean>(() => loadPrefs().simpleMode ?? true);
  // Simple Mode language toggle (English ⇄ Luganda). Persisted.
  const [simpleLang, setSimpleLang] = useState<SimpleLang>(() => loadPrefs().simpleLang ?? 'en');
  // Simple Mode bulk collect — let an agent tick several tenants and record a
  // full-balance cash collection for all of them in one tap. Queues offline
  // (same store as the per-tenant Collect flow). Picture-first, no reading.
  const [bulkSelectMode, setBulkSelectMode] = useState(false);
  const [bulkSelected, setBulkSelected] = useState<Set<string>>(new Set());
  const [bulkConfirmOpen, setBulkConfirmOpen] = useState(false);
  const [bulkSaving, setBulkSaving] = useState(false);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [mapMode, setMapMode] = useState(false);
  const [receiptLoadingId, setReceiptLoadingId] = useState<string | null>(null);
  // "Recent collection" filter — limit to tenants with last cash-in within N days.
  // 'all' = no filter, 'never' = no collections at all, otherwise a window in days.
  const [recentCollectionFilter, setRecentCollectionFilter] = useState<RecentCollectionFilter>(
    () => loadPrefs().recentCollectionFilter ?? 'all',
  );
  const [showBalanceBreakdown, setShowBalanceBreakdown] = useState(false);
  const tenantListRef = useRef<HTMLDivElement>(null);

  // ───── Saved filter presets ─────
  const [presets, setPresets] = useState<SheetPreset[]>(() => loadPresets());
  const [savePresetOpen, setSavePresetOpen] = useState(false);
  const [presetName, setPresetName] = useState('');

  const applyPreset = useCallback((p: SheetPreset) => {
    setSearch(p.search ?? '');
    setActiveFilter(p.activeFilter ?? 'owing');
    setLifecycleFilter(p.lifecycleFilter ?? 'any');
    setRiskFilter(p.riskFilter ?? 'all');
    setPropertyFilter(p.propertyFilter ?? 'all');
    setSortKey(p.sortKey ?? 'balance');
    setSortDir(p.sortDir ?? 'desc');
    setRecentCollectionFilter(p.recentCollectionFilter ?? 'all');
    setGroupByProperty(!!p.groupByProperty);
    sonnerToast.success(`Showing "${p.name}"`);
  }, []);

  const handleSavePreset = useCallback(() => {
    const name = presetName.trim();
    if (!name) return;
    const snapshot: SheetPreset = {
      id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      name,
      search,
      activeFilter,
      lifecycleFilter,
      riskFilter,
      propertyFilter,
      sortKey,
      sortDir,
      recentCollectionFilter,
      groupByProperty,
    };
    setPresets(prev => {
      // Replace an existing preset with the same (case-insensitive) name so
      // re-saving "My usual" just updates it instead of duplicating.
      const next = [...prev.filter(p => p.name.toLowerCase() !== name.toLowerCase()), snapshot];
      savePresets(next);
      return next;
    });
    setPresetName('');
    setSavePresetOpen(false);
    sonnerToast.success(`Saved "${name}"`);
  }, [presetName, search, activeFilter, lifecycleFilter, riskFilter, propertyFilter, sortKey, sortDir, recentCollectionFilter, groupByProperty]);

  const deletePreset = useCallback((id: string) => {
    setPresets(prev => {
      const next = prev.filter(p => p.id !== id);
      savePresets(next);
      return next;
    });
  }, []);

  const handleResetDefaults = useCallback(() => {
    setSearch('');
    setActiveFilter('owing');
    setLifecycleFilter('any');
    setRiskFilter('all');
    setPropertyFilter('all');
    setSortKey('balance');
    setSortDir('desc');
    setRecentCollectionFilter('all');
    setGroupByProperty(false);
    setSimpleMode(true);
    setSimpleLang('en');
    setExpandedTenantId(null);
    exitBulkSelect();
    try {
      window.localStorage.removeItem(PREFS_KEY);
    } catch { /* ignore */ }
    sonnerToast.success('Reset to defaults');
  }, []);

  // Push a property to the front of the MRU list and persist (deduped, capped).
  const recordRecentProperty = useCallback((address: string) => {
    if (!address || address === 'all') return;
    setRecentProperties(prev => {
      const next = [address, ...prev.filter(p => p !== address)].slice(0, MAX_RECENT_PROPERTIES);
      try {
        window.localStorage.setItem(RECENT_PROPERTIES_KEY, JSON.stringify(next));
      } catch { /* ignore */ }
      return next;
    });
  }, []);
  const toggleGroup = (key: string) => {
    setCollapsedGroups(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  // Fetch the latest rent_request for a tenant — used to build the most recent
  // repayment receipt for the "Last collected" pill quick actions.
  const fetchLatestRentStatement = useCallback(async (tenant: Tenant) => {
    const { data, error } = await supabase
      .from('rent_requests')
        .select('id, rent_amount, total_repayment, amount_repaid, daily_repayment, duration_days, status, created_at, registration_type, initial_outstanding_balance, outstanding_grace_days, landlord:landlords(name, property_address)')
      .eq('tenant_id', tenant.id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error || !data) return null;
    const req: any = data;
    return {
      tenantName: tenant.full_name,
      tenantPhone: tenant.phone,
      landlordName: req.landlord?.name || 'N/A',
      propertyAddress: req.landlord?.property_address,
      rentAmount: Number(req.rent_amount || 0),
      totalRepayment: getEffectiveRentRequestAmounts(req).totalRepayment,
      amountRepaid: Number(req.amount_repaid || 0),
      dailyRepayment: getEffectiveRentRequestAmounts(req).dailyRepayment,
      durationDays: Number(req.duration_days || 0),
      status: req.status || 'approved',
      createdAt: req.created_at,
      requestId: req.id,
    };
  }, []);

  const handleDownloadLastReceipt = async (tenant: Tenant) => {
    setReceiptLoadingId(tenant.id);
    try {
      const data = await fetchLatestRentStatement(tenant);
      if (!data) {
        toast({ title: 'No receipt available', description: 'No rent plan found for this tenant.', variant: 'destructive' });
        return;
      }
      await downloadRentStatement(data);
    } catch (e: any) {
      toast({ title: 'Failed to open receipt', description: e?.message || 'Try again.', variant: 'destructive' });
    } finally {
      setReceiptLoadingId(null);
    }
  };

  // Build & share a simple daily allocation report (one row per tenant) the
  // agent can forward to a manager or supporter. Uses the native share sheet
  // and falls back to a plain download.
  const [reportSharing, setReportSharing] = useState(false);
  const handleShareAllocationReport = async () => {
    setReportSharing(true);
    try {
      const rows: AllocationRow[] = processedTenants.map((t) => {
        const totals = tenantTotals[t.id];
        const outstanding = totals
          ? Math.max(0, totals.total - totals.paid)
          : (tenantBalances[t.id] || 0);
        return {
          name: t.full_name?.trim() || 'Tenant',
          property: tenantContext[t.id]?.propertyAddress || '',
          daily: outstanding > 0 ? (tenantDaily[t.id] || 0) : 0,
          outstanding,
          paid: totals?.paid || 0,
        };
      });
      if (rows.length === 0) {
        toast({ title: 'Nothing to report', description: 'No tenants are showing with the current filters.' });
        return;
      }
      const result = await shareDailyAllocationPdf({
        agentName: (user?.user_metadata as any)?.full_name || user?.email || undefined,
        agentPhone: (user?.user_metadata as any)?.phone || undefined,
        rows,
        collectedToday: todayStats.collectedAmount,
        tenantsCollectedToday: todayStats.tenantsCollected,
      });
      toast({
        title: result === 'shared' ? 'Report ready to share ✅' : 'Report downloaded ✅',
        description: result === 'shared'
          ? 'Send it to your manager or supporter.'
          : 'Saved as a PDF you can forward.',
      });
    } catch (e: any) {
      toast({ title: 'Could not create report', description: e?.message || 'Try again.', variant: 'destructive' });
    } finally {
      setReportSharing(false);
    }
  };

  const handleShareLastReceiptWhatsApp = async (tenant: Tenant) => {
    setReceiptLoadingId(tenant.id);
    try {
      const data = await fetchLatestRentStatement(tenant);
      if (!data) {
        toast({ title: 'No receipt available', description: 'No rent plan found for this tenant.', variant: 'destructive' });
        return;
      }
      const text = buildRentStatementWhatsApp(data);
      const phone = (tenant.phone || '').replace(/\D/g, '');
      const url = phone
        ? `https://wa.me/${phone}?text=${encodeURIComponent(text)}`
        : `https://wa.me/?text=${encodeURIComponent(text)}`;
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch (e: any) {
      toast({ title: 'Failed to share', description: e?.message || 'Try again.', variant: 'destructive' });
    } finally {
      setReceiptLoadingId(null);
    }
  };

  useEffect(() => {
    if (open && user) fetchTenants();
    if (!open) { setExpandedTenantId(null); setProfileTenantId(null); setProfileAutoEdit(false); }
  }, [open, user]);

  // Persist search / status tab / risk chip / property / sort / recent / grouping
  // across sheet open-close, navigation, and reloads
  useEffect(() => {
    try {
      window.localStorage.setItem(
        PREFS_KEY,
        JSON.stringify({
          search,
          activeFilter,
          riskFilter,
          propertyFilter,
          sortKey,
          sortDir,
          recentCollectionFilter,
          groupByProperty,
          lifecycleFilter,
          simpleMode,
          simpleLang,
        } satisfies SheetPrefs),
      );
    } catch {
      /* storage unavailable — ignore */
    }
  }, [search, activeFilter, riskFilter, propertyFilter, sortKey, sortDir, recentCollectionFilter, groupByProperty, lifecycleFilter, simpleMode, simpleLang]);

  const fetchTenants = async () => {
    if (!user) return;
    const seq = ++fetchTenantsSeqRef.current;
    setLoading(true);
    try {
      const { data, error } = await supabase.rpc('get_agent_tenants_overview', {
        p_today_start: startOfDay(new Date()).toISOString(),
      });
      if (error) throw error;
      if (seq !== fetchTenantsSeqRef.current) return;

      const rows = (data || []) as any[];
      const tenantList: Tenant[] = rows.map((row) => ({
        id: row.id,
        full_name: row.full_name || 'Tenant',
        phone: row.phone || '',
        email: row.email || '',
        created_at: row.created_at,
        monthly_rent: row.monthly_rent ?? null,
        verified: Boolean(row.verified),
      }));
      setTenants(tenantList);

      const balances: Record<string, number> = {};
      const daily: Record<string, number> = {};
      const totals: Record<string, { total: number; paid: number }> = {};
      const statusMap: Record<string, Set<string>> = {};
      const ctx: Record<string, { landlordName: string; propertyAddress: string; completedCount: number; totalRequests: number }> = {};
      const locs: Record<string, { lat: number; lng: number; address: string }> = {};
      const lastPaid: Record<string, { date: string; amount: number }> = {};
      const todays: Array<{ tenant_id: string; amount: number; created_at: string }> = [];

      rows.forEach((row) => {
        balances[row.id] = Number(row.balance || 0);
        daily[row.id] = Number(row.daily || 0);
        totals[row.id] = {
          total: Number(row.total_repayment || 0),
          paid: Number(row.amount_repaid || 0),
        };
        statusMap[row.id] = new Set((row.statuses || []).filter(Boolean));
        ctx[row.id] = {
          landlordName: row.landlord_name || '',
          propertyAddress: row.property_address || '',
          completedCount: Number(row.completed_count || 0),
          totalRequests: Number(row.request_count || 0),
        };
        const addr = String(row.property_address || '').trim();
        const lat = Number(row.latitude);
        const lng = Number(row.longitude);
        if (addr && Number.isFinite(lat) && Number.isFinite(lng) && lat !== 0 && lng !== 0 && !locs[addr]) {
          locs[addr] = { lat, lng, address: addr };
        }
        if (row.last_paid_at) {
          lastPaid[row.id] = { date: row.last_paid_at, amount: Number(row.last_paid_amount || 0) };
        }
        const todayAmount = Number(row.today_paid_amount || 0);
        if (todayAmount > 0) {
          todays.push({ tenant_id: row.id, amount: todayAmount, created_at: new Date().toISOString() });
        }
      });

      setTenantBalances(balances);
      setTenantDaily(daily);
      setTenantTotals(totals);
      setTenantStatuses(statusMap);
      setTenantContext(ctx);
      setPropertyLocations(locs);
      setTenantLastPaid(lastPaid);
      setTodayRepayments(todays);
    } catch (err) {
      console.error('Failed to fetch tenants:', err);
    } finally {
      if (seq === fetchTenantsSeqRef.current) setLoading(false);
    }
  };

  const fetchTenantRequests = useCallback(async (tenantId: string) => {
    if (tenantRequests[tenantId]) return tenantRequests[tenantId];
    setLoadingRequests(tenantId);
    try {
      const { data, error } = await supabase
        .from('rent_requests')
        .select('id, rent_amount, total_repayment, duration_days, daily_repayment, amount_repaid, status, created_at, disbursed_at, registration_type, initial_outstanding_balance, outstanding_grace_days, landlord_id, lc1_id, house_category, tenant_no_smartphone, request_latitude, request_longitude, landlord:landlords(name, property_address, house_category, latitude, longitude)')
        .eq('tenant_id', tenantId)
        .or(TENANT_DETAIL_REQUEST_FILTER)
        .order('created_at', { ascending: false })
        .limit(5);

      if (error) throw error;
      const normalized = ((data as unknown as TenantRentRequest[]) || []).map((req) => {
        const effective = getEffectiveRentRequestAmounts(req);
        return {
          ...req,
          total_repayment: effective.totalRepayment,
          daily_repayment: effective.dailyRepayment,
        };
      });
      setTenantRequests(prev => ({ ...prev, [tenantId]: normalized }));
      return normalized;
    } catch (err) {
      console.error('Failed to fetch tenant requests:', err);
      return undefined;
    } finally {
      setLoadingRequests(null);
    }
  }, [tenantRequests]);

  const toggleExpand = (tenantId: string) => {
    if (expandedTenantId === tenantId) {
      setExpandedTenantId(null);
    } else {
      setExpandedTenantId(tenantId);
      fetchTenantRequests(tenantId);
    }
  };

  // Per-tenant derived risk + AI ID (used by search, filter, and row chip)
  const tenantMeta = useMemo(() => {
    const map: Record<string, {
      aiId: string;
      riskLevel: 'good' | 'standard' | 'caution' | 'new';
      riskLabel: string;
      riskColor: string;
      completionRate: number;
      completedCount: number;
      totalRequests: number;
    }> = {};
    tenants.forEach(t => {
      const ctx = tenantContext[t.id];
      const completionRate = ctx && ctx.totalRequests > 0
        ? Math.round((ctx.completedCount / ctx.totalRequests) * 100)
        : 0;
      const totalRequests = ctx?.totalRequests || 0;
      const riskLevel: 'good' | 'standard' | 'caution' | 'new' =
        totalRequests === 0 ? 'new'
        : completionRate >= 80 ? 'good'
        : completionRate >= 50 ? 'standard'
        : 'caution';
      const tier = getRiskTierLabel(riskLevel);
      map[t.id] = {
        aiId: generateWelileAiId(t.id),
        riskLevel,
        riskLabel: tier.label,
        riskColor: tier.color,
        completionRate,
        completedCount: ctx?.completedCount || 0,
        totalRequests,
      };
    });
    return map;
  }, [tenants, tenantContext]);

  // Filtered & sorted tenants — always sorted by highest debt
  const processedTenants = useMemo(() => {
    const raw = deferredSearch.trim();
    const q = raw.toLowerCase();
    // Strip everything except digits so "+256 772 123 456", "0772-123-456"
    // and "772123456" all match the same tenant. Empty when the query has
    // no digits at all.
    const qDigits = raw.replace(/\D+/g, '');
    // Normalized reference-ID query — Welile AI IDs are stored uppercase
    // and may contain dashes (e.g. "WID-AB12-9X"). Allow agents to type
    // the ID with or without dashes / casing.
    const qRef = q.replace(/[\s-]+/g, '');
    let list = tenants.filter(t => {
      if (!q) return true;
      const ctx = tenantContext[t.id];
      const meta = tenantMeta[t.id];
      const phoneDigits = (t.phone || '').replace(/\D+/g, '');
      const aiId = (meta?.aiId || '').toLowerCase();
      const aiIdCompact = aiId.replace(/[\s-]+/g, '');
      // Text matches
      if (
        t.full_name.toLowerCase().includes(q) ||
        (ctx?.landlordName || '').toLowerCase().includes(q) ||
        (ctx?.propertyAddress || '').toLowerCase().includes(q) ||
        aiId.includes(q) ||
        aiIdCompact.includes(qRef)
      ) return true;
      // Digit-only matches: substring against the normalized phone, and
      // last-4 / last-N convenience matching for short queries.
      if (qDigits.length > 0 && phoneDigits.includes(qDigits)) return true;
      // Tenant UUID prefix (lets agents paste a reference ID from another
      // screen and still resolve the tenant).
      if (qRef.length >= 4 && t.id.toLowerCase().replace(/-/g, '').startsWith(qRef)) return true;
      return false;
    });

    switch (activeFilter) {
      case 'owing':
        list = list.filter(t => (tenantBalances[t.id] || 0) > 0);
        break;
      case 'paid-up':
        list = list.filter(t => {
          const s = tenantStatuses[t.id];
          if (!s || s.size === 0) return false;
          if ((tenantBalances[t.id] || 0) !== 0) return false;
          return s.has('funded') || s.has('disbursed') || s.has('repaying') || s.has('completed');
        });
        break;
      case 'all':
        break;
    }

    if (riskFilter !== 'all') {
      list = list.filter(t => tenantMeta[t.id]?.riskLevel === riskFilter);
    }
    if (propertyFilter !== 'all') {
      list = list.filter(t => (tenantContext[t.id]?.propertyAddress || '') === propertyFilter);
    }
    if (lifecycleFilter !== 'any') {
      list = list.filter(t => {
        const statuses = tenantStatuses[t.id] ?? new Set<string>();
        const balance = tenantBalances[t.id] || 0;
        // `funded` = company money already left (landlord settled), so the
        // tenant is collectible — same law as COLLECTIBLE_STATUSES / the
        // Priority Collection Queue. Only pre-funding stages are "pending".
        const isActive =
          statuses.has('funded') || statuses.has('disbursed') || statuses.has('repaying');
        const isPending = !isActive && (statuses.has('pending') || statuses.has('approved'));
        const isSettled = !isActive && !isPending && statuses.has('completed') && balance === 0;
        if (lifecycleFilter === 'active') return isActive;
        if (lifecycleFilter === 'pending') return isPending;
        if (lifecycleFilter === 'settled') return isSettled;
        return true;
      });
    }
    if (recentCollectionFilter !== 'all') {
      if (recentCollectionFilter === 'never') {
        list = list.filter(t => !tenantLastPaid[t.id]?.date);
      } else {
        const days = parseInt(recentCollectionFilter, 10);
        const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
        list = list.filter(t => {
          const d = tenantLastPaid[t.id]?.date;
          return d ? new Date(d).getTime() >= cutoff : false;
        });
      }
    }

    const dir = sortDir === 'asc' ? 1 : -1;
    list.sort((a, b) => {
      let cmp = 0;
      switch (sortKey) {
        case 'risk': {
          const ra = RISK_ORDER[tenantMeta[a.id]?.riskLevel ?? 'new'];
          const rb = RISK_ORDER[tenantMeta[b.id]?.riskLevel ?? 'new'];
          cmp = ra - rb;
          break;
        }
        case 'aiId': {
          cmp = (tenantMeta[a.id]?.aiId ?? '').localeCompare(tenantMeta[b.id]?.aiId ?? '');
          break;
        }
        case 'property': {
          const pa = (tenantContext[a.id]?.propertyAddress ?? '').toLowerCase();
          const pb = (tenantContext[b.id]?.propertyAddress ?? '').toLowerCase();
          // Push empty addresses to the bottom regardless of direction
          if (!pa && pb) return 1;
          if (pa && !pb) return -1;
          cmp = pa.localeCompare(pb);
          break;
        }
        case 'property-daily':
        case 'property-balance': {
          const pa = (tenantContext[a.id]?.propertyAddress ?? '').toLowerCase();
          const pb = (tenantContext[b.id]?.propertyAddress ?? '').toLowerCase();
          if (!pa && pb) return 1;
          if (pa && !pb) return -1;
          const pcmp = pa.localeCompare(pb);
          if (pcmp !== 0) return pcmp; // property always ascending
          const va = sortKey === 'property-daily' ? (tenantDaily[a.id] || 0) : (tenantBalances[a.id] || 0);
          const vb = sortKey === 'property-daily' ? (tenantDaily[b.id] || 0) : (tenantBalances[b.id] || 0);
          cmp = va - vb;
          break;
        }
        case 'balance':
        default: {
          cmp = (tenantBalances[a.id] || 0) - (tenantBalances[b.id] || 0);
          break;
        }
        case 'daily': {
          cmp = (tenantDaily[a.id] || 0) - (tenantDaily[b.id] || 0);
          break;
        }
        case 'lastCollected': {
          const ta = tenantLastPaid[a.id]?.date ? new Date(tenantLastPaid[a.id].date).getTime() : 0;
          const tb = tenantLastPaid[b.id]?.date ? new Date(tenantLastPaid[b.id].date).getTime() : 0;
          // Push tenants with no collection to the bottom regardless of direction
          if (!ta && tb) return 1;
          if (ta && !tb) return -1;
          cmp = ta - tb;
          break;
        }
        case 'recent': {
          const ta = a.created_at ? new Date(a.created_at).getTime() : 0;
          const tb = b.created_at ? new Date(b.created_at).getTime() : 0;
          cmp = ta - tb;
          break;
        }
        case 'name': {
          cmp = (a.full_name || '').localeCompare(b.full_name || '');
          break;
        }
      }
      if (cmp === 0) {
        // Stable tiebreaker: name asc
        cmp = a.full_name.localeCompare(b.full_name);
        return cmp;
      }
      return cmp * dir;
    });
    return list;
  }, [tenants, deferredSearch, activeFilter, riskFilter, sortKey, sortDir, tenantBalances, tenantDaily, tenantStatuses, tenantContext, tenantMeta, tenantLastPaid, recentCollectionFilter, propertyFilter, lifecycleFilter]);

  const propertyOptions = useMemo(() => {
    const counts = new Map<string, number>();
    Object.values(tenantContext).forEach(c => {
      const addr = c?.propertyAddress?.trim();
      if (addr) counts.set(addr, (counts.get(addr) || 0) + 1);
    });
    return Array.from(counts.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([address, count]) => ({ address, count }));
  }, [tenantContext]);

  // Stats
  const stats = useMemo(() => {
    const totalOwing = Object.values(tenantBalances).reduce((s, v) => s + v, 0);
    const owingCount = Object.values(tenantBalances).filter(v => v > 0).length;
    const paidUpCount = tenants.filter(t => {
      const s = tenantStatuses[t.id];
      if (!s || s.size === 0) return false;
      if ((tenantBalances[t.id] || 0) !== 0) return false;
      // Only tenants who actually had a funded plan can be "paid up".
      return s.has('funded') || s.has('disbursed') || s.has('repaying') || s.has('completed');
    }).length;
    const dailyExpectation = Object.entries(tenantDaily).reduce((s, [tid, v]) => {
      return s + ((tenantBalances[tid] || 0) > 0 ? (v || 0) : 0);
    }, 0);
    return { totalOwing, owingCount, paidUpCount, total: tenants.length, dailyExpectation };
  }, [tenants, tenantBalances, tenantStatuses, tenantDaily]);

  // ───── Today's collection status ─────
  // Drives the live header strip on My Tenants. All figures are scoped to
  // today (since 00:00 local time) and to this agent's tenant allowlist.
  const todayStats = useMemo(() => {
    const collectedAmount = todayRepayments.reduce((s, r) => s + (r.amount || 0), 0);
    const tenantsCollected = new Set(todayRepayments.map((r) => r.tenant_id)).size;
    const tenantsOwing = stats.owingCount;
    const expected = stats.dailyExpectation;
    const rate = expected > 0 ? Math.min(100, Math.round((collectedAmount / expected) * 100)) : 0;
    return { collectedAmount, tenantsCollected, tenantsOwing, expected, rate };
  }, [todayRepayments, stats.owingCount, stats.dailyExpectation]);

  const filterTabs: { key: FilterTab; label: string; count: number }[] = [
    { key: 'owing', label: 'Owing', count: stats.owingCount },
    { key: 'paid-up', label: 'Paid up', count: stats.paidUpCount },
    { key: 'all', label: 'All', count: stats.total },
  ];

  // Counts for the lifecycle quick filters. Computed across the full tenant
  // list (independent of search) so the chip badges reflect the agent's
  // overall pipeline rather than the current query result.
  const lifecycleCounts = useMemo(() => {
    let active = 0, pending = 0, settled = 0;
    for (const t of tenants) {
      const statuses = tenantStatuses[t.id] ?? new Set<string>();
      const balance = tenantBalances[t.id] || 0;
      const isActive =
        statuses.has('funded') || statuses.has('disbursed') || statuses.has('repaying');
      const isPending = !isActive && (statuses.has('pending') || statuses.has('approved'));
      const isSettled = !isActive && !isPending && statuses.has('completed') && balance === 0;
      if (isActive) active++;
      else if (isPending) pending++;
      else if (isSettled) settled++;
    }
    return { active, pending, settled };
  }, [tenants, tenantStatuses, tenantBalances]);

  const lifecycleTabs: { key: LifecycleFilter; label: string; count?: number }[] = [
    { key: 'any', label: 'Any' },
    { key: 'active', label: 'Active', count: lifecycleCounts.active },
    { key: 'pending', label: 'Pending', count: lifecycleCounts.pending },
    { key: 'settled', label: 'Settled', count: lifecycleCounts.settled },
  ];

  // ───── Handlers ─────
  const handleDownloadPdf = async (tenant: Tenant, req: TenantRentRequest) => {
    try {
      const scheduleDays = [];
      const start = startOfDay(new Date(req.disbursed_at || req.created_at));
      for (let i = 0; i < req.duration_days; i++) {
        const d = new Date(start);
        d.setDate(d.getDate() + i);
        scheduleDays.push({ date: format(d, 'yyyy-MM-dd'), amount: req.daily_repayment, status: 'pending' as const });
      }
      await downloadRepaymentPdf({
        tenantName: tenant.full_name, phone: tenant.phone,
        landlordName: req.landlord?.name || 'N/A', propertyAddress: req.landlord?.property_address || 'N/A',
        rentAmount: req.rent_amount, totalRepayment: req.total_repayment,
        dailyRepayment: req.daily_repayment, durationDays: req.duration_days,
        status: req.status || 'approved', paidAmount: req.amount_repaid,
        startDate: format(new Date(req.disbursed_at || req.created_at), 'dd MMM yyyy'), schedule: scheduleDays,
      });
    } catch { toast({ title: 'Error generating PDF', variant: 'destructive' }); }
  };

  const handleShareWhatsApp = async (tenant: Tenant, req: TenantRentRequest) => {
    try {
      const scheduleDays = [];
      const start = startOfDay(new Date(req.disbursed_at || req.created_at));
      for (let i = 0; i < req.duration_days; i++) {
        const d = new Date(start);
        d.setDate(d.getDate() + i);
        scheduleDays.push({ date: format(d, 'yyyy-MM-dd'), amount: req.daily_repayment, status: 'pending' as const });
      }
      await shareRepaymentPdfWhatsApp({
        tenantName: tenant.full_name, phone: tenant.phone,
        landlordName: req.landlord?.name || 'N/A', propertyAddress: req.landlord?.property_address || 'N/A',
        rentAmount: req.rent_amount, totalRepayment: req.total_repayment,
        dailyRepayment: req.daily_repayment, durationDays: req.duration_days,
        status: req.status || 'approved', paidAmount: req.amount_repaid,
        startDate: format(new Date(req.disbursed_at || req.created_at), 'dd MMM yyyy'), schedule: scheduleDays,
      }, tenant.phone);
    } catch { toast({ title: 'Error sharing', variant: 'destructive' }); }
  };

  // One-tap renew: re-post a rent request using the data from a completed cycle.
  // No new info is requested — landlord, tenant, house category etc. are reused.
  const handleRenew = async (tenant: Tenant, req: TenantRentRequest) => {
    if (!user) return;
    if (!req.landlord_id) {
      toast({ title: 'Cannot renew', description: 'Landlord info missing on prior request.', variant: 'destructive' });
      return;
    }
    setRenewingReqId(req.id);
    try {
      const fees = calculateRentRepayment(req.rent_amount, req.duration_days);
      const { error } = await supabase.from('rent_requests').insert({
        tenant_id: tenant.id,
        agent_id: user.id,
        landlord_id: req.landlord_id,
        lc1_id: req.lc1_id ?? null,
        rent_amount: fees.rentAmount,
        duration_days: fees.durationDays,
        access_fee: fees.accessFee,
        request_fee: fees.requestFee,
        total_repayment: fees.totalRepayment,
        daily_repayment: fees.dailyRepayment,
        status: 'pending',
        registration_type: 'renewal',
        house_category: req.house_category ?? req.landlord?.house_category ?? null,
        tenant_no_smartphone: req.tenant_no_smartphone ?? false,
        request_latitude: req.request_latitude ?? req.landlord?.latitude ?? null,
        request_longitude: req.request_longitude ?? req.landlord?.longitude ?? null,
      } as any);
      if (error) throw error;
      toast({ title: 'Rent request renewed ✅', description: `Posted for ${tenant.full_name}` });
      // Force-refresh this tenant's requests
      setTenantRequests(prev => {
        const updated = { ...prev };
        delete updated[tenant.id];
        return updated;
      });
      fetchTenantRequests(tenant.id);
      fetchTenants();
    } catch (err: any) {
      console.error('Renew failed:', err);
      toast({ title: 'Renew failed', description: err?.message || 'Try again', variant: 'destructive' });
    } finally {
      setRenewingReqId(null);
    }
  };

  // Top-level "Resubmit" entry point for tenants whose entire history is settled.
  // Looks up (and lazy-loads) the most recent completed rent plan for this
  // tenant, then delegates to handleRenew so the same audited flow is used.
  const handleResubmitTenant = async (tenant: Tenant) => {
    setRenewingReqId(tenant.id); // disable the button while we resolve
    try {
      let reqs = tenantRequests[tenant.id];
      if (!reqs || reqs.length === 0) {
        reqs = (await fetchTenantRequests(tenant.id)) || [];
      }
      const completed = (reqs || [])
        .filter((r) => r.status === 'completed')
        .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0];
      if (!completed) {
        toast({
          title: 'No cleared plan to resubmit',
          description: 'Open the tenant and pick a previous plan, or start a new request.',
          variant: 'destructive',
        });
        setRenewingReqId(null);
        return;
      }
      // handleRenew sets/clears renewingReqId itself based on the request id,
      // so reset our tenant-level guard before delegating.
      setRenewingReqId(null);
      await handleRenew(tenant, completed);
    } catch (err: any) {
      console.error('Resubmit failed:', err);
      toast({ title: 'Resubmit failed', description: err?.message || 'Try again', variant: 'destructive' });
      setRenewingReqId(null);
    }
  };

  /* ── Simple Mode bulk collect helpers ── */
  const toggleBulkSelect = (tenantId: string) => {
    setBulkSelected((prev) => {
      const next = new Set(prev);
      if (next.has(tenantId)) next.delete(tenantId);
      else next.add(tenantId);
      return next;
    });
  };

  const exitBulkSelect = () => {
    setBulkSelectMode(false);
    setBulkSelected(new Set());
  };

  /* Simple Mode label translator (English ⇄ Luganda) */
  const tr = useCallback(
    (key: SimpleTextKey, vars?: Record<string, string | number>) => {
      let out = SIMPLE_TEXT[key][simpleLang];
      if (vars) for (const k of Object.keys(vars)) out = out.replace(`{${k}}`, String(vars[k]));
      return out;
    },
    [simpleLang]
  );

  // Tenants that are selected AND still owe something — only these get a record.
  const bulkPayableTenants = useMemo(
    () => processedTenants.filter((t) => bulkSelected.has(t.id) && (tenantBalances[t.id] || 0) > 0),
    [processedTenants, bulkSelected, tenantBalances]
  );
  const bulkTotal = useMemo(
    () => bulkPayableTenants.reduce((s, t) => s + (tenantBalances[t.id] || 0), 0),
    [bulkPayableTenants, tenantBalances]
  );

  const handleBulkCollect = async () => {
    if (!user?.id || bulkPayableTenants.length === 0) return;
    setBulkSaving(true);
    try {
      const now = Date.now();
      for (const t of bulkPayableTenants) {
        const amt = tenantBalances[t.id] || 0;
        if (amt <= 0) continue;
        const entry: FieldEntry = {
          id: newClientUuid(),
          agentId: user.id,
          tenantId: t.id,
          tenantName: t.full_name || '',
          tenantPhone: t.phone || null,
          amount: amt,
          notes: 'Bulk collect — marked paid',
          capturedAt: now,
          syncState: 'queued',
        };
        await addEntry(entry);
      }
      sonnerToast.success(`Saved ${bulkPayableTenants.length} · ${formatUGX(bulkTotal)}`);
      setBulkConfirmOpen(false);
      exitBulkSelect();
    } catch (e) {
      sonnerToast.error(e instanceof Error ? e.message : 'Failed to save');
    } finally {
      setBulkSaving(false);
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        className={`${view === 'pipeline' && !profileTenantId ? 'h-screen max-h-screen rounded-none' : 'h-[92vh] rounded-t-3xl'} flex flex-col p-0 gap-0 overflow-y-auto`}
      >
        {profileTenantId ? (
          <TenantProfileView
            tenantId={profileTenantId}
            autoEdit={profileAutoEdit}
            onBack={() => { setProfileTenantId(null); setProfileAutoEdit(false); }}
          />
        ) : view === 'pipeline' ? (
          /* Full-screen Submissions takeover — covers the entire screen
             until the agent deliberately taps Back. */
          <div className="flex flex-col h-full bg-background">
            <div className="sticky top-0 z-40 flex items-center justify-between gap-2 px-3 py-2 bg-background/95 backdrop-blur border-b border-border/60">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setView('tenants')}
                className="h-11 px-3 rounded-xl text-base font-semibold gap-1"
                style={{ touchAction: 'manipulation' }}
              >
                <ArrowLeft className="h-5 w-5" />
                Back
              </Button>
              <div className="flex items-center gap-2 text-base font-bold">
                <Users className="h-5 w-5 text-primary" />
                Submissions
              </div>
              <div className="w-[72px]" />
            </div>
            <div className="flex-1 overflow-y-auto px-4 py-3">
              <AgentRequestPipelineView initialTab={initialPipelineTab} highlightId={initialHighlightId} />
            </div>
          </div>
        ) : (
        <>
        {/* ───── Header (scrolls with the rest of the page) ───── */}
        <div className="bg-background/95 border-b border-border/50 px-4 pt-4 pb-3 space-y-3 shrink-0">
          {/* HERO: Welile Agent Advance — live limit + Apply CTA */}
          <div className="relative overflow-hidden rounded-2xl p-4 bg-card text-foreground shadow-xl shadow-purple-900/10 border border-purple-300/50">
            {/* Decorative glow */}
            <div aria-hidden className="pointer-events-none absolute -top-16 -right-16 h-44 w-44 rounded-full bg-fuchsia-400/10 blur-3xl" />
            <div aria-hidden className="pointer-events-none absolute -bottom-20 -left-10 h-40 w-40 rounded-full bg-purple-300/10 blur-3xl" />

            <div className="relative">
              {/* Floating "+UGX X added" badge — appears the instant the
                  borrow limit increases after an allocation. */}
              <AnimatePresence>
                {limitBump && (
                  <motion.div
                    key={limitBump.id}
                    initial={{ opacity: 0, y: 10, scale: 0.85 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: -24, scale: 0.9 }}
                    transition={{ type: 'spring', stiffness: 320, damping: 20 }}
                    className="absolute -top-2 right-0 z-10 inline-flex items-center gap-1 rounded-full bg-emerald-400 text-emerald-950 font-extrabold text-xs px-3 py-1.5 shadow-lg shadow-emerald-900/40 ring-2 ring-white/70"
                  >
                    <TrendingUp className="h-3.5 w-3.5" />
                    + {formatCreditAmount(limitBump.amount)} added
                  </motion.div>
                )}
              </AnimatePresence>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => onOpenChange(false)}
                    className="h-8 px-2 text-xs font-semibold text-foreground hover:bg-muted gap-1"
                    aria-label="Back"
                  >
                    <ArrowLeft className="h-4 w-4" />
                    Back
                  </Button>
                  <div className="h-7 w-7 sm:h-8 sm:w-8 rounded-xl bg-purple-100 flex items-center justify-center ring-1 ring-purple-300">
                    <Sparkles className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
                  </div>
                  <div className="text-[10px] sm:text-[11px] uppercase tracking-[0.18em] font-bold text-purple-800">
                    Welile Agent Advance
                  </div>
                </div>
                <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 ring-1 ring-emerald-300 px-2 py-0.5 text-[9px] sm:text-[10px] font-semibold text-emerald-800">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
                  Live
                </span>
              </div>

              {/* BIG live number */}
              <div className="mt-2.5 sm:mt-3">
                <div className="text-[10px] sm:text-[11px] font-medium text-muted-foreground">
                  Money you can borrow today
                </div>
                <AnimatePresence mode="popLayout" initial={false}>
                  <motion.div
                    key={advanceLimit.totalLimit}
                    initial={{ opacity: 0, y: 8, scale: 0.97 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: -6, scale: 0.98 }}
                    transition={{ type: 'spring', stiffness: 260, damping: 22 }}
                    className="text-3xl sm:text-4xl font-extrabold tracking-tight leading-none mt-1 tabular-nums whitespace-pre-line text-purple-900"
                  >
                    {advanceLoading && !advanceLimit.totalLimit
                      ? '—'
                      : formatCreditAmount(advanceLimit.totalLimit)}
                  </motion.div>
                </AnimatePresence>
                <div className="text-[10px] sm:text-[11px] text-muted-foreground mt-1 leading-snug">
                  Pay 1,000 for a tenant, you can borrow <span className="font-extrabold text-foreground">2,000</span>. Pay more, borrow more.
                </div>
              </div>

              {/* Allocation breakdown — appears right after each allocation
                  with the exact UGX unlocked and the new borrow limit. */}
              <AnimatePresence>
                {limitBump && (
                  <motion.div
                    key={`bd-${limitBump.id}`}
                    initial={{ opacity: 0, y: 8, height: 0 }}
                    animate={{ opacity: 1, y: 0, height: 'auto' }}
                    exit={{ opacity: 0, y: -4, height: 0 }}
                    transition={{ type: 'spring', stiffness: 240, damping: 24 }}
                    className="mt-3 rounded-xl bg-emerald-50/95 text-emerald-950 ring-2 ring-emerald-300 shadow-lg shadow-emerald-900/20 overflow-hidden"
                  >
                    <div className="px-3 py-2.5">
                      <div className="flex items-center gap-1.5 text-[11px] font-extrabold uppercase tracking-wider text-emerald-700">
                        <Sparkles className="h-3.5 w-3.5" />
                        Just unlocked
                      </div>
                      <div className="mt-1 flex items-baseline justify-between gap-2">
                        <div>
                          <div className="text-[10px] font-semibold text-emerald-800/80">You unlocked</div>
                          <div className="text-lg sm:text-xl font-extrabold tabular-nums text-emerald-700">
                            + {formatCreditAmount(limitBump.amount)}
                          </div>
                        </div>
                        <div className="text-right">
                          <div className="text-[10px] font-semibold text-emerald-800/80">New borrow limit</div>
                          <div className="text-lg sm:text-xl font-extrabold tabular-nums text-emerald-900">
                            {formatCreditAmount(limitBump.next)}
                          </div>
                        </div>
                      </div>
                      <div className="mt-1.5 flex items-center gap-1 text-[10px] font-medium text-emerald-800/80 tabular-nums">
                        <span>{formatCreditAmount(limitBump.prev)}</span>
                        <TrendingUp className="h-3 w-3" />
                        <span className="font-bold text-emerald-700">{formatCreditAmount(limitBump.next)}</span>
                      </div>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>

              {/* Progress to cap */}
              <div className="mt-2.5 sm:mt-3">
                <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
                  <motion.div
                    initial={false}
                    animate={{ width: `${capProgress}%` }}
                    transition={{ type: 'spring', stiffness: 120, damping: 22 }}
                    className="h-full bg-gradient-to-r from-amber-500 via-yellow-400 to-emerald-500"
                  />
                </div>
                <div className="flex items-center justify-between mt-1 text-[9px] sm:text-[10px] text-muted-foreground font-medium">
                  <span>Start UGX 30,000</span>
                  <span>Up to UGX 30M</span>
                </div>
              </div>

              {/* Live mini-stats */}
              <div className="mt-2.5 sm:mt-3 grid grid-cols-3 gap-1.5 sm:gap-2 text-center">
                <div className="rounded-lg bg-muted px-1.5 sm:px-2 py-1.5 ring-1 ring-border">
                  <div className="text-[9px] text-muted-foreground font-medium leading-tight">You paid for tenants</div>
                  <div className="text-[10px] sm:text-xs font-bold tabular-nums text-foreground">{formatCreditAmount(allocatedTotal)}</div>
                </div>
                <div className="rounded-lg bg-muted px-1.5 sm:px-2 py-1.5 ring-1 ring-border">
                  <div className="text-[9px] text-muted-foreground font-medium leading-tight">Added to your borrow</div>
                  <div className="text-[10px] sm:text-xs font-bold tabular-nums text-emerald-700">+ {formatCreditAmount(bonusFromAlloc)}</div>
                </div>
                <div className="rounded-lg bg-purple-50 px-1.5 sm:px-2 py-1.5 ring-1 ring-purple-200">
                  <div className="text-[9px] text-purple-700 font-medium leading-tight">Every 1,000</div>
                  <div className="text-[10px] sm:text-xs font-bold text-purple-900">= 2,000</div>
                </div>
              </div>

              {/* CTA */}
              <button
                onClick={() => setApplyAdvanceOpen(true)}
                className="mt-2.5 sm:mt-3 w-full inline-flex items-center justify-center gap-2 rounded-xl bg-purple-700 text-primary-foreground font-bold text-xs sm:text-sm px-4 py-2.5 sm:py-3 shadow-lg shadow-purple-900/20 ring-1 ring-purple-800 hover:bg-purple-800 active:scale-[0.99] transition"
                style={{ touchAction: 'manipulation', minHeight: 44 }}
              >
                <Zap className="h-4 w-4" />
                Get Money Now
              </button>
              <div className="text-[9px] sm:text-[10px] text-muted-foreground text-center mt-1">
                Money goes straight to your wallet. Fast. No long forms.
              </div>
            </div>
          </div>

          <SheetHeader className="pb-0">
            <SheetTitle className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => onOpenChange(false)}
                  className="h-11 px-3 rounded-xl text-base font-semibold gap-1"
                >
                  <ArrowLeft className="h-5 w-5" />
                  Back
                </Button>
                <Users className="h-5 w-5 text-primary" />
                <span className="text-lg font-bold">My Tenants</span>
              </div>
              <div className="flex items-center gap-1.5">
                <Badge variant="outline" className="text-sm font-mono px-2.5 py-0.5">
                  {stats.total}
                </Badge>
                {view === 'tenants' && (
                  <Popover>
                    <PopoverTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-10 w-10 rounded-xl"
                        aria-label="View settings"
                      >
                        <Settings className="h-5 w-5" />
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent align="end" className="w-60 p-3 space-y-3">
                      <div>
                        <p className="text-xs font-semibold text-muted-foreground mb-1.5">View</p>
                        <div className="grid grid-cols-2 gap-2 p-1 rounded-xl bg-muted/50">
                          <button
                            onClick={() => setSimpleMode(true)}
                            className={`py-2 rounded-lg text-sm font-bold transition-all flex items-center justify-center gap-1.5 ${
                              simpleMode ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground'
                            }`}
                            style={{ touchAction: 'manipulation', minHeight: '40px' }}
                            aria-pressed={simpleMode}
                          >
                            <Sparkles className="h-4 w-4" />
                            Simple
                          </button>
                          <button
                            onClick={() => { setSimpleMode(false); exitBulkSelect(); }}
                            className={`py-2 rounded-lg text-sm font-bold transition-all flex items-center justify-center gap-1.5 ${
                              !simpleMode ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground'
                            }`}
                            style={{ touchAction: 'manipulation', minHeight: '40px' }}
                            aria-pressed={!simpleMode}
                          >
                            <SlidersHorizontal className="h-4 w-4" />
                            Detailed
                          </button>
                        </div>
                      </div>
                      {simpleMode && (
                        <div>
                          <p className="text-xs font-semibold text-muted-foreground mb-1.5">Language</p>
                          <div className="grid grid-cols-2 gap-2 p-1 rounded-xl bg-muted/50">
                            {(['en', 'lg'] as SimpleLang[]).map((lng) => (
                              <button
                                key={lng}
                                onClick={() => setSimpleLang(lng)}
                                aria-pressed={simpleLang === lng}
                                className={`py-2 rounded-lg text-sm font-bold transition-colors ${
                                  simpleLang === lng ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground'
                                }`}
                                style={{ minHeight: '40px' }}
                              >
                                {lng === 'en' ? 'English' : 'Luganda'}
                              </button>
                            ))}
                          </div>
                        </div>
                      )}
                      <div className="pt-1 border-t border-border/60">
                        <button
                          onClick={handleResetDefaults}
                          className="w-full flex items-center justify-center gap-2 py-2.5 rounded-lg text-sm font-bold text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors"
                          style={{ touchAction: 'manipulation', minHeight: '40px' }}
                        >
                          <RotateCcw className="h-4 w-4" />
                          Reset to defaults
                        </button>
                      </div>
                    </PopoverContent>
                  </Popover>
                )}
              </div>
            </SheetTitle>
          </SheetHeader>

          {/* Top-level view toggle: live tenants vs request pipeline — sticky on mobile so agents can always switch views */}
          <div className="sticky top-0 z-30 grid grid-cols-2 gap-2 p-1 rounded-xl bg-muted/50 backdrop-blur supports-[backdrop-filter]:bg-muted/60">
            <button
              onClick={() => setView('tenants')}
              className={`py-2 rounded-lg text-sm font-semibold transition-all ${
                view === 'tenants' ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground'
              }`}
              style={{ touchAction: 'manipulation', minHeight: '40px' }}
            >
              Tenants
            </button>
            <button
              onClick={() => setView('pipeline')}
              className="py-2 rounded-lg text-sm font-semibold text-muted-foreground transition-all"
              style={{ touchAction: 'manipulation', minHeight: '40px' }}
            >
              Submissions
            </button>
          </div>

          {view === 'tenants' && (
          <>
          {/* Simple Mode search — one big, obvious box, nothing else. */}
          {simpleMode && (
            <>
              {/* ── Simple Summary: total to collect vs total paid ── */}
              {(() => {
                let totalToCollect = 0;
                let totalPaid = 0;
                processedTenants.forEach((t) => {
                  const totals = tenantTotals[t.id];
                  if (totals) {
                    totalToCollect += Math.max(0, totals.total - totals.paid);
                    totalPaid += totals.paid;
                  }
                });
                return (
                  <div className="grid grid-cols-2 gap-2">
                    <div className="rounded-2xl bg-rose-50 border border-rose-200 p-2.5 sm:p-3 text-center">
                      <p className="text-[9px] sm:text-[10px] uppercase tracking-wide font-bold text-rose-700">{tr('toCollect')}</p>
                      <p className="text-base sm:text-lg font-extrabold font-mono text-rose-700 leading-tight mt-0.5">
                        {formatUGX(totalToCollect)}
                      </p>
                    </div>
                    <div className="rounded-2xl bg-emerald-50 border border-emerald-200 p-2.5 sm:p-3 text-center">
                      <p className="text-[9px] sm:text-[10px] uppercase tracking-wide font-bold text-emerald-700">{tr('paid')}</p>
                      <p className="text-base sm:text-lg font-extrabold font-mono text-emerald-700 leading-tight mt-0.5">
                        {formatUGX(totalPaid)}
                      </p>
                    </div>
                  </div>
                );
              })()}
              {/* ── Share a simple daily allocation report (PDF) ── */}
              <button
                onClick={handleShareAllocationReport}
                disabled={reportSharing}
                aria-label={simpleLang === 'lg' ? 'Sindika lipoota ya leero' : 'Share daily report'}
                className="w-full h-12 sm:h-14 rounded-2xl bg-primary text-primary-foreground font-bold text-sm sm:text-base flex items-center justify-center gap-2 disabled:opacity-60 active:scale-[0.99] transition-transform"
              >
                {reportSharing
                  ? <Loader2 className="h-5 w-5 sm:h-6 sm:w-6 animate-spin" />
                  : <FileDown className="h-5 w-5 sm:h-6 sm:w-6" strokeWidth={2.4} />}
                <span>{simpleLang === 'lg' ? 'Sindika lipoota' : 'Share daily report'}</span>
              </button>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-muted-foreground" />
                <Input
                  placeholder={tr('searchTenant')}
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="pl-11 h-12 sm:h-14 rounded-2xl bg-muted/40 border-2 border-primary/40 text-base sm:text-lg"
                  style={{ fontSize: '16px' }}
                  aria-label={tr('searchTenant')}
                  inputMode="search"
                  autoComplete="off"
                />
                {search && (
                  <button
                    onClick={() => setSearch('')}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground p-1"
                    aria-label="Clear search"
                  >
                    <X className="h-5 w-5" />
                  </button>
                )}
              </div>
              {/* ── Icon-only filters & sort (no reading required) ── */}
              <div className="flex items-center gap-2">
                {/* Filter group: All / Owing / Paid — pictures only */}
                <div className="flex flex-1 items-center gap-2">
                  {([
                    { key: 'all' as FilterTab, Icon: Users, label: tr('showAll'), on: 'bg-primary text-primary-foreground border-primary', off: 'bg-muted/40 text-muted-foreground border-transparent' },
                    { key: 'owing' as FilterTab, Icon: AlertCircle, label: tr('showOwing'), on: 'bg-rose-600 text-white border-rose-600', off: 'bg-rose-50 text-rose-500 border-transparent' },
                    { key: 'paid-up' as FilterTab, Icon: CheckCircle2, label: tr('showPaid'), on: 'bg-emerald-600 text-white border-emerald-600', off: 'bg-emerald-50 text-emerald-500 border-transparent' },
                  ]).map(({ key, Icon, label, on, off }) => {
                    const active = activeFilter === key;
                    return (
                      <button
                        key={key}
                        onClick={() => setActiveFilter(key)}
                        aria-label={label}
                        aria-pressed={active}
                        title={label}
                        className={`flex-1 h-14 rounded-2xl border-2 flex items-center justify-center transition-colors ${active ? on : off}`}
                      >
                        <Icon className="h-7 w-7" strokeWidth={2.4} />
                      </button>
                    );
                  })}
                </div>
                {/* Sort group: balance / daily / name — tap to pick, tap again to flip direction */}
                <div className="flex items-center gap-2">
                  {([
                    { key: 'balance' as SortKey, Icon: Banknote, labelAsc: 'Lowest balance first', labelDesc: 'Highest balance first' },
                    { key: 'daily' as SortKey, Icon: TrendingUp, labelAsc: 'Lowest daily first', labelDesc: 'Highest daily first' },
                    { key: 'name' as SortKey, Icon: ArrowDownAZ, labelAsc: 'Name Z → A', labelDesc: 'Name A → Z' },
                  ]).map(({ key, Icon, labelAsc, labelDesc }) => {
                    const active = sortKey === key;
                    const dir: SortDir = active ? sortDir : 'desc';
                    const label = dir === 'asc' ? labelAsc : labelDesc;
                    return (
                      <button
                        key={key}
                        onClick={() => {
                          if (sortKey === key) {
                            setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
                          } else {
                            setSortKey(key);
                            setSortDir('desc');
                          }
                        }}
                        aria-label={label}
                        aria-pressed={active}
                        title={label}
                        className={`relative h-14 w-14 rounded-2xl border-2 flex items-center justify-center transition-colors ${active ? 'bg-foreground text-background border-foreground' : 'bg-muted/40 text-muted-foreground border-transparent'}`}
                      >
                        <Icon className="h-7 w-7" strokeWidth={2.4} />
                        {active && (
                          <span className="absolute -top-1 -right-1 h-5 w-5 rounded-full bg-primary text-primary-foreground text-[10px] font-bold flex items-center justify-center border-2 border-background">
                            {sortDir === 'asc' ? '↑' : '↓'}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
                {/* Bulk select toggle — pictures only */}
                <button
                  onClick={() => { if (bulkSelectMode) exitBulkSelect(); else setBulkSelectMode(true); }}
                  aria-label={bulkSelectMode ? tr('stopSelecting') : tr('selectMany')}
                  aria-pressed={bulkSelectMode}
                  title={bulkSelectMode ? tr('stopSelecting') : tr('selectMany')}
                  className={`h-14 w-14 rounded-2xl border-2 flex items-center justify-center transition-colors ${bulkSelectMode ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-muted/40 text-muted-foreground border-transparent'}`}
                >
                  {bulkSelectMode ? <CheckSquare className="h-7 w-7" strokeWidth={2.4} /> : <ListChecks className="h-7 w-7" strokeWidth={2.4} />}
                </button>
              </div>
            </>
          )}

          {!simpleMode && (
          <>
          {/* Rent capacity + Today/Week paid vs expected */}
          <div className="pt-1">
            <AgentRentCapacitySelfCard />
          </div>
          {/* Breakdown of today vs target, yesterday & remaining slots */}
          <div className="pt-2">
            <AgentCapacityBreakdownPanel />
          </div>
          {/* Quick search — pinned at the top of the sheet so agents can
              jump straight to a tenant without scrolling past stats. */}
          <div className="sticky top-14 z-20 -mx-4 px-4 pt-1 pb-2 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search by name, phone digits, or reference ID…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-10 h-11 rounded-xl bg-muted/40 border border-primary/40 focus-visible:ring-1 focus-visible:ring-primary/40 text-base"
                style={{ fontSize: '16px' }}
                aria-label="Search tenants"
                inputMode="search"
                autoComplete="off"
              />
              {search && !isSearchPending && (
                <button
                  onClick={() => setSearch('')}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground p-1"
                  aria-label="Clear search"
                >
                  <X className="h-4 w-4" />
                </button>
              )}
              {isSearchPending && (
                <Loader2
                  className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground animate-spin"
                  aria-label="Searching"
                />
              )}
              {search && (
                <p className="mt-1 text-[11px] text-muted-foreground px-1">
                  {isSearchPending
                    ? 'Searching…'
                    : `${processedTenants.length} match${processedTenants.length === 1 ? '' : 'es'} for "${deferredSearch}"`}
                </p>
              )}
            </div>
            {/* Lifecycle quick filters and sort chips moved into "More
                filters" below — the sticky bar now carries just the single
                search so an ordinary agent isn't faced with two stacked
                filter rows. */}
          </div>

          {/* ───── Today's Collection Status ───── */}
          {/* Live strip showing the agent how their day is going. Driven by
              `todayRepayments` (created_at >= startOfDay) and the same
              owing/expected figures already powering the cards below. */}
          <div className="rounded-2xl border border-emerald-200 bg-gradient-to-br from-emerald-50 to-teal-50 p-3 shadow-sm">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <CalendarClock className="h-4 w-4 text-emerald-700" />
                <span className="text-xs font-semibold uppercase tracking-wide text-emerald-800">
                  Today's Collection
                </span>
              </div>
              <Badge variant="outline" className="text-[10px] font-mono px-2 py-0.5 border-emerald-300 text-emerald-700 bg-card">
                {todayStats.rate}% of expected
              </Badge>
            </div>
            <div className="grid grid-cols-4 gap-2">
              <div>
                <p className="text-[10px] text-emerald-700/80 leading-tight">Collected</p>
                <p className="text-sm font-bold text-emerald-900 leading-tight truncate">
                  {formatUGX(todayStats.collectedAmount)}
                </p>
              </div>
              <div>
                <p className="text-[10px] text-emerald-700/80 leading-tight">Tenants paid</p>
                <p className="text-sm font-bold text-emerald-900 leading-tight">
                  {todayStats.tenantsCollected}
                </p>
              </div>
              <div>
                <p className="text-[10px] text-emerald-700/80 leading-tight">Still owing</p>
                <p className="text-sm font-bold text-rose-700 leading-tight">
                  {todayStats.tenantsOwing}
                </p>
              </div>
              <div>
                <p className="text-[10px] text-emerald-700/80 leading-tight">Expected</p>
                <p className="text-sm font-bold text-emerald-900 leading-tight truncate">
                  {formatUGX(todayStats.expected)}
                </p>
              </div>
            </div>
          </div>

          {/* Compact summary — minimalist: the three numbers that matter most */}
          <div className="grid grid-cols-3 rounded-2xl border border-border/60 bg-card divide-x divide-border/60 overflow-hidden shadow-sm">
            <button
              type="button"
              onClick={() => setShowBalanceBreakdown(true)}
              className="p-3 text-left active:bg-muted/30 transition-colors"
            >
              <p className="text-[10px] text-muted-foreground uppercase tracking-wider leading-none">Total owed</p>
              <p className="text-base font-bold font-mono text-rose-600 leading-tight mt-1 truncate">{formatUGX(stats.totalOwing)}</p>
              <p className="text-[10px] text-muted-foreground leading-tight mt-0.5">{stats.owingCount} owing</p>
            </button>
            <div className="p-3">
              <p className="text-[10px] text-muted-foreground uppercase tracking-wider leading-none">Daily target</p>
              <p className="text-base font-bold font-mono text-indigo-600 leading-tight mt-1 truncate">{formatUGX(stats.dailyExpectation)}</p>
              <p className="text-[10px] text-muted-foreground leading-tight mt-0.5">Expected/day</p>
            </div>
            <div className="p-3">
              <p className="text-[10px] text-muted-foreground uppercase tracking-wider leading-none">Tenants</p>
              <p className="text-base font-bold leading-tight mt-1">{stats.total}</p>
              <p className="text-[10px] text-muted-foreground leading-tight mt-0.5">{stats.paidUpCount} paid up</p>
            </div>
          </div>

          {/* Filters — single search lives in the sticky bar above, so this
              block only carries the primary status chips + advanced toggles.
              (The duplicate search box that used to sit here was removed —
              two identical search inputs confused agents.) */}
          <div className="space-y-2">
            {/* Saved presets — one-tap return to a usual Owing/Paid up/All +
                search + sort setup. */}
            <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar">
              <span className="shrink-0 inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground pr-0.5">
                <Star className="h-3 w-3" /> Saved
              </span>
              {presets.length === 0 && (
                <span className="shrink-0 text-[11px] text-muted-foreground italic">
                  No saved views yet
                </span>
              )}
              {presets.map((p) => (
                <span
                  key={p.id}
                  className="shrink-0 inline-flex items-center rounded-full border border-border bg-muted/40 text-foreground/80 hover:bg-muted transition-colors"
                >
                  <button
                    onClick={() => applyPreset(p)}
                    className="pl-3 pr-1.5 py-1.5 text-xs font-semibold"
                    style={{ touchAction: 'manipulation', minHeight: '32px' }}
                  >
                    {p.name}
                  </button>
                  <button
                    onClick={() => deletePreset(p.id)}
                    className="pr-2 pl-0.5 py-1.5 text-muted-foreground hover:text-destructive"
                    aria-label={`Delete ${p.name}`}
                    style={{ touchAction: 'manipulation' }}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
              <Popover open={savePresetOpen} onOpenChange={(o) => { setSavePresetOpen(o); if (!o) setPresetName(''); }}>
                <PopoverTrigger asChild>
                  <button
                    className="shrink-0 inline-flex items-center gap-1 px-3 py-1.5 rounded-full border border-dashed border-primary/50 text-primary text-xs font-semibold hover:bg-primary/5 transition-colors"
                    style={{ touchAction: 'manipulation', minHeight: '32px' }}
                  >
                    <Plus className="h-3 w-3" /> Save current
                  </button>
                </PopoverTrigger>
                <PopoverContent className="w-[min(88vw,280px)] p-3" align="end">
                  <p className="text-xs font-semibold text-foreground mb-1">Save this view</p>
                  <p className="text-[11px] text-muted-foreground mb-2 leading-snug">
                    Stores your current filter, search and sort so you can return in one tap.
                  </p>
                  <Input
                    value={presetName}
                    onChange={(e) => setPresetName(e.target.value)}
                    placeholder="e.g. My usual"
                    className="h-9 text-sm"
                    style={{ fontSize: '16px' }}
                    autoFocus
                    onKeyDown={(e) => { if (e.key === 'Enter') handleSavePreset(); }}
                  />
                  <div className="flex justify-end gap-2 mt-2">
                    <Button variant="ghost" size="sm" onClick={() => { setSavePresetOpen(false); setPresetName(''); }}>
                      Cancel
                    </Button>
                    <Button size="sm" onClick={handleSavePreset} disabled={!presetName.trim()}>
                      Save
                    </Button>
                  </div>
                </PopoverContent>
              </Popover>
            </div>

            {/* Big tap-friendly status chips — the main filter most agents need */}
            <div className="grid grid-cols-3 gap-1.5 p-1 rounded-xl bg-muted/50">
              {filterTabs.map((tab) => {
                const active = activeFilter === tab.key;
                return (
                  <button
                    key={tab.key}
                    onClick={() => setActiveFilter(tab.key)}
                    className={`py-2.5 rounded-lg text-sm font-semibold transition-all flex items-center justify-center gap-1.5 ${
                      active ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground'
                    }`}
                    style={{ touchAction: 'manipulation', minHeight: '44px' }}
                  >
                    <span>{tab.label}</span>
                    <span className={`text-xs font-mono px-1.5 py-0.5 rounded-md ${
                      active ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'
                    }`}>{tab.count}</span>
                  </button>
                );
              })}
            </div>

            {/* "More filters" toggle — keeps the page calm on small screens */}
            <div className="flex items-center gap-2">
            <button
              onClick={() => setShowMoreFilters(v => !v)}
              className="flex-1 flex items-center justify-center gap-2 py-2 rounded-lg text-xs font-semibold text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-colors"
              style={{ touchAction: 'manipulation', minHeight: '36px' }}
            >
              <SlidersHorizontal className="h-3.5 w-3.5" />
              {showMoreFilters ? 'Hide filters' : 'More filters & sorting'}
              {(riskFilter !== 'all' || propertyFilter !== 'all') && (
                <Badge variant="secondary" className="h-5 px-1.5 text-[10px]">
                  {[riskFilter !== 'all', propertyFilter !== 'all'].filter(Boolean).length}
                </Badge>
              )}
            </button>
            <button
              onClick={() => { setGroupByProperty(v => !v); setCollapsedGroups(new Set()); if (mapMode) setMapMode(false); }}
              className={`flex-1 flex items-center justify-center gap-2 py-2 rounded-lg text-xs font-semibold transition-colors ${
                groupByProperty
                  ? 'bg-primary/10 text-primary'
                  : 'text-muted-foreground hover:text-foreground hover:bg-muted/40'
              }`}
              style={{ touchAction: 'manipulation', minHeight: '36px' }}
              aria-pressed={groupByProperty}
            >
              <Building2 className="h-3.5 w-3.5" />
              {groupByProperty ? 'Grouped by property' : 'Group by property'}
            </button>
            <button
              onClick={() => setMapMode(v => !v)}
              className={`flex-1 flex items-center justify-center gap-2 py-2 rounded-lg text-xs font-semibold transition-colors ${
                mapMode
                  ? 'bg-primary/10 text-primary'
                  : 'text-muted-foreground hover:text-foreground hover:bg-muted/40'
              }`}
              style={{ touchAction: 'manipulation', minHeight: '36px' }}
              aria-pressed={mapMode}
            >
              {mapMode ? <List className="h-3.5 w-3.5" /> : <MapIcon className="h-3.5 w-3.5" />}
              {mapMode ? 'List view' : 'Map view'}
            </button>
            </div>

            {showMoreFilters && (
              <div className="grid grid-cols-2 gap-2 pt-1">
                {/* Lifecycle stage chips — advanced filter, tucked away so the
                    main view only shows Owing / Paid up / All. */}
                <div className="col-span-2">
                  <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-1.5">Stage</p>
                  <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar">
                    {lifecycleTabs.map((tab) => {
                      const active = lifecycleFilter === tab.key;
                      return (
                        <button
                          key={tab.key}
                          onClick={() => setLifecycleFilter(tab.key)}
                          className={`shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold border transition-colors ${
                            active
                              ? 'bg-primary text-primary-foreground border-primary shadow-sm'
                              : 'bg-muted/40 text-muted-foreground border-border hover:bg-muted'
                          }`}
                          style={{ touchAction: 'manipulation', minHeight: '32px' }}
                          aria-pressed={active}
                        >
                          <span>{tab.label}</span>
                          {typeof tab.count === 'number' && (
                            <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded-md ${
                              active ? 'bg-primary-foreground/20 text-primary-foreground' : 'bg-background text-foreground/70'
                            }`}>{tab.count}</span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                </div>
                <Select value={riskFilter} onValueChange={(v) => setRiskFilter(v as RiskFilter)}>
              <SelectTrigger className="w-[140px] h-10 rounded-xl border-2 border-solid border-purple-600">
                <div className="text-left">
                  <p className="text-[10px] text-muted-foreground leading-none mb-0.5">Risk Level</p>
                  <SelectValue />
                </div>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All</SelectItem>
                <SelectItem value="good">Good</SelectItem>
                <SelectItem value="standard">Standard</SelectItem>
                <SelectItem value="caution">Caution</SelectItem>
                <SelectItem value="new">New</SelectItem>
              </SelectContent>
            </Select>
            <Popover open={propertyPickerOpen} onOpenChange={setPropertyPickerOpen}>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  role="combobox"
                  className="h-10 rounded-xl justify-between font-normal px-3"
                >
                  <div className="text-left min-w-0">
                    <p className="text-[10px] text-muted-foreground leading-none mb-0.5">Property</p>
                    <p className="text-sm truncate">
                      {propertyFilter === 'all' ? 'All Properties' : propertyFilter}
                    </p>
                  </div>
                  <div className="flex items-center gap-1 shrink-0 ml-2">
                    {propertyFilter !== 'all' && (
                      <span
                        onClick={(e) => { e.stopPropagation(); setPropertyFilter('all'); }}
                        className="inline-flex items-center justify-center h-5 w-5 rounded-full bg-muted hover:bg-muted/80 text-muted-foreground hover:text-foreground transition-colors"
                        role="button"
                        aria-label="Clear property filter"
                      >
                        <X className="h-3 w-3" />
                      </span>
                    )}
                    <ChevronsUpDown className="h-4 w-4 opacity-50 shrink-0" />
                  </div>
                </Button>
              </PopoverTrigger>
              <PopoverContent className="p-0 w-[min(92vw,320px)]" align="start">
                <Command>
                  <CommandInput placeholder="Search property name or address…" className="h-10 border-2 border-solid border-purple-600 rounded-md" />
                  <CommandList>
                    <CommandEmpty>No matching property.</CommandEmpty>
                    <CommandGroup>
                      <CommandItem
                        value="All Properties"
                        onSelect={() => {
                          setPropertyFilter('all');
                          setPropertyPickerOpen(false);
                          requestAnimationFrame(() => tenantListRef.current?.focus());
                        }}
                      >
                        <Check className={`mr-2 h-4 w-4 ${propertyFilter === 'all' ? 'opacity-100' : 'opacity-0'}`} />
                        All Properties
                      </CommandItem>
                    </CommandGroup>
                    {(() => {
                      const validRecents = recentProperties.filter(addr =>
                        propertyOptions.some(p => p.address === addr),
                      );
                      if (validRecents.length === 0) return null;
                      return (
                        <>
                          <CommandSeparator />
                          <CommandGroup heading="Recent">
                            {validRecents.map(addr => {
                              const opt = propertyOptions.find(p => p.address === addr);
                              return (
                                <CommandItem
                                  key={`recent-${addr}`}
                                  value={`recent ${addr}`}
                                  onSelect={() => {
                                    setPropertyFilter(addr);
                                    recordRecentProperty(addr);
                                    setPropertyPickerOpen(false);
                                    requestAnimationFrame(() => tenantListRef.current?.focus());
                                  }}
                                >
                                  <Check className={`mr-2 h-4 w-4 shrink-0 ${propertyFilter === addr ? 'opacity-100' : 'opacity-0'}`} />
                                  <span className="truncate flex-1">{addr}</span>
                                  {opt && (
                                    <span className="ml-2 text-[10px] font-mono tabular-nums px-1.5 py-0.5 rounded-md bg-muted text-muted-foreground">
                                      {opt.count}
                                    </span>
                                  )}
                                </CommandItem>
                              );
                            })}
                          </CommandGroup>
                          <CommandSeparator />
                        </>
                      );
                    })()}
                    <CommandGroup heading="All properties">
                      {propertyOptions.map(p => (
                        <CommandItem
                          key={p.address}
                          value={p.address}
                          onSelect={() => {
                            setPropertyFilter(p.address);
                            recordRecentProperty(p.address);
                            setPropertyPickerOpen(false);
                            requestAnimationFrame(() => tenantListRef.current?.focus());
                          }}
                        >
                          <Check className={`mr-2 h-4 w-4 shrink-0 ${propertyFilter === p.address ? 'opacity-100' : 'opacity-0'}`} />
                          <span className="truncate flex-1">{p.address}</span>
                          <span className="ml-2 text-[10px] font-mono tabular-nums px-1.5 py-0.5 rounded-md bg-muted text-muted-foreground">
                            {p.count}
                          </span>
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
            <Select value={`${sortKey}-${sortDir}`} onValueChange={(v) => {
              const idx = v.lastIndexOf('-');
              const k = v.slice(0, idx) as SortKey;
              const d = v.slice(idx + 1) as SortDir;
              setSortKey(k); setSortDir(d);
            }}>
              <SelectTrigger className="col-span-2 h-10 rounded-xl border-2 border-solid border-purple-600">
                <div className="text-left">
                  <p className="text-[10px] text-muted-foreground leading-none mb-0.5">Sort By</p>
                  <SelectValue />
                </div>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="recent-desc">Most recent (Newest → Oldest)</SelectItem>
                <SelectItem value="recent-asc">Most recent (Oldest → Newest)</SelectItem>
                <SelectItem value="name-asc">Name (A → Z)</SelectItem>
                <SelectItem value="name-desc">Name (Z → A)</SelectItem>
                <SelectItem value="balance-desc">Balance (High → Low)</SelectItem>
                <SelectItem value="balance-asc">Balance (Low → High)</SelectItem>
                <SelectItem value="daily-desc">Daily Expected (High → Low)</SelectItem>
                <SelectItem value="daily-asc">Daily Expected (Low → High)</SelectItem>
                <SelectItem value="risk-desc">Risk (Worst first)</SelectItem>
                <SelectItem value="aiId-asc">AI ID (A → Z)</SelectItem>
                <SelectItem value="property-asc">Property (A → Z)</SelectItem>
                <SelectItem value="property-daily-desc">Property, then Daily (High → Low)</SelectItem>
                <SelectItem value="property-daily-asc">Property, then Daily (Low → High)</SelectItem>
                <SelectItem value="property-balance-desc">Property, then Balance (High → Low)</SelectItem>
                <SelectItem value="property-balance-asc">Property, then Balance (Low → High)</SelectItem>
                <SelectItem value="lastCollected-desc">Last collected (Recent → Oldest)</SelectItem>
                <SelectItem value="lastCollected-asc">Last collected (Oldest → Recent)</SelectItem>
              </SelectContent>
            </Select>
            <Select value={recentCollectionFilter} onValueChange={(v) => setRecentCollectionFilter(v as typeof recentCollectionFilter)}>
              <SelectTrigger className="col-span-2 h-10 rounded-xl border-2 border-solid border-purple-600">
                <div className="text-left">
                  <p className="text-[10px] text-muted-foreground leading-none mb-0.5">Recent Collection</p>
                  <SelectValue />
                </div>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Any time</SelectItem>
                <SelectItem value="1">Collected in last 24 hours</SelectItem>
                <SelectItem value="3">Collected in last 3 days</SelectItem>
                <SelectItem value="7">Collected in last 7 days</SelectItem>
                <SelectItem value="14">Collected in last 14 days</SelectItem>
                <SelectItem value="30">Collected in last 30 days</SelectItem>
                <SelectItem value="never">Never collected</SelectItem>
              </SelectContent>
            </Select>
              </div>
            )}
          </div>

          {/* Top properties — quick-switch chips (horizontal scroll on mobile) */}
          {(() => {
            const counts = new Map<string, number>();
            tenants.forEach(t => {
              const a = tenantContext[t.id]?.propertyAddress?.trim();
              if (a) counts.set(a, (counts.get(a) || 0) + 1);
            });
            const top = Array.from(counts.entries())
              .sort((a, b) => b[1] - a[1])
              .slice(0, 6);
            if (top.length < 2) return null;
            return (
              <div className="-mx-4 px-4 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                <div className="flex items-center gap-1.5 w-max pb-1">
                  <button
                    onClick={() => setPropertyFilter('all')}
                    className={`shrink-0 h-8 px-3 rounded-full text-xs font-semibold border transition-colors ${
                      propertyFilter === 'all'
                        ? 'bg-primary text-primary-foreground border-primary'
                        : 'bg-background text-foreground border-border hover:bg-muted'
                    }`}
                    style={{ touchAction: 'manipulation' }}
                  >
                    All
                  </button>
                  {top.map(([addr, count]) => {
                    const active = propertyFilter === addr;
                    return (
                      <button
                        key={addr}
                        onClick={() => setPropertyFilter(active ? 'all' : addr)}
                        title={addr}
                        className={`shrink-0 h-8 pl-3 pr-2 rounded-full text-xs font-semibold border inline-flex items-center gap-1.5 transition-colors max-w-[180px] ${
                          active
                            ? 'bg-primary text-primary-foreground border-primary'
                            : 'bg-background text-foreground border-border hover:bg-muted'
                        }`}
                        style={{ touchAction: 'manipulation' }}
                      >
                        <Building2 className="h-3 w-3 shrink-0" />
                        <span className="truncate">{addr}</span>
                        <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded-md ${
                          active ? 'bg-primary-foreground/20' : 'bg-muted text-muted-foreground'
                        }`}>{count}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })()}

          {stats.totalOwing > 0 && (
            <button
              type="button"
              onClick={() => setShowBalanceBreakdown(true)}
              className="text-xs text-muted-foreground text-left hover:text-foreground transition-colors cursor-pointer"
            >
              Total owed: <span className="font-bold text-destructive font-mono underline decoration-dotted underline-offset-2">{formatUGX(stats.totalOwing)}</span>
            </button>
          )}
          </>
          )}
          </>
          )}
        </div>

        {/* ───── Body ───── */}
        {simpleMode ? (
          <div className={`px-3 py-2 space-y-2 ${bulkSelectMode ? 'pb-28' : ''}`}>
            {loading ? (
              <div className="flex items-center justify-center py-20">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            ) : processedTenants.length === 0 ? (
              <div className="text-center py-20">
                <Users className="h-10 w-10 mx-auto mb-3 text-muted-foreground/40" />
                <p className="text-sm text-muted-foreground">
                  {search ? `No results for "${search}"` : 'No tenants yet'}
                </p>
              </div>
            ) : (
              processedTenants.map((tenant) => {
                const balance = tenantBalances[tenant.id] || 0;
                const hasDebt = balance > 0;
                const ctx = tenantContext[tenant.id];
                const propertyAddress = ctx?.propertyAddress || '';
                const selected = bulkSelected.has(tenant.id);
                const selectable = bulkSelectMode && hasDebt;
                return (
                  <div
                    key={tenant.id}
                    className={`rounded-2xl border bg-card p-3 shadow-sm transition-colors ${
                      selected ? 'border-emerald-500 ring-2 ring-emerald-500/50 bg-emerald-50/40' : 'border-border/60'
                    } ${bulkSelectMode && !hasDebt ? 'opacity-50' : ''}`}
                  >
                    {/* Tenant identity — tap to open profile, or tick in select mode */}
                    <button
                      type="button"
                      onClick={() => {
                        if (bulkSelectMode) { if (hasDebt) toggleBulkSelect(tenant.id); }
                        else setProfileTenantId(tenant.id);
                      }}
                      className="flex items-center gap-2.5 w-full text-left active:opacity-80"
                      style={{ touchAction: 'manipulation' }}
                    >
                      {bulkSelectMode ? (
                        <div className={`w-12 h-12 rounded-full flex items-center justify-center shrink-0 border-2 ${
                          selected ? 'bg-emerald-600 border-emerald-600 text-white' : 'border-muted-foreground/30 text-muted-foreground/40'
                        }`}>
                          {selected ? <CheckCircle2 className="h-7 w-7" strokeWidth={2.5} /> : <CheckSquare className="h-6 w-6" strokeWidth={2} />}
                        </div>
                      ) : (
                      <div className={`w-11 h-11 rounded-full flex items-center justify-center shrink-0 text-lg font-bold ${
                        hasDebt ? 'bg-rose-100 text-rose-700' : 'bg-emerald-100 text-emerald-700'
                      }`}>
                        {(tenant.full_name?.trim()?.charAt(0) || tenant.phone?.charAt(0) || '?').toUpperCase()}
                      </div>
                      )}
                      <div className="flex-1 min-w-0">
                        <p className="font-bold text-sm sm:text-base leading-tight truncate">
                          {tenant.full_name?.trim() || 'Tenant'}
                        </p>
                        {propertyAddress ? (
                          <p className="text-xs text-muted-foreground truncate flex items-center gap-1 mt-0.5">
                            <MapPin className="h-3 w-3 shrink-0" />
                            {propertyAddress}
                          </p>
                        ) : tenant.phone ? (
                          <p className="text-xs text-muted-foreground truncate flex items-center gap-1 mt-0.5">
                            <Phone className="h-3 w-3 shrink-0" />
                            {tenant.phone}
                          </p>
                        ) : null}
                      </div>
                    </button>

                    {/* Big, unmissable amount */}
                    <div className={`mt-2 rounded-xl px-3 py-2 text-center ${hasDebt ? 'bg-rose-50' : 'bg-emerald-50'}`}>
                      <p className={`text-[10px] uppercase tracking-wide font-bold ${hasDebt ? 'text-rose-600' : 'text-emerald-600'}`}>
                        {hasDebt ? tr('toCollect') : tr('allPaid')}
                      </p>
                      <p className={`text-xl sm:text-2xl font-extrabold font-mono leading-none mt-1 ${hasDebt ? 'text-rose-600' : 'text-emerald-600'}`}>
                        {hasDebt ? formatUGX(balance) : 'UGX 0'}
                      </p>
                    </div>

                    {/* Two big actions — hidden while picking many tenants */}
                    {!bulkSelectMode && (
                    <div className="grid grid-cols-2 gap-2 mt-2">
                      <Button
                        onClick={() => setFieldCollectTarget(tenant)}
                        className="h-10 sm:h-11 text-xs sm:text-sm font-bold rounded-xl gap-1.5 bg-emerald-600 hover:bg-emerald-700 text-white"
                      >
                        <Banknote className="h-4 w-4" />
                        {tr('collect')}
                      </Button>
                      <Button
                        variant="outline"
                        onClick={() => { if (tenant.phone) window.open(`tel:${tenant.phone.replace(/\s/g, '')}`); }}
                        disabled={!tenant.phone}
                        className="h-10 sm:h-11 text-xs sm:text-sm font-bold rounded-xl gap-1.5"
                      >
                        <PhoneCall className="h-4 w-4" />
                        {tr('call')}
                      </Button>
                    </div>
                    )}
                  </div>
                );
              })
            )}

            {/* Sticky bulk-collect bar — appears while picking many tenants */}
            {bulkSelectMode && (
              <div className="fixed inset-x-0 bottom-0 z-40 px-4 pb-[calc(env(safe-area-inset-bottom)+12px)] pt-3 bg-background/95 backdrop-blur border-t">
                <div className="mx-auto max-w-md flex items-center gap-3">
                  <div className="flex-1 min-w-0">
                    <p className="text-2xl font-extrabold font-mono leading-none text-emerald-600">{formatUGX(bulkTotal)}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">{bulkPayableTenants.length} {tr('selected')}</p>
                  </div>
                  <Button
                    onClick={() => setBulkConfirmOpen(true)}
                    disabled={bulkPayableTenants.length === 0}
                    className="h-14 px-6 text-base font-bold rounded-2xl gap-2 bg-emerald-600 hover:bg-emerald-700 text-white"
                  >
                    <CheckCircle2 className="h-6 w-6" />
                    {tr('markPaid')}
                  </Button>
                </div>
              </div>
            )}
          </div>
        ) : mapMode ? (
          <div className="flex-1 overflow-hidden px-4 py-3">
            <PropertyMapView
              tenants={processedTenants}
              tenantContext={tenantContext}
              tenantBalances={tenantBalances}
              tenantDaily={tenantDaily}
              propertyLocations={propertyLocations}
              onSelectTenant={(id) => setProfileTenantId(id)}
            />
          </div>
        ) : (
        <div ref={tenantListRef} tabIndex={-1} className="px-4 py-3 space-y-2">
          {loading ? (
            <div className="flex items-center justify-center py-20">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : processedTenants.length === 0 ? (
            <div className="text-center py-20">
              <Users className="h-10 w-10 mx-auto mb-3 text-muted-foreground/40" />
              <p className="text-sm text-muted-foreground">
                {search ? `No results for "${search}"` : activeFilter === 'owing' ? 'No tenants owing' : activeFilter === 'paid-up' ? 'No paid up tenants' : 'No tenants yet'}
              </p>
              {(activeFilter !== 'all' || riskFilter !== 'all' || search) && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="mt-2 text-xs"
                  onClick={() => { setActiveFilter('all'); setRiskFilter('all'); setSearch(''); }}
                >
                  Reset filters
                </Button>
              )}
            </div>
          ) : (() => {
            const tenantCards = processedTenants.map((tenant) => {
              const isExpanded = expandedTenantId === tenant.id;
              const requests = tenantRequests[tenant.id] || [];
              const isLoadingThis = loadingRequests === tenant.id;
              const balance = tenantBalances[tenant.id] || 0;
              const totals = tenantTotals[tenant.id] || { total: 0, paid: 0 };
              const progressPct = totals.total > 0 ? Math.min(100, Math.round((totals.paid / totals.total) * 100)) : 0;
              const hasDebt = balance > 0;
              const tStatuses = tenantStatuses[tenant.id] ?? new Set<string>();
              const tIsActive = tStatuses.has('disbursed') || tStatuses.has('repaying');
              const tIsPending = !tIsActive && (tStatuses.has('pending') || tStatuses.has('approved') || tStatuses.has('funded'));
              const tIsSettled = !tIsActive && !tIsPending && tStatuses.has('completed') && balance === 0;
              const meta = tenantMeta[tenant.id];
              const ctx = tenantContext[tenant.id];
              const propertyAddress = ctx?.propertyAddress || '';
              const landlordName = ctx?.landlordName || '';
              const payStatus: 'paid_up' | 'owing' = hasDebt ? 'owing' : 'paid_up';
              // A zero balance only means "Paid up" when a plan actually ran.
              // Tenants still sitting in vetting/approval have no plan yet.
              const tHasLivePlan = tStatuses.has('funded') || tStatuses.has('disbursed')
                || tStatuses.has('repaying') || tStatuses.has('completed');
              const tInReview = !hasDebt && tStatuses.size > 0 && !tHasLivePlan;
              const statusMeta = hasDebt
                ? { label: 'Owing',   cls: 'bg-rose-100 text-rose-700 border-rose-200',          dot: 'bg-rose-500',   Icon: AlertCircle }
                : tInReview
                  ? { label: 'In review', cls: 'bg-amber-100 text-amber-700 border-amber-200',   dot: 'bg-amber-500',  Icon: AlertCircle }
                  : { label: 'Paid up', cls: 'bg-emerald-100 text-emerald-700 border-emerald-200', dot: 'bg-emerald-500', Icon: CheckCircle2 };
              const riskUiMeta: Record<string, { label: string; cls: string }> = {
                good:     { label: 'Low Risk',    cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
                standard: { label: 'Medium Risk', cls: 'bg-amber-50 text-amber-700 border-amber-200' },
                caution:  { label: 'High Risk',   cls: 'bg-rose-50 text-rose-700 border-rose-200' },
                new:      { label: 'New Member',  cls: 'bg-muted text-muted-foreground border-border' },
              };
              const riskUi = riskUiMeta[meta?.riskLevel ?? 'new'];
              const reliabilityMeta = meta?.completionRate >= 80
                ? { label: 'Pays on time', cls: 'bg-emerald-50 text-emerald-700' }
                : meta?.completionRate >= 50
                  ? { label: 'Usually late', cls: 'bg-amber-50 text-amber-700' }
                  : meta?.totalRequests > 0
                    ? { label: 'Frequently late', cls: 'bg-rose-50 text-rose-700' }
                    : { label: 'New', cls: 'bg-muted text-muted-foreground' };
              const progressColor = progressPct >= 100 ? 'bg-emerald-500' : hasDebt ? 'bg-rose-500' : 'bg-primary';
              const StatusIcon = statusMeta.Icon;

              return { tenant, el: (
                <div
                  key={tenant.id}
                  className="rounded-2xl border border-border/60 bg-card overflow-hidden transition-shadow hover:shadow-md"
                >
                  {/* Tenant row — mobile-first; tap row to expand, tap name for full profile */}
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => toggleExpand(tenant.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        toggleExpand(tenant.id);
                      }
                    }}
                    className="w-full p-3.5 text-left active:bg-muted/30 transition-colors cursor-pointer"
                    style={{ touchAction: 'manipulation', minHeight: '64px' }}
                  >
                    <div className="flex items-center gap-3">
                      {/* Avatar */}
                        <div className="relative">
                          <div className={`w-11 h-11 rounded-full flex items-center justify-center shrink-0 text-base font-bold ${
                            hasDebt ? 'bg-rose-100 text-rose-700' : 'bg-emerald-100 text-emerald-700'
                          }`}>
                            {(tenant.full_name?.trim()?.charAt(0) || tenant.phone?.charAt(0) || '?').toUpperCase()}
                          </div>
                          <span className={`absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-background ${statusMeta.dot}`} />
                        </div>

                      {/* Name + phone (name → opens full profile) */}
                      <div className="flex-1 min-w-0">
                        <p
                          className="font-semibold truncate text-primary underline underline-offset-2 cursor-pointer text-[15px] leading-tight"
                          onClick={(e) => { e.stopPropagation(); setProfileTenantId(tenant.id); }}
                        >
                            {tenant.full_name && tenant.full_name.trim() ? (
                              <Highlight text={tenant.full_name.trim()} query={deferredSearch} />
                            ) : (
                              <span className="text-muted-foreground italic">Unnamed tenant</span>
                            )}
                          </p>
                        <p className="text-[11px] text-muted-foreground flex items-center gap-1 truncate mt-0.5">
                            <Phone className="h-3 w-3" />
                            <Highlight text={tenant.phone} query={deferredSearch} />
                          {propertyAddress && (
                            <span className="truncate">· {propertyAddress}</span>
                          )}
                          </p>
                      </div>

                      {/* Amount due + daily expected */}
                      <div className="text-right shrink-0">
                        <p className="text-[10px] text-muted-foreground uppercase tracking-wider leading-none">Due</p>
                        <p className={`font-bold font-mono text-[15px] leading-tight ${hasDebt ? 'text-rose-600' : 'text-emerald-600'}`}>
                          {hasDebt ? formatUGX(balance) : 'UGX 0'}
                        </p>
                        <p className="text-[10px] text-muted-foreground leading-tight mt-0.5">
                          {formatUGX(tenantDaily[tenant.id] || 0)}/day
                        </p>
                      </div>
                      {/* Expand chevron — signals tap reveals actions */}
                      <ChevronsUpDown className={`h-4 w-4 shrink-0 text-muted-foreground/50 transition-transform ${isExpanded ? 'text-primary' : ''}`} />
                    </div>

                    {/* Slim last-collected hint — full actions appear on tap (expand) */}
                    {tenantLastPaid[tenant.id] && (
                      <p className="mt-1.5 text-[11px] font-medium text-emerald-600 flex items-center gap-1 truncate">
                        <CheckCircle2 className="h-3 w-3 shrink-0" />
                        Last collected +{formatUGX(tenantLastPaid[tenant.id].amount)}
                        <span className="text-emerald-600/70 font-normal">
                          · {formatDistanceToNowStrict(new Date(tenantLastPaid[tenant.id].date), { addSuffix: true })}
                        </span>
                      </p>
                    )}

                    {tIsSettled && (
                      <div className="mt-2 grid grid-cols-2 gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={(e) => { e.stopPropagation(); setProfileAutoEdit(true); setProfileTenantId(tenant.id); }}
                          className="h-11 gap-1.5 rounded-lg text-sm font-bold border-2 border-primary/40 text-primary hover:bg-primary/10"
                        >
                          <SlidersHorizontal className="h-4 w-4" />
                          Edit
                        </Button>
                        <Button
                          size="sm"
                          onClick={(e) => { e.stopPropagation(); handleResubmitTenant(tenant); }}
                          disabled={renewingReqId === tenant.id || loadingRequests === tenant.id}
                          className="h-11 gap-1.5 rounded-lg text-sm font-bold bg-primary text-primary-foreground hover:bg-primary/90 shadow-sm"
                        >
                          {renewingReqId === tenant.id || loadingRequests === tenant.id ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <RefreshCw className="h-4 w-4" />
                          )}
                          Renew
                        </Button>
                      </div>
                    )}
                  </div>

                  {/* ───── Expanded Details ───── */}
                  <AnimatePresence>
                    {isExpanded && (
                      <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.2 }}
                        className="overflow-hidden border-t border-border/40"
                      >
                        <div className="p-3.5 space-y-3">
                          {/* Next 7-day collection plan — quick mobile planner */}
                          {(tenantDaily[tenant.id] || 0) > 0 && (() => {
                            const daily = tenantDaily[tenant.id] || 0;
                            const weekTotal = daily * 7;
                            const cap = Math.min(weekTotal, balance);
                            const today = new Date();
                            const days = Array.from({ length: 7 }, (_, i) => {
                              const d = new Date(today);
                              d.setDate(today.getDate() + i);
                              return d;
                            });
                            let running = 0;
                            return (
                              <div className="rounded-xl border border-border/60 bg-background p-3">
                                <div className="flex items-center justify-between mb-2">
                                  <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
                                    Next 7 days
                                  </p>
                                  <p className="text-[11px] text-muted-foreground">
                                    Plan: <span className="font-bold font-mono text-foreground">{formatUGX(cap)}</span>
                                  </p>
                                </div>
                                <div className="grid grid-cols-7 gap-1.5">
                                  {days.map((d, i) => {
                                    const isToday = i === 0;
                                    running += daily;
                                    const beyondDebt = running > balance && balance > 0;
                                    return (
                                      <div
                                        key={i}
                                        className={`rounded-lg p-1.5 text-center border ${
                                          isToday
                                            ? 'bg-primary/10 border-primary/30'
                                            : beyondDebt
                                              ? 'bg-muted/30 border-border/40 opacity-60'
                                              : 'bg-muted/40 border-border/40'
                                        }`}
                                      >
                                        <p className="text-[9px] font-semibold text-muted-foreground uppercase">
                                          {format(d, 'EEE')}
                                        </p>
                                        <p className="text-[10px] text-muted-foreground leading-tight">
                                          {format(d, 'd MMM')}
                                        </p>
                                        <p className={`text-[10px] font-bold font-mono mt-0.5 leading-tight ${
                                          isToday ? 'text-primary' : 'text-foreground'
                                        }`}>
                                          {formatUGX(daily)}
                                        </p>
                                      </div>
                                    );
                                  })}
                                </div>
                                {balance > 0 && weekTotal > balance && (
                                  <p className="text-[10px] text-muted-foreground mt-2">
                                    Remaining debt clears in ~{Math.ceil(balance / daily)} day{Math.ceil(balance / daily) !== 1 ? 's' : ''}.
                                  </p>
                                )}
                              </div>
                            );
                          })()}
                          {isLoadingThis ? (
                            <div className="flex items-center justify-center py-6">
                              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                            </div>
                          ) : requests.length === 0 ? (
                            <p className="text-sm text-muted-foreground text-center py-4">No rent plans yet</p>
                          ) : (
                            requests.map((req) => {
                              const progress = req.total_repayment > 0 ? Math.min((req.amount_repaid / req.total_repayment) * 100, 100) : 0;
                              const owing = Math.max(0, (req.total_repayment || 0) - (req.amount_repaid || 0));

                              return (
                                <div key={req.id} className="bg-muted/30 rounded-xl p-3 space-y-3">
                                  {/* Landlord & Location Info */}
                                  {req.landlord && (
                                    <div className="grid grid-cols-2 gap-2">
                                      <div className="bg-background rounded-lg p-2 flex items-start gap-1.5">
                                        <User className="h-3 w-3 text-muted-foreground mt-0.5 shrink-0" />
                                        <div className="min-w-0">
                                          <p className="text-[9px] text-muted-foreground">Landlord</p>
                                          <p className="text-xs font-semibold truncate">
                                            <Highlight text={req.landlord.name} query={deferredSearch} />
                                          </p>
                                        </div>
                                      </div>
                                      <div className="bg-background rounded-lg p-2 flex items-start gap-1.5">
                                        <Home className="h-3 w-3 text-muted-foreground mt-0.5 shrink-0" />
                                        <div className="min-w-0">
                                          <p className="text-[9px] text-muted-foreground">House Type</p>
                                          <p className="text-xs font-semibold truncate">{req.landlord.house_category || 'N/A'}</p>
                                        </div>
                                      </div>
                                      <div className="bg-background rounded-lg p-2 flex items-start gap-1.5 col-span-2">
                                        <MapPin className="h-3 w-3 text-muted-foreground mt-0.5 shrink-0" />
                                        <div className="min-w-0">
                                          <p className="text-[9px] text-muted-foreground">Location</p>
                                          <p className="text-xs font-semibold truncate">
                                            <Highlight text={req.landlord.property_address || 'N/A'} query={deferredSearch} />
                                          </p>
                                        </div>
                                      </div>
                                    </div>
                                  )}

                                  {/* 2×2 Financial summary */}
                                  <div className="grid grid-cols-2 gap-2">
                                    <div className="bg-background rounded-lg p-2.5 text-center">
                                      <p className="text-[10px] text-muted-foreground">Rent</p>
                                      <p className="text-sm font-bold font-mono">{formatUGX(req.rent_amount)}</p>
                                    </div>
                                    <div className="bg-background rounded-lg p-2.5 text-center">
                                      <p className="text-[10px] text-muted-foreground">Daily</p>
                                      <p className="text-sm font-bold text-primary font-mono">{formatUGX(req.daily_repayment)}</p>
                                    </div>
                                    <div className="bg-background rounded-lg p-2.5 text-center">
                                      <p className="text-[10px] text-muted-foreground">Paid so far</p>
                                      <p className="text-sm font-bold text-success font-mono">{formatUGX(req.amount_repaid)}</p>
                                    </div>
                                    <div className="bg-background rounded-lg p-2.5 text-center">
                                      <p className="text-[10px] text-muted-foreground">Still owes</p>
                                      <p className={`text-sm font-bold font-mono ${owing > 0 ? 'text-destructive' : 'text-success'}`}>
                                        {owing > 0 ? formatUGX(owing) : 'Paid up ✓'}
                                      </p>
                                    </div>
                                  </div>

                                  {/* Progress bar */}
                                  <div>
                                    <div className="flex justify-between text-[10px] text-muted-foreground mb-1">
                                      <span>{req.duration_days} days</span>
                                      <span className="font-bold">{progress.toFixed(0)}%</span>
                                    </div>
                                    <div className="h-2 rounded-full bg-muted overflow-hidden">
                                      <motion.div
                                        initial={{ width: 0 }}
                                        animate={{ width: `${progress}%` }}
                                        transition={{ duration: 0.5, ease: 'easeOut' }}
                                        className={`h-full rounded-full ${progress >= 100 ? 'bg-success' : progress < 30 ? 'bg-destructive' : 'bg-primary'}`}
                                      />
                                    </div>
                                  </div>

                                  {/* Collect button — prominent if owing */}
                                  {owing > 0 && (
                                    <button
                                      onClick={() => {
                                        setCollectTarget({ tenant, reqId: req.id, owing });
                                        setCollectDialogOpen(true);
                                      }}
                                      className="relative z-20 flex items-center justify-center gap-2 h-12 rounded-xl bg-success text-success-foreground font-bold text-sm active:scale-95 transition-transform w-full shadow-sm cursor-pointer"
                                      style={{ touchAction: 'manipulation' }}
                                    >
                                      <Banknote className="h-5 w-5" />
                                      Collect Payment — {formatUGX(owing)}
                                    </button>
                                  )}

                                  {/* 2×2 Action Buttons */}
                                  <div className="grid grid-cols-2 gap-2">
                                    <a
                                      href={`tel:${tenant.phone}`}
                                      className="flex items-center justify-center gap-2 h-11 rounded-xl bg-success/10 text-success font-semibold text-sm active:scale-95 transition-transform"
                                      style={{ touchAction: 'manipulation' }}
                                    >
                                      <PhoneCall className="h-4 w-4" />
                                      Call
                                    </a>
                                    <button
                                      onClick={() => handleShareWhatsApp(tenant, req)}
                                      className="flex items-center justify-center gap-2 h-11 rounded-xl bg-primary/10 text-primary font-semibold text-sm active:scale-95 transition-transform"
                                      style={{ touchAction: 'manipulation' }}
                                    >
                                      <MessageCircle className="h-4 w-4" />
                                      WhatsApp
                                    </button>
                                    <button
                                      onClick={() => handleDownloadPdf(tenant, req)}
                                      className="flex items-center justify-center gap-2 h-11 rounded-xl bg-muted text-foreground font-semibold text-sm active:scale-95 transition-transform"
                                      style={{ touchAction: 'manipulation' }}
                                    >
                                      <FileDown className="h-4 w-4" />
                                      PDF
                                    </button>
                                    {req.status === 'completed' ? (
                                      <button
                                        onClick={() => handleRenew(tenant, req)}
                                        disabled={renewingReqId === req.id}
                                        className="flex items-center justify-center gap-2 h-11 rounded-xl bg-primary text-primary-foreground font-semibold text-sm active:scale-95 transition-transform disabled:opacity-60"
                                        style={{ touchAction: 'manipulation' }}
                                      >
                                        {renewingReqId === req.id ? (
                                          <Loader2 className="h-4 w-4 animate-spin" />
                                        ) : (
                                          <RefreshCw className="h-4 w-4" />
                                        )}
                                        {renewingReqId === req.id ? 'Renewing…' : 'Renew'}
                                      </button>
                                    ) : (
                                      <button
                                        onClick={() => {
                                          downloadRentStatement({
                                            tenantName: tenant.full_name, tenantPhone: tenant.phone,
                                            landlordName: req.landlord?.name || 'N/A', propertyAddress: req.landlord?.property_address,
                                            rentAmount: req.rent_amount, totalRepayment: req.total_repayment,
                                            amountRepaid: req.amount_repaid, dailyRepayment: req.daily_repayment,
                                            durationDays: req.duration_days, status: req.status || 'approved',
                                            createdAt: req.created_at, requestId: req.id,
                                          });
                                        }}
                                        className="flex items-center justify-center gap-2 h-11 rounded-xl bg-muted text-foreground font-semibold text-sm active:scale-95 transition-transform"
                                        style={{ touchAction: 'manipulation' }}
                                      >
                                        <FileDown className="h-4 w-4" />
                                        Receipt
                                      </button>
                                    )}
                                  {/* Behavior Card button */}
                                  <button
                                    onClick={() => {
                                      const totalPayments = req.duration_days;
                                      const paidDays = req.daily_repayment > 0 ? Math.floor(req.amount_repaid / req.daily_repayment) : 0;
                                      setBehaviorData({
                                        tenantName: tenant.full_name,
                                        tenantPhone: tenant.phone,
                                        landlordName: req.landlord?.name || 'N/A',
                                        propertyAddress: req.landlord?.property_address || 'N/A',
                                        houseCategory: req.landlord?.house_category || '',
                                        rentAmount: req.rent_amount,
                                        totalRepayment: req.total_repayment,
                                        amountRepaid: req.amount_repaid,
                                        durationDays: req.duration_days,
                                        status: req.status || 'approved',
                                        createdAt: req.created_at,
                                        onTimePayments: paidDays,
                                        latePayments: 0,
                                        missedPayments: Math.max(0, totalPayments - paidDays),
                                      });
                                      setBehaviorCardOpen(true);
                                    }}
                                    className="flex items-center justify-center gap-2 h-10 rounded-xl bg-primary/10 text-primary font-semibold text-xs active:scale-95 transition-transform w-full"
                                    style={{ touchAction: 'manipulation' }}
                                  >
                                    <TrendingUp className="h-4 w-4" />
                                    Share Behavior Card
                                  </button>
                                  {/* Mark this tenant as not funded — reverses a recent float allocation */}
                                  <button
                                    onClick={() =>
                                      setNotFundedTarget({ tenantName: tenant.full_name, reqId: req.id })
                                    }
                                    className="flex items-center justify-center gap-2 h-10 rounded-xl bg-destructive/10 text-destructive font-semibold text-xs active:scale-95 transition-transform w-full"
                                    style={{ touchAction: 'manipulation' }}
                                  >
                                    <AlertCircle className="h-4 w-4" />
                                    Mark not funded
                                  </button>
                                </div>
                                </div>
                              );
                            })
                          )}
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              ) };
            });

            if (!groupByProperty) {
              return tenantCards.map(c => c.el);
            }

            // Group cards by property address. Tenants without a property
            // fall into a single "No property assigned" bucket so nothing is hidden.
            const groups = new Map<string, typeof tenantCards>();
            for (const c of tenantCards) {
              const key = tenantContext[c.tenant.id]?.propertyAddress?.trim() || 'No property assigned';
              if (!groups.has(key)) groups.set(key, []);
              groups.get(key)!.push(c);
            }

            return Array.from(groups.entries())
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([property, items]) => {
                const isCollapsed = collapsedGroups.has(property);
                const groupOwing = items.reduce((s, c) => s + (tenantBalances[c.tenant.id] || 0), 0);
                const groupDaily = items.reduce((s, c) => s + (tenantDaily[c.tenant.id] || 0), 0);
                return (
                  <div key={property} className="rounded-2xl border border-border/60 bg-muted/20 overflow-hidden">
                    <button
                      onClick={() => toggleGroup(property)}
                      className="w-full flex items-center gap-3 px-3.5 py-3 text-left active:bg-muted/40 transition-colors"
                      style={{ touchAction: 'manipulation', minHeight: '56px' }}
                      aria-expanded={!isCollapsed}
                    >
                      <div className="h-9 w-9 rounded-xl bg-primary/10 text-primary flex items-center justify-center shrink-0">
                        <Building2 className="h-4 w-4" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-bold truncate leading-tight">{property}</p>
                        <p className="text-[11px] text-muted-foreground truncate mt-0.5">
                          {items.length} tenant{items.length !== 1 ? 's' : ''}
                          {groupDaily > 0 && <> · {formatUGX(groupDaily)}/day expected</>}
                        </p>
                      </div>
                      <div className="text-right shrink-0">
                        <p className="text-[10px] text-muted-foreground uppercase tracking-wider leading-none">Owing</p>
                        <p className={`text-sm font-bold font-mono leading-tight ${groupOwing > 0 ? 'text-rose-600' : 'text-emerald-600'}`}>
                          {groupOwing > 0 ? formatUGX(groupOwing) : 'UGX 0'}
                        </p>
                      </div>
                      {isCollapsed
                        ? <ArrowDown className="h-4 w-4 text-muted-foreground shrink-0" />
                        : <ArrowUp className="h-4 w-4 text-muted-foreground shrink-0" />}
                    </button>
                    {!isCollapsed && (
                      <div className="p-2 pt-0 space-y-2 bg-background/40">
                        {items.map(c => c.el)}
                      </div>
                    )}
                  </div>
                );
              });
          })()}
        </div>
        )}
        </>
        )}
      </SheetContent>

      <AgentRentRequestDialog
        open={renewDialogOpen}
        onOpenChange={(open) => {
          setRenewDialogOpen(open);
          if (!open) setRenewPrefill(null);
        }}
        onSuccess={() => {
          setRenewDialogOpen(false);
          setRenewPrefill(null);
          fetchTenants();
        }}
        prefillTenantName={renewPrefill?.name}
        prefillTenantPhone={renewPrefill?.phone}
        prefillRentAmount={renewPrefill?.amount}
      />

      <AgentTenantCollectDialog
        open={collectDialogOpen}
        onOpenChange={(open) => {
          setCollectDialogOpen(open);
          if (!open) setCollectTarget(null);
        }}
        tenant={collectTarget ? { id: collectTarget.tenant.id, full_name: collectTarget.tenant.full_name, phone: collectTarget.tenant.phone } : null}
        rentRequestId={collectTarget?.reqId || ''}
        outstandingBalance={collectTarget?.owing || 0}
        onSuccess={() => {
          setCollectDialogOpen(false);
          setCollectTarget(null);
          // Refresh tenant data to show updated balances
          setTenantRequests(prev => {
            const updated = { ...prev };
            if (collectTarget) delete updated[collectTarget.tenant.id];
            return updated;
          });
          fetchTenants();
        }}
      />
      <TenantBehaviorCard
        open={behaviorCardOpen}
        onOpenChange={setBehaviorCardOpen}
        data={behaviorData}
      />
      <TenantFieldCollectDialog
        open={!!fieldCollectTarget}
        onOpenChange={(open) => { if (!open) setFieldCollectTarget(null); }}
        tenantId={fieldCollectTarget?.id || ''}
        tenantName={fieldCollectTarget?.full_name || ''}
        tenantPhone={fieldCollectTarget?.phone || null}
      />
      {/* Bulk collect confirmation — pictures + big numbers, minimal reading */}
      <Dialog open={bulkConfirmOpen} onOpenChange={(o) => { if (!bulkSaving) setBulkConfirmOpen(o); }}>
        <DialogContent className="max-w-sm rounded-3xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <CheckCircle2 className="h-6 w-6 text-emerald-600" />
              {tr('markNPaid', { n: bulkPayableTenants.length })}
            </DialogTitle>
            <DialogDescription>
              {tr('recordsFull')}
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-2xl bg-emerald-50 border border-emerald-200 p-4 text-center">
            <p className="text-[11px] uppercase tracking-wide font-bold text-emerald-700">{tr('totalToRecord')}</p>
            <p className="text-3xl font-extrabold font-mono text-emerald-700 leading-none mt-1">{formatUGX(bulkTotal)}</p>
          </div>
          <div className="grid grid-cols-2 gap-2.5 mt-1">
            <Button
              variant="outline"
              onClick={() => setBulkConfirmOpen(false)}
              disabled={bulkSaving}
              className="h-14 text-base font-bold rounded-2xl gap-2"
            >
              <X className="h-5 w-5" />
              {tr('cancel')}
            </Button>
            <Button
              onClick={handleBulkCollect}
              disabled={bulkSaving || bulkPayableTenants.length === 0}
              className="h-14 text-base font-bold rounded-2xl gap-2 bg-emerald-600 hover:bg-emerald-700 text-white"
            >
              {bulkSaving ? <Loader2 className="h-5 w-5 animate-spin" /> : <CheckCircle2 className="h-6 w-6" />}
              {tr('confirm')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <MarkNotFundedDialog
        open={!!notFundedTarget}
        onOpenChange={(open) => { if (!open) setNotFundedTarget(null); }}
        tenantName={notFundedTarget?.tenantName || ''}
        rentRequestId={notFundedTarget?.reqId || ''}
        onReversed={() => {
          setTenantRequests({});
          fetchTenants();
        }}
      />

      {/* Balance Breakdown Dialog */}
      <Dialog open={showBalanceBreakdown} onOpenChange={setShowBalanceBreakdown}>
        <DialogContent stable className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertCircle className="h-5 w-5 text-rose-500" />
              Tenant Balance Breakdown
            </DialogTitle>
            <DialogDescription>
              Total owed: {formatUGX(stats.totalOwing)} from {stats.owingCount} tenant{stats.owingCount !== 1 ? 's' : ''}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 max-h-[60vh] overflow-y-auto pr-1">
            {(() => {
              const breakdown = tenants
                .filter((t) => (tenantBalances[t.id] || 0) > 0)
                .map((t) => ({ id: t.id, name: t.full_name, balance: tenantBalances[t.id] || 0 }))
                .sort((a, b) => b.balance - a.balance);
              if (breakdown.length === 0) {
                return <p className="text-sm text-muted-foreground text-center py-4">No outstanding balances</p>;
              }
              return breakdown.map((t, i) => (
                <div
                  key={t.id}
                  className="flex items-center justify-between gap-3 px-3 py-2.5 rounded-xl bg-muted/40"
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <div className="h-8 w-8 rounded-lg bg-rose-100 text-rose-600 flex items-center justify-center text-xs font-bold shrink-0">
                      {i + 1}
                    </div>
                    <span className="text-sm font-medium truncate">{t.name}</span>
                  </div>
                  <span className="text-sm font-bold text-rose-600 font-mono shrink-1">
                    {formatUGX(t.balance)}
                  </span>
                </div>
              ));
            })()}
          </div>
          {stats.totalOwing > 0 && (
            <div className="pt-2 border-t border-border flex items-center justify-between">
              <span className="text-sm font-medium">Total</span>
              <span className="text-base font-bold text-rose-600 font-mono">{formatUGX(stats.totalOwing)}</span>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <AgentAdvanceRequestForm
        open={applyAdvanceOpen}
        onOpenChange={setApplyAdvanceOpen}
      />
    </Sheet>
  );
}
