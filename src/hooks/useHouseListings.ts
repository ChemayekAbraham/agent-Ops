import { useState, useEffect, useCallback, useRef } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { PUBLIC_HOUSE_LISTING_COLUMNS } from '@/lib/houseListingColumns';
import { applyAreaFilter } from '@/lib/listingAreaFilter';

export interface HouseListing {
  id: string;
  landlord_id?: string | null;
  agent_id?: string;
  title: string;
  description: string | null;
  house_category: string;
  number_of_rooms: number;
  monthly_rent: number;
  daily_rate: number;
  access_fee: number;
  platform_fee: number;
  total_monthly_cost: number;
  region: string;
  district: string | null;
  sub_county?: string | null;
  village?: string | null;
  /** Official ug_villages id — present only on upgraded listings. */
  ug_village_id?: number | null;
  address: string;
  latitude: number | null;
  longitude: number | null;
  has_water: boolean;
  has_electricity: boolean;
  has_security: boolean;
  has_parking: boolean;
  is_furnished: boolean;
  amenities?: string[] | null;
  image_urls: string[] | null;
  status: string;
  video_url?: string | null;
  tenant_id?: string | null;
  landlord_accepted?: boolean;
  verified?: boolean | null;
  created_at: string;
  updated_at?: string;
  short_code?: string | null;
  verified_at?: string | null;
  // Bonus tracking
  listed_bonus_paid?: boolean | null;
  listed_bonus_paid_at?: string | null;
  listing_bonus_paid?: boolean | null;
  listing_bonus_paid_at?: string | null;
  // Distance from spatial query
  distance_km?: number;
  // Agent contact (enriched client-side)
  agent_phone?: string | null;
  agent_name?: string | null;
  agent_rating?: number | null;
}

/**
 * Enrich listings with the listing agent's phone/name.
 *
 * Tenants cannot read other users' `profiles` rows directly (RLS), so we use the
 * `get_listing_agent_contacts` SECURITY DEFINER RPC, which only returns the
 * contact of the agent who listed an available house. This is what powers the
 * "Chat on WhatsApp" button on the tenant dashboard.
 */
async function enrichWithAgentInfo(listings: HouseListing[]): Promise<HouseListing[]> {
  const listingIds = [...new Set(listings.map(l => l.id).filter(Boolean))] as string[];
  if (!listingIds.length) return listings;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data } = await (supabase as any).rpc('get_listing_agent_contacts', {
    p_listing_ids: listingIds,
  });
  if (!data) return listings;
  const map = new Map<string, { full_name: string | null; phone: string | null; avg_rating: number | null }>(
    (data as any[]).map((r) => [r.listing_id, { full_name: r.full_name, phone: r.phone, avg_rating: r.avg_rating }])
  );
  return listings.map(l => {
    const agent = map.get(l.id);
    return { ...l, agent_phone: agent?.phone ?? null, agent_name: agent?.full_name ?? null, agent_rating: agent?.avg_rating ?? null };
  });
}

/**
 * A listing is only shown to tenants / the public if it has at least one real
 * uploaded photo. Listings with no photos (e.g. empty houses logged by agents
 * before photographing them) are hidden from the marketplace until a photo is
 * added. Agents still see their own photo-less listings in their own views.
 */
export function listingHasRealPhoto(l: { image_urls?: string[] | null }): boolean {
  return Array.isArray(l.image_urls) && l.image_urls.some(u => typeof u === 'string' && u.trim().length > 0);
}

interface UseHouseListingsOptions {
  region?: string;
  category?: string;
  maxDailyRate?: number;
  agentId?: string;
  status?: string;
  limit?: number;
}

/**
 * Hook for basic house listings (no spatial query).
 * Used by agent dashboards and non-geo contexts.
 */
