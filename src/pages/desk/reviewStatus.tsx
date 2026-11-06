import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

/**
 * What happened to a request after its review was submitted, kept for as long
 * as the desk stays open.
 *
 * `pipeline_record_review` and the move that follows it are two calls, and only
 * the first is atomic. When the review is in but the move failed, the row has
 * to say so — the reviewer must not record a second review, they must retry the
 * move — so that state lives here, above the drawer, and the table reads it.
 */

export type ReviewState =
  | { kind: 'moved'; message: string }
  | { kind: 'move_failed'; message: string; decision: string };

/**
 * Keyed by the 8-character code the desk tables print, not the request id, so
 * a row can show its state without first resolving the code.
 */
type Ctx = {
  byShort: Record<string, ReviewState>;
  mark: (requestId: string, state: ReviewState) => void;
  clear: (requestId: string) => void;
};

/** Both the drawer and the COO batch hold full ids; the table holds codes. */
export const shortOf = (requestId: string) => requestId.slice(0, 8).toLowerCase();

const ReviewStatusCtx = createContext<Ctx | null>(null);

export function ReviewStatusProvider({ children }: { children: ReactNode }) {
  const [byShort, setByShort] = useState<Record<string, ReviewState>>({});

  const mark = useCallback((requestId: string, state: ReviewState) => {
    setByShort((prev) => ({ ...prev, [shortOf(requestId)]: state }));
  }, []);
  const clear = useCallback((requestId: string) => {
    const key = shortOf(requestId);
    setByShort((prev) => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }, []);

  const value = useMemo<Ctx>(() => ({ byShort, mark, clear }), [byShort, mark, clear]);
  return <ReviewStatusCtx.Provider value={value}>{children}</ReviewStatusCtx.Provider>;
}

/** Safe outside the provider: the desks that have no review drawer still render. */
export function useReviewStatus(): Ctx {
  return useContext(ReviewStatusCtx) ?? { byShort: {}, mark: () => {}, clear: () => {} };
}

export const RETRY_LABEL = 'Review recorded — move failed, retry';
