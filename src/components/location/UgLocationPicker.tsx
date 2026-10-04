/**
 * Shared Uganda location picker — used by the house listing form and the
 * post rent request form (and any future form needing an address).
 *
 * Type a village name → single debounced RPC returns matches with the full
 * district/county/sub-county/parish chain, so one tap fills everything.
 *
 * All data comes from the cached hooks in useUgLocations, so reopening the
 * dialog fires no extra requests.
 */
import { useEffect, useState } from 'react';
import { Search, MapPin, X, Check, Loader2, ListTree, AlertTriangle } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  useUgVillageSearch,
  useUgDistricts,
  useUgCounties,
  useUgSubcounties,
  useUgParishes,
  useUgVillages,
  buildUgSelection,
  UG_REGIONS,
  type UgLocationSelection,
  type UgOption,
} from '@/hooks/useUgLocations';

interface Props {
  value: UgLocationSelection | null;
  onChange: (sel: UgLocationSelection | null) => void;
  label?: string;
  required?: boolean;
  error?: string | null;
  className?: string;
  /** When set, village search is limited to villages inside this district. */
  districtName?: string | null;
  /**
   * Urban wording: parish/village are labelled "Ward"/"Cell" (KCCA / municipal
   * areas). Data and returned object are unchanged.
   */
  urban?: boolean;
  /** Which mode opens first. Users can still toggle. Default: 'search'. */
  defaultMode?: 'search' | 'cascade';
  /** Hide the search/browse toggle and lock to defaultMode. */
  lockMode?: boolean;
}

export function UgLocationPicker({
  value, onChange, label = 'Official location', required, error, className, districtName,
  urban = false, defaultMode = 'search', lockMode = false,
}: Props) {
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<'search' | 'cascade'>(defaultMode);
  // no focus gating — results stay visible while typing so they can't be hidden

  const PARISH_LABEL = urban ? 'Ward' : 'Parish';
  const VILLAGE_LABEL = urban ? 'Cell' : 'Village';

  const scopeDistrictName = (districtName ?? '').trim();
  const search = useUgVillageSearch(query, 20, {
    districtName: scopeDistrictName || null,
  });

  return (
    <div className={`space-y-2 ${className ?? ''}`}>
      <div className="flex items-center justify-between gap-2">
        <Label className="text-sm font-semibold flex items-center gap-1">
          <MapPin className="h-4 w-4 text-primary" /> {label}
          {required && <span className="text-destructive">*</span>}
        </Label>
        {!value && !lockMode && (
          <button
            type="button"
            onClick={() => setMode((m) => (m === 'search' ? 'cascade' : 'search'))}
            className="flex items-center gap-1 text-[11px] font-medium text-primary hover:underline"
          >
            {mode === 'search' ? (<><ListTree className="h-3.5 w-3.5" /> Browse by region</>) : (<><Search className="h-3.5 w-3.5" /> Search by {VILLAGE_LABEL.toLowerCase()}</>)}
          </button>
        )}
      </div>

      {value ? (
        <div className="flex items-start gap-2 rounded-lg border border-success/40 bg-success/5 p-2.5">
          <Check className="mt-0.5 h-4 w-4 shrink-0 text-success" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold leading-snug">{value.village}</p>
            <p className="text-[11px] text-muted-foreground leading-snug">{value.fullPath}</p>
            {value.region && (
              <p className="text-[11px] text-muted-foreground leading-snug">{value.region} Region</p>
            )}
          </div>
          <button
            type="button"
            onClick={() => { onChange(null); setQuery(''); }}
            className="text-muted-foreground hover:text-foreground"
            aria-label="Clear location"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      ) : mode === 'cascade' ? (
        <UgCascade
          onSelect={onChange}
          urban={urban}
          lockedDistrictName={scopeDistrictName || null}
        />
      ) : (
        <>
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              
              
              placeholder={`Type the ${VILLAGE_LABEL.toLowerCase()} name e.g. Kansanga, Bwaise…`}
              className={`h-11 pl-8 pr-8 text-base ${error ? 'border-destructive border-2' : ''}`}
            />
            {search.isFetching && (
              <Loader2 className="absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-muted-foreground" />
            )}
          </div>

          {query.trim().length >= 2 && (
            <div className="mt-1 max-h-56 w-full overflow-y-auto overscroll-contain rounded-lg border border-border bg-popover shadow-sm [-webkit-overflow-scrolling:touch]">
              {search.isFetching && (search.data ?? []).length === 0 ? (
                <p className="px-3 py-3 text-xs text-muted-foreground">Searching {VILLAGE_LABEL.toLowerCase()}s…</p>
              ) : (search.data ?? []).length === 0 ? (
                  <p className="px-3 py-3 text-xs text-muted-foreground">
                    {scopeDistrictName
                      ? `No ${VILLAGE_LABEL.toLowerCase()} matched in ${scopeDistrictName} district. Try a different spelling or browse by region.`
                      : `No ${VILLAGE_LABEL.toLowerCase()} matched. Try a different spelling or browse by region.`}
                  </p>
                ) : (
                  (search.data ?? []).map((hit) => (
                    <button
                      key={hit.villageId}
                      type="button"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => { onChange(hit); setQuery(""); }}
                      className="flex w-full items-start gap-2 px-3 py-2.5 text-left hover:bg-muted/60"
                    >
                      <MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
                      <span className="min-w-0">
                        <span className="block text-sm font-medium">{hit.village}</span>
                        <span className="block text-[11px] text-muted-foreground">{hit.fullPath}</span>
                        {hit.region && (
                          <span className="block text-[10px] text-muted-foreground">{hit.region} Region</span>
                        )}
                      </span>
                    </button>
                  ))
                )}
            </div>
          )}
          {search.isError && (
            <p className="text-[11px] text-destructive">
              Could not search locations: {(search.error as Error).message}
            </p>
          )}
          {scopeDistrictName && (
            <p className="text-[11px] text-muted-foreground">
              Searching {VILLAGE_LABEL.toLowerCase()}s in <span className="font-medium text-foreground">{scopeDistrictName}</span> district only.
            </p>
          )}
        </>
      )}

      {error && <p className="text-[11px] text-destructive">{error}</p>}
    </div>
  );
}

