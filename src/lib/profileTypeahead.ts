import { supabase } from '@/integrations/supabase/client';

/**
 * Profile typeahead.
 *
 * A PostgREST `.or(full_name.ilike, phone.ilike, email.ilike)` on ~97k profiles
 * cannot use one trigram index, and a 1–2 character `%x%` cannot use trigram
 * at all. Under the authenticated 8s statement_timeout those plans show up as
 * `profiles` ILIKE timeouts. `search_users_fast` already does the indexed
 * path (prefix, one trigram, phone last-9) with a hard cap. Callers that are
 * not allowed to use it fall back to a single column, never a multi-column OR.
 */

export const PROFILE_TYPEAHEAD_MIN_CHARS = 3;
export const PROFILE_TYPEAHEAD_DEBOUNCE_MS = 300;
export const PROFILE_TYPEAHEAD_LIMIT = 20;

const PHONE_MIN_DIGITS = 6;
const RPC_COLUMNS = new Set(['id', 'full_name', 'phone', 'email', 'national_id', 'verified']);

export type ProfileSearchRow = {
  id: string;
  full_name: string | null;
  phone: string | null;
  email?: string | null;
  national_id?: string | null;
  verified?: boolean | null;
  mobile_money_number?: string | null;
  avatar_url?: string | null;
  created_at?: string | null;
  city?: string | null;
  territory?: string | null;
  [key: string]: unknown;
};

export type ProfileTypeaheadColumn = 'full_name' | 'phone' | 'email';

const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Debounce an imperative search handler. Keys must be unique per input. */
export function debounceKeyed(key: string, fn: () => void, ms = PROFILE_TYPEAHEAD_DEBOUNCE_MS): void {
  const prev = debounceTimers.get(key);
  if (prev) clearTimeout(prev);
  debounceTimers.set(key, setTimeout(() => {
    debounceTimers.delete(key);
    fn();
  }, ms));
}

export function cancelDebounceKeyed(key: string): void {
  const prev = debounceTimers.get(key);
  if (prev) clearTimeout(prev);
  debounceTimers.delete(key);
}

/** Strip characters that are wildcards or break a PostgREST filter string. */
export function sanitizeProfileQuery(raw: string): string {
  return raw.trim().replace(/[%,()*]/g, '');
}

export function profileQueryDigits(raw: string): string {
  return raw.replace(/\D/g, '');
}

/**
 * A phone lookup, not a name. "WEL-1A2B3C" keeps its letters so it stays on
 * the Welile-ID / name path inside search_users_fast.
 */
export function isPhoneLikeProfileQuery(raw: string): boolean {
  const digits = profileQueryDigits(raw);
  const letters = raw.replace(/[^A-Za-z]/g, '');
  return digits.length >= PHONE_MIN_DIGITS && letters.length === 0;
}

/**
 * One indexed column for the RLS fallback. Null when the term is shorter
 * than a trigram (3 characters). Phone input is a last-9 suffix, not
 * `%digits%` across every column.
 */
export function profileTypeaheadFilter(
  raw: string,
): { column: ProfileTypeaheadColumn; pattern: string } | null {
  const q = sanitizeProfileQuery(raw);
  if (q.length < PROFILE_TYPEAHEAD_MIN_CHARS) return null;
  if (isPhoneLikeProfileQuery(q)) {
    const last9 = profileQueryDigits(q).slice(-9);
    if (last9.length < PROFILE_TYPEAHEAD_MIN_CHARS) return null;
    return { column: 'phone', pattern: `%${last9}` };
  }
  if (q.includes('@')) {
    return { column: 'email', pattern: `${q.toLowerCase()}%` };
  }
  return { column: 'full_name', pattern: `%${q}%` };
}

function columnList(columns: string): string[] {
  return columns.split(',').map((part) => part.trim()).filter(Boolean);
}

function rpcCovers(columns: string): boolean {
  return columnList(columns).every((column) => RPC_COLUMNS.has(column));
}

function shouldFallback(error: { code?: string; message?: string }): boolean {
  const code = String(error.code ?? '');
  const message = error.message ?? '';
  if (code === '42501' || /not authorized/i.test(message)) return true;
  if (code === 'PGRST202' || code === '42883') return true;
  if (/could not find the function|schema cache/i.test(message)) return true;
  return false;
}

