-- =============================================================================
-- Migration: 20261023120000_landlord_calling_center_foundation.sql
-- Purpose:   Server-side foundation for the Landlord Ops Calling Center.
--            Reuses the shared calling engine (cc_*) without modifying any
--            tenant populations, tenant sort/filter rows, TenantCallingCenter,
--            tenant reports, or existing function signatures/outputs.
--            No money movement, no wallet/ledger/payout/Rent Plan writes.
-- =============================================================================

-- 0. Ensure 42P10 migration-history idempotency constraint exists
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'supabase_migrations'
      AND table_name = 'schema_migrations'
      AND column_name = 'idempotency_key'
  ) AND NOT EXISTS (
    SELECT 1
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
    WHERE nsp.nspname = 'supabase_migrations'
      AND rel.relname = 'schema_migrations'
      AND con.contype = 'u'
      AND pg_get_constraintdef(con.oid) LIKE '%(idempotency_key)%'
  ) THEN
    ALTER TABLE supabase_migrations.schema_migrations
      ADD CONSTRAINT schema_migrations_idempotency_key_key UNIQUE (idempotency_key);
  END IF;
END
$$;

-- 1. Role-gate helper for Landlord Calling Center RPCs & policies
CREATE OR REPLACE FUNCTION public._landlord_cc_staff_ok()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT auth.uid() IS NOT NULL AND (
    public._am_staff_ok()
    OR public.has_role(auth.uid(), 'landlord_ops'::app_role)
    OR public.has_role(auth.uid(), 'hr'::app_role)
    OR public.cc_queue_access_allowed('landlord'::cc_subject_type)
  );
$$;

REVOKE ALL ON FUNCTION public._landlord_cc_staff_ok() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public._landlord_cc_staff_ok() TO authenticated, service_role;

