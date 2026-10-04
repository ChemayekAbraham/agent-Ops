CREATE OR REPLACE FUNCTION public.get_agent_monitoring_positions(
  p_from date,
  p_to date,
  p_include_self_payments boolean DEFAULT true
)
RETURNS TABLE (
  rent_request_id uuid,
  agent_id uuid,
  tenant_id uuid,
  frequency text,
  instalment_amount numeric,
  term_start date,
  term_end date,
  obligation_end date,
  total_repayment numeric,
  expected_in_period numeric,
  due_dates_in_period integer,
  paid_in_period_agent numeric,
  paid_in_period_self numeric,
  expected_to_date numeric,
  paid_to_date numeric,
  arrears numeric,
  credit_ahead numeric,
  covered_through date,
  outstanding numeric,
  position_band text,
  is_eligible boolean,
  exclusion_reason text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH gate AS (
    SELECT EXISTS (
      SELECT 1 FROM public.user_roles ur
      WHERE ur.user_id = auth.uid()
        AND ur.enabled = true
        AND ur.role::text IN (
          'manager','super_admin','coo','ceo','cto','cfo',
          'operations','tenant_ops','agent_ops','financial_ops'
        )
    ) AS ok
  ),
  plans AS (
    SELECT s.rent_request_id, s.agent_id, s.tenant_id, s.daily_amount,
           s.total_amount, s.amount_repaid, s.term_start, s.term_end,
           s.obligation_end,
           COALESCE(rr.repayment_frequency, 'daily') AS freq,
           CASE COALESCE(rr.repayment_frequency, 'daily')
             WHEN 'weekly'  THEN s.daily_amount * 7
             WHEN 'monthly' THEN s.daily_amount * 30
             ELSE s.daily_amount
           END AS instalment
    FROM public.v_rent_plan_schedule s
    JOIN public.rent_requests rr ON rr.id = s.rent_request_id
    CROSS JOIN gate
    WHERE gate.ok AND s.agent_id IS NOT NULL
  ),
  -- Frequency-aware due dates from the canonical schedule engine, with the
  -- frozen historical expectation taking precedence for past days.
  due AS (
    SELECT d.rent_request_id,
           d.due_on,
           CASE
             WHEN d.due_on < (now() AT TIME ZONE 'Africa/Kampala')::date
                  AND f.expected_ugx IS NOT NULL THEN f.expected_ugx
             ELSE d.amount
           END AS amount
    FROM public.rent_plan_schedule_days('2000-01-01'::date, '2100-01-01'::date) d
    LEFT JOIN public.agent_expected_day_plans f
      ON f.rent_request_id = d.rent_request_id AND f.day = d.due_on
    WHERE EXISTS (SELECT 1 FROM plans p WHERE p.rent_request_id = d.rent_request_id)
  ),
  cum AS (
    SELECT rent_request_id, due_on, amount,
           SUM(amount) OVER (PARTITION BY rent_request_id ORDER BY due_on) AS cum_expected
    FROM due
  ),
  -- Payments from both channels, de-duplicated: a self-payment that mirrors an
  -- agent collection (same plan, same amount, within 5 minutes) is counted once.
  pay AS (
    SELECT c.rent_request_id,
           (c.created_at AT TIME ZONE 'Africa/Kampala')::date AS pay_date,
           COALESCE(c.amount, 0) AS amount,
           'agent'::text AS src
    FROM public.agent_collections c
    WHERE c.rent_request_id IS NOT NULL
    UNION ALL
    SELECT r.rent_request_id,
           (r.created_at AT TIME ZONE 'Africa/Kampala')::date AS pay_date,
           COALESCE(r.amount, 0) AS amount,
           'self'::text AS src
    FROM public.repayments r
    WHERE r.rent_request_id IS NOT NULL
      AND p_include_self_payments
      AND NOT EXISTS (
        SELECT 1 FROM public.agent_collections c2
        WHERE c2.rent_request_id = r.rent_request_id
          AND COALESCE(c2.amount, 0) = COALESCE(r.amount, 0)
          AND abs(EXTRACT(epoch FROM (c2.created_at - r.created_at))) <= 300
      )
  ),
  agg AS (
    SELECT p.rent_request_id,
           COALESCE(SUM(CASE WHEN c.due_on BETWEEN p_from AND p_to THEN c.amount END), 0) AS expected_in_period,
           COALESCE(COUNT(CASE WHEN c.due_on BETWEEN p_from AND p_to THEN 1 END), 0)::int AS due_dates_in_period,
           COALESCE(MAX(CASE WHEN c.due_on <= p_to THEN c.cum_expected END), 0) AS expected_to_date
    FROM plans p
    LEFT JOIN cum c ON c.rent_request_id = p.rent_request_id
    GROUP BY p.rent_request_id
  ),
  paid AS (
    SELECT p.rent_request_id,
           COALESCE(SUM(CASE WHEN y.pay_date <= p_to THEN y.amount END), 0) AS paid_to_date,
           COALESCE(SUM(CASE WHEN y.pay_date BETWEEN p_from AND p_to AND y.src = 'agent' THEN y.amount END), 0) AS paid_agent,
           COALESCE(SUM(CASE WHEN y.pay_date BETWEEN p_from AND p_to AND y.src = 'self'  THEN y.amount END), 0) AS paid_self
    FROM plans p
    LEFT JOIN pay y ON y.rent_request_id = p.rent_request_id
    GROUP BY p.rent_request_id
  ),
  covered AS (
    SELECT p.rent_request_id,
           MAX(c.due_on) FILTER (WHERE c.cum_expected <= d.paid_to_date) AS covered_through
    FROM plans p
    JOIN paid d ON d.rent_request_id = p.rent_request_id
    LEFT JOIN cum c ON c.rent_request_id = p.rent_request_id
    GROUP BY p.rent_request_id
  ),
  scored AS (
    SELECT p.rent_request_id, p.agent_id, p.tenant_id, p.freq AS frequency,
           p.instalment AS instalment_amount, p.term_start, p.term_end, p.obligation_end,
           p.total_amount AS total_repayment,
           a.expected_in_period, a.due_dates_in_period,
           d.paid_agent AS paid_in_period_agent,
           d.paid_self AS paid_in_period_self,
           a.expected_to_date, d.paid_to_date,
           GREATEST(a.expected_to_date - d.paid_to_date, 0) AS arrears,
           GREATEST(d.paid_to_date - a.expected_to_date, 0) AS credit_ahead,
           v.covered_through,
           GREATEST(p.total_amount - d.paid_to_date, 0) AS outstanding,
           (e.rent_request_id IS NOT NULL) AS is_eligible
    FROM plans p
    JOIN agg a  ON a.rent_request_id = p.rent_request_id
    JOIN paid d ON d.rent_request_id = p.rent_request_id
    LEFT JOIN covered v ON v.rent_request_id = p.rent_request_id
    LEFT JOIN public.v_tenant_daily_eligibility e ON e.rent_request_id = p.rent_request_id
  )
  SELECT s.rent_request_id, s.agent_id, s.tenant_id, s.frequency, s.instalment_amount,
         s.term_start, s.term_end, s.obligation_end, s.total_repayment,
         s.expected_in_period, s.due_dates_in_period,
         s.paid_in_period_agent, s.paid_in_period_self,
         s.expected_to_date, s.paid_to_date, s.arrears, s.credit_ahead,
         s.covered_through, s.outstanding,
         CASE
           WHEN s.outstanding <= 0 THEN 'cleared'
           WHEN p_to < s.term_start THEN 'not_due_yet'
           WHEN s.instalment_amount > 0 AND s.credit_ahead >= s.instalment_amount THEN 'ahead'
           WHEN s.arrears <= 0 THEN 'on_track'
           WHEN s.instalment_amount > 0 AND s.arrears < s.instalment_amount THEN 'behind'
           ELSE 'overdue'
         END AS position_band,
         s.is_eligible,
         CASE
           WHEN s.is_eligible THEN NULL
           WHEN s.outstanding <= 0 THEN 'Plan fully repaid'
           ELSE 'Not collectable today (paused, reversed or landlord settled)'
         END AS exclusion_reason
  FROM scored s

  UNION ALL

  -- Agent cash with no plan attached: reported honestly instead of guessed.
  SELECT NULL::uuid, c.agent_id, NULL::uuid, NULL::text, 0::numeric,
         NULL::date, NULL::date, NULL::date, 0::numeric,
         0::numeric, 0,
         SUM(COALESCE(c.amount, 0)), 0::numeric,
         0::numeric, SUM(COALESCE(c.amount, 0)), 0::numeric, 0::numeric,
         NULL::date, 0::numeric, 'unattributed'::text, false,
         'Collection has no rent plan reference'::text
  FROM public.agent_collections c
  CROSS JOIN gate
  WHERE gate.ok
    AND c.rent_request_id IS NULL
    AND c.agent_id IS NOT NULL
    AND (c.created_at AT TIME ZONE 'Africa/Kampala')::date BETWEEN p_from AND p_to
  GROUP BY c.agent_id;
$$;

REVOKE ALL ON FUNCTION public.get_agent_monitoring_positions(date, date, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_agent_monitoring_positions(date, date, boolean) TO authenticated;