import { useEffect, useMemo } from 'react';
import { useQueries, useQuery, type UseQueryResult } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { isUnauthenticatedRpcError, requireUserSession, useAuthenticatedAudience } from '@/hooks/useAuthenticatedPoll';
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
  limit: number = SERVER_CELL_LIMIT,
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
    p_limit: limit,
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

/** Half-width of the "closest to the user" box, in degrees (about 1.5 km). */
export const NEAR_BOX_DEGREES = 0.0135;
/** The near box asks for far fewer cells than a full tile, so it comes back fast. */
export const NEAR_CELL_LIMIT = 80;
/** Snap the user's position so GPS jitter never changes the query key. */
const NEAR_SNAP_DEGREES = 0.005;

export interface MapNearPoint {
  lat: number;
  lng: number;
}

/** The near box around a position, or null when that position is not in the viewport. */
export function nearBoxFor(point: MapNearPoint | null | undefined, viewport: MapViewport | null) {
  if (!point || !viewport) return null;
  if (
    point.lat < viewport.minLat || point.lat > viewport.maxLat ||
    point.lng < viewport.minLng || point.lng > viewport.maxLng
  ) {
    return null; // the person panned away: the full tiles are all that matter
  }
  const lat = Math.round(point.lat / NEAR_SNAP_DEGREES) * NEAR_SNAP_DEGREES;
  const lng = Math.round(point.lng / NEAR_SNAP_DEGREES) * NEAR_SNAP_DEGREES;
  return {
    minLat: Math.max(lat - NEAR_BOX_DEGREES, viewport.minLat),
    maxLat: Math.min(lat + NEAR_BOX_DEGREES, viewport.maxLat),
    minLng: Math.max(lng - NEAR_BOX_DEGREES, viewport.minLng),
    maxLng: Math.min(lng + NEAR_BOX_DEGREES, viewport.maxLng),
  };
}

/**
 * Merges the per-tile results with the early "near the user" result.
 *
 * Tile cells always win: a cell on the edge of the near box is built from only
 * the houses inside that box, so its count can be partial. The near cells just
 * fill in whatever the tiles have not delivered yet, which is what makes the
 * closest houses appear first. Counts are never added together twice: the
 * homes-in-view figure comes from the tiles, and only falls back to the near
 * result while no tile has arrived.
 */
