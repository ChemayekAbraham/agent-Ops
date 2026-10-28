-- =============================================================================
-- Rollback: 20261028190000_landlord_calling_hub_real_landlords.rollback.sql
-- Purpose:  Restores the Prompt 1 foundation versions of `mv_landlord_hub_registry`,
--           `landlord_hub_list`, `landlord_hub_detail`, and `landlord_hub_stats`,
--           and drops `landlord_hub_agents()`.
--           Preserves all recorded calls, dial markers, and amendments untouched.
-- =============================================================================

DROP FUNCTION IF EXISTS public.landlord_hub_agents();
DROP FUNCTION IF EXISTS public.landlord_hub_list(text, text, text, text, text, text, text, text, integer, integer, text, text);
DROP FUNCTION IF EXISTS public.landlord_hub_list(text, text, text, text, text, text, text, text, integer, integer);

DROP MATERIALIZED VIEW IF EXISTS public.mv_landlord_hub_registry CASCADE;

CREATE MATERIALIZED VIEW public.mv_landlord_hub_registry AS
SELECT
  reg.landlord_key::text AS landlord_key_text,
  reg.*
FROM public.v_landlord_registry_all reg;

CREATE UNIQUE INDEX IF NOT EXISTS mv_landlord_hub_registry_key_text_idx
  ON public.mv_landlord_hub_registry (landlord_key_text);
CREATE INDEX IF NOT EXISTS mv_landlord_hub_registry_landlord_id_idx
  ON public.mv_landlord_hub_registry (landlord_id)
  WHERE landlord_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS mv_landlord_hub_registry_live_plans_sort_idx
  ON public.mv_landlord_hub_registry (plan_rent_total DESC NULLS LAST, active_rent_plans DESC NULLS LAST, landlord_key_text ASC)
  WHERE active_rent_plans > 0;
CREATE INDEX IF NOT EXISTS mv_landlord_hub_registry_all_sort_idx
  ON public.mv_landlord_hub_registry (plan_rent_total DESC NULLS LAST, active_rent_plans DESC NULLS LAST, landlord_key_text ASC);
CREATE INDEX IF NOT EXISTS mv_landlord_hub_registry_region_district_idx
  ON public.mv_landlord_hub_registry (lower(region), lower(district));

REVOKE ALL ON TABLE public.mv_landlord_hub_registry FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.mv_landlord_hub_registry TO service_role;

CREATE OR REPLACE FUNCTION public.refresh_mv_landlord_hub_registry()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.mv_landlord_hub_registry;
END;
$function$;

REVOKE ALL ON FUNCTION public.refresh_mv_landlord_hub_registry() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_mv_landlord_hub_registry() TO service_role;

CREATE OR REPLACE FUNCTION public.landlord_hub_list(
  p_scope    text DEFAULT 'live_plans',
  p_tab      text DEFAULT 'to_call',
  p_search   text DEFAULT NULL,
  p_region   text DEFAULT NULL,
  p_district text DEFAULT NULL,
  p_agent    text DEFAULT NULL,
  p_verified text DEFAULT NULL,
  p_sort     text DEFAULT 'rent_plan_value',
  p_limit    integer DEFAULT 50,
  p_offset   integer DEFAULT 0
)
RETURNS TABLE (
  landlord_key       text,
  landlord_id        uuid,
  user_id            uuid,
  landlord_name      text,
  phone              text,
  phone_masked       boolean,
  region             text,
  district           text,
  agent_id           uuid,
  agent_name         text,
  verified           boolean,
  verification_status text,
  houses_count       integer,
  live_rent_plans    integer,
  rent_plan_value    numeric,
  last_call_at       timestamptz,
  last_result        text,
  last_caller_id     uuid,
  last_caller_name   text,
  call_back_due_at   timestamptz,
  call_back_overdue  boolean,
  being_called_by_id uuid,
  being_called_by    text,
  being_called_since timestamptz,
  hub_status         text,
  needs_review       boolean,
  total_count        bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_scope     text := lower(btrim(COALESCE(NULLIF(p_scope, ''), 'live_plans')));
  v_tab       text := lower(btrim(COALESCE(NULLIF(p_tab, ''), 'to_call')));
  v_search    text := lower(btrim(COALESCE(p_search, '')));
  v_region    text := NULLIF(btrim(COALESCE(p_region, '')), '');
  v_district  text := NULLIF(btrim(COALESCE(p_district, '')), '');
  v_agent     text := NULLIF(btrim(COALESCE(p_agent, '')), '');
  v_verified  text := lower(btrim(COALESCE(p_verified, '')));
  v_sort      text := lower(btrim(COALESCE(NULLIF(p_sort, ''), 'rent_plan_value')));
  v_limit     integer := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 50);
  v_offset    integer := GREATEST(COALESCE(p_offset, 0), 0);
  v_unmasked  boolean;
  v_now       timestamptz := now();
