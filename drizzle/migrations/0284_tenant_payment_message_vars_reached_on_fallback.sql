-- Fix the reached-date fallback: use the latest surviving payment date from the
-- payment records themselves (rent_requests has no last_payment_at column).
CREATE OR REPLACE FUNCTION public.get_tenant_payment_message_vars(p_tenant_ids uuid[])
 RETURNS TABLE(tenant_id uuid, rent_request_id uuid, rent_amount numeric, total_expected numeric, paid_to_date numeric, remaining numeric, pct_covered numeric, term_end date, days_left_in_cycle integer, days_after_cycle integer, tier_key text, current_access numeric, current_topup numeric, next_level_key text, next_level_label text, next_level_required numeric, next_level_access numeric, next_level_deadline date)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_rules jsonb := public.tenant_topup_eligibility_rules();
  v_qual numeric := COALESCE((v_rules->>'qualifying_pct')::numeric, 90);
  v_same numeric := COALESCE((v_rules->>'same_amount_pct')::numeric, 70);
  v_d0 integer := COALESCE((v_rules->'tiers'->0->>'max_days_after_cycle')::integer, 0);
  v_d1 integer := COALESCE((v_rules->'tiers'->1->>'max_days_after_cycle')::integer, 30);
  v_d2 integer := COALESCE((v_rules->'tiers'->2->>'max_days_after_cycle')::integer, 60);
  v_i0 numeric := COALESCE((v_rules->'tiers'->0->>'increase_pct')::numeric, 100);
  v_i1 numeric := COALESCE((v_rules->'tiers'->1->>'increase_pct')::numeric, 50);
  v_i2 numeric := COALESCE((v_rules->'tiers'->2->>'increase_pct')::numeric, 25);
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_uid uuid := auth.uid();
BEGIN
  IF NOT (
    COALESCE(auth.role(), '') = 'service_role'
    OR (v_uid IS NOT NULL AND p_tenant_ids = ARRAY[v_uid])
    OR (v_uid IS NOT NULL AND (
         public.is_ops_role(v_uid)
         OR public.has_role(v_uid, 'manager')
         OR public.has_role(v_uid, 'super_admin')
         OR public.has_role(v_uid, 'ceo')
         OR public.has_role(v_uid, 'coo')
         OR public.has_role(v_uid, 'cfo')
         OR public.has_role(v_uid, 'cto')
       ))
  ) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  RETURN QUERY
  WITH latest AS (
    SELECT DISTINCT ON (s.tenant_id)
           s.tenant_id, s.rent_request_id, s.term_end, s.total_amount, s.amount_repaid
    FROM public.v_rent_plan_schedule s
    WHERE s.tenant_id = ANY(p_tenant_ids)
    ORDER BY s.tenant_id, s.term_start DESC, s.rent_request_id
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
  last_pay AS (
    SELECT p.rent_request_id, MAX(p.d) AS last_paid_on
    FROM pays p
    GROUP BY 1
  ),
  base AS (
    SELECT l.tenant_id,
           l.rent_request_id,
           COALESCE(rr.rent_amount, 0)::numeric AS rent_amount,
           l.total_amount::numeric AS total_expected,
           l.amount_repaid::numeric AS paid_to_date,
           GREATEST(l.total_amount - l.amount_repaid, 0)::numeric AS remaining,
           CASE WHEN l.total_amount > 0
                THEN ROUND(l.amount_repaid * 100.0 / l.total_amount, 2) ELSE 0 END AS pct_covered,
           l.term_end,
           GREATEST(l.term_end - v_today, 0)::integer AS days_left_in_cycle,
           GREATEST(
             COALESCE(
               rc.reached_on,
               CASE
                 WHEN l.total_amount > 0
                  AND ROUND(l.amount_repaid * 100.0 / l.total_amount, 2) >= v_qual
                 THEN lp.last_paid_on
               END,
               v_today
             ) - l.term_end, 0)::integer AS days_after_cycle
    FROM latest l
    LEFT JOIN public.rent_requests rr ON rr.id = l.rent_request_id
    LEFT JOIN reached rc ON rc.rent_request_id = l.rent_request_id
    LEFT JOIN last_pay lp ON lp.rent_request_id = l.rent_request_id
  ),
  graded AS (
    SELECT b.*,
      CASE
        WHEN b.pct_covered >= v_qual AND b.days_after_cycle <= v_d0 THEN 'within_cycle'
        WHEN b.pct_covered >= v_qual AND b.days_after_cycle <= v_d1 THEN 'within_one_month'
        WHEN b.pct_covered >= v_qual AND b.days_after_cycle <= v_d2 THEN 'within_two_months'
        WHEN b.pct_covered >= v_qual THEN 'beyond_two_months'
        WHEN b.pct_covered >= v_same THEN 'same_amount_only'
        ELSE 'not_eligible'
      END AS tier_key
    FROM base b
  ),
  priced AS (
    SELECT g.*,
      CASE g.tier_key
        WHEN 'within_cycle' THEN v_i0
        WHEN 'within_one_month' THEN v_i1
        WHEN 'within_two_months' THEN v_i2
        ELSE 0
      END AS increase_pct,
      GREATEST(ROUND(g.total_expected * v_qual / 100 - g.paid_to_date), 0) AS to_qualifying,
      GREATEST(ROUND(g.total_expected * v_same / 100 - g.paid_to_date), 0) AS to_same_amount
    FROM graded g
  )
  SELECT
    p.tenant_id,
    p.rent_request_id,
    p.rent_amount,
    p.total_expected,
    p.paid_to_date,
    p.remaining,
    p.pct_covered,
    p.term_end,
    p.days_left_in_cycle,
    p.days_after_cycle,
    p.tier_key,
    CASE WHEN p.tier_key = 'not_eligible' THEN 0::numeric
         ELSE ROUND(p.rent_amount * (100 + p.increase_pct) / 100) END AS current_access,
    ROUND(p.rent_amount * p.increase_pct / 100) AS current_topup,
    nl.key AS next_level_key,
    nl.label AS next_level_label,
    nl.required AS next_level_required,
    nl.access AS next_level_access,
    nl.deadline AS next_level_deadline
  FROM priced p
  LEFT JOIN LATERAL (
    SELECT x.key, x.label, x.required, x.access, x.deadline
    FROM (
      VALUES
        ('within_cycle', 'full double', v_i0, p.term_end + v_d0, p.to_qualifying),
        ('within_one_month', 'half increase', v_i1, p.term_end + v_d1, p.to_qualifying),
        ('within_two_months', 'quarter increase', v_i2, p.term_end + v_d2, p.to_qualifying),
        ('same_amount_only', 'same amount again', 0::numeric, NULL::date, p.to_same_amount)
    ) AS t(key, label, inc, deadline, required)
    CROSS JOIN LATERAL (
      SELECT t.key, t.label, t.required,
             ROUND(p.rent_amount * (100 + t.inc) / 100) AS access,
             t.deadline
    ) x
    WHERE (t.deadline IS NULL OR v_today <= t.deadline)
      AND t.inc > CASE p.tier_key
                    WHEN 'within_cycle' THEN v_i0
                    WHEN 'within_one_month' THEN v_i1
                    WHEN 'within_two_months' THEN v_i2
                    ELSE -1 END
      AND t.required > 0
    ORDER BY t.required ASC, t.inc DESC
    LIMIT 1
  ) nl ON true;
END;
$function$;