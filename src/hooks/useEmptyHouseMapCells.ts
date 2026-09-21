import { useEffect, useMemo } from 'react';
import { useQueries, type UseQueryResult } from '@tanstack/react-query';
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
 *
 * Loading is progressive, not batched: the viewport is split into tiles and
 * each tile is fetched as its own asynchronous query. Houses appear on the map
 * as each tile lands instead of waiting for one whole-viewport response, a
 * slow tile never holds the others back, and tiles are cached individually so
 * panning reuses the tiles that stay on screen.
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
  /** Rent needed to fund every empty house in this cell. */
  sumRent: number;
  /** A district name seen inside the cell, used to label a tapped region. */
  district: string | null;
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
  sum_rent: number | string | null;
  district: string | null;
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

/** Rounds a viewport edge so small pans reuse cached tiles instead of refetching. */
const quantize = (value: number, step: number) => Math.round(value / step) * step;

/**
 * The viewport is split into a 2×2 grid of independently fetched tiles. Each
 * tile still asks the server for a bounded payload, and the merged render is
 * capped at the same 400-cell budget the single-batch query had.
 */
const TILES_PER_AXIS = 2;
const SERVER_CELL_LIMIT = 400;

interface MapTile {
  key: { minLat: number; minLng: number; maxLat: number; maxLng: number; zoom: number };
  bounds: { minLat: number; minLng: number; maxLat: number; maxLng: number };
}

/** Splits a quantized viewport key into quantized tiles so pans reuse overlapping tiles. */
const buildTiles = (key: MapTile['key'], step: number): MapTile[] => {
  const tiles: MapTile[] = [];
  const latStep = (key.maxLat - key.minLat) / TILES_PER_AXIS;
  const lngStep = (key.maxLng - key.minLng) / TILES_PER_AXIS;
  for (let latIndex = 0; latIndex < TILES_PER_AXIS; latIndex += 1) {
    for (let lngIndex = 0; lngIndex < TILES_PER_AXIS; lngIndex += 1) {
      const bounds = {
        minLat: quantize(key.minLat + latIndex * latStep, step),
        maxLat: latIndex === TILES_PER_AXIS - 1 ? key.maxLat : quantize(key.minLat + (latIndex + 1) * latStep, step),
        minLng: quantize(key.minLng + lngIndex * lngStep, step),
        maxLng: lngIndex === TILES_PER_AXIS - 1 ? key.maxLng : quantize(key.minLng + (lngIndex + 1) * lngStep, step),
      };
      if (bounds.maxLat <= bounds.minLat || bounds.maxLng <= bounds.minLng) continue;
      tiles.push({ key: { ...bounds, zoom: key.zoom }, bounds });
    }
  }
  return tiles;
};

const parsePayload = (data: unknown): EmptyHouseMapCells => {
  const payload = (data ?? {}) as { cells?: RawCell[]; scanned?: number; scan_capped?: boolean; cell_size?: number | string };
  const cells = (payload.cells ?? [])
    .map((raw) => ({
      key: raw.key,
      count: Number(raw.count ?? 0),
      latitude: Number(raw.latitude ?? 0),
      longitude: Number(raw.longitude ?? 0),
      minRent: Number(raw.min_rent ?? 0),
      maxRent: Number(raw.max_rent ?? 0),
      sumRent: Number(raw.sum_rent ?? 0),
      district: raw.district ?? null,
      house: toHouse(raw.house),
    }))
    .filter((cell) => Number.isFinite(cell.latitude) && Number.isFinite(cell.longitude));

  return {
    cells,
    housesInView: Number(payload.scanned ?? 0),
    scanCapped: payload.scan_capped === true,
    cellSize: Number(payload.cell_size ?? 0),
  };
};

const fetchTile = async (
  tile: MapTile,
  zoom: number,
  filters: MapCellFilters,
  signal: AbortSignal | undefined,
): Promise<EmptyHouseMapCells> => {
  const startedAt = performance.now();
  // Stale-result protection: a superseded tile read is aborted, so a slow
  // response can never overwrite the houses now on screen.
  const { data, error } = await supabase.rpc('map_empty_house_cells', {
    p_min_lat: tile.bounds.minLat,
    p_min_lng: tile.bounds.minLng,
    p_max_lat: tile.bounds.maxLat,
    p_max_lng: tile.bounds.maxLng,
    p_zoom: Math.round(zoom),
    p_search: filters.search?.trim() ? filters.search.trim() : null,
    p_district: filters.district?.trim() ? filters.district.trim() : null,
    p_min_rent: filters.minRent ?? null,
    p_max_rent: filters.maxRent ?? null,
    p_limit: SERVER_CELL_LIMIT,
    p_max_age_days: filters.maxAgeDays ?? null,
  }).abortSignal(signal);
  if (signal?.aborted) throw new Error('aborted');
  if (error) {
    mapPerf.recordFailure(error.message ?? 'Viewport query failed');
    throw error;
  }

  const result = parsePayload(data);
  mapPerf.recordQuery(performance.now() - startedAt, {
    markers: result.cells.length,
    housesInView: result.housesInView,
    scanCapped: result.scanCapped,
  });
  return result;
};

