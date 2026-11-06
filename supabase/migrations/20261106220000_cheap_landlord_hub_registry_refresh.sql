-- =============================================================================
-- Migration: 20261106220000_cheap_landlord_hub_registry_refresh.sql
-- Purpose:   Make the 5-minute refresh of public.mv_landlord_hub_registry
--            compute the same rows with less work.
--
--            The stored refresh re-ran v_landlord_registry_all (a window over
--            every landlord-role profile, most of which the hub then discards),
--            scanned public.landlords a second time for phone/meta, aggregated
--            public.rent_requests twice, and matched own-tenant phones by
--            calling normalize_landlord_phone_256 six times per candidate.
--
--            v_landlord_hub_refresh_src is the refresh body:
--              * one landlords scan carries phone norms and hub meta
--              * the phone window only sees landlord rows, orphan payout
--                phones, and landlord-role profiles whose phone is in that set
--                (peer merge data). Role-only profiles that cannot change a
--                hub row are not sorted.
--              * rent_requests is aggregated once (live value, stage counts,
--                tenants)
--              * own-tenant phones are normalised once per rent request via
--                the profiles primary key, then compared by equality
--
--            Column names, types, and the row set of mv_landlord_hub_registry
--            stay as they are. v_landlord_registry_all is not redefined, so
--            Landlord Ops Calling Center keeps its full role-only population.
--
--            Applying this migration drops and recreates the matview (Postgres
--            cannot edit a matview query in place). Indexes and grants are
--            recreated in this file. No view or function depends on the
--            matview in pg_depend; landlord_hub_* and staff_calling_detailed_report
--            reference it by name and keep working once the columns are back.
--
--            Cron stays every 5 minutes. The minute offset moves from */5 to
--            1-59/5 so the job no longer starts on the same minute as the other
--            */5 refreshes and the */2 email jobs. 12 runs per hour, same as now.
--
--            No CREATE INDEX on landlords, profiles, or rent_requests.
--            The nine matview indexes below are rebuilt with the matview
--            (~47k rows), not pre-built concurrently.
-- =============================================================================

