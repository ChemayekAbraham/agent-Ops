import { useEffect, useMemo, useState } from 'react';
import {
  Home,
  Banknote,
  Users,
  Wallet,
  AlertTriangle,
  Loader2,
  RefreshCw,
  ChevronRight,
  ChevronDown,
  MapPin,
  FilterX,
  Search,
  ChevronLeft,
  ArrowUp,
  ArrowDown,
  ArrowUpDown,
} from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { formatUGX } from '@/lib/rentCalculations';
import CollectingGeographyDrilldown, {
  HORIZONS as COLLECTING_HORIZONS,
  DEFAULT_HORIZON,
} from '@/components/landlord-ops/CollectingGeographyDrilldown';

import {
  useLandlordFloatOverview,
  useLandlordFloatDrilldown,
  useLandlordPayoutsPage,
  useLandlordPayoutsGeo,
  useLandlordPayoutsGeoPage,
  useLandlordPayoutSources,
  useLandlordFloatNeededGeo,
  type LandlordFloatDrilldownKind,
  type LandlordFloatNeededGeoRow,
  useApprovedDistricts,
  useDistrictAliasStatus,

  useMapDistrictAlias,


} from '@/hooks/useLandlordFloatOverview';

const KAMPALA = 'Africa/Kampala';

function fmtDateTime(value?: string | null) {
  if (!value) return '—';
  return new Date(value).toLocaleString('en-GB', {
    timeZone: KAMPALA,
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function StatTile({
  label,
  value,
  sub,
  icon: Icon,
  tone = 'default',
  onClick,
}: {
  label: string;
  value: string;
  sub?: string;
  icon: typeof Home;
  tone?: 'default' | 'amber' | 'emerald' | 'sky';
  onClick?: () => void;
}) {
  const toneRing =
    tone === 'amber'
      ? 'border-amber-500/30 bg-amber-500/5'
      : tone === 'emerald'
        ? 'border-emerald-500/30 bg-emerald-500/5'
        : tone === 'sky'
          ? 'border-sky-500/30 bg-sky-500/5'
          : 'border-border/60 bg-card';
  const inner = (
    <>
      <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        <Icon className="h-3.5 w-3.5" />
        <span className="truncate">{label}</span>
        {onClick && <ChevronRight className="ml-auto h-3.5 w-3.5 shrink-0 opacity-60" />}
      </div>
      <p className="mt-2 text-xl font-bold tabular-nums leading-tight">{value}</p>
      {sub && <p className="mt-1 text-xs text-muted-foreground">{sub}</p>}
    </>
  );

  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        className={`rounded-xl border p-4 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${toneRing}`}
      >
        {inner}
      </button>
    );
  }

  return <div className={`rounded-xl border p-4 ${toneRing}`}>{inner}</div>;
}

function TableShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-border/60">
      <table className="w-full text-sm">{children}</table>
    </div>
  );
}

const TH = 'px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground whitespace-nowrap';
const TD = 'px-3 py-2 align-middle whitespace-nowrap';

/** One column of a drill-down table. */
interface DrillColumn {
  key: string;
  label: string;
  type?: 'text' | 'ugx' | 'date' | 'badge';
  align?: 'left' | 'right';
}

interface DrillTarget {
  title: string;
  description?: string;
  columns: DrillColumn[];
  /** Rows already loaded by the overview RPC. */
  rows?: Record<string, any>[];
  /** Or fetch the underlying rows from the drill-down RPC. */
  kind?: LandlordFloatDrilldownKind;
  filterKey?: string | null;
}

function DrillCell({ column, row }: { column: DrillColumn; row: Record<string, any> }) {
  const raw = row[column.key];
  if (column.type === 'ugx') {
    return (
      <td className={`${TD} text-right tabular-nums font-medium`}>{formatUGX(Number(raw) || 0)}</td>
    );
  }
  if (column.type === 'date') {
    return <td className={TD}>{fmtDateTime(raw)}</td>;
  }
  if (column.type === 'badge') {
    return (
      <td className={TD}>
        {raw ? (
          <Badge variant="outline" className="text-[10px]">
            {String(raw).replace(/_/g, ' ')}
          </Badge>
        ) : (
          '—'
        )}
      </td>
    );
  }
  return (
    <td className={`${TD} ${column.align === 'right' ? 'text-right tabular-nums' : ''}`}>
      {raw === null || raw === undefined || raw === '' ? '—' : String(raw)}
    </td>
  );
}

const PAGE_SIZE = 25;
const GEO_PAGE_SIZE = 15;

/** Sortable columns of the server-paged payout geography breakdown. */
const GEO_COLUMNS: DrillColumn[] = [
  { key: 'country', label: 'Country' },
  { key: 'region', label: 'Region' },
  { key: 'district', label: 'District' },
  { key: 'payouts', label: 'Payouts', align: 'right' },
  { key: 'amount', label: 'Amount paid', type: 'ugx' },
];

/** Free-text match across every displayed column value of a read-only row. */
function matchesSearch(row: Record<string, any>, columns: DrillColumn[], query: string) {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return columns.some((c) => {
    const raw = row[c.key];
    if (raw === null || raw === undefined) return false;
    const text = c.type === 'date' ? `${fmtDateTime(raw)} ${String(raw)}` : String(raw);
    return text.toLowerCase().includes(q);
  });
}

/** Search box for narrowing already-loaded drill-down rows. */
function DrillSearch({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
}) {
  return (
    <div className="relative w-full sm:w-[280px]">
      <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="h-8 pl-8 text-sm"
      />
    </div>
  );
}

/** Page controls for read-only drill-down tables. */
function DrillPager({
  page,
  pageCount,
  total,
  from,
  to,
  onPage,
}: {
  page: number;
  pageCount: number;
  total: number;
  from: number;
  to: number;
  onPage: (p: number) => void;
}) {
  if (total === 0) return null;
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 pt-1 text-xs text-muted-foreground">
      <span>
        Showing {from.toLocaleString()}–{to.toLocaleString()} of {total.toLocaleString()}
      </span>
      {pageCount > 1 && (
        <div className="flex items-center gap-1.5">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 px-2"
            disabled={page <= 1}
            onClick={() => onPage(page - 1)}
          >
            <ChevronLeft className="h-3.5 w-3.5" />
          </Button>
          <span className="tabular-nums">
            Page {page} of {pageCount}
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 px-2"
            disabled={page >= pageCount}
            onClick={() => onPage(page + 1)}
          >
            <ChevronRight className="h-3.5 w-3.5" />
          </Button>
        </div>
      )}
    </div>
  );
}

type SortDir = 'asc' | 'desc';

/**
 * Clickable column header. Presentation only — it just reports which column and
 * direction the operator picked; no figure is recalculated.
 */
function SortableTh({
  column,
  active,
  dir,
  onSort,
}: {
  column: DrillColumn;
  active: boolean;
  dir: SortDir;
  onSort: (key: string) => void;
}) {
  const right = column.type === 'ugx' || column.align === 'right';
  return (
    <th className={`${TH} ${right ? 'text-right' : ''} p-0`}>
      <button
        type="button"
        onClick={() => onSort(column.key)}
        aria-label={`Sort by ${column.label}`}
        className={`flex w-full items-center gap-1 px-3 py-2 text-left hover:text-foreground ${
          right ? 'justify-end' : ''
        } ${active ? 'text-foreground' : ''}`}
      >
        <span className="truncate">{column.label}</span>
        {active ? (
          dir === 'asc' ? (
            <ArrowUp className="h-3 w-3 shrink-0" />
          ) : (
            <ArrowDown className="h-3 w-3 shrink-0" />
          )
        ) : (
          <ArrowUpDown className="h-3 w-3 shrink-0 opacity-30" />
        )}
      </button>
    </th>
  );
}

/**
 * Landlord payout register with server-side date-range, search, totals and
 * pagination. Filtering, counting and totalling all happen in
 * `landlord_ops_payouts_page`, so the register stays fast with millions of
 * landlords and payouts. Read-only: nothing is recalculated or changed.
 */
