import { supabase } from '@/integrations/supabase/client';

/**
 * Shared access to get_statement_of_financial_position for every screen in the browser.
 *
 * The statement rebuilds the balance sheet from the whole ledger (about 15 s and 1 GB of temp disk on the server per
 * run). The CFO Overview cash cards and the Balance Sheet both need it; calling it separately ran it two or three
 * times at once and pushed each run past the request time limit. Here one request per as-at key is shared by every
 * caller, and a finished result is reused for a few minutes. The figures are exactly what the server returned —
 * nothing is recomputed in the browser.
 *
 * Key: 'now' for the live statement (no p_as_at; the server uses now()), or the ISO timestamp passed as p_as_at.
 */

/** Same freshness window the Balance Sheet snapshot and the Overview cards already use. */
export const SOFP_CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * The server functions run with statement_timeout = 120 s. If nothing has come back shortly after that, the
 * connection is dead (usually a gateway timeout), so stop waiting.
 */
export const SOFP_CLIENT_TIMEOUT_MS = 130_000;

/** Error code of a request this module abandoned after SOFP_CLIENT_TIMEOUT_MS. */
export const SOFP_CLIENT_TIMEOUT_CODE = 'SOFP_CLIENT_TIMEOUT';

export interface SofpResult<T> {
  data: T;
  /** When the server result was received (ms since epoch). */
  fetchedAt: number;
}

type Entry = { promise: Promise<SofpResult<unknown>>; settledAt: number | null };

const entries = new Map<string, Entry>();

export interface FetchSofpOptions {
  /** ISO timestamp for a past statement; omit for the live statement. */
  asAtIso?: string | null;
  /** Ignore a cached result (the user pressed Refresh). An in-flight request is still shared. */
  force?: boolean;
}

/** Error carrying the PostgREST code (e.g. '57014' statement timeout) so callers can decide on retries. */
export type SofpError = Error & { code?: string };

export function fetchStatementOfFinancialPosition<T = unknown>(opts: FetchSofpOptions = {}): Promise<SofpResult<T>> {
  const key = opts.asAtIso ? opts.asAtIso : 'now';
  const existing = entries.get(key);
  if (existing) {
    const inFlight = existing.settledAt === null;
    const fresh = existing.settledAt !== null && Date.now() - existing.settledAt < SOFP_CACHE_TTL_MS;
    if (inFlight || (fresh && !opts.force)) return existing.promise as Promise<SofpResult<T>>;
  }

  const params = opts.asAtIso ? { p_as_at: opts.asAtIso } : {};
  const entry: Entry = { promise: Promise.resolve() as unknown as Promise<SofpResult<unknown>>, settledAt: null };
  entry.promise = (async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(Object.assign(new Error('Balance sheet request timed out'), { code: SOFP_CLIENT_TIMEOUT_CODE })),
          SOFP_CLIENT_TIMEOUT_MS,
        );
      });
      const rpc = (supabase.rpc as unknown as (fn: string, args: Record<string, unknown>) =>
        Promise<{ data: unknown; error: { message: string; code?: string } | null }>)
        .call(supabase, 'get_statement_of_financial_position', params);
      const { data, error } = await Promise.race([rpc, timeout]);
      if (error) throw Object.assign(new Error(error.message), { code: error.code }) as SofpError;
      if (!data) throw new Error('The server returned an empty balance sheet');
      entry.settledAt = Date.now();
      return { data, fetchedAt: entry.settledAt };
    } catch (e) {
      // Never cache a failure: the next caller tries again.
      if (entries.get(key) === entry) entries.delete(key);
      throw e;
    } finally {
      if (timer) clearTimeout(timer);
    }
  })();
  entries.set(key, entry);
  return entry.promise as Promise<SofpResult<T>>;
}

/** Test helper: forget every cached and in-flight statement. */
export function resetSofpRequestCache(): void {
  entries.clear();
}
