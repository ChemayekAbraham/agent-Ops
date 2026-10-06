-- tops_shortfall_lines_v2: tops_shortfall_lines with the age columns filled in for plans
-- that have no instalment schedule. Read-only, additive: one new function.
--
-- It calls public.tops_shortfall_lines UNCHANGED, so every money column (expected,
-- collected, short, last paid, cadence) is exactly the original's. days_behind,
-- oldest_unpaid_due and periods_behind are taken from tops_shortfall_age_fallback ONLY
-- where the original oldest_unpaid_due is NULL; a value the original gave is never
-- overwritten. age_basis says which source was used:
--   'instalments'       the original (tops_open_instalments_asof)
--   'pinned_bills_fifo' filled from the pinned bills and receipts
--   'none'              neither source has an open bill for the plan
-- periods_behind uses the original's rule: daily = days, weekly = ceil(days / 7),
-- monthly = ceil(days / 30), other cadences NULL. The as-of date matches the original's
-- (the window's last Kampala day, capped at today).
--
-- Every column reference is alias-qualified: the RETURNS TABLE output names are also
-- PL/pgSQL variables and an unqualified reference raises "column reference is ambiguous".

CREATE OR REPLACE FUNCTION public.tops_shortfall_lines_v2(p_start timestamptz, p_end timestamptz)
RETURNS TABLE (
  rent_request_id uuid,
  tenant_id uuid,
  agent_id uuid,
  expected_ugx numeric,
  collected_capped_ugx numeric,
  short_ugx numeric,
  collected_raw_ugx numeric,
  last_paid_at timestamptz,
  oldest_unpaid_due date,
  days_behind int,
  cadence text,
  periods_behind int,
  age_basis text
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_end timestamptz;
  v_d2 date;
  v_asof date;
BEGIN
  IF NOT (
    public.is_ops_role(auth.uid()) OR public.has_role(auth.uid(), 'manager') OR public.has_role(auth.uid(), 'super_admin')
    OR public.has_role(auth.uid(), 'cto') OR public.has_role(auth.uid(), 'ceo') OR public.has_role(auth.uid(), 'coo')
  ) THEN RAISE EXCEPTION 'not authorized'; END IF;

  -- Same as-of date tops_shortfall_lines uses.
  v_end := (date_trunc('day', (p_end AT TIME ZONE 'Africa/Kampala')) AT TIME ZONE 'Africa/Kampala') + interval '1 day';
  v_d2 := ((v_end - interval '1 microsecond') AT TIME ZONE 'Africa/Kampala')::date;
  v_asof := LEAST(v_d2, (now() AT TIME ZONE 'Africa/Kampala')::date);

  RETURN QUERY
  WITH l AS MATERIALIZED (
    SELECT * FROM public.tops_shortfall_lines(p_start, p_end)
  ),
  fb AS MATERIALIZED (
    SELECT f.rent_request_id AS rr_id, f.oldest_unpaid_day AS oldest_day, f.days_behind AS dbh, f.basis AS basis
    FROM public.tops_shortfall_age_fallback(v_asof) f
    WHERE f.rent_request_id IN (SELECT l0.rent_request_id FROM l l0 WHERE l0.oldest_unpaid_due IS NULL)
  )
  SELECT
    l.rent_request_id,
    l.tenant_id,
    l.agent_id,
    l.expected_ugx,
    l.collected_capped_ugx,
    l.short_ugx,
    l.collected_raw_ugx,
    l.last_paid_at,
    COALESCE(l.oldest_unpaid_due, fb.oldest_day),
    CASE WHEN l.oldest_unpaid_due IS NULL THEN fb.dbh ELSE l.days_behind END,
    l.cadence,
    CASE
      WHEN l.oldest_unpaid_due IS NOT NULL OR fb.oldest_day IS NULL THEN l.periods_behind
      WHEN l.cadence = 'daily' THEN fb.dbh
      WHEN l.cadence = 'weekly' THEN ceil(fb.dbh::numeric / 7)::int
      WHEN l.cadence = 'monthly' THEN ceil(fb.dbh::numeric / 30)::int
      ELSE NULL
    END,
    CASE
      WHEN l.oldest_unpaid_due IS NOT NULL THEN 'instalments'
      WHEN fb.oldest_day IS NOT NULL THEN fb.basis
      ELSE 'none'
    END
  FROM l
  LEFT JOIN fb ON fb.rr_id = l.rent_request_id
  ORDER BY l.short_ugx DESC, l.rent_request_id;
END;
$function$;

-- This schema's default privileges auto-grant new functions to anon; revoke explicitly.
REVOKE ALL ON FUNCTION public.tops_shortfall_lines_v2(timestamptz, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tops_shortfall_lines_v2(timestamptz, timestamptz) TO authenticated;
