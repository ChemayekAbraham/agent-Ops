/**
 * "Tenant Classification" tab — Active, Waiting for landlord payment, Dormant, Inactive, plus a
 * "Needs review" flag. Presentation only: the category, sub-label, counts, amounts and dates all come
 * from `tops_tenant_classification_summary` / `_list` (read-only, built on the shared payout clock).
 * Nothing here recomputes a start date or an amount.
 */
import { useEffect, useMemo, useState } from 'react';
import type { DateRange } from 'react-day-picker';
import { useSearchParams } from 'react-router-dom';
import { format, isValid, parseISO } from 'date-fns';
import { AlertTriangle, CalendarIcon, CheckCircle2, ChevronLeft, ChevronRight, ClipboardCheck, FileText, Hourglass, Loader2, Moon, Sheet as SheetIcon, Smartphone, UserPlus, UserX } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { ExecutiveDataTable, type Column } from '@/components/executive/ExecutiveDataTable';
import { KPICard } from '@/components/executive/KPICard';
import { formatUGX } from '@/lib/rentCalculations';
import {
  CATEGORY_HINTS,
  CATEGORY_LABELS,
  CATEGORY_TONE,
  SUB_LABELS,
  SUB_LABELS_BY_CATEGORY,
  completionText,
  filterDescription,
  formatStatus,
  subLabelText,
  type TenantCategory,
  type TenantClassificationRow,
  type TenantSubLabel,
} from '@/lib/tenantClassification';
import {
  CLASSIFICATION_PAGE_SIZE,
  fetchClassificationRowsForExport,
  useTenantClassificationList,
  useTenantClassificationSummary,
  type ClassificationFilters,
} from '@/hooks/useTenantClassification';
import {
  exportTenantClassificationXlsx,
  generateTenantClassificationPdf,
} from '@/lib/tenantOpsClassificationReport';
import {
  OpsDateRangeFilter, PRESETS, rangePhrase, resolveRange, type PresetKey,
} from '@/components/executive/shared/OpsDateRangeFilter';
import { useTenantSmartphoneUsage } from '@/hooks/useTenantSmartphoneUsage';
import { fmtTenants, joinedWindowHint, kampalaWindow, recordedSmartphoneHint, windowChecksHint } from '@/lib/tenantSmartphoneUsage';

const ALL = 'all';

const fmtDay = (iso: string | null) => (iso ? iso.slice(0, 10) : '');

// The window travels in the URL (tc_range, plus tc_from / tc_to for a custom range) the same way the
// Payment Behaviour and Collection Shortfall tabs carry theirs, so a link can open this tab on a period.
const RANGE_PARAMS = ['tc_range', 'tc_from', 'tc_to'] as const;

function readRange(params: URLSearchParams): { preset: PresetKey; custom?: DateRange } {
  const range = params.get('tc_range');
  if (range === 'custom') {
    const fromRaw = params.get('tc_from');
    const toRaw = params.get('tc_to');
    const from = fromRaw ? parseISO(fromRaw) : null;
    const to = toRaw ? parseISO(toRaw) : null;
    if (from && isValid(from)) return { preset: 'custom', custom: { from, to: to && isValid(to) ? to : from } };
  }
  if (range && PRESETS.some((p) => p.key === range && p.key !== 'custom')) return { preset: range as PresetKey };
  return { preset: 'month' };
}