export function mergeTileResults(
  tileResults: Array<EmptyHouseMapCells | undefined>,
  near: EmptyHouseMapCells | undefined,
  viewport: MapViewport | null,
  cellLimit: number = SERVER_CELL_LIMIT,
): EmptyHouseMapCells {
  const byKey = new Map<string, EmptyHouseMapCell>();
  let housesInView = 0;
  let scanCapped = false;
  let cellSize = 0;
  let haveTile = false;
  for (const tileData of tileResults) {
    if (!tileData) continue;
    haveTile = true;
    housesInView += tileData.housesInView;
    scanCapped = scanCapped || tileData.scanCapped;
    if (!cellSize && tileData.cellSize) cellSize = tileData.cellSize;
    for (const cell of tileData.cells) {
      if (!byKey.has(cell.key)) byKey.set(cell.key, cell);
    }
  }
  if (near) {
    for (const cell of near.cells) {
      if (!byKey.has(cell.key)) byKey.set(cell.key, cell);
    }
    if (!haveTile) {
      housesInView = near.housesInView;
      scanCapped = near.scanCapped;
      cellSize = near.cellSize;
    }
  }
  let cells = [...byKey.values()];
  // The render budget still holds for the merged view: under cap pressure the
  // cells nearest the middle of the screen win.
  if (cells.length > cellLimit && viewport) {
    const midLat = (viewport.minLat + viewport.maxLat) / 2;
    const midLng = (viewport.minLng + viewport.maxLng) / 2;
    cells = cells
      .map((cell, index) => ({
        cell,
        index,
        distance: (cell.latitude - midLat) ** 2 + (cell.longitude - midLng) ** 2,
      }))
      .sort((a, b) => a.distance - b.distance || a.index - b.index)
      .slice(0, cellLimit)
      .sort((a, b) => a.index - b.index)
      .map((entry) => entry.cell);
  }
  return { cells, housesInView, scanCapped, cellSize };
}

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
  /** The user's position: houses right around it are fetched first, in a small fast request. */
  nearPoint: MapNearPoint | null = null,
): EmptyHouseMapCellsQuery {
  const signedIn = useAuthenticatedAudience();
  const canQuery = enabled && signedIn;
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
    if (!viewportKey || !canQuery) return;
    mapPerf.noteViewportKey(viewportKey);
  }, [viewportKey, canQuery]);

  const tiles = useMemo(() => (key && step > 0 ? buildTiles(key, step) : []), [key, step]);
  const tilesSignature = tiles.map((tile) => JSON.stringify(tile.key)).join('|');
  // Stable tile list across renders: rebuild only when the quantized keys change.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const stableTiles = useMemo(() => tiles, [tilesSignature]);

  const tileQueries = useQueries({
    queries: stableTiles.map((tile) => ({
      queryKey: ['empty-house-map-cells', tile.key, filters] as const,
      enabled: canQuery && !!viewport,
      // A tile that was on screen a moment ago stays visible while its
      // replacement loads, so panning never blanks the map.
      placeholderData: (previous: EmptyHouseMapCells | undefined) => previous,
      staleTime: 60 * 1000,
      gcTime: 10 * 60 * 1000,
      refetchOnWindowFocus: false,
      // A flaky mobile network is the norm in the field: retry with backoff, and
      // only surface a failure once the retries are exhausted. A missing user
      // JWT is not retried — that call would be anonymous and log 42501.
      retry: (failureCount: number, error: unknown) => failureCount < 2 && !isUnauthenticatedRpcError(error),
      retryDelay: (attempt: number) => Math.min(4000, 600 * 2 ** attempt),
      queryFn: async ({ signal }: { signal?: AbortSignal }) => {
        await requireUserSession();
        return fetchTile(tile, tile.key.zoom, filters, signal);
      },
    })),
  });

  // The houses around the user, fetched alongside the full tiles as one small
  // request (about 1.5 km, at most 80 cells) so they can be on the map after a
  // single round trip instead of waiting for the full viewport.
  const nearBox = useMemo(() => nearBoxFor(nearPoint, viewport), [nearPoint?.lat, nearPoint?.lng, viewport]);
  const nearKey = nearBox
    ? {
        minLat: quantize(nearBox.minLat, step),
        minLng: quantize(nearBox.minLng, step),
        maxLat: quantize(nearBox.maxLat, step),
        maxLng: quantize(nearBox.maxLng, step),
        zoom: viewport ? viewport.zoom : 0,
      }
    : null;
  const nearQuery = useQuery<EmptyHouseMapCells>({
    queryKey: ['empty-house-map-cells-near', nearKey, filters] as const,
    enabled: canQuery && !!nearKey,
    staleTime: 60 * 1000,
    gcTime: 10 * 60 * 1000,
    refetchOnWindowFocus: false,
    retry: (failureCount: number, error: unknown) => failureCount < 1 && !isUnauthenticatedRpcError(error),
    queryFn: async ({ signal }) => {
      await requireUserSession();
      const key = nearKey!;
      return fetchTile({ key, bounds: key }, key.zoom, filters, signal, NEAR_CELL_LIMIT);
    },
  });

  /**
   * Progressive merge: as each tile resolves its cells join the map, so the
   * funder sees houses arrive one area at a time instead of waiting for the
   * slowest part of the view. A failed tile leaves the rest of the map intact.
   * The near-the-user result lands first and is superseded tile by tile.
   */
  const data = useMemo<EmptyHouseMapCells>(() => {
    if (stableTiles.length === 0) return EMPTY_RESULT;
    return mergeTileResults(
      (tileQueries as UseQueryResult<EmptyHouseMapCells>[]).map((query) => query.data),
      nearKey ? nearQuery.data : undefined,
      viewport,
    );
    // tileQueries is a fresh array each render; the merge is cheap and keyed on
    // the underlying per-tile data.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stableTiles, viewport, nearKey ? nearQuery.data : undefined, ...tileQueries.map((query) => (query as UseQueryResult<EmptyHouseMapCells>).data)]);

  const hasData = stableTiles.length > 0 && (tileQueries.some((query) => query.data) || (!!nearKey && !!nearQuery.data));
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