export function useHouseListings(options: UseHouseListingsOptions = {}) {
  const [listings, setListings] = useState<HouseListing[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchListings = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      let query = supabase
        .from('house_listings')
        .select(PUBLIC_HOUSE_LISTING_COLUMNS)
        .order('created_at', { ascending: false })
        .limit(options.limit || 50);

      if (options.status) {
        query = query.eq('status', options.status);
      } else if (!options.agentId) {
        // Default to only "available" for public/marketplace queries.
        // When an agent is viewing THEIR OWN listings, show every status
        // (available, occupied, rejected, etc.) so they can manage them all.
        query = query.eq('status', 'available');
      }

      // Hide houses that landlord ops has hidden — only when not viewing
      // an agent's own listings (agents must still see/manage their hidden ones).
      if (!options.agentId) {
        query = query.eq('is_hidden', false);
      }

      // A listing is only shown publicly once Landlord Ops (admin) has approved
      // it (verified = true). Unverified listings stay out of the marketplace.
      // Agents still see all of their own listings regardless of approval state.
      if (!options.agentId) {
        query = query.eq('verified', true);
      }

      if (options.region) {
        query = query.ilike('region', `%${options.region}%`);
      }
      if (options.category) {
        query = query.eq('house_category', options.category);
      }
      if (options.maxDailyRate) {
        query = query.lte('daily_rate', options.maxDailyRate);
      }
      if (options.agentId) {
        query = query.eq('agent_id', options.agentId);
      }

      const { data, error: fetchError } = await query;

      if (fetchError) throw fetchError;
      let rows = ((data as any[]) || []) as HouseListing[];
      // Public/marketplace views must only show houses that have real photos.
      // Agents viewing their own listings still see everything so they can add photos.
      if (!options.agentId) {
        rows = rows.filter(listingHasRealPhoto);
      }
      const enriched = await enrichWithAgentInfo(rows);
      setListings(enriched);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [options.region, options.category, options.maxDailyRate, options.agentId, options.status, options.limit]);

  useEffect(() => {
    fetchListings();
  }, [fetchListings]);

  return { listings, loading, error, refresh: fetchListings };
}

interface UseNearbyHousesOptions {
  latitude: number | null;
  longitude: number | null;
  radiusKm?: number;
  category?: string;
  region?: string;
  district?: string;
  subCounty?: string;
  village?: string;
  /** Official ug_villages id for the picked village (upgraded listings). */
  villageId?: number | null;
  search?: string;
  limit?: number;
  enabled?: boolean;
  /** Cap on daily_rate (UGX). Applied as `daily_rate <= maxDailyRate`. */
  maxDailyRate?: number;
  /** Floor on daily_rate (UGX). Applied as `daily_rate >= minDailyRate`. */
  minDailyRate?: number;
  /** Minimum number of rooms. Applied as `number_of_rooms >= minRooms`. */
  minRooms?: number;
  /** Amenity toggles — when true, only match rows with that boolean = true. */
  hasWater?: boolean;
  hasElectricity?: boolean;
  hasSecurity?: boolean;
  hasParking?: boolean;
  isFurnished?: boolean;
  /** Sort order for the fallback (non-GPS) query. */
  sort?: 'newest' | 'price_asc' | 'price_desc';
  /**
   * When true, fetch EVERY matching listing by paging through the source
   * instead of relying on a single fixed cap. Results stream in page-by-page,
   * ordered by GPS distance. Use this for full browse views (tenant/funder
   * "Available Houses"). Leave off for bounded previews that intentionally show
   * a small number (they pass `limit`).
   */
  paginate?: boolean;
  /** Rows fetched per page when `paginate` is true. Defaults to 500. */
  pageSize?: number;
  /** Hard safety ceiling so a runaway dataset can't fetch unbounded. Defaults to 20000. */
  maxResults?: number;
}

/**
 * In-memory cache of paginated nearby-house results, keyed by the exact filter
 * set (rounded GPS + radius + category + region + page size). Re-opening the
 * sheet or returning to a previously-viewed filter combo restores the already
 * fetched pages + cursor instantly instead of re-hitting the RPC page by page.
 *
 * This lives at module scope so it survives component unmount/remount (e.g.
 * closing and re-opening the Available Houses sheet) within the same session.
 */
