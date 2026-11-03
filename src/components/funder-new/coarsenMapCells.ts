import type { FunderNewMapCell } from './FunderNewRouteMap';

/**
 * Below street level the server's cells sit about half a price pill apart, so
 * the pills pile on top of each other (hundreds of overlapping pins at city
 * zoom). This merges neighbouring cells into a grid about one pill wide, which
 * cuts the pin count several-fold where it is densest.
 *
 * The server grid is 360 / 2^(zoom + 3) degrees; this one is 360 / 2^(zoom + 2),
 * exactly twice as coarse and aligned to the same origin, so a server cell never
 * straddles two merged cells. At street level (zoom 15 and up) the cells are
 * left alone so single houses stay individually tappable.
 */
export const COARSEN_BELOW_ZOOM = 15;

export function coarsenMapCells(cells: FunderNewMapCell[], zoom: number): FunderNewMapCell[] {
  if (zoom >= COARSEN_BELOW_ZOOM || cells.length < 2) return cells;
  const pitch = 360 / 2 ** (Math.round(zoom) + 2);

  const buckets = new Map<
    string,
    { count: number; latSum: number; lngSum: number; amount: number; only: FunderNewMapCell; members: number }
  >();

  for (const cell of cells) {
    const key = `m:${Math.floor(cell.lng / pitch)}:${Math.floor(cell.lat / pitch)}`;
    const weight = Math.max(1, cell.count);
    const bucket = buckets.get(key);
    if (!bucket) {
      buckets.set(key, {
        count: cell.count,
        latSum: cell.lat * weight,
        lngSum: cell.lng * weight,
        amount: cell.amount,
        only: cell,
        members: 1,
      });
      continue;
    }
    bucket.count += cell.count;
    bucket.latSum += cell.lat * weight;
    bucket.lngSum += cell.lng * weight;
    // The pill shows the lowest rent in the area; ignore cells with no rent.
    if (cell.amount > 0 && (bucket.amount <= 0 || cell.amount < bucket.amount)) bucket.amount = cell.amount;
    bucket.members += 1;
  }

  const merged: FunderNewMapCell[] = [];
  for (const [key, bucket] of buckets) {
    // A bucket holding one untouched cell is returned as it came from the server.
    if (bucket.members === 1) {
      merged.push(bucket.only);
      continue;
    }
    const weight = Math.max(1, bucket.count);
    merged.push({
      key,
      count: bucket.count,
      lat: bucket.latSum / weight,
      lng: bucket.lngSum / weight,
      amount: bucket.amount,
      house: bucket.count === 1 ? bucket.only.house : null,
    });
  }
  return merged;
}