-- 2. Fast inlineable SQL phone normalizer (256XXXXXXXXX)
CREATE OR REPLACE FUNCTION public.normalize_landlord_phone_256(raw text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = public
AS $$
  SELECT CASE
    WHEN raw IS NULL THEN NULL
    WHEN length(regexp_replace(raw, '\D', '', 'g')) >= 9
         AND right(regexp_replace(raw, '\D', '', 'g'), 9) <> '000000000'
      THEN '256' || right(regexp_replace(raw, '\D', '', 'g'), 9)
    ELSE NULL
  END;
$$;

REVOKE ALL ON FUNCTION public.normalize_landlord_phone_256(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.normalize_landlord_phone_256(text) TO authenticated, service_role;

-- 3. Unified Landlord Registry View: public.v_landlord_registry_all
--    Unions public.landlords, public.user_roles (role='landlord', including
--    disabled and flagged), and landlord phones from rent_requests / float
--    allocations / payouts.
--    Dedupes by linked user_id, then normalized phone (256XXXXXXXXX).
--    Unclear matches get needs_review = true and are never guess-merged.
CREATE OR REPLACE VIEW public.v_landlord_registry_all
WITH (security_invoker = true)
AS
WITH raw_union AS (
  -- Source A: public.landlords
  SELECT
    'll'::text AS src,
    l.id AS raw_id,
    l.id AS landlord_id,
    NULL::uuid AS user_id,
    NULLIF(btrim(COALESCE(l.name, '')), '') AS full_name,
    lower(regexp_replace(btrim(COALESCE(l.name, '')), '\s+', ' ', 'g')) AS norm_name,
    CASE
      WHEN length(dg.p_digits) >= 9 AND right(dg.p_digits, 9) <> '000000000'
        THEN '256' || right(dg.p_digits, 9)
      ELSE NULL
    END AS norm_phone,
    CASE
      WHEN length(dg.m_digits) >= 9 AND right(dg.m_digits, 9) <> '000000000'
        THEN '256' || right(dg.m_digits, 9)
      ELSE NULL
    END AS norm_momo,
    NULLIF(btrim(COALESCE(l.region, '')), '') AS region,
    NULLIF(btrim(COALESCE(l.district, '')), '') AS district,
    COALESCE(l.registered_by, l.managed_by_agent_id) AS registering_agent_id,
    GREATEST(COALESCE(l.number_of_houses, 0), 0) AS declared_houses,
    GREATEST(COALESCE(l.monthly_rent, 0), 0)::numeric AS declared_monthly_rent,
    l.created_at AS registered_at,
    CASE
      WHEN l.verified IS TRUE OR lower(COALESCE(l.verification_status, '')) = 'verified' THEN 'verified'
      WHEN NULLIF(btrim(COALESCE(l.verification_status, '')), '') IS NOT NULL THEN lower(btrim(l.verification_status))
      ELSE 'unverified'
    END AS verification_status,
    false AS is_flagged,
    0::numeric AS orphan_paid_ugx,
    NULL::timestamptz AS orphan_last_payout_at
  FROM public.landlords l
  CROSS JOIN LATERAL (
    SELECT
      regexp_replace(COALESCE(l.phone, ''), '\D', '', 'g') AS p_digits,
      regexp_replace(COALESCE(l.mobile_money_number, ''), '\D', '', 'g') AS m_digits
  ) dg

  UNION ALL

  -- Source B: public.user_roles WHERE role = 'landlord' (deduped by user_id, including disabled/flagged)
  SELECT
    'ur'::text AS src,
    u.user_id AS raw_id,
    NULL::uuid AS landlord_id,
    u.user_id AS user_id,
    NULLIF(btrim(COALESCE(p.full_name, '')), '') AS full_name,
    lower(regexp_replace(btrim(COALESCE(p.full_name, '')), '\s+', ' ', 'g')) AS norm_name,
    CASE
      WHEN length(dg.p_digits) >= 9 AND right(dg.p_digits, 9) <> '000000000'
        THEN '256' || right(dg.p_digits, 9)
      ELSE NULL
    END AS norm_phone,
    CASE
      WHEN length(dg.m_digits) >= 9 AND right(dg.m_digits, 9) <> '000000000'
        THEN '256' || right(dg.m_digits, 9)
      ELSE NULL
    END AS norm_momo,
    NULLIF(btrim(COALESCE(p.region, '')), '') AS region,
    NULLIF(btrim(COALESCE(p.district, p.city, '')), '') AS district,
    COALESCE(p.referrer_id, p.managing_agent_id) AS registering_agent_id,
    0 AS declared_houses,
    0::numeric AS declared_monthly_rent,
    LEAST(COALESCE(p.created_at, u.role_created_at), COALESCE(u.role_created_at, p.created_at)) AS registered_at,
    CASE
      WHEN p.deleted_at IS NOT NULL THEN 'deleted'
      WHEN COALESCE(p.is_frozen, false) THEN 'frozen'
      WHEN u.all_disabled THEN 'disabled'
      WHEN COALESCE(p.verified, false) OR COALESCE(p.phone_verified, false) THEN 'verified'
      ELSE 'unverified'
    END AS verification_status,
    (p.deleted_at IS NOT NULL OR COALESCE(p.is_frozen, false) OR u.all_disabled) AS is_flagged,
    0::numeric AS orphan_paid_ugx,
    NULL::timestamptz AS orphan_last_payout_at
  FROM (
    SELECT
      ur.user_id,
      min(ur.created_at) AS role_created_at,
      bool_and(COALESCE(ur.enabled, true) = false) AS all_disabled
    FROM public.user_roles ur
    WHERE ur.role = 'landlord'::app_role
    GROUP BY ur.user_id
  ) u
  LEFT JOIN public.profiles p ON p.id = u.user_id
  CROSS JOIN LATERAL (
    SELECT
      regexp_replace(COALESCE(p.phone, ''), '\D', '', 'g') AS p_digits,
      regexp_replace(COALESCE(p.mobile_money_number, ''), '\D', '', 'g') AS m_digits
  ) dg

  UNION ALL

  -- Source C: landlord phones from rent_requests / float allocations / payouts with no landlord_id
  SELECT
    'rr'::text AS src,
    md5('welile:landlord_phone:' || o.norm_phone)::uuid AS raw_id,
    NULL::uuid AS landlord_id,
    NULL::uuid AS user_id,
    o.full_name,
    lower(regexp_replace(btrim(COALESCE(o.full_name, '')), '\s+', ' ', 'g')) AS norm_name,
    o.norm_phone,
    NULL::text AS norm_momo,
    NULL::text AS region,
    NULL::text AS district,
    o.registering_agent_id,
    0 AS declared_houses,
    0::numeric AS declared_monthly_rent,
    o.registered_at,
    'unverified'::text AS verification_status,
    false AS is_flagged,
    o.paid_out_ugx AS orphan_paid_ugx,
    o.last_payout_at AS orphan_last_payout_at
  FROM (
    SELECT
      norm_phone,
      max(landlord_name) AS full_name,
      (max(agent_id::text))::uuid AS registering_agent_id,
      min(created_at) AS registered_at,
      sum(paid_out_ugx)::numeric AS paid_out_ugx,
      max(last_payout_at) AS last_payout_at
    FROM (
      SELECT
        CASE WHEN length(regexp_replace(COALESCE(a.landlord_phone, ''), '\D', '', 'g')) >= 9
             THEN '256' || right(regexp_replace(COALESCE(a.landlord_phone, ''), '\D', '', 'g'), 9)
             ELSE NULL END AS norm_phone,
        NULLIF(btrim(COALESCE(a.landlord_name, '')), '') AS landlord_name,
        a.agent_id,
        a.created_at,
        CASE WHEN a.status <> 'cancelled' THEN COALESCE(a.paid_out_amount, 0) ELSE 0 END AS paid_out_ugx,
        CASE WHEN a.status <> 'cancelled' AND COALESCE(a.paid_out_amount, 0) > 0 THEN a.updated_at ELSE NULL END AS last_payout_at
      FROM public.agent_landlord_float_allocations a
      WHERE a.landlord_id IS NULL AND a.landlord_phone IS NOT NULL
      UNION ALL
      SELECT
        CASE WHEN length(regexp_replace(COALESCE(lp.landlord_phone, ''), '\D', '', 'g')) >= 9
             THEN '256' || right(regexp_replace(COALESCE(lp.landlord_phone, ''), '\D', '', 'g'), 9)
             ELSE NULL END AS norm_phone,
        NULLIF(btrim(COALESCE(lp.landlord_name, '')), '') AS landlord_name,
        lp.agent_id,
        lp.created_at,
        CASE WHEN lp.status <> 'failed' AND COALESCE(lp.finops_disbursed_at, lp.disbursed_at) IS NOT NULL THEN COALESCE(lp.amount, 0) ELSE 0 END AS paid_out_ugx,
        COALESCE(lp.finops_disbursed_at, lp.disbursed_at) AS last_payout_at
      FROM public.landlord_payouts lp
      WHERE lp.landlord_id IS NULL AND lp.landlord_phone IS NOT NULL
    ) x
    WHERE norm_phone IS NOT NULL AND right(norm_phone, 9) <> '000000000'
    GROUP BY norm_phone
  ) o
),
windowed AS (
  SELECT
    r.*,
    count(*) FILTER (WHERE r.src = 'll') OVER w AS ll_cnt,
    count(*) FILTER (WHERE r.src = 'ur') OVER w AS ur_cnt,
    (max(r.user_id::text) FILTER (WHERE r.src = 'ur') OVER w)::uuid AS peer_user_id,
    max(r.norm_name) FILTER (WHERE r.src = 'll') OVER w AS peer_ll_norm_name,
    max(r.norm_name) FILTER (WHERE r.src = 'ur') OVER w AS peer_ur_norm_name,
    max(r.full_name) FILTER (WHERE r.src = 'ur') OVER w AS peer_ur_full_name,
    max(r.norm_momo) FILTER (WHERE r.src = 'ur') OVER w AS peer_ur_momo,
    max(r.region) FILTER (WHERE r.src = 'ur') OVER w AS peer_ur_region,
    max(r.district) FILTER (WHERE r.src = 'ur') OVER w AS peer_ur_district,
    (max(r.registering_agent_id::text) FILTER (WHERE r.src = 'ur') OVER w)::uuid AS peer_ur_agent_id,
    min(r.registered_at) FILTER (WHERE r.src = 'ur') OVER w AS peer_ur_registered_at,
    max(r.verification_status) FILTER (WHERE r.src = 'ur') OVER w AS peer_ur_vstatus,
    bool_or(r.is_flagged) FILTER (WHERE r.src = 'ur') OVER w AS peer_ur_flagged,
    COALESCE(max(r.orphan_paid_ugx) FILTER (WHERE r.src = 'rr') OVER w, 0) AS peer_orphan_paid_ugx,
    max(r.orphan_last_payout_at) FILTER (WHERE r.src = 'rr') OVER w AS peer_orphan_last_payout_at
  FROM raw_union r
  WINDOW w AS (PARTITION BY COALESCE(r.norm_phone, r.src || ':' || r.raw_id::text))
),
deduped AS (
  SELECT
    w.raw_id AS landlord_key,
    w.landlord_id,
    CASE
      WHEN w.src = 'll' AND w.norm_phone IS NOT NULL AND w.ll_cnt = 1 AND w.ur_cnt = 1
           AND (w.peer_ll_norm_name = w.peer_ur_norm_name OR w.peer_ll_norm_name = '' OR w.peer_ur_norm_name = '')
        THEN w.peer_user_id
      ELSE w.user_id
    END AS user_id,
    COALESCE(
      w.full_name,
      CASE WHEN w.src = 'll' AND w.ll_cnt = 1 AND w.ur_cnt = 1 THEN w.peer_ur_full_name END,
      'Unnamed Landlord'
    ) AS full_name,
    ARRAY_REMOVE(ARRAY[
      w.norm_phone,
      CASE WHEN w.norm_momo IS DISTINCT FROM w.norm_phone THEN w.norm_momo END,
      CASE
        WHEN w.src = 'll' AND w.norm_phone IS NOT NULL AND w.ll_cnt = 1 AND w.ur_cnt = 1
             AND (w.peer_ll_norm_name = w.peer_ur_norm_name OR w.peer_ll_norm_name = '' OR w.peer_ur_norm_name = '')
             AND w.peer_ur_momo IS DISTINCT FROM w.norm_phone
             AND w.peer_ur_momo IS DISTINCT FROM w.norm_momo
          THEN w.peer_ur_momo
      END
    ], NULL) AS base_phones,
    COALESCE(
      w.region,
      CASE WHEN w.src = 'll' AND w.ll_cnt = 1 AND w.ur_cnt = 1
                AND (w.peer_ll_norm_name = w.peer_ur_norm_name OR w.peer_ll_norm_name = '' OR w.peer_ur_norm_name = '')
           THEN w.peer_ur_region END
    ) AS region,
    COALESCE(
      w.district,
      CASE WHEN w.src = 'll' AND w.ll_cnt = 1 AND w.ur_cnt = 1
                AND (w.peer_ll_norm_name = w.peer_ur_norm_name OR w.peer_ll_norm_name = '' OR w.peer_ur_norm_name = '')
           THEN w.peer_ur_district END
    ) AS district,
    COALESCE(
      w.registering_agent_id,
      CASE WHEN w.src = 'll' AND w.ll_cnt = 1 AND w.ur_cnt = 1
                AND (w.peer_ll_norm_name = w.peer_ur_norm_name OR w.peer_ll_norm_name = '' OR w.peer_ur_norm_name = '')
           THEN w.peer_ur_agent_id END
    ) AS registering_agent_id,
    w.declared_houses,
    w.declared_monthly_rent,
    CASE
      WHEN w.src = 'll' AND w.ll_cnt = 1 AND w.ur_cnt = 1
           AND (w.peer_ll_norm_name = w.peer_ur_norm_name OR w.peer_ll_norm_name = '' OR w.peer_ur_norm_name = '')
           AND w.peer_ur_registered_at IS NOT NULL
        THEN LEAST(COALESCE(w.registered_at, w.peer_ur_registered_at), w.peer_ur_registered_at)
      ELSE w.registered_at
    END AS registered_at,
    CASE
      WHEN w.verification_status = 'verified' THEN 'verified'
      WHEN w.src = 'll' AND w.ll_cnt = 1 AND w.ur_cnt = 1
           AND (w.peer_ll_norm_name = w.peer_ur_norm_name OR w.peer_ll_norm_name = '' OR w.peer_ur_norm_name = '')
           AND w.peer_ur_vstatus IN ('deleted', 'frozen', 'disabled')
        THEN w.peer_ur_vstatus
      ELSE w.verification_status
    END AS verification_status,
    CASE
      WHEN w.src = 'rr' THEN true
      WHEN w.norm_phone IS NULL OR w.full_name IS NULL THEN true
      WHEN w.is_flagged THEN true
      WHEN w.ll_cnt > 1 OR w.ur_cnt > 1 THEN true
      WHEN w.ll_cnt = 1 AND w.ur_cnt = 1
           AND w.peer_ll_norm_name <> w.peer_ur_norm_name
           AND w.peer_ll_norm_name <> '' AND w.peer_ur_norm_name <> '' THEN true
      WHEN w.src = 'll' AND w.ll_cnt = 1 AND w.ur_cnt = 1 AND COALESCE(w.peer_ur_flagged, false) THEN true
      ELSE false
    END AS needs_review,
    GREATEST(w.orphan_paid_ugx, w.peer_orphan_paid_ugx) AS orphan_paid_ugx,
    GREATEST(w.orphan_last_payout_at, w.peer_orphan_last_payout_at) AS orphan_last_payout_at
  FROM windowed w
  WHERE
    (w.src = 'll')
    OR (
      w.src = 'ur'
      AND NOT (
        w.norm_phone IS NOT NULL
        AND w.ll_cnt = 1 AND w.ur_cnt = 1
        AND (w.peer_ll_norm_name = w.peer_ur_norm_name OR w.peer_ll_norm_name = '' OR w.peer_ur_norm_name = '')
      )
    )
    OR (
      w.src = 'rr'
      AND w.ll_cnt = 0 AND w.ur_cnt = 0
    )
),
houses_agg AS (
  SELECT
    hl.landlord_id,
    count(*)::integer AS listed_houses
  FROM public.house_listings hl
  WHERE hl.landlord_id IS NOT NULL
    AND COALESCE(hl.status, '') NOT IN ('rejected', 'delisted')
  GROUP BY hl.landlord_id
),
plans_agg AS (
  SELECT
    rr.landlord_id,
    count(*) FILTER (WHERE rr.status IN ('funded', 'repaying', 'active', 'disbursed'))::integer AS active_rent_plans,
    COALESCE(sum(COALESCE(rr.rent_amount, 0)) FILTER (WHERE rr.status NOT IN ('rejected', 'cancelled', 'deleted_by_agent')), 0)::numeric AS plan_rent_total,
    (array_agg(COALESCE(rr.assigned_agent_id, rr.agent_id) ORDER BY rr.created_at DESC) FILTER (WHERE COALESCE(rr.assigned_agent_id, rr.agent_id) IS NOT NULL))[1] AS latest_plan_agent_id
  FROM public.rent_requests rr
  WHERE rr.landlord_id IS NOT NULL
  GROUP BY rr.landlord_id
),
payouts_agg AS (
  SELECT
    landlord_id,
    GREATEST(COALESCE(max(lp_paid), 0), COALESCE(max(alp_paid), 0), COALESCE(max(alfa_paid), 0))::numeric AS total_paid_out_ugx,
    GREATEST(max(lp_at), max(alp_at), max(alfa_at)) AS last_payout_at
  FROM (
    SELECT
      lp.landlord_id,
      sum(COALESCE(lp.amount, 0)) AS lp_paid,
      max(COALESCE(lp.finops_disbursed_at, lp.disbursed_at)) AS lp_at,
      0::numeric AS alp_paid, NULL::timestamptz AS alp_at,
      0::numeric AS alfa_paid, NULL::timestamptz AS alfa_at
    FROM public.landlord_payouts lp
    WHERE lp.landlord_id IS NOT NULL
      AND lp.status <> 'failed'
      AND COALESCE(lp.finops_disbursed_at, lp.disbursed_at) IS NOT NULL
    GROUP BY lp.landlord_id
    UNION ALL
    SELECT
      alp.landlord_id,
      0::numeric, NULL::timestamptz,
      sum(COALESCE(alp.amount, 0)) AS alp_paid,
      max(alp.created_at) AS alp_at,
      0::numeric, NULL::timestamptz
    FROM public.agent_landlord_payouts alp
    WHERE alp.landlord_id IS NOT NULL
      AND COALESCE(alp.status, '') <> 'rejected'
    GROUP BY alp.landlord_id
    UNION ALL
    SELECT
      alfa.landlord_id,
      0::numeric, NULL::timestamptz,
      0::numeric, NULL::timestamptz,
      sum(COALESCE(alfa.paid_out_amount, 0)) AS alfa_paid,
      max(alfa.updated_at) AS alfa_at
    FROM public.agent_landlord_float_allocations alfa
    WHERE alfa.landlord_id IS NOT NULL
      AND alfa.status <> 'cancelled'
      AND COALESCE(alfa.paid_out_amount, 0) > 0
    GROUP BY alfa.landlord_id
  ) p
  GROUP BY landlord_id
),
calls_raw AS (
  SELECT
    r.subject_id,
    COALESCE(a.recorded_at, a.revealed_at, a.created_at) AS called_at,
    COALESCE(cat.code, a.outcome::text) AS call_outcome,
    a.caller_id
  FROM public.cc_call_attempts a
  JOIN public.cc_cycle_rows r ON r.id = a.cycle_row_id
  LEFT JOIN LATERAL (
    SELECT f.category_id
    FROM public.cc_feedback f
    WHERE f.attempt_id = a.id
    ORDER BY f.created_at DESC
    LIMIT 1
  ) fb ON true
  LEFT JOIN public.cc_feedback_categories cat ON cat.id = fb.category_id
  WHERE r.subject_type = 'landlord'::cc_subject_type
    AND a.void_reason IS NULL
    AND a.recorded_at IS NOT NULL

  UNION ALL

  SELECT
    lcr.landlord_id AS subject_id,
    lcr.called_at,
    lcr.status AS call_outcome,
    lcr.called_by AS caller_id
  FROM public.landlord_call_reports lcr
  WHERE lcr.landlord_id IS NOT NULL AND lcr.called_at IS NOT NULL

  UNION ALL

  SELECT
    COALESCE(w.subject_user_id, rr.landlord_id) AS subject_id,
    COALESCE(w.recorded_at, w.dial_started_at) AS called_at,
    w.call_result AS call_outcome,
    w.caller_id
  FROM public.rent_pipeline_awareness_calls w
  LEFT JOIN public.rent_requests rr ON rr.id = w.rent_request_id
  WHERE w.subject_type = 'landlord'
    AND COALESCE(w.subject_user_id, rr.landlord_id) IS NOT NULL
    AND COALESCE(w.recorded_at, w.dial_started_at) IS NOT NULL

  UNION ALL

  SELECT
    rr.landlord_id AS subject_id,
    rr.landlord_ops_reviewed_at AS called_at,
    CASE WHEN COALESCE(rr.landlord_acknowledged, false) THEN 'reached_ok' ELSE 'called' END AS call_outcome,
    rr.landlord_ops_reviewed_by AS caller_id
  FROM public.rent_requests rr
  WHERE rr.landlord_id IS NOT NULL
    AND rr.landlord_called IS TRUE
    AND rr.landlord_verification_method = 'phone_call'
    AND rr.landlord_ops_reviewed_at IS NOT NULL

  UNION ALL

  SELECT
    s.target_user_id AS subject_id,
    s.created_at AS called_at,
    CASE WHEN s.answered_at IS NOT NULL THEN 'engaged' ELSE COALESCE(s.status, 'no_answer') END AS call_outcome,
    s.staff_id AS caller_id
  FROM public.crm_call_sessions s
  WHERE s.target_role = 'landlord'
    AND s.target_user_id IS NOT NULL
    AND s.created_at IS NOT NULL
),
calls_dedup AS (
  SELECT DISTINCT ON (c.subject_id)
    c.subject_id,
    c.called_at AS last_called_at,
    c.call_outcome AS last_call_outcome,
    cp.full_name AS last_caller_name
  FROM calls_raw c
  LEFT JOIN public.profiles cp ON cp.id = c.caller_id
  ORDER BY c.subject_id, c.called_at DESC NULLS LAST
)
SELECT
  d.landlord_key,
  d.landlord_id,
  d.user_id,
  d.full_name,
  d.base_phones AS phones,
  d.region,
  d.district,
  COALESCE(d.registering_agent_id, pl.latest_plan_agent_id) AS registering_agent_id,
  ag.full_name AS registering_agent_name,
  GREATEST(COALESCE(h.listed_houses, 0), COALESCE(d.declared_houses, 0))::integer AS houses_count,
  COALESCE(pl.active_rent_plans, 0)::integer AS active_rent_plans,
  GREATEST(COALESCE(po.total_paid_out_ugx, 0), COALESCE(d.orphan_paid_ugx, 0))::numeric AS total_paid_out_ugx,
  GREATEST(po.last_payout_at, d.orphan_last_payout_at) AS last_payout_at,
  d.registered_at,
  d.verification_status,
  CASE
    WHEN ck.last_called_at IS NOT NULL AND cu.last_called_at IS NOT NULL THEN GREATEST(ck.last_called_at, cu.last_called_at)
    ELSE COALESCE(ck.last_called_at, cu.last_called_at)
  END AS last_called_at,
  CASE
    WHEN ck.last_called_at IS NOT NULL AND (cu.last_called_at IS NULL OR ck.last_called_at >= cu.last_called_at) THEN ck.last_call_outcome
    ELSE cu.last_call_outcome
  END AS last_call_outcome,
  CASE
    WHEN ck.last_called_at IS NOT NULL AND (cu.last_called_at IS NULL OR ck.last_called_at >= cu.last_called_at) THEN ck.last_caller_name
    ELSE cu.last_caller_name
  END AS last_caller_name,
  d.needs_review,
  GREATEST(COALESCE(pl.plan_rent_total, 0), COALESCE(d.declared_monthly_rent, 0))::numeric AS plan_rent_total
FROM deduped d
LEFT JOIN houses_agg h ON h.landlord_id = d.landlord_id
LEFT JOIN plans_agg pl ON pl.landlord_id = d.landlord_id
LEFT JOIN payouts_agg po ON po.landlord_id = d.landlord_id
LEFT JOIN public.profiles ag ON ag.id = COALESCE(d.registering_agent_id, pl.latest_plan_agent_id)
LEFT JOIN calls_dedup ck ON ck.subject_id = d.landlord_key
LEFT JOIN calls_dedup cu ON d.user_id IS NOT NULL AND d.user_id <> d.landlord_key AND cu.subject_id = d.user_id;

GRANT SELECT ON public.v_landlord_registry_all TO authenticated, service_role;

-- 4. Advisory caller assignment columns on cc_cycle_rows + side table
ALTER TABLE public.cc_cycle_rows
  ADD COLUMN IF NOT EXISTS assigned_caller_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS assigned_at timestamptz;

CREATE INDEX IF NOT EXISTS cc_cycle_rows_assigned_caller_idx
  ON public.cc_cycle_rows (cycle_id, assigned_caller_id)
  WHERE assigned_caller_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.landlord_cc_row_assignments (
  cycle_row_id uuid PRIMARY KEY REFERENCES public.cc_cycle_rows(id) ON DELETE CASCADE,
  cycle_id uuid NOT NULL REFERENCES public.cc_call_cycles(id) ON DELETE CASCADE,
  caller_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  assigned_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  assigned_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.landlord_cc_row_assignments TO authenticated;
GRANT ALL ON public.landlord_cc_row_assignments TO service_role;

ALTER TABLE public.landlord_cc_row_assignments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS landlord_cc_row_assignments_select ON public.landlord_cc_row_assignments;
CREATE POLICY landlord_cc_row_assignments_select
  ON public.landlord_cc_row_assignments
  FOR SELECT
  TO authenticated
  USING (public._landlord_cc_staff_ok());

DROP POLICY IF EXISTS landlord_cc_row_assignments_write ON public.landlord_cc_row_assignments;
CREATE POLICY landlord_cc_row_assignments_write
  ON public.landlord_cc_row_assignments
  FOR ALL
  TO authenticated
  USING (public._landlord_cc_staff_ok())
  WITH CHECK (public._landlord_cc_staff_ok());

-- 5. Extend v_cc_call_queue with landlord profile fallback and new trailing
--    landlord sort/filter columns (preserving all 45 existing columns in exact
--    order and types, and leaving tenant/agent behaviour 100% untouched).
CREATE OR REPLACE VIEW public.v_cc_call_queue
AS
SELECT
  r.cycle_id,
  r.id AS cycle_row_id,
  r.subject_type,
  r.subject_id,
  r.state,
  r.attempts_made,
  r.last_attempt_at,
  r.next_retry_at,
  r.callback_due_at,
  r.park_reason,
  r.priority_value,
  COALESCE(t.tenant_name, l.name, a.full_name, tpr.full_name, lpr.full_name) AS name,
  COALESCE(t.district, l.district, a.district, NULLIF(tpr.district, ''::text), NULLIF(lpr.district, ''::text)) AS district,
  COALESCE(t.region, l.region, a.region, NULLIF(tpr.region, ''::text), NULLIF(lpr.region, ''::text)) AS region,
  COALESCE(tap.full_name, lap.full_name, lrap.full_name) AS linked_agent_name,
  fb.feedback_category,
  fb.severity,
  fb.routed_to_name,
  fb.ticket_ref,
  fb.task_status,
  pk.fix_ticket_ref,
  cb.booked_by_name,
  t.arrears_amount,
  t.outstanding,
  t.schedule_delta_days,
  t.daily_repayment,
  t.days_since_funded,
  t.last_payment_at,
  l.monthly_rent,
  l.houses,
  l.empty_houses,
  l.plans,
  l.plan_rent_total,
  l.houses_monthly_rent,
  l.last_paid_at,
  adv.advance_outstanding,
  adv.advance_arrears,
  el.active_count AS active_tenants,
  mf.own_cash_outstanding,
  a.last_active_at,
  a.agent_tier,
  a.active_capability_count,
  tpr.preferred_language,
  t.next_due_date,
  CASE
    WHEN r.subject_type = 'tenant'::cc_subject_type THEN GREATEST(0, - t.schedule_delta_days)
    ELSE NULL::integer
  END AS days_behind,
  COALESCE(l.created_at, lpr.created_at) AS registered_at,
  COALESCE(r.last_attempt_at, lcs.last_call_at) AS last_called_at,
  COALESCE(lrap.full_name, lap.full_name) AS registering_agent_name,
  r.assigned_caller_id,
  acp.full_name AS assigned_caller_name
FROM public.cc_cycle_rows r
LEFT JOIN LATERAL (
  SELECT
    b.tenant_id,
    b.tenant_name,
    b.district,
    b.region,
    b.agent_id,
    b.arrears_amount,
    b.outstanding,
    b.schedule_delta_days,
    b.daily_repayment,
    b.days_since_funded,
    b.last_payment_at,
    b.next_due_date
  FROM public.v_tenant_ops_tenant_base b
  WHERE r.subject_type = 'tenant'::cc_subject_type AND b.tenant_id = r.subject_id
  ORDER BY b.funded_at DESC NULLS LAST, b.rent_request_id
  LIMIT 1
) t ON true
LEFT JOIN LATERAL (
  SELECT
    l2.name,
    l2.district,
    l2.region,
    l2.monthly_rent,
    l2.houses,
    l2.empty_houses,
    l2.plans,
    l2.plan_rent_total,
    l2.houses_monthly_rent,
    l2.last_paid_at,
    l2.managed_by_agent_id,
    l2.registered_by,
    l2.created_at
  FROM public.v_landlord_calling_base l2
  WHERE r.subject_type = 'landlord'::cc_subject_type AND l2.landlord_id = r.subject_id
  LIMIT 1
) l ON true
LEFT JOIN LATERAL (
  SELECT
    a2.full_name,
    a2.district,
    a2.region,
    a2.last_active_at,
    a2.agent_tier,
    a2.active_capability_count
  FROM public.vw_agent_ops_directory a2
  WHERE r.subject_type = 'agent'::cc_subject_type AND a2.agent_id = r.subject_id
  LIMIT 1
) a ON true
LEFT JOIN public.profiles tap ON tap.id = t.agent_id
LEFT JOIN public.profiles lap ON lap.id = l.managed_by_agent_id
LEFT JOIN public.profiles tpr ON r.subject_type = 'tenant'::cc_subject_type AND tpr.id = r.subject_id
LEFT JOIN public.profiles lpr ON r.subject_type = 'landlord'::cc_subject_type AND lpr.id = r.subject_id
LEFT JOIN public.profiles lrap ON r.subject_type = 'landlord'::cc_subject_type
  AND lrap.id = COALESCE(l.registered_by, l.managed_by_agent_id, lpr.referrer_id, lpr.managing_agent_id)
LEFT JOIN public.v_landlord_call_summary lcs ON r.subject_type = 'landlord'::cc_subject_type AND lcs.landlord_id = r.subject_id
LEFT JOIN public.profiles acp ON acp.id = r.assigned_caller_id
LEFT JOIN LATERAL (
  SELECT
    sum(aa.outstanding_balance) AS advance_outstanding,
    sum(aa.arrears_balance) AS advance_arrears
  FROM public.agent_advances aa
  WHERE r.subject_type = 'agent'::cc_subject_type
    AND aa.agent_id = r.subject_id
    AND COALESCE(aa.status, ''::text) <> 'cancelled'::text
    AND aa.reversed_at IS NULL
) adv ON true
LEFT JOIN LATERAL (
  SELECT sum(m.own_cash_outstanding) AS own_cash_outstanding
  FROM public.v_merchant_float_position m
  WHERE r.subject_type = 'agent'::cc_subject_type AND m.agent_id = r.subject_id
) mf ON true
LEFT JOIN LATERAL (
  SELECT e.active_count
  FROM public.v_agent_daily_eligibility e
  WHERE r.subject_type = 'agent'::cc_subject_type AND e.agent_id = r.subject_id
  LIMIT 1
) el ON true
LEFT JOIN LATERAL (
  SELECT
    cat.label AS feedback_category,
    f.severity,
    sp.full_name AS routed_to_name,
    tk.ref AS ticket_ref,
    tsk.status::text AS task_status
  FROM public.cc_call_attempts at2
  JOIN public.cc_feedback f ON f.attempt_id = at2.id
  LEFT JOIN public.cc_feedback_categories cat ON cat.id = f.category_id
  LEFT JOIN public.hr_staff st ON st.id = COALESCE(f.routed_to_actual, f.routed_to_expected)
  LEFT JOIN public.profiles sp ON sp.id = st.user_id
  LEFT JOIN public.hr_tickets tk ON tk.id = f.ticket_id
  LEFT JOIN public.hr_tasks tsk ON tsk.id = tk.task_id
  WHERE at2.cycle_row_id = r.id
  ORDER BY f.created_at DESC
  LIMIT 1
) fb ON true
LEFT JOIN LATERAL (
  SELECT tk2.ref AS fix_ticket_ref
  FROM public.hr_tickets tk2
  JOIN public.cc_call_attempts at3 ON at3.id = tk2.call_attempt_id
  WHERE at3.cycle_row_id = r.id AND tk2.severity_basis = 'Call centre parked row'::text
  ORDER BY tk2.raised_at DESC
  LIMIT 1
) pk ON true
LEFT JOIN LATERAL (
  SELECT p.full_name AS booked_by_name
  FROM public.cc_call_attempts at4
  LEFT JOIN public.profiles p ON p.id = at4.caller_id
  WHERE at4.cycle_row_id = r.id AND at4.outcome = 'callback_booked'::cc_attempt_outcome
  ORDER BY at4.recorded_at DESC NULLS LAST
  LIMIT 1
) cb ON true;

GRANT SELECT ON public.v_cc_call_queue TO authenticated, service_role;

-- 6. Landlord Calling Center populations (subject_type = 'landlord' ONLY)
INSERT INTO public.cc_cycle_populations (
  subject_type, code, label, source_view, subject_id_column, priority_column, filter_sql, max_rows, active
)
VALUES
  ('landlord'::cc_subject_type, 'landlords_registry_all',   'All registered landlords',          'v_landlord_registry_all', 'landlord_key', 'plan_rent_total',   NULL,                                                                NULL, true),
  ('landlord'::cc_subject_type, 'landlords_never_called',   'Landlords never called',            'v_landlord_registry_all', 'landlord_key', 'plan_rent_total',   'last_called_at IS NULL',                                            NULL, true),
  ('landlord'::cc_subject_type, 'landlords_active_plans',   'Landlords with active Rent Plans',  'v_landlord_registry_all', 'landlord_key', 'plan_rent_total',   'active_rent_plans > 0',                                             NULL, true),
  ('landlord'::cc_subject_type, 'landlords_paid_30d',       'Landlords paid in last 30 days',    'v_landlord_registry_all', 'landlord_key', 'total_paid_out_ugx','last_payout_at >= now() - interval ''30 days''',                    NULL, true),
  ('landlord'::cc_subject_type, 'landlords_unverified',     'Unverified landlords',              'v_landlord_registry_all', 'landlord_key', 'plan_rent_total',   'verification_status <> ''verified''',                               NULL, true),
  ('landlord'::cc_subject_type, 'landlords_no_houses',      'Landlords with no houses listed',   'v_landlord_registry_all', 'landlord_key', 'plan_rent_total',   'coalesce(houses_count, 0) = 0',                                     NULL, true),
  ('landlord'::cc_subject_type, 'landlords_not_called_30d', 'Landlords not called in 30+ days',  'v_landlord_registry_all', 'landlord_key', 'plan_rent_total',   'last_called_at IS NULL OR last_called_at < now() - interval ''30 days''', NULL, true),
  ('landlord'::cc_subject_type, 'landlords_not_called_60d', 'Landlords not called in 60+ days',  'v_landlord_registry_all', 'landlord_key', 'plan_rent_total',   'last_called_at IS NULL OR last_called_at < now() - interval ''60 days''', NULL, true),
  ('landlord'::cc_subject_type, 'landlords_not_called_90d', 'Landlords not called in 90+ days',  'v_landlord_registry_all', 'landlord_key', 'plan_rent_total',   'last_called_at IS NULL OR last_called_at < now() - interval ''90 days''', NULL, true)
ON CONFLICT (subject_type, code) DO UPDATE
SET
  label             = EXCLUDED.label,
  source_view       = EXCLUDED.source_view,
  subject_id_column = EXCLUDED.subject_id_column,
  priority_column   = EXCLUDED.priority_column,
  filter_sql        = EXCLUDED.filter_sql,
  max_rows          = EXCLUDED.max_rows,
  active            = EXCLUDED.active,
  updated_at        = now();

-- 7. Landlord Calling Center filter options (subject_type = 'landlord' ONLY)
INSERT INTO public.cc_filter_options (
  subject_type, key, label, filter_column, kind, sort_order, active
)
VALUES
  ('landlord'::cc_subject_type, 'region',            'Region',            'region',                 'value', 10, true),
  ('landlord'::cc_subject_type, 'district',          'District',          'district',               'value', 20, true),
  ('landlord'::cc_subject_type, 'registering_agent', 'Registering agent', 'registering_agent_name', 'value', 30, true)
ON CONFLICT (subject_type, key) DO UPDATE
SET
  label         = EXCLUDED.label,
  filter_column = EXCLUDED.filter_column,
  kind          = EXCLUDED.kind,
  sort_order    = EXCLUDED.sort_order,
  active        = EXCLUDED.active,
  updated_at    = now();

-- 8. Landlord Calling Center sort options (subject_type = 'landlord' ONLY)
UPDATE public.cc_sort_options
SET label = 'Highest Rent Plan value'
WHERE subject_type = 'landlord'::cc_subject_type
  AND key = 'plan_rent_total';

INSERT INTO public.cc_sort_options (
  subject_type, key, label, sort_column, direction, nulls_last, is_default, sort_order, active, value_format
)
VALUES
  ('landlord'::cc_subject_type, 'highest_rent_plan_value', 'Highest Rent Plan value', 'plan_rent_total', 'desc', true,  false, 15, true, 'ugx'),
  ('landlord'::cc_subject_type, 'last_called_at',          'Oldest call first',       'last_called_at',  'asc',  false, false, 25, true, 'date'),
  ('landlord'::cc_subject_type, 'oldest_call_first',       'Oldest call first',       'last_called_at',  'asc',  false, false, 26, true, 'date'),
  ('landlord'::cc_subject_type, 'registered_at',           'Newest registration',     'registered_at',   'desc', true,  false, 35, true, 'date'),
  ('landlord'::cc_subject_type, 'newest_registration',     'Newest registration',     'registered_at',   'desc', true,  false, 36, true, 'date')
ON CONFLICT (subject_type, key) DO UPDATE
SET
  label        = EXCLUDED.label,
  sort_column  = EXCLUDED.sort_column,
  direction    = EXCLUDED.direction,
  nulls_last   = EXCLUDED.nulls_last,
  sort_order   = EXCLUDED.sort_order,
  active       = EXCLUDED.active,
  value_format = EXCLUDED.value_format,
  updated_at   = now();

-- 9. Landlord-only outcome categories in cc_feedback_categories
INSERT INTO public.cc_feedback_categories (
  code, label, applies_to, default_owner_role, locked, active, raises_ticket, surface_id
)
VALUES
  ('reached_ok',              'Reached — all okay',      ARRAY['landlord'::cc_subject_type], 'landlord_ops'::app_role,  false, true, false, NULL),
  ('confirmed_payout_number', 'Confirmed payout number', ARRAY['landlord'::cc_subject_type], 'landlord_ops'::app_role,  false, true, false, NULL),
  ('wants_more_tenants',      'Wants more tenants',      ARRAY['landlord'::cc_subject_type], 'landlord_ops'::app_role,  false, true, false, NULL),
  ('complaint',               'Landlord complaint',      ARRAY['landlord'::cc_subject_type], 'landlord_ops'::app_role,  false, true, false, NULL),
  ('payout_issue',            'Payout issue',            ARRAY['landlord'::cc_subject_type], 'financial_ops'::app_role, false, true, false, NULL),
  ('not_landlord',            'Not a landlord',          ARRAY['landlord'::cc_subject_type], 'landlord_ops'::app_role,  false, true, false, NULL),
  ('wrong_number',            'Wrong phone number',      ARRAY['landlord'::cc_subject_type], 'landlord_ops'::app_role,  false, true, false, NULL)
ON CONFLICT (code) DO UPDATE
SET
  label              = EXCLUDED.label,
  applies_to         = EXCLUDED.applies_to,
  default_owner_role = EXCLUDED.default_owner_role,
  locked             = EXCLUDED.locked,
  active             = EXCLUDED.active,
  raises_ticket      = EXCLUDED.raises_ticket;

-- 10. Saved queues table: public.landlord_cc_saved_queues
--     Order per CLAUDE.md: CREATE, GRANT, ENABLE RLS, POLICY
CREATE TABLE IF NOT EXISTS public.landlord_cc_saved_queues (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(btrim(name)) >= 1),
  filters jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(filters) = 'object'),
  sort_key text,
  owner uuid NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
  shared boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS landlord_cc_saved_queues_owner_name_idx
  ON public.landlord_cc_saved_queues (owner, lower(btrim(name)));

GRANT SELECT, INSERT, UPDATE, DELETE ON public.landlord_cc_saved_queues TO authenticated;
GRANT ALL ON public.landlord_cc_saved_queues TO service_role;

ALTER TABLE public.landlord_cc_saved_queues ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS landlord_cc_saved_queues_select ON public.landlord_cc_saved_queues;
CREATE POLICY landlord_cc_saved_queues_select
  ON public.landlord_cc_saved_queues
  FOR SELECT
  TO authenticated
  USING (
    public._landlord_cc_staff_ok()
    AND (owner = auth.uid() OR shared = true)
  );

DROP POLICY IF EXISTS landlord_cc_saved_queues_insert ON public.landlord_cc_saved_queues;
CREATE POLICY landlord_cc_saved_queues_insert
  ON public.landlord_cc_saved_queues
  FOR INSERT
  TO authenticated
  WITH CHECK (
    public._landlord_cc_staff_ok()
    AND owner = auth.uid()
  );

DROP POLICY IF EXISTS landlord_cc_saved_queues_update ON public.landlord_cc_saved_queues;
CREATE POLICY landlord_cc_saved_queues_update
  ON public.landlord_cc_saved_queues
  FOR UPDATE
  TO authenticated
  USING (
    public._landlord_cc_staff_ok()
    AND (owner = auth.uid() OR public.has_role(auth.uid(), 'super_admin'::app_role))
  )
  WITH CHECK (
    public._landlord_cc_staff_ok()
    AND (owner = auth.uid() OR public.has_role(auth.uid(), 'super_admin'::app_role))
  );

DROP POLICY IF EXISTS landlord_cc_saved_queues_delete ON public.landlord_cc_saved_queues;
CREATE POLICY landlord_cc_saved_queues_delete
  ON public.landlord_cc_saved_queues
  FOR DELETE
  TO authenticated
  USING (
    public._landlord_cc_staff_ok()
    AND (owner = auth.uid() OR public.has_role(auth.uid(), 'super_admin'::app_role))
  );

-- 11. RPCs: landlord_cc_save_queue, landlord_cc_list_queues, landlord_cc_assign_callers
CREATE OR REPLACE FUNCTION public.landlord_cc_save_queue(
  p_name text,
  p_filters jsonb DEFAULT '{}'::jsonb,
  p_sort_key text DEFAULT NULL::text,
  p_shared boolean DEFAULT false,
  p_queue_id uuid DEFAULT NULL::uuid
)
RETURNS public.landlord_cc_saved_queues
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_name text := btrim(COALESCE(p_name, ''));
  v_filters jsonb := COALESCE(p_filters, '{}'::jsonb);
  v_sort text := NULLIF(btrim(COALESCE(p_sort_key, '')), '');
  v_row public.landlord_cc_saved_queues;
BEGIN
  IF NOT public._landlord_cc_staff_ok() THEN
    RAISE EXCEPTION 'NOT_AUTHORISED: only Landlord Ops and authorised staff can save landlord queues'
      USING ERRCODE = '42501';
  END IF;

  IF length(v_name) < 1 THEN
    RAISE EXCEPTION 'QUEUE_NAME_REQUIRED: queue name cannot be empty'
      USING ERRCODE = '22023';
  END IF;

  IF jsonb_typeof(v_filters) <> 'object' THEN
    RAISE EXCEPTION 'INVALID_FILTERS: filters must be a JSON object'
      USING ERRCODE = '22023';
  END IF;

  -- Validate filter keys against cc_filter_options for subject_type = 'landlord'
  PERFORM public.cc_filter_predicate('landlord'::cc_subject_type, v_filters);

  -- Validate sort_key against cc_sort_options for subject_type = 'landlord'
  IF v_sort IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM public.cc_sort_options s
    WHERE s.subject_type = 'landlord'::cc_subject_type
      AND s.key = v_sort
      AND s.active
  ) THEN
    RAISE EXCEPTION 'INVALID_SORT_KEY: sort option % does not exist for landlord queue', v_sort
      USING ERRCODE = '22023';
  END IF;

  IF p_queue_id IS NOT NULL THEN
    UPDATE public.landlord_cc_saved_queues q
       SET name       = v_name,
           filters    = v_filters,
           sort_key   = v_sort,
           shared     = COALESCE(p_shared, q.shared),
           updated_at = now()
     WHERE q.id = p_queue_id
       AND (q.owner = v_uid OR public.has_role(v_uid, 'super_admin'::app_role))
     RETURNING * INTO v_row;

    IF v_row.id IS NULL THEN
      RAISE EXCEPTION 'QUEUE_NOT_FOUND_OR_FORBIDDEN: saved queue % not found or not owned by caller', p_queue_id
        USING ERRCODE = '42501';
    END IF;
    RETURN v_row;
  END IF;

  INSERT INTO public.landlord_cc_saved_queues (name, filters, sort_key, owner, shared)
  VALUES (v_name, v_filters, v_sort, v_uid, COALESCE(p_shared, false))
  ON CONFLICT (owner, (lower(btrim(name)))) DO UPDATE
  SET filters    = EXCLUDED.filters,
      sort_key   = EXCLUDED.sort_key,
      shared     = EXCLUDED.shared,
      updated_at = now()
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public.landlord_cc_save_queue(text, jsonb, text, boolean, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.landlord_cc_save_queue(text, jsonb, text, boolean, uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.landlord_cc_list_queues()
RETURNS TABLE(
  id uuid,
  name text,
  filters jsonb,
  sort_key text,
  owner uuid,
  owner_name text,
  shared boolean,
  is_mine boolean,
  created_at timestamptz,
  updated_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public._landlord_cc_staff_ok() THEN
    RAISE EXCEPTION 'NOT_AUTHORISED: only Landlord Ops and authorised staff can view landlord saved queues'
      USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT
    q.id,
    q.name,
    q.filters,
    q.sort_key,
    q.owner,
    COALESCE(NULLIF(btrim(p.full_name), ''), 'Staff member') AS owner_name,
    q.shared,
    (q.owner = auth.uid()) AS is_mine,
    q.created_at,
    q.updated_at
  FROM public.landlord_cc_saved_queues q
  LEFT JOIN public.profiles p ON p.id = q.owner
  WHERE q.owner = auth.uid() OR q.shared = true
  ORDER BY (q.owner = auth.uid()) DESC, q.updated_at DESC, q.name ASC;
END;
$$;

REVOKE ALL ON FUNCTION public.landlord_cc_list_queues() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.landlord_cc_list_queues() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.landlord_cc_assign_callers(
  p_cycle_id uuid,
  p_staff_ids uuid[]
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_cycle public.cc_call_cycles;
  v_caller_ids uuid[];
  v_caller_count integer;
  v_assigned_count integer := 0;
  v_per_caller jsonb := '[]'::jsonb;
BEGIN
  IF NOT public._landlord_cc_staff_ok() THEN
    RAISE EXCEPTION 'NOT_AUTHORISED: only Landlord Ops and authorised staff can assign landlord callers'
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_cycle
  FROM public.cc_call_cycles
  WHERE id = p_cycle_id;

  IF v_cycle.id IS NULL THEN
    RAISE EXCEPTION 'CYCLE_NOT_FOUND: cycle % does not exist', p_cycle_id
      USING ERRCODE = '22023';
  END IF;

  IF v_cycle.subject_type <> 'landlord'::cc_subject_type THEN
    RAISE EXCEPTION 'INVALID_SUBJECT_TYPE: landlord_cc_assign_callers only applies to landlord cycles (got %)', v_cycle.subject_type
      USING ERRCODE = '22023';
  END IF;

  IF v_cycle.closed_at IS NOT NULL THEN
    RAISE EXCEPTION 'CYCLE_CLOSED: cycle % is already closed', p_cycle_id
      USING ERRCODE = '22023';
  END IF;

  -- Resolve each passed id as either hr_staff.id -> user_id or direct auth.users.id, preserving order & deduplicating
  SELECT array_agg(resolved_uid ORDER BY first_ord)
    INTO v_caller_ids
  FROM (
    SELECT
      COALESCE(s.user_id, u.id) AS resolved_uid,
      min(inp.ord) AS first_ord
    FROM unnest(COALESCE(p_staff_ids, ARRAY[]::uuid[])) WITH ORDINALITY AS inp(raw_id, ord)
    LEFT JOIN public.hr_staff s ON s.id = inp.raw_id
    LEFT JOIN auth.users u ON u.id = COALESCE(s.user_id, inp.raw_id)
    WHERE inp.raw_id IS NOT NULL
      AND COALESCE(s.user_id, u.id) IS NOT NULL
    GROUP BY COALESCE(s.user_id, u.id)
  ) resolved;

  v_caller_count := COALESCE(array_length(v_caller_ids, 1), 0);
  IF v_caller_count = 0 THEN
    RAISE EXCEPTION 'CALLERS_REQUIRED: provide at least one valid staff or user ID in p_staff_ids'
      USING ERRCODE = '22023';
  END IF;

  -- Fair round-robin split across open/callable rows (advisory only — never blocks other callers)
  WITH target_rows AS (
    SELECT
      r.id AS cycle_row_id,
      v_caller_ids[((row_number() OVER (ORDER BY r.priority_value DESC NULLS LAST, r.created_at ASC, r.id ASC) - 1) % v_caller_count) + 1] AS assigned_uid
    FROM public.cc_cycle_rows r
    WHERE r.cycle_id = p_cycle_id
      AND r.state IN ('to_call'::cc_row_state, 'unreachable'::cc_row_state, 'callback'::cc_row_state)
  ),
  upd AS (
    UPDATE public.cc_cycle_rows r
       SET assigned_caller_id = t.assigned_uid,
           assigned_at        = now()
      FROM target_rows t
     WHERE r.id = t.cycle_row_id
    RETURNING r.id AS cycle_row_id, r.cycle_id, r.assigned_caller_id
  ),
  upsert_side AS (
    INSERT INTO public.landlord_cc_row_assignments (cycle_row_id, cycle_id, caller_id, assigned_by, assigned_at)
    SELECT u.cycle_row_id, u.cycle_id, u.assigned_caller_id, v_uid, now()
    FROM upd u
    ON CONFLICT (cycle_row_id) DO UPDATE
    SET caller_id   = EXCLUDED.caller_id,
        assigned_by = EXCLUDED.assigned_by,
        assigned_at = EXCLUDED.assigned_at
    RETURNING caller_id
  )
  SELECT count(*)::integer INTO v_assigned_count FROM upsert_side;

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'caller_id', c.caller_id,
        'caller_name', COALESCE(NULLIF(btrim(p.full_name), ''), 'Staff member'),
        'assigned_count', COALESCE(cnt.n, 0)
      )
      ORDER BY c.ord
    ),
    '[]'::jsonb
  )
  INTO v_per_caller
  FROM unnest(v_caller_ids) WITH ORDINALITY AS c(caller_id, ord)
  LEFT JOIN public.profiles p ON p.id = c.caller_id
  LEFT JOIN (
    SELECT r.assigned_caller_id, count(*)::integer AS n
    FROM public.cc_cycle_rows r
    WHERE r.cycle_id = p_cycle_id
      AND r.state IN ('to_call'::cc_row_state, 'unreachable'::cc_row_state, 'callback'::cc_row_state)
    GROUP BY r.assigned_caller_id
  ) cnt ON cnt.assigned_caller_id = c.caller_id;

  RETURN jsonb_build_object(
    'cycle_id', p_cycle_id,
    'caller_count', v_caller_count,
    'assigned_rows', v_assigned_count,
    'per_caller', v_per_caller
  );
END;
$$;

REVOKE ALL ON FUNCTION public.landlord_cc_assign_callers(uuid, uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.landlord_cc_assign_callers(uuid, uuid[]) TO authenticated, service_role;
