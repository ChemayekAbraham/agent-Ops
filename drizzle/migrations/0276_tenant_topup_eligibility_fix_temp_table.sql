-- Removes an accidental temp-table statement that made the new report raise at runtime.
CREATE OR REPLACE FUNCTION public.get_tenant_topup_eligibility(
  p_search text DEFAULT NULL,
  p_agent_id uuid DEFAULT NULL,
  p_tier text DEFAULT NULL,
  p_limit integer DEFAULT 100,
  p_offset integer DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_rules jsonb := public.tenant_topup_eligibility_rules();
  v_qual numeric;
  v_same numeric;
  v_d0 integer;
  v_d1 integer;
  v_d2 integer;
  v_i0 numeric;
  v_i1 numeric;
  v_i2 numeric;
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 100), 1), 500);
  v_offset integer := GREATEST(COALESCE(p_offset, 0), 0);
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_search text := NULLIF(btrim(COALESCE(p_search, '')), '');
  v_rows jsonb;
  v_summary jsonb;
  v_total bigint;
BEGIN
  IF NOT (
    public.is_ops_role(auth.uid())
    OR public.has_role(auth.uid(), 'manager')
    OR public.has_role(auth.uid(), 'super_admin')
    OR public.has_role(auth.uid(), 'cto')
    OR public.has_role(auth.uid(), 'ceo')
    OR public.has_role(auth.uid(), 'coo')
    OR public.has_role(auth.uid(), 'cfo')
  ) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  v_qual := COALESCE((v_rules->>'qualifying_pct')::numeric, 90);
  v_same := COALESCE((v_rules->>'same_amount_pct')::numeric, 70);
  v_d0   := COALESCE((v_rules->'tiers'->0->>'max_days_after_cycle')::integer, 0);
  v_d1   := COALESCE((v_rules->'tiers'->1->>'max_days_after_cycle')::integer, 30);
  v_d2   := COALESCE((v_rules->'tiers'->2->>'max_days_after_cycle')::integer, 60);
  v_i0   := COALESCE((v_rules->'tiers'->0->>'increase_pct')::numeric, 100);
  v_i1   := COALESCE((v_rules->'tiers'->1->>'increase_pct')::numeric, 50);
  v_i2   := COALESCE((v_rules->'tiers'->2->>'increase_pct')::numeric, 25);

  WITH sched AS (
    SELECT s.rent_request_id, s.tenant_id, s.agent_id, s.term_start, s.term_end,
           s.term_days, s.daily_amount, s.total_amount, s.amount_repaid, s.is_live
    FROM public.v_rent_plan_schedule s
  ),
  latest AS (
    SELECT DISTINCT ON (sched.tenant_id) sched.*
    FROM sched
    ORDER BY sched.tenant_id, sched.term_start DESC, sched.rent_request_id
  ),
  pays AS (
    SELECT x.rent_request_id,
           (x.created_at AT TIME ZONE 'Africa/Kampala')::date AS d,
           SUM(x.amount) AS amt
    FROM (
      SELECT ac.rent_request_id, ac.created_at, ac.amount
      FROM public.agent_collections ac
      WHERE ac.rent_request_id IS NOT NULL AND ac.reversed_at IS NULL
      UNION ALL
      SELECT r.rent_request_id, r.created_at, r.amount
      FROM public.repayments r
      WHERE r.rent_request_id IS NOT NULL
    ) x
    JOIN latest l ON l.rent_request_id = x.rent_request_id
    GROUP BY 1, 2
  ),
  cum AS (
    SELECT p.rent_request_id, p.d,
           SUM(p.amt) OVER (PARTITION BY p.rent_request_id ORDER BY p.d) AS running
    FROM pays p
  ),
  reached AS (
    SELECT c.rent_request_id, MIN(c.d) AS reached_on
    FROM cum c
    JOIN latest l ON l.rent_request_id = c.rent_request_id
    WHERE l.total_amount > 0 AND c.running >= l.total_amount * v_qual / 100
    GROUP BY 1
  ),
  calc AS (
    SELECT
      l.tenant_id,
      l.rent_request_id,
      b.tenant_name,
      b.tenant_phone,
      b.district,
      b.rr_status,
      b.registration_type,
      b.rent_amount,
      b.expected_to_date,
      b.last_payment_at,
      l.agent_id,
      ap.full_name AS agent_name,
      ap.phone AS agent_phone,
      l.term_start,
      l.term_end,
      l.term_days,
      l.daily_amount,
      l.total_amount,
      l.amount_repaid,
      l.is_live,
      COALESCE(rr.repayment_frequency, 'daily') AS repayment_frequency,
      GREATEST(l.total_amount - l.amount_repaid, 0) AS outstanding,
      CASE WHEN l.total_amount > 0
           THEN ROUND(l.amount_repaid * 100.0 / l.total_amount, 2) ELSE 0 END AS pct_covered,
      rc.reached_on,
      GREATEST(COALESCE(rc.reached_on, v_today) - l.term_end, 0) AS days_after_cycle
    FROM latest l
    JOIN public.v_tenant_ops_tenant_base b ON b.rent_request_id = l.rent_request_id
    LEFT JOIN public.rent_requests rr ON rr.id = l.rent_request_id
    LEFT JOIN public.profiles ap ON ap.id = l.agent_id
    LEFT JOIN reached rc ON rc.rent_request_id = l.rent_request_id
    WHERE b.is_active OR l.amount_repaid > 0
  ),
  graded AS (
    SELECT c.*,
      CASE
        WHEN c.pct_covered >= v_qual AND c.days_after_cycle <= v_d0 THEN 'within_cycle'
        WHEN c.pct_covered >= v_qual AND c.days_after_cycle <= v_d1 THEN 'within_one_month'
        WHEN c.pct_covered >= v_qual AND c.days_after_cycle <= v_d2 THEN 'within_two_months'
        WHEN c.pct_covered >= v_qual THEN 'beyond_two_months'
        WHEN c.pct_covered >= v_same THEN 'same_amount_only'
        ELSE 'not_eligible'
      END AS tier_key
    FROM calc c
  ),
  priced AS (
    SELECT g.*,
      CASE g.tier_key
        WHEN 'within_cycle' THEN v_i0
        WHEN 'within_one_month' THEN v_i1
        WHEN 'within_two_months' THEN v_i2
        ELSE 0
      END AS increase_pct,
      CASE g.tier_key
        WHEN 'not_eligible' THEN false
        ELSE true
      END AS eligible
    FROM graded g
  ),
  final AS (
    SELECT p.*,
      ROUND(p.rent_amount * p.increase_pct / 100) AS max_topup_amount,
      CASE WHEN p.tier_key = 'not_eligible' THEN 0
           ELSE ROUND(p.rent_amount * (100 + p.increase_pct) / 100) END AS max_accessible_rent,
      GREATEST(ROUND(p.total_amount * v_qual / 100 - p.amount_repaid), 0) AS amount_to_qualifying,
      GREATEST(ROUND(p.total_amount * v_same / 100 - p.amount_repaid), 0) AS amount_to_same_amount
    FROM priced p
  ),
  filtered AS (
    SELECT f.* FROM final f
    WHERE (p_agent_id IS NULL OR f.agent_id = p_agent_id)
      AND (p_tier IS NULL OR f.tier_key = p_tier)
      AND (
        v_search IS NULL
        OR f.tenant_name ILIKE '%' || v_search || '%'
        OR COALESCE(f.tenant_phone, '') ILIKE '%' || v_search || '%'
        OR COALESCE(f.agent_name, '') ILIKE '%' || v_search || '%'
        OR f.tenant_id::text = v_search
        OR f.rent_request_id::text = v_search
      )
  )
  SELECT
    COALESCE(jsonb_agg(row_to_json(pageset)::jsonb ORDER BY pageset.pct_covered DESC), '[]'::jsonb),
    (SELECT count(*) FROM filtered),
    (SELECT jsonb_build_object(
        'tenants', count(*),
        'eligible', count(*) FILTER (WHERE eligible),
        'within_cycle', count(*) FILTER (WHERE tier_key = 'within_cycle'),
        'within_one_month', count(*) FILTER (WHERE tier_key = 'within_one_month'),
        'within_two_months', count(*) FILTER (WHERE tier_key = 'within_two_months'),
        'beyond_two_months', count(*) FILTER (WHERE tier_key = 'beyond_two_months'),
        'same_amount_only', count(*) FILTER (WHERE tier_key = 'same_amount_only'),
        'not_eligible', count(*) FILTER (WHERE tier_key = 'not_eligible'),
        'total_expected', COALESCE(SUM(total_amount), 0),
        'total_paid', COALESCE(SUM(amount_repaid), 0),
        'total_outstanding', COALESCE(SUM(outstanding), 0),
        'total_topup_accessible', COALESCE(SUM(max_topup_amount), 0)
      ) FROM filtered)
  INTO v_rows, v_total, v_summary
  FROM (
    SELECT
      f.tenant_id, f.rent_request_id, f.tenant_name, f.tenant_phone, f.district,
      f.rr_status, f.registration_type, f.agent_id, f.agent_name, f.agent_phone,
      f.rent_amount, f.total_amount, f.daily_amount, f.amount_repaid, f.outstanding,
      f.expected_to_date, f.pct_covered, f.term_start, f.term_end, f.term_days,
      f.repayment_frequency, f.is_live, f.last_payment_at, f.reached_on,
      f.days_after_cycle, f.tier_key, f.increase_pct, f.eligible,
      f.max_topup_amount, f.max_accessible_rent,
      f.amount_to_qualifying, f.amount_to_same_amount,
      GREATEST(f.term_end - v_today, 0) AS days_left_in_cycle,
      jsonb_build_array(
        jsonb_build_object(
          'key','within_cycle','label','Within payment cycle','increase_pct',v_i0,
          'max_accessible_rent', ROUND(f.rent_amount * (100 + v_i0) / 100),
          'deadline', f.term_end + v_d0,
          'amount_required', GREATEST(ROUND(f.total_amount * v_qual / 100 - f.amount_repaid), 0),
          'window_open', v_today <= f.term_end + v_d0,
          'reached', f.tier_key = 'within_cycle'
        ),
        jsonb_build_object(
          'key','within_one_month','label','Within one month after cycle','increase_pct',v_i1,
          'max_accessible_rent', ROUND(f.rent_amount * (100 + v_i1) / 100),
          'deadline', f.term_end + v_d1,
          'amount_required', GREATEST(ROUND(f.total_amount * v_qual / 100 - f.amount_repaid), 0),
          'window_open', v_today <= f.term_end + v_d1,
          'reached', f.tier_key = 'within_one_month'
        ),
        jsonb_build_object(
          'key','within_two_months','label','Within two months after cycle','increase_pct',v_i2,
          'max_accessible_rent', ROUND(f.rent_amount * (100 + v_i2) / 100),
          'deadline', f.term_end + v_d2,
          'amount_required', GREATEST(ROUND(f.total_amount * v_qual / 100 - f.amount_repaid), 0),
          'window_open', v_today <= f.term_end + v_d2,
          'reached', f.tier_key = 'within_two_months'
        ),
        jsonb_build_object(
          'key','same_amount_only','label','Same amount as before, no increase','increase_pct',0,
          'max_accessible_rent', ROUND(f.rent_amount),
          'deadline', NULL,
          'amount_required', GREATEST(ROUND(f.total_amount * v_same / 100 - f.amount_repaid), 0),
          'window_open', true,
          'reached', f.tier_key IN ('same_amount_only','beyond_two_months')
        )
      ) AS levels
    FROM filtered f
    ORDER BY f.pct_covered DESC, f.tenant_name
    LIMIT v_limit OFFSET v_offset
  ) pageset;

  RETURN jsonb_build_object(
    'rules', v_rules,
    'as_of', v_today,
    'total', COALESCE(v_total, 0),
    'limit', v_limit,
    'offset', v_offset,
    'summary', COALESCE(v_summary, '{}'::jsonb),
    'rows', COALESCE(v_rows, '[]'::jsonb)
  );
END;
$$;