const EMPTY_RESULT: EmptyHouseMapCells = { cells: [], housesInView: 0, scanCapped: false, cellSize: 0 };

export interface EmptyHouseMapCellsQuery {
  data: EmptyHouseMapCells | undefined;
  isFetching: boolean;
  isError: boolean;
  refetch: () => void;
}

export function useEmptyHouseMapCells(
  viewport: MapViewport | null,
  filters: MapCellFilters = {},
  enabled = true,
): EmptyHouseMapCellsQuery {
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

  const tiles = useMemo(() => (key && step > 0 ? buildTiles(key, step) : []), [key, step]);
  const tilesSignature = tiles.map((tile) => JSON.stringify(tile.key)).join('|');
  // Stable tile list across renders: rebuild only when the quantized keys change.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const stableTiles = useMemo(() => tiles, [tilesSignature]);

  const tileQueries = useQueries({
    queries: stableTiles.map((tile) => ({
      queryKey: ['empty-house-map-cells', tile.key, filters] as const,
      enabled: enabled && !!viewport,
      // A tile that was on screen a moment ago stays visible while its
      // replacement loads, so panning never blanks the map.
      placeholderData: (previous: EmptyHouseMapCells | undefined) => previous,
      staleTime: 60 * 1000,
      gcTime: 10 * 60 * 1000,
      refetchOnWindowFocus: false,
      // A flaky mobile network is the norm in the field: retry with backoff, and
      // only surface a failure once the retries are exhausted.
      retry: 2,
      retryDelay: (attempt: number) => Math.min(4000, 600 * 2 ** attempt),
      queryFn: ({ signal }: { signal?: AbortSignal }) =>
        fetchTile(tile, tile.key.zoom, filters, signal),
    })),
  });

  /**
   * Progressive merge: as each tile resolves its cells join the map, so the
   * funder sees houses arrive one area at a time instead of waiting for the
   * slowest part of the view. A failed tile leaves the rest of the map intact.
   */
  const data = useMemo<EmptyHouseMapCells>(() => {
    if (stableTiles.length === 0) return EMPTY_RESULT;
    const byKey = new Map<string, EmptyHouseMapCell>();
    let housesInView = 0;
    let scanCapped = false;
    let cellSize = 0;
    for (const query of tileQueries as UseQueryResult<EmptyHouseMapCells>[]) {
      const tileData = query.data;
      if (!tileData) continue;
      housesInView += tileData.housesInView;
      scanCapped = scanCapped || tileData.scanCapped;
      if (!cellSize && tileData.cellSize) cellSize = tileData.cellSize;
      for (const cell of tileData.cells) {
        if (!byKey.has(cell.key)) byKey.set(cell.key, cell);
      }
    }
    let cells = [...byKey.values()];
    // The 400-cell render budget still holds for the merged view: under cap
    // pressure the cells nearest the middle of the screen win.
    if (cells.length > SERVER_CELL_LIMIT && viewport) {
      const midLat = (viewport.minLat + viewport.maxLat) / 2;
      const midLng = (viewport.minLng + viewport.maxLng) / 2;
      cells = cells
        .map((cell, index) => ({
          cell,
          index,
          distance: (cell.latitude - midLat) ** 2 + (cell.longitude - midLng) ** 2,
        }))
        .sort((a, b) => a.distance - b.distance || a.index - b.index)
        .slice(0, SERVER_CELL_LIMIT)
        .sort((a, b) => a.index - b.index)
        .map((entry) => entry.cell);
    }
    return { cells, housesInView, scanCapped, cellSize };
    // tileQueries is a fresh array each render; the merge is cheap and keyed on
    // the underlying per-tile data.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stableTiles, viewport, ...tileQueries.map((query) => (query as UseQueryResult<EmptyHouseMapCells>).data)]);

  const hasData = stableTiles.length > 0 && tileQueries.some((query) => query.data);
  return {
    data: hasData || stableTiles.length === 0 ? data : undefined,
    isFetching: tileQueries.some((query) => query.isFetching),
    // Only call the whole view failed when every tile failed — one bad tile
    // must never blank the houses that did load.
    isError: stableTiles.length > 0 && tileQueries.every((query) => query.isError),
    refetch: () => {
      for (const query of tileQueries) void query.refetch();
    },
  };
}
