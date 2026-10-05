import { useEffect, useMemo, useState, useCallback } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { getEntries, isFieldCollectStorageUnavailable, onFieldCollectStorageUnavailable, onFieldCollectChange, deleteEntry, updateEntry, type FieldEntry } from '@/lib/fieldCollectStore';
import { formatUGX } from '@/lib/rentCalculations';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { CheckCircle2, Clock, FileWarning, CalendarDays, RefreshCcw, FileText, FileSpreadsheet, CalendarIcon, Settings2, RotateCcw, MoreHorizontal, CalendarRange, Loader2, SkipForward } from 'lucide-react';
import { cn } from '@/lib/utils';
import { FieldCollectDailyDetailsSheet } from '@/components/agent/FieldCollectDailyDetailsSheet';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Calendar } from '@/components/ui/calendar';
import { FieldCollectReconciliationSheet } from '@/components/agent/FieldCollectReconciliationSheet';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { exportDailyTotalsCsv, exportDailyTotalsPdf, exportRangeTotalsPdf, exportRangeTotalsCsv } from '@/lib/fieldCollectExport';
import {
  format, isSameDay, startOfWeek, endOfWeek, startOfMonth, endOfMonth, differenceInCalendarDays,
} from 'date-fns';
import type { DateRange } from 'react-day-picker';
import { toast } from 'sonner';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { supabase } from '@/integrations/supabase/client';

interface Bucket {
  label: string;
  count: number;
  total: number;
}

interface SessionCutoffs {
  morningEnd: number;   // hour (0-23). Morning = [0, morningEnd)
  afternoonEnd: number; // hour (0-23). Afternoon = [morningEnd, afternoonEnd). Evening = [afternoonEnd, 24)
}

const DEFAULT_CUTOFFS: SessionCutoffs = { morningEnd: 12, afternoonEnd: 17 };
const CUTOFFS_STORAGE_KEY = 'welile.fieldCollect.sessionCutoffs';

function loadCutoffs(): SessionCutoffs {
  try {
    const raw = localStorage.getItem(CUTOFFS_STORAGE_KEY);
    if (!raw) return DEFAULT_CUTOFFS;
    const parsed = JSON.parse(raw) as Partial<SessionCutoffs>;
    const m = Number(parsed.morningEnd);
    const a = Number(parsed.afternoonEnd);
    if (!Number.isFinite(m) || !Number.isFinite(a)) return DEFAULT_CUTOFFS;
    if (m < 1 || m > 23 || a < 1 || a > 23 || m >= a) return DEFAULT_CUTOFFS;
    return { morningEnd: Math.floor(m), afternoonEnd: Math.floor(a) };
  } catch {
    return DEFAULT_CUTOFFS;
  }
}

function formatHour(h: number): string {
  const hh = String(h).padStart(2, '0');
  return `${hh}:00`;
}

interface Props {
  /** Compact card for embedding inside dashboards / dialogs. */
  variant?: 'card' | 'inline';
  className?: string;
  /** When true, polls IndexedDB for live updates (used on dashboard). */
  live?: boolean;
}

/**
 * Aggregates today's field-collection entries into time-of-day sessions
 * (Morning <12:00, Afternoon 12-17, Evening ≥17) and shows synced vs pending totals.
 * Reads exclusively from the local IndexedDB queue so it works offline.
 */
