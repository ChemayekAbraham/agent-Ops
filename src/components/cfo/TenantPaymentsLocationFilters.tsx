// Read-only geographic payment filters for Tenant Products & Services.
// Cascading selects — Country → Region → District → Town/Sub-county → Village —
// each narrowing the options and results below it. Backed by the same
// authoritative reporting RPCs (get_payments_location_breakdown /
// get_payments_location_receipts); nothing here touches payment or accounting
// logic.
import { useEffect, useMemo, useState } from 'react';
import { format } from 'date-fns';
import {
  CalendarIcon,
  ChevronLeft,
  ChevronRight,
  Loader2,
  MapPin,
  Receipt,
  Users,
  Wallet,
  X,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Calendar } from '@/components/ui/calendar';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Separator } from '@/components/ui/separator';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { formatUGX } from '@/lib/rentCalculations';
import {
  usePaymentsAtLocation,
  usePaymentsByLocation,
  type PaymentsLocationLevel,
} from '@/hooks/usePaymentsByLocation';

const ALL = '__all__';
const RECEIPTS_PER_PAGE = 15;

const METHOD_LABEL: Record<string, string> = {
  mobile_money: 'Mobile money',
  cash: 'Cash',
  in_app_wallet: 'In-app wallet',
  unknown: 'Not recorded',
};

const METHOD_BADGE: Record<string, string> = {
  mobile_money: 'bg-muted/60 text-foreground border-border/60',
  cash: 'bg-muted/60 text-foreground border-border/60',
  in_app_wallet: 'bg-muted/60 text-foreground border-border/60',
  unknown: 'bg-muted/40 text-muted-foreground border-border/60',
};

function isoDaysAgo(days: number) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

interface Selection {
  country: string | null;
  region: string | null;
  districtId: number | null;
  districtLabel: string | null;
  subcountyId: number | null;
  subcountyLabel: string | null;
  village: string | null;
}

const EMPTY_SELECTION: Selection = {
  country: null,
  region: null,
  districtId: null,
  districtLabel: null,
  subcountyId: null,
  subcountyLabel: null,
  village: null,
};

