-- Agent Monitoring: the Expected vs paid tab on the payout clock, and one staff gate.
--
-- Adds (all read-only, no data written, no ledger):
--   _am_staff_ok()      who may read the Agent Monitoring figures: the same role list that
--                       get_agent_monitoring_positions already used (manager, super_admin, coo,
--                       ceo, cto, cfo, operations, tenant_ops, agent_ops, financial_ops).
--   am_plan_positions() the Expected vs paid tab's per-plan position, identical in shape to
--                       get_agent_monitoring_positions, but counted from the landlord-payout
--                       clock (am_plan_clock) and only for plans in the `counting` and
--                       `outstanding_balance` buckets. Same population view (v_rent_plan_schedule),
--                       same instalment shape (daily, weekly = daily x 7, monthly = daily x 30,
--                       last instalment capped at the total), same payment de-duplication, same
--                       bands. The frozen historical day expectations (agent_expected_day_plans)
--                       are NOT used: they are keyed to the old start dates.
-- am_plan_clock / am_plan_arrears (20261012100000) are re-created with the same bodies and the
-- same signatures; the ONLY change is the role check, which now calls _am_staff_ok() so users who
-- could open the page before (cto, operations, agent_ops, financial_ops) are not refused.
-- Rollback: supabase/rollbacks/20261012150000_am_plan_positions_and_staff_gate.rollback.sql

CREATE OR REPLACE FUNCTION public._am_staff_ok()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles ur
     WHERE ur.user_id = auth.uid()
       AND ur.enabled = true
       AND ur.role::text IN ('manager','super_admin','coo','ceo','cto','cfo',
                             'operations','tenant_ops','agent_ops','financial_ops')
  );
$function$;

REVOKE ALL ON FUNCTION public._am_staff_ok() FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public._am_staff_ok() TO authenticated;