export default function TenantClassificationTab() {
  const [category, setCategory] = useState<TenantCategory | null>(null);
  const [sub, setSub] = useState<TenantSubLabel | null>(null);
  const [needsReview, setNeedsReview] = useState(false);
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [exporting, setExporting] = useState<'pdf' | 'xlsx' | null>(null);

  // The smartphone window: the same presets Tenant Ops Home and Payment Behaviour use, kept in the URL.
  const [params, setParams] = useSearchParams();
  const [initialRange] = useState(() => readRange(params));
  const [preset, setPreset] = useState<PresetKey>(initialRange.preset);
  const [custom, setCustom] = useState<DateRange | undefined>(initialRange.custom);
  const { start, end } = useMemo(() => resolveRange(preset, custom), [preset, custom]);
  const phrase = useMemo(() => rangePhrase(preset, start, end), [preset, start, end]);
  const { fromDay, toDay } = useMemo(() => kampalaWindow(start, end), [start, end]);

  const writeRange = (nextPreset: PresetKey, nextCustom: DateRange | undefined) => {
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      RANGE_PARAMS.forEach((k) => next.delete(k));
      next.set('tc_range', nextPreset);
      if (nextPreset === 'custom' && nextCustom?.from) {
        next.set('tc_from', format(nextCustom.from, 'yyyy-MM-dd'));
        next.set('tc_to', format(nextCustom.to ?? nextCustom.from, 'yyyy-MM-dd'));
      }
      return next;
    }, { replace: true });
  };
  const changePreset = (p: PresetKey) => { setPreset(p); writeRange(p, custom); };
  const changeCustom = (c: DateRange | undefined) => { setCustom(c); writeRange(preset, c); };

  // The search box waits for a pause in typing before it asks the server.
  useEffect(() => {
    const id = setTimeout(() => { setSearch(searchInput); setPage(0); }, 300);
    return () => clearTimeout(id);
  }, [searchInput]);

  const filters = useMemo<ClassificationFilters>(
    () => ({ category, sub, needsReview, search }),
    [category, sub, needsReview, search],
  );
  const summary = useTenantClassificationSummary();
  const list = useTenantClassificationList(filters, page);
  const usage = useTenantSmartphoneUsage(fromDay, toDay);

  const pickCategory = (next: TenantCategory | null) => {
    setCategory(next);
    setSub(null);
    setPage(0);
  };

  const rows = list.data?.rows ?? [];
  const total = list.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / CLASSIFICATION_PAGE_SIZE));
  const subOptions = category ? SUB_LABELS_BY_CATEGORY[category] : [];
  const s = summary.data;
  const u = usage.data;
  const fmtCount = (n: number | undefined) => (n == null ? '' : n.toLocaleString('en-US'));

  const runExport = async (kind: 'pdf' | 'xlsx') => {
    if (!s) return;
    setExporting(kind);
    const toastId = toast.loading(kind === 'pdf' ? 'Preparing PDF…' : 'Preparing Excel export…');
    try {
      const { rows: all, total: matching, truncated } = await fetchClassificationRowsForExport(filters);
      const meta = { filterText: filterDescription(category, sub, needsReview, search), total: matching };
      if (kind === 'pdf') await generateTenantClassificationPdf(s, all, meta);
      else await exportTenantClassificationXlsx(s, all, meta);
      toast.success(
        truncated ? `Export ready (first ${all.length.toLocaleString('en-US')} of ${matching.toLocaleString('en-US')} tenants)` : 'Export ready',
        { id: toastId },
      );
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Could not prepare the export', { id: toastId });
    } finally {
      setExporting(null);
    }
  };

  const columns = useMemo<Column<TenantClassificationRow>[]>(() => [
    { key: 'tenant_name', label: 'Tenant', render: (_v, r) => (
      <div>
        <p className="font-medium">{r.tenant_name || '—'}</p>
        <p className="text-[11px] text-muted-foreground">{r.tenant_phone || r.tenant_id.slice(0, 8)}</p>
      </div>
    ) },
    { key: 'category', label: 'Category', render: (_v, r) => (
      <div className="space-y-1">
        <Badge variant="outline" className={CATEGORY_TONE[r.category]}>{CATEGORY_LABELS[r.category]}</Badge>
        {r.sub_label && <p className="text-[11px] text-muted-foreground">{subLabelText(r.sub_label)}</p>}
      </div>
    ) },
    { key: 'needs_review', label: 'Needs review', render: (_v, r) => (
      r.needs_review ? (
        <div className="space-y-0.5">
          <Badge variant="outline" className="border-rose-200 bg-rose-100 text-rose-800">Needs review</Badge>
          {r.review_reasons && <p className="max-w-[220px] text-[11px] text-muted-foreground">{r.review_reasons}</p>}
        </div>
      ) : null
    ) },
    { key: 'running_plans', label: 'Rent Plans', className: 'hidden md:table-cell', render: (_v, r) => (
      <span className="text-xs">{r.running_plans} running · {r.completed_plans} finished</span>
    ) },
    { key: 'outstanding_ugx', label: 'Still owing', className: 'hidden md:table-cell', render: (_v, r) => (
      r.category === 'active' || r.category === 'waiting' ? formatUGX(Number(r.outstanding_ugx) || 0) : '—'
    ) },
    { key: 'completed_on', label: 'Finished', className: 'hidden lg:table-cell', render: (_v, r) => completionText(r) ?? '—' },
    { key: 'latest_status', label: 'Latest request', className: 'hidden lg:table-cell', render: (_v, r) => (
      <div>
        <p className="text-xs">{formatStatus(r.latest_status) || '—'}</p>
        <p className="text-[11px] text-muted-foreground">{fmtDay(r.latest_request_at)}</p>
      </div>
    ) },
    { key: 'latest_agent_name', label: 'Agent', className: 'hidden xl:table-cell', render: (_v, r) => r.latest_agent_name || '—' },
  ], []);

  return (
    <div className="space-y-3">
      {/* Page-level period, at the top of the page. The category counts below are a point-in-time
          snapshot ("As of …") and are not narrowed by this window; it drives the smartphone figures. */}
      <div className="flex flex-row flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-xl border border-border/70 bg-muted/20 px-3 py-2" data-testid="page-period-bar">
        <div className="flex items-center gap-1.5 whitespace-nowrap">
          <CalendarIcon aria-hidden className="h-3.5 w-3.5 shrink-0 text-primary" />
          <p className="shrink-0 text-xs font-semibold leading-tight">Period</p>
          <p className="hidden text-[11px] leading-tight text-muted-foreground sm:block">· applies to the smartphone figures</p>
        </div>
        <OpsDateRangeFilter preset={preset} custom={custom} onPresetChange={changePreset} onCustomChange={changeCustom} className="shrink-0" />
      </div>
      <div className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-start sm:justify-between">
        <p className="min-w-0 break-words text-xs text-muted-foreground" data-testid="classification-note">
          Every tenant is in exactly one category. Counted from the day after the landlord was paid.
          {s?.as_of ? ` As of ${s.as_of}.` : ''}
        </p>
        <div className="grid grid-cols-1 gap-1.5 min-[380px]:grid-cols-2 sm:flex sm:shrink-0 sm:flex-wrap sm:items-center sm:justify-end">
          <Button variant="outline" size="sm" className="w-full gap-1.5 sm:w-auto" disabled={!s || exporting !== null} onClick={() => runExport('pdf')}>
            {exporting === 'pdf' ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileText className="h-4 w-4" />}
            Professional PDF
          </Button>
          <Button variant="outline" size="sm" className="w-full gap-1.5 sm:w-auto" disabled={!s || exporting !== null} onClick={() => runExport('xlsx')}>
            {exporting === 'xlsx' ? <Loader2 className="h-4 w-4 animate-spin" /> : <SheetIcon className="h-4 w-4" />}
            Export Excel
          </Button>
        </div>
      </div>

      {summary.isLoading ? (
        <Skeleton className="h-24 w-full" />
      ) : summary.isError ? (
        <p className="text-xs text-destructive" data-testid="classification-error">
          Could not load the counts: {summary.error instanceof Error ? summary.error.message : 'unknown error'}
        </p>
      ) : s ? (
        <div className="grid grid-cols-1 gap-2 min-[360px]:grid-cols-2 md:grid-cols-3 xl:grid-cols-5" data-testid="classification-cards">
          <KPICard title={CATEGORY_LABELS.active} value={fmtCount(s.active)} icon={CheckCircle2} color="bg-success/10 text-success"
            subtitle={CATEGORY_HINTS.active} onClick={() => pickCategory('active')} />
          <KPICard title={CATEGORY_LABELS.waiting} value={fmtCount(s.waiting)} icon={Hourglass} color="bg-warning/10 text-warning"
            subtitle={CATEGORY_HINTS.waiting} onClick={() => pickCategory('waiting')} />
          <KPICard title={CATEGORY_LABELS.dormant} value={fmtCount(s.dormant)} icon={Moon} color="bg-primary/10 text-primary"
            subtitle={`${fmtCount(s.dormant_renewal_in_progress)} ${SUB_LABELS.renewal_in_progress.toLowerCase()}`} onClick={() => pickCategory('dormant')} />
          <KPICard title={CATEGORY_LABELS.inactive} value={fmtCount(s.inactive)} icon={UserX} color="bg-muted text-muted-foreground"
            subtitle={`${fmtCount(s.inactive_never_requested)} never requested · ${fmtCount(s.inactive_request_in_review)} in review · ${fmtCount(s.inactive_only_rejected_cancelled)} only rejected or cancelled`}
            onClick={() => pickCategory('inactive')} />
          <KPICard title="Needs review" value={fmtCount(s.needs_review)} icon={AlertTriangle} color="bg-destructive/10 text-destructive"
            subtitle="Plan status and amounts do not agree" onClick={() => { setNeedsReview((v) => !v); setPage(0); }} />
        </div>
      ) : null}

      {/* Smartphone use. One card for the whole population, two for the chosen window. The categories
          above are a point-in-time snapshot and are not narrowed by the window. */}
      <div className="space-y-2" data-testid="smartphone-section">
        <div className="flex min-w-0 items-center gap-2">
          <span aria-hidden className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
            <Smartphone className="h-3.5 w-3.5" />
          </span>
          <p className="min-w-0 break-words text-sm font-semibold leading-tight" data-testid="smartphone-note">
            Smartphone use
            <span className="ml-1.5 hidden font-normal text-xs text-muted-foreground sm:inline">
              · recorded at sign-up or by a check
            </span>
          </p>
        </div>
        {usage.isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : usage.isError ? (
          <p className="text-xs text-destructive" data-testid="smartphone-error">
            Could not load the smartphone figures: {usage.error instanceof Error ? usage.error.message : 'unknown error'}
          </p>
        ) : u ? (
          <div className="grid grid-cols-1 gap-2 min-[420px]:grid-cols-2 lg:grid-cols-3" data-testid="smartphone-cards">
            <KPICard title="Use a smartphone" value={fmtTenants(u.recorded_smartphone)} icon={Smartphone}
              color="bg-primary/10 text-primary" subtitle={recordedSmartphoneHint(u)} />
            <KPICard title={`Device checks ${phrase}`} value={fmtTenants(u.checks)} icon={ClipboardCheck}
              color="bg-success/10 text-success" subtitle={windowChecksHint(u)} />
            <KPICard title={`Joined ${phrase}`} value={fmtTenants(u.joined)} icon={UserPlus}
              color="bg-warning/10 text-warning" subtitle={joinedWindowHint(u)} />
          </div>
        ) : null}
      </div>

      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
        <Select value={category ?? ALL} onValueChange={(v) => pickCategory(v === ALL ? null : (v as TenantCategory))}>
          <SelectTrigger className="h-9 w-full sm:w-64" aria-label="Category"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All categories</SelectItem>
            {(Object.keys(CATEGORY_LABELS) as TenantCategory[]).map((c) => (
              <SelectItem key={c} value={c}>{CATEGORY_LABELS[c]}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        {subOptions.length > 0 && (
          <Select value={sub ?? ALL} onValueChange={(v) => { setSub(v === ALL ? null : (v as TenantSubLabel)); setPage(0); }}>
            <SelectTrigger className="h-9 w-full sm:w-64" aria-label="Detail"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All {CATEGORY_LABELS[category as TenantCategory].toLowerCase()}</SelectItem>
              {subOptions.map((o) => <SelectItem key={o} value={o}>{SUB_LABELS[o]}</SelectItem>)}
            </SelectContent>
          </Select>
        )}
        <Button
          variant={needsReview ? 'default' : 'outline'}
          size="sm"
          className="h-9 w-full gap-1.5 sm:w-auto"
          aria-pressed={needsReview}
          onClick={() => { setNeedsReview((v) => !v); setPage(0); }}
        >
          <AlertTriangle className="h-4 w-4" /> Needs review only
        </Button>
        <div className="flex w-full items-center justify-between gap-1.5 sm:ml-auto sm:w-auto sm:justify-start">
          <Button variant="outline" size="sm" disabled={page === 0} onClick={() => setPage((p) => p - 1)} aria-label="Previous page">
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="text-xs text-muted-foreground" data-testid="classification-pager">
            {total.toLocaleString('en-US')} tenant{total === 1 ? '' : 's'} · Page {page + 1} of {totalPages}
          </span>
          <Button variant="outline" size="sm" disabled={page + 1 >= totalPages} onClick={() => setPage((p) => p + 1)} aria-label="Next page">
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <ExecutiveDataTable
        data={rows}
        columns={columns}
        title="Tenants"
        loading={list.isLoading}
        limit={CLASSIFICATION_PAGE_SIZE}
        searchValue={searchInput}
        onSearchChange={setSearchInput}
        searchPlaceholder="Search tenant name or phone…"
        searching={list.isFetching}
      />
    </div>
  );
}