BEGIN
  IF NOT public._landlord_hub_can_read() THEN
    RAISE EXCEPTION 'NOT_AUTHORISED: you are not authorised to view the Landlord Calling Hub'
      USING ERRCODE = '42501';
  END IF;

  IF v_scope NOT IN ('live_plans', 'with_plans', 'all') THEN
    RAISE EXCEPTION 'SCOPE_INVALID: p_scope must be live_plans, with_plans or all'
      USING ERRCODE = '22023';
  END IF;

  IF v_tab NOT IN ('to_call', 'call_back', 'answered', 'not_answered', 'all') THEN
    RAISE EXCEPTION 'TAB_INVALID: p_tab must be to_call, call_back, answered, not_answered or all'
      USING ERRCODE = '22023';
  END IF;

  v_unmasked := public._landlord_cc_can_view_unmasked_phone();

  RETURN QUERY
  WITH hub_latest AS MATERIALIZED (
    SELECT DISTINCT ON (c.landlord_key)
      c.landlord_key,
      c.id AS call_id,
      c.recorded_at,
      c.result,
      c.call_back_at,
      c.caller_id,
      COALESCE(NULLIF(btrim(cp.full_name), ''), 'Landlord Ops officer') AS caller_name
    FROM public.v_landlord_calls_effective c
    LEFT JOIN public.profiles cp ON cp.id = c.caller_id
    WHERE c.voided_at IS NULL
    ORDER BY c.landlord_key, c.recorded_at DESC, c.id DESC
  ),
  active_dials AS MATERIALIZED (
    SELECT DISTINCT ON (d.landlord_key)
      d.landlord_key,
      d.caller_id,
      COALESCE(NULLIF(btrim(dp.full_name), ''), 'Landlord Ops officer') AS caller_name,
      d.started_at
    FROM public.landlord_call_dials d
    LEFT JOIN public.profiles dp ON dp.id = d.caller_id
    WHERE d.call_id IS NULL
      AND d.expires_at > v_now
    ORDER BY d.landlord_key, d.started_at DESC
  ),
  plans_any AS MATERIALIZED (
    SELECT DISTINCT rr.landlord_id
    FROM public.rent_requests rr
    WHERE v_scope = 'with_plans'
      AND rr.landlord_id IS NOT NULL
  ),
  scoped_reg AS (
    SELECT
      reg.landlord_key_text AS l_key,
      reg.landlord_id,
      reg.user_id,
      COALESCE(NULLIF(btrim(reg.full_name), ''), 'Unnamed Landlord') AS landlord_name,
      reg.phones[1] AS primary_phone,
      reg.region,
      reg.district,
      reg.registering_agent_id AS agent_id,
      reg.registering_agent_name AS agent_name,
      (reg.verification_status = 'verified') AS is_verified,
      reg.verification_status,
      COALESCE(reg.houses_count, 0)::integer AS houses_count,
      COALESCE(reg.active_rent_plans, 0)::integer AS live_rent_plans,
      COALESCE(reg.plan_rent_total, 0)::numeric AS rent_plan_value,
      reg.needs_review,
      reg.registered_at,
      CASE
        WHEN hl.recorded_at IS NOT NULL AND (reg.last_called_at IS NULL OR hl.recorded_at >= reg.last_called_at)
          THEN hl.recorded_at
        ELSE reg.last_called_at
      END AS eff_last_call_at,
      CASE
        WHEN hl.recorded_at IS NOT NULL AND (reg.last_called_at IS NULL OR hl.recorded_at >= reg.last_called_at)
          THEN hl.result
        ELSE reg.last_call_outcome
      END AS eff_last_result,
      CASE
        WHEN hl.recorded_at IS NOT NULL AND (reg.last_called_at IS NULL OR hl.recorded_at >= reg.last_called_at)
          THEN hl.caller_id
        ELSE NULL::uuid
      END AS eff_last_caller_id,
      CASE
        WHEN hl.recorded_at IS NOT NULL AND (reg.last_called_at IS NULL OR hl.recorded_at >= reg.last_called_at)
          THEN hl.caller_name
        ELSE reg.last_caller_name
      END AS eff_last_caller_name,
      CASE
        WHEN hl.result = 'call_back'
             AND (reg.last_called_at IS NULL OR hl.recorded_at >= reg.last_called_at)
          THEN hl.call_back_at
        ELSE NULL::timestamptz
      END AS eff_call_back_due_at,
      ad.caller_id AS dial_caller_id,
      ad.caller_name AS dial_caller_name,
      ad.started_at AS dial_started_at
    FROM public.mv_landlord_hub_registry reg
    LEFT JOIN hub_latest hl ON hl.landlord_key = reg.landlord_key_text
    LEFT JOIN active_dials ad ON ad.landlord_key = reg.landlord_key_text
    WHERE (
      (v_scope = 'live_plans' AND reg.active_rent_plans > 0)
      OR (v_scope = 'with_plans' AND (
        reg.active_rent_plans > 0
        OR reg.plan_rent_total > 0
        OR (reg.landlord_id IS NOT NULL AND EXISTS (SELECT 1 FROM plans_any pa WHERE pa.landlord_id = reg.landlord_id))
      ))
      OR (v_scope = 'all')
    )
    AND (
      v_region IS NULL
      OR lower(COALESCE(reg.region, '')) = lower(v_region)
    )
    AND (
      v_district IS NULL
      OR lower(COALESCE(reg.district, '')) = lower(v_district)
    )
    AND (
      v_agent IS NULL
      OR reg.registering_agent_id::text = v_agent
      OR lower(COALESCE(reg.registering_agent_name, '')) = lower(v_agent)
    )
    AND (
      v_verified = ''
      OR v_verified = 'all'
      OR (v_verified IN ('true', 'verified', 'yes', '1') AND reg.verification_status = 'verified')
      OR (v_verified IN ('false', 'unverified', 'no', '0') AND reg.verification_status <> 'verified')
    )
    AND (
      v_search = ''
      OR strpos(lower(COALESCE(reg.full_name, '')), v_search) > 0
      OR strpos(lower(COALESCE(reg.phones[1], '')), v_search) > 0
      OR strpos(lower(COALESCE(reg.district, '')), v_search) > 0
      OR strpos(lower(COALESCE(reg.registering_agent_name, '')), v_search) > 0
    )
  ),
  classified AS (
    SELECT
      s.*,
      CASE
        WHEN s.eff_last_result IN ('call_back', 'call_back_later', 'callback_booked') THEN 'call_back'
        WHEN s.eff_last_result IN (
          'answered', 'engaged', 'reached_ok', 'confirmed_payout_number',
          'wants_more_tenants', 'complaint', 'payout_issue', 'picked_up', 'called'
        ) THEN 'answered'
        WHEN s.eff_last_call_at IS NOT NULL THEN 'not_answered'
        ELSE 'never_called'
      END AS status_bucket
    FROM scoped_reg s
  ),
  filtered AS (
    SELECT
      c.*,
      count(*) OVER ()::bigint AS total_n
    FROM classified c
    WHERE (
      v_tab = 'all'
      OR (v_tab = 'call_back' AND c.status_bucket = 'call_back')
      OR (v_tab = 'answered' AND c.status_bucket = 'answered')
      OR (v_tab = 'not_answered' AND c.status_bucket = 'not_answered')
      OR (
        v_tab = 'to_call'
        AND (
          c.status_bucket = 'never_called'
          OR (c.status_bucket = 'not_answered' AND c.eff_last_call_at < (v_now - interval '7 days'))
        )
      )
    )
  )
  SELECT
    f.l_key AS landlord_key,
    f.landlord_id,
    f.user_id,
    f.landlord_name,
    CASE
      WHEN f.primary_phone IS NULL OR btrim(f.primary_phone) = '' THEN '—'
      WHEN v_unmasked THEN f.primary_phone
      ELSE public.crm_mask_phone(f.primary_phone)
    END AS phone,
    (NOT v_unmasked) AS phone_masked,
    f.region,
    f.district,
    f.agent_id,
    f.agent_name,
    f.is_verified AS verified,
    f.verification_status,
    f.houses_count,
    f.live_rent_plans,
    f.rent_plan_value,
    f.eff_last_call_at AS last_call_at,
    f.eff_last_result AS last_result,
    f.eff_last_caller_id AS last_caller_id,
    f.eff_last_caller_name AS last_caller_name,
    f.eff_call_back_due_at AS call_back_due_at,
    (f.eff_call_back_due_at IS NOT NULL AND f.eff_call_back_due_at < v_now) AS call_back_overdue,
    f.dial_caller_id AS being_called_by_id,
    f.dial_caller_name AS being_called_by,
    f.dial_started_at AS being_called_since,
    f.status_bucket AS hub_status,
    f.needs_review,
    f.total_n AS total_count
  FROM filtered f
  ORDER BY
    CASE WHEN v_sort IN ('call_back_due', 'callback_due') THEN f.eff_call_back_due_at END ASC NULLS LAST,
    CASE WHEN v_sort IN ('last_called', 'last_called_at', 'oldest_call_first') THEN f.eff_last_call_at END ASC NULLS FIRST,
    CASE WHEN v_sort IN ('newest_registration', 'registered_at') THEN f.registered_at END DESC NULLS LAST,
    CASE WHEN v_sort IN ('name', 'landlord_name') THEN lower(f.landlord_name) END ASC NULLS LAST,
    f.rent_plan_value DESC NULLS LAST,
    f.live_rent_plans DESC NULLS LAST,
    f.l_key ASC
  LIMIT v_limit
  OFFSET v_offset;