CREATE OR REPLACE FUNCTION public.am_plan_clock(p_rent_request_ids uuid[])
RETURNS TABLE (
  rent_request_id               uuid,
  bucket                        text,
  landlord_paid_count           integer,
  landlord_paid_total           numeric,
  landlord_paid_dates_estimated integer,
  first_landlord_paid_on        date,
  last_landlord_paid_on         date,
  clock_start                   date,
  clock_end                     date,
  current_start                 date,
  shift_days                    integer
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
#variable_conflict use_column
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL OR NOT public._am_staff_ok() THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
  END IF;

  IF p_rent_request_ids IS NULL OR cardinality(p_rent_request_ids) = 0 THEN
    RETURN;
  END IF;
  IF cardinality(p_rent_request_ids) > 10000 THEN
    RAISE EXCEPTION 'Too many Rent Plans in one call (max 10000)' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  WITH ids AS (
    SELECT DISTINCT u.id FROM unnest(p_rent_request_ids) AS u(id)
  ),
  pay AS (
    SELECT d.rid,
           count(*)::int                                  AS n,
           COALESCE(sum(d.amount), 0)                     AS total,
           count(*) FILTER (WHERE d.estimated)::int       AS est,
           min(d.day)                                     AS first_on,
           max(d.day)                                     AS last_on
      FROM (
        SELECT lp.rent_request_id AS rid,
               lp.amount,
               (lp.finops_disbursed_at IS NULL AND lp.disbursed_at IS NULL) AS estimated,
               (COALESCE(lp.finops_disbursed_at, lp.disbursed_at, lp.otp_verified_at)
                  AT TIME ZONE 'Africa/Kampala')::date AS day
          FROM public.landlord_payouts lp
         WHERE lp.rent_request_id IN (SELECT id FROM ids)
           AND lp.status IN ('awaiting_agent_receipt', 'completed')
      ) d
     GROUP BY d.rid
  )
  SELECT rr.id,
         CASE
           WHEN rr.registration_type = 'outstanding_balance' THEN 'outstanding_balance'
           WHEN COALESCE(p.n, 0) > 0                         THEN 'counting'
           WHEN COALESCE(rr.amount_repaid, 0) > 0
                OR EXISTS (SELECT 1 FROM public.agent_collections ac
                            WHERE ac.rent_request_id = rr.id AND ac.reversed_at IS NULL)
                                                             THEN 'tenant_paying_no_landlord'
           ELSE 'awaiting_landlord'
         END,
         COALESCE(p.n, 0),
         COALESCE(p.total, 0),
         COALESCE(p.est, 0),
         p.first_on,
         p.last_on,
         c.cs,
         CASE WHEN c.cs IS NOT NULL AND rr.duration_days IS NOT NULL
              THEN c.cs + rr.duration_days - 1 END,
         rr.repayment_starts_on,
         CASE WHEN c.cs IS NOT NULL AND rr.repayment_starts_on IS NOT NULL
              THEN c.cs - rr.repayment_starts_on END
    FROM ids
    JOIN public.rent_requests rr ON rr.id = ids.id
    LEFT JOIN pay p ON p.rid = rr.id
    CROSS JOIN LATERAL (
      SELECT CASE
               WHEN rr.registration_type = 'outstanding_balance' THEN rr.repayment_starts_on
               WHEN COALESCE(p.n, 0) > 0                         THEN p.last_on + 1
               ELSE NULL::date
             END AS cs
    ) c;
END;
$function$;

CREATE OR REPLACE FUNCTION public.am_plan_arrears(p_rent_request_ids uuid[], p_as_at date DEFAULT NULL)
RETURNS TABLE (
  rent_request_id  uuid,
  bucket           text,
  cadence          text,
  unit             text,
  clock_start      date,
  expected_to_date numeric,
  paid_to_date     numeric,
  arrears          numeric,
  days_behind      integer,
  days_ahead       integer,
  periods_behind   integer,
  periods_ahead    integer
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
#variable_conflict use_column
DECLARE
  v_uid uuid := auth.uid();
  v_as_at date := COALESCE(p_as_at, (now() AT TIME ZONE 'Africa/Kampala')::date);
BEGIN
  IF v_uid IS NULL OR NOT public._am_staff_ok() THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
  END IF;

  IF p_rent_request_ids IS NULL OR cardinality(p_rent_request_ids) = 0 THEN
    RETURN;
  END IF;
  IF cardinality(p_rent_request_ids) > 10000 THEN
    RAISE EXCEPTION 'Too many Rent Plans in one call (max 10000)' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  WITH clk AS (
    SELECT * FROM public.am_plan_clock(p_rent_request_ids)
  ),
  coll AS (
    SELECT ac.rent_request_id AS rid, COALESCE(sum(ac.amount), 0) AS paid
      FROM public.agent_collections ac
     WHERE ac.rent_request_id IN (SELECT rent_request_id FROM clk)
       AND ac.reversed_at IS NULL
       AND (ac.created_at AT TIME ZONE 'Africa/Kampala')::date <= v_as_at
     GROUP BY ac.rent_request_id
  ),
  rep AS (
    -- Tenant self-payments land in repayments; a repayment that mirrors a collection
    -- (same plan, same amount, under 5 minutes apart) is the same money, count it once.
    SELECT rp.rent_request_id AS rid, COALESCE(sum(rp.amount), 0) AS paid
      FROM public.repayments rp
     WHERE rp.rent_request_id IN (SELECT rent_request_id FROM clk)
       AND (rp.created_at AT TIME ZONE 'Africa/Kampala')::date <= v_as_at
       AND NOT EXISTS (
         SELECT 1 FROM public.agent_collections ac
          WHERE ac.rent_request_id = rp.rent_request_id
            AND ac.reversed_at IS NULL
            AND COALESCE(ac.amount, 0) = COALESCE(rp.amount, 0)
            AND abs(extract(epoch FROM (ac.created_at - rp.created_at))) < 300)
     GROUP BY rp.rent_request_id
  ),
  base AS (
    SELECT k.rent_request_id AS rid, k.bucket, k.clock_start AS cs,
           (lower(COALESCE(rr.repayment_frequency, 'daily')) = 'weekly') AS weekly,
           COALESCE(rr.total_repayment, 0) AS total,
           COALESCE(rr.daily_repayment, 0)
             * CASE WHEN lower(COALESCE(rr.repayment_frequency, 'daily')) = 'weekly' THEN 7 ELSE 1 END AS period,
           COALESCE(c.paid, 0) + COALESCE(r.paid, 0) AS paid
      FROM clk k
      JOIN public.rent_requests rr ON rr.id = k.rent_request_id
      LEFT JOIN coll c ON c.rid = k.rent_request_id
      LEFT JOIN rep  r ON r.rid = k.rent_request_id
  ),
  due AS (
    SELECT b.*,
           CASE WHEN b.cs IS NULL OR v_as_at < b.cs THEN 0
                WHEN b.weekly THEN ((v_as_at - b.cs) / 7) + 1
                ELSE (v_as_at - b.cs) + 1 END AS raw_periods,
           CASE WHEN b.period > 0 THEN ceil(b.total / b.period)::int ELSE 0 END AS total_periods
      FROM base b
  ),
  calc AS (
    SELECT d.*,
           CASE WHEN d.total_periods > 0 THEN least(d.raw_periods, d.total_periods) ELSE d.raw_periods END AS periods_due
      FROM due d
  ),
  money AS (
    SELECT c.*,
           CASE WHEN c.cs IS NULL THEN 0::numeric
                ELSE least(CASE WHEN c.total > 0 THEN c.total ELSE c.period * c.periods_due END,
                           c.period * c.periods_due) END AS expected
      FROM calc c
  )
  SELECT m.rid,
         m.bucket,
         CASE WHEN m.weekly THEN 'weekly' ELSE 'daily' END,
         CASE WHEN m.weekly THEN 'week'   ELSE 'day'   END,
         m.cs,
         m.expected,
         m.paid,
         CASE WHEN m.cs IS NULL THEN 0::numeric ELSE greatest(0, m.expected - m.paid) END,
         (CASE WHEN m.cs IS NULL OR m.period <= 0 THEN 0
               ELSE greatest(0, ceil(greatest(0, m.expected - m.paid) / m.period)::int - 1) END)
           * CASE WHEN m.weekly THEN 7 ELSE 1 END,
         (CASE WHEN m.cs IS NULL OR m.period <= 0 THEN 0
               ELSE floor(greatest(0, m.paid - m.expected) / m.period)::int END)
           * CASE WHEN m.weekly THEN 7 ELSE 1 END,
         CASE WHEN m.cs IS NULL OR m.period <= 0 THEN 0
              ELSE greatest(0, ceil(greatest(0, m.expected - m.paid) / m.period)::int - 1) END,
         CASE WHEN m.cs IS NULL OR m.period <= 0 THEN 0
              ELSE floor(greatest(0, m.paid - m.expected) / m.period)::int END
    FROM money m;
END;
$function$;

REVOKE ALL ON FUNCTION public.am_plan_clock(uuid[]) FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION public.am_plan_arrears(uuid[], date) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.am_plan_clock(uuid[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.am_plan_arrears(uuid[], date) TO authenticated;

CREATE OR REPLACE FUNCTION public.am_plan_positions(
  p_from date,
  p_to date,
  p_include_self_payments boolean DEFAULT true
)
RETURNS TABLE(
  rent_request_id uuid, agent_id uuid, tenant_id uuid, frequency text, instalment_amount numeric,
  term_start date, term_end date, obligation_end date, total_repayment numeric,
  expected_in_period numeric, due_dates_in_period integer,
  paid_in_period_agent numeric, paid_in_period_self numeric,
  expected_to_date numeric, paid_to_date numeric, arrears numeric, credit_ahead numeric,
  covered_through date, outstanding numeric, position_band text, is_eligible boolean,
  exclusion_reason text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
#variable_conflict use_column
BEGIN
  IF auth.uid() IS NULL OR NOT public._am_staff_ok() THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH base AS (
    -- Same population as get_agent_monitoring_positions.
    SELECT s.rent_request_id, s.agent_id, s.tenant_id, s.daily_amount, s.total_amount,
           s.amount_repaid, s.term_days, s.last_pay_date,
           COALESCE(rr.repayment_frequency, 'daily') AS freq
      FROM public.v_rent_plan_schedule s
      JOIN public.rent_requests rr ON rr.id = s.rent_request_id
     WHERE s.agent_id IS NOT NULL
  ),
  clk AS (
    SELECT * FROM public.am_plan_clock(ARRAY(SELECT b.rent_request_id FROM base b))
  ),
  plans AS (
    SELECT b.rent_request_id, b.agent_id, b.tenant_id, b.daily_amount, b.total_amount,
           b.amount_repaid, b.term_days, b.freq,
           k.clock_start AS term_start,
           k.clock_start + b.term_days - 1 AS term_end,
           CASE WHEN b.total_amount - b.amount_repaid > 0
                THEN k.clock_start + b.term_days - 1
                ELSE LEAST(k.clock_start + b.term_days - 1, COALESCE(b.last_pay_date, k.clock_start - 1))
           END AS obligation_end,
           CASE b.freq WHEN 'weekly' THEN b.daily_amount * 7
                       WHEN 'monthly' THEN b.daily_amount * 30
                       ELSE b.daily_amount END AS instalment,
           CASE b.freq WHEN 'weekly' THEN ceil(b.term_days::numeric / 7)::int
                       WHEN 'monthly' THEN greatest(1, ceil(b.term_days::numeric / 30))::int
                       ELSE b.term_days END AS n_inst
      FROM base b
      JOIN clk k ON k.rent_request_id = b.rent_request_id
     WHERE k.bucket IN ('counting', 'outstanding_balance')
       AND k.clock_start IS NOT NULL
  ),
  expanded AS (
    SELECT p.rent_request_id, p.obligation_end,
           CASE p.freq WHEN 'monthly' THEN (p.term_start + (g.k || ' month')::interval)::date
                       WHEN 'weekly'  THEN p.term_start + (g.k * 7)
                       ELSE p.term_start + g.k END AS due_on,
           (least(p.instalment * (g.k + 1), p.total_amount)
          - least(p.instalment * g.k,       p.total_amount)) AS amount
      FROM plans p
      CROSS JOIN LATERAL generate_series(0, greatest(p.n_inst - 1, 0)) g(k)
  ),
  due AS (
    SELECT e.rent_request_id, e.due_on, e.amount
      FROM expanded e
     WHERE e.due_on <= e.obligation_end AND e.amount > 0
  ),
  cum AS (
    SELECT d.rent_request_id, d.due_on, d.amount,
           SUM(d.amount) OVER (PARTITION BY d.rent_request_id ORDER BY d.due_on) AS cum_expected
      FROM due d
  ),
  pay AS (
    SELECT c.rent_request_id,
           (c.created_at AT TIME ZONE 'Africa/Kampala')::date AS pay_date,
           COALESCE(c.amount, 0) AS amount,
           'agent'::text AS src
      FROM public.agent_collections c
     WHERE c.reversed_at IS NULL AND c.rent_request_id IS NOT NULL
       AND c.rent_request_id IN (SELECT p.rent_request_id FROM plans p)
    UNION ALL
    SELECT r.rent_request_id,
           (r.created_at AT TIME ZONE 'Africa/Kampala')::date,
           COALESCE(r.amount, 0),
           'self'::text
      FROM public.repayments r
     WHERE r.rent_request_id IS NOT NULL
       AND p_include_self_payments
       AND r.rent_request_id IN (SELECT p.rent_request_id FROM plans p)
       AND NOT EXISTS (
         SELECT 1 FROM public.agent_collections c2
          WHERE c2.reversed_at IS NULL
            AND c2.rent_request_id = r.rent_request_id
            AND COALESCE(c2.amount, 0) = COALESCE(r.amount, 0)
            AND abs(EXTRACT(epoch FROM (c2.created_at - r.created_at))) <= 300)
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
           d.paid_agent AS paid_in_period_agent, d.paid_self AS paid_in_period_self,
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
   WHERE c.reversed_at IS NULL
     AND c.rent_request_id IS NULL
     AND c.agent_id IS NOT NULL
     AND (c.created_at AT TIME ZONE 'Africa/Kampala')::date BETWEEN p_from AND p_to
   GROUP BY c.agent_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.am_plan_positions(date, date, boolean) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.am_plan_positions(date, date, boolean) TO authenticated;
