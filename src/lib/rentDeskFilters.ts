/**
 * Filters and sort for the rent-request desks (RentPipelineQueue, the Service Center vetting queue, the Tenant Ops pipeline
 * hub), and how they live in the URL. Pure: no React, no network. The database evaluates the filters
 * (`rent_request_desk_order`) and returns each request's `matches` flag and the count; this file only describes the choices,
 * reads and writes them in the URL, and builds the RPC arguments. It never decides whether a request matches.
 *
 *   ?desk_sort=best_payers|newest|oldest   (a desk may add its own extra sorts)
 *   &desk_labels=proven_good,watch         (any of the four paying labels)
 *   &desk_arrived=today|7d|custom
 *   &desk_from=2026-10-01&desk_to=2026-10-14   (custom range, Kampala days, either end may be left open)
 *
 * Defaults (best payers first, no filters) are left out of the URL, and parameters the desks do not own are never touched.
 */

export type RentDeskSort = 'best_payers' | 'newest' | 'oldest';
export const RENT_DESK_SORTS: readonly RentDeskSort[] = ['best_payers', 'newest', 'oldest'];
export const DEFAULT_RENT_DESK_SORT: RentDeskSort = 'best_payers';

export const RENT_DESK_SORT_LABELS: Record<RentDeskSort, string> = {
  best_payers: 'Best payers first',
  newest: 'Newest first',
  oldest: 'Oldest first',
};

export type RentDeskLabel = 'proven_good' | 'good_agent_pick' | 'average' | 'watch';
export const RENT_DESK_LABELS: readonly RentDeskLabel[] = ['proven_good', 'good_agent_pick', 'average', 'watch'];

export const RENT_DESK_LABEL_TEXT: Record<RentDeskLabel, string> = {
  proven_good: 'Proven good',
  good_agent_pick: 'Good agent pick',
  average: 'Average',
  watch: 'Watch',
};

export type RentDeskArrived = 'any' | 'today' | '7d' | 'custom';
export const RENT_DESK_ARRIVED: readonly RentDeskArrived[] = ['any', 'today', '7d', 'custom'];

export const RENT_DESK_ARRIVED_TEXT: Record<RentDeskArrived, string> = {
  any: 'Any time',
  today: 'Today',
  '7d': 'Last 7 days',
  custom: 'Custom range',
};

export interface RentDeskFilters {
  labels: RentDeskLabel[];
  arrived: RentDeskArrived;
  /** Custom range ends as YYYY-MM-DD (Kampala days). Only used when `arrived` is 'custom'. */
  from: string | null;
  to: string | null;
}

export const NO_RENT_DESK_FILTERS: RentDeskFilters = { labels: [], arrived: 'any', from: null, to: null };

export const RENT_DESK_PARAM = {
  sort: 'desk_sort',
  labels: 'desk_labels',
  arrived: 'desk_arrived',
  from: 'desk_from',
  to: 'desk_to',
} as const;

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** A real calendar day, as YYYY-MM-DD, or null. */
export function cleanRentDeskDay(raw: string | null | undefined): string | null {
  if (!raw || !DAY.test(raw)) return null;
  const d = new Date(`${raw}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== raw ? null : raw;
}

export const isRentDeskSort = (v: unknown): v is RentDeskSort => RENT_DESK_SORTS.includes(v as RentDeskSort);

/** Tidies a filter set: known labels once each in a fixed order, a valid arrival, real days, and from never after to. */
export function normalizeRentDeskFilters(f: Partial<RentDeskFilters> | null | undefined): RentDeskFilters {
  const labels = RENT_DESK_LABELS.filter((l) => (f?.labels ?? []).includes(l));
  const arrived = RENT_DESK_ARRIVED.includes(f?.arrived as RentDeskArrived) ? (f!.arrived as RentDeskArrived) : 'any';
  if (arrived !== 'custom') return { labels: [...labels], arrived, from: null, to: null };
  let from = cleanRentDeskDay(f?.from);
  let to = cleanRentDeskDay(f?.to);
  if (from && to && from > to) [from, to] = [to, from];
  return { labels: [...labels], arrived, from, to };
}

/** True when the filters would narrow the desk. A custom range with no day chosen yet narrows nothing. */
export function isRentDeskFiltered(f: RentDeskFilters): boolean {
  return f.labels.length > 0 || f.arrived === 'today' || f.arrived === '7d' || (f.arrived === 'custom' && !!(f.from || f.to));
}

/** The RPC arguments for a filter set. A custom range with no day chosen is sent as no date filter. */
export function rentDeskFilterArgs(f: RentDeskFilters): {
  p_labels: RentDeskLabel[] | null;
  p_arrived: RentDeskArrived | null;
  p_from: string | null;
  p_to: string | null;
} {
  const n = normalizeRentDeskFilters(f);
  const dated = n.arrived === 'today' || n.arrived === '7d' || (n.arrived === 'custom' && !!(n.from || n.to));
  return {
    p_labels: n.labels.length ? n.labels : null,
    p_arrived: dated ? n.arrived : null,
    p_from: dated && n.arrived === 'custom' ? n.from : null,
    p_to: dated && n.arrived === 'custom' ? n.to : null,
  };
}

export interface RentDeskUrlState<S extends string = RentDeskSort> {
  sort: S | RentDeskSort;
  filters: RentDeskFilters;
}

/** Reads the desk state from URL parameters. Anything unknown or malformed falls back to the default. */
export function readRentDeskUrl<S extends string = never>(
  params: URLSearchParams,
  extraSorts: readonly S[] = [],
): RentDeskUrlState<S> {
  const rawSort = params.get(RENT_DESK_PARAM.sort);
  const sort = isRentDeskSort(rawSort) || (extraSorts as readonly string[]).includes(rawSort ?? '')
    ? (rawSort as RentDeskSort | S)
    : DEFAULT_RENT_DESK_SORT;
  const labels = (params.get(RENT_DESK_PARAM.labels) ?? '').split(',').filter(Boolean) as RentDeskLabel[];
  const filters = normalizeRentDeskFilters({
    labels,
    arrived: (params.get(RENT_DESK_PARAM.arrived) ?? 'any') as RentDeskArrived,
    from: params.get(RENT_DESK_PARAM.from),
    to: params.get(RENT_DESK_PARAM.to),
  });
  return { sort, filters };
}

/** Writes the desk state into a copy of the URL parameters, leaving every other parameter alone and omitting defaults. */
export function writeRentDeskUrl(params: URLSearchParams, state: RentDeskUrlState<string>): URLSearchParams {
  const next = new URLSearchParams(params);
  Object.values(RENT_DESK_PARAM).forEach((k) => next.delete(k));
  if (state.sort !== DEFAULT_RENT_DESK_SORT) next.set(RENT_DESK_PARAM.sort, state.sort);
  const f = normalizeRentDeskFilters(state.filters);
  if (f.labels.length) next.set(RENT_DESK_PARAM.labels, f.labels.join(','));
  if (f.arrived !== 'any') next.set(RENT_DESK_PARAM.arrived, f.arrived);
  if (f.arrived === 'custom') {
    if (f.from) next.set(RENT_DESK_PARAM.from, f.from);
    if (f.to) next.set(RENT_DESK_PARAM.to, f.to);
  }
  return next;
}