export default UgLocationPicker;

/* ------------------------------------------------------------------ *
 * Strict cascading mode: Region → District → County → Sub-county →
 * Parish/Ward → Village/Cell. Driven entirely by the cached level hooks.
 * ------------------------------------------------------------------ */

function LevelSelect({
  label, placeholder, options, value, onPick, disabled, loading, isError, errorMessage, emptyMessage,
}: {
  label: string;
  placeholder: string;
  options: UgOption[];
  value: UgOption | null;
  onPick: (o: UgOption | null) => void;
  disabled?: boolean;
  loading?: boolean;
  isError?: boolean;
  errorMessage?: string;
  emptyMessage: string;
}) {
  return (
    <div className="space-y-1">
      <Label className="text-[11px] font-medium text-muted-foreground">{label}</Label>
      <Select
        value={value ? String(value.id) : ''}
        disabled={disabled || loading || isError}
        onValueChange={(v) => onPick(options.find((o) => String(o.id) === v) ?? null)}
      >
        <SelectTrigger className="h-10">
          <SelectValue placeholder={loading ? 'Loading…' : placeholder} />
        </SelectTrigger>
        <SelectContent className="max-h-64">
          {options.length === 0 && !loading ? (
            <div className="px-3 py-2 text-xs text-muted-foreground">{emptyMessage}</div>
          ) : (
            options.map((o) => (
              <SelectItem key={o.id} value={String(o.id)}>{o.name}</SelectItem>
            ))
          )}
        </SelectContent>
      </Select>
      {isError && (
        <p className="flex items-center gap-1 text-[11px] text-destructive">
          <AlertTriangle className="h-3 w-3" /> {errorMessage || 'Could not load this list.'}
        </p>
      )}
      {!isError && !loading && !disabled && options.length === 0 && (
        <p className="text-[11px] text-muted-foreground">{emptyMessage}</p>
      )}
    </div>
  );
}

