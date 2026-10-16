-- Landlord Ops home figures for a date range: ops_landlord_ops_home_range(p_start, p_end).
--
-- ONE NEW read-only function, modelled on ops_tenant_ops_home_range. No existing table, column, function, policy or edge function is
-- changed, and nothing here moves money.
--
-- Days are Kampala days: the range runs from the start of the Kampala day of p_start to the end of the Kampala day of p_end.
--
-- Landlords left out of EVERY figure: those whose phone (last 9 digits, normalize_phone_last9) matches a profile with deleted_at set.
-- Float balance is per agent, not per landlord, so that one figure cannot be narrowed this way (stated in the answer).
--
-- Each figure reuses the definition the Landlord Ops screens already use:
--   total_landlords            landlords created before the end of the range
--   new_landlords              landlords created in the range
--   verified_landlords         status "verified" (v_landlord_ops_status) whose state date COALESCE(verification_updated_at, created_at)
--                              falls in the range (the same date the Landlords tab's "Verified between" filter uses)
--   pending_verification       the CURRENT queues, exactly as src/hooks/landlordOpsQueueFilters.ts defines them (not range-based):
--                                houses     unverified, not rejected/delisted, service_center_status not_required or passed
--                                landlords  not with a Service Centre manager (service_center_status <> 'pending'), not verified
--                                lc1        v_lc1_verification_inbox: status pending, agent request open, not with a Service Centre
--   with_tenants / without_tenants   v_landlord_ops_status.has_tenant, over landlords created before the end of the range
--   funded_landlords           distinct landlords with a Rent Plan funded in the range (ops_landlord_funded_stats); also funded_requests
--                              and funded_principal (sum of rent_amount)
--   landlords_paid             distinct landlords paid in the range: a landlord_payouts row that is not failed, disbursed in the range
--                              (COALESCE(finops_disbursed_at, disbursed_at)), and not reversed (every receipt of the payout reversed and
--                              none still active); also payouts_paid and paid_amount
--   principal_recovered        sum of instalment_allocations.principal_component, not reversed, instalment_date in the range
--                              (landlord_ops_principal_comparison's definition), for Rent Plans of the landlords counted
--   float_balance              sum of agent_landlord_float.balance where the balance is above 0 (landlord_ops_float_overview, "with agents")
--   missing_gps                landlords created before the end of the range with no latitude or no longitude
--   missing_payout_details     ... with neither a mobile money number nor a bank name (the "Not set" payout channel)
--   duplicate_phones           phone numbers (last 9 digits) held by more than one landlord created before the end of the range;
--                              duplicate_phone_landlords is how many landlords share them
--
-- Access: landlord_ops, coo, cfo, ceo, manager, super_admin. A missing user is refused first. SECURITY DEFINER, STABLE, search_path = public.
-- Rollback: supabase/rollbacks/20261015160000_ops_landlord_ops_home_range.rollback.sql

CREATE OR REPLACE FUNCTION public.ops_landlord_ops_home_range(p_start timestamptz, p_end timestamptz)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_start timestamptz;
  v_end timestamptz;
  v_days int;
  v_res jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not authorised' USING ERRCODE = '42501';
  END IF;
  IF NOT (
    public.has_role(v_uid, 'landlord_ops'::app_role) OR public.has_role(v_uid, 'coo'::app_role) OR public.has_role(v_uid, 'cfo'::app_role)
    OR public.has_role(v_uid, 'ceo'::app_role) OR public.has_role(v_uid, 'manager'::app_role) OR public.has_role(v_uid, 'super_admin'::app_role)
  ) THEN
    RAISE EXCEPTION 'not authorised' USING ERRCODE = '42501';
  END IF;
  IF p_start IS NULL OR p_end IS NULL THEN
    RAISE EXCEPTION 'RANGE_REQUIRED: p_start and p_end are required' USING ERRCODE = '22023';
  END IF;

  v_start := (date_trunc('day', (p_start AT TIME ZONE 'Africa/Kampala')) AT TIME ZONE 'Africa/Kampala');
  v_end := (date_trunc('day', (p_end AT TIME ZONE 'Africa/Kampala')) AT TIME ZONE 'Africa/Kampala') + interval '1 day';
  IF v_end <= v_start THEN
    RAISE EXCEPTION 'RANGE_INVALID: p_end is before p_start' USING ERRCODE = '22023';
  END IF;
  v_days := GREATEST(1, round(extract(epoch FROM (v_end - v_start)) / 86400)::int);

  WITH deleted_phones AS (
    SELECT DISTINCT public.normalize_phone_last9(p.phone) AS k
      FROM public.profiles p
     WHERE p.deleted_at IS NOT NULL AND public.normalize_phone_last9(p.phone) IS NOT NULL
  ), ll AS (
    SELECT l.id, l.phone, l.created_at, l.verification_updated_at, l.latitude, l.longitude, l.mobile_money_number, l.bank_name,
           l.verified, l.service_center_status, v.status AS vstatus, v.has_tenant,
           public.normalize_phone_last9(l.phone) AS phone_key
      FROM public.landlords l
      JOIN public.v_landlord_ops_status v ON v.landlord_id = l.id
     WHERE NOT EXISTS (SELECT 1 FROM deleted_phones d WHERE d.k = public.normalize_phone_last9(l.phone))
  ), asat AS (
    SELECT * FROM ll WHERE created_at < v_end
  ), dup AS (
    SELECT phone_key, count(*) AS n FROM asat WHERE phone_key IS NOT NULL GROUP BY phone_key HAVING count(*) > 1
  ), funded AS (
    SELECT rr.landlord_id, COALESCE(rr.rent_amount, 0) AS rent_amount
      FROM public.rent_requests rr
      JOIN ll ON ll.id = rr.landlord_id
     WHERE rr.funded_at >= v_start AND rr.funded_at < v_end
  ), paid AS (
    SELECT lp.landlord_id, COALESCE(lp.amount, 0) AS amount
      FROM public.landlord_payouts lp
      JOIN ll ON ll.id = lp.landlord_id
     WHERE lp.status <> 'failed'
       AND COALESCE(lp.finops_disbursed_at, lp.disbursed_at) >= v_start
       AND COALESCE(lp.finops_disbursed_at, lp.disbursed_at) < v_end
       AND NOT (
         EXISTS (SELECT 1 FROM public.landlord_payout_receipts r WHERE r.payout_id = lp.id AND r.reversed_at IS NOT NULL)
         AND NOT EXISTS (SELECT 1 FROM public.landlord_payout_receipts r WHERE r.payout_id = lp.id AND r.reversed_at IS NULL)
       )
  )
  SELECT jsonb_build_object(
    'days', v_days,
    'window_start', to_jsonb(v_start),
    'window_end', to_jsonb(v_end),
    'from_day', (v_start AT TIME ZONE 'Africa/Kampala')::date,
    'to_day', ((v_end - interval '1 microsecond') AT TIME ZONE 'Africa/Kampala')::date,
    'total_landlords', (SELECT count(*) FROM asat),
    'new_landlords', (SELECT count(*) FROM ll WHERE created_at >= v_start AND created_at < v_end),
    'verified_landlords', (SELECT count(*) FROM ll WHERE vstatus = 'verified'
                             AND COALESCE(verification_updated_at, created_at) >= v_start AND COALESCE(verification_updated_at, created_at) < v_end),
    'pending_verification', jsonb_build_object(
      'houses', (SELECT count(*) FROM public.house_listings hl
                  WHERE hl.verified = false AND hl.status NOT IN ('rejected', 'delisted') AND hl.service_center_status IN ('not_required', 'passed')
                    AND (hl.landlord_id IS NULL OR hl.landlord_id IN (SELECT id FROM ll))),
      'landlords', (SELECT count(*) FROM ll WHERE service_center_status <> 'pending' AND (verified IS NULL OR verified = false)),
      'lc1', (SELECT count(*) FROM public.v_lc1_verification_inbox i
               WHERE i.service_center_status <> 'pending' AND i.status = 'pending' AND i.agent_request_open = true)
    ),
    'with_tenants', (SELECT count(*) FROM asat WHERE has_tenant),
    'without_tenants', (SELECT count(*) FROM asat WHERE NOT has_tenant),
    'funded_landlords', (SELECT count(DISTINCT landlord_id) FROM funded),
    'funded_requests', (SELECT count(*) FROM funded),
    'funded_principal', (SELECT COALESCE(sum(rent_amount), 0) FROM funded),
    'landlords_paid', (SELECT count(DISTINCT landlord_id) FROM paid),
    'payouts_paid', (SELECT count(*) FROM paid),
    'paid_amount', (SELECT COALESCE(sum(amount), 0) FROM paid),
    'principal_recovered', (SELECT COALESCE(sum(ia.principal_component), 0)
                              FROM public.instalment_allocations ia
                              JOIN public.rent_requests rr ON rr.id = ia.rent_request_id
                              JOIN ll ON ll.id = rr.landlord_id
                             WHERE ia.reversed_at IS NULL AND ia.instalment_date >= v_start AND ia.instalment_date < v_end),
    'float_balance', (SELECT COALESCE(sum(f.balance), 0) FROM public.agent_landlord_float f WHERE COALESCE(f.balance, 0) > 0),
    'float_agents', (SELECT count(*) FROM public.agent_landlord_float f WHERE COALESCE(f.balance, 0) > 0),
    'missing_gps', (SELECT count(*) FROM asat WHERE latitude IS NULL OR longitude IS NULL),
    'missing_payout_details', (SELECT count(*) FROM asat
                                WHERE NULLIF(btrim(COALESCE(mobile_money_number, '')), '') IS NULL AND NULLIF(btrim(COALESCE(bank_name, '')), '') IS NULL),
    'duplicate_phones', (SELECT count(*) FROM dup),
    'duplicate_phone_landlords', (SELECT COALESCE(sum(n), 0) FROM dup),
    'excluded_landlords', (SELECT count(*) FROM public.landlords) - (SELECT count(*) FROM ll),
    'generated_at', to_jsonb(now())
  ) INTO v_res;

  RETURN v_res;
END;
$function$;

COMMENT ON FUNCTION public.ops_landlord_ops_home_range(timestamptz, timestamptz) IS
  'Read-only Landlord Ops home figures for a range of Kampala days (landlords, verification, tenants, funded, paid, principal recovered, float, data gaps, duplicate phones). Landlords whose phone matches a deleted profile are left out. landlord_ops, coo, cfo, ceo, manager, super_admin.';

REVOKE ALL ON FUNCTION public.ops_landlord_ops_home_range(timestamptz, timestamptz) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.ops_landlord_ops_home_range(timestamptz, timestamptz) TO authenticated;
