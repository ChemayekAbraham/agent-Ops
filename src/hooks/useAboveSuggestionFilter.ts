import { useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';

const PARAM = 'above_suggestion';

/**
 * "Only renewals above the suggestion", kept in the URL (`?above_suggestion=1`) like the other desk filters. It narrows a list by the
 * flag the server stored on the request (`renewal_above_suggestion`); nothing is worked out in the browser.
 */
export function useAboveSuggestionFilter() {
  const [params, setParams] = useSearchParams();
  const only = params.get(PARAM) === '1';
  const setOnly = useCallback(
    (on: boolean) => {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (on) next.set(PARAM, '1'); else next.delete(PARAM);
          return next;
        },
        { replace: true },
      );
    },
    [setParams],
  );
  return { only, setOnly };
}
