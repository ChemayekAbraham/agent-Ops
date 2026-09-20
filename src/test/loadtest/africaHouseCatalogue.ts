/**
 * Synthetic Africa-wide empty-house catalogue used by the map load tests.
 *
 * It models more than 10,000,000 listings spread across the continent without
 * ever materialising them: houses are derived deterministically from their grid
 * cell, so a viewport query only walks the cells it actually covers. The
 * aggregation mirrors the `map_empty_house_cells` SQL function (grid pitch,
 * 20,000-row scan cap, 400-cell result cap) so the tests exercise the same
 * bounded contract the database provides.
 */

export const AFRICA_BOUNDS = {
  minLat: -35,
  maxLat: 37,
  minLng: -18,
  maxLng: 52,
} as const;

/** Settlement grid resolution in degrees. */
const GRID = 0.05;
const COLS = Math.round((AFRICA_BOUNDS.maxLng - AFRICA_BOUNDS.minLng) / GRID);
const ROWS = Math.round((AFRICA_BOUNDS.maxLat - AFRICA_BOUNDS.minLat) / GRID);

/** Mirrors the server scan cap in `map_empty_house_cells`. */
export const SERVER_SCAN_CAP = 20_000;
/** Mirrors the server result cap requested by the hook. */
export const SERVER_CELL_LIMIT = 400;

const hash = (a: number, b: number, salt: number) => {
  let h = (a * 374761393 + b * 668265263 + salt * 2246822519) >>> 0;
  h = (h ^ (h >>> 13)) >>> 0;
  h = (h * 1274126177) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
};

const unit = (a: number, b: number, salt: number) => hash(a, b, salt) / 4294967296;

/** Houses in a settlement cell: 0-10, averaging ~5 across the continent. */
const densityAt = (col: number, row: number) => hash(col, row, 7) % 11;

const DISTRICTS = [
  'Kampala',
  'Wakiso',
  'Mukono',
  'Nairobi',
  'Lagos',
  'Accra',
  'Dar es Salaam',
  'Kigali',
  'Addis Ababa',
  'Abidjan',
];

const RENTS = [150_000, 250_000, 350_000, 450_000, 600_000, 800_000, 1_200_000, 2_000_000];

export interface SyntheticHouse {
  house_id: string;
  title: string;
  house_category: string;
  district: string;
  sub_county: string;
  village: string;
  monthly_rent: number;
  latitude: number;
  longitude: number;
  verified: boolean;
  image_urls: string[];
  created_at: string;
}

const houseAt = (col: number, row: number, index: number): SyntheticHouse => {
  const lng = AFRICA_BOUNDS.minLng + (col + unit(col, row, index * 31 + 1)) * GRID;
  const lat = AFRICA_BOUNDS.minLat + (row + unit(col, row, index * 31 + 2)) * GRID;
  const district = DISTRICTS[hash(col, row, index * 31 + 3) % DISTRICTS.length];
  const rent = RENTS[hash(col, row, index * 31 + 4) % RENTS.length];
  return {
    house_id: `synthetic-${col}-${row}-${index}`,
    title: `${district} empty house ${col}-${row}-${index}`,
    house_category: 'single_room',
    district,
    sub_county: `${district} sub-county ${row % 12}`,
    village: `${district} village ${col % 20}`,
    monthly_rent: rent,
    latitude: lat,
    longitude: lng,
    verified: hash(col, row, index * 31 + 5) % 3 === 0,
    image_urls: [`https://example.test/houses/${col}-${row}-${index}.webp`],
    created_at: new Date(1_700_000_000_000 + hash(col, row, index) % 5_000_000_000).toISOString(),
  };
};

/** Exact size of the simulated catalogue (walks the grid, never the houses). */
export const catalogueSize = (() => {
  let cached: number | null = null;
  return () => {
    if (cached != null) return cached;
    let total = 0;
    for (let col = 0; col < COLS; col += 1) {
      for (let row = 0; row < ROWS; row += 1) total += densityAt(col, row);
    }
    cached = total;
    return total;
  };
})();

export interface CatalogueQuery {
  minLat: number;
  minLng: number;
  maxLat: number;
  maxLng: number;
  zoom: number;
  search?: string | null;
  district?: string | null;
  minRent?: number | null;
  maxRent?: number | null;
  limit?: number;
}