END;
$function$;

REVOKE ALL ON FUNCTION public.landlord_hub_list(text, text, text, text, text, text, text, text, integer, integer) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.landlord_hub_list(text, text, text, text, text, text, text, text, integer, integer) TO authenticated;

CREATE OR REPLACE FUNCTION public.landlord_hub_detail(
  p_landlord_key text
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_key        text := btrim(COALESCE(p_landlord_key, ''));
  v_unmasked   boolean;
  v_reg        record;
  v_ll         record;
  v_ll_id      uuid;
  v_agent      jsonb;
  v_caretaker  jsonb;
  v_payout_det jsonb;
  v_houses     jsonb;
  v_plans      jsonb;
  v_payouts    jsonb;
  v_history    jsonb;
  v_active_d   jsonb;
BEGIN
  IF NOT public._landlord_hub_can_read() THEN
    RAISE EXCEPTION 'NOT_AUTHORISED: you are not authorised to view landlord calling details'
      USING ERRCODE = '42501';
  END IF;

  IF v_key = '' THEN
    RAISE EXCEPTION 'LANDLORD_REQUIRED: p_landlord_key is required'
      USING ERRCODE = '22023';
  END IF;

  v_unmasked := public._landlord_cc_can_view_unmasked_phone();

  SELECT *
    INTO v_reg
  FROM public.mv_landlord_hub_registry r
  WHERE r.landlord_key_text = v_key
  LIMIT 1;

  IF v_reg.landlord_key IS NULL THEN
    RAISE EXCEPTION 'LANDLORD_NOT_FOUND: landlord % not found in registry', v_key
      USING ERRCODE = '22023';
  END IF;

  v_ll_id := v_reg.landlord_id;

  IF v_ll_id IS NOT NULL THEN
    SELECT * INTO v_ll
    FROM public.landlords l
    WHERE l.id = v_ll_id;
  END IF;

  SELECT jsonb_build_object(
    'agent_id', p.id,
    'full_name', p.full_name,
    'phone', CASE
      WHEN p.phone IS NULL OR btrim(p.phone) = '' THEN NULL
      WHEN v_unmasked THEN p.phone
      ELSE public.crm_mask_phone(p.phone)
    END
  )
  INTO v_agent
  FROM public.profiles p
  WHERE p.id = v_reg.registering_agent_id;

  SELECT jsonb_build_object(
    'name', COALESCE(
      NULLIF(btrim(v_ll.caretaker_name), ''),
      (SELECT NULLIF(btrim(hl.caretaker_name), '') FROM public.house_listings hl WHERE hl.landlord_id = v_ll_id AND NULLIF(btrim(hl.caretaker_name), '') IS NOT NULL ORDER BY hl.created_at DESC LIMIT 1)
    ),
    'phone', CASE
      WHEN COALESCE(
        NULLIF(btrim(v_ll.caretaker_phone), ''),
        (SELECT NULLIF(btrim(hl.caretaker_phone), '') FROM public.house_listings hl WHERE hl.landlord_id = v_ll_id AND NULLIF(btrim(hl.caretaker_phone), '') IS NOT NULL ORDER BY hl.created_at DESC LIMIT 1)
      ) IS NULL THEN NULL
      WHEN v_unmasked THEN COALESCE(
        NULLIF(btrim(v_ll.caretaker_phone), ''),
        (SELECT NULLIF(btrim(hl.caretaker_phone), '') FROM public.house_listings hl WHERE hl.landlord_id = v_ll_id AND NULLIF(btrim(hl.caretaker_phone), '') IS NOT NULL ORDER BY hl.created_at DESC LIMIT 1)
      )
      ELSE public.crm_mask_phone(COALESCE(
        NULLIF(btrim(v_ll.caretaker_phone), ''),
        (SELECT NULLIF(btrim(hl.caretaker_phone), '') FROM public.house_listings hl WHERE hl.landlord_id = v_ll_id AND NULLIF(btrim(hl.caretaker_phone), '') IS NOT NULL ORDER BY hl.created_at DESC LIMIT 1)
      ))
    END
  ) INTO v_caretaker;

  v_payout_det := jsonb_build_object(
    'mobile_money_number', CASE
      WHEN COALESCE(v_ll.mobile_money_number, v_ll.phone, v_reg.phones[1]) IS NULL THEN NULL
      WHEN v_unmasked THEN COALESCE(v_ll.mobile_money_number, v_ll.phone, v_reg.phones[1])
      ELSE public.crm_mask_phone(COALESCE(v_ll.mobile_money_number, v_ll.phone, v_reg.phones[1]))
    END,
    'mobile_money_name', v_ll.mobile_money_name,
    'verified_mobile_money_number', CASE
      WHEN v_ll.verified_mobile_money_number IS NULL THEN NULL
      WHEN v_unmasked THEN v_ll.verified_mobile_money_number
      ELSE public.crm_mask_phone(v_ll.verified_mobile_money_number)
    END,
    'bank_name', v_ll.bank_name,
    'bank_branch', v_ll.bank_branch,
    'account_number', CASE
      WHEN v_ll.account_number IS NULL THEN NULL
      WHEN v_unmasked THEN v_ll.account_number
      ELSE public.crm_mask_phone(v_ll.account_number)
    END,
    'bank_account_name', v_ll.bank_account_name,
    'total_paid_out_ugx', COALESCE(v_reg.total_paid_out_ugx, 0),
    'last_payout_at', v_reg.last_payout_at
  );

  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'id', hl.id,
      'title', COALESCE(NULLIF(btrim(hl.title), ''), NULLIF(btrim(hl.address), ''), 'House Listing'),
      'address', hl.address,
      'region', hl.region,
      'district', hl.district,
      'village', hl.village,
      'house_category', hl.house_category,
      'number_of_rooms', hl.number_of_rooms,
      'monthly_rent', COALESCE(hl.monthly_rent, 0),
      'daily_rate', COALESCE(hl.daily_rate, 0),
      'status', COALESCE(hl.status, 'listed'),
      'verified', COALESCE(hl.verified, false),
      'caretaker_name', hl.caretaker_name,
      'created_at', hl.created_at
    ) ORDER BY hl.created_at DESC
  ), '[]'::jsonb)
  INTO v_houses
  FROM public.house_listings hl
  WHERE v_ll_id IS NOT NULL
    AND hl.landlord_id = v_ll_id
    AND COALESCE(hl.status, '') NOT IN ('rejected', 'delisted');

  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'rent_request_id', rr.id,
      'tenant_id', rr.tenant_id,
      'tenant_name', COALESCE(NULLIF(btrim(tp.full_name), ''), 'Unnamed Tenant'),
      'tenant_phone', CASE
        WHEN tp.phone IS NULL OR btrim(tp.phone) = '' THEN NULL
        WHEN v_unmasked THEN tp.phone
        ELSE public.crm_mask_phone(tp.phone)
      END,
      'status', rr.status,
      'rent_amount', COALESCE(rr.rent_amount, 0),
      'daily_repayment', COALESCE(rr.daily_repayment, 0),
      'total_repayment', COALESCE(rr.total_repayment, 0),
      'amount_repaid', COALESCE(rr.amount_repaid, 0),
      'outstanding', CASE
        WHEN rr.status IN ('rejected', 'cancelled', 'deleted_by_agent') THEN 0::numeric
        ELSE GREATEST(COALESCE(rr.total_repayment, 0) - COALESCE(rr.amount_repaid, 0), 0)
      END,
      'agent_id', COALESCE(rr.assigned_agent_id, rr.agent_id),
      'agent_name', ap.full_name,
      'funded_at', rr.funded_at,
      'created_at', rr.created_at
    ) ORDER BY rr.created_at DESC, rr.id
  ), '[]'::jsonb)
  INTO v_plans
  FROM public.rent_requests rr
  LEFT JOIN public.profiles tp ON tp.id = rr.tenant_id
  LEFT JOIN public.profiles ap ON ap.id = COALESCE(rr.assigned_agent_id, rr.agent_id)
  WHERE v_ll_id IS NOT NULL
    AND rr.landlord_id = v_ll_id;

  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'id', p.id,
      'source', p.source,
      'amount', p.amount,
      'status', p.status,
      'paid_at', p.paid_at,
      'rent_request_id', p.rent_request_id,
      'reference', p.reference
    ) ORDER BY p.paid_at DESC NULLS LAST
  ), '[]'::jsonb)
  INTO v_payouts
  FROM (
    SELECT
      lp.id,
      'landlord_payout'::text AS source,
      COALESCE(lp.amount, 0)::numeric AS amount,
      lp.status,
      COALESCE(lp.finops_disbursed_at, lp.disbursed_at, lp.created_at) AS paid_at,
      lp.rent_request_id,
      COALESCE(lp.finops_momo_reference, lp.external_reference, lp.receipt_number) AS reference
    FROM public.landlord_payouts lp
    WHERE v_ll_id IS NOT NULL
      AND lp.landlord_id = v_ll_id
    UNION ALL
    SELECT
      alfa.id,
      'float_allocation'::text AS source,
      COALESCE(alfa.paid_out_amount, 0)::numeric AS amount,
      alfa.status,
      alfa.updated_at AS paid_at,
      alfa.rent_request_id,
      alfa.funding_reference AS reference
    FROM public.agent_landlord_float_allocations alfa
    WHERE v_ll_id IS NOT NULL
      AND alfa.landlord_id = v_ll_id
      AND alfa.status <> 'cancelled'
      AND COALESCE(alfa.paid_out_amount, 0) > 0
  ) p;

  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'call_id', h.call_id,
      'source', h.source,
      'called_at', h.called_at,
      'dial_started_at', h.dial_started_at,
      'caller_id', h.caller_id,
      'caller_name', h.caller_name,
      'caller_team', h.caller_team,
      'phone_dialed', CASE
        WHEN h.phone_dialed IS NULL OR btrim(h.phone_dialed) = '' THEN NULL
        WHEN v_unmasked THEN h.phone_dialed
        ELSE public.crm_mask_phone(h.phone_dialed)
      END,
      'result', h.result,
      'call_back_at', h.call_back_at,
      'aware_30m', h.aware_30m,
      'landlord_consent', h.landlord_consent,
      'aware_payout_otp', h.aware_payout_otp,
      'explained', h.explained,
      'feedback_category', h.feedback_category,
      'severity', h.severity,
      'note', h.note,
      'tenants_discussed', h.tenants_discussed,
      'rent_request_id', h.rent_request_id,
      'is_amended', h.is_amended,
      'amended_at', h.amended_at,
      'amendment_reason', h.amendment_reason
    ) ORDER BY h.called_at DESC NULLS LAST, h.call_id DESC
  ), '[]'::jsonb)
  INTO v_history
  FROM (
    SELECT
      c.id AS call_id,
      'calling_hub'::text AS source,
      c.recorded_at AS called_at,
      c.dial_started_at,
      c.caller_id,
      COALESCE(NULLIF(btrim(cp.full_name), ''), 'Landlord Ops officer') AS caller_name,
      c.caller_team,
      c.phone_dialed,
      c.result,
      c.call_back_at,
      c.aware_30m,
      c.landlord_consent,
      c.aware_payout_otp,
      c.explained,
      c.feedback_category,
      c.severity,
      c.note,
      to_jsonb(c.tenants_discussed) AS tenants_discussed,
      NULL::uuid AS rent_request_id,
      c.is_amended,
      c.amended_at,
      c.amendment_reason
    FROM public.v_landlord_calls_effective c
    LEFT JOIN public.profiles cp ON cp.id = c.caller_id
    WHERE c.voided_at IS NULL
      AND (
        c.landlord_key = v_key
        OR (v_ll_id IS NOT NULL AND c.landlord_id = v_ll_id)
      )

    UNION ALL

    SELECT
      w.id AS call_id,
      'awareness'::text AS source,
      COALESCE(w.recorded_at, w.dial_started_at) AS called_at,
      w.dial_started_at,
      w.caller_id,
      COALESCE(NULLIF(btrim(wp.full_name), ''), 'Pipeline officer') AS caller_name,
      w.caller_team,
      w.subject_phone AS phone_dialed,
      w.call_result AS result,
      NULL::timestamptz AS call_back_at,
      w.aware_30m,
      w.landlord_consent,
      w.aware_payout_otp,
      w.explained,
      NULL::text AS feedback_category,
      NULL::text AS severity,
      w.note,
      to_jsonb(ARRAY[w.rent_request_id]) AS tenants_discussed,
      w.rent_request_id,
      false AS is_amended,
      NULL::timestamptz AS amended_at,
      NULL::text AS amendment_reason
    FROM public.rent_pipeline_awareness_calls w
    LEFT JOIN public.rent_requests wrr ON wrr.id = w.rent_request_id
    LEFT JOIN public.profiles wp ON wp.id = w.caller_id
    WHERE w.subject_type = 'landlord'
      AND (
        w.subject_user_id::text = v_key
        OR (v_ll_id IS NOT NULL AND (w.subject_user_id = v_ll_id OR wrr.landlord_id = v_ll_id))
        OR (v_reg.user_id IS NOT NULL AND w.subject_user_id = v_reg.user_id)
      )

    UNION ALL

    SELECT
      rr.id AS call_id,
      'verification'::text AS source,
      rr.landlord_ops_reviewed_at AS called_at,
      rr.landlord_ops_reviewed_at AS dial_started_at,
      rr.landlord_ops_reviewed_by AS caller_id,
      COALESCE(NULLIF(btrim(vp.full_name), ''), 'Landlord Ops officer') AS caller_name,
      'landlord_ops'::text AS caller_team,
      COALESCE(v_ll.phone, v_reg.phones[1]) AS phone_dialed,
      CASE WHEN COALESCE(rr.landlord_acknowledged, false) THEN 'answered' ELSE 'no_answer' END AS result,
      NULL::timestamptz AS call_back_at,
      NULL::text AS aware_30m,
      NULL::text AS landlord_consent,
      NULL::text AS aware_payout_otp,
      NULL::text AS explained,
      CASE WHEN COALESCE(rr.landlord_acknowledged, false) THEN 'reached_ok' ELSE NULL END AS feedback_category,
      NULL::text AS severity,
      rr.landlord_call_notes AS note,
      to_jsonb(ARRAY[rr.id]) AS tenants_discussed,
      rr.id AS rent_request_id,
      false AS is_amended,
      NULL::timestamptz AS amended_at,
      NULL::text AS amendment_reason
    FROM public.rent_requests rr
    LEFT JOIN public.profiles vp ON vp.id = rr.landlord_ops_reviewed_by
    WHERE v_ll_id IS NOT NULL
      AND rr.landlord_id = v_ll_id
      AND rr.landlord_called IS TRUE
      AND rr.landlord_verification_method = 'phone_call'
      AND rr.landlord_ops_reviewed_at IS NOT NULL
  ) h;

  SELECT jsonb_build_object(
    'dial_id', d.id,
    'caller_id', d.caller_id,
    'caller_name', COALESCE(NULLIF(btrim(dp.full_name), ''), 'Landlord Ops officer'),
    'started_at', d.started_at,
    'expires_at', d.expires_at
  )
  INTO v_active_d
  FROM public.landlord_call_dials d
  LEFT JOIN public.profiles dp ON dp.id = d.caller_id
  WHERE d.landlord_key = v_key
    AND d.call_id IS NULL
    AND d.expires_at > now()
  ORDER BY d.started_at DESC
  LIMIT 1;

  RETURN jsonb_build_object(
    'landlord_key', v_key,
    'landlord_id', v_ll_id,
    'user_id', v_reg.user_id,
    'landlord_name', COALESCE(NULLIF(btrim(v_reg.full_name), ''), 'Unnamed Landlord'),
    'phones', COALESCE((
      SELECT jsonb_agg(
        CASE WHEN v_unmasked THEN ph ELSE public.crm_mask_phone(ph) END
      )
      FROM unnest(COALESCE(v_reg.phones, ARRAY[]::text[])) AS ph
    ), '[]'::jsonb),
    'phone_masked', (NOT v_unmasked),
    'region', v_reg.region,
    'district', v_reg.district,
    'village', v_ll.village,
    'property_address', v_ll.property_address,
    'verified', (v_reg.verification_status = 'verified'),
    'verification_status', v_reg.verification_status,
    'needs_review', COALESCE(v_reg.needs_review, false),
    'registered_at', v_reg.registered_at,
    'houses_count', COALESCE(v_reg.houses_count, 0),
    'live_rent_plans', COALESCE(v_reg.active_rent_plans, 0),
    'rent_plan_value', COALESCE(v_reg.plan_rent_total, 0),
    'registering_agent', v_agent,
    'caretaker', v_caretaker,
    'payout_details', v_payout_det,
    'houses', v_houses,
    'tenants_and_plans', v_plans,
    'payouts', v_payouts,
    'call_history', v_history,
    'active_dial', v_active_d
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.landlord_hub_detail(text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.landlord_hub_detail(text) TO authenticated;

CREATE OR REPLACE FUNCTION public.landlord_hub_stats()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_now                 timestamptz := now();
  v_kampala_today       date := (v_now AT TIME ZONE 'Africa/Kampala')::date;
  v_today_start         timestamptz := (v_kampala_today::timestamp AT TIME ZONE 'Africa/Kampala');
  v_dow                 int := extract(dow FROM v_kampala_today)::int;
  v_week_start_date     date := v_kampala_today - ((v_dow - 3 + 7) % 7);
  v_week_start          timestamptz := (v_week_start_date::timestamp AT TIME ZONE 'Africa/Kampala');
  v_calls_today         integer := 0;
  v_answered_today      integer := 0;
  v_answered_rate       numeric := 0;
  v_callbacks_due       integer := 0;
  v_callbacks_overdue   integer := 0;
  v_live_total          integer := 0;
  v_live_never_called   integer := 0;
  v_reached_this_week   integer := 0;
BEGIN
  IF NOT public._landlord_hub_can_read() THEN
    RAISE EXCEPTION 'NOT_AUTHORISED: you are not authorised to view Landlord Calling Hub stats'
      USING ERRCODE = '42501';
  END IF;

  SELECT
    count(*)::integer,
    count(*) FILTER (WHERE c.result = 'answered')::integer
  INTO v_calls_today, v_answered_today
  FROM public.v_landlord_calls_effective c
  WHERE c.voided_at IS NULL
    AND c.recorded_at >= v_today_start;

  IF v_calls_today > 0 THEN
    v_answered_rate := round((v_answered_today::numeric * 100.0) / v_calls_today, 1);
  ELSE
    v_answered_rate := 0;
  END IF;

  WITH latest_hub AS (
    SELECT DISTINCT ON (c.landlord_key)
      c.landlord_key,
      c.result,
      c.call_back_at
    FROM public.v_landlord_calls_effective c
    WHERE c.voided_at IS NULL
    ORDER BY c.landlord_key, c.recorded_at DESC, c.id DESC
  )
  SELECT
    count(*) FILTER (WHERE lh.result = 'call_back')::integer,
    count(*) FILTER (WHERE lh.result = 'call_back' AND lh.call_back_at IS NOT NULL AND lh.call_back_at < v_now)::integer
  INTO v_callbacks_due, v_callbacks_overdue
  FROM latest_hub lh;

  SELECT
    count(*)::integer,
    count(*) FILTER (
      WHERE reg.last_called_at IS NULL
        AND NOT EXISTS (
          SELECT 1
          FROM public.v_landlord_calls_effective c
          WHERE c.voided_at IS NULL
            AND c.landlord_key = reg.landlord_key_text
        )
    )::integer
  INTO v_live_total, v_live_never_called
  FROM public.mv_landlord_hub_registry reg
  WHERE reg.active_rent_plans > 0;

  SELECT count(DISTINCT reached_key)::integer
    INTO v_reached_this_week
  FROM (
    SELECT c.landlord_key AS reached_key
    FROM public.v_landlord_calls_effective c
    WHERE c.voided_at IS NULL
      AND c.recorded_at >= v_week_start
      AND c.result IN ('answered', 'call_back')
    UNION
    SELECT COALESCE(w.subject_user_id, rr.landlord_id)::text AS reached_key
    FROM public.rent_pipeline_awareness_calls w
    LEFT JOIN public.rent_requests rr ON rr.id = w.rent_request_id
    WHERE w.subject_type = 'landlord'
      AND w.call_result = 'answered'
      AND COALESCE(w.recorded_at, w.dial_started_at) >= v_week_start
      AND COALESCE(w.subject_user_id, rr.landlord_id) IS NOT NULL
    UNION
    SELECT q.landlord_id::text AS reached_key
    FROM public.rent_requests q
    WHERE q.landlord_id IS NOT NULL
      AND q.landlord_called IS TRUE
      AND q.landlord_verification_method = 'phone_call'
      AND COALESCE(q.landlord_acknowledged, false) IS TRUE
      AND q.landlord_ops_reviewed_at >= v_week_start
  ) wk
  WHERE reached_key IS NOT NULL;

  RETURN jsonb_build_object(
    'calls_today', v_calls_today,
    'answered_today', v_answered_today,
    'answered_rate_pct', v_answered_rate,
    'call_backs_due', v_callbacks_due,
    'call_backs_overdue', v_callbacks_overdue,
    'live_plan_landlords_total', v_live_total,
    'live_plan_landlords_never_called', v_live_never_called,
    'landlords_reached_this_week', v_reached_this_week,
    'week_start', v_week_start_date,
    'kampala_today', v_kampala_today
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.landlord_hub_stats() FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.landlord_hub_stats() TO authenticated;
