import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  Eye, ImageIcon, Loader2, MapPin, MessageSquare, Navigation, Phone,
  Search, ShieldCheck, SlidersHorizontal, Users, X,
} from 'lucide-react';

import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { formatUGX } from '@/lib/rentCalculations';
import { UGANDA_DISTRICTS, CITY_TO_DISTRICT } from '@/lib/ugandaDistricts';
import { EmptyHouseDetailSheet, housePlace, type HouseOpportunity } from '@/components/agent/EmptyHouseDetailSheet';
import { HouseShareActions } from '@/components/agent/HouseShareActions';

const PAGE_SIZE = 20;

/** Listings carry free-typed district text; resolve each back to an official district. */
const officialDistrict = (raw: string | null | undefined): string | null => {
  const cleaned = (raw ?? '').trim();
  if (!cleaned) return null;
  const key = cleaned.toLowerCase();
  if (CITY_TO_DISTRICT[key]) return CITY_TO_DISTRICT[key];
  const exact = UGANDA_DISTRICTS.find((d) => d.toLowerCase() === key);
  if (exact) return exact;
  const cityPrefix = Object.keys(CITY_TO_DISTRICT).find((c) => key.startsWith(c));
  if (cityPrefix) return CITY_TO_DISTRICT[cityPrefix];
  const prefixed = UGANDA_DISTRICTS
    .filter((d) => key.startsWith(d.toLowerCase()))
    .sort((a, b) => b.length - a.length)[0];
  return prefixed ?? null;
};

const placeOf = (h: HouseOpportunity) =>
  [h.village, h.sub_county, h.district].filter(Boolean).join(', ') || h.region || 'Location on file';

const hasGps = (h: HouseOpportunity) =>
  typeof h.latitude === 'number' && typeof h.longitude === 'number' && (h.latitude !== 0 || h.longitude !== 0);

const mapsUrl = (h: HouseOpportunity) => `https://www.google.com/maps/search/?api=1&query=${h.latitude},${h.longitude}`;

type HouseProgress = {
  house_id: string;
  is_funded: boolean;
  tenant_activated: boolean;
  monthly_paid_this_month: boolean;
};

/** Live progress badges: funded → tenant activated → paid this month. */
function HouseProgressBadges({ progress }: { progress?: HouseProgress }) {
  const items = [
    { active: Boolean(progress?.is_funded), on: 'Funded', off: 'Awaiting funding' },
    { active: Boolean(progress?.tenant_activated), on: 'Tenant activated', off: 'Tenant pending' },
    { active: Boolean(progress?.monthly_paid_this_month), on: 'Paid this month', off: 'Monthly payment pending' },
  ];
  return (
    <div className="flex flex-wrap gap-1.5">
      {items.map(({ active, on, off }) => (
        <Badge
          key={on}
          variant="outline"
          className={`h-5 text-[10px] ${
            active
              ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600'
              : 'border-muted-foreground/20 bg-muted text-muted-foreground'
          }`}
        >
          {active ? on : off}
        </Badge>
      ))}
    </div>
  );
}

/**
 * The full empty-house browsing experience (search, filters, landlord contact,
 * GPS, progress badges, details) embedded inline in the agent / proxy agent
 * "Share these to bring in support" section. Cards carry share actions instead
 * of a selection cart — every share creates the opaque /s/<code> support link
 * that keeps this agent credited server-side.
 *
 * GPS-only is forced: a shared house without coordinates has no "Visit House"
 * on the public support page, so it must not appear here.
 */
