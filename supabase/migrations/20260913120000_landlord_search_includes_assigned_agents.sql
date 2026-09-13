-- Agent Shakirah Nakimbugwe reported: searching for a landlord she had
-- already dealt with ("Sharif kayemba 0") returned "No registered landlord
-- found". Confirmed: landlord "kayemba sharif" (id 88be517a-c508-4462-8d9a-
-- 001f6384d5bc) was registered_by a different agent (Sharifah Nattu), but
-- Shakirah has an ACTIVE agent_landlord_assignments row for that same
-- landlord from a separate rent request (assigned 2026-09-05) — she is
-- legitimately paying this landlord out, just didn't create the record.
--
-- search_landlords_fuzzy's agent scope only checked landlords_directory.
-- registered_by, so any landlord an agent works with via assignment/
-- management but didn't personally register was invisible to them when
-- posting a new tenant for that same landlord. Broaden the scope to match
-- how "this agent's landlords" is already computed elsewhere (see
-- AgentFloatPayoutWizard.tsx / AgentLandlordPayoutFlow.tsx, both of which
-- resolve payable landlords via agent_landlord_assignments).
--
-- Purely additive — only widens which rows can match, never narrows.

CREATE OR REPLACE FUNCTION public.search_landlords_fuzzy(p_query text DEFAULT ''::text, p_limit integer DEFAULT 20, p_threshold real DEFAULT 0.2, p_registered_by uuid DEFAULT NULL::uuid)
 RETURNS TABLE(id uuid, name text, phone text, property_address text, district text, town_council text, county text, village text, house_category text, monthly_rent numeric, latitude numeric, longitude numeric, verified boolean, match_score real, match_kind text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH q AS (
    SELECT
      trim(coalesce(p_query, '')) AS raw,
      lower(trim(coalesce(p_query, ''))) AS lc,
      regexp_replace(coalesce(p_query, ''), '\D', '', 'g') AS digits
  ),
  base AS (
    SELECT l.*,
      CASE
        WHEN (SELECT raw FROM q) = '' THEN 1.0
        WHEN lower(l.name) = (SELECT lc FROM q) THEN 1.0
        WHEN (SELECT digits FROM q) <> '' AND l.phone ILIKE '%' || (SELECT digits FROM q) || '%' THEN 0.95
        WHEN l.name ILIKE '%' || (SELECT raw FROM q) || '%' THEN 0.9
        ELSE similarity(lower(l.name), (SELECT lc FROM q))
      END::real AS score,
      CASE
        WHEN (SELECT raw FROM q) = '' THEN 'all'
        WHEN lower(l.name) = (SELECT lc FROM q) THEN 'name_exact'
        WHEN (SELECT digits FROM q) <> '' AND l.phone ILIKE '%' || (SELECT digits FROM q) || '%' THEN 'phone'
        WHEN l.name ILIKE '%' || (SELECT raw FROM q) || '%' THEN 'name_exact'
        ELSE 'fuzzy'
      END AS kind
    FROM public.landlords_directory l
    WHERE p_registered_by IS NULL
       OR l.registered_by = p_registered_by
       OR l.managed_by_agent_id = p_registered_by
       OR EXISTS (
         SELECT 1 FROM public.agent_landlord_assignments a
         WHERE a.landlord_id = l.id AND a.agent_id = p_registered_by AND a.status = 'active'
       )
  )
  SELECT b.id, b.name, b.phone, b.property_address,
    b.district, b.town_council, b.county, b.village,
    b.house_category, b.monthly_rent, b.latitude, b.longitude,
    COALESCE(b.verified, false) AS verified,
    b.score AS match_score, b.kind AS match_kind
  FROM base b
  WHERE (SELECT raw FROM q) = '' OR b.score >= p_threshold
  ORDER BY COALESCE(b.verified, false) DESC, b.score DESC, b.name ASC
  LIMIT LEAST(GREATEST(p_limit, 1), 100);
$function$;
