-- =============================================================================
-- Rollback: 20261028110000_landlord_calling_hub_reports.rollback.sql
-- Purpose:  Restores `v_landlord_registry_all`, `_landlord_cc_events_in_window`,
--           `landlord_cc_coverage`, and `staff_calling_detailed_report` to their
--           pre-20261028110000 definitions.
-- =============================================================================

CREATE OR REPLACE VIEW public.v_landlord_registry_all
WITH (security_invoker = true)
AS
WITH raw_union AS (
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

CREATE OR REPLACE FUNCTION public._landlord_cc_events_in_window(
  p_from timestamptz,
  p_to   timestamptz
)
RETURNS TABLE (
  call_id uuid,
  called_at timestamptz,
  kampala_day date,
  caller_id uuid,
  caller_name text,
  landlord_key uuid,
  landlord_name text,
  raw_phone text,
  source text,
  direction text,
  outcome text,
  is_engaged boolean,
  is_reached boolean,
  is_callback boolean,
  is_unreachable boolean,
  category_code text,
  category_label text,
  note text,
  cycle_row_id uuid,
  received_call_id uuid,
  feedback_id uuid
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH raw_events AS (
    SELECT
      a.id AS call_id,
      COALESCE(a.recorded_at, a.revealed_at, a.created_at) AS called_at,
      a.caller_id,
      NULL::text AS fallback_caller_name,
      r.subject_id AS person_id,
      NULL::uuid AS rr_id,
      NULL::text AS fallback_landlord_name,
      NULL::text AS fallback_phone,
      'calling_center'::text AS source,
      'made'::text AS direction,
      1 AS prio,
      COALESCE(a.outcome::text, 'open') AS outcome,
      (a.outcome = 'engaged'::cc_attempt_outcome) AS is_engaged,
      (a.outcome IN ('engaged'::cc_attempt_outcome, 'callback_booked'::cc_attempt_outcome)) AS is_reached,
      (a.outcome = 'callback_booked'::cc_attempt_outcome) AS is_callback,
      (a.outcome IS NULL OR a.outcome NOT IN ('engaged'::cc_attempt_outcome, 'callback_booked'::cc_attempt_outcome)) AS is_unreachable,
      cat.code AS category_code,
      cat.label AS category_label,
      COALESCE(fb.note, a.legacy_note) AS note,
      r.id AS cycle_row_id,
      NULL::uuid AS received_call_id,
      fb.id AS feedback_id
    FROM public.cc_call_attempts a
    JOIN public.cc_cycle_rows r ON r.id = a.cycle_row_id
    LEFT JOIN LATERAL (
      SELECT f.id, f.category_id, f.note
      FROM public.cc_feedback f
      WHERE f.attempt_id = a.id
      ORDER BY f.created_at DESC
      LIMIT 1
    ) fb ON true
    LEFT JOIN public.cc_feedback_categories cat ON cat.id = fb.category_id
    WHERE r.subject_type = 'landlord'::cc_subject_type
      AND a.void_reason IS NULL
      AND COALESCE(a.recorded_at, a.revealed_at, a.created_at) >= p_from
      AND COALESCE(a.recorded_at, a.revealed_at, a.created_at) < p_to

    UNION ALL

    SELECT
      c.id AS call_id,
      c.called_at,
      c.recorded_by AS caller_id,
      c.recorded_by_name AS fallback_caller_name,
      c.linked_user_id AS person_id,
      NULL::uuid AS rr_id,
      c.caller_name AS fallback_landlord_name,
      c.caller_phone AS fallback_phone,
      'received'::text AS source,
      'received'::text AS direction,
      1 AS prio,
      'engaged'::text AS outcome,
      true AS is_engaged,
      true AS is_reached,
      (c.follow_up_at IS NOT NULL) AS is_callback,
      false AS is_unreachable,
      'received_call'::text AS category_code,
      'Received call'::text AS category_label,
      COALESCE(NULLIF(btrim(COALESCE(c.concern, '')), ''), c.notes) AS note,
      NULL::uuid AS cycle_row_id,
      c.id AS received_call_id,
      NULL::uuid AS feedback_id
    FROM public.cc_received_calls c
    WHERE c.linked_kind = 'landlord'
      AND c.called_at >= p_from
      AND c.called_at < p_to

    UNION ALL

    SELECT
      w.id AS call_id,
      COALESCE(w.recorded_at, w.dial_started_at) AS called_at,
      w.caller_id,
      NULL::text AS fallback_caller_name,
      COALESCE(w.subject_user_id, rr.landlord_id) AS person_id,
      w.rent_request_id AS rr_id,
      l.name AS fallback_landlord_name,
      COALESCE(w.subject_phone, l.phone) AS fallback_phone,
      'awareness'::text AS source,
      'made'::text AS direction,
      2 AS prio,
      COALESCE(w.call_result, 'no_answer') AS outcome,
      (w.call_result = 'answered') AS is_engaged,
      (w.call_result IN ('answered', 'call_back_later')) AS is_reached,
      (w.call_result = 'call_back_later') AS is_callback,
      (w.call_result IS NULL OR w.call_result NOT IN ('answered', 'call_back_later')) AS is_unreachable,
      CASE
        WHEN w.landlord_consent IS NOT NULL THEN 'landlord_consent_' || w.landlord_consent
        ELSE 'awareness_call'
      END AS category_code,
      'Pipeline awareness'::text AS category_label,
      w.note,
      NULL::uuid AS cycle_row_id,
      NULL::uuid AS received_call_id,
      NULL::uuid AS feedback_id
    FROM public.rent_pipeline_awareness_calls w
    LEFT JOIN public.rent_requests rr ON rr.id = w.rent_request_id
    LEFT JOIN public.landlords l ON l.id = COALESCE(w.subject_user_id, rr.landlord_id)
    WHERE w.subject_type = 'landlord'
      AND COALESCE(w.recorded_at, w.dial_started_at) >= p_from
      AND COALESCE(w.recorded_at, w.dial_started_at) < p_to

    UNION ALL

    SELECT
      q.id AS call_id,
      q.landlord_ops_reviewed_at AS called_at,
      q.landlord_ops_reviewed_by AS caller_id,
      NULL::text AS fallback_caller_name,
      q.landlord_id AS person_id,
      q.id AS rr_id,
      l.name AS fallback_landlord_name,
      l.phone AS fallback_phone,
      'pipeline_landlord'::text AS source,
      'made'::text AS direction,
      3 AS prio,
      CASE WHEN COALESCE(q.landlord_acknowledged, false) THEN 'engaged' ELSE 'no_answer' END AS outcome,
      COALESCE(q.landlord_acknowledged, false) AS is_engaged,
      COALESCE(q.landlord_acknowledged, false) AS is_reached,
      false AS is_callback,
      NOT COALESCE(q.landlord_acknowledged, false) AS is_unreachable,
      'pipeline_verification'::text AS category_code,
      'Landlord verification'::text AS category_label,
      NULL::text AS note,
      NULL::uuid AS cycle_row_id,
      NULL::uuid AS received_call_id,
      NULL::uuid AS feedback_id
    FROM public.rent_requests q
    LEFT JOIN public.landlords l ON l.id = q.landlord_id
    WHERE q.landlord_called IS TRUE
      AND q.landlord_verification_method = 'phone_call'
      AND q.landlord_ops_reviewed_by IS NOT NULL
      AND q.landlord_ops_reviewed_at IS NOT NULL
      AND q.landlord_ops_reviewed_at >= p_from
      AND q.landlord_ops_reviewed_at < p_to

    UNION ALL

    SELECT
      s.id AS call_id,
      s.created_at AS called_at,
      s.staff_id AS caller_id,
      NULL::text AS fallback_caller_name,
      s.target_user_id AS person_id,
      NULL::uuid AS rr_id,
      s.target_name AS fallback_landlord_name,
      s.target_phone AS fallback_phone,
      'crm_voice'::text AS source,
      CASE WHEN s.direction = 'inbound' THEN 'received' ELSE 'made' END AS direction,
      4 AS prio,
      CASE WHEN s.answered_at IS NOT NULL THEN 'engaged' ELSE COALESCE(s.status, 'no_answer') END AS outcome,
      (s.answered_at IS NOT NULL) AS is_engaged,
      (s.answered_at IS NOT NULL) AS is_reached,
      false AS is_callback,
      (s.answered_at IS NULL) AS is_unreachable,
      'crm_voice'::text AS category_code,
      'App voice call'::text AS category_label,
      s.summary AS note,
      NULL::uuid AS cycle_row_id,
      NULL::uuid AS received_call_id,
      NULL::uuid AS feedback_id
    FROM public.crm_call_sessions s
    WHERE s.target_role = 'landlord'
      AND s.created_at >= p_from
      AND s.created_at < p_to

    UNION ALL

    SELECT
      lcr.id AS call_id,
      lcr.called_at,
      lcr.called_by AS caller_id,
      NULL::text AS fallback_caller_name,
      lcr.landlord_id AS person_id,
      NULL::uuid AS rr_id,
      l.name AS fallback_landlord_name,
      l.phone AS fallback_phone,
      'legacy_landlord'::text AS source,
      'made'::text AS direction,
      5 AS prio,
      CASE
        WHEN lcr.status = 'picked_up' THEN 'engaged'
        WHEN lcr.follow_up_at IS NOT NULL THEN 'callback_booked'
        ELSE COALESCE(lcr.status, 'no_answer')
      END AS outcome,
      (lcr.status = 'picked_up') AS is_engaged,
      (lcr.status = 'picked_up' OR lcr.follow_up_at IS NOT NULL) AS is_reached,
      (lcr.follow_up_at IS NOT NULL AND lcr.status <> 'picked_up') AS is_callback,
      (lcr.status IS DISTINCT FROM 'picked_up' AND lcr.follow_up_at IS NULL) AS is_unreachable,
      'legacy_landlord'::text AS category_code,
      'Earlier landlord call log'::text AS category_label,
      lcr.comment AS note,
      NULL::uuid AS cycle_row_id,
      NULL::uuid AS received_call_id,
      NULL::uuid AS feedback_id
    FROM public.landlord_call_reports lcr
    LEFT JOIN public.landlords l ON l.id = lcr.landlord_id
    WHERE lcr.called_at >= p_from
      AND lcr.called_at < p_to
  ),
  in_window AS MATERIALIZED (
    SELECT e.*
    FROM raw_events e
    WHERE e.called_at IS NOT NULL
      AND e.called_at >= p_from
      AND e.called_at < p_to
  ),
  kept AS MATERIALIZED (
    SELECT m.*
    FROM in_window m
    WHERE NOT EXISTS (
      SELECT 1
      FROM in_window h
      WHERE h.prio < m.prio
        AND m.caller_id IS NOT NULL
        AND h.caller_id = m.caller_id
        AND abs(extract(epoch FROM (h.called_at - m.called_at))) <= 15 * 60
        AND (
          (h.person_id IS NOT NULL AND h.person_id = m.person_id)
          OR (h.rr_id IS NOT NULL AND h.rr_id = m.rr_id)
        )
    )
  )
  SELECT
    k.call_id,
    k.called_at,
    (k.called_at AT TIME ZONE 'Africa/Kampala')::date AS kampala_day,
    k.caller_id,
    COALESCE(NULLIF(btrim(cp.full_name), ''), NULLIF(btrim(k.fallback_caller_name), ''), 'Call centre officer') AS caller_name,
    k.person_id AS landlord_key,
    COALESCE(NULLIF(btrim(ll.name), ''), NULLIF(btrim(k.fallback_landlord_name), ''), NULLIF(btrim(lp.full_name), ''), 'Unnamed Landlord') AS landlord_name,
    COALESCE(
      public.normalize_landlord_phone_256(COALESCE(ll.phone, ll.mobile_money_number)),
      public.normalize_landlord_phone_256(k.fallback_phone),
      public.normalize_landlord_phone_256(COALESCE(lp.phone, lp.mobile_money_number)),
      NULLIF(btrim(COALESCE(ll.phone, k.fallback_phone, lp.phone, '')), '')
    ) AS raw_phone,
    k.source,
    k.direction,
    k.outcome,
    k.is_engaged,
    k.is_reached,
    k.is_callback,
    k.is_unreachable,
    k.category_code,
    k.category_label,
    k.note,
    k.cycle_row_id,
    k.received_call_id,
    k.feedback_id
  FROM kept k
  LEFT JOIN public.profiles cp ON cp.id = k.caller_id
  LEFT JOIN public.landlords ll ON ll.id = k.person_id
  LEFT JOIN public.profiles lp ON lp.id = k.person_id;
$$;

REVOKE ALL ON FUNCTION public._landlord_cc_events_in_window(timestamptz, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public._landlord_cc_events_in_window(timestamptz, timestamptz) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.landlord_cc_coverage(
  p_as_at timestamptz DEFAULT now()
)
RETURNS TABLE (
  region text,
  district text,
  registry_total integer,
  ever_reached integer,
  reached_this_round integer,
  reached_this_month integer,
  never_called integer,
  called_but_unreached integer,
  needs_review_count integer,
  active_rent_plans_count integer
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_as_at timestamptz := COALESCE(p_as_at, now());
  v_month_start timestamptz;
  v_cycle_id uuid;
BEGIN
  IF NOT (pg_trigger_depth() > 0 OR auth.uid() IS NULL OR public._landlord_cc_staff_ok()) THEN
    RAISE EXCEPTION 'Not authorized to view Landlord Calling Center coverage'
      USING ERRCODE = '42501';
  END IF;

  v_month_start := (date_trunc('month', v_as_at AT TIME ZONE 'Africa/Kampala') AT TIME ZONE 'Africa/Kampala');

  SELECT c.id INTO v_cycle_id
  FROM public.cc_call_cycles c
  WHERE c.subject_type = 'landlord'::cc_subject_type
    AND c.opened_at <= v_as_at
  ORDER BY (c.closed_at IS NULL) DESC, c.opened_at DESC
  LIMIT 1;

  RETURN QUERY
  WITH reached_events AS (
    SELECT
      r.subject_id,
      COALESCE(a.recorded_at, a.revealed_at, a.created_at) AS ts,
      r.cycle_id
    FROM public.cc_call_attempts a
    JOIN public.cc_cycle_rows r ON r.id = a.cycle_row_id
    WHERE r.subject_type = 'landlord'::cc_subject_type
      AND a.void_reason IS NULL
      AND a.outcome IN ('engaged'::cc_attempt_outcome, 'callback_booked'::cc_attempt_outcome)
      AND COALESCE(a.recorded_at, a.revealed_at, a.created_at) <= v_as_at

    UNION ALL

    SELECT
      COALESCE(w.subject_user_id, rr.landlord_id) AS subject_id,
      COALESCE(w.recorded_at, w.dial_started_at) AS ts,
      NULL::uuid AS cycle_id
    FROM public.rent_pipeline_awareness_calls w
    LEFT JOIN public.rent_requests rr ON rr.id = w.rent_request_id
    WHERE w.subject_type = 'landlord'
      AND w.call_result IN ('answered', 'call_back_later')
      AND COALESCE(w.subject_user_id, rr.landlord_id) IS NOT NULL
      AND COALESCE(w.recorded_at, w.dial_started_at) <= v_as_at

    UNION ALL

    SELECT
      q.landlord_id AS subject_id,
      q.landlord_ops_reviewed_at AS ts,
      NULL::uuid AS cycle_id
    FROM public.rent_requests q
    WHERE q.landlord_id IS NOT NULL
      AND q.landlord_called IS TRUE
      AND q.landlord_verification_method = 'phone_call'
      AND COALESCE(q.landlord_acknowledged, false) IS TRUE
      AND q.landlord_ops_reviewed_at <= v_as_at

    UNION ALL

    SELECT
      lcr.landlord_id AS subject_id,
      lcr.called_at AS ts,
      NULL::uuid AS cycle_id
    FROM public.landlord_call_reports lcr
    WHERE lcr.landlord_id IS NOT NULL
      AND lcr.status = 'picked_up'
      AND lcr.called_at <= v_as_at

    UNION ALL

    SELECT
      s.target_user_id AS subject_id,
      s.created_at AS ts,
      NULL::uuid AS cycle_id
    FROM public.crm_call_sessions s
    WHERE s.target_role = 'landlord'
      AND s.target_user_id IS NOT NULL
      AND s.answered_at IS NOT NULL
      AND s.created_at <= v_as_at
  ),
  reached_by_subject AS (
    SELECT
      re.subject_id,
      true AS is_ever_reached,
      bool_or(re.ts >= v_month_start) AS is_reached_month,
      bool_or(v_cycle_id IS NOT NULL AND re.cycle_id = v_cycle_id) AS is_reached_round_attempt
    FROM reached_events re
    WHERE re.subject_id IS NOT NULL
    GROUP BY re.subject_id
  ),
  round_engaged_rows AS (
    SELECT DISTINCT r.subject_id
    FROM public.cc_cycle_rows r
    WHERE v_cycle_id IS NOT NULL
      AND r.cycle_id = v_cycle_id
      AND r.subject_type = 'landlord'::cc_subject_type
      AND r.state IN ('engaged'::cc_row_state, 'callback'::cc_row_state)
  ),
  registry_enriched AS (
    SELECT
      COALESCE(NULLIF(btrim(reg.region), ''), 'Unspecified') AS region_label,
      COALESCE(NULLIF(btrim(reg.district), ''), 'Unspecified') AS district_label,
      reg.landlord_key,
      reg.needs_review,
      reg.active_rent_plans,
      (reg.last_called_at IS NULL OR reg.last_called_at > v_as_at) AS is_never_called,
      (
        COALESCE(rk.is_ever_reached, false)
        OR COALESCE(ru.is_ever_reached, false)
        OR (reg.last_called_at IS NOT NULL AND reg.last_called_at <= v_as_at AND reg.last_call_outcome IN (
          'engaged', 'callback_booked', 'reached_ok', 'confirmed_payout_number',
          'wants_more_tenants', 'complaint', 'payout_issue', 'answered', 'picked_up'
        ))
      ) AS is_ever_reached,
      (
        COALESCE(rk.is_reached_month, false)
        OR COALESCE(ru.is_reached_month, false)
        OR (reg.last_called_at IS NOT NULL AND reg.last_called_at >= v_month_start AND reg.last_called_at <= v_as_at AND reg.last_call_outcome IN (
          'engaged', 'callback_booked', 'reached_ok', 'confirmed_payout_number',
          'wants_more_tenants', 'complaint', 'payout_issue', 'answered', 'picked_up'
        ))
      ) AS is_reached_this_month,
      (
        COALESCE(rk.is_reached_round_attempt, false)
        OR COALESCE(ru.is_reached_round_attempt, false)
        OR rrk.subject_id IS NOT NULL
        OR rru.subject_id IS NOT NULL
      ) AS is_reached_this_round
    FROM public.v_landlord_registry_all reg
    LEFT JOIN reached_by_subject rk ON rk.subject_id = reg.landlord_key
    LEFT JOIN reached_by_subject ru ON reg.user_id IS NOT NULL AND reg.user_id <> reg.landlord_key AND ru.subject_id = reg.user_id
    LEFT JOIN round_engaged_rows rrk ON rrk.subject_id = reg.landlord_key
    LEFT JOIN round_engaged_rows rru ON reg.user_id IS NOT NULL AND reg.user_id <> reg.landlord_key AND rru.subject_id = reg.user_id
  )
  SELECT
    re.region_label AS region,
    re.district_label AS district,
    count(*)::integer AS registry_total,
    count(*) FILTER (WHERE re.is_ever_reached)::integer AS ever_reached,
    count(*) FILTER (WHERE re.is_reached_this_round)::integer AS reached_this_round,
    count(*) FILTER (WHERE re.is_reached_this_month)::integer AS reached_this_month,
    count(*) FILTER (WHERE re.is_never_called)::integer AS never_called,
    count(*) FILTER (WHERE NOT re.is_never_called AND NOT re.is_ever_reached)::integer AS called_but_unreached,
    count(*) FILTER (WHERE re.needs_review)::integer AS needs_review_count,
    count(*) FILTER (WHERE re.active_rent_plans > 0)::integer AS active_rent_plans_count
  FROM registry_enriched re
  GROUP BY re.region_label, re.district_label
  ORDER BY count(*) DESC, re.region_label ASC, re.district_label ASC;
END;
$$;

REVOKE ALL ON FUNCTION public.landlord_cc_coverage(timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.landlord_cc_coverage(timestamptz) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.staff_calling_detailed_report(
  p_from timestamptz,
  p_to   timestamptz
)
RETURNS TABLE (
  staff_id         uuid,
  short_name       text,
  staff_name       text,
  ts               timestamptz,
  day              date,
  hhmm             text,
  source           text,
  role             text,
  name             text,
  phone            text,
  phone9           text,
  answered         boolean,
  outcome          text,
  feedback         text,
  extra            jsonb,
  rr_id            uuid,
  person_id        uuid,
  prio             integer,
  excluded_reveals integer
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_can_view_all boolean := false;
  v_is_calling_staff boolean := false;
BEGIN
  IF p_from IS NULL OR p_to IS NULL OR p_to <= p_from THEN
    RAISE EXCEPTION 'Invalid report window: p_from and p_to are required and p_to must be after p_from'
      USING ERRCODE = '22023';
  END IF;

  IF v_uid IS NULL
     OR v_uid = '5295252d-f477-42a9-92f5-af56e503e33d'::uuid
     OR v_uid = 'fe1e9f51-a2c3-49fc-bd40-b2c143afe628'::uuid
     OR public.has_role(v_uid, 'hr'::app_role)
     OR public.has_role(v_uid, 'coo'::app_role)
     OR public.has_role(v_uid, 'cfo'::app_role)
     OR public.has_role(v_uid, 'ceo'::app_role)
     OR public.has_role(v_uid, 'manager'::app_role)
     OR public.has_role(v_uid, 'super_admin'::app_role)
     OR public.has_role(v_uid, 'operations'::app_role)
  THEN
    v_can_view_all := true;
  END IF;

  IF v_uid IN (
    '5295252d-f477-42a9-92f5-af56e503e33d'::uuid,
    'a9258d45-3e27-4827-af71-64344e76fb4f'::uuid,
    'fda0d518-98c4-45e4-83d8-64266b25eefa'::uuid
  ) THEN
    v_is_calling_staff := true;
  END IF;

  IF NOT v_can_view_all AND NOT v_is_calling_staff THEN
    RAISE EXCEPTION 'Access denied to staff calling reports'
      USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH staff(id, s_short, s_full) AS (
    SELECT *
    FROM (
      VALUES
        ('5295252d-f477-42a9-92f5-af56e503e33d'::uuid, 'Jane'::text, 'Janehephzibar Gimono'::text),
        ('a9258d45-3e27-4827-af71-64344e76fb4f'::uuid, 'Winnie'::text, 'Winfred Asiimwe'::text),
        ('fda0d518-98c4-45e4-83d8-64266b25eefa'::uuid, 'Hanisha'::text, 'Hanishah Amber Kawuki'::text)
    ) AS t(id, s_short, s_full)
    WHERE v_can_view_all OR t.id = v_uid
  ),
  reveals_by_staff AS (
    SELECT
      s.id AS s_id,
      count(a.id)::integer AS reveals_cnt
    FROM staff s
    LEFT JOIN public.cc_call_attempts a
      ON a.caller_id = s.id
     AND a.void_reason IS NULL
     AND a.outcome IS NULL
     AND coalesce(a.revealed_at, a.created_at) >= p_from
     AND coalesce(a.revealed_at, a.created_at) < p_to
    GROUP BY s.id
  ),
  raw AS (
    SELECT
      a.caller_id AS r_staff_id,
      coalesce(a.recorded_at, a.created_at) AS r_ts,
      CASE
        WHEN r.subject_type::text = 'landlord' THEN 'Landlord Ops - Calling Center'
        ELSE 'Tenant Ops - Calling Center'
      END AS r_source,
      1 AS r_prio,
      CASE
        WHEN r.subject_type::text IN ('tenant', 'landlord', 'agent') THEN r.subject_type::text
        ELSE 'other'
      END AS r_role,
      coalesce(
        nullif(btrim(pp.full_name), ''),
        nullif(btrim(ll.name), ''),
        nullif(btrim(lr.full_name), ''),
        'Unnamed'
      ) AS r_name,
      coalesce(
        nullif(btrim(pp.phone), ''),
        nullif(btrim(pp.mobile_money_number), ''),
        nullif(btrim(ll.phone), ''),
        nullif(btrim(ll.mobile_money_number), ''),
        nullif(btrim(lr.phone), ''),
        CASE
          WHEN pp.email ~ '^[0-9+]+@noapp\.welile\.user$'
          THEN regexp_replace(pp.email, '@noapp\.welile\.user$', '')
          ELSE NULL
        END,
        (SELECT nullif(btrim(u.raw_user_meta_data->>'phone'), '') FROM auth.users u WHERE u.id = r.subject_id)
      ) AS r_phone,
      r.subject_id AS r_person_id,
      NULL::uuid AS r_rr_id,
      (a.outcome::text = 'engaged') AS r_answered,
      a.outcome::text AS r_outcome,
      nullif(btrim(concat_ws(' | ',
        CASE
          WHEN fc.label IS NOT NULL THEN fc.label || coalesce(' (' || fb.severity::text || ')', '')
          ELSE NULL
        END,
        nullif(btrim(coalesce(fb.note, a.legacy_note)), '')
      )), '') AS r_feedback,
      jsonb_build_object(
        'channel', a.channel::text,
        'subject_type', r.subject_type::text,
        'category', fc.label,
        'severity', fb.severity::text,
        'note', nullif(btrim(coalesce(fb.note, a.legacy_note)), '')
      ) AS r_extra
    FROM public.cc_call_attempts a
    JOIN public.cc_cycle_rows r ON r.id = a.cycle_row_id
    LEFT JOIN public.profiles pp ON pp.id = r.subject_id
    LEFT JOIN public.landlords ll ON ll.id = r.subject_id
    LEFT JOIN LATERAL (
      SELECT v.full_name, v.phones[1] AS phone
      FROM public.v_landlord_registry_all v
      WHERE r.subject_type = 'landlord'::cc_subject_type
        AND pp.id IS NULL
        AND ll.id IS NULL
        AND v.landlord_key = r.subject_id
      LIMIT 1
    ) lr ON true
    LEFT JOIN LATERAL (
      SELECT f.category_id, f.severity, f.note
      FROM public.cc_feedback f
      WHERE f.attempt_id = a.id
      ORDER BY f.created_at DESC
      LIMIT 1
    ) fb ON true
    LEFT JOIN public.cc_feedback_categories fc ON fc.id = fb.category_id
    WHERE a.void_reason IS NULL
      AND a.outcome IS NOT NULL
      AND a.caller_id IN (SELECT id FROM staff)
      AND coalesce(a.recorded_at, a.created_at) >= p_from
      AND coalesce(a.recorded_at, a.created_at) < p_to

    UNION ALL

    SELECT
      c.recorded_by AS r_staff_id,
      c.called_at AS r_ts,
      'Calling Center - Inbound call received' AS r_source,
      1 AS r_prio,
      CASE
        WHEN c.linked_kind IN ('tenant', 'landlord', 'agent') THEN c.linked_kind
        ELSE 'other'
      END AS r_role,
      coalesce(nullif(btrim(c.caller_name), ''), 'Unnamed') AS r_name,
      nullif(btrim(c.caller_phone), '') AS r_phone,
      c.linked_user_id AS r_person_id,
      NULL::uuid AS r_rr_id,
      true AS r_answered,
      'received'::text AS r_outcome,
      nullif(btrim(concat_ws(' | ',
        CASE
          WHEN nullif(btrim(c.concern), '') IS NOT NULL THEN 'Concern: ' || btrim(c.concern)
          ELSE NULL
        END,
        nullif(btrim(c.notes), '')
      )), '') AS r_feedback,
      jsonb_build_object(
        'concern', nullif(btrim(c.concern), ''),
        'notes', nullif(btrim(c.notes), ''),
        'linked_kind', c.linked_kind
      ) AS r_extra
    FROM public.cc_received_calls c
    WHERE c.recorded_by IN (SELECT id FROM staff)
      AND c.called_at >= p_from
      AND c.called_at < p_to

    UNION ALL

    SELECT
      w.caller_id AS r_staff_id,
      coalesce(w.recorded_at, w.dial_started_at) AS r_ts,
      'Rent Pipeline - Awareness call' AS r_source,
      2 AS r_prio,
      CASE
        WHEN w.subject_type IN ('tenant', 'landlord', 'agent') THEN w.subject_type
        ELSE 'other'
      END AS r_role,
      coalesce(
        CASE w.subject_type
          WHEN 'tenant' THEN nullif(btrim(tp.full_name), '')
          WHEN 'landlord' THEN nullif(btrim(ll.name), '')
          WHEN 'agent' THEN nullif(btrim(ap.full_name), '')
        END,
        'Unnamed'
      ) AS r_name,
      coalesce(
        nullif(btrim(w.subject_phone), ''),
        CASE w.subject_type
          WHEN 'tenant' THEN coalesce(nullif(btrim(tp.phone), ''), nullif(btrim(tp.mobile_money_number), ''))
          WHEN 'landlord' THEN coalesce(nullif(btrim(ll.phone), ''), nullif(btrim(ll.mobile_money_number), ''))
          WHEN 'agent' THEN coalesce(nullif(btrim(ap.phone), ''), nullif(btrim(ap.mobile_money_number), ''))
        END
      ) AS r_phone,
      w.subject_user_id AS r_person_id,
      w.rent_request_id AS r_rr_id,
      (w.call_result = 'answered') AS r_answered,
      w.call_result::text AS r_outcome,
      nullif(btrim(concat_ws(' | ',
        nullif(btrim(w.note), ''),
        CASE
          WHEN w.subject_type = 'landlord'
           AND q.landlord_ops_reviewed_by = w.caller_id
           AND q.landlord_ops_reviewed_at IS NOT NULL
           AND abs(extract(epoch FROM (coalesce(w.recorded_at, w.dial_started_at) - q.landlord_ops_reviewed_at))) <= 900
          THEN nullif(btrim(concat_ws(' - ',
            CASE
              WHEN nullif(btrim(q.landlord_call_notes), '') IS NOT NULL
              THEN 'Verification: ' || btrim(q.landlord_call_notes)
              ELSE NULL
            END,
            CASE
              WHEN nullif(btrim(q.landlord_ops_comment), '') IS NOT NULL
              THEN 'Decision note: ' || btrim(q.landlord_ops_comment)
              ELSE NULL
            END
          )), '')
          ELSE NULL
        END
      )), '') AS r_feedback,
      jsonb_build_object(
        'aware_30m', w.aware_30m,
        'explained', w.explained,
        'merchant_codes', w.aware_merchant_codes,
        'landlord_consent', w.landlord_consent,
        'payout_otp', w.aware_payout_otp,
        'stage', w.pipeline_stage,
        'note', nullif(btrim(w.note), ''),
        'landlord_ops_comment', CASE
          WHEN w.subject_type = 'landlord' AND q.landlord_ops_reviewed_by = w.caller_id
          THEN nullif(btrim(q.landlord_ops_comment), '')
          ELSE NULL
        END
      ) AS r_extra
    FROM public.rent_pipeline_awareness_calls w
    LEFT JOIN public.rent_requests q ON q.id = w.rent_request_id
    LEFT JOIN public.profiles tp ON tp.id = q.tenant_id
    LEFT JOIN public.profiles ap ON ap.id = q.agent_id
    LEFT JOIN public.landlords ll ON ll.id = q.landlord_id
    WHERE w.caller_id IN (SELECT id FROM staff)
      AND coalesce(w.recorded_at, w.dial_started_at) >= p_from
      AND coalesce(w.recorded_at, w.dial_started_at) < p_to

    UNION ALL

    SELECT
      q.landlord_ops_reviewed_by AS r_staff_id,
      q.landlord_ops_reviewed_at AS r_ts,
      CASE
        WHEN q.landlord_called IS TRUE AND q.landlord_verification_method = 'phone_call'
        THEN 'Rent Pipeline - Landlord Ops verification call'
        ELSE 'Rent Pipeline - Landlord Ops review feedback'
      END AS r_source,
      3 AS r_prio,
      'landlord'::text AS r_role,
      coalesce(nullif(btrim(ll.name), ''), 'Unnamed') AS r_name,
      coalesce(nullif(btrim(ll.phone), ''), nullif(btrim(ll.mobile_money_number), '')) AS r_phone,
      ll.id AS r_person_id,
      q.id AS r_rr_id,
      CASE
        WHEN q.landlord_called IS TRUE AND coalesce(q.landlord_acknowledged, false) THEN true
        WHEN q.landlord_ops_comment ~* '(number off|phone is off|phone off|number is off|unreachable|busy|doesn''t exist|does not exist)' THEN false
        WHEN q.landlord_ops_comment ~* '(refused|arrears|not the landlord|wrong landlord)' THEN true
        ELSE false
      END AS r_answered,
      CASE
        WHEN q.landlord_called IS TRUE AND coalesce(q.landlord_acknowledged, false) THEN 'verified'
        WHEN q.landlord_ops_comment ~* '(number off|phone is off|phone off|number is off|unreachable)' THEN 'phone_off'
        WHEN q.landlord_ops_comment ~* '(busy)' THEN 'no_answer'
        WHEN q.landlord_ops_comment ~* '(doesn''t exist|does not exist|not the landlord|wrong landlord)' THEN 'wrong_number'
        WHEN q.landlord_ops_comment ~* '(refused|arrears)' THEN 'engaged'
        ELSE 'review recorded'
      END AS r_outcome,
      nullif(btrim(concat_ws(' | ',
        nullif(btrim(q.landlord_call_notes), ''),
        nullif(btrim(q.landlord_ops_comment), ''),
        CASE
          WHEN q.status = 'rejected'
           AND nullif(btrim(q.rejected_reason), '') IS NOT NULL
           AND btrim(q.rejected_reason) IS DISTINCT FROM btrim(coalesce(q.landlord_ops_comment, ''))
          THEN 'Declined: ' || btrim(q.rejected_reason)
          ELSE NULL
        END
      )), '') AS r_feedback,
      jsonb_build_object(
        'stage', 'landlord_ops',
        'verification_method', q.landlord_verification_method,
        'landlord_called', q.landlord_called,
        'landlord_acknowledged', q.landlord_acknowledged,
        'request_status', q.status,
        'landlord_call_notes', nullif(btrim(q.landlord_call_notes), ''),
        'landlord_ops_comment', nullif(btrim(q.landlord_ops_comment), '')
      ) AS r_extra
    FROM public.rent_requests q
    LEFT JOIN public.landlords ll ON ll.id = q.landlord_id
    WHERE q.landlord_ops_reviewed_by IN (SELECT id FROM staff)
      AND q.landlord_ops_reviewed_at IS NOT NULL
      AND q.landlord_ops_reviewed_at >= p_from
      AND q.landlord_ops_reviewed_at < p_to
      AND (
        (q.landlord_called IS TRUE AND q.landlord_verification_method = 'phone_call')
        OR nullif(btrim(q.landlord_ops_comment), '') IS NOT NULL
        OR nullif(btrim(q.landlord_call_notes), '') IS NOT NULL
      )
      AND coalesce(q.landlord_verification_method, '') <> 'physical_visit'

    UNION ALL

    SELECT
      q.tenant_ops_reviewed_by AS r_staff_id,
      q.tenant_ops_reviewed_at AS r_ts,
      'Rent Pipeline - Tenant Ops review feedback' AS r_source,
      3 AS r_prio,
      'tenant'::text AS r_role,
      coalesce(nullif(btrim(tp.full_name), ''), 'Unnamed') AS r_name,
      coalesce(
        nullif(btrim(tp.phone), ''),
        nullif(btrim(tp.mobile_money_number), ''),
        CASE
          WHEN tp.email ~ '^[0-9+]+@noapp\.welile\.user$'
          THEN regexp_replace(tp.email, '@noapp\.welile\.user$', '')
          ELSE NULL
        END,
        (SELECT nullif(btrim(u.raw_user_meta_data->>'phone'), '') FROM auth.users u WHERE u.id = q.tenant_id)
      ) AS r_phone,
      q.tenant_id AS r_person_id,
      q.id AS r_rr_id,
      NULL::boolean AS r_answered,
      'review recorded'::text AS r_outcome,
      nullif(btrim(concat_ws(' | ',
        nullif(btrim(q.tenant_ops_comment), ''),
        CASE
          WHEN q.status = 'rejected'
           AND nullif(btrim(q.rejected_reason), '') IS NOT NULL
           AND btrim(q.rejected_reason) IS DISTINCT FROM btrim(coalesce(q.tenant_ops_comment, ''))
          THEN 'Declined: ' || btrim(q.rejected_reason)
          ELSE NULL
        END
      )), '') AS r_feedback,
      jsonb_build_object(
        'stage', 'tenant_ops',
        'request_status', q.status,
        'tenant_ops_comment', nullif(btrim(q.tenant_ops_comment), '')
      ) AS r_extra
    FROM public.rent_requests q
    LEFT JOIN public.profiles tp ON tp.id = q.tenant_id
    WHERE q.tenant_ops_reviewed_by IN (SELECT id FROM staff)
      AND q.tenant_ops_reviewed_at IS NOT NULL
      AND q.tenant_ops_reviewed_at >= p_from
      AND q.tenant_ops_reviewed_at < p_to
      AND nullif(btrim(q.tenant_ops_comment), '') IS NOT NULL

    UNION ALL

    SELECT
      s.staff_id AS r_staff_id,
      s.created_at AS r_ts,
      'In-app voice call' AS r_source,
      4 AS r_prio,
      CASE s.target_role
        WHEN 'tenant' THEN 'tenant'
        WHEN 'agent' THEN 'agent'
        WHEN 'landlord' THEN 'landlord'
        ELSE 'other'
      END AS r_role,
      coalesce(nullif(btrim(s.target_name), ''), 'Unnamed') AS r_name,
      nullif(btrim(s.target_phone), '') AS r_phone,
      s.target_user_id AS r_person_id,
      NULL::uuid AS r_rr_id,
      (s.answered_at IS NOT NULL) AS r_answered,
      s.status::text AS r_outcome,
      nullif(btrim(s.summary), '') AS r_feedback,
      jsonb_build_object(
        'seconds', s.duration_seconds,
        'target_role', s.target_role
      ) AS r_extra
    FROM public.crm_call_sessions s
    WHERE s.staff_id IN (SELECT id FROM staff)
      AND s.created_at >= p_from
      AND s.created_at < p_to

    UNION ALL

    SELECT
      lcr.called_by AS r_staff_id,
      lcr.called_at AS r_ts,
      'Landlord Ops - Direct call log' AS r_source,
      5 AS r_prio,
      'landlord'::text AS r_role,
      coalesce(nullif(btrim(ll.name), ''), 'Unnamed') AS r_name,
      coalesce(nullif(btrim(ll.phone), ''), nullif(btrim(ll.mobile_money_number), '')) AS r_phone,
      lcr.landlord_id AS r_person_id,
      NULL::uuid AS r_rr_id,
      (lcr.status = 'picked_up') AS r_answered,
      CASE
        WHEN lcr.status = 'picked_up' THEN 'engaged'
        WHEN lcr.follow_up_at IS NOT NULL THEN 'callback_booked'
        ELSE coalesce(lcr.status, 'no_answer')
      END AS r_outcome,
      nullif(btrim(lcr.comment), '') AS r_feedback,
      jsonb_build_object(
        'status', lcr.status,
        'follow_up_at', lcr.follow_up_at
      ) AS r_extra
    FROM public.landlord_call_reports lcr
    LEFT JOIN public.landlords ll ON ll.id = lcr.landlord_id
    WHERE lcr.called_by IN (SELECT id FROM staff)
      AND lcr.called_at >= p_from
      AND lcr.called_at < p_to

    UNION ALL

    SELECT
      tcr.called_by AS r_staff_id,
      tcr.called_at AS r_ts,
      'Tenant Ops - Direct call log' AS r_source,
      5 AS r_prio,
      'tenant'::text AS r_role,
      coalesce(nullif(btrim(tp.full_name), ''), 'Unnamed') AS r_name,
      coalesce(
        nullif(btrim(tp.phone), ''),
        nullif(btrim(tp.mobile_money_number), ''),
        CASE
          WHEN tp.email ~ '^[0-9+]+@noapp\.welile\.user$'
          THEN regexp_replace(tp.email, '@noapp\.welile\.user$', '')
          ELSE NULL
        END
      ) AS r_phone,
      tcr.tenant_id AS r_person_id,
      tcr.rent_request_id AS r_rr_id,
      (tcr.outcome IN ('engaged', 'picked_up', 'answered')) AS r_answered,
      coalesce(nullif(btrim(tcr.outcome), ''), coalesce(tcr.status, 'no_answer')) AS r_outcome,
      nullif(btrim(tcr.comment), '') AS r_feedback,
      jsonb_build_object(
        'status', tcr.status,
        'follow_up_at', tcr.follow_up_at
      ) AS r_extra
    FROM public.tenant_call_reports tcr
    LEFT JOIN public.profiles tp ON tp.id = tcr.tenant_id
    WHERE tcr.called_by IN (SELECT id FROM staff)
      AND tcr.called_at >= p_from
      AND tcr.called_at < p_to
  ),
  in_win AS MATERIALIZED (
    SELECT
      right(regexp_replace(coalesce(x.r_phone, ''), '\D', '', 'g'), 9) AS r_phone9,
      x.*
    FROM raw x
    WHERE x.r_ts IS NOT NULL
      AND x.r_ts >= p_from
      AND x.r_ts < p_to
      AND x.r_name !~* '\mtest\M'
  ),
  kept AS (
    SELECT m.*
    FROM in_win m
    WHERE NOT EXISTS (
      SELECT 1
      FROM in_win h
      WHERE h.r_prio < m.r_prio
        AND h.r_staff_id = m.r_staff_id
        AND abs(extract(epoch FROM (h.r_ts - m.r_ts))) <= 900
        AND (
          (h.r_person_id IS NOT NULL AND h.r_person_id = m.r_person_id)
          OR (length(h.r_phone9) = 9 AND h.r_phone9 = m.r_phone9)
          OR (h.r_rr_id IS NOT NULL AND h.r_rr_id = m.r_rr_id AND h.r_role = m.r_role)
        )
    )
  )
  SELECT
    k.r_staff_id AS staff_id,
    s.s_short AS short_name,
    s.s_full AS staff_name,
    k.r_ts AS ts,
    (k.r_ts AT TIME ZONE 'Africa/Kampala')::date AS day,
    to_char(k.r_ts AT TIME ZONE 'Africa/Kampala', 'HH24:MI') AS hhmm,
    k.r_source AS source,
    k.r_role AS role,
    k.r_name AS name,
    k.r_phone AS phone,
    k.r_phone9 AS phone9,
    k.r_answered AS answered,
    k.r_outcome AS outcome,
    k.r_feedback AS feedback,
    k.r_extra AS extra,
    k.r_rr_id AS rr_id,
    k.r_person_id AS person_id,
    k.r_prio AS prio,
    coalesce(rv.reveals_cnt, 0) AS excluded_reveals
  FROM kept k
  JOIN staff s ON s.id = k.r_staff_id
  LEFT JOIN reveals_by_staff rv ON rv.s_id = k.r_staff_id
  ORDER BY s.s_short, k.r_ts;
END;
$$;

REVOKE ALL ON FUNCTION public.staff_calling_detailed_report(timestamptz, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_calling_detailed_report(timestamptz, timestamptz) TO authenticated, service_role;

REFRESH MATERIALIZED VIEW public.mv_landlord_hub_registry;
