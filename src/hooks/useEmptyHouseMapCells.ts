import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { mapPerf } from '@/lib/mapPerf';
import { mapRegionFor } from '@/lib/mapRegions';
import type { SupportableHouse } from '@/components/partner/SelfSupportHousesSection';

/**
 * Viewport-scoped empty-house map data.
 *
 * The map never downloads the whole catalogue: the database aggregates the
 * listings inside the current viewport into a zoom-sized grid and returns at
 * most a few hundred cells. A cell holding one house carries that house's
 * details so the marker panel can open without another round trip. This keeps
 * the map flat-cost whether the catalogue holds 10 thousand or 10 million
 * houses.
 */
export interface MapViewport {
  minLat: number;
  minLng: number;
  maxLat: number;
  maxLng: number;
  zoom: number;
}

export interface MapCellFilters {
  search?: string;
  district?: string;
  minRent?: number | null;
  maxRent?: number | null;
  /** Listing age: only houses listed within this many days are aggregated. */
  maxAgeDays?: number | null;
}

export interface EmptyHouseMapCell {
  key: string;
  count: number;
  latitude: number;
  longitude: number;
  minRent: number;
  maxRent: number;
  /** Present only when the cell holds exactly one house. */
  house: SupportableHouse | null;
}

export interface EmptyHouseMapCells {
  cells: EmptyHouseMapCell[];
  /** Houses counted inside the viewport (capped by the server scan limit). */
  housesInView: number;
  scanCapped: boolean;
  /** Grid pitch in degrees used for this zoom — drives the density heatmap tiles. */
  cellSize: number;
}

interface RawCell {
  key: string;
  count: number | string;
  latitude: number | string | null;
  longitude: number | string | null;
  min_rent: number | string | null;
  max_rent: number | string | null;
  house: Record<string, unknown> | null;
}

const toHouse = (raw: Record<string, unknown> | null): SupportableHouse | null => {
  if (!raw || !raw.house_id) return null;
  const images = Array.isArray(raw.image_urls) ? (raw.image_urls as string[]).filter(Boolean) : [];
  return {
    house_id: String(raw.house_id),
    title: (raw.title as string | null) ?? null,
    house_category: (raw.house_category as string | null) ?? null,
    district: (raw.district as string | null) ?? null,
    sub_county: (raw.sub_county as string | null) ?? null,
    village: (raw.village as string | null) ?? null,
    monthly_rent: Number(raw.monthly_rent ?? 0),
    latitude: raw.latitude == null ? null : Number(raw.latitude),
    longitude: raw.longitude == null ? null : Number(raw.longitude),
    verified: raw.verified === true,
    image_urls: images,
    image_url: images[0] ?? null,
    created_at: (raw.created_at as string | null) ?? null,
  } as unknown as SupportableHouse;
};

/** Rounds a viewport so small pans reuse the cached result instead of refetching. */
const quantize = (value: number, step: number) => Math.round(value / step) * step;

export function useEmptyHouseMapCells(
  viewport: MapViewport | null,
  filters: MapCellFilters = {},
  enabled = true,
) {
  const step = viewport ? 360 / Math.pow(2, Math.min(Math.max(viewport.zoom, 1), 20) + 6) : 0;
  const key = viewport
    ? {
        minLat: quantize(viewport.minLat, step),
        minLng: quantize(viewport.minLng, step),
        maxLat: quantize(viewport.maxLat, step),
        maxLng: quantize(viewport.maxLng, step),
        zoom: viewport.zoom,
      }
    : null;

  // Attribute the events that follow to the region now on screen, so production
  // monitoring can tell a slow region from a slow session.
  const centreLat = viewport ? (viewport.minLat + viewport.maxLat) / 2 : null;
  const centreLng = viewport ? (viewport.minLng + viewport.maxLng) / 2 : null;
  const region = mapRegionFor(centreLat, centreLng);
  useEffect(() => {
    if (!viewport) return;
    mapPerf.setRegion(region, viewport.zoom);
  }, [region, viewport]);

  // Classify each viewport read: a key we already requested is served from cache.
  const viewportKey = key ? JSON.stringify([key, filters]) : null;
  useEffect(() => {
    if (!viewportKey || !enabled) return;
    mapPerf.noteViewportKey(viewportKey);
  }, [viewportKey, enabled]);

  return useQuery<EmptyHouseMapCells>({
    queryKey: ['empty-house-map-cells', key, filters],
    enabled: enabled && !!viewport,
    placeholderData: (previous) => previous,
    staleTime: 60 * 1000,
    gcTime: 10 * 60 * 1000,
    refetchOnWindowFocus: false,
    // A flaky mobile network is the norm in the field: retry with backoff, and
    // only surface a failure once the retries are exhausted.
    retry: 2,
    retryDelay: (attempt) => Math.min(4000, 600 * 2 ** attempt),
    queryFn: async ({ signal }) => {
      if (!viewport) return { cells: [], housesInView: 0, scanCapped: false, cellSize: 0 };
      const startedAt = performance.now();
      // Stale-result protection: a superseded viewport read is aborted, so a
      // slow response can never overwrite the houses now on screen.
      const { data, error } = await supabase.rpc('map_empty_house_cells', {
        p_min_lat: viewport.minLat,
        p_min_lng: viewport.minLng,
        p_max_lat: viewport.maxLat,
        p_max_lng: viewport.maxLng,
        p_zoom: Math.round(viewport.zoom),
        p_search: filters.search?.trim() ? filters.search.trim() : null,
        p_district: filters.district?.trim() ? filters.district.trim() : null,
        p_min_rent: filters.minRent ?? null,
        p_max_rent: filters.maxRent ?? null,
        p_limit: 400,
        p_max_age_days: filters.maxAgeDays ?? null,
      }).abortSignal(signal);
      if (signal?.aborted) throw new Error('aborted');
      if (error) {
        mapPerf.recordFailure(error.message ?? 'Viewport query failed');
        throw error;
      }

      const payload = (data ?? {}) as { cells?: RawCell[]; scanned?: number; scan_capped?: boolean; cell_size?: number | string };
      const cells = (payload.cells ?? [])
        .map((raw) => ({
          key: raw.key,
          count: Number(raw.count ?? 0),
          latitude: Number(raw.latitude ?? 0),
          longitude: Number(raw.longitude ?? 0),
          minRent: Number(raw.min_rent ?? 0),
          maxRent: Number(raw.max_rent ?? 0),
          house: toHouse(raw.house),
        }))
        .filter((cell) => Number.isFinite(cell.latitude) && Number.isFinite(cell.longitude));

      const result = {
        cells,
        housesInView: Number(payload.scanned ?? 0),
        scanCapped: payload.scan_capped === true,
        cellSize: Number(payload.cell_size ?? 0),
      };
      mapPerf.recordQuery(performance.now() - startedAt, {
        markers: result.cells.length,
        housesInView: result.housesInView,
        scanCapped: result.scanCapped,
      });
      return result;
    },
  });
}
