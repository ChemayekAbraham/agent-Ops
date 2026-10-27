import { useCallback, useEffect, useMemo, useState } from 'react';
import { format, formatDistanceToNow } from 'date-fns';
import { toast } from 'sonner';
import {
  AlertTriangle,
  ArrowUpDown,
  CalendarClock,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock,
  Copy,
  Filter,
  Loader2,
  MapPin,
  MessageCircle,
  Phone,
  PhoneCall,
  PhoneForwarded,
  PhoneMissed,
  RefreshCw,
  Search,
  ShieldCheck,
  UserCheck,
  Users,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { formatUGX } from '@/lib/rentCalculations';
import { toWhatsAppUrl } from '@/components/ops/ContactActions';
import { useAuth } from '@/hooks/useAuth';
import { telHref } from '@/lib/awarenessCallLabels';
import {
  HUB_RESULT_LABELS,
  HUB_STATUS_LABELS,
  formatHubError,
  useHubReturnFromCall,
  useLandlordHubList,
  useLandlordHubStartDial,
  useLandlordHubStats,
  useLandlordHubTabCounts,
  useMyStartedDials,
  type LandlordHubRow,
  type LandlordHubScope,
  type LandlordHubSort,
  type LandlordHubStartedDial,
  type LandlordHubTab,
  type LandlordHubTenantPlan,
  type LandlordHubVerifiedFilter,
} from '@/hooks/useLandlordCallingHub';
import { LandlordCallingHubCard } from './LandlordCallingHubCard';
import { LandlordCallingHubRecordDialog } from './LandlordCallingHubRecordDialog';

const PAGE_SIZE = 50;

const SCOPES: { value: LandlordHubScope; label: string }[] = [
  { value: 'live_plans', label: 'Live Rent Plans' },
  { value: 'with_plans', label: 'With Rent Plans' },
  { value: 'all', label: 'All landlords' },
];

const TABS: { value: LandlordHubTab; label: string }[] = [
  { value: 'to_call', label: 'To call' },
  { value: 'call_back', label: 'Call back' },
  { value: 'answered', label: 'Answered' },
  { value: 'not_answered', label: 'Not answered' },
  { value: 'all', label: 'All' },
];

const SORTS: { value: LandlordHubSort; label: string }[] = [
  { value: 'rent_plan_value', label: 'Rent Plan value' },
  { value: 'last_called', label: 'Last called' },
  { value: 'call_back_due', label: 'Call-back due' },
];

function statusBadgeVariant(
  status: LandlordHubRow['hub_status'],
): 'default' | 'secondary' | 'outline' | 'destructive' {
  switch (status) {
    case 'answered':
      return 'default';
    case 'call_back':
      return 'secondary';
    case 'not_answered':
      return 'outline';
    case 'never_called':
    default:
      return 'outline';
  }
}

export function LandlordCallingHub() {
  const { user } = useAuth();

  // Filter, Scope, Tab, Sort, and Pagination state
  const [scope, setScope] = useState<LandlordHubScope>('live_plans');
  const [tab, setTab] = useState<LandlordHubTab>('to_call');
  const [searchInput, setSearchInput] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [region, setRegion] = useState('');
  const [district, setDistrict] = useState('');
  const [agent, setAgent] = useState('');
  const [verified, setVerified] = useState<LandlordHubVerifiedFilter>('all');
  const [sort, setSort] = useState<LandlordHubSort>('rent_plan_value');
  const [page, setPage] = useState(0);
  const [showFilters, setShowFilters] = useState(false);

  // Selected landlord card & active dial / record dialog state
  const [selectedLandlordKey, setSelectedLandlordKey] = useState<string | null>(null);
  const [activeDial, setActiveDial] = useState<LandlordHubStartedDial | null>(null);
  const [showStartedDialsList, setShowStartedDialsList] = useState(false);
  const [dialRefusalBanner, setDialRefusalBanner] = useState<{
    landlordKey: string;
    landlordName: string;
    message: string;
  } | null>(null);

  const [recordDialogState, setRecordDialogState] = useState<{
    open: boolean;
    landlordKey: string;
    landlordId?: string | null;
    landlordName: string;
    phone: string;
    dialId?: string | null;
    dialStartedAt?: string | null;
    manualMode?: boolean;
    tenantPlans?: LandlordHubTenantPlan[];
  }>({
    open: false,
    landlordKey: '',
    landlordName: '',
    phone: '',
  });

  // Debounce search input
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedSearch(searchInput.trim());
      setPage(0);
    }, 220);
    return () => window.clearTimeout(timer);
  }, [searchInput]);

  // Keep sort aligned when switching to Call back tab
  const effectiveSort: LandlordHubSort =
    tab === 'call_back' ? 'call_back_due' : sort;

  // Queries
  const statsQuery = useLandlordHubStats();
  const listQuery = useLandlordHubList({
    scope,
    tab,
    search: debouncedSearch,
    region,
    district,
    agent,
    verified,
    sort: effectiveSort,
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE,
  });
  const tabCountsQuery = useLandlordHubTabCounts({
    scope,
    search: debouncedSearch,
    region,
    district,
    agent,
    verified,
  });
  const startedDials = useMyStartedDials();
  const startDialMutation = useLandlordHubStartDial();

  const rows = listQuery.data?.rows ?? [];
  const totalCount = listQuery.data?.totalCount ?? 0;

  // Selected row from current page (or fallback stub if opened via recovery list)
  const selectedRow = useMemo<LandlordHubRow | null>(() => {
    if (!selectedLandlordKey) return null;
    const found = rows.find((r) => r.landlord_key === selectedLandlordKey);
    if (found) return found;
    return {
      landlord_key: selectedLandlordKey,
      landlord_id: null,
      user_id: null,
      landlord_name: 'Landlord',
      phone: '—',
      phone_masked: false,
      region: null,
      district: null,
      agent_id: null,
      agent_name: null,
      verified: false,
      verification_status: null,
      houses_count: 0,
      live_rent_plans: 0,
      rent_plan_value: 0,
      last_call_at: null,
      last_result: null,
      last_caller_id: null,
      last_caller_name: null,
      call_back_due_at: null,
      call_back_overdue: false,
      being_called_by_id: null,
      being_called_by: null,
      being_called_since: null,
      hub_status: 'never_called',
      needs_review: false,
      total_count: 0,
    };
  }, [selectedLandlordKey, rows]);

  // Open the record form automatically when returning from the phone dialer
  const handleReturnFromCall = useCallback((dial: LandlordHubStartedDial) => {
    setRecordDialogState({
      open: true,
      landlordKey: dial.landlord_key,
      landlordId: dial.landlord_id ?? null,
      landlordName: dial.landlord_name,
      phone: dial.phone,
      dialId: dial.dial_id,
      dialStartedAt: dial.started_at,
      manualMode: false,
    });
    setActiveDial(null);
  }, []);

  useHubReturnFromCall(activeDial, handleReturnFromCall);

  const handleRowDial = async (row: LandlordHubRow) => {
    setDialRefusalBanner(null);
    const phoneToCall = row.phone;
    const hasPhone =
      Boolean(phoneToCall) &&
      phoneToCall !== '—' &&
      !phoneToCall.includes('*') &&
      phoneToCall.replace(/\D/g, '').length >= 7;

    if (!hasPhone) {
      setSelectedLandlordKey(row.landlord_key);
      return;
    }

    try {
      const resp = await startDialMutation.mutateAsync({
        landlordKey: row.landlord_key,
        phone: phoneToCall,
        landlordName: row.landlord_name,
        landlordId: row.landlord_id,
      });

      const started: LandlordHubStartedDial = {
        dial_id: resp.dial_id,
        landlord_key: resp.landlord_key || row.landlord_key,
        landlord_id: row.landlord_id,
        landlord_name: row.landlord_name,
        phone: resp.phone || phoneToCall,
        started_at: resp.started_at || new Date().toISOString(),
        expires_at: resp.expires_at,
      };
      setActiveDial(started);

      const href = telHref(phoneToCall);
      if (
        href &&
        typeof window !== 'undefined' &&
        !/jsdom/i.test(window.navigator?.userAgent || '')
      ) {
        try {
          window.location.href = href;
        } catch {
          // ignore navigation error in test environments
        }
      }
    } catch (err) {
      const msg = formatHubError(err);
      setDialRefusalBanner({
        landlordKey: row.landlord_key,
        landlordName: row.landlord_name,
        message: msg,
      });
      toast.error(msg);
    }
  };

  const handleCopyNumber = async (phoneToCopy: string) => {
    if (!phoneToCopy || phoneToCopy === '—') return;
    try {
      await navigator.clipboard.writeText(phoneToCopy);
      toast.success(`Copied ${phoneToCopy}`);
    } catch {
      toast.error('Could not copy phone number');
    }
  };

  const handleRefreshAll = () => {
    statsQuery.refetch();
    listQuery.refetch();
    tabCountsQuery.refetch();
    startedDials.refetch();
  };

  const clearFilters = () => {
    setSearchInput('');
    setDebouncedSearch('');
    setRegion('');
    setDistrict('');
    setAgent('');
    setVerified('all');
    setPage(0);
  };

  const hasActiveFilters = Boolean(
    debouncedSearch || region || district || agent || verified !== 'all',
  );

  // Paging calculations ("Showing 1 to 50 of N")
  const showingFrom = totalCount === 0 ? 0 : page * PAGE_SIZE + 1;
  const showingTo = Math.min((page + 1) * PAGE_SIZE, totalCount);
  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));

  const stats = statsQuery.data;
  const tabCounts = tabCountsQuery.data;

  return (
    <div
      data-testid="landlord-calling-hub"
      className="mx-auto w-full max-w-6xl space-y-4 px-3 py-3 sm:px-6 sm:py-5"
    >
      {/* Header Bar */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
        <div>
          <h1 className="text-lg sm:text-xl font-bold text-foreground tracking-tight">
            Landlord Calling Hub
          </h1>
          <p className="text-xs text-muted-foreground">
            Call landlords with live Rent Plans, confirm awareness and payout details, and record every outcome.
          </p>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid="hub-started-dials-toggle"
            className="min-h-[44px] text-xs gap-1.5"
            onClick={() => setShowStartedDialsList((v) => !v)}
          >
            <Clock className="h-3.5 w-3.5 text-primary" />
            Calls I started
            {startedDials.dials.length > 0 && (
              <Badge variant="default" className="text-xs ml-0.5">
                {startedDials.dials.length}
              </Badge>
            )}
          </Button>

          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid="hub-refresh-btn"
            className="min-h-[44px] text-xs gap-1.5"
            onClick={handleRefreshAll}
          >
            <RefreshCw
              className={cn(
                'h-3.5 w-3.5',
                (listQuery.isFetching || statsQuery.isFetching) && 'animate-spin',
              )}
            />
            Refresh
          </Button>
        </div>
      </div>

      {/* Top Strip of Clickable Stats */}
      <div
        data-testid="hub-stats-strip"
        className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2"
      >
        <button
          type="button"
          data-testid="hub-stat-calls-today"
          onClick={() => {
            setTab('all');
            setSort('last_called');
            setPage(0);
          }}
          className="min-h-[68px] rounded-xl border border-border bg-card hover:bg-muted/40 p-3 text-left transition-colors"
        >
          <div className="text-xs text-muted-foreground">Calls today</div>
          <div className="text-lg font-bold tabular-nums text-foreground mt-0.5">
            {statsQuery.isLoading ? '…' : (stats?.calls_today ?? 0).toLocaleString()}
          </div>
          <div className="text-xs text-muted-foreground">
            {stats?.answered_today ?? 0} answered today
          </div>
        </button>

        <button
          type="button"
          data-testid="hub-stat-answered-rate"
          onClick={() => {
            setTab('answered');
            setPage(0);
          }}
          className="min-h-[68px] rounded-xl border border-border bg-card hover:bg-muted/40 p-3 text-left transition-colors"
        >
          <div className="text-xs text-muted-foreground">Answered rate</div>
          <div className="text-lg font-bold tabular-nums text-emerald-700 dark:text-emerald-400 mt-0.5">
            {statsQuery.isLoading ? '…' : `${stats?.answered_rate_pct ?? 0}%`}
          </div>
          <div className="text-xs text-muted-foreground">Tap to view answered</div>
        </button>

        <button
          type="button"
          data-testid="hub-stat-callbacks-due"
          onClick={() => {
            setTab('call_back');
            setSort('call_back_due');
            setPage(0);
          }}
          className={cn(
            'min-h-[68px] rounded-xl border p-3 text-left transition-colors',
            (stats?.call_backs_overdue ?? 0) > 0
              ? 'border-destructive/50 bg-destructive/5 hover:bg-destructive/10'
              : 'border-border bg-card hover:bg-muted/40',
          )}
        >
          <div className="text-xs text-muted-foreground">Call backs due</div>
          <div className="flex items-baseline gap-1.5 mt-0.5">
            <span className="text-lg font-bold tabular-nums text-foreground">
              {statsQuery.isLoading ? '…' : (stats?.call_backs_due ?? 0).toLocaleString()}
            </span>
            {(stats?.call_backs_overdue ?? 0) > 0 && (
              <Badge variant="destructive" className="text-xs">
                {stats?.call_backs_overdue} overdue
              </Badge>
            )}
          </div>
          <div className="text-xs text-muted-foreground">Tap to open Call back</div>
        </button>

        <button
          type="button"
          data-testid="hub-stat-never-called"
          onClick={() => {
            setScope('live_plans');
            setTab('to_call');
            setSort('rent_plan_value');
            setPage(0);
          }}
          className="min-h-[68px] rounded-xl border border-border bg-card hover:bg-muted/40 p-3 text-left transition-colors"
        >
          <div className="text-xs text-muted-foreground">
            Live Rent Plan never called
          </div>
          <div className="text-lg font-bold tabular-nums text-foreground mt-0.5">
            {statsQuery.isLoading
              ? '…'
              : (stats?.live_plan_landlords_never_called ?? 0).toLocaleString()}
          </div>
          <div className="text-xs text-muted-foreground">
            of {(stats?.live_plan_landlords_total ?? 0).toLocaleString()} with live Rent Plans
          </div>
        </button>

        <button
          type="button"
          data-testid="hub-stat-reached-week"
          onClick={() => {
            setTab('answered');
            setSort('last_called');
            setPage(0);
          }}
          className="min-h-[68px] col-span-2 sm:col-span-1 rounded-xl border border-border bg-card hover:bg-muted/40 p-3 text-left transition-colors"
        >
          <div className="text-xs text-muted-foreground">Reached this week</div>
          <div className="text-lg font-bold tabular-nums text-foreground mt-0.5">
            {statsQuery.isLoading
              ? '…'
              : (stats?.landlords_reached_this_week ?? 0).toLocaleString()}
          </div>
          <div className="text-xs text-muted-foreground">Distinct landlords</div>
        </button>
      </div>

      {/* Dial Refusal Alert Banner */}
      {dialRefusalBanner && (
        <div
          role="alert"
          data-testid="hub-dial-refusal-banner"
          className="flex items-start justify-between gap-3 rounded-xl border border-destructive/40 bg-destructive/10 p-3.5 text-xs text-destructive"
        >
          <div className="space-y-0.5">
            <div className="font-bold">
              Cannot dial {dialRefusalBanner.landlordName} right now
            </div>
            <div>{dialRefusalBanner.message}</div>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="min-h-[44px] text-xs"
            onClick={() => setDialRefusalBanner(null)}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      )}

      {/* "Calls I started" Recovery Panel */}
      {(showStartedDialsList || startedDials.dials.length > 0) && (
        <div
          data-testid="hub-started-dials-panel"
          className="rounded-xl border border-primary/30 bg-primary/5 p-3.5 space-y-2.5"
        >
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="flex items-center gap-2 text-xs font-bold text-foreground">
              <PhoneCall className="h-4 w-4 text-primary" />
              Calls I started ({startedDials.dials.length})
            </div>
            <span className="text-xs text-muted-foreground">
              Tap Record outcome to finish logging any unrecorded call
            </span>
          </div>

          {startedDials.dials.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              You have no unrecorded calls waiting right now.
            </p>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {startedDials.dials.map((dial) => (
                <div
                  key={`${dial.landlord_key}-${dial.started_at}`}
                  data-testid={`hub-started-dial-${dial.landlord_key}`}
                  className="flex items-center justify-between gap-2 rounded-lg border border-border bg-card p-2.5 text-xs"
                >
                  <div className="min-w-0">
                    <div className="font-semibold text-foreground truncate">
                      {dial.landlord_name}
                    </div>
                    <div className="text-xs text-muted-foreground font-mono truncate">
                      {dial.phone} · started{' '}
                      {format(new Date(dial.started_at), 'HH:mm')}
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <Button
                      type="button"
                      size="sm"
                      data-testid={`hub-recover-dial-btn-${dial.landlord_key}`}
                      className="min-h-[44px] text-xs font-semibold"
                      onClick={() =>
                        setRecordDialogState({
                          open: true,
                          landlordKey: dial.landlord_key,
                          landlordId: dial.landlord_id ?? null,
                          landlordName: dial.landlord_name,
                          phone: dial.phone,
                          dialId: dial.dial_id,
                          dialStartedAt: dial.started_at,
                          manualMode: false,
                        })
                      }
                    >
                      Record outcome
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Scope Switch & Controls */}
      <div className="rounded-xl border border-border bg-card p-3 space-y-3">
        {/* Scope Switch */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
          <div
            role="group"
            aria-label="Landlord scope"
            className="grid grid-cols-3 gap-1.5 rounded-xl bg-muted p-1"
          >
            {SCOPES.map((s) => (
              <button
                key={s.value}
                type="button"
                data-testid={`hub-scope-${s.value}`}
                onClick={() => {
                  setScope(s.value);
                  setPage(0);
                }}
                className={cn(
                  'min-h-[44px] rounded-lg px-2.5 py-1.5 text-xs font-semibold transition-colors',
                  scope === s.value
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {s.label}
              </button>
            ))}
          </div>

          {/* Sort & Filter Toggle */}
          <div className="flex items-center gap-2 flex-wrap">
            <div className="flex items-center gap-1.5 text-xs">
              <ArrowUpDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              <span className="text-muted-foreground">Sort:</span>
              {SORTS.map((s) => (
                <button
                  key={s.value}
                  type="button"
                  data-testid={`hub-sort-${s.value}`}
                  onClick={() => {
                    setSort(s.value);
                    setPage(0);
                  }}
                  className={cn(
                    'min-h-[44px] rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors',
                    effectiveSort === s.value
                      ? 'border-primary bg-primary/10 text-primary font-semibold'
                      : 'border-border bg-background text-muted-foreground hover:text-foreground',
                  )}
                >
                  {s.label}
                </button>
              ))}
            </div>

            <Button
              type="button"
              variant={showFilters || hasActiveFilters ? 'secondary' : 'outline'}
              size="sm"
              data-testid="hub-filters-toggle"
              className="min-h-[44px] text-xs gap-1.5"
              onClick={() => setShowFilters((v) => !v)}
            >
              <Filter className="h-3.5 w-3.5" />
              Filters
              {hasActiveFilters && (
                <Badge variant="default" className="text-xs ml-0.5">
                  Active
                </Badge>
              )}
            </Button>
          </div>
        </div>

        {/* Search Input */}
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            data-testid="hub-search-input"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search landlord name, phone, district, or registering agent..."
            className="min-h-[44px] pl-9 pr-9 text-xs sm:text-sm"
          />
          {searchInput && (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => setSearchInput('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 p-2 text-muted-foreground hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>

        {/* Expandable Region / District / Agent / Verified Filters */}
        {showFilters && (
          <div
            data-testid="hub-filters-panel"
            className="grid grid-cols-1 sm:grid-cols-4 gap-2 pt-2 border-t border-border/60"
          >
            <div>
              <label className="text-xs text-muted-foreground block mb-1">
                Region
              </label>
              <Input
                data-testid="hub-filter-region"
                value={region}
                onChange={(e) => {
                  setRegion(e.target.value);
                  setPage(0);
                }}
                placeholder="e.g. Central"
                className="min-h-[44px] text-xs"
              />
            </div>

            <div>
              <label className="text-xs text-muted-foreground block mb-1">
                District
              </label>
              <Input
                data-testid="hub-filter-district"
                value={district}
                onChange={(e) => {
                  setDistrict(e.target.value);
                  setPage(0);
                }}
                placeholder="e.g. Kampala, Wakiso"
                className="min-h-[44px] text-xs"
              />
            </div>

            <div>
              <label className="text-xs text-muted-foreground block mb-1">
                Registering Agent
              </label>
              <Input
                data-testid="hub-filter-agent"
                value={agent}
                onChange={(e) => {
                  setAgent(e.target.value);
                  setPage(0);
                }}
                placeholder="Agent name"
                className="min-h-[44px] text-xs"
              />
            </div>

            <div>
              <label className="text-xs text-muted-foreground block mb-1">
                Verification
              </label>
              <div className="grid grid-cols-3 gap-1">
                {(['all', 'verified', 'unverified'] as const).map((v) => (
                  <button
                    key={v}
                    type="button"
                    data-testid={`hub-filter-verified-${v}`}
                    onClick={() => {
                      setVerified(v);
                      setPage(0);
                    }}
                    className={cn(
                      'min-h-[44px] rounded-lg border px-2 text-xs font-medium capitalize',
                      verified === v
                        ? 'border-primary bg-primary text-primary-foreground'
                        : 'border-border bg-background text-foreground',
                    )}
                  >
                    {v}
                  </button>
                ))}
              </div>
            </div>

            {hasActiveFilters && (
              <div className="sm:col-span-4 flex justify-end">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  data-testid="hub-clear-filters-btn"
                  className="min-h-[44px] text-xs"
                  onClick={clearFilters}
                >
                  Clear all filters
                </Button>
              </div>
            )}
          </div>
        )}

        {/* Tabs with Server Counts */}
        <div
          role="tablist"
          aria-label="Calling status tabs"
          className="flex items-center gap-1.5 overflow-x-auto pb-1 pt-1"
        >
          {TABS.map((t) => {
            const active = tab === t.value;
            const count = tabCounts?.[t.value];
            return (
              <button
                key={t.value}
                type="button"
                role="tab"
                aria-selected={active}
                data-testid={`hub-tab-${t.value}`}
                onClick={() => {
                  setTab(t.value);
                  if (t.value === 'call_back') {
                    setSort('call_back_due');
                  }
                  setPage(0);
                }}
                className={cn(
                  'min-h-[44px] shrink-0 inline-flex items-center gap-1.5 rounded-xl border px-3 py-2 text-xs font-semibold transition-colors',
                  active
                    ? 'border-primary bg-primary text-primary-foreground shadow-sm'
                    : 'border-border bg-background text-foreground hover:bg-muted',
                )}
              >
                <span>{t.label}</span>
                <span
                  data-testid={`hub-tab-count-${t.value}`}
                  className={cn(
                    'rounded-full px-1.5 py-0.5 text-xs tabular-nums',
                    active
                      ? 'bg-primary-foreground/20 text-primary-foreground'
                      : 'bg-muted text-muted-foreground',
                  )}
                >
                  {typeof count === 'number' ? count.toLocaleString() : '…'}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Paging Summary Bar ("Showing 1 to 50 of N") */}
      <div className="flex items-center justify-between gap-2 flex-wrap text-xs text-muted-foreground px-1">
        <span data-testid="hub-showing-line">
          {totalCount > 0
            ? `Showing ${showingFrom} to ${showingTo} of ${totalCount.toLocaleString()}`
            : 'Showing 0 of 0'}
        </span>

        {totalCount > PAGE_SIZE && (
          <div className="flex items-center gap-1.5">
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid="hub-page-prev"
              disabled={page === 0 || listQuery.isFetching}
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              className="min-h-[44px] text-xs gap-1"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
              Previous
            </Button>
            <span className="text-xs font-medium px-2">
              Page {page + 1} of {totalPages}
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid="hub-page-next"
              disabled={page + 1 >= totalPages || listQuery.isFetching}
              onClick={() => setPage((p) => p + 1)}
              className="min-h-[44px] text-xs gap-1"
            >
              Next
              <ChevronRight className="h-3.5 w-3.5" />
            </Button>
          </div>
        )}
      </div>

      {/* Main List States: Loading Skeletons / Error with Retry / Empty / Rows */}
      {listQuery.isLoading ? (
        <div className="space-y-2.5" data-testid="hub-list-loading">
          {Array.from({ length: 6 }).map((_, idx) => (
            <Skeleton key={idx} className="h-28 w-full rounded-xl" />
          ))}
        </div>
      ) : listQuery.isError ? (
        <div
          role="alert"
          data-testid="hub-list-error"
          className="rounded-xl border border-destructive/40 bg-destructive/10 p-5 text-center space-y-3"
        >
          <p className="text-sm font-semibold text-destructive">
            {formatHubError(listQuery.error)}
          </p>
          <p className="text-xs text-muted-foreground">
            We could not load the landlord calling list right now. Check your connection and try again.
          </p>
          <Button
            type="button"
            variant="outline"
            data-testid="hub-list-retry-btn"
            className="min-h-[44px] text-xs gap-1.5"
            onClick={() => listQuery.refetch()}
          >
            <RefreshCw className="h-4 w-4" />
            Retry
          </Button>
        </div>
      ) : rows.length === 0 ? (
        <div
          data-testid="hub-list-empty"
          className="rounded-xl border border-border bg-card p-8 text-center space-y-2"
        >
          <PhoneCall className="h-8 w-8 text-muted-foreground mx-auto" />
          <p className="text-sm font-bold text-foreground">
            {tab === 'to_call'
              ? 'No landlords waiting to be called in this view'
              : tab === 'call_back'
                ? 'No call backs scheduled in this view'
                : tab === 'answered'
                  ? 'No answered calls match your current filters'
                  : tab === 'not_answered'
                    ? 'No unanswered calls match your current filters'
                    : 'No landlords match your current search or filters'}
          </p>
          <p className="text-xs text-muted-foreground max-w-md mx-auto">
            {hasActiveFilters
              ? 'Try clearing your search or location filters, or switch to another scope.'
              : 'Switch tabs or change the scope above to see more landlords.'}
          </p>
          {hasActiveFilters && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="min-h-[44px] text-xs mt-2"
              onClick={clearFilters}
            >
              Reset filters
            </Button>
          )}
        </div>
      ) : (
        <div className="space-y-2.5" data-testid="hub-list-rows">
          {rows.map((row) => {
            const isCallbackTab = tab === 'call_back';
            const isAnotherOfficersCallback =
              row.hub_status === 'call_back' &&
              Boolean(row.last_caller_id) &&
              Boolean(user?.id) &&
              row.last_caller_id !== user?.id;

            const hasCallablePhone =
              Boolean(row.phone) &&
              row.phone !== '—' &&
              !row.phone.includes('*') &&
              row.phone.replace(/\D/g, '').length >= 7;

            return (
              <div
                key={row.landlord_key}
                data-testid={`hub-row-${row.landlord_key}`}
                onClick={() => setSelectedLandlordKey(row.landlord_key)}
                className={cn(
                  'cursor-pointer rounded-xl border bg-card hover:bg-muted/30 p-3.5 transition-colors space-y-2.5',
                  row.call_back_overdue
                    ? 'border-destructive/50'
                    : 'border-border',
                )}
              >
                {/* Row Top Line: Name, Badges, Rent Plans */}
                <div className="flex items-start justify-between gap-2 flex-wrap">
                  <div className="min-w-0 space-y-1">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="text-sm font-bold text-foreground">
                        {row.landlord_name}
                      </span>

                      {/* Status Badge */}
                      <Badge
                        variant={statusBadgeVariant(row.hub_status)}
                        data-testid={`hub-row-status-${row.landlord_key}`}
                        className="text-xs"
                      >
                        {HUB_STATUS_LABELS[row.hub_status] || row.hub_status}
                      </Badge>

                      {/* Verified / Unverified */}
                      {row.verified && (
                        <Badge variant="outline" className="text-xs">
                          <ShieldCheck className="h-3 w-3 mr-1 text-emerald-600" />
                          Verified
                        </Badge>
                      )}

                      {/* Flagged needs_review badge */}
                      {row.needs_review && (
                        <Badge
                          variant="outline"
                          data-testid={`hub-row-needs-review-${row.landlord_key}`}
                          className="text-xs border-amber-500/50 text-amber-700 dark:text-amber-300"
                        >
                          <AlertTriangle className="h-3 w-3 mr-1" />
                          Needs review
                        </Badge>
                      )}

                      {/* "Being called by Grace" active dial badge */}
                      {row.being_called_by && (
                        <Badge
                          variant="secondary"
                          data-testid={`hub-row-being-called-${row.landlord_key}`}
                          className="text-xs bg-amber-500/15 text-amber-800 dark:text-amber-200 border border-amber-500/30"
                        >
                          <PhoneCall className="h-3 w-3 mr-1 animate-pulse" />
                          Being called by {row.being_called_by}
                        </Badge>
                      )}

                      {/* Call-back due badge (overdue in destructive colour) */}
                      {row.call_back_due_at && (
                        <Badge
                          variant={row.call_back_overdue ? 'destructive' : 'secondary'}
                          data-testid={`hub-row-callback-badge-${row.landlord_key}`}
                          className="text-xs"
                        >
                          <CalendarClock className="h-3 w-3 mr-1" />
                          {row.call_back_overdue ? 'Overdue · ' : 'Due · '}
                          {format(new Date(row.call_back_due_at), 'dd MMM HH:mm')}
                        </Badge>
                      )}
                    </div>

                    {/* District, Region, Phone, Agent */}
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                      <span className="font-mono text-foreground font-medium">
                        {row.phone}
                      </span>
                      {(row.district || row.region) && (
                        <span className="inline-flex items-center gap-1">
                          <MapPin className="h-3 w-3" />
                          {[row.district, row.region].filter(Boolean).join(', ')}
                        </span>
                      )}
                      {row.agent_name && (
                        <span className="inline-flex items-center gap-1">
                          <UserCheck className="h-3 w-3" />
                          Agent: {row.agent_name}
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Rent Plans & Value */}
                  <div className="text-left sm:text-right shrink-0">
                    <div className="text-xs font-semibold text-foreground">
                      {row.live_rent_plans}{' '}
                      {row.live_rent_plans === 1 ? 'live Rent Plan' : 'live Rent Plans'}
                    </div>
                    <div className="text-sm font-bold tabular-nums text-primary">
                      {formatUGX(row.rent_plan_value)}
                    </div>
                  </div>
                </div>

                {/* Row Bottom Line: Last Call Info + Quick Actions */}
                <div
                  className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 pt-2 border-t border-border/60"
                  onClick={(e) => e.stopPropagation()}
                >
                  <div className="text-xs text-muted-foreground">
                    {row.last_call_at ? (
                      <span>
                        Last call:{' '}
                        <strong className="text-foreground">
                          {HUB_RESULT_LABELS[row.last_result || ''] ||
                            row.last_result ||
                            'Called'}
                        </strong>{' '}
                        · {format(new Date(row.last_call_at), 'dd MMM yyyy HH:mm')}{' '}
                        ({formatDistanceToNow(new Date(row.last_call_at), { addSuffix: true })})
                        {row.last_caller_name ? ` by ${row.last_caller_name}` : ''}
                      </span>
                    ) : (
                      <span>Never called through any route</span>
                    )}
                  </div>

                  <div className="flex items-center gap-1.5 flex-wrap">
                    {/* Call Back Tab "Take over" button for another officer's call back */}
                    {(isCallbackTab || row.hub_status === 'call_back') &&
                      isAnotherOfficersCallback && (
                        <Button
                          type="button"
                          variant="secondary"
                          size="sm"
                          data-testid={`hub-row-takeover-${row.landlord_key}`}
                          disabled={!hasCallablePhone || startDialMutation.isPending}
                          onClick={() => handleRowDial(row)}
                          className="min-h-[44px] text-xs font-semibold gap-1.5"
                        >
                          <PhoneForwarded className="h-3.5 w-3.5 text-primary" />
                          Take over
                        </Button>
                      )}

                    {/* Call Button (`tel:` that first calls landlord_hub_start_dial) */}
                    <Button
                      type="button"
                      size="sm"
                      data-testid={`hub-row-call-${row.landlord_key}`}
                      disabled={!hasCallablePhone || startDialMutation.isPending}
                      onClick={() => handleRowDial(row)}
                      className="min-h-[44px] text-xs font-semibold gap-1.5"
                    >
                      <Phone className="h-3.5 w-3.5" />
                      Call
                    </Button>

                    {/* Copy Number Fallback */}
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      data-testid={`hub-row-copy-${row.landlord_key}`}
                      disabled={!row.phone || row.phone === '—'}
                      onClick={() => handleCopyNumber(row.phone)}
                      className="min-h-[44px] text-xs gap-1"
                    >
                      <Copy className="h-3.5 w-3.5" />
                      Copy number
                    </Button>

                    {/* WhatsApp Fallback */}
                    {hasCallablePhone && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        asChild
                        data-testid={`hub-row-whatsapp-${row.landlord_key}`}
                        className="min-h-[44px] text-xs gap-1"
                      >
                        <a
                          href={toWhatsAppUrl(
                            row.phone,
                            `Hello ${row.landlord_name}, this is Welile Landlord Operations.`,
                          )}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          <MessageCircle className="h-3.5 w-3.5 text-emerald-600" />
                          WhatsApp
                        </a>
                      </Button>
                    )}

                    {/* Record Call Made Another Way */}
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      data-testid={`hub-row-record-manual-${row.landlord_key}`}
                      onClick={() =>
                        setRecordDialogState({
                          open: true,
                          landlordKey: row.landlord_key,
                          landlordId: row.landlord_id,
                          landlordName: row.landlord_name,
                          phone: row.phone,
                          manualMode: true,
                        })
                      }
                      className="min-h-[44px] text-xs"
                    >
                      Record outcome
                    </Button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Bottom Pagination Controls */}
      {totalCount > PAGE_SIZE && (
        <div className="flex items-center justify-between gap-2 pt-2 text-xs text-muted-foreground">
          <span>
            Showing {showingFrom} to {showingTo} of {totalCount.toLocaleString()}
          </span>
          <div className="flex items-center gap-1.5">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={page === 0 || listQuery.isFetching}
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              className="min-h-[44px] text-xs"
            >
              Previous
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={page + 1 >= totalPages || listQuery.isFetching}
              onClick={() => setPage((p) => p + 1)}
              className="min-h-[44px] text-xs"
            >
              Next
            </Button>
          </div>
        </div>
      )}

      {/* Landlord Detail Card (Drawer on desktop, full screen on mobile) */}
      <LandlordCallingHubCard
        open={Boolean(selectedLandlordKey)}
        onClose={() => setSelectedLandlordKey(null)}
        row={selectedRow}
        onDialStarted={(dial) => setActiveDial(dial)}
        onOpenRecordDialog={(opts) =>
          setRecordDialogState({
            open: true,
            landlordKey: opts.landlordKey,
            landlordId: opts.landlordId ?? null,
            landlordName: opts.landlordName,
            phone: opts.phone,
            dialId: opts.dialId ?? null,
            dialStartedAt: opts.dialStartedAt ?? null,
            manualMode: opts.manualMode ?? false,
            tenantPlans: opts.tenantPlans ?? [],
          })
        }
      />

      {/* Stepped Call Record Dialog */}
      <LandlordCallingHubRecordDialog
        open={recordDialogState.open}
        onOpenChange={(nextOpen) =>
          setRecordDialogState((prev) => ({ ...prev, open: nextOpen }))
        }
        landlordKey={recordDialogState.landlordKey}
        landlordId={recordDialogState.landlordId}
        landlordName={recordDialogState.landlordName}
        phone={recordDialogState.phone}
        dialId={recordDialogState.dialId}
        dialStartedAt={recordDialogState.dialStartedAt}
        manualMode={recordDialogState.manualMode}
        tenantPlans={recordDialogState.tenantPlans}
      />
    </div>
  );
}

export default LandlordCallingHub;