CREATE OR REPLACE VIEW public.v_landlord_hub_refresh_src
WITH (security_invoker = true)
AS
WITH ll_meta AS (
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
    NULL::timestamptz AS orphan_last_payout_at,
    CASE
      WHEN COALESCE(l.verified, false) IS TRUE
           OR lower(COALESCE(l.verification_status, '')) = 'verified'
        THEN 'verified'
      WHEN lower(COALESCE(l.verification_status, '')) = 'rejected'
        THEN 'rejected'
      ELSE 'pending'
    END AS real_verification_status,
    COALESCE(NULLIF(btrim(l.service_center_status), ''), 'not_required') AS service_center_status,
    l.registered_by,
    l.managed_by_agent_id,
    CASE
      WHEN length(dg.v_digits) >= 9 AND right(dg.v_digits, 9) <> '000000000'
        THEN '256' || right(dg.v_digits, 9)
      ELSE NULL
    END AS norm_verified_momo
  FROM public.landlords l
  CROSS JOIN LATERAL (
    SELECT
      regexp_replace(COALESCE(l.phone, ''), '\D', '', 'g') AS p_digits,
      regexp_replace(COALESCE(l.mobile_money_number, ''), '\D', '', 'g') AS m_digits,
      regexp_replace(COALESCE(l.verified_mobile_money_number, ''), '\D', '', 'g') AS v_digits
  ) dg
),
orphan_agg AS (
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
),
match_phones AS (
  SELECT lm.norm_phone
  FROM ll_meta lm
  WHERE lm.norm_phone IS NOT NULL
  UNION
  SELECT o.norm_phone
  FROM orphan_agg o
  WHERE o.norm_phone IS NOT NULL
),
raw_union AS (
  SELECT
    lm.src,
    lm.raw_id,
    lm.landlord_id,
    lm.user_id,
    lm.full_name,
    lm.norm_name,
    lm.norm_phone,
    lm.norm_momo,
    lm.region,
    lm.district,
    lm.registering_agent_id,
    lm.declared_houses,
    lm.declared_monthly_rent,
    lm.registered_at,
    lm.verification_status,
    lm.is_flagged,
    lm.orphan_paid_ugx,
    lm.orphan_last_payout_at
  FROM ll_meta lm

  UNION ALL

  -- Landlord-role profiles that share a partition key with a landlord or an
  -- orphan payout phone. Other role-only profiles never change a hub row.
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
    WHERE ur.role = 'landlord'::public.app_role
    GROUP BY ur.user_id
  ) u
  JOIN public.profiles p ON p.id = u.user_id
  CROSS JOIN LATERAL (
    SELECT
      regexp_replace(COALESCE(p.phone, ''), '\D', '', 'g') AS p_digits,
      regexp_replace(COALESCE(p.mobile_money_number, ''), '\D', '', 'g') AS m_digits
  ) dg
  JOIN match_phones mp
    ON mp.norm_phone = CASE
      WHEN length(dg.p_digits) >= 9 AND right(dg.p_digits, 9) <> '000000000'
        THEN '256' || right(dg.p_digits, 9)
      ELSE NULL
    END

  UNION ALL

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
  FROM orphan_agg o
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
      WHEN w.src = 'll' AND w.norm_phone IS NOT NULL AND w.ll_cnt = 1 AND w.ur_cnt = 1
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
    count(*) FILTER (WHERE rr.status IN ('funded', 'repaying', 'active', 'disbursed'))::integer AS plans_live,
    count(*)::integer AS plans_total,
    count(*) FILTER (
      WHERE rr.status IN (
        'pending',
        'agent_ops_approved',
        'partner_ops_approved',
        'coo_approved',
        'tenant_ops_approved',
        'landlord_ops_approved',
        'approved',
        'agent_approved'
      )
    )::integer AS plans_strict_in_progress,
    count(*) FILTER (WHERE rr.status = 'service_center_review')::integer AS plans_sc_review,
    count(DISTINCT rr.tenant_id)::integer AS tenants_count,
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
  WHERE r.subject_type = 'landlord'::public.cc_subject_type
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

  UNION ALL

  SELECT
    COALESCE(
      CASE
        WHEN lc.landlord_key ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          THEN lc.landlord_key::uuid
        ELSE NULL
      END,
      lc.landlord_id
    ) AS subject_id,
    COALESCE(lc.recorded_at, lc.dial_started_at) AS called_at,
    COALESCE(lc.feedback_category, lc.result) AS call_outcome,
    lc.caller_id
  FROM public.v_landlord_calls_effective lc
  WHERE lc.voided_at IS NULL
    AND COALESCE(
      CASE
        WHEN lc.landlord_key ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          THEN lc.landlord_key::uuid
        ELSE NULL
      END,
      lc.landlord_id
    ) IS NOT NULL
    AND COALESCE(lc.recorded_at, lc.dial_started_at) IS NOT NULL
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
),
registry AS (
  SELECT
    d.landlord_key::text AS landlord_key_text,
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
    GREATEST(COALESCE(pl.plan_rent_total, 0), COALESCE(d.declared_monthly_rent, 0))::numeric AS plan_rent_total,
    GREATEST(COALESCE(po.total_paid_out_ugx, 0), COALESCE(d.orphan_paid_ugx, 0))::numeric AS total_paid_out_ugx,
    GREATEST(po.last_payout_at, d.orphan_last_payout_at) AS last_payout_at,
    d.registered_at,
    d.verification_status AS registry_verification_status,
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
    d.needs_review
  FROM deduped d
  LEFT JOIN houses_agg h ON h.landlord_id = d.landlord_id
  LEFT JOIN plans_agg pl ON pl.landlord_id = d.landlord_id
  LEFT JOIN payouts_agg po ON po.landlord_id = d.landlord_id
  LEFT JOIN public.profiles ag ON ag.id = COALESCE(d.registering_agent_id, pl.latest_plan_agent_id)
  LEFT JOIN calls_dedup ck ON ck.subject_id = d.landlord_key
  LEFT JOIN calls_dedup cu ON d.user_id IS NOT NULL AND d.user_id <> d.landlord_key AND cu.subject_id = d.user_id
  WHERE d.landlord_id IS NOT NULL
     OR (d.landlord_id IS NULL AND d.user_id IS NULL)
),
dup_phones AS (
  SELECT lm.norm_phone
  FROM ll_meta lm
  WHERE lm.norm_phone IS NOT NULL
  GROUP BY lm.norm_phone
  HAVING count(*) > 1
),
active_agents AS (
  SELECT DISTINCT ur.user_id
  FROM public.user_roles ur
  WHERE ur.role = 'agent'::public.app_role
    AND COALESCE(ur.enabled, true) = true
),
tenant_keys AS MATERIALIZED (
  SELECT
    rr.landlord_id,
    CASE
      WHEN length(pd.d) >= 9 AND right(pd.d, 9) <> '000000000'
        THEN '256' || right(pd.d, 9)
      ELSE NULL
    END AS norm_phone,
    CASE
      WHEN length(md.d) >= 9 AND right(md.d, 9) <> '000000000'
        THEN '256' || right(md.d, 9)
      ELSE NULL
    END AS norm_momo
  FROM public.rent_requests rr
  JOIN public.profiles tp ON tp.id = rr.tenant_id
  CROSS JOIN LATERAL (
    SELECT regexp_replace(COALESCE(tp.phone, ''), '\D', '', 'g') AS d
  ) pd
  CROSS JOIN LATERAL (
    SELECT regexp_replace(COALESCE(tp.mobile_money_number, ''), '\D', '', 'g') AS d
  ) md
  WHERE rr.landlord_id IS NOT NULL
),
own_tenant_landlords AS (
  SELECT rr.landlord_id
  FROM public.rent_requests rr
  JOIN deduped br ON br.landlord_id = rr.landlord_id
  WHERE br.user_id IS NOT NULL
    AND rr.tenant_id = br.user_id
  UNION
  SELECT tk.landlord_id
  FROM tenant_keys tk
  JOIN ll_meta lm ON lm.landlord_id = tk.landlord_id
  WHERE tk.norm_phone IS NOT NULL
    AND tk.norm_phone IN (lm.norm_phone, lm.norm_momo, lm.norm_verified_momo)
  UNION
  SELECT tk.landlord_id
  FROM tenant_keys tk
  JOIN ll_meta lm ON lm.landlord_id = tk.landlord_id
  WHERE tk.norm_momo IS NOT NULL
    AND tk.norm_momo IN (lm.norm_phone, lm.norm_momo, lm.norm_verified_momo)
),
computed AS (
  SELECT
    br.landlord_key_text,
    br.landlord_key,
    br.landlord_id,
    br.user_id,
    br.full_name,
    br.phones,
    br.region,
    br.district,
    COALESCE(lm.real_verification_status, 'pending') AS verification_status,
    (COALESCE(br.registry_verification_status, '') IN ('frozen', 'disabled', 'deleted')) AS is_flagged,
    COALESCE(lm.service_center_status, 'not_required') AS service_center_status,
    lm.registered_by,
    br.registering_agent_id,
    br.registering_agent_name,
    (aa_eff.user_id IS NOT NULL) AS registrar_is_agent_now,
    COALESCE(br.houses_count, 0)::integer AS houses_count,
    COALESCE(pr.plans_live, COALESCE(br.active_rent_plans, 0))::integer AS active_rent_plans,
    COALESCE(pr.plans_live, COALESCE(br.active_rent_plans, 0))::integer AS plans_live,
    COALESCE(pr.plans_total, 0)::integer AS plans_total,
    COALESCE(pr.tenants_count, 0)::integer AS tenants_count,
    CASE
      WHEN COALESCE(pr.plans_live, COALESCE(br.active_rent_plans, 0)) > 0 THEN 'live'
      WHEN COALESCE(pr.plans_strict_in_progress, 0) > 0
           OR (COALESCE(pr.plans_sc_review, 0) > 0 AND COALESCE(pr.plans_total, 0) <= 50)
        THEN 'in_progress'
      WHEN COALESCE(pr.plans_total, 0) > 0 THEN 'finished'
      ELSE 'registered_only'
    END AS plan_stage,
    COALESCE(br.plan_rent_total, 0)::numeric AS plan_rent_total,
    COALESCE(br.total_paid_out_ugx, 0)::numeric AS total_paid_out_ugx,
    br.last_payout_at,
    br.last_called_at,
    br.last_call_outcome,
    br.last_caller_name,
    br.registered_at,
    COALESCE(br.needs_review, false) AS needs_review,
    ARRAY_REMOVE(ARRAY[
      CASE WHEN otl.landlord_id IS NOT NULL THEN 'is_own_tenant' END,
      CASE WHEN dp.norm_phone IS NOT NULL THEN 'duplicate_phone' END,
      CASE
        WHEN COALESCE(br.full_name, '') ~* '\m(test|demo|dummy)\M'
             OR COALESCE(br.phones[1], lm.norm_phone, '') LIKE '256700000%'
          THEN 'test_account'
      END,
      CASE
        WHEN COALESCE(cardinality(br.phones), 0) = 0
             OR length(regexp_replace(COALESCE(br.phones[1], ''), '\D', '', 'g')) < 9
          THEN 'no_phone'
      END,
      CASE WHEN COALESCE(pr.plans_total, 0) > 50 THEN 'plan_overload' END,
      CASE
        WHEN COALESCE(lm.real_verification_status, 'pending') = 'rejected'
             AND COALESCE(pr.plans_live, COALESCE(br.active_rent_plans, 0)) > 0
          THEN 'rejected_with_live_plan'
      END,
      CASE
        WHEN lm.registered_by IS NOT NULL AND aa_reg.user_id IS NULL
          THEN 'registrar_not_agent'
      END
    ]::text[], NULL) AS check_flags
  FROM registry br
  LEFT JOIN ll_meta lm ON lm.landlord_id = br.landlord_id
  LEFT JOIN dup_phones dp ON dp.norm_phone = lm.norm_phone
  LEFT JOIN active_agents aa_reg ON aa_reg.user_id = lm.registered_by
  LEFT JOIN active_agents aa_eff ON aa_eff.user_id = COALESCE(lm.registered_by, lm.managed_by_agent_id, br.registering_agent_id)
  LEFT JOIN plans_agg pr ON pr.landlord_id = br.landlord_id
  LEFT JOIN own_tenant_landlords otl ON otl.landlord_id = br.landlord_id
)
SELECT
  c.landlord_key_text,
  c.landlord_key,
  c.landlord_id,
  c.user_id,
  c.full_name,
  c.phones,
  c.region,
  c.district,
  c.verification_status,
  c.is_flagged,
  c.service_center_status,
  c.registered_by,
  c.registering_agent_id,
  c.registering_agent_name,
  c.registrar_is_agent_now,
  c.houses_count,
  c.active_rent_plans,
  c.plans_live,
  c.plans_total,
  c.tenants_count,
  c.plan_stage,
  c.plan_rent_total,
  c.total_paid_out_ugx,
  c.last_payout_at,
  c.last_called_at,
  c.last_call_outcome,
  c.last_caller_name,
  c.registered_at,
  c.needs_review,
  c.check_flags,
  (cardinality(c.check_flags) > 0) AS needs_check
