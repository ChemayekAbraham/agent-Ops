import { useEffect, useRef, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';

/**
 * Fuzzy duplicate detection for landlord and LC1 chairperson registration.
 *
 * Backed by `find_similar_landlords` / `find_similar_lc1`, which trigram-match
 * off a GIN index and score geography in three tiers. Both return a `severity`
 * so every caller applies the same rule instead of re-deriving thresholds.
 *
 * Why this exists. The phone guards on both tables are INSERT-only and skip
 * blank or short numbers, and nothing has ever looked at the name. Production
 * holds 473 extra landlord rows sharing a phone and 2,171 extra LC1 rows
 * sharing a name and village — one name/village pair registered 193 times.
 * Only 2 of those 684 LC1 groups share a phone number, so the phone guard
 * could never have caught them: the same person is entered with a different
 * number each time.
 *
 * Deliberately non-blocking on failure. A network hiccup must not stop an
 * agent registering a landlord in the field; the check is an assistant, not a
 * gate. The durable constraint belongs in the database, and cannot be added
 * until the existing duplicates are merged.
 */

export type SimilarContactGeoMatch = 'village_id' | 'village' | 'district' | 'none';

export interface SimilarContact {
  id: string;
  name: string;
  /** 0–1 trigram similarity against the typed name. */
  similarity: number;
  verified: boolean;
  /** Which geography tier matched, strongest first. */
  geo_match: SimilarContactGeoMatch;
  village: string | null;
  district: string | null;
  registered_by_name: string | null;
  /** True when the caller is the agent who registered this record. */
  is_mine: boolean;
  created_at: string;
  /** `block` = similarity ≥ 0.6 in the same village. */
  severity: 'block' | 'warn';
}

interface UseSimilarContactsArgs {
  kind: 'landlord' | 'lc1';
  name: string;
  villageId?: number | null;
  village?: string | null;
  district?: string | null;
  /** Set false to stop checking, e.g. once an existing record has been reused. */
  enabled?: boolean;
}

interface UseSimilarContactsResult {
  matches: SimilarContact[];
  /** The strongest match is a near-certain duplicate in the same village. */
  blocking: SimilarContact | null;
  checking: boolean;
}

/** Below this the trigram search matches half the country, so do not ask. */
const MIN_NAME_LENGTH = 3;
const DEBOUNCE_MS = 400;

export function useSimilarContacts({
  kind,
  name,
  villageId = null,
  village = null,
  district = null,
  enabled = true,
}: UseSimilarContactsArgs): UseSimilarContactsResult {
  const [matches, setMatches] = useState<SimilarContact[]>([]);
  const [checking, setChecking] = useState(false);

  // Monotonic request id. Responses can arrive out of order while someone is
  // typing; without this an older answer can overwrite a newer one and show a
  // match for a name the agent has already changed.
  const requestSeq = useRef(0);

  const trimmed = name.trim();

  useEffect(() => {
    if (!enabled || trimmed.length < MIN_NAME_LENGTH) {
      setMatches([]);
      setChecking(false);
      return;
    }

    const seq = ++requestSeq.current;
    let cancelled = false;
    setChecking(true);

    const timer = setTimeout(async () => {
      try {
        const { data, error } = await supabase.rpc(
          kind === 'landlord' ? 'find_similar_landlords' : 'find_similar_lc1',
          {
            p_name: trimmed,
            p_village_id: villageId ?? undefined,
            p_village_text: village ?? undefined,
            p_district: district ?? undefined,
            p_limit: 5,
          } as never,
        );

        // Drop the answer if the inputs moved on while it was in flight.
        if (cancelled || seq !== requestSeq.current) return;

        if (error) {
          // Never block registration on a lookup failure.
          setMatches([]);
          return;
        }
        setMatches(Array.isArray(data) ? (data as SimilarContact[]) : []);
      } catch {
        if (!cancelled && seq === requestSeq.current) setMatches([]);
      } finally {
        if (!cancelled && seq === requestSeq.current) setChecking(false);
      }
    }, DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [kind, trimmed, villageId, village, district, enabled]);

  const blocking = matches.find((m) => m.severity === 'block') ?? null;

  return { matches, blocking, checking };
}

/**
 * One sentence an agent can act on. Kept here so the landlord form, the LC1
 * form and anything built on top of this hook all word it the same way.
 */
export function describeSimilarContact(match: SimilarContact, kind: 'landlord' | 'lc1'): string {
  const who = kind === 'landlord' ? 'landlord' : 'LC1 chairperson';
  const where = match.village?.trim() || match.district?.trim();
  const parts = [`"${match.name}"`];
  if (where) parts.push(`in ${where}`);
  if (match.verified) parts.push('(already verified)');
  const by = match.is_mine
    ? 'registered by you'
    : match.registered_by_name
      ? `registered by ${match.registered_by_name}`
      : null;
  if (by) parts.push(`— ${by}`);
  return `A ${who} ${parts.join(' ')} is already registered. Reuse that record instead of creating a duplicate.`;
}