function ServerPayoutTable({
  columns,
  scope,
  agentId,
  emptyText,
  maxHeight = '50vh',
  caption,
}: {
  columns: DrillColumn[];
  scope: 'all_time' | 'completed';
  agentId?: string | null;
  emptyText: string;
  maxHeight?: string;
  caption?: string;
}) {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState('disbursed_at');
  const [dir, setDir] = useState<SortDir>('desc');
  const [country, setCountry] = useState('');
  const [region, setRegion] = useState('');
  const [district, setDistrict] = useState('');
  const [geoPage, setGeoPage] = useState(1);
  const [geoSort, setGeoSort] = useState('amount');
  const [geoDir, setGeoDir] = useState<SortDir>('desc');
  const [sourceId, setSourceId] = useState<string | null>(null);
  const [locSearch, setLocSearch] = useState('');

  const toggleGeoSort = (key: string) => {
    if (key === geoSort) {
      setGeoDir((d) => (d === 'desc' ? 'asc' : 'desc'));
    } else {
      setGeoSort(key);
      setGeoDir(key === 'amount' || key === 'payouts' ? 'desc' : 'asc');
    }
    setGeoPage(1);
  };

  const toggleSort = (key: string) => {
    if (key === sort) {
      setDir((d) => (d === 'desc' ? 'asc' : 'desc'));
    } else {
      setSort(key);
      setDir(key === 'amount' || key === 'disbursed_at' || key === 'created_at' ? 'desc' : 'asc');
    }
    setPage(1);
  };

  // Debounced so typing never fires a query per keystroke at scale.
  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput), 350);
    return () => clearTimeout(t);
  }, [searchInput]);

  useEffect(() => {
    setPage(1);
  }, [from, to, search, scope, agentId, country, region, district]);

  useEffect(() => {
    setGeoPage(1);
  }, [from, to, search, scope, agentId, country, region, district]);

  const { data, isLoading, isFetching, isError, error } = useLandlordPayoutsPage({
    scope,
    search,
    from,
    to,
    agentId: agentId ?? null,
    page,
    pageSize: PAGE_SIZE,
    sort,
    dir,
    country,
    region,
    district,
  });

  // Filter option lists: the same payout population grouped through the approved
  // country -> region -> district hierarchy. One small aggregate read.
  const geoQuery = useLandlordPayoutsGeo({
    scope,
    search,
    from,
    to,
    agentId: agentId ?? null,
  });
  const geoRows = geoQuery.data ?? [];

  // The visible breakdown table: grouped, filtered, sorted, counted and paged on
  // the server, so it stays fast at any payout volume. Read-only.
  const geoPageQuery = useLandlordPayoutsGeoPage({
    scope,
    search,
    from,
    to,
    agentId: agentId ?? null,
    country,
    region,
    district,
    page: geoPage,
    pageSize: GEO_PAGE_SIZE,
    sort: geoSort,
    dir: geoDir,
  });

  const countries = useMemo(
    () => Array.from(new Set(geoRows.map((r) => r.country))).sort(),
    [geoRows],
  );
  const regions = useMemo(
    () =>
      Array.from(
        new Set(geoRows.filter((r) => !country || r.country === country).map((r) => r.region)),
      ).sort(),
    [geoRows, country],
  );
  const districts = useMemo(
    () =>
      Array.from(
        new Set(
          geoRows
            .filter((r) => (!country || r.country === country) && (!region || r.region === region))
            .map((r) => r.district),
        ),
      ).sort(),
    [geoRows, country, region],
  );

  // Locate a place by any part of its recorded location details and jump the
  // register straight to its payouts. Matching runs over the already-loaded
  // grouped totals; nothing is recalculated.
  const locMatches = useMemo(() => {
    const q = locSearch.trim().toLowerCase();
    if (!q) return [];
    return geoRows
      .filter((r) =>
        `${r.district} ${r.region} ${r.country}`.toLowerCase().includes(q),
      )
      .sort((a, b) => b.amount - a.amount)
      .slice(0, 20);
  }, [geoRows, locSearch]);

  const geoBreakdown = geoPageQuery.data?.rows ?? [];
  const geoTotalRows = geoPageQuery.data?.total_count ?? 0;
  const geoPageCount = Math.max(1, Math.ceil(geoTotalRows / GEO_PAGE_SIZE));
  const geoStart = (geoPage - 1) * GEO_PAGE_SIZE;

  const rows = data?.rows ?? [];
  const total = data?.total_count ?? 0;
  const totalAmount = data?.total_amount ?? 0;
  const isFiltered = !!from || !!to || !!search.trim() || !!country || !!region || !!district;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const start = (page - 1) * PAGE_SIZE;
  const geoLabel = district || region || country || 'all locations';

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-2 rounded-lg border border-border/60 bg-muted/30 p-3">
        <div className="space-y-1">
          <label className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Paid from
          </label>
          <Input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="h-8 w-[150px] text-sm"
          />
        </div>
        <div className="space-y-1">
          <label className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Paid to
          </label>
          <Input
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="h-8 w-[150px] text-sm"
          />
        </div>
        <div className="space-y-1">
          <label className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Search
          </label>
          <DrillSearch
            value={searchInput}
            onChange={setSearchInput}
            placeholder="Landlord, phone, amount, reference…"
          />
        </div>
        <div className="space-y-1">
          <label className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Country
          </label>
          <Select
            value={country || 'all'}
            onValueChange={(v) => {
              setCountry(v === 'all' ? '' : v);
              setRegion('');
              setDistrict('');
            }}
          >
            <SelectTrigger className="h-8 w-[150px] text-sm">
              <SelectValue placeholder="All countries" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All countries</SelectItem>
              {countries.map((c) => (
                <SelectItem key={c} value={c}>
                  {c}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <label className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Region
          </label>
          <Select
            value={region || 'all'}
            onValueChange={(v) => {
              setRegion(v === 'all' ? '' : v);
              setDistrict('');
            }}
          >
            <SelectTrigger className="h-8 w-[160px] text-sm">
              <SelectValue placeholder="All regions" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All regions</SelectItem>
              {regions.map((r) => (
                <SelectItem key={r} value={r}>
                  {r}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <label className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            District
          </label>
          <Select
            value={district || 'all'}
            onValueChange={(v) => setDistrict(v === 'all' ? '' : v)}
          >
            <SelectTrigger className="h-8 w-[180px] text-sm">
              <SelectValue placeholder="All districts" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All districts</SelectItem>
              {districts.map((d) => (
                <SelectItem key={d} value={d}>
                  {d}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="relative space-y-1">
          <label className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Find a location
          </label>
          <DrillSearch
            value={locSearch}
            onChange={setLocSearch}
            placeholder="District, region, country…"
          />
          {locSearch.trim() !== '' && (
            <div className="absolute left-0 top-[58px] z-20 w-[280px] overflow-hidden rounded-lg border border-border bg-popover shadow-lg">
              {locMatches.length === 0 ? (
                <p className="px-3 py-2 text-xs text-muted-foreground">
                  No location matches that spelling.
                </p>
              ) : (
                <ul className="max-h-[240px] overflow-y-auto py-1">
                  {locMatches.map((m) => (
                    <li key={`${m.country}|${m.region}|${m.district}`}>
                      <button
                        type="button"
                        className="flex w-full items-start justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-muted/60"
                        onClick={() => {
                          setCountry(m.country);
                          setRegion(m.region);
                          setDistrict(m.district);
                          setLocSearch('');
                        }}
                      >
                        <span className="min-w-0">
                          <span className="block truncate font-medium">{m.district}</span>
                          <span className="block truncate text-[11px] text-muted-foreground">
                            {m.region} · {m.country} · {m.payouts.toLocaleString()} payout
                            {m.payouts === 1 ? '' : 's'}
                          </span>
                        </span>
                        <span className="shrink-0 text-xs font-semibold tabular-nums">
                          {formatUGX(m.amount)}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
        {isFiltered && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-8"
            onClick={() => {
              setFrom('');
              setTo('');
              setSearchInput('');
              setSearch('');
              setCountry('');
              setRegion('');
              setDistrict('');
            }}
          >
            <FilterX className="mr-1.5 h-3.5 w-3.5" />
            Clear filters
          </Button>
        )}
      </div>

      {/* Where the money went: district totals for the current selection, grouped,
          sorted, counted and paged on the server. */}
      <div className="rounded-lg border border-border/60">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 bg-muted/40 px-3 py-2">
          <span className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            <MapPin className="h-3.5 w-3.5" />
            Paid out by location · {geoLabel}
          </span>
          <span className="text-xs text-muted-foreground">
            {geoPageQuery.isLoading
              ? 'Loading…'
              : `${geoTotalRows.toLocaleString()} district${geoTotalRows === 1 ? '' : 's'} · ${
                  (geoPageQuery.data?.total_payouts ?? 0).toLocaleString()
                } payouts · ${formatUGX(geoPageQuery.data?.total_amount ?? 0)}`}
            {geoPageQuery.isFetching && !geoPageQuery.isLoading ? ' · updating…' : ''}
          </span>
        </div>
        {geoPageQuery.isError ? (
          <div className="p-3">
            <p className="text-sm font-medium text-destructive">
              The location breakdown could not be loaded.
            </p>
            <ErrorDetails error={geoPageQuery.error} />
          </div>
        ) : (
          <>
            <div className="max-h-[280px] overflow-y-auto">
              <TableShell>
                <thead className="sticky top-0 bg-muted/60 backdrop-blur">
                  <tr>
                    {GEO_COLUMNS.map((c) => (
                      <SortableTh
                        key={c.key}
                        column={c}
                        active={geoSort === c.key}
                        dir={geoDir}
                        onSort={toggleGeoSort}
                      />
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {geoPageQuery.isLoading &&
                    [0, 1, 2].map((i) => (
                      <tr key={`g-${i}`} className="border-t border-border/50">
                        <td className={TD} colSpan={GEO_COLUMNS.length}>
                          <Skeleton className="h-5 w-full" />
                        </td>
                      </tr>
                    ))}
                  {!geoPageQuery.isLoading && geoBreakdown.length === 0 && (
                    <tr>
                      <td className={`${TD} text-muted-foreground`} colSpan={GEO_COLUMNS.length}>
                        No payouts recorded for this selection.
                      </td>
                    </tr>
                  )}
                  {!geoPageQuery.isLoading &&
                    geoBreakdown.map((g) => {
                      const drill = () => {
                        setCountry(g.country);
                        setRegion(g.region);
                        setDistrict(g.district);
                      };
                      return (
                        <tr
                          key={`${g.country}|${g.region}|${g.district}`}
                          className="cursor-pointer border-t border-border/50 hover:bg-muted/40"
                          role="button"
                          tabIndex={0}
                          title="Open the payouts recorded in this district"
                          onClick={drill}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault();
                              drill();
                            }
                          }}
                        >
                          <td className={TD}>{g.country}</td>
                          <td className={TD}>{g.region}</td>
                          <td className={TD}>
                            <span className="flex items-center gap-1.5">
                              {g.district}
                              {g.unmatched && (
                                <Badge
                                  variant="outline"
                                  className="border-amber-500/40 text-[10px] text-amber-600"
                                >
                                  Unmatched spelling
                                </Badge>
                              )}
                            </span>
                          </td>
                          <td className={`${TD} text-right tabular-nums`}>
                            {g.payouts.toLocaleString()}
                          </td>
                          <td className={`${TD} text-right font-semibold tabular-nums`}>
                            {formatUGX(g.amount)}
                          </td>
                        </tr>
                      );
                    })}
                </tbody>
              </TableShell>
            </div>
            <div className="border-t border-border/60 px-3">
              <DrillPager
                page={geoPage}
                pageCount={geoPageCount}
                total={geoTotalRows}
                from={geoTotalRows === 0 ? 0 : geoStart + 1}
                to={Math.min(geoStart + GEO_PAGE_SIZE, geoTotalRows)}
                onPage={setGeoPage}
              />
            </div>
          </>
        )}
      </div>


      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <span className="text-muted-foreground">
          {caption ? `${caption} · ` : ''}
          {isLoading
            ? 'Counting…'
            : `${total.toLocaleString()} record${total === 1 ? '' : 's'}${
                isFiltered ? ' matching your filters' : ''
              }`}
          {isFetching && !isLoading ? ' · updating…' : ''}
        </span>
        <span className="font-semibold tabular-nums">{formatUGX(totalAmount)}</span>
      </div>

      {isError ? (
        <div className="py-4">
          <p className="text-sm font-medium text-destructive">
            These payout records could not be loaded.
          </p>
          <ErrorDetails error={error} />
        </div>
      ) : (
        <div className="overflow-y-auto" style={{ maxHeight }}>
          <TableShell>
            <thead className="sticky top-0 bg-muted/60 backdrop-blur">
              <tr>
                {columns.map((c) => (
                  <SortableTh
                    key={c.key}
                    column={c}
                    active={sort === c.key}
                    dir={dir}
                    onSort={toggleSort}
                  />
                ))}
              </tr>
            </thead>
            <tbody>
              {isLoading &&
                [0, 1, 2, 3, 4].map((i) => (
                  <tr key={`s-${i}`} className="border-t border-border/50">
                    <td className={TD} colSpan={columns.length}>
                      <Skeleton className="h-5 w-full" />
                    </td>
                  </tr>
                ))}
              {!isLoading && rows.length === 0 && (
                <tr>
                  <td className={`${TD} text-muted-foreground`} colSpan={columns.length}>
                    {isFiltered ? 'No records match these filters.' : emptyText}
                  </td>
                </tr>
              )}
              {!isLoading &&
                rows.map((r, i) => (
                  <tr
                    key={r.id ?? `${start + i}`}
                    className="cursor-pointer border-t border-border/50 hover:bg-muted/40"
                    role="button"
                    tabIndex={0}
                    title="Open the source transactions behind this payout"
                    onClick={() => r.id && setSourceId(String(r.id))}
                    onKeyDown={(e) => {
                      if ((e.key === 'Enter' || e.key === ' ') && r.id) {
                        e.preventDefault();
                        setSourceId(String(r.id));
                      }
                    }}
                  >
                    {columns.map((c) => (
                      <DrillCell key={c.key} column={c} row={r as Record<string, any>} />
                    ))}
                  </tr>
                ))}
            </tbody>
          </TableShell>
        </div>
      )}

      <DrillPager
        page={page}
        pageCount={pageCount}
        total={total}
        from={total === 0 ? 0 : start + 1}
        to={Math.min(start + PAGE_SIZE, total)}
        onPage={setPage}
      />

      <PayoutSourcesDialog payoutId={sourceId} onClose={() => setSourceId(null)} />
    </div>
  );
}

/**
 * Read-only source transactions behind a single payout: the recorded payout and
 * the ledger legs posted against it, straight from the RPC.
 */
function PayoutSourcesDialog({
  payoutId,
  onClose,
}: {
  payoutId: string | null;
  onClose: () => void;
}) {
  const { data, isLoading, isError, error } = useLandlordPayoutSources(payoutId);
  const payout = data?.payout ?? null;
  const legs = data?.legs ?? [];

  return (
    <Dialog open={!!payoutId} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Source transactions behind this payout</DialogTitle>
          <DialogDescription>
            The recorded payout and every ledger entry posted against it. Read-only.
          </DialogDescription>
        </DialogHeader>

        {isError ? (
          <div>
            <p className="text-sm font-medium text-destructive">
              The source transactions could not be loaded.
            </p>
            <ErrorDetails error={error} />
          </div>
        ) : isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-24 w-full" />
          </div>
        ) : (
          <div className="space-y-4">
            {payout && (
              <div className="grid gap-2 rounded-lg border border-border/60 bg-muted/30 p-3 text-sm sm:grid-cols-2">
                <div>
                  <span className="text-muted-foreground">Landlord: </span>
                  {payout.landlord_name || '—'}
                  {payout.landlord_phone ? ` · ${payout.landlord_phone}` : ''}
                </div>
                <div>
                  <span className="text-muted-foreground">Amount: </span>
                  <span className="font-semibold tabular-nums">
                    {formatUGX(Number(payout.amount) || 0)}
                  </span>
                </div>
                <div>
                  <span className="text-muted-foreground">Tenant: </span>
                  {payout.tenant_name || '—'}
                </div>
                <div>
                  <span className="text-muted-foreground">Paid via: </span>
                  {payout.provider || '—'} · {payout.reference || 'no reference'}
                </div>
                <div>
                  <span className="text-muted-foreground">Agent: </span>
                  {payout.agent_name || '—'}
                </div>
                <div>
                  <span className="text-muted-foreground">Paid on: </span>
                  {fmtDateTime(payout.disbursed_at) || fmtDateTime(payout.created_at)}
                </div>
              </div>
            )}

            <div className="max-h-[45vh] overflow-y-auto rounded-lg border border-border/60">
              <TableShell>
                <thead className="sticky top-0 bg-muted/60 backdrop-blur">
                  <tr>
                    <th className={TH}>When</th>
                    <th className={TH}>Category</th>
                    <th className={TH}>Direction</th>
                    <th className={`${TH} text-right`}>Amount</th>
                    <th className={TH}>Description</th>
                    <th className={TH}>Reference</th>
                  </tr>
                </thead>
                <tbody>
                  {legs.length === 0 && (
                    <tr>
                      <td className={`${TD} text-muted-foreground`} colSpan={6}>
                        No ledger entries recorded against this payout.
                      </td>
                    </tr>
                  )}
                  {legs.map((l) => (
                    <tr key={String(l.id)} className="border-t border-border/50">
                      <td className={TD}>{fmtDateTime(l.transaction_date)}</td>
                      <td className={TD}>{String(l.category ?? '—').replace(/_/g, ' ')}</td>
                      <td className={TD}>{l.direction || '—'}</td>
                      <td className={`${TD} text-right tabular-nums`}>
                        {formatUGX(Number(l.amount) || 0)}
                      </td>
                      <td className={TD}>{l.description || '—'}</td>
                      <td className={TD}>{l.reference_id || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </TableShell>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function PaidAllTimeDrillPanel() {
  return (
    <ServerPayoutTable
      columns={PAYOUT_ALL_COLUMNS}
      scope="all_time"
      emptyText="No payout records found."
      caption="Payout records behind the all-time total"
    />
  );
}


/**
 * Read-only drill-down table with free-text search and pagination. Rows come
 * straight from the drill-down RPC; nothing is recalculated or changed.
 */
function SearchablePagedTable({
  columns,
  rows,
}: {
  columns: DrillColumn[];
  rows: Record<string, any>[];
}) {
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<string | null>(null);
  const [dir, setDir] = useState<SortDir>('desc');

  const toggleSort = (key: string) => {
    if (key === sort) {
      setDir((d) => (d === 'desc' ? 'asc' : 'desc'));
    } else {
      const col = columns.find((c) => c.key === key);
      setSort(key);
      setDir(col?.type === 'ugx' || col?.type === 'date' ? 'desc' : 'asc');
    }
    setPage(1);
  };

  const searched = useMemo(
    () => rows.filter((r) => matchesSearch(r, columns, search)),
    [rows, columns, search],
  );

  // Sorting only reorders the recorded rows; no value is recalculated.
  const filtered = useMemo(() => {
    if (!sort) return searched;
    const col = columns.find((c) => c.key === sort);
    const numeric = col?.type === 'ugx';
    const dateLike = col?.type === 'date';
    const sign = dir === 'asc' ? 1 : -1;
    return [...searched].sort((a, b) => {
      const av = a[sort];
      const bv = b[sort];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (numeric) return ((Number(av) || 0) - (Number(bv) || 0)) * sign;
      if (dateLike) {
        return (new Date(av).getTime() - new Date(bv).getTime()) * sign;
      }
      return String(av).localeCompare(String(bv), undefined, { sensitivity: 'base' }) * sign;
    });
  }, [searched, sort, dir, columns]);
  const total = useMemo(() => {
    const col = columns.find((c) => c.type === 'ugx');
    return col ? filtered.reduce((sum, r) => sum + (Number(r[col.key]) || 0), 0) : 0;
  }, [filtered, columns]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  useEffect(() => {
    setPage(1);
  }, [search, rows]);
  const safePage = Math.min(page, pageCount);
  const start = (safePage - 1) * PAGE_SIZE;
  const visible = filtered.slice(start, start + PAGE_SIZE);
  const isSearching = !!search.trim();

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <DrillSearch value={search} onChange={setSearch} placeholder="Search these records…" />
          {isSearching && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-8"
              onClick={() => setSearch('')}
            >
              <FilterX className="mr-1.5 h-3.5 w-3.5" />
              Clear
            </Button>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-muted-foreground">
            {isSearching
              ? `${filtered.length.toLocaleString()} of ${rows.length.toLocaleString()} records`
              : `${rows.length.toLocaleString()} record${rows.length === 1 ? '' : 's'}`}
          </span>
          {total > 0 && <span className="font-semibold tabular-nums">{formatUGX(total)}</span>}
        </div>
      </div>
      <div className="max-h-[60vh] overflow-y-auto">
        <TableShell>
          <thead className="sticky top-0 bg-muted/60 backdrop-blur">
            <tr>
              {columns.map((c) => (
                <SortableTh
                  key={c.key}
                  column={c}
                  active={sort === c.key}
                  dir={dir}
                  onSort={toggleSort}
                />
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr>
                <td className={`${TD} text-muted-foreground`} colSpan={columns.length || 1}>
                  {isSearching ? 'No records match your search.' : 'Nothing recorded here.'}
                </td>
              </tr>
            )}
            {visible.map((r, i) => (
              <tr
                key={String(r.id ?? r.rent_request_id ?? r.agent_id ?? start + i)}
                className="border-t border-border/50"
              >
                {columns.map((c) => (
                  <DrillCell key={c.key} column={c} row={r} />
                ))}
              </tr>
            ))}
          </tbody>
        </TableShell>
      </div>
      <DrillPager
        page={safePage}
        pageCount={pageCount}
        total={filtered.length}
        from={filtered.length === 0 ? 0 : start + 1}
        to={Math.min(start + PAGE_SIZE, filtered.length)}
        onPage={setPage}
      />
      <p className="text-xs text-muted-foreground">
        Read-only records, shown exactly as recorded. Up to 500 rows.
      </p>
    </>
  );
}

function DrillDownDialog({
  target,
  onClose,
}: {
  target: DrillTarget | null;
  onClose: () => void;
}) {
  const isPayouts = target?.kind === 'payouts' || target?.kind === 'payouts_all';
  const { data: fetched, isLoading, isError, error } = useLandlordFloatDrilldown(
    target?.rows || isPayouts ? null : (target?.kind ?? null),
    target?.filterKey ?? null,
  );
  const rows = target?.rows ?? fetched ?? [];

  return (
    <Dialog open={!!target} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-5xl">
        <DialogHeader>
          <DialogTitle className="text-base">{target?.title}</DialogTitle>
          {target?.description && (
            <DialogDescription>{target.description}</DialogDescription>
          )}
        </DialogHeader>

        {isPayouts ? (
          <ServerPayoutTable
            key={`${target?.kind}-${target?.filterKey ?? 'all'}`}
            columns={target?.columns ?? []}
            scope={target?.kind === 'payouts_all' ? 'all_time' : 'completed'}
            agentId={target?.filterKey ?? null}
            emptyText="No payout records found."
            maxHeight="55vh"
          />
        ) : isLoading ? (
          <div className="space-y-2 py-4">
            {[0, 1, 2, 3, 4].map((i) => (
              <Skeleton key={i} className="h-8 w-full" />
            ))}
          </div>
        ) : isError ? (
          <div className="py-6">
            <p className="text-sm font-medium text-destructive">These records could not be loaded.</p>
            <ErrorDetails error={error} />
          </div>
        ) : (

          <SearchablePagedTable
            key={`${target?.kind}-${target?.filterKey ?? 'all'}`}
            columns={target?.columns ?? []}
            rows={rows}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

const EMPTY_HOUSE_COLUMNS: DrillColumn[] = [
  { key: 'title', label: 'House' },
  { key: 'district', label: 'District' },
  { key: 'sub_county', label: 'Sub-county' },
  { key: 'village', label: 'Village' },
  { key: 'landlord_name', label: 'Landlord' },
  { key: 'landlord_phone', label: 'Landlord phone' },
  { key: 'agent_name', label: 'Listing agent' },
  { key: 'amount', label: 'Monthly rent', type: 'ugx' },
  { key: 'created_at', label: 'Listed', type: 'date' },
];

const WAITING_COLUMNS: DrillColumn[] = [
  { key: 'tenant_name', label: 'Tenant' },
  { key: 'landlord_name', label: 'Landlord' },
  { key: 'landlord_phone', label: 'Landlord phone' },
  { key: 'district', label: 'District' },
  { key: 'status', label: 'Stage', type: 'badge' },
  { key: 'amount', label: 'Rent needed', type: 'ugx' },
  { key: 'created_at', label: 'Requested', type: 'date' },
];

const NEEDED_DISTRICT_COLUMNS: DrillColumn[] = [
  { key: 'source', label: 'Source', type: 'badge' },
  { key: 'name', label: 'House / Tenant' },
  { key: 'recorded_district', label: 'Recorded district' },
  { key: 'landlord_name', label: 'Landlord' },
  { key: 'landlord_phone', label: 'Landlord phone' },
  { key: 'agent_name', label: 'Agent' },
  { key: 'sub_county', label: 'Sub-county' },
  { key: 'village', label: 'Village' },
  { key: 'amount', label: 'Rent needed', type: 'ugx' },
  { key: 'created_at', label: 'Recorded', type: 'date' },
];

const PAYOUT_COLUMNS: DrillColumn[] = [
  { key: 'landlord_name', label: 'Landlord' },
  { key: 'landlord_phone', label: 'Landlord phone' },
  { key: 'tenant_name', label: 'Tenant' },
  { key: 'agent_name', label: 'Agent' },
  { key: 'region', label: 'Region' },
  { key: 'district', label: 'District' },
  { key: 'provider', label: 'Channel' },
  { key: 'reference', label: 'Reference' },
  { key: 'amount', label: 'Amount', type: 'ugx' },
  { key: 'disbursed_at', label: 'Paid', type: 'date' },
];

const PAYOUT_ALL_COLUMNS: DrillColumn[] = [
  { key: 'landlord_name', label: 'Landlord' },
  { key: 'landlord_phone', label: 'Landlord phone' },
  { key: 'tenant_name', label: 'Tenant' },
  { key: 'agent_name', label: 'Agent' },
  { key: 'region', label: 'Region' },
  { key: 'district', label: 'District' },
  { key: 'provider', label: 'Channel' },
  { key: 'reference', label: 'Reference' },
  { key: 'amount', label: 'Amount', type: 'ugx' },
  { key: 'status', label: 'Status', type: 'badge' },
  { key: 'disbursed_at', label: 'Paid', type: 'date' },
];

const COLLECTING_COLUMNS: DrillColumn[] = [
  { key: 'tenant_name', label: 'Tenant' },
  { key: 'landlord_name', label: 'Landlord' },
  { key: 'landlord_phone', label: 'Landlord phone' },
  { key: 'status', label: 'Status', type: 'badge' },
  { key: 'contracted', label: 'Expected total', type: 'ugx' },
  { key: 'collected', label: 'Collected', type: 'ugx' },
  { key: 'outstanding', label: 'Outstanding', type: 'ugx' },
  { key: 'funded_at', label: 'Funded', type: 'date' },
];

const AGENT_COLUMNS: DrillColumn[] = [
  { key: 'agent_name', label: 'Agent' },
  { key: 'agent_phone', label: 'Phone' },
  { key: 'region', label: 'Region' },
  { key: 'balance', label: 'Float held', type: 'ugx' },
  { key: 'total_funded', label: 'Funded', type: 'ugx' },
  { key: 'total_paid_out', label: 'Paid out', type: 'ugx' },
  { key: 'updated_at', label: 'Last movement', type: 'date' },
];

const PORTFOLIO_COLUMNS: DrillColumn[] = [
  { key: 'portfolio_code', label: 'Portfolio' },
  { key: 'partner_name', label: 'Funder' },
  { key: 'partner_phone', label: 'Phone' },
  { key: 'status', label: 'Status', type: 'badge' },
  { key: 'duration_months', label: 'Months', align: 'right' },
  { key: 'amount', label: 'Capital', type: 'ugx' },
  { key: 'created_at', label: 'Created', type: 'date' },
];

const ATTACHED_COLUMNS: DrillColumn[] = [
  { key: 'partner_name', label: 'Funder' },
  { key: 'house_title', label: 'House' },
  { key: 'district', label: 'District' },
  { key: 'landlord_name', label: 'Landlord' },
  { key: 'status', label: 'Status', type: 'badge' },
  { key: 'amount', label: 'Principal', type: 'ugx' },
  { key: 'supported_at', label: 'Attached', type: 'date' },
];

/**
 * Renders the full backend error (PostgREST/RPC): code, message, details and
 * hint — so a permission denial, a missing function, or a bad request is
 * distinguishable at a glance.
 */
/**
 * Geographic breakdown of the float need: cascading Country -> Region ->
 * District filters over the read-only geo RPC. Clicking a district opens the
 * combined drill-down (empty houses + awaiting funding) for that district.
 */
/**
 * One-click mapping of an unmatched recorded spelling to an approved district.
 * Records an alias only — the location text on the underlying house, landlord
 * or tenant records is never rewritten.
 */
function MapDistrictDialog({
  recordedText,
  onClose,
}: {
  recordedText: string | null;
  onClose: () => void;
}) {
  const { data: districts = [], isLoading } = useApprovedDistricts(!!recordedText);
  const mapAlias = useMapDistrictAlias();
  const [region, setRegion] = useState<string | null>(null);
  const [districtId, setDistrictId] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const { data: status, isLoading: statusLoading } = useDistrictAliasStatus(recordedText);

  const existing = status?.override ?? status?.approved ?? null;
  const conflicted = !!existing || status?.normalisable === false;

  const regions = [...new Set(districts.map((d) => d.region ?? 'Unspecified'))].sort();
  const districtChoices = districts.filter((d) => !region || (d.region ?? 'Unspecified') === region);
  const reasonTooShort = reason.trim().length < 10;

  const reset = () => {
    setRegion(null);
    setDistrictId(null);
    setReason('');
    mapAlias.reset();
  };

  return (
    <Dialog
      open={!!recordedText}
      onOpenChange={(open) => {
        if (!open) {
          reset();
          onClose();
        }
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-base">Map "{recordedText}" to a district</DialogTitle>
          <DialogDescription>
            This links the recorded spelling to an approved district so its houses and tenants show
            under the right region. The spelling saved on the records themselves is left untouched.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {statusLoading && (
            <p className="text-xs text-muted-foreground">Checking existing mappings…</p>
          )}

          {status?.normalisable === false && (
            <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 dark:bg-amber-950/20">
              <p className="text-sm font-medium text-amber-800 dark:text-amber-300">
                This spelling cannot be mapped
              </p>
              <p className="mt-1 text-xs text-amber-800/80 dark:text-amber-300/80">
                The recorded text has no usable letters, so it cannot be linked to a district.
              </p>
            </div>
          )}

          {existing && (
            <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 dark:bg-amber-950/20">
              <p className="text-sm font-medium text-amber-800 dark:text-amber-300">
                Already pointing at {existing.district_name}
                {existing.region ? ` (${existing.region})` : ''}
              </p>
              <p className="mt-1 text-xs text-amber-800/80 dark:text-amber-300/80">
                {status?.override
                  ? 'Someone has already mapped this spelling. Adding another mapping would conflict with it, so this is blocked. Change or remove the existing mapping first.'
                  : 'This spelling already matches an approved district, so no mapping is needed.'}
              </p>
              {status?.override?.reason && (
                <p className="mt-1.5 text-xs text-amber-800/70 dark:text-amber-300/70">
                  Reason given: {status.override.reason}
                </p>
              )}
            </div>
          )}

          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Region</label>
            <Select
              value={region ?? ''}
              onValueChange={(v) => {
                setRegion(v);
                setDistrictId(null);
              }}
              disabled={isLoading || conflicted}
            >
              <SelectTrigger>
                <SelectValue placeholder={isLoading ? 'Loading…' : 'Choose a region'} />
              </SelectTrigger>
              <SelectContent>
                {regions.map((r) => (
                  <SelectItem key={r} value={r}>
                    {r}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">District</label>
            <Select
              value={districtId ?? ''}
              onValueChange={setDistrictId}
              disabled={isLoading || !region || conflicted}
            >
              <SelectTrigger>
                <SelectValue placeholder={region ? 'Choose a district' : 'Choose a region first'} />
              </SelectTrigger>
              <SelectContent className="max-h-72">
                {districtChoices.map((d) => (
                  <SelectItem key={d.id} value={String(d.id)}>
                    {d.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">
              Why this mapping (at least 10 characters)
            </label>
            <Textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              disabled={conflicted}
              placeholder="e.g. Recorded as a misspelling of Wakiso by the field agent"
            />
          </div>

          {mapAlias.isError && (
            <div className="rounded-lg border border-destructive/40 p-3">
              <p className="text-sm font-medium text-destructive">This mapping was not saved.</p>
              <ErrorDetails error={mapAlias.error} />
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2">
          <Button
            variant="ghost"
            onClick={() => {
              reset();
              onClose();
            }}
          >
            Cancel
          </Button>
          <Button
            disabled={!districtId || reasonTooShort || conflicted || statusLoading || mapAlias.isPending}
            onClick={async () => {
              if (!recordedText || !districtId) return;
              try {
                await mapAlias.mutateAsync({
                  recordedText,
                  districtId: Number(districtId),
                  reason: reason.trim(),
                });
                reset();
                onClose();
              } catch {
                /* error shown above */
              }
            }}
          >
            {mapAlias.isPending && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}
            Map district
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function NeededByLocation({

  onOpenDistrict,
}: {
  onOpenDistrict: (row: LandlordFloatNeededGeoRow) => void;
}) {

  const { data, isLoading, isError, error, refetch } = useLandlordFloatNeededGeo();
  const [country, setCountry] = useState<string | null>(null);
  const [region, setRegion] = useState<string | null>(null);
  const [mapping, setMapping] = useState<string | null>(null);


  const rows = data ?? [];
  const countries = [...new Set(rows.map((r) => r.country))].sort();
  const regions = [
    ...new Set(rows.filter((r) => !country || r.country === country).map((r) => r.region)),
  ].sort();
  const filtered = rows.filter(
    (r) => (!country || r.country === country) && (!region || r.region === region),
  );
  const totals = filtered.reduce(
    (acc, r) => ({
      houses: acc.houses + r.houses,
      amount: acc.amount + r.amount,
    }),
    { houses: 0, amount: 0 },
  );

  if (isLoading) {
    return (
      <div className="space-y-2">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-8 w-full" />
        ))}
      </div>
    );
  }

  if (isError) {
    return (
      <div className="rounded-lg border border-destructive/40 p-4">
        <p className="text-sm font-medium text-destructive">
          The geographic breakdown could not be loaded.
        </p>
        <ErrorDetails error={error} />
        <Button size="sm" variant="outline" className="mt-3" onClick={() => refetch()}>
          <RefreshCw className="mr-2 h-3.5 w-3.5" /> Retry
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={country ?? 'all'}
          onValueChange={(v) => {
            setCountry(v === 'all' ? null : v);
            setRegion(null);
          }}
        >
          <SelectTrigger className="w-44">
            <SelectValue placeholder="Country" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All countries</SelectItem>
            {countries.map((c) => (
              <SelectItem key={c} value={c}>
                {c}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={region ?? 'all'} onValueChange={(v) => setRegion(v === 'all' ? null : v)}>
          <SelectTrigger className="w-44">
            <SelectValue placeholder="Region" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All regions</SelectItem>
            {regions.map((r) => (
              <SelectItem key={r} value={r}>
                {r}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {(country || region) && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setCountry(null);
              setRegion(null);
            }}
          >
            Reset
          </Button>
        )}
        <span className="ml-auto text-xs text-muted-foreground">
          {totals.houses.toLocaleString()} houses ·{' '}
          <span className="font-semibold text-foreground tabular-nums">
            {formatUGX(totals.amount)}
          </span>
        </span>
      </div>

      <TableShell>
        <thead className="bg-muted/40">
          <tr>
            <th className={TH}>District</th>
            <th className={TH}>Region</th>
            <th className={`${TH} text-right`}>Empty houses</th>
            <th className={`${TH} text-right`}>Awaiting funding</th>
            <th className={`${TH} text-right`}>Total needed</th>
            <th className={`${TH} text-right`}>Action</th>
          </tr>
        </thead>
        <tbody>
          {filtered.length === 0 && (
            <tr>
              <td className={`${TD} text-muted-foreground`} colSpan={6}>
                No float need recorded for this selection.
              </td>
            </tr>
          )}
          {filtered.map((r) => (
            <tr
              key={`${r.country}|${r.region}|${r.district}`}
              className="border-t border-border/50 cursor-pointer hover:bg-muted/40"
              tabIndex={0}
              role="button"
              onClick={() => onOpenDistrict(r)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onOpenDistrict(r);
                }
              }}
            >
              <td className={TD}>
                <span className="inline-flex items-center gap-2">
                  {r.district}
                  {r.country === 'Unmapped' && (
                    <Badge variant="outline" className="text-[10px] text-amber-700 border-amber-300">
                      Unmapped
                    </Badge>
                  )}
                </span>
              </td>
              <td className={`${TD} text-muted-foreground`}>{r.region}</td>
              <td className={`${TD} text-right tabular-nums`}>
                {r.empty_houses.toLocaleString()} · {formatUGX(r.empty_amount)}
              </td>
              <td className={`${TD} text-right tabular-nums`}>
                {r.waiting_houses.toLocaleString()} · {formatUGX(r.waiting_amount)}
              </td>
              <td className={`${TD} text-right tabular-nums font-medium`}>{formatUGX(r.amount)}</td>
              <td className={`${TD} text-right`}>
                {r.country === 'Unmapped' && r.district !== 'Unspecified' ? (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-[11px]"
                    onClick={(e) => {
                      e.stopPropagation();
                      setMapping(r.district);
                    }}
                  >
                    <MapPin className="mr-1.5 h-3 w-3" /> Map district
                  </Button>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </TableShell>

      <MapDistrictDialog recordedText={mapping} onClose={() => setMapping(null)} />
    </div>

  );
}

function ErrorDetails({ error }: { error: unknown }) {
  if (!error) {
    return <p className="mt-1 text-sm text-muted-foreground">Unknown error — please try again.</p>;
  }
  const e = error as { message?: string; code?: string; details?: string; hint?: string };
  return (
    <div className="mt-2 space-y-1 rounded-lg border border-destructive/30 bg-destructive/5 p-3 font-mono text-xs">
      {e.code && (
        <p>
          <span className="text-muted-foreground">code: </span>
          <span className="font-semibold text-destructive">{e.code}</span>
        </p>
      )}
      <p className="break-words">
        <span className="text-muted-foreground">message: </span>
        <span>{e.message || String(error)}</span>
      </p>
      {e.details && (
        <p className="break-words">
          <span className="text-muted-foreground">details: </span>
          <span>{e.details}</span>
        </p>
      )}
      {e.hint && (
        <p className="break-words">
          <span className="text-muted-foreground">hint: </span>
          <span>{e.hint}</span>
        </p>
      )}
    </div>
  );
}

export default function LandlordFloat() {
  const { data, isLoading, isError, error, refetch, isFetching } = useLandlordFloatOverview();
  const [tab, setTab] = useState('needed');
  // Shared projection horizon between the Being collected tile and its drilldown.
  const [collectingHorizonKey, setCollectingHorizonKey] = useState<string>(DEFAULT_HORIZON);
  const [drill, setDrill] = useState<DrillTarget | null>(null);
  const [showPaidAllTime, setShowPaidAllTime] = useState(false);

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-9 w-64" />
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-24 w-full" />
          ))}
        </div>
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (isError || !data) {
    return (
      <Card className="border-destructive/40">
        <CardContent className="flex items-start gap-3 p-5">
          <AlertTriangle className="h-5 w-5 shrink-0 text-destructive" />
          <div className="min-w-0">
            <p className="font-semibold">Landlord float could not be loaded</p>
            <ErrorDetails error={error} />
            <Button size="sm" variant="outline" className="mt-3" onClick={() => refetch()}>
              <RefreshCw className="mr-2 h-3.5 w-3.5" /> Retry
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  const { needed, collecting, with_agents, no_tenant } = data;

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-bold tracking-tight">Landlord Float</h1>
          <p className="text-sm text-muted-foreground">
            Where landlord rent money is needed, where it is being collected, and where it is
            sitting right now. As at {fmtDateTime(data.as_at)} (EAT).
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={() => refetch()} disabled={isFetching}>
          {isFetching ? (
            <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="mr-2 h-3.5 w-3.5" />
          )}
          Refresh
        </Button>
      </div>

      {/* Headline tiles */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label="Float needed"
          value={formatUGX(needed.total_amount)}
          sub={`${needed.total_houses.toLocaleString()} houses`}
          icon={Home}
          tone="amber"
          onClick={() =>
            setDrill({
              title: 'Empty listed houses needing landlord float',
              description: 'Every listed house that is still empty, with its landlord and listing agent.',
              columns: EMPTY_HOUSE_COLUMNS,
              kind: 'empty_houses',
            })
          }
        />
        <StatTile
          label="Being collected"
          value={formatUGX(collecting.expected.expected)}
          sub={`${formatUGX(collecting.paid_out.amount)} paid to landlords`}
          icon={Banknote}
          tone="emerald"
          onClick={() =>
            setDrill({
              title: 'Live rent plans still being collected',
              description: 'Tenants in funded houses, their landlords and what is still outstanding.',
              columns: COLLECTING_COLUMNS,
              rows: collecting.rows,
            })
          }
        />
        <StatTile
          label="With agents"
          value={formatUGX(with_agents.summary.amount)}
          sub={`${with_agents.summary.agents.toLocaleString()} agents holding float`}
          icon={Users}
          tone="sky"
          onClick={() =>
            setDrill({
              title: 'Agents holding landlord float',
              description: 'Every agent with landlord float still in hand.',
              columns: AGENT_COLUMNS,
              rows: with_agents.rows,
            })
          }
        />
        <StatTile
          label="No tenant attached"
          value={formatUGX(no_tenant.unattached)}
          sub={`${no_tenant.portfolios.toLocaleString()} funder portfolios`}
          icon={Wallet}
          onClick={() =>
            setDrill({
              title: 'Funder portfolios',
              description: 'Live funder capital recorded in Partnership Ops.',
              columns: PORTFOLIO_COLUMNS,
              kind: 'portfolios',
            })
          }
        />
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="flex w-full flex-wrap justify-start gap-1 h-auto">
          <TabsTrigger value="needed">1 · Float needed</TabsTrigger>
          <TabsTrigger value="collecting">2 · Being collected</TabsTrigger>
          <TabsTrigger value="agents">3 · With agents</TabsTrigger>
          <TabsTrigger value="no-tenant">4 · No tenant attached</TabsTrigger>
        </TabsList>

        {/* 1 — Float needed */}
        <TabsContent value="needed" className="mt-4 space-y-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Landlord float needed</CardTitle>
              <p className="text-sm text-muted-foreground">
                Listed houses that are still empty, plus houses that already have a tenant whose
                rent request is still waiting for funding.
              </p>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-3">
                <StatTile
                  label="Empty listed houses"
                  value={formatUGX(needed.empty_houses.amount)}
                  sub={`${needed.empty_houses.houses.toLocaleString()} houses`}
                  icon={Home}
                  onClick={() =>
                    setDrill({
                      title: 'Empty listed houses',
                      description: 'House, landlord, listing agent and monthly rent.',
                      columns: EMPTY_HOUSE_COLUMNS,
                      kind: 'empty_houses',
                    })
                  }
                />
                <StatTile
                  label="Tenant in, awaiting funding"
                  value={formatUGX(needed.waiting_funding.amount)}
                  sub={`${needed.waiting_funding.houses.toLocaleString()} requests`}
                  icon={Home}
                  tone="amber"
                  onClick={() =>
                    setDrill({
                      title: 'Tenants waiting for funding',
                      description: 'Rent requests with a tenant already in the house.',
                      columns: WAITING_COLUMNS,
                      rows: needed.waiting_rows,
                    })
                  }
                />
                <StatTile
                  label="Total float needed"
                  value={formatUGX(needed.total_amount)}
                  sub={`${needed.total_houses.toLocaleString()} houses in total`}
                  icon={Banknote}
                  tone="emerald"
                />
              </div>

              <div className="space-y-2">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Float needed by location
                </p>
                <p className="text-xs text-muted-foreground">
                  Filter by country and region, then open any district to see the exact houses and
                  tenants behind its need. Districts that match no approved location stay under
                  Unmapped with their original spelling — use Map district to link that spelling to
                  an approved district and every float table by location refreshes at once.
                </p>
                <NeededByLocation
                  onOpenDistrict={(row) =>
                    setDrill({
                      title:
                        row.country === 'Unmapped'
                          ? `Unmatched location "${row.district}"`
                          : `Float needed in ${row.district}`,
                      description:
                        row.country === 'Unmapped'
                          ? `These houses and tenants were recorded with the location "${row.district}", which matches no approved district. The spelling is shown exactly as recorded and nothing has been changed.`
                          : 'Empty listed houses and tenants still awaiting funding in this district.',
                      columns: NEEDED_DISTRICT_COLUMNS,
                      kind: 'needed_district',
                      filterKey: row.district,
                    })
                  }
                />

              </div>

              <div className="space-y-2">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Tenants in a house, waiting for funding
                </p>
                <TableShell>
                  <thead className="bg-muted/40">
                    <tr>
                      <th className={TH}>Tenant</th>
                      <th className={TH}>Landlord</th>
                      <th className={TH}>Landlord phone</th>
                      <th className={TH}>District</th>
                      <th className={TH}>Stage</th>
                      <th className={`${TH} text-right`}>Rent needed</th>
                    </tr>
                  </thead>
                  <tbody>
                    {needed.waiting_rows.length === 0 && (
                      <tr>
                        <td className={`${TD} text-muted-foreground`} colSpan={6}>
                          Nothing is waiting for funding.
                        </td>
                      </tr>
                    )}
                    {needed.waiting_rows.map((r) => (
                      <tr key={r.rent_request_id} className="border-t border-border/50">
                        <td className={TD}>{r.tenant_name}</td>
                        <td className={TD}>{r.landlord_name}</td>
                        <td className={TD}>{r.landlord_phone || '—'}</td>
                        <td className={TD}>{r.district}</td>
                        <td className={TD}>
                          <Badge variant="outline" className="text-[10px]">
                            {r.status.replace(/_/g, ' ')}
                          </Badge>
                        </td>
                        <td className={`${TD} text-right tabular-nums font-medium`}>{formatUGX(r.amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </TableShell>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* 2 — Being collected */}
        <TabsContent value="collecting" className="mt-4 space-y-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Landlord float being collected</CardTitle>
              <p className="text-sm text-muted-foreground">
                Rent already paid out to landlords, and what is still expected back from the tenants
                living in those houses.
              </p>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
                <StatTile
                  label="Paid to landlords (all time)"
                  value={formatUGX(collecting.paid_all_time?.amount ?? 0)}
                  sub={`${(collecting.paid_all_time?.payouts ?? 0).toLocaleString()} payouts actually disbursed`}
                  icon={Banknote}
                  tone="emerald"
                  onClick={() =>
                    setDrill({
                      title: 'All money paid to landlords',
                      description:
                        'Every payout whose money actually reached the landlord, all time — including payments still awaiting the agent\'s receipt confirmation.',
                      columns: PAYOUT_ALL_COLUMNS,
                      kind: 'payouts_all',
                    })
                  }
                />
                <StatTile
                  label="Confirmed by agent receipt"
                  value={formatUGX(collecting.paid_out.amount)}
                  sub={`${collecting.paid_out.payouts.toLocaleString()} completed payouts`}
                  icon={Banknote}
                  onClick={() =>
                    setDrill({
                      title: 'Completed landlord payouts',
                      description: 'Each payment made to a landlord, with channel and reference.',
                      columns: PAYOUT_COLUMNS,
                      kind: 'payouts',
                    })
                  }
                />
                <StatTile
                  label="Contracted from tenants"
                  value={formatUGX(collecting.expected.contracted)}
                  sub={`${collecting.expected.plans.toLocaleString()} live rent plans`}
                  icon={Home}
                  onClick={() =>
                    setDrill({
                      title: 'Live rent plans',
                      description: 'Every tenant and landlord behind the contracted total.',
                      columns: COLLECTING_COLUMNS,
                      rows: collecting.rows,
                    })
                  }
                />
                <StatTile
                  label="Collected so far"
                  value={formatUGX(collecting.expected.collected)}
                  icon={Wallet}
                  tone="emerald"
                  onClick={() =>
                    setDrill({
                      title: 'Collected so far, by rent plan',
                      columns: COLLECTING_COLUMNS,
                      rows: collecting.rows,
                    })
                  }
                />
                <StatTile
                  label="Still to collect"
                  value={formatUGX(collecting.expected.expected)}
                  icon={AlertTriangle}
                  tone="amber"
                  onClick={() =>
                    setDrill({
                      title: 'Still to collect, by rent plan',
                      columns: COLLECTING_COLUMNS,
                      rows: collecting.rows,
                    })
                  }
                />
              </div>

              <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5">
                <button
                  type="button"
                  className="flex w-full items-center justify-between gap-2 px-4 py-2.5 text-left text-sm font-medium hover:bg-emerald-500/10"
                  onClick={() => setShowPaidAllTime((v) => !v)}
                >
                  <span>
                    Source transactions behind the all-time total —{' '}
                    <span className="tabular-nums font-semibold">
                      {formatUGX(collecting.paid_all_time?.amount ?? 0)}
                    </span>
                  </span>
                  {showPaidAllTime ? (
                    <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
                  ) : (
                    <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                  )}
                </button>
                {showPaidAllTime && (
                  <div className="border-t border-emerald-500/20 px-4 py-3">
                    <PaidAllTimeDrillPanel />
                  </div>
                )}
              </div>

              <CollectingGeographyDrilldown />

              <TableShell>

                <thead className="bg-muted/40">
                  <tr>
                    <th className={TH}>Tenant</th>
                    <th className={TH}>Landlord</th>
                    <th className={TH}>Landlord phone</th>
                    <th className={`${TH} text-right`}>Rent paid</th>
                    <th className={`${TH} text-right`}>Expected total</th>
                    <th className={`${TH} text-right`}>Collected</th>
                    <th className={`${TH} text-right`}>Outstanding</th>
                    <th className={`${TH} text-right`}>Daily</th>
                    <th className={TH}>Funded</th>
                  </tr>
                </thead>
                <tbody>
                  {collecting.rows.length === 0 && (
                    <tr>
                      <td className={`${TD} text-muted-foreground`} colSpan={9}>
                        No live rent plans.
                      </td>
                    </tr>
                  )}
                  {collecting.rows.map((r) => (
                    <tr key={r.rent_request_id} className="border-t border-border/50">
                      <td className={TD}>{r.tenant_name}</td>
                      <td className={TD}>{r.landlord_name}</td>
                      <td className={TD}>{r.landlord_phone || '—'}</td>
                      <td className={`${TD} text-right tabular-nums`}>{formatUGX(r.rent_amount)}</td>
                      <td className={`${TD} text-right tabular-nums`}>{formatUGX(r.contracted)}</td>
                      <td className={`${TD} text-right tabular-nums text-emerald-600 dark:text-emerald-400`}>
                        {formatUGX(r.collected)}
                      </td>
                      <td className={`${TD} text-right tabular-nums font-medium`}>{formatUGX(r.outstanding)}</td>
                      <td className={`${TD} text-right tabular-nums`}>{formatUGX(r.daily_repayment)}</td>
                      <td className={TD}>{fmtDateTime(r.funded_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </TableShell>
            </CardContent>
          </Card>
        </TabsContent>

        {/* 3 — With agents */}
        <TabsContent value="agents" className="mt-4 space-y-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Landlord float with agents</CardTitle>
              <p className="text-sm text-muted-foreground">
                Landlord payout float still in agents' hands — the same balance each agent sees under
                Landlord Float on their dashboard.
              </p>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-4">
                <StatTile
                  label="Held by agents"
                  value={formatUGX(with_agents.summary.amount)}
                  sub={`${with_agents.summary.agents.toLocaleString()} agents`}
                  icon={Users}
                  tone="sky"
                  onClick={() =>
                    setDrill({
                      title: 'Agents holding landlord float',
                      columns: AGENT_COLUMNS,
                      rows: with_agents.rows,
                    })
                  }
                />
                <StatTile
                  label="Total ever funded"
                  value={formatUGX(with_agents.summary.total_funded)}
                  icon={Banknote}
                  onClick={() =>
                    setDrill({
                      title: 'Float funded to agents',
                      columns: AGENT_COLUMNS,
                      rows: with_agents.rows,
                    })
                  }
                />
                <StatTile
                  label="Total paid to landlords"
                  value={formatUGX(with_agents.summary.total_paid_out)}
                  icon={Home}
                  tone="emerald"
                  onClick={() =>
                    setDrill({
                      title: 'Payouts agents made to landlords',
                      description: 'Every completed landlord payment, with channel and reference.',
                      columns: PAYOUT_COLUMNS,
                      kind: 'payouts',
                    })
                  }
                />
                <StatTile
                  label="Agents holding float"
                  value={with_agents.summary.agents.toLocaleString()}
                  icon={Users}
                  onClick={() =>
                    setDrill({
                      title: 'Agents holding landlord float',
                      columns: AGENT_COLUMNS,
                      rows: with_agents.rows,
                    })
                  }
                />
              </div>

              <TableShell>
                <thead className="bg-muted/40">
                  <tr>
                    <th className={TH}>Agent</th>
                    <th className={TH}>Phone</th>
                    <th className={TH}>Region</th>
                    <th className={`${TH} text-right`}>Float held</th>
                    <th className={`${TH} text-right`}>Funded</th>
                    <th className={`${TH} text-right`}>Paid out</th>
                    <th className={TH}>Last movement</th>
                  </tr>
                </thead>
                <tbody>
                  {with_agents.rows.length === 0 && (
                    <tr>
                      <td className={`${TD} text-muted-foreground`} colSpan={7}>
                        No agent is holding landlord float.
                      </td>
                    </tr>
                  )}
                  {with_agents.rows.map((r) => (
                    <tr
                      key={r.agent_id}
                      className="border-t border-border/50 cursor-pointer hover:bg-muted/40"
                      tabIndex={0}
                      role="button"
                      onClick={() =>
                        setDrill({
                          title: `Landlord payouts by ${r.agent_name}`,
                          description: 'Every completed landlord payment this agent made.',
                          columns: PAYOUT_COLUMNS,
                          kind: 'payouts',
                          filterKey: r.agent_id,
                        })
                      }
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          setDrill({
                            title: `Landlord payouts by ${r.agent_name}`,
                            description: 'Every completed landlord payment this agent made.',
                            columns: PAYOUT_COLUMNS,
                            kind: 'payouts',
                            filterKey: r.agent_id,
                          });
                        }
                      }}
                    >
                      <td className={TD}>{r.agent_name}</td>
                      <td className={TD}>{r.agent_phone || '—'}</td>
                      <td className={TD}>{r.region || '—'}</td>
                      <td className={`${TD} text-right tabular-nums font-medium`}>{formatUGX(r.balance)}</td>
                      <td className={`${TD} text-right tabular-nums`}>{formatUGX(r.total_funded)}</td>
                      <td className={`${TD} text-right tabular-nums`}>{formatUGX(r.total_paid_out)}</td>
                      <td className={TD}>{fmtDateTime(r.updated_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </TableShell>
            </CardContent>
          </Card>
        </TabsContent>

        {/* 4 — No tenant attached */}
        <TabsContent value="no-tenant" className="mt-4 space-y-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Landlord float with no tenant attached</CardTitle>
              <p className="text-sm text-muted-foreground">
                Funder portfolio capital held by the company, and how much of it is not yet attached
                to a house or tenant. Sourced from Partnership Ops records.
              </p>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-3">
                <StatTile
                  label="Total funder portfolios"
                  value={formatUGX(no_tenant.total)}
                  sub={`${no_tenant.portfolios.toLocaleString()} live portfolios`}
                  icon={Wallet}
                  onClick={() =>
                    setDrill({
                      title: 'Funder portfolios',
                      description: 'Each live funder portfolio and its capital.',
                      columns: PORTFOLIO_COLUMNS,
                      kind: 'portfolios',
                    })
                  }
                />
                <StatTile
                  label="Attached to a house"
                  value={formatUGX(no_tenant.attached_amount)}
                  sub={`${no_tenant.attached_houses.toLocaleString()} supported houses`}
                  icon={Home}
                  tone="emerald"
                  onClick={() =>
                    setDrill({
                      title: 'Funder capital attached to houses',
                      description: 'Supported houses with funder, landlord and principal.',
                      columns: ATTACHED_COLUMNS,
                      kind: 'attached_houses',
                    })
                  }
                />
                <StatTile
                  label="Not attached to a tenant"
                  value={formatUGX(no_tenant.unattached)}
                  icon={AlertTriangle}
                  tone="amber"
                  onClick={() =>
                    setDrill({
                      title: 'Funder portfolios',
                      description:
                        'Live portfolios behind the unattached balance. Compare with the attached houses list.',
                      columns: PORTFOLIO_COLUMNS,
                      kind: 'portfolios',
                    })
                  }
                />
              </div>
              <p className="text-xs text-muted-foreground">
                Figures are shown exactly as recorded — nothing is estimated or adjusted here.
              </p>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <DrillDownDialog target={drill} onClose={() => setDrill(null)} />
    </div>
  );
}
