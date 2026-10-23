import { useMemo, useState } from 'react';
import { format, formatDistanceToNow } from 'date-fns';
import { toast } from 'sonner';
import {
  Bookmark,
  BookmarkPlus,
  Building2,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock,
  Eye,
  Filter,
  Loader2,
  MapPin,
  Phone,
  RotateCcw,
  Search,
  ShieldCheck,
  Smartphone,
  User,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  type CcCallingHub,
  type CcFilterSelection,
  type CcRow,
  type CcRowState,
} from '@/hooks/useCcCallingHub';
import { CallingPausedNotice } from '@/components/executive/crm/call-centre/CallingPausedNotice';
import { formatUGX } from '@/lib/rentCalculations';
import {
  LandlordRegistryRecord,
  LandlordSavedQueue,
  useLandlordRegistryBatch,
  useLandlordSavedQueues,
  useSaveLandlordQueue,
} from './useLandlordRegistryBatch';
import { CcEmptyState, CcPill, formatHumanLabel } from './ccUi';

export interface LandlordExtraFilters {
  rentPlanStatus: 'all' | 'active' | 'none';
  verification: 'all' | 'verified' | 'unverified';
  lastOutcome: string;
}

const STATE_TABS: Array<{ key: CcRowState | 'all'; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'to_call', label: 'Pending' },
  { key: 'unreachable', label: 'Unreachable' },
  { key: 'callback', label: 'Callback' },
  { key: 'engaged', label: 'Engaged' },
  { key: 'parked', label: 'Parked' },
];

const LAST_OUTCOME_OPTIONS = [
  { value: 'all', label: 'All Last Outcomes' },
  { value: 'never_called', label: 'Never Called' },
  { value: 'reached_ok', label: 'Reached — All Good' },
  { value: 'confirmed_payout_number', label: 'Confirmed Payout Number' },
  { value: 'wants_more_tenants', label: 'Wants More Tenants' },
  { value: 'complaint', label: 'Complaint Raised' },
  { value: 'payout_issue', label: 'Payout Issue' },
  { value: 'engaged', label: 'Engaged' },
  { value: 'no_answer', label: 'No Answer' },
  { value: 'phone_off', label: 'Phone Off' },
  { value: 'wrong_number', label: 'Wrong Number' },
];

export interface LandlordWorkQueuePanelProps {
  hub: CcCallingHub;
  callingPaused: boolean;
  isRevealing: boolean;
  stateFilter: CcRowState | 'all';
  onStateFilterChange: (s: CcRowState | 'all') => void;
  search: string;
  onSearchChange: (s: string) => void;
  filters: CcFilterSelection;
  onFiltersChange: (f: CcFilterSelection) => void;
  extraFilters: LandlordExtraFilters;
  onExtraFiltersChange: (f: LandlordExtraFilters) => void;
  sortKey: string | null;
  onSortKeyChange: (s: string | null) => void;
  page: number;
  pageSize: number;
  onPageChange: (p: number) => void;
  onResetFilters: () => void;
  onDialRow: (row: CcRow) => void;
  onInspectRow: (row: CcRow) => void;
  onOpenTimeline: (row: CcRow, reg?: LandlordRegistryRecord | null) => void;
}