FROM computed c;

REVOKE ALL ON public.v_landlord_hub_refresh_src FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.v_landlord_hub_refresh_src TO service_role;

-- No other view or matview depends on mv_landlord_hub_registry (pg_depend).
-- DROP without CASCADE so a new dependent fails this migration instead of
-- being dropped silently. The matview query cannot be altered in place.
DROP MATERIALIZED VIEW public.mv_landlord_hub_registry;

CREATE MATERIALIZED VIEW public.mv_landlord_hub_registry AS
SELECT
  landlord_key_text,
  landlord_key,
  landlord_id,
  user_id,
  full_name,
  phones,
  region,
  district,
  verification_status,
  is_flagged,
  service_center_status,
  registered_by,
  registering_agent_id,
  registering_agent_name,
  registrar_is_agent_now,
  houses_count,
  active_rent_plans,
  plans_live,
  plans_total,
  tenants_count,
  plan_stage,
  plan_rent_total,
  total_paid_out_ugx,
  last_payout_at,
  last_called_at,
  last_call_outcome,
  last_caller_name,
  registered_at,
  needs_review,
  check_flags,
  needs_check
FROM public.v_landlord_hub_refresh_src;

CREATE UNIQUE INDEX IF NOT EXISTS mv_landlord_hub_registry_key_text_idx
  ON public.mv_landlord_hub_registry (landlord_key_text);