export function FieldCollectDailyTotals({ variant = 'card', className, live = false }: Props) {
  const { user } = useAuth();
  const [entries, setEntries] = useState<FieldEntry[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);
  const [lastRefreshed, setLastRefreshed] = useState<number>(Date.now());
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [reconcileOpen, setReconcileOpen] = useState(false);
  const [dupPopoverOpen, setDupPopoverOpen] = useState(false);
  const [cutoffs, setCutoffs] = useState<SessionCutoffs>(() => loadCutoffs());
  const [cutoffsOpen, setCutoffsOpen] = useState(false);
  const [draftMorning, setDraftMorning] = useState<string>(String(cutoffs.morningEnd));
  const [draftAfternoon, setDraftAfternoon] = useState<string>(String(cutoffs.afternoonEnd));
  const [selectedDate, setSelectedDate] = useState<Date>(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  });
  const [datePickerOpen, setDatePickerOpen] = useState(false);

  /**
   * Date-range export popover. Opens from the dropdown ("Export range…") and
   * lets the agent pick a quick preset (This week / This month / Last 7 days)
   * or a custom range, then download CSV/PDF.
   */
  const [rangeExportOpen, setRangeExportOpen] = useState(false);
  const [rangeSelection, setRangeSelection] = useState<DateRange | undefined>(undefined);

  /**
   * One-tap resolution state for the review popover.
   * 'skip'  → drop local copies of duplicates (server version is canonical)
   * 'retry' → re-queue failed entries and immediately re-attempt sync
   * 'auto'  → run skip then retry back-to-back
   */
  const [resolvingAction, setResolvingAction] = useState<null | 'skip' | 'retry' | 'auto'>(null);

  const refresh = useCallback(async () => {
    if (!user?.id) return;
    setRefreshing(true);
    try {
      setEntries(await getEntries(user.id));
      setLastRefreshed(Date.now());
    } catch (e) {
      // Polled every 4s — keep the last good totals rather than raising an
      // unhandled rejection on every tick when IndexedDB is unavailable.
      console.warn('FieldCollectDailyTotals refresh failed', e);
    } finally {
      setRefreshing(false);
      setInitialLoading(false);
    }
  }, [user?.id]);

  useEffect(() => {
    refresh();
    if (!live) return;
    if (isFieldCollectStorageUnavailable()) return;
    const iv = window.setInterval(refresh, 4000);
    const offUnavailable = onFieldCollectStorageUnavailable(() => window.clearInterval(iv));
    return () => { window.clearInterval(iv); offUnavailable(); };
  }, [refresh, live]);

  /**
   * Instant refresh on save/update/delete from anywhere in the app
   * (e.g. TenantFieldCollectDialog, FieldCollectDialog, sync worker).
   * Decoupled via the field-collect change event bus.
   */
  useEffect(() => {
    return onFieldCollectChange((detail) => {
      if (detail.agentId && user?.id && detail.agentId !== user.id) return;
      refresh();
    });
  }, [refresh, user?.id]);

  const isToday = isSameDay(selectedDate, new Date());

  const today = useMemo(() => {
    const start = new Date(selectedDate);
    start.setHours(0, 0, 0, 0);
    const end = new Date(selectedDate);
    end.setHours(23, 59, 59, 999);
    return entries.filter(e => e.capturedAt >= start.getTime() && e.capturedAt <= end.getTime());
  }, [entries, selectedDate]);

  const handleExport = useCallback((kind: 'csv' | 'pdf') => {
    const agentName = (user?.user_metadata as any)?.full_name || user?.email || null;
    const payload = { date: selectedDate, agentName, entries: today };
    try {
      if (kind === 'csv') exportDailyTotalsCsv(payload);
      else exportDailyTotalsPdf(payload);
      toast.success(`Exported ${today.length} entr${today.length === 1 ? 'y' : 'ies'} as ${kind.toUpperCase()}`);
    } catch (err) {
      console.error('[fieldCollect] export failed', err);
      toast.error('Export failed');
    }
  }, [selectedDate, today, user]);

  /**
   * Range export — pulls every entry across [start..end] (inclusive) from the
   * already-loaded local cache, then hands it to the shared PDF/CSV builders.
   */
  const handleRangeExport = useCallback(
    (kind: 'csv' | 'pdf', start: Date, end: Date, label?: string) => {
      const startMs = new Date(start).setHours(0, 0, 0, 0);
      const endMs = new Date(end).setHours(23, 59, 59, 999);
      const slice = entries.filter(e => e.capturedAt >= startMs && e.capturedAt <= endMs);
      if (slice.length === 0) {
        toast.info('No payments in that date range');
        return;
      }
      const agentName = (user?.user_metadata as any)?.full_name || user?.email || null;
      const payload = {
        startDate: new Date(startMs),
        endDate: new Date(endMs),
        agentName,
        entries: slice,
        rangeLabel: label,
      };
      try {
        if (kind === 'csv') exportRangeTotalsCsv(payload);
        else exportRangeTotalsPdf(payload);
        const days = differenceInCalendarDays(end, start) + 1;
        toast.success(
          `Exported ${slice.length} payment${slice.length === 1 ? '' : 's'} across ${days} day${days === 1 ? '' : 's'} as ${kind.toUpperCase()}`,
        );
        setRangeExportOpen(false);
      } catch (err) {
        console.error('[fieldCollect] range export failed', err);
        toast.error('Export failed');
      }
    },
    [entries, user],
  );

  /** Quick presets surfaced inside the range popover. */
  const exportPreset = useCallback(
    (kind: 'csv' | 'pdf', preset: 'thisWeek' | 'thisMonth' | 'last7' | 'last30') => {
      const now = new Date();
      let start: Date, end: Date, label: string;
      switch (preset) {
        case 'thisWeek':
          start = startOfWeek(now, { weekStartsOn: 1 });
          end = endOfWeek(now, { weekStartsOn: 1 });
          label = 'This week';
          break;
        case 'thisMonth':
          start = startOfMonth(now);
          end = endOfMonth(now);
          label = 'This month';
          break;
        case 'last7':
          end = now;
          start = new Date(now);
          start.setDate(start.getDate() - 6);
          label = 'Last 7 days';
          break;
        case 'last30':
          end = now;
          start = new Date(now);
          start.setDate(start.getDate() - 29);
          label = 'Last 30 days';
          break;
      }
      handleRangeExport(kind, start, end, label);
    },
    [handleRangeExport],
  );

  /**
   * One-tap: drop the local copies of duplicates so the server version
   * remains the source of truth (same semantic as "Keep server" in the
   * reconciliation sheet — but applied in bulk).
   */
  const skipAllDuplicates = useCallback(async (): Promise<number> => {
    const dupes = today.filter(e => e.syncState === 'duplicate');
    let n = 0;
    for (const e of dupes) {
      try {
        await deleteEntry(e.id);
        n++;
      } catch (err) {
        console.error('[fieldCollect] skip duplicate failed', e.id, err);
      }
    }
    return n;
  }, [today]);

  /**
   * One-tap: re-queue every failed entry, then push them to the server.
   * Mirrors the sync logic used by the capture dialog so the popover is
   * self-contained and works without opening Field Collect.
   */
  const retryAllFailed = useCallback(async (): Promise<{ ok: number; fail: number; dup: number }> => {
    if (!user?.id) return { ok: 0, fail: 0, dup: 0 };
    if (!navigator.onLine) {
      toast.error('No internet — connect and try again.');
      return { ok: 0, fail: 0, dup: 0 };
    }
    const failed = today.filter(e => e.syncState === 'error');
    let ok = 0, fail = 0, dup = 0;
    for (const e of failed) {
      try {
        // Reset to queued first so the UI/state stay consistent if the page reloads mid-sync.
        await updateEntry(e.id, { syncState: 'queued', syncError: null });
        const { data, error } = await (supabase.from('field_collections') as any)
          .insert({
            client_uuid: e.id,
            agent_id: user.id,
            tenant_id: e.tenantId,
            tenant_name: e.tenantName,
            tenant_phone: e.tenantPhone,
            amount: e.amount,
            notes: e.notes,
            location_name: e.locationName,
            latitude: e.latitude,
            longitude: e.longitude,
            captured_at: new Date(e.capturedAt).toISOString(),
            status: 'pending',
          })
          .select('id')
          .single();
        if (error) {
          if ((error as any).code === '23505') {
            // Same idempotency-key collision logic as the capture dialog
            const { data: existing } = await (supabase.from('field_collections') as any)
              .select('id, amount, captured_at, tenant_name, status, created_at')
              .eq('agent_id', user.id)
              .eq('client_uuid', e.id)
              .maybeSingle();
            const sameAmount = existing && Number(existing.amount) === Number(e.amount);
            if (existing && sameAmount) {
              await updateEntry(e.id, {
                syncState: 'synced',
                serverId: existing.id,
                syncError: null,
                lastSyncAt: Date.now(),
              });
              ok++;
            } else {
              await updateEntry(e.id, {
                syncState: 'duplicate',
                syncError: 'Already on server — needs reconciliation',
                duplicateOfServerId: existing?.id ?? null,
                duplicateServerSnapshot: existing ? {
                  amount: Number(existing.amount),
                  capturedAt: existing.captured_at,
                  tenantName: existing.tenant_name,
                  status: existing.status,
                  createdAt: existing.created_at,
                } : null,
                lastSyncAt: Date.now(),
              });
              dup++;
            }
          } else {
            await updateEntry(e.id, { syncState: 'error', syncError: error.message, lastSyncAt: Date.now() });
            fail++;
          }
        } else {
          await updateEntry(e.id, {
            syncState: 'synced',
            serverId: (data as any)?.id,
            syncError: null,
            lastSyncAt: Date.now(),
          });
          ok++;
        }
      } catch (err: any) {
        await updateEntry(e.id, { syncState: 'error', syncError: err?.message || 'Unknown', lastSyncAt: Date.now() });
        fail++;
      }
    }
    return { ok, fail, dup };
  }, [today, user?.id]);

  /** Reload today totals from the local cache (also triggered automatically via store events). */
  const refreshTodayTotals = useCallback(async () => {
    if (!user?.id) return;
    try {
      setEntries(await getEntries(user.id));
    } catch (e) {
      console.warn('refreshTodayTotals failed', e);
    }
  }, [user?.id]);

  /**
   * "Resolve all" — runs the full checklist in order:
   *   1) Skip duplicates  → 2) Retry failed  → 3) Refresh today's totals.
   * Designed to leave nothing requiring manual review when possible.
   */
  const resolveAllInOrder = useCallback(async () => {
    setResolvingAction('auto');
    try {
      const skipped = await skipAllDuplicates();
      const retried = await retryAllFailed();
      await refreshTodayTotals();
      const parts: string[] = [];
      if (skipped) parts.push(`${skipped} duplicate${skipped === 1 ? '' : 's'} skipped`);
      if (retried.ok) parts.push(`${retried.ok} sent`);
      if (retried.dup) parts.push(`${retried.dup} new duplicate${retried.dup === 1 ? '' : 's'}`);
      if (retried.fail) parts.push(`${retried.fail} still failing`);
      if (parts.length === 0) toast.info('Nothing to resolve');
      else if (retried.fail || retried.dup) toast.warning(parts.join(' · '));
      else toast.success(parts.join(' · '));
    } catch (err) {
      console.error('[fieldCollect] resolve-all failed', err);
      toast.error('Could not resolve everything — try the items individually.');
    } finally {
      setResolvingAction(null);
    }
  }, [skipAllDuplicates, retryAllFailed, refreshTodayTotals]);

  const breakdown = useMemo(() => {
    const synced = today.filter(e => e.syncState === 'synced');
    const pending = today.filter(e => e.syncState === 'queued');
    const failed = today.filter(e => e.syncState === 'error');
    const dup = today.filter(e => e.syncState === 'duplicate');
    const sum = (arr: FieldEntry[]) => arr.reduce((s, e) => s + Number(e.amount || 0), 0);
    return {
      total: sum(today),
      count: today.length,
      synced: { count: synced.length, total: sum(synced) },
      pending: { count: pending.length, total: sum(pending) },
      failed: { count: failed.length, total: sum(failed) },
      duplicate: { count: dup.length, total: sum(dup) },
    };
  }, [today]);

  const sessions: Bucket[] = useMemo(() => {
    const morn: FieldEntry[] = [], aft: FieldEntry[] = [], eve: FieldEntry[] = [];
    for (const e of today) {
      const h = new Date(e.capturedAt).getHours();
      if (h < cutoffs.morningEnd) morn.push(e);
      else if (h < cutoffs.afternoonEnd) aft.push(e);
      else eve.push(e);
    }
    const sum = (arr: FieldEntry[]) => arr.reduce((s, e) => s + Number(e.amount || 0), 0);
    return [
      { label: `Morning (until ${formatHour(cutoffs.morningEnd)})`, count: morn.length, total: sum(morn) },
      { label: `Afternoon (until ${formatHour(cutoffs.afternoonEnd)})`, count: aft.length, total: sum(aft) },
      { label: `Evening (from ${formatHour(cutoffs.afternoonEnd)})`, count: eve.length, total: sum(eve) },
    ];
  }, [today, cutoffs]);

  const saveCutoffs = useCallback(() => {
    const m = Math.floor(Number(draftMorning));
    const a = Math.floor(Number(draftAfternoon));
    if (!Number.isFinite(m) || !Number.isFinite(a)) {
      toast.error('Enter valid hours (0-23)');
      return;
    }
    if (m < 1 || m > 23 || a < 1 || a > 23) {
      toast.error('Hours must be between 1 and 23');
      return;
    }
    if (m >= a) {
      toast.error('Afternoon end must be after morning end');
      return;
    }
    const next = { morningEnd: m, afternoonEnd: a };
    setCutoffs(next);
    try { localStorage.setItem(CUTOFFS_STORAGE_KEY, JSON.stringify(next)); } catch {}
    setCutoffsOpen(false);
    toast.success('Session cutoffs updated');
  }, [draftMorning, draftAfternoon]);

  const resetCutoffs = useCallback(() => {
    setCutoffs(DEFAULT_CUTOFFS);
    setDraftMorning(String(DEFAULT_CUTOFFS.morningEnd));
    setDraftAfternoon(String(DEFAULT_CUTOFFS.afternoonEnd));
    try { localStorage.removeItem(CUTOFFS_STORAGE_KEY); } catch {}
    toast.success('Session cutoffs reset to defaults');
  }, []);

  const isInline = variant === 'inline';

  const dateLabel = isToday ? "Today's totals" : format(selectedDate, 'PPP');

  // Initial-load skeleton: matches the real layout to avoid jump
  if (initialLoading) {
    return (
      <div
        className={cn(
          'space-y-3',
          !isInline && 'rounded-2xl border bg-card p-4',
          className,
        )}
        aria-busy="true"
        aria-live="polite"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-2">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-7 w-32" />
            <Skeleton className="h-3 w-40" />
          </div>
          <div className="flex gap-1.5">
            <Skeleton className="h-7 w-16 rounded-md" />
            <Skeleton className="h-7 w-16 rounded-md" />
          </div>
        </div>
        <Separator />
        <div className="grid grid-cols-2 gap-2">
          <Skeleton className="h-16 rounded-lg" />
          <Skeleton className="h-16 rounded-lg" />
        </div>
        <Skeleton className="h-1.5 w-full rounded-full" />
        <div>
          <Skeleton className="h-3 w-20 mb-1.5" />
          <div className="grid grid-cols-3 gap-2">
            <Skeleton className="h-14 rounded-lg" />
            <Skeleton className="h-14 rounded-lg" />
            <Skeleton className="h-14 rounded-lg" />
          </div>
        </div>
        <Skeleton className="h-4 w-24 mx-auto" />
      </div>
    );
  }

  const dateSelector = (
    <Popover open={datePickerOpen} onOpenChange={setDatePickerOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-7 px-2 text-[11px] gap-1"
          aria-label="Pick date"
        >
          <CalendarIcon className="h-3 w-3" />
          {isToday ? 'Today' : format(selectedDate, 'MMM d')}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="end">
        <Calendar
          mode="single"
          selected={selectedDate}
          onSelect={(d) => {
            if (d) {
              const nd = new Date(d);
              nd.setHours(0, 0, 0, 0);
              setSelectedDate(nd);
              setDatePickerOpen(false);
            }
          }}
          disabled={(d) => d > new Date()}
          initialFocus
          className={cn('p-3 pointer-events-auto')}
        />
      </PopoverContent>
    </Popover>
  );

  if (breakdown.count === 0) {
    return (
      <div
        className={cn(
          'text-xs text-muted-foreground text-center py-4',
          !isInline && 'rounded-2xl border bg-muted/30 px-4',
          className,
        )}
      >
        <CalendarDays className="h-4 w-4 mx-auto mb-1 opacity-60" />
        {isToday ? 'No field collections yet today' : `No field collections on ${format(selectedDate, 'PPP')}`}
        <div className="mt-2 flex items-center justify-center gap-1.5 flex-wrap">
          {dateSelector}
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={refresh}
            disabled={refreshing}
            className="h-7 px-2 text-[11px] gap-1"
          >
            <RefreshCcw className={cn('h-3 w-3', refreshing && 'animate-spin')} />
            Refresh totals
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div
      className={cn(
        'space-y-4',
        !isInline && 'rounded-3xl border bg-card p-4 sm:p-5',
        className,
      )}
    >
      {/* Header — calm, single big number */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground font-medium uppercase tracking-wide">
            <CalendarDays className="h-3.5 w-3.5" />
            {dateLabel}
          </div>
          <p className="text-3xl sm:text-4xl font-bold tracking-tight tabular-nums mt-1">
            {formatUGX(breakdown.total)}
          </p>
          <p className="text-xs text-muted-foreground mt-0.5">
            {breakdown.count} payment{breakdown.count === 1 ? '' : 's'} · updated {formatRelative(lastRefreshed)}
          </p>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {dateSelector}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-9 w-9 p-0 rounded-full"
                aria-label="More options"
              >
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuLabel className="text-[11px]">
                {format(selectedDate, 'PPP')}
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={refresh}
                disabled={refreshing}
                className="gap-2 text-sm"
              >
                <RefreshCcw className={cn('h-4 w-4', refreshing && 'animate-spin')} />
                Refresh
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => handleExport('csv')} className="gap-2 text-sm">
                <FileSpreadsheet className="h-4 w-4" />
                Download CSV
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => handleExport('pdf')} className="gap-2 text-sm">
                <FileText className="h-4 w-4" />
                Download PDF
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => {
                  // Initialise the range picker to the current selected day so
                  // the calendar opens on something familiar.
                  setRangeSelection({ from: selectedDate, to: selectedDate });
                  setRangeExportOpen(true);
                }}
                className="gap-2 text-sm"
              >
                <CalendarRange className="h-4 w-4" />
                Export date range…
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() => {
                  setDraftMorning(String(cutoffs.morningEnd));
                  setDraftAfternoon(String(cutoffs.afternoonEnd));
                  setCutoffsOpen(true);
                }}
                className="gap-2 text-sm"
              >
                <Settings2 className="h-4 w-4" />
                Time-of-day settings
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* Range-export popover — opens via the dropdown */}
      <Popover open={rangeExportOpen} onOpenChange={setRangeExportOpen}>
        <PopoverTrigger asChild>
          <span className="sr-only" aria-hidden="true" />
        </PopoverTrigger>
        <PopoverContent align="end" className="w-[320px] sm:w-[360px] p-0 max-h-[80vh] overflow-y-auto">
          <div className="px-4 py-3 border-b">
            <p className="text-sm font-semibold">Export date range</p>
            <p className="text-[11px] text-muted-foreground">
              Same totals and reference columns as the daily export.
            </p>
          </div>

          {/* Quick presets */}
          <div className="px-4 py-3 space-y-2 border-b">
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-medium">Quick presets</p>
            <div className="grid grid-cols-2 gap-1.5">
              {([
                { id: 'thisWeek', label: 'This week' },
                { id: 'thisMonth', label: 'This month' },
                { id: 'last7', label: 'Last 7 days' },
                { id: 'last30', label: 'Last 30 days' },
              ] as const).map(p => (
                <div key={p.id} className="flex rounded-md overflow-hidden border">
                  <button
                    type="button"
                    onClick={() => exportPreset('pdf', p.id)}
                    className="flex-1 px-2 py-2 text-[11px] font-medium hover:bg-accent inline-flex items-center justify-center gap-1 min-h-[36px]"
                    title={`${p.label} — PDF`}
                  >
                    <FileText className="h-3 w-3" />
                    {p.label}
                  </button>
                  <button
                    type="button"
                    onClick={() => exportPreset('csv', p.id)}
                    className="px-2 py-2 text-[10px] font-medium hover:bg-accent border-l text-muted-foreground"
                    title={`${p.label} — CSV`}
                    aria-label={`${p.label} as CSV`}
                  >
                    CSV
                  </button>
                </div>
              ))}
            </div>
          </div>

          {/* Custom range */}
          <div className="px-4 py-3 space-y-2">
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-medium">Custom range</p>
            <Calendar
              mode="range"
              selected={rangeSelection}
              onSelect={setRangeSelection}
              numberOfMonths={1}
              disabled={(d) => d > new Date()}
              className={cn('p-0 pointer-events-auto')}
            />
            {rangeSelection?.from && rangeSelection?.to ? (
              <p className="text-[11px] text-muted-foreground text-center">
                {format(rangeSelection.from, 'PPP')} → {format(rangeSelection.to, 'PPP')}
                {' · '}
                {differenceInCalendarDays(rangeSelection.to, rangeSelection.from) + 1} days
              </p>
            ) : (
              <p className="text-[11px] text-muted-foreground text-center">
                Pick a start and end date.
              </p>
            )}
            <div className="grid grid-cols-2 gap-2 pt-1">
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-9 text-xs gap-1"
                disabled={!rangeSelection?.from || !rangeSelection?.to}
                onClick={() => {
                  if (rangeSelection?.from && rangeSelection?.to) {
                    handleRangeExport('csv', rangeSelection.from, rangeSelection.to, 'Custom range');
                  }
                }}
              >
                <FileSpreadsheet className="h-3.5 w-3.5" />
                CSV
              </Button>
              <Button
                type="button"
                size="sm"
                className="h-9 text-xs gap-1"
                disabled={!rangeSelection?.from || !rangeSelection?.to}
                onClick={() => {
                  if (rangeSelection?.from && rangeSelection?.to) {
                    handleRangeExport('pdf', rangeSelection.from, rangeSelection.to, 'Custom range');
                  }
                }}
              >
                <FileText className="h-3.5 w-3.5" />
                PDF
              </Button>
            </div>
          </div>
        </PopoverContent>
      </Popover>

      {/* Hidden popover — opens via dropdown */}
      <Popover open={cutoffsOpen} onOpenChange={setCutoffsOpen}>
        <PopoverTrigger asChild>
          <span className="sr-only" aria-hidden="true" />
        </PopoverTrigger>
        <PopoverContent align="end" className="w-72 p-3 space-y-3">
          <div>
            <p className="text-sm font-semibold">Time-of-day settings</p>
            <p className="text-xs text-muted-foreground">
              When does each part of the day end?
            </p>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label htmlFor="morning-end" className="text-xs">Morning ends</Label>
              <Input
                id="morning-end"
                type="number"
                min={1}
                max={23}
                value={draftMorning}
                onChange={(e) => setDraftMorning(e.target.value)}
                className="h-9 text-sm"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="afternoon-end" className="text-xs">Afternoon ends</Label>
              <Input
                id="afternoon-end"
                type="number"
                min={1}
                max={23}
                value={draftAfternoon}
                onChange={(e) => setDraftAfternoon(e.target.value)}
                className="h-9 text-sm"
              />
            </div>
          </div>
          <div className="flex items-center justify-between gap-2 pt-1">
            <Button type="button" size="sm" variant="ghost" onClick={resetCutoffs} className="h-8 text-xs gap-1">
              <RotateCcw className="h-3 w-3" />
              Reset
            </Button>
            <Button type="button" size="sm" onClick={saveCutoffs} className="h-8 text-xs">
              Save
            </Button>
          </div>
        </PopoverContent>
      </Popover>

      {/* Sync split — synced vs waiting (combined) */}
      {(() => {
        const pendingCount = breakdown.pending.count + breakdown.failed.count + breakdown.duplicate.count;
        const pendingTotal = breakdown.pending.total + breakdown.failed.total + breakdown.duplicate.total;
        const syncedPct = breakdown.count > 0
          ? Math.round((breakdown.synced.count / breakdown.count) * 100)
          : 0;
        return (
          <div className="space-y-2.5">
            <div className="grid grid-cols-2 gap-2.5">
              <div className="rounded-2xl bg-emerald-500/10 px-4 py-4 sm:py-3">
                <div className="flex items-center gap-1.5 text-emerald-700 dark:text-emerald-400 text-xs font-medium">
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  Sent
                </div>
                <p className="text-xl sm:text-lg font-bold tabular-nums mt-1">{formatUGX(breakdown.synced.total)}</p>
                <p className="text-[11px] text-muted-foreground mt-0.5">
                  {breakdown.synced.count} of {breakdown.count}
                </p>
              </div>
              <div className="rounded-2xl bg-amber-500/10 px-4 py-4 sm:py-3">
                <div className="flex items-center gap-1.5 text-amber-700 dark:text-amber-400 text-xs font-medium">
                  <Clock className="h-3.5 w-3.5" />
                  Waiting
                </div>
                <p className="text-xl sm:text-lg font-bold tabular-nums mt-1">{formatUGX(pendingTotal)}</p>
                <p className="text-[11px] text-muted-foreground mt-0.5">
                  {pendingCount === 0 ? 'None waiting' : `${pendingCount} to send`}
                </p>
              </div>
            </div>

            {/* Progress bar */}
            <div
              className="h-2 w-full overflow-hidden rounded-full bg-muted"
              role="progressbar"
              aria-valuenow={syncedPct}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label={`${syncedPct}% sent`}
            >
              <div className="h-full bg-emerald-500 transition-all rounded-full" style={{ width: `${syncedPct}%` }} />
            </div>

            {/* Issue chip — only when there's something to act on */}
            {(breakdown.failed.count > 0 || breakdown.duplicate.count > 0) && (
              <Popover open={dupPopoverOpen} onOpenChange={setDupPopoverOpen}>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    aria-label="Review issues with payments"
                    className="w-full inline-flex items-center justify-between gap-2 rounded-2xl border border-amber-500/30 bg-amber-500/5 px-4 py-3.5 sm:py-2.5 min-h-[52px] sm:min-h-0 text-sm font-medium text-amber-700 dark:text-amber-400 hover:bg-amber-500/10 transition-colors touch-manipulation"
                  >
                    <span className="inline-flex items-center gap-2">
                      <FileWarning className="h-4 w-4" />
                      {breakdown.failed.count + breakdown.duplicate.count} need attention
                    </span>
                    <span className="text-xs opacity-80">Review →</span>
                  </button>
                </PopoverTrigger>
                <PopoverContent align="center" className="w-80 p-0">
                <div className="px-3 py-2 border-b">
                  <p className="text-sm font-semibold">Payments needing attention</p>
                  <p className="text-[11px] text-muted-foreground">
                    Some payments could not be sent or already exist on the server.
                  </p>
                </div>
                {/* Plain-language fix-it checklist — guides the agent step by step */}
                {(() => {
                  const dupCount = breakdown.duplicate.count;
                  const failCount = breakdown.failed.count;
                  const steps = [
                    {
                      key: 'duplicate' as const,
                      label: dupCount > 0
                        ? `Check the ${dupCount} payment${dupCount === 1 ? '' : 's'} already on the server`
                        : 'Check duplicate payments',
                      done: dupCount === 0,
                      active: dupCount > 0,
                      action: dupCount > 0
                        ? {
                            label: 'Skip',
                            busy: resolvingAction === 'skip' || resolvingAction === 'auto',
                            onClick: async () => {
                              setResolvingAction('skip');
                              try {
                                const n = await skipAllDuplicates();
                                await refreshTodayTotals();
                                if (n > 0) toast.success(`${n} duplicate${n === 1 ? '' : 's'} skipped — server version kept`);
                                else toast.info('No duplicates to skip');
                              } finally {
                                setResolvingAction(null);
                              }
                            },
                          }
                        : null,
                    },
                    {
                      key: 'failed' as const,
                      label: failCount > 0
                        ? `Retry the ${failCount} payment${failCount === 1 ? '' : 's'} that did not send`
                        : 'Retry failed payments',
                      done: failCount === 0,
                      active: dupCount === 0 && failCount > 0,
                      action: failCount > 0
                        ? {
                            label: 'Retry',
                            busy: resolvingAction === 'retry' || resolvingAction === 'auto',
                            onClick: async () => {
                              setResolvingAction('retry');
                              try {
                                const r = await retryAllFailed();
                                await refreshTodayTotals();
                                const parts: string[] = [];
                                if (r.ok) parts.push(`${r.ok} sent`);
                                if (r.dup) parts.push(`${r.dup} new duplicate${r.dup === 1 ? '' : 's'}`);
                                if (r.fail) parts.push(`${r.fail} still failing`);
                                if (parts.length === 0) toast.info('Nothing to retry');
                                else if (r.fail || r.dup) toast.warning(parts.join(' · '));
                                else toast.success(parts.join(' · '));
                              } finally {
                                setResolvingAction(null);
                              }
                            },
                          }
                        : null,
                    },
                    {
                      key: 'confirm' as const,
                      label: 'Confirm today\'s total matches your cash on hand',
                      done: false,
                      active: dupCount === 0 && failCount === 0,
                      action: null,
                    },
                  ];
                  return (
                    <ol className="px-3 py-2.5 border-b space-y-1.5 bg-muted/20">
                      {steps.map((s, i) => (
                        <li
                          key={i}
                          className={cn(
                            'flex items-start gap-2 text-[11px] leading-snug',
                            s.done && 'text-muted-foreground line-through opacity-70',
                            s.active && 'text-foreground font-medium',
                            !s.done && !s.active && 'text-muted-foreground',
                          )}
                        >
                          <span
                            className={cn(
                              'mt-0.5 h-4 w-4 rounded-full border flex items-center justify-center shrink-0 text-[9px] font-bold',
                              s.done && 'bg-emerald-500 border-emerald-500 text-white',
                              s.active && 'border-primary text-primary',
                              !s.done && !s.active && 'border-muted-foreground/40',
                            )}
                          >
                            {s.done ? '✓' : i + 1}
                          </span>
                          <span className="min-w-0 flex-1">{s.label}</span>
                          {s.action && (
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              disabled={!!resolvingAction}
                              onClick={s.action.onClick}
                              className="h-6 px-2 text-[10px] font-medium shrink-0 -my-0.5"
                            >
                              {s.action.busy ? (
                                <Loader2 className="h-3 w-3 animate-spin" />
                              ) : s.key === 'duplicate' ? (
                                <SkipForward className="h-3 w-3 mr-1" />
                              ) : (
                                <RefreshCcw className="h-3 w-3 mr-1" />
                              )}
                              {!s.action.busy && s.action.label}
                            </Button>
                          )}
                        </li>
                      ))}
                    </ol>
                  );
                })()}
                <div className="max-h-64 overflow-y-auto">
                  {today.filter(e => e.syncState === 'duplicate').map(e => {
                    const ref = e.duplicateOfServerId
                      ? `#${e.duplicateOfServerId.slice(0, 8)}`
                      : `#${e.id.slice(0, 8)}`;
                    const snap = e.duplicateServerSnapshot;
                    return (
                      <div key={e.id} className="px-3 py-2 border-b last:border-0 text-[11px] space-y-0.5">
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-medium truncate">{e.tenantName || 'Walk-up'}</span>
                          <span className="text-muted-foreground font-mono text-[10px]">{ref}</span>
                        </div>
                        <div className="flex items-center justify-between text-muted-foreground">
                          <span>Local: {formatUGX(e.amount)}</span>
                          {snap && <span>Server: {formatUGX(snap.amount)}</span>}
                        </div>
                      </div>
                    );
                  })}
                </div>
                <div className="px-3 py-2 border-t space-y-1.5">
                  <Button
                    type="button"
                    size="sm"
                    className="w-full h-8 text-xs gap-1"
                    disabled={!!resolvingAction || (breakdown.duplicate.count === 0 && breakdown.failed.count === 0)}
                    onClick={resolveAllInOrder}
                  >
                    {resolvingAction === 'auto' ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <CheckCircle2 className="h-3.5 w-3.5" />
                    )}
                    {resolvingAction === 'auto' ? 'Resolving…' : 'Resolve all in order'}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="w-full h-8 text-xs gap-1 text-muted-foreground"
                    disabled={!!resolvingAction}
                    onClick={() => {
                      setDupPopoverOpen(false);
                      setReconcileOpen(true);
                    }}
                  >
                    <FileWarning className="h-3.5 w-3.5" />
                    Review one-by-one instead
                  </Button>
                </div>
              </PopoverContent>
            </Popover>
            )}
          </div>
        );
      })()}

      {/* Time-of-day sessions — collapsed by default to keep main view calm */}
      <details className="group">
        <summary className="cursor-pointer text-[11px] uppercase tracking-wide text-muted-foreground font-medium hover:text-foreground select-none flex items-center justify-between">
          <span>By time of day</span>
          <span className="text-[10px] normal-case tracking-normal opacity-70 group-open:hidden">Show</span>
          <span className="text-[10px] normal-case tracking-normal opacity-70 hidden group-open:inline">Hide</span>
        </summary>
        <div className="grid grid-cols-3 gap-2 mt-2">
          {sessions.map(s => (
            <div
              key={s.label}
              className={cn(
                'rounded-2xl px-3 py-2.5 text-center',
                s.count === 0 ? 'bg-muted/30 opacity-60' : 'bg-muted/50',
              )}
            >
              <p className="text-[11px] text-muted-foreground truncate" title={s.label}>
                {s.label.split(' (')[0]}
              </p>
              <p className="text-base font-bold tabular-nums leading-tight mt-1">
                {formatUGX(s.total)}
              </p>
              <p className="text-[10px] text-muted-foreground mt-0.5">
                {s.count} payment{s.count === 1 ? '' : 's'}
              </p>
            </div>
          ))}
        </div>
      </details>

      {/* View details */}
      <button
        type="button"
        onClick={() => setDetailsOpen(true)}
        className="w-full text-sm font-semibold text-primary hover:underline py-2 min-h-[44px] touch-manipulation"
        style={{ WebkitTapHighlightColor: 'transparent' }}
      >
        See every payment →
      </button>
      <FieldCollectDailyDetailsSheet open={detailsOpen} onOpenChange={setDetailsOpen} />
      <FieldCollectReconciliationSheet open={reconcileOpen} onOpenChange={setReconcileOpen} />
    </div>
  );
}

function formatRelative(ts: number): string {
  const sec = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (sec < 5) return 'just now';
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  return `${hr}h ago`;
}