export function EmptyHouseShareBrowser({ onTotalChange }: { onTotalChange?: (total: number) => void }) {
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [page, setPage] = useState(0);
  const [district, setDistrict] = useState('all');
  const [verifiedOnly, setVerifiedOnly] = useState(false);
  const [minRent, setMinRent] = useState('');
  const [maxRent, setMaxRent] = useState('');
  const [nearMe, setNearMe] = useState<{ lat: number; lng: number; radiusKm: number } | null>(null);
  const [sort, setSort] = useState<'recommended' | 'nearest' | 'newest' | 'rent_high' | 'rent_low'>('recommended');
  const [locating, setLocating] = useState(false);
  const [detailHouse, setDetailHouse] = useState<HouseOpportunity | null>(null);

  useEffect(() => {
    const t = setTimeout(() => { setDebounced(search); setPage(0); }, 350);
    return () => clearTimeout(t);
  }, [search]);

  const { data, isLoading, isFetching } = useQuery({
    queryKey: ['empty-house-share-browser', debounced, page, district, verifiedOnly, minRent, maxRent, nearMe, sort],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('agent_list_empty_house_opportunities', {
        p_search: debounced || null,
        p_limit: PAGE_SIZE,
        p_offset: page * PAGE_SIZE,
        p_district: district === 'all' ? null : `${district}%`,
        p_verified_only: verifiedOnly,
        // Always true in the share context — a house without coordinates cannot
        // offer "Visit House" on the public support page.
        p_gps_only: true,
        p_min_rent: minRent ? Number(minRent) : null,
        p_max_rent: maxRent ? Number(maxRent) : null,
        p_near_lat: nearMe?.lat ?? null,
        p_near_lng: nearMe?.lng ?? null,
        p_radius_km: nearMe?.radiusKm ?? null,
        p_sort: sort,
      });
      if (error) throw error;
      const payload = (data ?? {}) as { total?: number; houses?: HouseOpportunity[]; districts?: string[] };
      return {
        total: Number(payload.total || 0),
        houses: payload.houses ?? [],
        districts: payload.districts ?? [],
      };
    },
  });

  const total = data?.total ?? 0;
  useEffect(() => { onTotalChange?.(total); }, [total, onTotalChange]);

  const districtOptions = useMemo(() => {
    const set = new Set<string>();
    for (const raw of data?.districts ?? []) {
      const official = officialDistrict(raw);
      if (official) set.add(official);
    }
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [data?.districts]);

  const activeFilterCount =
    (district !== 'all' ? 1 : 0) + (verifiedOnly ? 1 : 0) +
    (minRent ? 1 : 0) + (maxRent ? 1 : 0) + (nearMe ? 1 : 0);

  const clearFilters = () => {
    setDistrict('all'); setVerifiedOnly(false);
    setMinRent(''); setMaxRent(''); setNearMe(null); setPage(0);
  };

  const filterChips: { key: string; label: string; onRemove: () => void }[] = [
    ...(search.trim() ? [{ key: 'search', label: `Search: "${search.trim()}"`, onRemove: () => { setSearch(''); setPage(0); } }] : []),
    ...(district !== 'all' ? [{ key: 'district', label: `District: ${district}`, onRemove: () => { setDistrict('all'); setPage(0); } }] : []),
    ...(verifiedOnly ? [{ key: 'verified', label: 'Verified only', onRemove: () => { setVerifiedOnly(false); setPage(0); } }] : []),
    ...(minRent ? [{ key: 'minRent', label: `Min rent: ${minRent}`, onRemove: () => { setMinRent(''); setPage(0); } }] : []),
    ...(maxRent ? [{ key: 'maxRent', label: `Max rent: ${maxRent}`, onRemove: () => { setMaxRent(''); setPage(0); } }] : []),
    ...(nearMe ? [{ key: 'nearMe', label: `Within ${nearMe.radiusKm} km`, onRemove: () => { setNearMe(null); setPage(0); } }] : []),
  ];

  const useMyLocation = () => {
    if (!navigator.geolocation) { toast.error('Location is not available on this device'); return; }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setNearMe({ lat: pos.coords.latitude, lng: pos.coords.longitude, radiusKm: 10 });
        setPage(0);
        setLocating(false);
      },
      () => { setLocating(false); toast.error('Could not get your location'); },
      { enableHighAccuracy: true, timeout: 10_000 },
    );
  };

  // Live funding / tenant / payout progress for houses this user already supports.
  const { data: progressRows } = useQuery({
    queryKey: ['empty-house-progress'],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('partner_supported_house_returns');
      if (error) throw error;
      const payload = (data ?? {}) as { houses?: HouseProgress[] };
      return payload.houses ?? [];
    },
    staleTime: 30_000,
  });

  const progressByHouse = useMemo(() => {
    const map: Record<string, HouseProgress> = {};
    for (const row of progressRows ?? []) if (row?.house_id) map[row.house_id] = row;
    return map;
  }, [progressRows]);

  const houses = data?.houses ?? [];
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="space-y-4">
      {/* Search + filters */}
      <div className="space-y-2">
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by landlord name or phone, village, district or house"
              className="h-10 pl-9"
            />
          </div>
          <Popover modal>
            <PopoverTrigger asChild>
              <Button
                type="button"
                variant={activeFilterCount > 0 ? 'default' : 'outline'}
                className="h-10 shrink-0 gap-1.5"
              >
                <SlidersHorizontal className="h-4 w-4" />
                Filters{activeFilterCount > 0 ? ` (${activeFilterCount})` : ''}
              </Button>
            </PopoverTrigger>
            <PopoverContent
              align="end"
              collisionPadding={12}
              className="z-[200] max-h-[70vh] w-[calc(100vw-2rem)] space-y-3 overflow-y-auto rounded-2xl border bg-popover p-3 sm:w-[420px]"
            >
              <div className="space-y-1">
                <Label className="text-[11px] text-muted-foreground">Sort by</Label>
                <Select
                  value={sort}
                  onValueChange={(v) => {
                    const next = v as typeof sort;
                    setSort(next);
                    setPage(0);
                    if (next === 'nearest' && !nearMe) useMyLocation();
                  }}
                >
                  <SelectTrigger className="h-9">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="recommended">Recommended</SelectItem>
                    <SelectItem value="nearest">Nearest to me</SelectItem>
                    <SelectItem value="newest">Newest listings</SelectItem>
                    <SelectItem value="rent_high">Highest funding need</SelectItem>
                    <SelectItem value="rent_low">Lowest funding need</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label className="text-[11px] text-muted-foreground">District</Label>
                  <Select value={district} onValueChange={(v) => { setDistrict(v); setPage(0); }}>
                    <SelectTrigger className="h-9">
                      <SelectValue placeholder="All districts" />
                    </SelectTrigger>
                    <SelectContent className="max-h-64">
                      <SelectItem value="all">All districts</SelectItem>
                      {districtOptions.map((d) => (
                        <SelectItem key={d} value={d}>{d}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label className="text-[11px] text-muted-foreground">Monthly rent (UGX)</Label>
                  <div className="flex gap-2">
                    <Input
                      inputMode="numeric"
                      value={minRent}
                      onChange={(e) => { setMinRent(e.target.value.replace(/\D/g, '')); setPage(0); }}
                      placeholder="Min"
                      className="h-9"
                    />
                    <Input
                      inputMode="numeric"
                      value={maxRent}
                      onChange={(e) => { setMaxRent(e.target.value.replace(/\D/g, '')); setPage(0); }}
                      placeholder="Max"
                      className="h-9"
                    />
                  </div>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant={verifiedOnly ? 'default' : 'outline'}
                  className="h-8 gap-1.5"
                  onClick={() => { setVerifiedOnly((v) => !v); setPage(0); }}
                >
                  <ShieldCheck className="h-3.5 w-3.5" /> Verified only
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant={nearMe ? 'default' : 'outline'}
                  className="h-8 gap-1.5"
                  disabled={locating}
                  onClick={() => (nearMe ? (setNearMe(null), setPage(0)) : useMyLocation())}
                >
                  {locating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Navigation className="h-3.5 w-3.5" />}
                  {nearMe ? `Within ${nearMe.radiusKm} km` : 'Near me'}
                </Button>
                {nearMe && (
                  <Select
                    value={String(nearMe.radiusKm)}
                    onValueChange={(v) => { setNearMe({ ...nearMe, radiusKm: Number(v) }); setPage(0); }}
                  >
                    <SelectTrigger className="h-8 w-28"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {[2, 5, 10, 25, 50].map((r) => (
                        <SelectItem key={r} value={String(r)}>{r} km</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
                {activeFilterCount > 0 && (
                  <Button type="button" size="sm" variant="ghost" className="h-8" onClick={clearFilters}>
                    Clear
                  </Button>
                )}
              </div>
            </PopoverContent>
          </Popover>
        </div>
      </div>

      {filterChips.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-muted-foreground">Active filters</span>
          {filterChips.map((chip) => (
            <button
              key={chip.key}
              type="button"
              onClick={chip.onRemove}
              aria-label={`Remove filter ${chip.label}`}
              className="inline-flex items-center gap-1 rounded-full border bg-muted/60 px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:bg-muted"
            >
              {chip.label}
              <X className="h-3 w-3 text-muted-foreground" />
            </button>
          ))}
          <button
            type="button"
            onClick={() => { setSearch(''); clearFilters(); }}
            className="ml-1 text-xs font-medium text-muted-foreground underline underline-offset-2 hover:text-foreground"
          >
            Clear all
          </button>
        </div>
      )}

      {/* Houses */}
      {isLoading ? (
        <div className="space-y-2">
          {[1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-24 rounded-2xl" />)}
        </div>
      ) : houses.length === 0 ? (
        <div className="rounded-2xl border border-dashed p-8 text-center text-sm text-muted-foreground">
          No empty houses available right now.
        </div>
      ) : (
        <div className="space-y-2">
          {houses.map((h) => {
            const photos = (h.image_urls && h.image_urls.length ? h.image_urls : h.image_url ? [h.image_url] : []).slice(0, 4);
            return (
              <div key={h.house_id} className="w-full rounded-2xl border border-border transition">
                <div className="p-3">
                  {photos.length > 0 ? (
                    <div className="mb-2.5 flex gap-1.5 overflow-x-auto">
                      {photos.map((src, i) => (
                        <img
                          key={`${h.house_id}-${i}`}
                          src={src}
                          alt={`${h.title || 'Empty house'} photo ${i + 1}`}
                          loading="lazy"
                          className="h-24 w-32 shrink-0 rounded-xl bg-muted object-cover"
                        />
                      ))}
                    </div>
                  ) : (
                    <div className="mb-2.5 flex h-24 items-center justify-center gap-2 rounded-xl bg-muted text-[11px] text-muted-foreground">
                      <ImageIcon className="h-4 w-4" /> No photo on file
                    </div>
                  )}
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-semibold">
                        {h.title || h.house_category || 'Empty house'}
                      </span>
                      {h.verified && (
                        <Badge variant="outline" className="h-5 gap-1 border-emerald-500/30 bg-emerald-500/10 text-[10px] text-emerald-600">
                          <ShieldCheck className="h-3 w-3" /> Verified
                        </Badge>
                      )}
                      {nearMe && h.distance_km != null && (
                        <Badge variant="outline" className="h-5 gap-1 text-[10px]">
                          <Navigation className="h-3 w-3" /> {h.distance_km < 1 ? `${Math.round(h.distance_km * 1000)} m` : `${h.distance_km.toFixed(1)} km`}
                        </Badge>
                      )}
                    </div>
                    <p className="flex items-center gap-1 truncate text-[11px] text-muted-foreground">
                      <MapPin className="h-3 w-3 shrink-0" /> {placeOf(h)}
                    </p>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px]">
                      <span className="text-muted-foreground">Rent</span>
                      <span className="font-semibold">{formatUGX(h.monthly_rent)}/mo</span>
                      <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 font-bold text-emerald-600">
                        Partner earns {formatUGX(h.partner_monthly_return)}/month
                      </span>
                      <span className="text-muted-foreground">
                        {formatUGX(h.partner_annual_return)} over 12 months
                      </span>
                    </div>
                    {h.listing_agent_name && (
                      <p className="flex items-center gap-1 text-[10px] text-muted-foreground">
                        <Users className="h-3 w-3" /> {h.listing_agent_name} places the tenant once funded
                      </p>
                    )}
                    <div className="pt-0.5">
                      <HouseProgressBadges progress={progressByHouse[h.house_id]} />
                    </div>
                  </div>
                </div>
                {(h.landlord_name || h.landlord_phone) && (
                  <div className="mx-3 mb-3 rounded-2xl border border-primary/15 bg-primary/5 p-3">
                    <div className="flex flex-col gap-2">
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-[10px] font-bold uppercase tracking-wide text-primary/80">Landlord</p>
                        {h.landlord_phone && (
                          <div className="flex flex-wrap justify-end gap-1.5">
                            <Button asChild variant="outline" size="sm" className="h-8 gap-1 px-2.5 text-[11px]">
                              <a href={`tel:${h.landlord_phone}`}>
                                <Phone className="h-3.5 w-3.5" /> Call
                              </a>
                            </Button>
                            <Button asChild variant="secondary" size="sm" className="h-8 gap-1 px-2.5 text-[11px]">
                              <a href={`sms:${h.landlord_phone}`}>
                                <MessageSquare className="h-3.5 w-3.5" /> Message
                              </a>
                            </Button>
                          </div>
                        )}
                      </div>
                      <div className="min-w-0 space-y-0.5">
                        <p className="truncate text-sm font-bold leading-tight">
                          {h.landlord_name || 'Name not on file'}
                        </p>
                        {h.landlord_phone && (
                          <p className="flex items-center gap-1.5 text-xs font-semibold text-primary">
                            <Phone className="h-3.5 w-3.5 shrink-0" /> {h.landlord_phone}
                          </p>
                        )}
                      </div>
                    </div>
                  </div>
                )}
                <div className="flex flex-wrap items-center gap-2 border-t px-3 py-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    className="h-8 gap-1 text-[11px]"
                    onClick={() => setDetailHouse(h)}
                  >
                    <Eye className="h-3 w-3" /> View details
                  </Button>
                  {hasGps(h) && (
                    <Button asChild variant="outline" size="sm" className="h-8 gap-1 text-[11px]">
                      <a href={mapsUrl(h)} target="_blank" rel="noopener noreferrer">
                        <Navigation className="h-3 w-3" /> GPS location
                      </a>
                    </Button>
                  )}
                  {hasGps(h) && (
                    <span className="text-[10px] text-muted-foreground">
                      {Number(h.latitude).toFixed(5)}, {Number(h.longitude).toFixed(5)}
                    </span>
                  )}
                </div>
                <div className="border-t px-3 py-2.5">
                  <HouseShareActions house={h} />
                </div>
              </div>
            );
          })}
        </div>
      )}

      {pages > 1 && (
        <div className="flex items-center justify-between text-xs">
          <Button variant="outline" size="sm" disabled={page === 0 || isFetching} onClick={() => setPage((p) => Math.max(0, p - 1))}>
            Previous
          </Button>
          <span className="text-muted-foreground">Page {page + 1} of {pages} · {total} empty houses</span>
          <Button variant="outline" size="sm" disabled={page + 1 >= pages || isFetching} onClick={() => setPage((p) => p + 1)}>
            Next
          </Button>
        </div>
      )}

      <EmptyHouseDetailSheet
        house={detailHouse}
        open={Boolean(detailHouse)}
        onOpenChange={(v) => { if (!v) setDetailHouse(null); }}
        isPartner={false}
      />
    </div>
  );
}