export function LandlordWorkQueuePanel({
  hub,
  callingPaused,
  isRevealing,
  stateFilter,
  onStateFilterChange,
  search,
  onSearchChange,
  filters,
  onFiltersChange,
  extraFilters,
  onExtraFiltersChange,
  sortKey,
  onSortKeyChange,
  page,
  pageSize,
  onPageChange,
  onResetFilters,
  onDialRow,
  onInspectRow,
  onOpenTimeline,
}: LandlordWorkQueuePanelProps) {
  const rawRows = (hub.rows ?? []) as CcRow[];
  const totalCount = hub.total ?? 0;
  const counts = hub.counts;

  // Enrich current page rows with v_landlord_registry_all (houses, Rent Plans, verification, last called date/caller/outcome, user_id)
  const subjectIds = useMemo(() => rawRows.map((r) => r.subject_id), [rawRows]);
  const registryBatch = useLandlordRegistryBatch(subjectIds);
  const registryMap = registryBatch.data ?? {};

  // Saved queues
  const savedQueuesQuery = useLandlordSavedQueues();
  const saveQueueMutation = useSaveLandlordQueue();
  const [selectedQueueId, setSelectedQueueId] = useState<string>('__none__');
  const [saveDialogOpen, setSaveDialogOpen] = useState(false);
  const [queueName, setQueueName] = useState('');
  const [queueShared, setQueueShared] = useState(true);

  const filteredRows = useMemo(() => {
    return rawRows.filter((row) => {
      const reg = registryMap[row.subject_id];
      if (extraFilters.rentPlanStatus === 'active') {
        const plans = reg?.active_rent_plans ?? (Number(row.metric_value ?? 0) > 0 ? 1 : 0);
        if (plans <= 0) return false;
      } else if (extraFilters.rentPlanStatus === 'none') {
        const plans = reg?.active_rent_plans ?? (Number(row.metric_value ?? 0) > 0 ? 1 : 0);
        if (plans > 0) return false;
      }

      if (extraFilters.verification === 'verified') {
        if ((reg?.verification_status ?? 'unverified') !== 'verified') return false;
      } else if (extraFilters.verification === 'unverified') {
        if ((reg?.verification_status ?? 'unverified') === 'verified') return false;
      }

      if (extraFilters.lastOutcome && extraFilters.lastOutcome !== 'all') {
        const lastOut = reg?.last_call_outcome ?? row.feedback_category ?? null;
        if (extraFilters.lastOutcome === 'never_called') {
          if (lastOut || reg?.last_called_at || row.last_attempt_at) return false;
        } else if (lastOut !== extraFilters.lastOutcome) {
          return false;
        }
      }

      return true;
    });
  }, [rawRows, registryMap, extraFilters]);

  const handleApplySavedQueue = (queueId: string) => {
    setSelectedQueueId(queueId);
    if (queueId === '__none__') return;
    const found = (savedQueuesQuery.data ?? []).find((q) => q.id === queueId);
    if (!found) return;
    const saved = found.filters ?? {};
    const {
      __rentPlanStatus,
      __verification,
      __lastOutcome,
      __stateFilter,
      __search,
      ...serverFilters
    } = saved;

    onFiltersChange(serverFilters);
    onExtraFiltersChange({
      rentPlanStatus: __rentPlanStatus ?? 'all',
      verification: __verification ?? 'all',
      lastOutcome: __lastOutcome ?? 'all',
    });
    if (__stateFilter) onStateFilterChange(__stateFilter);
    if (typeof __search === 'string') onSearchChange(__search);
    if (found.sort_key) onSortKeyChange(found.sort_key);
    onPageChange(0);
    toast.success(`Loaded saved queue "${found.name}"`);
  };

  const handleSaveCurrentQueue = async () => {
    if (!queueName.trim()) {
      toast.error('Enter a name for this saved queue.');
      return;
    }
    try {
      const combinedFilters: Record<string, any> = {
        ...filters,
        __rentPlanStatus: extraFilters.rentPlanStatus,
        __verification: extraFilters.verification,
        __lastOutcome: extraFilters.lastOutcome,
        __stateFilter: stateFilter,
        __search: search,
      };
      const saved = await saveQueueMutation.mutateAsync({
        name: queueName.trim(),
        filters: combinedFilters,
        sortKey,
        shared: queueShared,
      });
      toast.success(`Saved queue "${saved.name}"`);
      setSelectedQueueId(saved.id);
      setQueueName('');
      setSaveDialogOpen(false);
    } catch (e: any) {
      toast.error(e?.message || 'Could not save queue');
    }
  };

  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  const sorts = hub.sortOptions ?? [];
  const serverFilterOptions = hub.filterOptions ?? [];

  const totalStateCount =
    (counts?.to_call ?? 0) +
    (counts?.engaged ?? 0) +
    (counts?.unreachable ?? 0) +
    (counts?.parked ?? 0) +
    (counts?.callback ?? 0);

  return (
    <div className="space-y-3">
      <CallingPausedNotice />

      {/* State filter pills */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-1.5 flex-wrap">
          {STATE_TABS.map((t) => {
            const countVal =
              t.key === 'all'
                ? totalStateCount
                : (counts?.[t.key as keyof typeof counts] as number | undefined);
            return (
              <Button
                key={t.key}
                type="button"
                size="sm"
                variant={stateFilter === t.key ? 'default' : 'outline'}
                className="h-8 text-xs gap-1.5"
                onClick={() => {
                  onStateFilterChange(t.key);
                  onPageChange(0);
                }}
              >
                {t.label}
                {typeof countVal === 'number' && (
                  <Badge variant="secondary" className="h-4 px-1 text-[10px] tabular-nums">
                    {countVal}
                  </Badge>
                )}
              </Button>
            );
          })}
        </div>

        {/* Saved Queue Picker + Save Current Queue button */}
        <div className="flex items-center gap-1.5 flex-wrap">
          <Select value={selectedQueueId} onValueChange={handleApplySavedQueue}>
            <SelectTrigger className="h-8 text-xs w-[190px]">
              <Bookmark className="h-3.5 w-3.5 mr-1 text-primary shrink-0" />
              <SelectValue placeholder="Saved Queues…" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__none__">Saved Queues…</SelectItem>
              {(savedQueuesQuery.data ?? []).map((q: LandlordSavedQueue) => (
                <SelectItem key={q.id} value={q.id}>
                  {q.name} {q.shared ? '(Shared)' : '(Mine)'}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-8 text-xs gap-1"
            onClick={() => setSaveDialogOpen(true)}
          >
            <BookmarkPlus className="h-3.5 w-3.5" /> Save Queue
          </Button>
        </div>
      </div>

      {/* Search + Landlord Filters Bar */}
      <Card className="p-3 space-y-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative flex-1 min-w-[220px]">
            <Search className="h-3.5 w-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => {
                onSearchChange(e.target.value);
                onPageChange(0);
              }}
              placeholder="Search landlord by name, phone, district, or registering agent…"
              className="pl-8 h-8 text-xs"
            />
          </div>

          <Select
            value={sortKey || hub.effectiveSortKey || '__default__'}
            onValueChange={(v) => {
              onSortKeyChange(v === '__default__' ? null : v);
              onPageChange(0);
            }}
          >
            <SelectTrigger className="h-8 text-xs w-[195px]">
              <SelectValue placeholder="Sort Landlords…" />
            </SelectTrigger>
            <SelectContent>
              {sorts.map((s) => (
                <SelectItem key={s.key} value={s.key}>
                  Sort: {s.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-8 text-xs gap-1"
            onClick={() => {
              setSelectedQueueId('__none__');
              onResetFilters();
            }}
          >
            <RotateCcw className="h-3.5 w-3.5" /> Reset
          </Button>
        </div>

        {/* Filter dropdowns: Region, District, Agent, Rent Plan Status, Verification, Last Outcome */}
        <div className="flex flex-wrap items-center gap-2 pt-1 border-t border-border/50">
          <span className="inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground mr-1">
            <Filter className="h-3 w-3" /> Filters:
          </span>

          {serverFilterOptions.map((opt) => (
            <Select
              key={opt.key}
              value={filters[opt.key] || '__all__'}
              onValueChange={(v) => {
                const next = { ...filters };
                if (v === '__all__') delete next[opt.key];
                else next[opt.key] = v;
                onFiltersChange(next);
                onPageChange(0);
              }}
            >
              <SelectTrigger className="h-8 text-xs w-[155px]">
                <SelectValue placeholder={`All ${opt.label}`} />
              </SelectTrigger>
              <SelectContent className="max-h-64">
                <SelectItem value="__all__">All {opt.label}</SelectItem>
                {opt.choices.map((c) => (
                  <SelectItem key={c.value} value={c.value}>
                    {c.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ))}

          {/* Rent Plan status filter */}
          <Select
            value={extraFilters.rentPlanStatus}
            onValueChange={(v) =>
              onExtraFiltersChange({
                ...extraFilters,
                rentPlanStatus: v as LandlordExtraFilters['rentPlanStatus'],
              })
            }
          >
            <SelectTrigger className="h-8 text-xs w-[160px]">
              <SelectValue placeholder="Rent Plan Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Rent Plan Statuses</SelectItem>
              <SelectItem value="active">Has Active Rent Plans</SelectItem>
              <SelectItem value="none">No Active Rent Plans</SelectItem>
            </SelectContent>
          </Select>

          {/* Verification filter */}
          <Select
            value={extraFilters.verification}
            onValueChange={(v) =>
              onExtraFiltersChange({
                ...extraFilters,
                verification: v as LandlordExtraFilters['verification'],
              })
            }
          >
            <SelectTrigger className="h-8 text-xs w-[150px]">
              <SelectValue placeholder="Verification" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Verification</SelectItem>
              <SelectItem value="verified">Verified</SelectItem>
              <SelectItem value="unverified">Unverified</SelectItem>
            </SelectContent>
          </Select>

          {/* Last outcome filter */}
          <Select
            value={extraFilters.lastOutcome}
            onValueChange={(v) =>
              onExtraFiltersChange({
                ...extraFilters,
                lastOutcome: v,
              })
            }
          >
            <SelectTrigger className="h-8 text-xs w-[175px]">
              <SelectValue placeholder="Last Outcome" />
            </SelectTrigger>
            <SelectContent>
              {LAST_OUTCOME_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </Card>

      {/* Queue Table (Desktop) */}
      <Card className="hidden md:block overflow-hidden">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader className="bg-muted/30">
              <TableRow>
                <TableHead className="text-xs">Landlord</TableHead>
                <TableHead className="text-xs">Region / District</TableHead>
                <TableHead className="text-xs">Registering Agent</TableHead>
                <TableHead className="text-xs">Rent Plans & Houses</TableHead>
                <TableHead className="text-xs">Verification</TableHead>
                <TableHead className="text-xs">Last called</TableHead>
                <TableHead className="text-xs">State</TableHead>
                <TableHead className="text-xs text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {hub.isLoading ? (
                <TableRow>
                  <TableCell colSpan={8} className="py-10 text-center text-xs text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin inline mr-1.5" />
                    Loading landlord calling queue…
                  </TableCell>
                </TableRow>
              ) : filteredRows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={8} className="py-8">
                    <CcEmptyState
                      icon={Building2}
                      title="No landlords match your active filters"
                      description="Try clearing a filter or opening/topping up the active landlord calling round."
                    />
                  </TableCell>
                </TableRow>
              ) : (
                filteredRows.map((row) => {
                  const reg = registryMap[row.subject_id];
                  const lastCalledAt = reg?.last_called_at ?? row.last_attempt_at;
                  const lastCallerName = reg?.last_caller_name ?? null;
                  const lastOutcome = reg?.last_call_outcome ?? row.feedback_category ?? null;
                  const verStatus = reg?.verification_status ?? 'unverified';
                  const activePlans = reg?.active_rent_plans ?? 0;
                  const housesCount = reg?.houses_count ?? 0;
                  const rentValue = Number(row.metric_value ?? reg?.plan_rent_total ?? 0);
                  const hasUserAccount = reg ? Boolean(reg.user_id) : true;

                  return (
                    <TableRow
                      key={row.id}
                      className="hover:bg-muted/30 cursor-pointer"
                      onClick={() => onInspectRow(row)}
                    >
                      <TableCell className="text-xs">
                        <div className="font-semibold text-foreground flex items-center gap-1.5 flex-wrap">
                          <span>{row.name || reg?.full_name || 'Landlord'}</span>
                          {reg?.needs_review && (
                            <Badge variant="destructive" className="text-[9px] px-1.5 py-0">
                              Needs Review
                            </Badge>
                          )}
                          {!hasUserAccount && (
                            <Badge variant="outline" className="text-[9px] px-1.5 py-0">
                              Handset Only
                            </Badge>
                          )}
                        </div>
                        <div className="text-[11px] font-mono text-muted-foreground">
                          {reg?.phones?.[0] || 'Phone revealed on dial'}
                        </div>
                      </TableCell>

                      <TableCell className="text-xs">
                        <div className="text-foreground">{row.district || reg?.district || '—'}</div>
                        {reg?.region && (
                          <div className="text-[10px] text-muted-foreground">{reg.region}</div>
                        )}
                      </TableCell>

                      <TableCell className="text-xs">
                        {row.linked_agent || reg?.registering_agent_name || '—'}
                      </TableCell>

                      <TableCell className="text-xs">
                        <div className="font-semibold tabular-nums text-foreground">
                          {formatUGX(rentValue)}
                        </div>
                        <div className="text-[10px] text-muted-foreground">
                          {activePlans} active plan{activePlans === 1 ? '' : 's'} · {housesCount} house
                          {housesCount === 1 ? '' : 's'}
                        </div>
                      </TableCell>

                      <TableCell className="text-xs">
                        <CcPill
                          tone={verStatus === 'verified' ? 'emerald' : 'amber'}
                          icon={verStatus === 'verified' ? CheckCircle2 : ShieldCheck}
                        >
                          {formatHumanLabel(verStatus)}
                        </CcPill>
                      </TableCell>

                      {/* "Last called" column: date, by whom, result */}
                      <TableCell className="text-xs">
                        {lastCalledAt ? (
                          <div className="space-y-0.5">
                            <div className="font-medium text-foreground">
                              {format(new Date(lastCalledAt), 'dd MMM yyyy')}
                              <span className="text-[10px] text-muted-foreground ml-1">
                                ({formatDistanceToNow(new Date(lastCalledAt), { addSuffix: true })})
                              </span>
                            </div>
                            <div className="text-[11px] text-muted-foreground flex items-center gap-1.5 flex-wrap">
                              {lastCallerName && <span>By {lastCallerName}</span>}
                              {lastOutcome && (
                                <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                                  {formatHumanLabel(lastOutcome)}
                                </Badge>
                              )}
                            </div>
                          </div>
                        ) : (
                          <span className="text-muted-foreground text-[11px]">Never called</span>
                        )}
                      </TableCell>

                      <TableCell className="text-xs">
                        <Badge
                          variant={
                            row.state === 'engaged'
                              ? 'default'
                              : row.state === 'unreachable'
                                ? 'destructive'
                                : 'secondary'
                          }
                          className="text-[10px]"
                        >
                          {formatHumanLabel(row.state)}
                        </Badge>
                        {row.attempts_made > 0 && (
                          <div className="text-[10px] text-muted-foreground mt-0.5">
                            {row.attempts_made} attempt{row.attempts_made === 1 ? '' : 's'}
                          </div>
                        )}
                      </TableCell>

                      <TableCell
                        className="text-xs text-right whitespace-nowrap"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <div className="inline-flex items-center gap-1">
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            className="h-7 px-2 text-xs gap-1"
                            onClick={() => onInspectRow(row)}
                          >
                            <Eye className="h-3 w-3" /> Panel
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            className="h-7 px-2 text-xs gap-1"
                            onClick={() => onOpenTimeline(row, reg)}
                          >
                            <Clock className="h-3 w-3" /> Timeline
                          </Button>
                          {!callingPaused && (
                            <Button
                              type="button"
                              size="sm"
                              variant={hasUserAccount ? 'default' : 'secondary'}
                              disabled={isRevealing}
                              className="h-7 px-2.5 text-xs gap-1"
                              onClick={() => onDialRow(row)}
                            >
                              {hasUserAccount ? (
                                <>
                                  <Phone className="h-3 w-3" /> Call
                                </>
                              ) : (
                                <>
                                  <Smartphone className="h-3 w-3" /> Handset
                                </>
                              )}
                            </Button>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </div>
      </Card>

      {/* Mobile Card List */}
      <div className="md:hidden space-y-2">
        {hub.isLoading ? (
          <Card className="p-6 text-center text-xs text-muted-foreground">
            Loading landlord queue…
          </Card>
        ) : filteredRows.length === 0 ? (
          <Card className="p-6">
            <CcEmptyState
              icon={Building2}
              title="No landlords match your filters"
              description="Try adjusting your search or filter selections."
            />
          </Card>
        ) : (
          filteredRows.map((row) => {
            const reg = registryMap[row.subject_id];
            const lastCalledAt = reg?.last_called_at ?? row.last_attempt_at;
            const lastCallerName = reg?.last_caller_name ?? null;
            const lastOutcome = reg?.last_call_outcome ?? row.feedback_category ?? null;
            const verStatus = reg?.verification_status ?? 'unverified';
            const hasUserAccount = reg ? Boolean(reg.user_id) : true;

            return (
              <Card
                key={row.id}
                className="p-3 space-y-2 text-xs"
                onClick={() => onInspectRow(row)}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="font-semibold text-sm truncate">
                      {row.name || reg?.full_name || 'Landlord'}
                    </div>
                    <div className="font-mono text-[11px] text-muted-foreground">
                      {reg?.phones?.[0] || 'Phone revealed on dial'}
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <CcPill tone={verStatus === 'verified' ? 'emerald' : 'amber'}>
                      {formatHumanLabel(verStatus)}
                    </CcPill>
                    <Badge variant="outline" className="text-[10px]">
                      {formatHumanLabel(row.state)}
                    </Badge>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                  {(row.district || reg?.district) && (
                    <span className="inline-flex items-center gap-1">
                      <MapPin className="h-3 w-3" /> {row.district || reg?.district}
                    </span>
                  )}
                  {(row.linked_agent || reg?.registering_agent_name) && (
                    <span className="inline-flex items-center gap-1">
                      <User className="h-3 w-3" /> {row.linked_agent || reg?.registering_agent_name}
                    </span>
                  )}
                  <span className="font-semibold text-foreground">
                    {formatUGX(Number(row.metric_value ?? reg?.plan_rent_total ?? 0))}
                  </span>
                </div>

                <div className="rounded bg-muted/40 px-2.5 py-1.5 text-[11px] flex items-center justify-between gap-2">
                  <span className="text-muted-foreground">
                    Last called:{' '}
                    {lastCalledAt ? (
                      <strong className="text-foreground">
                        {format(new Date(lastCalledAt), 'dd MMM yyyy')}
                        {lastCallerName ? ` · ${lastCallerName}` : ''}
                      </strong>
                    ) : (
                      'Never called'
                    )}
                  </span>
                  {lastOutcome && (
                    <Badge variant="outline" className="text-[10px]">
                      {formatHumanLabel(lastOutcome)}
                    </Badge>
                  )}
                </div>

                <div
                  className="flex items-center justify-end gap-1.5 pt-1 border-t"
                  onClick={(e) => e.stopPropagation()}
                >
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="h-7 text-xs gap-1"
                    onClick={() => onInspectRow(row)}
                  >
                    <Eye className="h-3 w-3" /> Panel
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="h-7 text-xs gap-1"
                    onClick={() => onOpenTimeline(row, reg)}
                  >
                    <Clock className="h-3 w-3" /> Timeline
                  </Button>
                  {!callingPaused && (
                    <Button
                      type="button"
                      size="sm"
                      variant={hasUserAccount ? 'default' : 'secondary'}
                      disabled={isRevealing}
                      className="h-7 text-xs gap-1"
                      onClick={() => onDialRow(row)}
                    >
                      {hasUserAccount ? (
                        <>
                          <Phone className="h-3 w-3" /> Call
                        </>
                      ) : (
                        <>
                          <Smartphone className="h-3 w-3" /> Handset
                        </>
                      )}
                    </Button>
                  )}
                </div>
              </Card>
            );
          })
        )}
      </div>

      {/* Pagination Bar (50 per page, server-side, 0-indexed page) */}
      <Card className="p-2.5 flex items-center justify-between gap-2 text-xs">
        <span className="text-muted-foreground">
          Showing page <strong className="text-foreground">{page + 1}</strong> of{' '}
          <strong className="text-foreground">{totalPages}</strong> ({totalCount} landlords in round · 50 per page)
        </span>
        <div className="flex items-center gap-1.5">
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-7 text-xs gap-1"
            disabled={page <= 0}
            onClick={() => onPageChange(Math.max(0, page - 1))}
          >
            <ChevronLeft className="h-3.5 w-3.5" /> Prev
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-7 text-xs gap-1"
            disabled={page + 1 >= totalPages}
            onClick={() => onPageChange(Math.min(totalPages - 1, page + 1))}
          >
            Next <ChevronRight className="h-3.5 w-3.5" />
          </Button>
        </div>
      </Card>

      {/* Save Current Queue Dialog */}
      <Dialog open={saveDialogOpen} onOpenChange={setSaveDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base">
              <BookmarkPlus className="h-4 w-4 text-primary" /> Save Landlord Queue Filter View
            </DialogTitle>
            <DialogDescription className="text-xs">
              Save your current region, district, agent, verification, Rent Plan, and sort settings for one-click reuse.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2 text-sm">
            <div className="space-y-1.5">
              <Label htmlFor="saved-queue-name" className="text-xs">
                Queue Name *
              </Label>
              <Input
                id="saved-queue-name"
                value={queueName}
                onChange={(e) => setQueueName(e.target.value)}
                placeholder="e.g. Central Unverified Landlords with Active Rent Plans"
              />
            </div>
            <div className="flex items-center justify-between rounded-lg border p-2.5">
              <div>
                <div className="text-xs font-medium">Share with Landlord Ops Team</div>
                <div className="text-[11px] text-muted-foreground">
                  Allow other calling officers to load this saved queue
                </div>
              </div>
              <Switch checked={queueShared} onCheckedChange={setQueueShared} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setSaveDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={saveQueueMutation.isPending || !queueName.trim()}
              onClick={handleSaveCurrentQueue}
            >
              {saveQueueMutation.isPending ? 'Saving…' : 'Save Queue'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