export interface RawCellPayload {
  key: string;
  count: number;
  latitude: number;
  longitude: number;
  min_rent: number;
  max_rent: number;
  house: SyntheticHouse | null;
}

export interface CataloguePayload {
  cells: RawCellPayload[];
  zoom: number;
  cell_size: number;
  scanned: number;
  scan_capped: boolean;
}

/** Cell pitch used by `map_empty_house_cells`. */
export const cellSizeForZoom = (zoom: number) =>
  360 / Math.pow(2, Math.min(Math.max(Math.round(zoom), 1), 20) + 3);

const matches = (house: SyntheticHouse, q: CatalogueQuery) => {
  if (q.minRent != null && house.monthly_rent < q.minRent) return false;
  if (q.maxRent != null && house.monthly_rent > q.maxRent) return false;
  if (q.district && house.district.toLowerCase() !== q.district.toLowerCase()) return false;
  if (q.search) {
    const needle = q.search.toLowerCase();
    const haystack = `${house.title} ${house.district} ${house.sub_county} ${house.village}`.toLowerCase();
    if (!haystack.includes(needle)) return false;
  }
  return true;
};

/**
 * Bounded viewport aggregation, mirroring the database function: scans at most
 * SERVER_SCAN_CAP matching houses and returns at most `limit` grid cells.
 */
export const queryCatalogue = (q: CatalogueQuery): CataloguePayload => {
  const limit = q.limit ?? SERVER_CELL_LIMIT;
  const size = cellSizeForZoom(q.zoom);

  const colStart = Math.max(0, Math.floor((q.minLng - AFRICA_BOUNDS.minLng) / GRID));
  const colEnd = Math.min(COLS - 1, Math.ceil((q.maxLng - AFRICA_BOUNDS.minLng) / GRID));
  const rowStart = Math.max(0, Math.floor((q.minLat - AFRICA_BOUNDS.minLat) / GRID));
  const rowEnd = Math.min(ROWS - 1, Math.ceil((q.maxLat - AFRICA_BOUNDS.minLat) / GRID));

  const buckets = new Map<
    string,
    { count: number; latSum: number; lngSum: number; minRent: number; maxRent: number; house: SyntheticHouse | null }
  >();
  let scanned = 0;

  outer: for (let col = colStart; col <= colEnd; col += 1) {
    for (let row = rowStart; row <= rowEnd; row += 1) {
      const density = densityAt(col, row);
      for (let i = 0; i < density; i += 1) {
        const house = houseAt(col, row, i);
        if (house.latitude < q.minLat || house.latitude > q.maxLat) continue;
        if (house.longitude < q.minLng || house.longitude > q.maxLng) continue;
        if (!matches(house, q)) continue;

        scanned += 1;
        const cellCol = Math.floor(house.longitude / size);
        const cellRow = Math.floor(house.latitude / size);
        const key = `${cellCol}:${cellRow}`;
        const bucket = buckets.get(key);
        if (bucket) {
          bucket.count += 1;
          bucket.latSum += house.latitude;
          bucket.lngSum += house.longitude;
          bucket.minRent = Math.min(bucket.minRent, house.monthly_rent);
          bucket.maxRent = Math.max(bucket.maxRent, house.monthly_rent);
          bucket.house = null;
        } else {
          buckets.set(key, {
            count: 1,
            latSum: house.latitude,
            lngSum: house.longitude,
            minRent: house.monthly_rent,
            maxRent: house.monthly_rent,
            house,
          });
        }
        if (scanned >= SERVER_SCAN_CAP) break outer;
      }
    }
  }

  const cells: RawCellPayload[] = [...buckets.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, limit)
    .map(([key, b]) => ({
      key,
      count: b.count,
      latitude: b.latSum / b.count,
      longitude: b.lngSum / b.count,
      min_rent: b.minRent,
      max_rent: b.maxRent,
      house: b.count === 1 ? b.house : null,
    }));

  return {
    cells,
    zoom: Math.round(q.zoom),
    cell_size: size,
    scanned,
    scan_capped: scanned >= SERVER_SCAN_CAP,
  };
};
