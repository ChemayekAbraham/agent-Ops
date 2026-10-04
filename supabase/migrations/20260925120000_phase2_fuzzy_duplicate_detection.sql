-- Phase 2 — fuzzy duplicate detection for landlords and LC1 chairpersons
--
-- Spec: docs/rent-plan-new-flow-full-report.md section 8, Phase 2 (items 8-10).
--
-- Why this is needed. Both tables have a BEFORE INSERT phone guard, and both
-- guards are INSERT-only, skip blank or short numbers, and never look at the
-- name. Production on 25 September 2026:
--
--   landlords         46,350 rows. 289 duplicate-phone groups -> 473 extra
--                     rows, 197 of them verified. 209 duplicate-name groups
--                     -> 385 extra rows.
--   lc1_chairpersons  24,482 rows. 684 groups share a name AND a village ->
--                     2,171 extra rows, 125 of them verified. The largest
--                     single name/village pair appears 193 times.
--
-- The LC1 figure is the striking one, and it shows why the phone guard was
-- never going to be enough: only 2 of those 684 groups share a phone number.
-- The same chairperson is entered with a different number every time, so the
-- only reliable signal is the name plus the village.
--
-- Each duplicate is not merely untidy. A verified row can pay its own
-- registration bonus, so a duplicated landlord is a duplicated 5,000.
--
-- What this migration does NOT do. It adds no constraint and blocks no write.
-- A hard block would make the 473 existing landlord duplicates unresolvable
-- and would reject legitimate bulk imports. Detect first, merge second,
-- constrain third -- see docs/commission-policy-decisions-2026-09-23.md.
--
-- Geography, as it actually is. The spec assumed village scoping on
-- `ug_village_id`. That is populated on 515 of 46,350 landlords (1.1%) and 437
-- of 24,482 LC1 rows (1.8%), so scoping on it alone would ignore 99% of the
-- book. The free-text columns carry the real signal -- `village` on 46% of
-- landlords and 100% of LC1 rows, `district` on 46% and 97%. These functions
-- therefore match geography in three tiers and report which one hit, so a name
-- collision in the same village can be weighed differently from one on the
-- other side of the country.
--
-- Performance. `find_landlord_duplicate`, the exact-match RPC the registration
-- form already calls on every name blur, compares a computed expression with
-- `=`, so it can use no index and seq-scans the table: 230 ms and 3,199
-- buffers, every call. These functions drive the `%` operator off the trigram
-- index instead and settle at roughly 2.7 ms and 135 buffers once the plan is
-- cached (about 15 ms on the first call), while being fuzzy rather than exact.

-- ---------------------------------------------------------------------------
-- 8. The index LC1 was missing
--
-- `landlords` already has idx_landlords_name_trgm. `lc1_chairpersons` had only
-- a btree on lower(name), which answers equality and nothing else.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_lc1_chairpersons_name_trgm
  ON public.lc1_chairpersons USING gin (name gin_trgm_ops);