async function searchOneColumn(
  raw: string,
  limit: number,
  columns: string,
): Promise<{ rows: ProfileSearchRow[]; error: string | null }> {
  const clause = profileTypeaheadFilter(raw);
  if (!clause) return { rows: [], error: null };
  const { data, error } = await (supabase.from('profiles') as any)
    .select(columns)
    .ilike(clause.column, clause.pattern)
    .limit(limit);
  if (error) return { rows: [], error: error.message as string };
  return { rows: (data ?? []) as ProfileSearchRow[], error: null };
}

async function hydrateProfiles(
  base: ProfileSearchRow[],
  columns: string,
): Promise<{ rows: ProfileSearchRow[]; error: string | null }> {
  const ids = base.map((row) => row.id);
  const { data, error } = await (supabase.from('profiles') as any)
    .select(columns)
    .in('id', ids);
  if (error) return { rows: base, error: null };
  const order = new Map(base.map((row, index) => [row.id, index]));
  const rows = ((data ?? []) as ProfileSearchRow[]).slice().sort(
    (a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0),
  );
  return { rows, error: null };
}

/**
 * Staff typeahead goes through `search_users_fast` (min 3, phone last-9,
 * single trigram, cap 50). Anyone else gets one RLS-scoped column.
 * An empty RPC result is a real miss — it is not re-run as a 3-column ILIKE.
 */
export async function searchProfilesTypeahead(
  raw: string,
  options?: { limit?: number; columns?: string },
): Promise<{ rows: ProfileSearchRow[]; error: string | null }> {
  const q = sanitizeProfileQuery(raw);
  if (q.length < PROFILE_TYPEAHEAD_MIN_CHARS) return { rows: [], error: null };
  const limit = Math.min(Math.max(options?.limit ?? PROFILE_TYPEAHEAD_LIMIT, 1), 50);
  const columns = options?.columns ?? 'id, full_name, phone, email';

  const { data, error } = await supabase.rpc('search_users_fast', {
    p_query: q,
    p_limit: limit,
  });

  if (!error) {
    const base = ((data ?? []) as ProfileSearchRow[]).slice(0, limit);
    if (base.length === 0) return { rows: [], error: null };
    if (rpcCovers(columns)) return { rows: base, error: null };
    return hydrateProfiles(base, columns);
  }

  if (!shouldFallback(error)) return { rows: [], error: error.message };
  return searchOneColumn(q, limit, columns);
}

/**
 * Profile ids for a name, phone or email filter.
 * Null means the box is empty (do not filter). An empty array means the term
 * is too short for a trigram, or nobody matched. Never a multi-column ILIKE.
 */
export async function profileIdsForTypeahead(raw: string, limit = 50): Promise<string[] | null> {
  if (!raw.trim()) return null;
  const { rows, error } = await searchProfilesTypeahead(raw, {
    limit,
    columns: 'id',
  });
  if (error) throw new Error(error);
  return rows.map((row) => row.id);
}

/**
 * Match several extracted names without one giant `full_name ILIKE OR` chain.
 * Each name is its own capped lookup. Names under 3 characters are skipped.
 */
export async function searchProfilesByNames(
  names: string[],
  options?: { maxNames?: number; perNameLimit?: number; columns?: string },
): Promise<ProfileSearchRow[]> {
  const maxNames = options?.maxNames ?? 12;
  const perNameLimit = Math.min(Math.max(options?.perNameLimit ?? 5, 1), 20);
  const columns = options?.columns;
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const raw of names) {
    const q = sanitizeProfileQuery(raw);
    if (q.length < PROFILE_TYPEAHEAD_MIN_CHARS) continue;
    const key = q.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(q);
    if (unique.length >= maxNames) break;
  }

  const out = new Map<string, ProfileSearchRow>();
  const concurrency = 4;
  for (let i = 0; i < unique.length; i += concurrency) {
    const batch = unique.slice(i, i + concurrency);
    const results = await Promise.all(
      batch.map((name) => searchProfilesTypeahead(name, { limit: perNameLimit, columns })),
    );
    for (const result of results) {
      for (const row of result.rows) {
        if (!out.has(row.id)) out.set(row.id, row);
      }
    }
  }
  return [...out.values()];
}
