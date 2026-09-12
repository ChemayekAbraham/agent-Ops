import { useEffect, useMemo, useState } from 'react';
import {
  MapPin,
  ChevronRight,
  ChevronLeft,
  Search,
  Loader2,
  AlertTriangle,
  Home,
  Phone,
  User,
  Navigation,
  ImageOff,
  FilterX,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import LocationMapPreview from '@/components/shared/LocationMapPreview';
import { formatUGX } from '@/lib/rentCalculations';
import {
  useCollectingGeoPage,
  useCollectingGeoSuggestions,
  nextCollectingLevel,
  collectingPathKeyFor,
  COLLECTING_GEO_LEVEL_LABELS,
  type CollectingGeoPath,
  type CollectingGeoGroupRow,
  type CollectingGeoHouseRow,
  type CollectingGeoSuggestion,
} from '@/hooks/useCollectingGeoDrilldown';

const PAGE_SIZE = 25;

/**
 * Forward collection horizons. A projection is simply the recorded daily
 * repayment multiplied by the number of days in the chosen horizon — no
 * financial record is read differently or written.
 */
export const HORIZONS = [
  { key: '1w', label: 'Next 1 week', short: '1w', days: 7 },
  { key: '1m', label: 'Next 1 month', short: '1m', days: 30 },
  { key: '3m', label: 'Next 3 months', short: '3m', days: 91 },
  { key: '6m', label: 'Next 6 months', short: '6m', days: 182 },
  { key: '12m', label: 'Next 12 months', short: '12m', days: 365 },
  { key: '2y', label: 'Next 2 years', short: '2y', days: 730 },
  { key: '3y', label: 'Next 3 years', short: '3y', days: 1095 },
  { key: '4y', label: 'Next 4 years', short: '4y', days: 1460 },
  { key: '5y', label: 'Next 5 years', short: '5y', days: 1825 },
] as const;

export const DEFAULT_HORIZON = '12m';

/**
 * The projection horizon always opens on the 12-month view so anyone opening
 * Landlord Float sees the next-12-months collection figure first. Switching the
 * horizon applies for the current view only and is not remembered.
 */


const ORDER: Array<keyof CollectingGeoPath> = [
  'country',
  'region',
  'district',
  'county',
  'subcounty',
  'parish',
  'village',
];

const LEVEL_OF_KEY: Record<keyof CollectingGeoPath, string> = {
  country: 'Country',
  region: 'Region',
  district: 'District',
  county: 'County',
  subcounty: 'Sub-county',
  parish: 'Parish',
  village: 'Village / Cell',
};

function fmtDate(v: string | null) {
  if (!v) return '—';
  return new Date(v).toLocaleDateString('en-GB', {
    timeZone: 'Africa/Kampala',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

const PROJECTION_EXPLANATION =
  'Projected collection is calculated as the recorded daily expected amount multiplied by the number of days in the selected horizon. It is a straight projection — it does not stop at the outstanding balance or assume any missed day.';

function ProjectionValue({
  daily,
  days,
  label,
}: {
  daily: number;
  days: number;
  label?: string;
}) {
  const amount = Math.round(daily * days);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="cursor-help">{formatUGX(amount)}</span>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-xs">
        <p className="text-xs font-medium">{label ? `${label} projection` : 'Projected collection'}</p>
        <p className="text-xs text-muted-foreground">
          {formatUGX(daily)} a day × {days.toLocaleString()} days = {formatUGX(amount)}
        </p>
      </TooltipContent>
    </Tooltip>
  );
}

function ProjectionLabel({ label, sublabel }: { label: string; sublabel?: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="block cursor-help">
          <span className="text-[11px] font-medium uppercase tracking-wide text-primary">{label}</span>
          {sublabel && <span className="block text-xs text-muted-foreground">{sublabel}</span>}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-xs">
        <p className="text-xs">{PROJECTION_EXPLANATION}</p>
      </TooltipContent>
    </Tooltip>
  );
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="truncate text-sm font-medium">{value ?? '—'}</p>
    </div>
  );
}

function PhoneLine({ label, name, phone }: { label: string; name?: string | null; phone?: string | null }) {
  return (
    <div className="flex items-start justify-between gap-3 rounded-md border border-border/60 bg-muted/20 px-3 py-2">
      <div className="min-w-0">
        <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
        <p className="truncate text-sm font-medium">{name || '—'}</p>
      </div>
      {phone ? (
        <a
          href={`tel:${phone}`}
          className="inline-flex shrink-0 items-center gap-1 text-sm text-primary hover:underline"
        >
          <Phone className="h-3.5 w-3.5" />
          {phone}
        </a>
      ) : (
        <span className="shrink-0 text-sm text-muted-foreground">No phone</span>
      )}
    </div>
  );
}

/**
 * Read-only holistic geographic drilldown for landlord float being collected:
 * Country → Region → District → County → Sub-county → Parish → Village/Cell → House,
 * ending at the house itself with its photo, GPS, landlord, tenant and agent contacts.
 *
 * Every figure comes from `landlord_ops_collecting_geo_page`. Nothing is written and
 * recorded location text is never rewritten — unmatched spellings show as "Unmapped".
 */
export default function CollectingGeographyDrilldown({
  horizonKey: controlledHorizonKey,
  onHorizonChange,
}: {
  /** When provided, the projection horizon is controlled by the parent (e.g. the Being collected tile). */
  horizonKey?: string;
  onHorizonChange?: (key: string) => void;
} = {}) {
  const [path, setPath] = useState<CollectingGeoPath>({});
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [openHouse, setOpenHouse] = useState<CollectingGeoHouseRow | null>(null);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [debounced, setDebounced] = useState('');
  const [localHorizonKey, setLocalHorizonKey] = useState<string>(DEFAULT_HORIZON);
  const horizonKey = controlledHorizonKey ?? localHorizonKey;
  const setHorizonKey = (key: string) => {
    setLocalHorizonKey(key);
    onHorizonChange?.(key);
  };

  const horizon = HORIZONS.find((h) => h.key === horizonKey) ?? HORIZONS[4];



  useEffect(() => {
    const t = setTimeout(() => setDebounced(search), 250);
    return () => clearTimeout(t);
  }, [search]);

  const period = { from: from || null, to: to || null };
  const dated = !!(from || to);

  const level = nextCollectingLevel(path);
  const { data, isLoading, isFetching, error } = useCollectingGeoPage(path, {
    search,
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE,
    period,
  });

  const { data: suggestions = [], isFetching: suggesting } = useCollectingGeoSuggestions(
    debounced,
    period,
  );

  const applySuggestion = (s: CollectingGeoSuggestion) => {
    const next: CollectingGeoPath = {};
    ORDER.forEach((k) => {
      const v = s[k];
      if (v) next[k] = v;
    });
    setPath(next);
    setSearch(s.kind === 'house' ? s.label : '');
    setSuggestOpen(false);
    setPage(0);
  };

  const totals = data?.totals;
  const totalRows = data?.total_rows ?? 0;
  const pages = Math.max(1, Math.ceil(totalRows / PAGE_SIZE));

  const trail = useMemo(
    () => ORDER.filter((k) => path[k]).map((k) => ({ key: k, value: path[k] as string })),
    [path],
  );

  const setLevelValue = (key: keyof CollectingGeoPath, value: string) => {
    setPath((prev) => ({ ...prev, [key]: value }));
    setSearch('');
    setPage(0);
  };

  const truncateTo = (key: keyof CollectingGeoPath | null) => {
    if (!key) {
      setPath({});
    } else {
      const stop = ORDER.indexOf(key);
      const next: CollectingGeoPath = {};
      ORDER.forEach((k, i) => {
        if (i <= stop && path[k]) next[k] = path[k];
      });
      setPath(next);
    }
    setSearch('');
    setPage(0);
  };

  const groupRows = level !== 'houses' ? ((data?.rows ?? []) as CollectingGeoGroupRow[]) : [];
  const houseRows = level === 'houses' ? ((data?.rows ?? []) as CollectingGeoHouseRow[]) : [];

  return (
    <TooltipProvider delayDuration={150}>
    <div className="space-y-3 rounded-xl border border-border bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            <MapPin className="h-4 w-4 text-primary" />
            Where the money is being collected from
          </h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Drill from country down to the exact house — {COLLECTING_GEO_LEVEL_LABELS[level]} shown now.
            Places we cannot match to an approved location appear as “Unmapped” with the recorded spelling kept.
          </p>
        </div>
        {isFetching && !isLoading && (
          <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Updating
          </span>
        )}
      </div>

      {/* Breadcrumbs */}
      <div className="flex flex-wrap items-center gap-1 text-xs">
        <button
          type="button"
          onClick={() => truncateTo(null)}
          className="rounded px-2 py-1 font-medium hover:bg-muted"
        >
          Everywhere
        </button>
        {trail.map((t) => (
          <span key={t.key} className="flex items-center gap-1">
            <ChevronRight className="h-3 w-3 text-muted-foreground" />
            <button
              type="button"
              onClick={() => truncateTo(t.key)}
              className="rounded px-2 py-1 hover:bg-muted"
              title={LEVEL_OF_KEY[t.key]}
            >
              {t.value}
            </button>
          </span>
        ))}
        {trail.length > 0 && (
          <Button variant="ghost" size="sm" className="h-7 gap-1 px-2 text-xs" onClick={() => truncateTo(null)}>
            <FilterX className="h-3.5 w-3.5" /> Reset
          </Button>
        )}
      </div>

      {/* Prominent header: total projected collections for the selected horizon */}
      <div className="relative overflow-hidden rounded-xl border border-primary/20 bg-primary/10 p-5">
        <div className="relative flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <ProjectionLabel
                label={`Total projected collections · ${horizon.label.toLowerCase()}`}
                sublabel={
                  <>
                    {formatUGX(totals?.daily_repayment ?? 0)} a day across{' '}
                    {(totals?.plans ?? 0).toLocaleString()} live rent plan{(totals?.plans ?? 0) === 1 ? '' : 's'} ×{' '}
                    {horizon.days.toLocaleString()} days
                    {trail.length > 0 ? ` · ${trail[trail.length - 1].value}` : ' · everywhere'}
                    {dated && (
                      <span className="ml-1.5 inline-flex items-center rounded bg-background/80 px-1.5 py-0.5 text-[10px] font-medium text-foreground">
                        filtered {fmtDate(from)} – {fmtDate(to)}
                      </span>
                    )}
                  </>
                }
              />
            </div>
            <p className="mt-2 text-3xl font-extrabold tabular-nums tracking-tight sm:text-4xl">
              <ProjectionValue
                daily={totals?.daily_repayment ?? 0}
                days={horizon.days}
                label={horizon.label}
              />
            </p>
            <p className="mt-1.5 max-w-xl text-xs text-muted-foreground">
              This figure updates automatically when you change the location filters, the date range, or the projection
              period. It is a straight daily amount × days projection and does not stop at the outstanding balance.
            </p>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="projection-horizon" className="text-[11px] font-semibold uppercase tracking-wide text-primary">
              Projection period
            </Label>
            <Select value={horizon.key} onValueChange={setHorizonKey}>
              <SelectTrigger id="projection-horizon" className="w-48 bg-background/80 backdrop-blur-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {HORIZONS.map((h) => (
                  <SelectItem key={h.key} value={h.key}>
                    {h.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>

      {/* Totals for the current place */}
      <div className="grid gap-2 sm:grid-cols-4">
        {[
          { label: 'Live rent plans', value: (totals?.plans ?? 0).toLocaleString() },
          { label: 'Expected total', value: formatUGX(totals?.contracted ?? 0) },
          { label: 'Collected', value: formatUGX(totals?.collected ?? 0) },
          { label: 'Outstanding', value: formatUGX(totals?.outstanding ?? 0) },
        ].map((t) => (
          <div key={t.label} className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2">
            <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{t.label}</p>
            <p className="truncate text-sm font-semibold tabular-nums">{t.value}</p>
          </div>
        ))}
      </div>

      {/* Collection period */}
      <div className="flex flex-wrap items-end gap-2 rounded-lg border border-border/60 bg-muted/10 px-3 py-2">
        <div>
          <label className="text-[11px] uppercase tracking-wide text-muted-foreground" htmlFor="cgd-from">
            Collected from
          </label>
          <Input
            id="cgd-from"
            type="date"
            value={from}
            max={to || undefined}
            onChange={(e) => {
              setFrom(e.target.value);
              setPage(0);
            }}
            className="h-9 w-[10.5rem]"
          />
        </div>
        <div>
          <label className="text-[11px] uppercase tracking-wide text-muted-foreground" htmlFor="cgd-to">
            Collected to
          </label>
          <Input
            id="cgd-to"
            type="date"
            value={to}
            min={from || undefined}
            onChange={(e) => {
              setTo(e.target.value);
              setPage(0);
            }}
            className="h-9 w-[10.5rem]"
          />
        </div>
        {dated && (
          <Button
            variant="ghost"
            size="sm"
            className="h-9 gap-1 px-2 text-xs"
            onClick={() => {
              setFrom('');
              setTo('');
              setPage(0);
            }}
          >
            <FilterX className="h-3.5 w-3.5" /> Clear period
          </Button>
        )}
        <p className="ml-auto max-w-sm text-[11px] text-muted-foreground">
          {dated
            ? 'Collected shows money received inside this period (Kampala time). Expected and outstanding stay as recorded to date.'
            : 'Leave the dates empty to see everything collected to date.'}
        </p>
      </div>

      {/* Location search with autocomplete */}
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setSuggestOpen(true);
            setPage(0);
          }}
          onFocus={() => setSuggestOpen(true)}
          onBlur={() => setTimeout(() => setSuggestOpen(false), 150)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setSuggestOpen(false);
          }}
          placeholder="Search a country, region, district, village, house, landlord, tenant or agent"
          className="pl-8"
          autoComplete="off"
          role="combobox"
          aria-expanded={suggestOpen && suggestions.length > 0}
        />
        {suggestOpen && search.trim().length >= 2 && (
          <div className="absolute left-0 right-0 top-[calc(100%+4px)] z-30 max-h-72 overflow-y-auto rounded-lg border border-border bg-popover p-1 shadow-lg">
            {suggesting && suggestions.length === 0 && (
              <p className="flex items-center gap-2 px-2 py-2 text-xs text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Looking…
              </p>
            )}
            {!suggesting && suggestions.length === 0 && (
              <p className="px-2 py-2 text-xs text-muted-foreground">No matching place, house or person.</p>
            )}
            {suggestions.map((s, i) => (
              <button
                key={`${s.kind}-${s.level}-${s.label}-${i}`}
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => applySuggestion(s)}
                className="flex w-full items-center justify-between gap-3 rounded-md px-2 py-2 text-left hover:bg-muted"
              >
                <span className="min-w-0">
                  <span className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium">{s.label}</span>
                    <Badge variant="outline" className="shrink-0 text-[10px]">
                      {s.kind === 'house' ? 'House' : COLLECTING_GEO_LEVEL_LABELS[s.level]}
                    </Badge>
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {s.detail ||
                      ORDER.map((k) => s[k])
                        .filter((v) => v && v !== 'Unmapped')
                        .join(' · ') ||
                      'Location not recorded'}
                  </span>
                </span>
                <span className="shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                  {s.plans.toLocaleString()} plan{s.plans === 1 ? '' : 's'}
                  <span className="block">{formatUGX(s.outstanding)}</span>
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
          <span className="min-w-0">{(error as { message?: string })?.message || 'Could not load this location.'}</span>
        </div>
      )}

      {isLoading ? (
        <div className="space-y-2">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : level !== 'houses' ? (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted/40">
              <tr>
                <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">
                  {COLLECTING_GEO_LEVEL_LABELS[level]}
                </th>
                <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground">Plans</th>
                <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground">Expected</th>
                <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground">Collected</th>
                <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground">Outstanding</th>
                <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground">Daily</th>
                <th className="px-3 py-2 text-right text-xs font-medium text-primary">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="cursor-help">{horizon.label}</span>
                    </TooltipTrigger>
                    <TooltipContent side="top" className="max-w-xs">
                      <p className="text-xs">{PROJECTION_EXPLANATION}</p>
                    </TooltipContent>
                  </Tooltip>
                </th>
                <th className="w-8" />
              </tr>
            </thead>
            <tbody>
              {groupRows.length === 0 && (
                <tr>
                  <td className="px-3 py-3 text-muted-foreground" colSpan={8}>
                    Nothing is being collected here.
                  </td>
                </tr>
              )}
              {groupRows.map((r) => (
                <tr
                  key={r.label}
                  role="button"
                  tabIndex={0}
                  onClick={() => {
                    const key = collectingPathKeyFor(level);
                    if (key) setLevelValue(key, r.label);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      const key = collectingPathKeyFor(level);
                      if (key) setLevelValue(key, r.label);
                    }
                  }}
                  className="cursor-pointer border-t border-border/50 hover:bg-muted/40"
                >
                  <td className="px-3 py-2">
                    <span className="flex items-center gap-2">
                      <span className="font-medium">{r.label}</span>
                      {r.unmatched && (
                        <Badge
                          variant="outline"
                          className="border-amber-500/40 bg-amber-500/10 text-[10px] text-amber-700"
                        >
                          Unmapped
                        </Badge>
                      )}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {r.plans.toLocaleString()} rent plan{r.plans === 1 ? '' : 's'}
                      {r.houses > 0 ? ` · ${r.houses.toLocaleString()} listed house${r.houses === 1 ? '' : 's'}` : ''}

                    </span>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{r.plans.toLocaleString()}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatUGX(r.contracted)}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-emerald-600 dark:text-emerald-400">
                    {formatUGX(r.collected)}
                  </td>
                  <td className="px-3 py-2 text-right font-medium tabular-nums">{formatUGX(r.outstanding)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatUGX(r.daily_repayment)}</td>
                  <td className="px-3 py-2 text-right font-semibold tabular-nums text-primary">
                    <ProjectionValue daily={r.daily_repayment} days={horizon.days} label={r.label} />
                  </td>
                  <td className="px-2 py-2 text-muted-foreground">
                    <ChevronRight className="h-4 w-4" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {houseRows.length === 0 && (
            <p className="text-sm text-muted-foreground">No houses are being collected from here.</p>
          )}
          {houseRows.map((h) => (
            <button
              key={h.rent_request_id}
              type="button"
              onClick={() => setOpenHouse(h)}
              className="overflow-hidden rounded-lg border border-border bg-background text-left transition hover:border-primary/40 hover:shadow-sm"
            >
              <div className="relative h-32 w-full bg-muted">
                {h.house_image_url ? (
                  <img
                    src={h.house_image_url}
                    alt={h.house_title || `House rented by ${h.tenant_name}`}
                    loading="lazy"
                    className="h-32 w-full object-cover"
                  />
                ) : (
                  <span className="flex h-32 w-full items-center justify-center gap-2 text-xs text-muted-foreground">
                    <ImageOff className="h-4 w-4" /> No house photo
                  </span>
                )}
                {h.latitude != null && h.longitude != null && (
                  <Badge className="absolute right-2 top-2 gap-1 bg-background/90 text-[10px] text-foreground">
                    <Navigation className="h-3 w-3" /> GPS
                  </Badge>
                )}
              </div>
              <div className="space-y-2 p-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold">
                    {h.house_title || h.house_address || 'House on this plan'}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {[h.village, h.parish, h.subcounty, h.district].filter((v) => v && v !== 'Unmapped').join(', ') ||
                      'Location not recorded'}
                  </p>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <Field label="Tenant" value={h.tenant_name} />
                  <Field label="Agent" value={h.agent_name || 'No agent'} />
                  <Field label="Landlord" value={h.landlord_name} />
                  <Field label="Outstanding" value={formatUGX(h.outstanding)} />
                </div>
                <div className="rounded-md border border-primary/25 bg-primary/5 px-2.5 py-2">
                  <ProjectionLabel
                    label={horizon.label}
                    sublabel={`${formatUGX(h.daily_repayment)} a day × ${horizon.days.toLocaleString()} days`}
                  />
                  <p className="text-sm font-semibold tabular-nums">
                    <ProjectionValue
                      daily={h.daily_repayment}
                      days={horizon.days}
                      label={h.house_title || 'This house'}
                    />
                  </p>
                </div>
              </div>
            </button>
          ))}
        </div>
      )}

      {/* Pagination */}
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>
          {totalRows.toLocaleString()}{' '}
          {level === 'houses'
            ? totalRows === 1
              ? 'house'
              : 'houses'
            : totalRows === 1
              ? COLLECTING_GEO_LEVEL_LABELS[level].toLowerCase()
              : `${COLLECTING_GEO_LEVEL_LABELS[level].toLowerCase()} places`}{' '}
          · page {page + 1} of {pages}
        </span>

        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="sm"
            className="h-7 gap-1 px-2"
            disabled={page === 0}
            onClick={() => setPage((p) => Math.max(0, p - 1))}
          >
            <ChevronLeft className="h-3.5 w-3.5" /> Back
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-7 gap-1 px-2"
            disabled={page + 1 >= pages}
            onClick={() => setPage((p) => p + 1)}
          >
            Next <ChevronRight className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {/* House detail */}
      <Dialog open={!!openHouse} onOpenChange={(o) => !o && setOpenHouse(null)}>
        <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base">
              <Home className="h-4 w-4 text-primary" />
              {openHouse?.house_title || openHouse?.house_address || 'House being collected from'}
            </DialogTitle>
            <DialogDescription>
              {[
                openHouse?.village,
                openHouse?.parish,
                openHouse?.subcounty,
                openHouse?.county,
                openHouse?.district,
                openHouse?.region,
                openHouse?.country,
              ]
                .filter((v) => v && v !== 'Unmapped')
                .join(' · ') || 'Location not recorded'}
            </DialogDescription>
          </DialogHeader>

          {openHouse && (
            <div className="space-y-4">
              {openHouse.house_image_url ? (
                <img
                  src={openHouse.house_image_url}
                  alt={openHouse.house_title || `House rented by ${openHouse.tenant_name}`}
                  className="max-h-64 w-full rounded-lg object-cover"
                />
              ) : (
                <div className="flex h-32 items-center justify-center gap-2 rounded-lg border border-dashed border-border text-sm text-muted-foreground">
                  <ImageOff className="h-4 w-4" /> No house photo recorded
                </div>
              )}

              {openHouse.latitude != null && openHouse.longitude != null ? (
                <LocationMapPreview lat={Number(openHouse.latitude)} lng={Number(openHouse.longitude)} />
              ) : (
                <p className="text-xs text-muted-foreground">No GPS point recorded for this house.</p>
              )}

              <div className="grid gap-2 sm:grid-cols-2">
                <Field label="Address" value={openHouse.house_address || '—'} />
                <Field label="Plan status" value={openHouse.status} />
                <Field label="Rent paid to landlord" value={formatUGX(openHouse.rent_amount)} />
                <Field label="Funded" value={fmtDate(openHouse.funded_at)} />
                <Field label="Expected total" value={formatUGX(openHouse.contracted)} />
                <Field label="Collected" value={formatUGX(openHouse.collected)} />
                <Field label="Outstanding" value={formatUGX(openHouse.outstanding)} />
                <Field label="Daily amount" value={formatUGX(openHouse.daily_repayment)} />
              </div>

              <div className="rounded-lg border border-primary/25 bg-primary/5 p-3">
                <ProjectionLabel label="Projected collection from this house" />
                <div className="mt-2 grid gap-2 sm:grid-cols-3">
                  {HORIZONS.map((h) => (
                    <div key={h.key} className="min-w-0">
                      <p className="text-[11px] text-muted-foreground">{h.label}</p>
                      <p className="truncate text-sm font-semibold tabular-nums">
                        <ProjectionValue
                          daily={openHouse.daily_repayment}
                          days={h.days}
                          label={h.label}
                        />
                      </p>
                    </div>
                  ))}
                </div>
                <p className="mt-2 text-[11px] text-muted-foreground">
                  Daily amount × days in each period. A straight projection — it does not stop at the
                  outstanding balance or assume any missed day.
                </p>
              </div>

              <div className="space-y-2">
                <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  <User className="h-3.5 w-3.5" /> People on this house
                </p>
                <PhoneLine label="Tenant" name={openHouse.tenant_name} phone={openHouse.tenant_phone} />
                <PhoneLine label="Agent" name={openHouse.agent_name} phone={openHouse.agent_phone} />
                <PhoneLine label="Landlord" name={openHouse.landlord_name} phone={openHouse.landlord_phone} />
                {(openHouse.mobile_money_name || openHouse.mobile_money_number) && (
                  <PhoneLine
                    label="Landlord mobile money"
                    name={openHouse.mobile_money_name}
                    phone={openHouse.mobile_money_number}
                  />
                )}
                {(openHouse.caretaker_name || openHouse.caretaker_phone) && (
                  <PhoneLine
                    label="Caretaker"
                    name={openHouse.caretaker_name}
                    phone={openHouse.caretaker_phone}
                  />
                )}
                {(openHouse.lc1_chairperson_name || openHouse.lc1_chairperson_phone) && (
                  <PhoneLine
                    label="LC1 chairperson"
                    name={openHouse.lc1_chairperson_name}
                    phone={openHouse.lc1_chairperson_phone}
                  />
                )}
              </div>

              {!openHouse.geo_official && (
                <p className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-700">
                  This location was matched from recorded text only, so parts of it show as “Unmapped”. The recorded
                  spelling is kept exactly as captured.
                </p>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
    </TooltipProvider>
  );
}