-- ---------------------------------------------------------------------------
-- 9a. find_similar_landlords
--
-- One round trip, one index scan, and the profiles lookup deliberately placed
-- AFTER the limit so it runs on at most `p_limit` rows rather than on every
-- trigram hit.
--
-- Returned deliberately: enough to recognise the person and act -- name, where
-- they are, whether they are verified, who registered them, and whether that
-- was you. Deliberately NOT returned: phone number or any identity document.
-- The caller is `authenticated`, so this must not become a lookup tool; the
-- three-character floor exists for the same reason.
--
-- `severity` is computed here so every caller applies the same rule instead of
-- re-deriving thresholds:
--   block -- similarity >= 0.6 AND the same village. Near-certainly the same
--            person; the form should refuse and offer to reuse the record.
--   warn  -- anything else returned. Shown, but the agent may proceed.
--
-- A note on the thresholds, from testing against real duplicates: an exact
-- re-registration scores 1.0 and blocks, but a plausible agent typo
-- ("Walyoumu Micheal" for "walyomu Michael") scores 0.435 and only warns. The
-- warn tier is doing most of the work, so whatever renders these must make a
-- warning prominent rather than easy to dismiss.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.find_similar_landlords(
  p_name         text,
  p_village_id   integer DEFAULT NULL,
  p_village_text text    DEFAULT NULL,
  p_district     text    DEFAULT NULL,
  p_limit        integer DEFAULT 5
)
RETURNS TABLE (
  id                 uuid,
  name               text,
  similarity         real,
  verified           boolean,
  geo_match          text,
  village            text,
  district           text,
  registered_by_name text,
  is_mine            boolean,
  created_at         timestamptz,
  severity           text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_name  text := btrim(COALESCE(p_name, ''));
  v_limit int  := GREATEST(1, LEAST(COALESCE(p_limit, 5), 20));
BEGIN
  -- Two characters match half of Uganda. Below three, say nothing.
  IF length(v_name) < 3 THEN
    RETURN;
  END IF;

  -- Pin the operator's threshold for this statement only, so the result never
  -- depends on a database- or session-level setting someone else changed.
  PERFORM set_config('pg_trgm.similarity_threshold', '0.3', true);

  RETURN QUERY
  WITH scored AS (
    SELECT l.id, l.name, similarity(l.name, v_name) AS sim,
           COALESCE(l.verified, false) AS verified,
           CASE
             WHEN p_village_id IS NOT NULL AND l.ug_village_id = p_village_id THEN 'village_id'
             WHEN NULLIF(btrim(COALESCE(p_village_text, '')), '') IS NOT NULL
              AND lower(btrim(COALESCE(l.village, ''))) = lower(btrim(p_village_text)) THEN 'village'
             WHEN NULLIF(btrim(COALESCE(p_district, '')), '') IS NOT NULL
              AND lower(btrim(COALESCE(l.district, ''))) = lower(btrim(p_district)) THEN 'district'
             ELSE 'none'
           END AS geo_match,
           l.village, l.district, l.registered_by, l.created_at
    FROM public.landlords l
    WHERE l.name % v_name
  ), picked AS (
    -- Narrow to the rows actually returned BEFORE joining profiles.
    SELECT s.*, (s.sim >= 0.6 AND s.geo_match IN ('village_id','village')) AS is_block
    FROM scored s
    WHERE s.sim >= 0.4 OR (s.sim >= 0.3 AND s.geo_match <> 'none')
    ORDER BY (s.sim >= 0.6 AND s.geo_match IN ('village_id','village')) DESC,
             s.sim DESC, s.verified DESC, s.created_at ASC
    LIMIT v_limit
  )
  SELECT k.id, k.name, k.sim, k.verified, k.geo_match, k.village, k.district,
         pr.full_name,
         (k.registered_by IS NOT NULL AND k.registered_by = auth.uid()),
         k.created_at,
         CASE WHEN k.is_block THEN 'block' ELSE 'warn' END
  FROM picked k
  LEFT JOIN public.profiles pr ON pr.id = k.registered_by
  ORDER BY k.is_block DESC, k.sim DESC, k.verified DESC, k.created_at ASC;
END;
$function$;

-- ---------------------------------------------------------------------------
-- 9b. find_similar_lc1 — the same shape for LC1 chairpersons
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.find_similar_lc1(
  p_name         text,
  p_village_id   integer DEFAULT NULL,
  p_village_text text    DEFAULT NULL,
  p_district     text    DEFAULT NULL,
  p_limit        integer DEFAULT 5
)
RETURNS TABLE (
  id                 uuid,
  name               text,
  similarity         real,
  verified           boolean,
  geo_match          text,
  village            text,
  district           text,
  registered_by_name text,
  is_mine            boolean,
  created_at         timestamptz,
  severity           text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_name  text := btrim(COALESCE(p_name, ''));
  v_limit int  := GREATEST(1, LEAST(COALESCE(p_limit, 5), 20));
BEGIN
  IF length(v_name) < 3 THEN
    RETURN;
  END IF;

  PERFORM set_config('pg_trgm.similarity_threshold', '0.3', true);

  RETURN QUERY
  WITH scored AS (
    SELECT c.id, c.name, similarity(c.name, v_name) AS sim,
           COALESCE(c.verified, false) AS verified,
           CASE
             WHEN p_village_id IS NOT NULL AND c.ug_village_id = p_village_id THEN 'village_id'
             WHEN NULLIF(btrim(COALESCE(p_village_text, '')), '') IS NOT NULL
              AND lower(btrim(COALESCE(c.village, ''))) = lower(btrim(p_village_text)) THEN 'village'
             WHEN NULLIF(btrim(COALESCE(p_district, '')), '') IS NOT NULL
              AND lower(btrim(COALESCE(c.district, ''))) = lower(btrim(p_district)) THEN 'district'
             ELSE 'none'
           END AS geo_match,
           c.village, c.district, c.registered_by, c.created_at
    FROM public.lc1_chairpersons c
    WHERE c.name % v_name
  ), picked AS (
    SELECT s.*, (s.sim >= 0.6 AND s.geo_match IN ('village_id','village')) AS is_block
    FROM scored s
    WHERE s.sim >= 0.4 OR (s.sim >= 0.3 AND s.geo_match <> 'none')
    ORDER BY (s.sim >= 0.6 AND s.geo_match IN ('village_id','village')) DESC,
             s.sim DESC, s.verified DESC, s.created_at ASC
    LIMIT v_limit
  )
  SELECT k.id, k.name, k.sim, k.verified, k.geo_match, k.village, k.district,
         pr.full_name,
         (k.registered_by IS NOT NULL AND k.registered_by = auth.uid()),
         k.created_at,
         CASE WHEN k.is_block THEN 'block' ELSE 'warn' END
  FROM picked k
  LEFT JOIN public.profiles pr ON pr.id = k.registered_by
  ORDER BY k.is_block DESC, k.sim DESC, k.verified DESC, k.created_at ASC;
END;
$function$;

REVOKE ALL ON FUNCTION public.find_similar_landlords(text, integer, text, text, integer) FROM public, anon;
REVOKE ALL ON FUNCTION public.find_similar_lc1(text, integer, text, text, integer) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.find_similar_landlords(text, integer, text, text, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.find_similar_lc1(text, integer, text, text, integer) TO authenticated;

COMMENT ON FUNCTION public.find_similar_landlords(text, integer, text, text, integer) IS
  'Fuzzy duplicate detection for landlord registration. Trigram-matched off '
  'idx_landlords_name_trgm, geography matched in three tiers (ug_village_id, '
  'village text, district). severity=block means similarity >= 0.6 in the same '
  'village. Returns no phone or identity document by design.';

COMMENT ON FUNCTION public.find_similar_lc1(text, integer, text, text, integer) IS
  'Fuzzy duplicate detection for LC1 chairperson registration. See '
  'find_similar_landlords.';
