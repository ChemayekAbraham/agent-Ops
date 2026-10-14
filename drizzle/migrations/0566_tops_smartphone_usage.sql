-- Tenant Ops Workspace: smartphone usage for the "Tenant Classification" tab.
--
-- Read-only. One new function; nothing existing is edited (no function, view, table, trigger, policy
-- or ledger object is touched) and no category from tops_tenant_classification_* is recomputed here.
--
-- Population is exactly the classification population: users with the enabled 'tenant' role whose
-- profile is not deleted. So every figure below is "of the same tenants the cards above count".
--
-- What each figure means - no new definition of "smartphone" is invented:
--   recorded_smartphone / recorded_without
--       profiles.has_smartphone: the answer captured at sign-up. It is a declaration, not a check.
--   confirmed_smartphone / confirmed_feature_phone / device_unknown
--       profiles.smartphone_status, the same three values get_tenant_smartphone_overview segments on.
--       That function stays the canonical device segmentation; this read repeats its two filters only
--       so one round trip can serve the card together with the window figures.
--   window figures (Kampala days, p_from .. p_to inclusive)
--       joined                     profiles.created_at falls in the window
--       joined_recorded_smartphone  ... and was recorded as having a smartphone
--       checks                     profiles.smartphone_verified_at falls in the window: the day the
--                                  device was settled by an agent, the call centre or a dashboard visit
--       checks_smartphone / checks_feature_phone  ... and what that check concluded
--       seen_on_phone              distinct tenants in tenant_dashboard_access_log whose device_class
--                                  was a phone (android_phone, iphone) on an open inside the window
--
-- Access: _am_staff_ok(), the same staff check the classification tab's own functions use.

CREATE OR REPLACE FUNCTION public.tops_smartphone_usage(p_from date, p_to date)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_out jsonb;
BEGIN
  IF auth.uid() IS NULL OR NOT public._am_staff_ok() THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;
  IF p_from IS NULL OR p_to IS NULL THEN
    RAISE EXCEPTION 'p_from and p_to are both required' USING ERRCODE = '22023';
  END IF;
  IF p_from > p_to THEN
    RAISE EXCEPTION 'p_from (%) must not be after p_to (%)', p_from, p_to USING ERRCODE = '22023';
  END IF;
  IF p_to > (now() AT TIME ZONE 'Africa/Kampala')::date THEN
    RAISE EXCEPTION 'p_to (%) is a future Kampala day', p_to USING ERRCODE = '22023';
  END IF;

  WITH pop AS (
    SELECT p.id,
           p.has_smartphone,
           p.smartphone_status,
           (p.created_at AT TIME ZONE 'Africa/Kampala')::date             AS joined_on,
           (p.smartphone_verified_at AT TIME ZONE 'Africa/Kampala')::date AS checked_on
      FROM public.profiles p
     WHERE p.deleted_at IS NULL
       AND EXISTS (SELECT 1 FROM public.user_roles ur
                    WHERE ur.user_id = p.id AND ur.role::text = 'tenant' AND ur.enabled)
  ),
  seen AS (
    SELECT DISTINCT l.tenant_id
      FROM public.tenant_dashboard_access_log l
     WHERE l.device_class IN ('android_phone', 'iphone')
       AND l.opened_at IS NOT NULL
       AND (l.opened_at AT TIME ZONE 'Africa/Kampala')::date BETWEEN p_from AND p_to
  )
  SELECT jsonb_build_object(
    'as_of', (now() AT TIME ZONE 'Africa/Kampala')::date,
    'from_day', p_from,
    'to_day', p_to,
    'tenants', count(*),
    'recorded_smartphone', count(*) FILTER (WHERE pop.has_smartphone),
    'recorded_without', count(*) FILTER (WHERE pop.has_smartphone IS NOT TRUE),
    'confirmed_smartphone', count(*) FILTER (WHERE pop.smartphone_status = 'CONFIRMED_SMARTPHONE'),
    'confirmed_feature_phone', count(*) FILTER (WHERE pop.smartphone_status = 'CONFIRMED_FEATURE_PHONE'),
    'device_unknown', count(*) FILTER (WHERE pop.smartphone_status IS NULL OR pop.smartphone_status = 'UNKNOWN'),
    'joined', count(*) FILTER (WHERE pop.joined_on BETWEEN p_from AND p_to),
    'joined_recorded_smartphone', count(*) FILTER (WHERE pop.joined_on BETWEEN p_from AND p_to AND pop.has_smartphone),
    'checks', count(*) FILTER (WHERE pop.checked_on BETWEEN p_from AND p_to),
    'checks_smartphone', count(*) FILTER (WHERE pop.checked_on BETWEEN p_from AND p_to AND pop.smartphone_status = 'CONFIRMED_SMARTPHONE'),
    'checks_feature_phone', count(*) FILTER (WHERE pop.checked_on BETWEEN p_from AND p_to AND pop.smartphone_status = 'CONFIRMED_FEATURE_PHONE'),
    'seen_on_phone', (SELECT count(*) FROM seen s JOIN pop ON pop.id = s.tenant_id)
  )
  INTO v_out
  FROM pop;

  RETURN v_out;
END;
$function$;

-- Grants: signed-in staff only, and the function itself decides who (anon can never call it).
REVOKE ALL ON FUNCTION public.tops_smartphone_usage(date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tops_smartphone_usage(date, date) TO authenticated, service_role;

COMMENT ON FUNCTION public.tops_smartphone_usage(date, date) IS
  'Read-only smartphone figures for the Tenant Classification tab: recorded at sign-up, confirmed by a check, and a Kampala-day window. Staff only (_am_staff_ok).'