export function TenantPaymentsLocationFilters() {
  const [sel, setSel] = useState<Selection>(EMPTY_SELECTION);
  const [dateMode, setDateMode] = useState<'range' | 'day'>('range');
  const [day, setDay] = useState<Date | undefined>(undefined);
  const [from, setFrom] = useState<string>(isoDaysAgo(30));
  const [to, setTo] = useState<string>(new Date().toISOString().slice(0, 10));
  const [method, setMethod] = useState<string>(ALL);

  const methodParam = method === ALL ? null : method;
  // Daily mode pins both bounds to the picked calendar day.
  const dayIso = day ? format(day, 'yyyy-MM-dd') : null;
  const fromParam = dateMode === 'day' ? dayIso : (from || null);
  const toParam = dateMode === 'day' ? dayIso : (to || null);

  // ---- Option lists: every level is independent — each loads whether or not
  // the levels above it are selected, and narrows when parents are chosen. ----
  const countryQ = usePaymentsByLocation({
    level: 'country', from: fromParam, to: toParam, method: methodParam,
  });
  const regionQ = usePaymentsByLocation(
    { level: 'region', country: sel.country, from: fromParam, to: toParam, method: methodParam },
  );
  const districtQ = usePaymentsByLocation(
    {
      level: 'district', country: sel.country, region: sel.region,
      from: fromParam, to: toParam, method: methodParam,
    },
  );
  const subcountyQ = usePaymentsByLocation(
    {
      level: 'subcounty', country: sel.country, region: sel.region, districtId: sel.districtId,
      from: fromParam, to: toParam, method: methodParam,
    },
  );
  const villageQ = usePaymentsByLocation(
    {
      level: 'village', country: sel.country, region: sel.region,
      districtId: sel.districtId, subcountyId: sel.subcountyId,
      from: fromParam, to: toParam, method: methodParam,
    },
  );

  // ---- Results for the current (deepest) selection. ----
  const resultLevel: PaymentsLocationLevel = sel.subcountyId
    ? 'village'
    : sel.districtId
      ? 'subcounty'
      : sel.region
        ? 'district'
        : sel.country
          ? 'region'
          : 'country';

  const results = usePaymentsByLocation({
    level: resultLevel,
    country: sel.country,
    region: sel.region,
    districtId: sel.districtId,
    subcountyId: sel.subcountyId,
    from: fromParam,
    to: toParam,
    method: methodParam,
  });

  // Receipts: at village level show that village's receipts; otherwise the
  // receipts under the currently selected filters.
  const receipts = usePaymentsAtLocation({
    level: sel.subcountyId ? 'village' : resultLevel,
    country: sel.country,
    region: sel.region,
    districtId: sel.districtId,
    subcountyId: sel.subcountyId,
    groupLabel: sel.village,
    from: fromParam,
    to: toParam,
    method: methodParam,
    limit: 200,
  });

  const data = results.data;

  // Receipts pagination — reset to page 1 whenever the filters change.
  const [receiptPage, setReceiptPage] = useState(1);
  useEffect(() => {
    setReceiptPage(1);
  }, [sel, fromParam, toParam, methodParam]);

  const receiptTotal = receipts.data?.payments.length ?? 0;
  const receiptTotalPages = Math.max(1, Math.ceil(receiptTotal / RECEIPTS_PER_PAGE));
  const receiptPageSafe = Math.min(receiptPage, receiptTotalPages);
  const pagedReceipts = useMemo(() => {
    const all = receipts.data?.payments ?? [];
    const start = (receiptPageSafe - 1) * RECEIPTS_PER_PAGE;
    return all.slice(start, start + RECEIPTS_PER_PAGE);
  }, [receipts.data, receiptPageSafe]);

  const pageNumbers = useMemo(() => {
    // Compact window: first, last, and neighbours of the current page.
    const pages = new Set<number>([1, receiptTotalPages]);
    for (let p = receiptPageSafe - 1; p <= receiptPageSafe + 1; p++) {
      if (p >= 1 && p <= receiptTotalPages) pages.add(p);
    }
    return [...pages].sort((a, b) => a - b);
  }, [receiptPageSafe, receiptTotalPages]);

  const summary = useMemo(() => {
    // Totals come from the deepest available breakdown so they always reflect
    // every active filter.
    const deepest = sel.village
      ? receipts.data
      : sel.subcountyId
        ? villageQ.data
        : sel.districtId
          ? subcountyQ.data
          : sel.region
            ? districtQ.data
            : sel.country
              ? regionQ.data
              : countryQ.data;
    if (!deepest) return null;
    return {
      total: deepest.total,
      payment_count: deepest.payment_count,
      tenant_count: deepest.tenant_count,
      unmapped_amount: 'unmapped_amount' in deepest ? deepest.unmapped_amount : 0,
    };
  }, [sel, receipts.data, villageQ.data, subcountyQ.data, districtQ.data, regionQ.data, countryQ.data]);

  const hasAnyFilter =
    !!sel.country || !!sel.region || !!sel.districtId || !!sel.subcountyId || !!sel.village;

  return (
    <Card className="border-border/60">
      <CardHeader className="px-5 py-4 pb-2">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle className="flex items-center gap-2 text-sm sm:text-base">
              <MapPin className="h-4 w-4 text-primary shrink-0" />
              Payment activity by location
            </CardTitle>
            <p className="mt-1 text-[11px] sm:text-xs text-muted-foreground max-w-xl">
              Filter money received by country, region, district, town/sub-county and village — each filter works on its own; picking a lower level fills in the levels above it.
            </p>
          </div>
          {hasAnyFilter && (
            <Button
              size="sm"
              variant="outline"
              className="h-8 px-2.5 text-[11px] shrink-0"
              onClick={() => setSel(EMPTY_SELECTION)}
            >
              <X className="mr-1.5 h-3.5 w-3.5" />
              Reset filters
            </Button>
          )}
        </div>
      </CardHeader>

      <CardContent className="space-y-4 px-5 pb-5 pt-0">
        {/* Date + method filters */}
        <div className="flex items-center gap-1.5 pb-0.5">
          <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground mr-1">
            Filter by
          </span>
          <Button
            type="button"
            size="sm"
            variant={dateMode === 'range' ? 'default' : 'outline'}
            className="h-7 px-2.5 text-[11px]"
            onClick={() => setDateMode('range')}
          >
            Date range
          </Button>
          <Button
            type="button"
            size="sm"
            variant={dateMode === 'day' ? 'default' : 'outline'}
            className="h-7 px-2.5 text-[11px]"
            onClick={() => setDateMode('day')}
          >
            Pick by date
          </Button>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5">
          {dateMode === 'day' ? (
            <div className="space-y-1.5 sm:col-span-2">
              <label className="block text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                Date
              </label>
              <Popover modal>
                <PopoverTrigger asChild>
                  <Button
                    type="button"
                    variant="outline"
                    className={`h-9 w-full justify-start text-left text-xs font-normal ${!day ? 'text-muted-foreground' : ''}`}
                  >
                    <CalendarIcon className="mr-2 h-3.5 w-3.5" />
                    {day ? format(day, 'PPP') : <span>Pick a date</span>}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="start">
                  <Calendar
                    mode="single"
                    selected={day}
                    onSelect={setDay}
                    initialFocus
                    className="p-3 pointer-events-auto"
                  />
                </PopoverContent>
              </Popover>
              <p className="text-[10px] text-muted-foreground">
                Shows payments received on this exact date only.
              </p>
            </div>
          ) : (
            <>
              <div className="space-y-1.5">
                <label className="block text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  From
                </label>
                <Input
                  type="date"
                  value={from}
                  max={to}
                  onChange={(e) => setFrom(e.target.value)}
                  className="h-9 text-xs"
                />
              </div>
              <div className="space-y-1.5">
                <label className="block text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  To
                </label>
                <Input
                  type="date"
                  value={to}
                  min={from}
                  onChange={(e) => setTo(e.target.value)}
                  className="h-9 text-xs"
                />
              </div>
            </>
          )}
          <div className="space-y-1.5">
            <label className="block text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              Payment method
            </label>
            <Select value={method} onValueChange={setMethod}>
              <SelectTrigger className="h-9 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL} className="text-xs">All methods</SelectItem>
                {(data?.methods ?? countryQ.data?.methods ?? []).map((m) => (
                  <SelectItem key={m.method} value={m.method} className="text-xs">
                    {METHOD_LABEL[m.method] ?? m.method}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {/* Cascading location filters */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-2.5">
          <div className="space-y-1.5">
            <label className="block text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              Country
            </label>
            <Select
              value={sel.country ?? ALL}
              onValueChange={(v) =>
                setSel({ ...EMPTY_SELECTION, country: v === ALL ? null : v })
              }
            >
              <SelectTrigger className="h-9 text-xs">
                <SelectValue placeholder="All countries" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL} className="text-xs">All countries</SelectItem>
                {(countryQ.data?.rows ?? []).map((r) => (
                  <SelectItem key={r.label} value={r.label} className="text-xs">
                    {r.label} ({r.payment_count})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <label className="block text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              Region
            </label>
            <Select
              value={sel.region ?? ALL}
              onValueChange={(v) => {
                if (v === ALL) {
                  setSel((s) => ({
                    ...s,
                    region: null, districtId: null, districtLabel: null,
                    subcountyId: null, subcountyLabel: null, village: null,
                  }));
                  return;
                }
                const row = (regionQ.data?.rows ?? []).find((r) => r.label === v);
                setSel({
                  ...EMPTY_SELECTION,
                  country: row?.country ?? sel.country,
                  region: v,
                });
              }}
            >
              <SelectTrigger className="h-9 text-xs">
                <SelectValue placeholder="All regions" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL} className="text-xs">All regions</SelectItem>
                {(regionQ.data?.rows ?? []).map((r) => (
                  <SelectItem key={r.label} value={r.label} className="text-xs">
                    {r.label} ({r.payment_count})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <label className="block text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              District
            </label>
            <Select
              value={sel.districtId != null ? String(sel.districtId) : ALL}
              onValueChange={(v) =>
                setSel((s) => {
                  if (v === ALL) {
                    return { ...s, districtId: null, districtLabel: null, subcountyId: null, subcountyLabel: null, village: null };
                  }
                  const row = (districtQ.data?.rows ?? []).find((r) => String(r.district_id) === v);
                  return {
                    country: row?.country ?? s.country,
                    region: row?.region ?? s.region,
                    districtId: Number(v),
                    districtLabel: row?.label ?? null,
                    subcountyId: null, subcountyLabel: null, village: null,
                  };
                })
              }
            >
              <SelectTrigger className="h-9 text-xs">
                <SelectValue placeholder="All districts" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL} className="text-xs">All districts</SelectItem>
                {(districtQ.data?.rows ?? [])
                  .filter((r) => r.district_id != null)
                  .map((r) => (
                    <SelectItem key={r.district_id} value={String(r.district_id)} className="text-xs">
                      {r.label} ({r.payment_count})
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <label className="block text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              Town / sub-county
            </label>
            <Select
              value={sel.subcountyId != null ? String(sel.subcountyId) : ALL}
              onValueChange={(v) =>
                setSel((s) => {
                  if (v === ALL) {
                    return { ...s, subcountyId: null, subcountyLabel: null, village: null };
                  }
                  const row = (subcountyQ.data?.rows ?? []).find((r) => String(r.subcounty_id) === v);
                  return {
                    country: row?.country ?? s.country,
                    region: row?.region ?? s.region,
                    districtId: row?.district_id ?? s.districtId,
                    districtLabel: row?.district ?? s.districtLabel,
                    subcountyId: Number(v),
                    subcountyLabel: row?.label ?? null,
                    village: null,
                  };
                })
              }
            >
              <SelectTrigger className="h-9 text-xs">
                <SelectValue placeholder="All towns / sub-counties" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL} className="text-xs">All towns / sub-counties</SelectItem>
                {(subcountyQ.data?.rows ?? [])
                  .filter((r) => r.subcounty_id != null)
                  .map((r) => (
                    <SelectItem key={r.subcounty_id} value={String(r.subcounty_id)} className="text-xs">
                      {r.label} ({r.payment_count})
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <label className="block text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              Village
            </label>
            <Select
              value={sel.village ?? ALL}
              onValueChange={(v) =>
                setSel((s) => {
                  if (v === ALL) return { ...s, village: null };
                  const row = (villageQ.data?.rows ?? []).find((r) => r.label === v);
                  return {
                    country: row?.country ?? s.country,
                    region: row?.region ?? s.region,
                    districtId: row?.district_id ?? s.districtId,
                    districtLabel: row?.district ?? s.districtLabel,
                    subcountyId: row?.subcounty_id ?? s.subcountyId,
                    subcountyLabel: s.subcountyLabel,
                    village: v,
                  };
                })
              }
            >
              <SelectTrigger className="h-9 text-xs">
                <SelectValue placeholder="All villages" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL} className="text-xs">All villages</SelectItem>
                {(villageQ.data?.rows ?? []).map((r) => (
                  <SelectItem
                    key={`${r.subcounty_id ?? 'x'}-${r.label}`}
                    value={r.label}
                    className="text-xs"
                  >
                    {r.label}
                    {r.district ? ` — ${r.district}` : ''} ({r.payment_count})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <Separator />

        {/* Totals for the active filter set */}
        {summary && (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-2.5">
            <div className="rounded-xl border border-border/60 bg-card p-2.5">
              <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                <Wallet className="h-3.5 w-3.5" />
                Collected
              </div>
              <p className="mt-1.5 text-sm font-bold font-mono tabular-nums">{formatUGX(summary.total)}</p>
            </div>
            <div className="rounded-xl border border-border/60 bg-card p-2.5">
              <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                <Receipt className="h-3.5 w-3.5" />
                Payments
              </div>
              <p className="mt-1.5 text-sm font-bold font-mono tabular-nums">{summary.payment_count}</p>
            </div>
            <div className="rounded-xl border border-border/60 bg-card p-2.5">
              <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                <Users className="h-3.5 w-3.5" />
                Tenants paying
              </div>
              <p className="mt-1.5 text-sm font-bold font-mono tabular-nums">{summary.tenant_count}</p>
            </div>
            <div className="rounded-xl border border-border/60 bg-card p-2.5">
              <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                <MapPin className="h-3.5 w-3.5" />
                Not placed
              </div>
              <p className="mt-1.5 text-sm font-bold font-mono tabular-nums">{formatUGX(summary.unmapped_amount)}</p>
            </div>
          </div>
        )}

        {/* Where the filtered money sits (one level below the deepest filter) */}
        {!sel.village && (
          <div className="space-y-2">
            <h4 className="text-[11px] sm:text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Location breakdown
            </h4>
            {results.isLoading && (
              <div className="flex items-center gap-2 py-6 justify-center text-[11px] text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading payment activity…
              </div>
            )}
            {results.isError && (
              <p className="py-4 text-center text-[11px] text-destructive">
                Could not load payment activity. Please try again.
              </p>
            )}
            {data && data.rows.length === 0 && !results.isLoading && (
              <p className="py-6 text-center text-[11px] text-muted-foreground bg-muted/30 rounded-xl">
                No payments recorded for this location and period.
              </p>
            )}
            <div className="rounded-xl border border-border/60 bg-card overflow-hidden">
              {(data?.rows ?? []).map((row) => (
                <button
                  key={row.label}
                  type="button"
                  onClick={() => {
                    // Clicking a row moves the matching filter down one level.
                    if (resultLevel === 'country') setSel({ ...EMPTY_SELECTION, country: row.label });
                    else if (resultLevel === 'region') setSel((s) => ({ ...s, region: row.label, districtId: null, districtLabel: null, subcountyId: null, subcountyLabel: null, village: null }));
                    else if (resultLevel === 'district' && row.district_id != null)
                      setSel((s) => ({ ...s, districtId: row.district_id!, districtLabel: row.label, subcountyId: null, subcountyLabel: null, village: null }));
                    else if (resultLevel === 'subcounty' && row.subcounty_id != null)
                      setSel((s) => ({ ...s, subcountyId: row.subcounty_id!, subcountyLabel: row.label, village: null }));
                    else if (resultLevel === 'village') setSel((s) => ({ ...s, village: row.label }));
                  }}
                  className="w-full flex items-center justify-between gap-2 border-b border-border/40 px-3 py-2 last:border-0 text-left hover:bg-muted/40 transition-colors"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-[11px] sm:text-xs font-medium">{row.label}</span>
                    <span className="block text-[9px] sm:text-[10px] text-muted-foreground">
                      {row.payment_count} payment{row.payment_count === 1 ? '' : 's'} · {row.tenant_count} tenant{row.tenant_count === 1 ? '' : 's'}
                      {row.last_payment_at ? ` · last ${format(new Date(row.last_payment_at), 'dd MMM')}` : ''}
                    </span>
                  </span>
                  <span className="shrink-0 font-mono text-[11px] sm:text-xs font-semibold tabular-nums">
                    {formatUGX(row.amount)}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Payments that match the active filters (always shown; village filter narrows further) */}
        <div className="space-y-2">
          <div className="space-y-0.5">
            <div className="flex flex-wrap items-center gap-2">
              <h4 className="text-[11px] sm:text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {sel.village
                  ? `PAYMENTS FOR ${sel.village}`
                  : sel.subcountyLabel
                    ? `PAYMENTS FOR ${sel.subcountyLabel}`
                    : sel.districtLabel
                      ? `PAYMENTS FOR ${sel.districtLabel}`
                      : sel.region
                        ? `PAYMENTS FOR ${sel.region}`
                        : sel.country
                          ? `PAYMENTS FOR ${sel.country}`
                          : 'ALL FILTERED PAYMENTS'}
              </h4>
              {receipts.data && (
                <>
                  <Badge variant="outline" className="px-2 py-0 text-[10px] font-mono">
                    {formatUGX(receipts.data.total)}
                  </Badge>
                  <Badge variant="outline" className="px-2 py-0 text-[10px]">
                    <Users className="mr-1 h-3 w-3" />
                    {receipts.data.tenant_count} tenants
                  </Badge>
                </>
              )}
            </div>
            {(method !== ALL ||
              (dateMode === 'day' && !!day) ||
              (dateMode === 'range' && (from !== isoDaysAgo(30) || to !== new Date().toISOString().slice(0, 10)))) && (
              <p className="text-[10px] text-muted-foreground">
                {[
                  method !== ALL ? (METHOD_LABEL[method] ?? method) : null,
                  dateMode === 'day' && day
                    ? format(day, 'dd MMM yyyy')
                    : dateMode === 'range' && from && to
                      ? `${format(new Date(from), 'dd MMM yyyy')} – ${format(new Date(to), 'dd MMM yyyy')}`
                      : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </p>
            )}
          </div>
          {receipts.isLoading && (
            <div className="flex items-center gap-2 py-6 justify-center text-[11px] text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading receipts…
            </div>
          )}
          {receipts.data && (
            <div className="rounded-xl border border-border/60 bg-card overflow-hidden">
              {receipts.data.payments.length === 0 && (
                <p className="px-3 py-6 text-center text-[11px] text-muted-foreground">
                  No receipts match these filters.
                </p>
              )}
              {pagedReceipts.map((p) => (
                <div
                  key={p.payment_id}
                  className="flex items-start sm:items-center justify-between gap-3 border-b border-border/40 px-3 py-2 last:border-0"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-[11px] sm:text-xs font-medium">
                      {p.tenant || 'Unnamed tenant'}
                    </span>
                    <span className="block text-[9px] sm:text-[10px] text-muted-foreground">
                      {format(new Date(p.paid_at), 'dd MMM yyyy HH:mm')}
                      {p.agent ? ` · ${p.agent}` : ''}
                      {p.village && p.village !== 'Unmapped' ? ` · ${p.village}` : ''}
                    </span>
                  </span>
                  <div className="shrink-0 flex flex-col sm:flex-row items-end sm:items-center gap-1.5 sm:gap-3">
                    <Badge variant="outline" className={`px-1.5 py-0 text-[9px] ${METHOD_BADGE[p.method ?? 'unknown'] ?? METHOD_BADGE.unknown}`}>
                      {METHOD_LABEL[p.method ?? 'unknown'] ?? p.method}
                    </Badge>
                    <span className="font-mono text-[11px] sm:text-xs font-semibold tabular-nums">
                      {formatUGX(p.amount)}
                    </span>
                  </div>
                </div>
              ))}
              {receiptTotal > 0 && (
                <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/40 px-3 py-2 bg-muted/30">
                  <p className="text-[10px] text-muted-foreground">
                    Showing {(receiptPageSafe - 1) * RECEIPTS_PER_PAGE + 1}–
                    {Math.min(receiptPageSafe * RECEIPTS_PER_PAGE, receiptTotal)} of {receiptTotal} receipts
                    {receipts.data.payment_count > receipts.data.returned &&
                      ` (latest ${receipts.data.returned} of ${receipts.data.payment_count} payments)`}
                  </p>
                  {receiptTotalPages > 1 && (
                    <div className="flex items-center gap-1">
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 w-7 p-0"
                        disabled={receiptPageSafe <= 1}
                        onClick={() => setReceiptPage((p) => Math.max(1, p - 1))}
                        aria-label="Previous page"
                      >
                        <ChevronLeft className="h-3.5 w-3.5" />
                      </Button>
                      {pageNumbers.map((p, i) => (
                        <span key={p} className="flex items-center gap-1">
                          {i > 0 && pageNumbers[i - 1] < p - 1 && (
                            <span className="px-0.5 text-[10px] text-muted-foreground">…</span>
                          )}
                          <Button
                            size="sm"
                            variant={p === receiptPageSafe ? 'default' : 'outline'}
                            className="h-7 min-w-7 px-1.5 text-[10px] font-mono"
                            onClick={() => setReceiptPage(p)}
                          >
                            {p}
                          </Button>
                        </span>
                      ))}
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 w-7 p-0"
                        disabled={receiptPageSafe >= receiptTotalPages}
                        onClick={() => setReceiptPage((p) => Math.min(receiptTotalPages, p + 1))}
                        aria-label="Next page"
                      >
                        <ChevronRight className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

export default TenantPaymentsLocationFilters;