interface NearbyCacheEntry {
  listings: HouseListing[];
  offset: number;
  useRpc: boolean;
  exhausted: boolean;
  ts: number;
}
const NEARBY_CACHE = new Map<string, NearbyCacheEntry>();
const NEARBY_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const NEARBY_CACHE_MAX = 24; // cap distinct filter sets kept in memory

function nearbyCacheKey(o: UseNearbyHousesOptions, paginate: boolean, pageSize: number): string {
  // Round GPS to ~3 decimals (~110m) so tiny location jitter reuses the cache.
  const r = (n: number | null | undefined) => (n == null ? 'x' : n.toFixed(3));
  return [
    r(o.latitude),
    r(o.longitude),
    o.radiusKm || 50,
    o.category || '',
    o.region || '',
    o.district || '',
    o.subCounty || '',
    o.village || '',
    o.villageId ?? '',
    o.search || '',
    paginate ? 1 : 0,
    pageSize,
    o.minDailyRate || 0,
    o.maxDailyRate || 0,
    o.minRooms || 0,
    o.hasWater ? 'w' : '',
    o.hasElectricity ? 'e' : '',
    o.hasSecurity ? 's' : '',
    o.hasParking ? 'p' : '',
    o.isFurnished ? 'f' : '',
    o.sort || '',
  ].join('|');
}

function safeOrTerm(value: string | undefined): string {
  return (value || '').replace(/[%,()]/g, ' ').trim();
}

