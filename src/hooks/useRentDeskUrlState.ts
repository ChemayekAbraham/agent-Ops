import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  DEFAULT_RENT_DESK_SORT,
  NO_RENT_DESK_FILTERS,
  isRentDeskFiltered,
  normalizeRentDeskFilters,
  readRentDeskUrl,
  writeRentDeskUrl,
  type RentDeskFilters,
  type RentDeskSort,
} from '@/lib/rentDeskFilters';

/**
 * The selected sort and filters of a rent-request desk, kept in the URL (`desk_sort`, `desk_labels`, `desk_arrived`,
 * `desk_from`, `desk_to`) so a view can be shared, reloaded and reached with the back button. Changes replace the current
 * history entry and leave every other URL parameter alone. Pass `extraSorts` for a desk that has sorts of its own.
 */
export function useRentDeskUrlState<S extends string = never>(extraSorts: readonly S[] = []) {
  const [params, setParams] = useSearchParams();
  const extraKey = extraSorts.join('|');

  const state = useMemo(
    () => readRentDeskUrl<S>(params, extraSorts),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [params, extraKey],
  );

  const update = useCallback(
    (patch: Partial<{ sort: RentDeskSort | S; filters: RentDeskFilters }>) => {
      setParams(
        (prev) => {
          const cur = readRentDeskUrl<S>(prev, extraSorts);
          return writeRentDeskUrl(prev, {
            sort: patch.sort ?? cur.sort,
            filters: patch.filters ? normalizeRentDeskFilters(patch.filters) : cur.filters,
          });
        },
        { replace: true },
      );
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [setParams, extraKey],
  );

  const setSort = useCallback((sort: RentDeskSort | S) => update({ sort }), [update]);
  const setFilters = useCallback((filters: RentDeskFilters) => update({ filters }), [update]);
  const clearFilters = useCallback(() => update({ filters: NO_RENT_DESK_FILTERS }), [update]);

  return {
    sort: state.sort,
    filters: state.filters,
    isFiltered: isRentDeskFiltered(state.filters),
    isDefaultSort: state.sort === DEFAULT_RENT_DESK_SORT,
    setSort,
    setFilters,
    clearFilters,
  };
}