function UgCascade({
  onSelect, urban, lockedDistrictName,
}: {
  onSelect: (sel: UgLocationSelection) => void;
  urban: boolean;
  lockedDistrictName: string | null;
}) {
  const [region, setRegion] = useState<string | null>(null);
  const [district, setDistrict] = useState<UgOption | null>(null);
  const [county, setCounty] = useState<UgOption | null>(null);
  const [subcounty, setSubcounty] = useState<UgOption | null>(null);
  const [parish, setParish] = useState<UgOption | null>(null);

  const districts = useUgDistricts(region);
  const counties = useUgCounties(district?.id ?? null);
  const subcounties = useUgSubcounties(county?.id ?? null);
  const parishes = useUgParishes(subcounty?.id ?? null);
  const villages = useUgVillages(parish?.id ?? null);

  const PARISH_LABEL = urban ? 'Ward' : 'Parish';
  const VILLAGE_LABEL = urban ? 'Cell' : 'Village';

  const districtOptions = (districts.data ?? []).filter((d) =>
    !lockedDistrictName || d.name.toLowerCase() === lockedDistrictName.toLowerCase());

  // When the form scopes to one district, auto-pick it (and its region).
  useEffect(() => {
    if (!lockedDistrictName || district) return;
    const hit = (districts.data ?? []).find((d) => d.name.toLowerCase() === lockedDistrictName.toLowerCase());
    if (hit) { setRegion(hit.region ?? null); setDistrict({ id: hit.id, name: hit.name }); }
  }, [lockedDistrictName, districts.data, district]);

  return (
    <div className="space-y-2.5 rounded-lg border border-border bg-muted/20 p-2.5">
      <div className="space-y-1">
        <Label className="text-[11px] font-medium text-muted-foreground">Region</Label>
        <Select
          value={region ?? ''}
          onValueChange={(v) => {
            setRegion(v);
            setDistrict(null); setCounty(null); setSubcounty(null); setParish(null);
          }}
        >
          <SelectTrigger className="h-10"><SelectValue placeholder="Select region" /></SelectTrigger>
          <SelectContent>
            {UG_REGIONS.map((r) => <SelectItem key={r} value={r}>{r}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      <LevelSelect
        label="District"
        placeholder={region ? 'Select district' : 'Select a region first'}
        options={districtOptions.map((d) => ({ id: d.id, name: d.name }))}
        value={district}
        disabled={!region}
        loading={districts.isLoading}
        isError={districts.isError}
        errorMessage={(districts.error as Error | null)?.message}
        emptyMessage="No districts found for this region."
        onPick={(o) => { setDistrict(o); setCounty(null); setSubcounty(null); setParish(null); }}
      />

      <LevelSelect
        label="County / Municipality"
        placeholder={district ? 'Select county' : 'Select a district first'}
        options={counties.data ?? []}
        value={county}
        disabled={!district}
        loading={counties.isFetching && !counties.data}
        isError={counties.isError}
        errorMessage={(counties.error as Error | null)?.message}
        emptyMessage="No counties recorded under this district."
        onPick={(o) => { setCounty(o); setSubcounty(null); setParish(null); }}
      />

      <LevelSelect
        label="Sub-county / Division"
        placeholder={county ? 'Select sub-county' : 'Select a county first'}
        options={subcounties.data ?? []}
        value={subcounty}
        disabled={!county}
        loading={subcounties.isFetching && !subcounties.data}
        isError={subcounties.isError}
        errorMessage={(subcounties.error as Error | null)?.message}
        emptyMessage="No sub-counties recorded under this county."
        onPick={(o) => { setSubcounty(o); setParish(null); }}
      />

      <LevelSelect
        label={PARISH_LABEL}
        placeholder={subcounty ? `Select ${PARISH_LABEL.toLowerCase()}` : 'Select a sub-county first'}
        options={parishes.data ?? []}
        value={parish}
        disabled={!subcounty}
        loading={parishes.isFetching && !parishes.data}
        isError={parishes.isError}
        errorMessage={(parishes.error as Error | null)?.message}
        emptyMessage={`No ${PARISH_LABEL.toLowerCase()}s recorded under this sub-county.`}
        onPick={(o) => setParish(o)}
      />

      <LevelSelect
        label={VILLAGE_LABEL}
        placeholder={parish ? `Select ${VILLAGE_LABEL.toLowerCase()}` : `Select a ${PARISH_LABEL.toLowerCase()} first`}
        options={villages.data ?? []}
        value={null}
        disabled={!parish}
        loading={villages.isFetching && !villages.data}
        isError={villages.isError}
        errorMessage={(villages.error as Error | null)?.message}
        emptyMessage={`No ${VILLAGE_LABEL.toLowerCase()}s recorded under this ${PARISH_LABEL.toLowerCase()}.`}
        onPick={(o) => {
          if (!o || !district || !county || !subcounty || !parish) return;
          onSelect(buildUgSelection({ region, district, county, subcounty, parish, village: o }));
        }}
      />
    </div>
  );
}