function writeNearbyCache(key: string, entry: NearbyCacheEntry) {
  NEARBY_CACHE.set(key, entry);
  // Evict the oldest entries when we exceed the cap (Map preserves insert order,
  // and re-setting an existing key keeps its original position, so refresh by ts).
  if (NEARBY_CACHE.size > NEARBY_CACHE_MAX) {
    const oldest = [...NEARBY_CACHE.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
    if (oldest) NEARBY_CACHE.delete(oldest[0]);
  }
}

/** Clear cached nearby-house pages. Call after listing data changes materially. */
export function clearNearbyHousesCache() {
  NEARBY_CACHE.clear();
}

/**
 * Diagnostics for a paginated GPS house search. Exposed from `useNearbyHouses`
 * and logged to the console (see `paginationDebugEnabled`) so slow or incomplete
 * queries are quick to spot: how many pages we fetched, how many rows the source
 * returned vs. how many we actually show, whether the spatial RPC or the plain
 * fallback answered, timing, and any duplicate rows the paginator returned.
 */
export interface NearbyMetrics {
  /** The filter-set cache key this run belongs to. */
  filterKey: string;
  /** Number of source pages fetched this run (0 when served purely from cache). */
  pagesFetched: number;
  /** Raw rows returned by the source before the photo filter / dedupe. */
  rawRowsFetched: number;
  /** Distinct rows actually shown (after photo filter + dedupe). */
  totalRows: number;
  /** Rows dropped because a later page repeated an id from an earlier page. */
  duplicatesDetected: number;
  /** Rows dropped because they had no real photo. */
  photolessFiltered: number;
  /** Whether this run was restored from the in-memory cache. */
  cacheHit: boolean;
  /** Which data path answered: the PostGIS RPC or the plain fallback query. */
  source: 'rpc' | 'fallback';
  /** Time to the first page's rows (ms). */
  firstPageMs: number | null;
  /** Duration of the most recent page fetch (ms). */
  lastPageMs: number | null;
  /** Cumulative fetch time across all pages this run (ms). */
  totalMs: number;
  /** True once the source is exhausted (no more pages). */
  complete: boolean;
}

function emptyMetrics(): NearbyMetrics {
  return {
    filterKey: '',
    pagesFetched: 0,
    rawRowsFetched: 0,
    totalRows: 0,
    duplicatesDetected: 0,
    photolessFiltered: 0,
    cacheHit: false,
    source: 'rpc',
    firstPageMs: null,
    lastPageMs: null,
    totalMs: 0,
    complete: false,
  };
}

/**
 * Pagination logging is on automatically in dev, and can be toggled in any
 * environment (e.g. production debugging) with:
 *   localStorage.setItem('welile-debug-pagination', '1')
 */
function paginationDebugEnabled(): boolean {
  try {
    if (typeof localStorage !== 'undefined' && localStorage.getItem('welile-debug-pagination') === '1') return true;
  } catch { /* ignore */ }
  try {
    return !!import.meta.env?.DEV;
  } catch {
    return false;
  }
}

function pgLog(event: string, data: Record<string, unknown>) {
  if (!paginationDebugEnabled()) return;
  // eslint-disable-next-line no-console
  console.info(`[house-pagination] ${event}`, data);
}

/**
 * Hook for spatial nearby house search using PostGIS.
 *
 * Falls back to a regular query when there are no GPS coordinates (or if the
 * spatial RPC is unavailable). When `paginate` is true it pages through the
 * ENTIRE matching result set — GPS-distance ordered — so browse views never
 * silently truncate at a fixed cap. Pages are appended as they arrive; the
 * first page clears the loading state so the UI paints quickly while the rest
 * loads in the background.
 */
export function useNearbyHouses(options: UseNearbyHousesOptions) {
  const [listings, setListings] = useState<HouseListing[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Cancels stale in-flight requests when the query params change.
  const runIdRef = useRef(0);
  // Cursor state for lazy (infinite-scroll) pagination. Lives in a ref so
  // `loadMore` can be called repeatedly without re-creating the callback.
  const cursorRef = useRef<{
    offset: number;
    useRpc: boolean;
    exhausted: boolean;
    loading: boolean;
    accumulated: HouseListing[];
  }>({ offset: 0, useRpc: false, exhausted: true, loading: false, accumulated: [] });
  // Pagination diagnostics for the current filter set. `seenIdsRef` powers both
  // duplicate detection and dedupe of rows the paginator may repeat.
  const metricsRef = useRef<NearbyMetrics>(emptyMetrics());
  const seenIdsRef = useRef<Set<string>>(new Set());
  const [metrics, setMetrics] = useState<NearbyMetrics>(metricsRef.current);

  const paginate = options.paginate === true;
  const maxResults = options.maxResults && options.maxResults > 0 ? options.maxResults : 20000;
  const pageSize = paginate
    ? (options.pageSize && options.pageSize > 0 ? options.pageSize : 24)
    : (options.limit || 50);

  // Fetch a single page at the current cursor and append it. Handles the
  // spatial RPC → plain query fallback and stale-run cancellation.
  const fetchPage = useCallback(async (runId: number, isFirst: boolean) => {
    const st = cursorRef.current;
    if (st.exhausted || st.loading) return;
    st.loading = true;
    if (isFirst) setLoading(true); else setLoadingMore(true);
    const pageStart = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const key = nearbyCacheKey(options, paginate, pageSize);

    try {
      const remaining = maxResults - st.accumulated.length;
      if (remaining <= 0) {
        st.exhausted = true;
        setHasMore(false);
        const m = metricsRef.current;
        m.complete = true;
        setMetrics({ ...m });
        return;
      }
      const wantLimit = Math.min(pageSize, remaining);

      const fetchRaw = async (): Promise<any[]> => {
        if (st.useRpc) {
          const { data, error: rpcError } = await supabase.rpc('find_nearby_houses', {
            user_lat: options.latitude,
            user_lng: options.longitude,
            radius_km: options.radiusKm || 50,
            category_filter: options.category || null,
            region_filter: options.region || null,
            result_limit: wantLimit,
            result_offset: st.offset,
          });
          if (rpcError) {
            // RPC unavailable — switch to the plain query for the rest of the run.
            if (st.offset === 0) { st.useRpc = false; return fetchRaw(); }
            throw rpcError;
          }
          return (data as any[]) || [];
        }
        let query = supabase
          .from('house_listings')
          .select(PUBLIC_HOUSE_LISTING_COLUMNS)
          .eq('status', 'available')
          .eq('verified', true)
          .eq('is_hidden', false)
          .range(st.offset, st.offset + wantLimit - 1);
        if (options.sort === 'price_asc') {
          query = query.order('daily_rate', { ascending: true }).order('id', { ascending: true });
        } else if (options.sort === 'price_desc') {
          query = query.order('daily_rate', { ascending: false }).order('id', { ascending: true });
        } else {
          query = query.order('created_at', { ascending: false }).order('id', { ascending: true });
        }
        if (options.region) {
          // The location filter may be a broad region ("Central") OR a
          // city/district/village ("Kampala", "Wakiso"). Match any of the
          // location columns so picking a district doesn't return zero houses.
          const term = safeOrTerm(options.region);
          query = query.or(
            [
              `region.ilike.%${term}%`,
              `district.ilike.%${term}%`,
              `sub_county.ilike.%${term}%`,
              `village.ilike.%${term}%`,
              `address.ilike.%${term}%`,
            ].join(','),
          );
        }
        // District / sub-county / village: id-based where the listing has been
        // upgraded, normalised case-insensitive text otherwise (shared builder
        // so the list and the exact counters can never diverge).
        query = applyAreaFilter(query as any, {
          district: options.district,
          subCounty: options.subCounty,
          village: options.village,
          villageId: options.villageId ?? null,
        }) as typeof query;
        if (options.category) query = query.eq('house_category', options.category);
        if (options.minDailyRate) query = query.gte('daily_rate', options.minDailyRate);
        if (options.maxDailyRate) query = query.lte('daily_rate', options.maxDailyRate);
        if (options.minRooms) query = query.gte('number_of_rooms', options.minRooms);
        if (options.hasWater) query = query.eq('has_water', true);
        if (options.hasElectricity) query = query.eq('has_electricity', true);
        if (options.hasSecurity) query = query.eq('has_security', true);
        if (options.hasParking) query = query.eq('has_parking', true);
        if (options.isFurnished) query = query.eq('is_furnished', true);
        const search = safeOrTerm(options.search);
        if (search) {
          query = query.or(
            [
              `title.ilike.%${search}%`,
              `description.ilike.%${search}%`,
              `region.ilike.%${search}%`,
              `district.ilike.%${search}%`,
              `sub_county.ilike.%${search}%`,
              `village.ilike.%${search}%`,
              `address.ilike.%${search}%`,
            ].join(','),
          );
        }
        const { data, error: fetchError } = await query;
        if (fetchError) throw fetchError;
        return (data as any[]) || [];
      };

      const pageRaw = await fetchRaw();
      // Stale run (params changed mid-flight) — abandon without touching state.
      if (runId !== runIdRef.current) return;

      // Public/marketplace views only show houses with real photos. Filter for
      // display, but advance the cursor by the RAW page size so photo-less rows
      // don't make us stop early.
      const filteredPage = (pageRaw as HouseListing[]).filter(listingHasRealPhoto);
      const enriched = await enrichWithAgentInfo(filteredPage);
      if (runId !== runIdRef.current) return;

      // Duplicate detection + dedupe: a shifting/large result set can re-return a
      // row across page boundaries. We drop repeats (so React keys never collide)
      // and count them so incomplete/overlapping GPS queries are easy to spot.
      let dupCount = 0;
      const pageUnique: HouseListing[] = [];
      for (const l of enriched) {
        if (l.id && seenIdsRef.current.has(l.id)) { dupCount++; continue; }
        if (l.id) seenIdsRef.current.add(l.id);
        pageUnique.push(l);
      }
      st.accumulated = [...st.accumulated, ...pageUnique];
      st.offset += pageRaw.length;
      // In non-paginate mode we only ever fetch one page.
      st.exhausted = !paginate || pageRaw.length < wantLimit;
      setListings([...st.accumulated]);
      setHasMore(!st.exhausted);

      // Update + emit pagination metrics.
      const pageMs = Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - pageStart);
      const m = metricsRef.current;
      m.filterKey = key;
      m.pagesFetched += 1;
      m.rawRowsFetched += pageRaw.length;
      m.totalRows = st.accumulated.length;
      m.duplicatesDetected += dupCount;
      m.photolessFiltered += pageRaw.length - filteredPage.length;
      m.source = st.useRpc ? 'rpc' : 'fallback';
      m.cacheHit = false;
      m.lastPageMs = pageMs;
      m.totalMs += pageMs;
      if (isFirst || m.firstPageMs == null) m.firstPageMs = pageMs;
      m.complete = st.exhausted;
      setMetrics({ ...m });
      pgLog(st.exhausted ? 'run complete' : 'page fetched', {
        filterKey: key,
        page: m.pagesFetched,
        source: m.source,
        pageRows: pageRaw.length,
        newRows: pageUnique.length,
        dupsThisPage: dupCount,
        photolessThisPage: pageRaw.length - filteredPage.length,
        totalRows: m.totalRows,
        totalDuplicates: m.duplicatesDetected,
        pageMs,
        totalMs: m.totalMs,
        complete: st.exhausted,
      });

      // Write-through cache so re-opening this filter set restores instantly.
      writeNearbyCache(nearbyCacheKey(options, paginate, pageSize), {
        listings: st.accumulated,
        offset: st.offset,
        useRpc: st.useRpc,
        exhausted: st.exhausted,
        ts: Date.now(),
      });
    } catch (err: any) {
      if (runId === runIdRef.current) {
        setError(err.message);
        pgLog('page error', { filterKey: key, page: metricsRef.current.pagesFetched + 1, error: err?.message });
      }
    } finally {
      st.loading = false;
      if (runId === runIdRef.current) {
        setLoading(false);
        setLoadingMore(false);
      }
    }
  }, [
    options.latitude,
    options.longitude,
    options.radiusKm,
    options.category,
    options.region,
    options.district,
    options.subCounty,
    options.village,
    options.search,
    options.minDailyRate,
    options.maxDailyRate,
    options.minRooms,
    options.hasWater,
    options.hasElectricity,
    options.hasSecurity,
    options.hasParking,
    options.isFurnished,
    options.sort,
    paginate,
    pageSize,
    maxResults,
  ]);

  // (Re)start from the first page whenever the query params change.
  useEffect(() => {
    if (options.enabled === false) {
      setLoading(false);
      setLoadingMore(false);
      setHasMore(false);
      return;
    }
    const runId = ++runIdRef.current;
    const hasGps = !!(options.latitude && options.longitude);

    // Cache hit: restore the previously fetched pages + cursor without any
    // network calls. `loadMore` then continues from the cached offset.
    const key = nearbyCacheKey(options, paginate, pageSize);
    const cached = NEARBY_CACHE.get(key);
    if (cached && Date.now() - cached.ts < NEARBY_CACHE_TTL) {
      cursorRef.current = {
        offset: cached.offset,
        useRpc: cached.useRpc,
        exhausted: cached.exhausted,
        loading: false,
        accumulated: cached.listings,
      };
      setListings(cached.listings);
      setError(null);
      setLoading(false);
      setLoadingMore(false);
      setHasMore(!cached.exhausted);
      // Rebuild the seen-id set so further loadMore() calls still dedupe.
      seenIdsRef.current = new Set(cached.listings.map((l) => l.id).filter(Boolean) as string[]);
      metricsRef.current = {
        ...emptyMetrics(),
        filterKey: key,
        totalRows: cached.listings.length,
        cacheHit: true,
        source: cached.useRpc ? 'rpc' : 'fallback',
        complete: cached.exhausted,
      };
      setMetrics({ ...metricsRef.current });
      pgLog('cache hit', { filterKey: key, rows: cached.listings.length, complete: cached.exhausted });
      return;
    }

    cursorRef.current = { offset: 0, useRpc: hasGps, exhausted: false, loading: false, accumulated: [] };
    setListings([]);
    setError(null);
    setLoading(true);
    setLoadingMore(false);
    setHasMore(false);
    seenIdsRef.current = new Set();
    metricsRef.current = { ...emptyMetrics(), filterKey: key, source: hasGps ? 'rpc' : 'fallback' };
    setMetrics({ ...metricsRef.current });
    pgLog('run start', { filterKey: key, hasGps, pageSize, paginate });
    fetchPage(runId, true);
  }, [fetchPage, options.enabled]);

  // Load the next page on demand (called when the user nears the bottom).
  const loadMore = useCallback(() => {
    const st = cursorRef.current;
    if (st.loading || st.exhausted) return;
    fetchPage(runIdRef.current, false);
  }, [fetchPage]);

  const refresh = useCallback(() => {
    const runId = ++runIdRef.current;
    const hasGps = !!(options.latitude && options.longitude);
    // Force a fresh fetch: drop this filter set's cached pages first.
    const key = nearbyCacheKey(options, paginate, pageSize);
    NEARBY_CACHE.delete(key);
    cursorRef.current = { offset: 0, useRpc: hasGps, exhausted: false, loading: false, accumulated: [] };
    setListings([]);
    setError(null);
    setLoading(true);
    setLoadingMore(false);
    setHasMore(false);
    seenIdsRef.current = new Set();
    metricsRef.current = { ...emptyMetrics(), filterKey: key, source: hasGps ? 'rpc' : 'fallback' };
    setMetrics({ ...metricsRef.current });
    pgLog('refresh', { filterKey: key });
    fetchPage(runId, true);
  }, [fetchPage, options.latitude, options.longitude, options.radiusKm, options.category, options.region, options.district, options.subCounty, options.village, options.villageId, options.search, options.minDailyRate, options.maxDailyRate, options.minRooms, options.hasWater, options.hasElectricity, options.hasSecurity, options.hasParking, options.isFurnished, options.sort, paginate, pageSize]);

  return { listings, loading, loadingMore, hasMore, loadMore, error, refresh, metrics };
}

/**
 * Calculate the daily rate for a house listing
 * Formula: (monthly_rent + access_fee + platform_fee) / 30
 */
export function calculateDailyRentalRate(monthlyRent: number) {
  const accessFee = Math.round(monthlyRent * (Math.pow(1.33, 1) - 1)); // 33% for 30 days
  const platformFee = monthlyRent <= 200000 ? 10000 : 20000;
  const totalMonthlyCost = monthlyRent + accessFee + platformFee;
  const dailyRate = Math.ceil(totalMonthlyCost / 30);

  return {
    monthlyRent,
    accessFee,
    platformFee,
    totalMonthlyCost,
    dailyRate,
  };
}

// ---------------------------------------------------------------------------
// Exact listing counts per filtered location
// ---------------------------------------------------------------------------

export interface HouseListingCountOptions {
  /** Region/city term chosen in the top-level dropdown (broad ILIKE match). */
  region?: string;
  /** Exact district selected in the cascading filter. */
  district?: string;
  /** Exact sub-county/area selected in the cascading filter. */
  subCounty?: string;
  /** Exact village selected in the cascading filter. */
  village?: string;
  /** Official ug_villages id for the picked village (upgraded listings). */
  villageId?: number | null;
  /** house_category filter. */
  category?: string;
  /** Cap on daily_rate. */
  maxDailyRate?: number;
  /** Floor on daily_rate. */
  minDailyRate?: number;
  /** Minimum rooms. */
  minRooms?: number;
  hasWater?: boolean;
  hasElectricity?: boolean;
  hasSecurity?: boolean;
  hasParking?: boolean;
  isFurnished?: boolean;
  /** Free-text search term (matches title/region/district/address). */
  search?: string;
  enabled?: boolean;
}

export interface HouseListingCounts {
  /** Approved/verified listings live in the public marketplace. */
  verified: number;
  /** Listed but awaiting Landlord Ops verification. */
  unverified: number;
  /** verified + unverified. */
  total: number;
  loading: boolean;
  error: string | null;
}

const escapeOr = (s: string) => s.replace(/[,()]/g, ' ').trim();

/**
 * Returns the EXACT number of listed houses matching the active location/filter
 * set, split into verified (public marketplace) and not-yet-verified (pending
 * approval). Uses cheap `count: 'exact', head: true` queries — no rows are
 * fetched — so it stays accurate no matter how many pages the list has loaded.
 * This replaces the misleading "24+" counter that only reflected loaded rows.
 */
export function useHouseListingCount(options: HouseListingCountOptions): HouseListingCounts {
  const {
    region,
    district,
    subCounty,
    village,
    villageId,
    category,
    maxDailyRate,
    minDailyRate,
    minRooms,
    hasWater,
    hasElectricity,
    hasSecurity,
    hasParking,
    isFurnished,
    search,
    enabled = true,
  } = options;

  const [counts, setCounts] = useState<{ verified: number; unverified: number }>({
    verified: 0,
    unverified: 0,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    let cancelled = false;

    const buildQuery = (verified: boolean) => {
      let q = supabase
        .from('house_listings')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'available')
        .eq('is_hidden', false)
        .eq('verified', verified);

      const term = region && region.trim() && region !== 'All Regions' ? escapeOr(region) : '';
      if (term) {
        q = q.or(
          [
            `region.ilike.%${term}%`,
            `district.ilike.%${term}%`,
            `sub_county.ilike.%${term}%`,
            `village.ilike.%${term}%`,
            `address.ilike.%${term}%`,
          ].join(','),
        );
      }
      q = applyAreaFilter(q as any, { district, subCounty, village, villageId: villageId ?? null }) as typeof q;
      if (category && category !== 'all') q = q.eq('house_category', category);
      if (maxDailyRate) q = q.lte('daily_rate', maxDailyRate);
      if (minDailyRate) q = q.gte('daily_rate', minDailyRate);
      if (minRooms) q = q.gte('number_of_rooms', minRooms);
      if (hasWater) q = q.eq('has_water', true);
      if (hasElectricity) q = q.eq('has_electricity', true);
      if (hasSecurity) q = q.eq('has_security', true);
      if (hasParking) q = q.eq('has_parking', true);
      if (isFurnished) q = q.eq('is_furnished', true);
      const s = search && search.trim() ? escapeOr(search) : '';
      if (s) {
        q = q.or(
          [
            `title.ilike.%${s}%`,
            `description.ilike.%${s}%`,
            `region.ilike.%${s}%`,
            `district.ilike.%${s}%`,
            `sub_county.ilike.%${s}%`,
            `village.ilike.%${s}%`,
            `address.ilike.%${s}%`,
          ].join(','),
        );
      }
      return q;
    };

    (async () => {
      setLoading(true);
      setError(null);
      try {
        const [ver, unver] = await Promise.all([buildQuery(true), buildQuery(false)]);
        if (cancelled) return;
        if (ver.error) throw ver.error;
        if (unver.error) throw unver.error;
        setCounts({ verified: ver.count || 0, unverified: unver.count || 0 });
      } catch (err: any) {
        if (!cancelled) setError(err?.message || 'Failed to count listings');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [region, district, subCounty, village, villageId, category, maxDailyRate, minDailyRate, minRooms, hasWater, hasElectricity, hasSecurity, hasParking, isFurnished, search, enabled]);

  return {
    verified: counts.verified,
    unverified: counts.unverified,
    total: counts.verified + counts.unverified,
    loading,
    error,
  };
}