CREATE INDEX IF NOT EXISTS mv_landlord_hub_registry_landlord_id_idx
  ON public.mv_landlord_hub_registry (landlord_id)
  WHERE landlord_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS mv_landlord_hub_registry_plan_stage_sort_idx
  ON public.mv_landlord_hub_registry (plan_stage, plan_rent_total DESC NULLS LAST, active_rent_plans DESC NULLS LAST, landlord_key_text ASC);
CREATE INDEX IF NOT EXISTS mv_landlord_hub_registry_needs_check_idx
  ON public.mv_landlord_hub_registry (needs_check, plan_rent_total DESC NULLS LAST, landlord_key_text ASC)
  WHERE needs_check IS TRUE;
CREATE INDEX IF NOT EXISTS mv_landlord_hub_registry_vstatus_idx
  ON public.mv_landlord_hub_registry (verification_status);
CREATE INDEX IF NOT EXISTS mv_landlord_hub_registry_agent_idx
  ON public.mv_landlord_hub_registry (registering_agent_id)
  WHERE registering_agent_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS mv_landlord_hub_registry_live_plans_sort_idx
  ON public.mv_landlord_hub_registry (plan_rent_total DESC NULLS LAST, active_rent_plans DESC NULLS LAST, landlord_key_text ASC)
  WHERE active_rent_plans > 0;
CREATE INDEX IF NOT EXISTS mv_landlord_hub_registry_all_sort_idx
  ON public.mv_landlord_hub_registry (plan_rent_total DESC NULLS LAST, active_rent_plans DESC NULLS LAST, landlord_key_text ASC);
CREATE INDEX IF NOT EXISTS mv_landlord_hub_registry_region_district_idx
  ON public.mv_landlord_hub_registry (lower(region), lower(district));

REVOKE ALL ON TABLE public.mv_landlord_hub_registry FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.mv_landlord_hub_registry TO service_role;

-- Same 5-minute cadence, offset by one minute so it does not share a start
-- with the other */5 refreshes or the */2 email matchers.
DO $cron$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'cron') THEN
    IF EXISTS (
      SELECT 1 FROM cron.job WHERE jobname = 'refresh-landlord-hub-registry-5m'
    ) THEN
      PERFORM cron.unschedule('refresh-landlord-hub-registry-5m');
    END IF;
    PERFORM cron.schedule(
      'refresh-landlord-hub-registry-5m',
      '1-59/5 * * * *',
      $cmd$SELECT public.refresh_mv_landlord_hub_registry();$cmd$
    );
  END IF;
END
$cron$;
