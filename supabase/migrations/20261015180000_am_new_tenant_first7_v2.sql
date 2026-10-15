-- Agent Monitoring: the first seven days of every new Rent Plan, v2.
--
-- THREE NEW read-only functions. am_new_tenant_first7 and every other existing function, table and policy are untouched; nothing here
-- moves money.
--
--   am_new_tenant_first7_v2(p_from, p_to, p_frequency, p_agent_id)
--       One row per Rent Plan whose FIRST landlord payout (Kampala date) is between p_from and p_to, with the seven days after it laid out
--       as arrays: paid, due and state per day.
--   am_new_tenant_first7_summary_v2(same arguments)
--       Headline counts, the day-1 count and %, per-day payer counts, and collected vs expected, from the same rows (one definition).
--   am_new_tenant_first7_payments(p_rent_request_id)
--       Every collection (time, amount, method, agent) inside that plan's seven-day window.
--
-- Definitions (one place, written in supabase/AGENTS.md):
--   plans      from _am_plan_clock_core, bucket counting or outstanding_balance, first_landlord_paid_on in range. Plans must be
--              funded / repaying / completed. (An outstanding_balance plan has no landlord payout, so it never has a first_landlord_paid_on
--              and does not appear.)
--   day 1      first_landlord_paid_on + 1 (a Kampala date). Days 1 to 7 follow.
--   frequency  rent_requests.repayment_frequency (NULL counts as daily), never tops_plan_clock.cadence.
--   paid       sum of agent_collections.amount with reversed_at IS NULL, by Kampala date of created_at.
--   due        daily: daily_repayment each day. weekly: daily_repayment x 7 on day 1 only (the first weekly instalment falls due on the first
--              day of the clock, the next on day 8 - the same rule as _am_plan_arrears_core) and 0 on days 2 to 7. Never more than the
--              plan's total_repayment.
--   day state  future   the day has not ended: after today, or today with nothing paid yet
--              not_due  nothing is due that day (weekly days 2 to 7)
--              paid     paid >= due
--              part     0 < paid < due
--              missed   the day has ended with nothing paid
--   expected_to_date   sum of due over the days that have ENDED (before today)
--   first_paid_day     the first day (1 to 7) with a payment, or NULL
--   row status too_early    day 1 is after today
--              not_started  no payment yet (day 1 has begun)
--              on_track     paid_7d >= expected_to_date
--              behind       paid_7d <  expected_to_date
--
-- Access: auth.uid() present and _am_staff_ok(), else SQLSTATE 42501. EXECUTE for authenticated only. SECURITY DEFINER, STABLE,
-- search_path = public. Range: at most 31 days inclusive (otherwise 22023).
-- Rollback: supabase/rollbacks/20261015180000_am_new_tenant_first7_v2.rollback.sql

CREATE OR REPLACE FUNCTION public.am_new_tenant_first7_v2(
  p_from date,
  p_to date,
  p_frequency text DEFAULT NULL,
  p_agent_id uuid DEFAULT NULL
)
RETURNS TABLE (
  rent_request_id   uuid,
  tenant_id         uuid,
  tenant_name       text,
  tenant_phone      text,
  agent_id          uuid,
  agent_name        text,
  landlord_paid_on  date,
  day1              date,
  frequency         text,
  daily_due         numeric,
  total_repayment   numeric,
  day_paid          numeric[],
  day_due           numeric[],
  day_state         text[],
  paid_7d           numeric,
  expected_to_date  numeric,
  first_paid_day    integer,
  row_status        text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
#variable_conflict use_column
DECLARE
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_freq text := NULLIF(lower(btrim(COALESCE(p_frequency, ''))), '');
  v_ids uuid[];
BEGIN
  IF auth.uid() IS NULL OR NOT public._am_staff_ok() THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
  END IF;
  IF p_from IS NULL OR p_to IS NULL THEN
    RAISE EXCEPTION 'RANGE_REQUIRED: p_from and p_to are required' USING ERRCODE = '22023';
  END IF;
  IF p_to < p_from THEN
    RAISE EXCEPTION 'RANGE_INVALID: p_to is before p_from' USING ERRCODE = '22023';
  END IF;
  IF p_to - p_from > 30 THEN
    RAISE EXCEPTION 'RANGE_TOO_LARGE: the range is at most 31 days' USING ERRCODE = '22023';
  END IF;
  IF v_freq IS NOT NULL AND v_freq NOT IN ('daily', 'weekly') THEN
    RAISE EXCEPTION 'FREQUENCY_INVALID: p_frequency must be daily, weekly or empty' USING ERRCODE = '22023';
  END IF;

  -- plans with a landlord payout in the range; the clock then decides which of them were FIRST paid in it
  SELECT array_agg(DISTINCT lp.rent_request_id) INTO v_ids
    FROM public.landlord_payouts lp
    JOIN public.rent_requests rr ON rr.id = lp.rent_request_id
   WHERE lp.status IN ('awaiting_agent_receipt', 'completed')
     AND (COALESCE(lp.finops_disbursed_at, lp.disbursed_at, lp.otp_verified_at) AT TIME ZONE 'Africa/Kampala')::date BETWEEN p_from AND p_to
     AND rr.status IN ('funded', 'repaying', 'completed')
     AND (p_agent_id IS NULL OR rr.agent_id = p_agent_id)
     AND (v_freq IS NULL OR lower(COALESCE(rr.repayment_frequency, 'daily')) = v_freq);
  IF v_ids IS NULL THEN RETURN; END IF;

  RETURN QUERY
  WITH clk AS (
    SELECT k.rent_request_id AS rid, k.first_landlord_paid_on AS fp
      FROM public._am_plan_clock_core(v_ids) k
     WHERE k.bucket IN ('counting', 'outstanding_balance')
       AND k.first_landlord_paid_on BETWEEN p_from AND p_to
  ), base AS (
    SELECT c.rid, c.fp, c.fp + 1 AS d1,
           rr.tenant_id AS tid, rr.agent_id AS aid,
           lower(COALESCE(rr.repayment_frequency, 'daily')) AS freq,
           COALESCE(rr.daily_repayment, 0) AS daily,
           COALESCE(rr.total_repayment, 0) AS total
      FROM clk c
      JOIN public.rent_requests rr ON rr.id = c.rid
  ), coll AS (
    SELECT ac.rent_request_id AS rid,
           (ac.created_at AT TIME ZONE 'Africa/Kampala')::date AS dt,
           sum(ac.amount) AS amt
      FROM public.agent_collections ac
     WHERE ac.rent_request_id IN (SELECT rid FROM base)
       AND ac.reversed_at IS NULL
       AND (ac.created_at AT TIME ZONE 'Africa/Kampala')::date BETWEEN p_from + 1 AND p_to + 7
     GROUP BY 1, 2
  ), dd AS (
    SELECT b.rid, n, b.d1 + (n - 1) AS dt,
           COALESCE(c.amt, 0) AS paid,
           CASE
             WHEN b.freq = 'weekly' THEN
               CASE WHEN n = 1 THEN (CASE WHEN b.total > 0 THEN LEAST(b.daily * 7, b.total) ELSE b.daily * 7 END) ELSE 0 END
             ELSE
               CASE WHEN b.total > 0 THEN GREATEST(0, LEAST(b.daily, b.total - b.daily * (n - 1))) ELSE b.daily END
           END AS due
      FROM base b
     CROSS JOIN generate_series(1, 7) AS n
      LEFT JOIN coll c ON c.rid = b.rid AND c.dt = b.d1 + (n - 1)
  ), st AS (
    SELECT d.*,
           CASE
             WHEN d.dt > v_today THEN 'future'
             WHEN d.due = 0 THEN 'not_due'
             WHEN d.paid >= d.due THEN 'paid'
             WHEN d.paid > 0 THEN 'part'
             WHEN d.dt = v_today THEN 'future'
             ELSE 'missed'
           END AS state
      FROM dd d
  ), agg AS (
    SELECT s.rid,
           array_agg(s.paid ORDER BY s.n) AS paids,
           array_agg(s.due ORDER BY s.n) AS dues,
           array_agg(s.state ORDER BY s.n) AS states,
           sum(s.paid) AS paid7,
           COALESCE(sum(s.due) FILTER (WHERE s.dt < v_today), 0) AS expected,
           min(s.n) FILTER (WHERE s.paid > 0) AS first_paid
      FROM st s
     GROUP BY s.rid
  )
  SELECT b.rid, b.tid, tp.full_name, tp.phone, b.aid, ap.full_name,
         b.fp, b.d1, b.freq, b.daily, b.total,
         a.paids, a.dues, a.states, a.paid7, a.expected, a.first_paid,
         CASE
           WHEN b.d1 > v_today THEN 'too_early'
           WHEN a.first_paid IS NULL THEN 'not_started'
           WHEN a.paid7 >= a.expected THEN 'on_track'
           ELSE 'behind'
         END
    FROM base b
    JOIN agg a ON a.rid = b.rid
    LEFT JOIN public.profiles tp ON tp.id = b.tid
    LEFT JOIN public.profiles ap ON ap.id = b.aid
   ORDER BY ap.full_name NULLS LAST, tp.full_name NULLS LAST, b.rid;
END;
$function$;

COMMENT ON FUNCTION public.am_new_tenant_first7_v2(date, date, text, uuid) IS
  'Read-only Agent Monitoring: per new Rent Plan (first landlord payout in the range, Kampala days), the seven days after it: paid, due and state per day, paid_7d, expected_to_date, first_paid_day and a row status. Staff only (_am_staff_ok).';


CREATE OR REPLACE FUNCTION public.am_new_tenant_first7_summary_v2(
  p_from date,
  p_to date,
  p_frequency text DEFAULT NULL,
  p_agent_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_res jsonb;
BEGIN
  IF auth.uid() IS NULL OR NOT public._am_staff_ok() THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
  END IF;

  WITH t AS (
    SELECT * FROM public.am_new_tenant_first7_v2(p_from, p_to, p_frequency, p_agent_id)
  ), d AS (
    SELECT t.rent_request_id, t.day1, n, t.day_paid[n] AS paid, t.day_due[n] AS due, t.day_state[n] AS state, t.day1 + (n - 1) AS dt
      FROM t CROSS JOIN generate_series(1, 7) AS n
  ), per_day AS (
    SELECT n,
           count(*) FILTER (WHERE dt <= v_today) AS started,
           count(*) FILTER (WHERE paid > 0) AS payers,
           COALESCE(sum(paid), 0) AS paid_amount,
           COALESCE(sum(due) FILTER (WHERE dt <= v_today), 0) AS due_amount,
           count(*) FILTER (WHERE state = 'paid') AS n_paid,
           count(*) FILTER (WHERE state = 'part') AS n_part,
           count(*) FILTER (WHERE state = 'missed') AS n_missed,
           count(*) FILTER (WHERE state = 'not_due') AS n_not_due,
           count(*) FILTER (WHERE state = 'future') AS n_future
      FROM d GROUP BY n
  ), tot AS (
    SELECT count(*) AS plans,
           count(*) FILTER (WHERE frequency = 'daily') AS daily_plans,
           count(*) FILTER (WHERE frequency = 'weekly') AS weekly_plans,
           count(*) FILTER (WHERE row_status = 'on_track') AS on_track,
           count(*) FILTER (WHERE row_status = 'behind') AS behind,
           count(*) FILTER (WHERE row_status = 'not_started') AS not_started,
           count(*) FILTER (WHERE row_status = 'too_early') AS too_early,
           COALESCE(sum(paid_7d), 0) AS collected,
           COALESCE(sum(expected_to_date), 0) AS expected
      FROM t
  )
  SELECT jsonb_build_object(
    'from', p_from, 'to', p_to, 'frequency', NULLIF(lower(btrim(COALESCE(p_frequency, ''))), ''), 'agent_id', p_agent_id,
    'as_at', v_today,
    'plans', tot.plans, 'daily_plans', tot.daily_plans, 'weekly_plans', tot.weekly_plans,
    'status', jsonb_build_object('on_track', tot.on_track, 'behind', tot.behind, 'not_started', tot.not_started, 'too_early', tot.too_early),
    'day1', jsonb_build_object(
      'started', COALESCE(d1.started, 0),
      'payers', COALESCE(d1.payers, 0),
      'pct', CASE WHEN COALESCE(d1.started, 0) > 0 THEN round(100.0 * d1.payers / d1.started, 1) END
    ),
    'per_day', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'day', pd.n, 'started', pd.started, 'payers', pd.payers, 'paid_amount', pd.paid_amount, 'due_amount', pd.due_amount,
               'states', jsonb_build_object('paid', pd.n_paid, 'part', pd.n_part, 'missed', pd.n_missed, 'not_due', pd.n_not_due, 'future', pd.n_future)
             ) ORDER BY pd.n)
        FROM per_day pd), '[]'::jsonb),
    'collected', tot.collected,
    'expected', tot.expected,
    'collected_pct', CASE WHEN tot.expected > 0 THEN round(100.0 * tot.collected / tot.expected, 1) END,
    'generated_at', now()
  )
  INTO v_res
  FROM tot LEFT JOIN per_day d1 ON d1.n = 1;

  RETURN v_res;
END;
$function$;

COMMENT ON FUNCTION public.am_new_tenant_first7_summary_v2(date, date, text, uuid) IS
  'Read-only Agent Monitoring: headline counts, day-1 payers and %, per-day payer counts and collected vs expected for the plans of am_new_tenant_first7_v2. Staff only (_am_staff_ok).';


CREATE OR REPLACE FUNCTION public.am_new_tenant_first7_payments(p_rent_request_id uuid)
RETURNS TABLE (
  collection_id       uuid,
  collected_at        timestamptz,
  collected_day       date,
  day_number          integer,
  amount              numeric,
  payment_method      text,
  collection_channel  text,
  agent_id            uuid,
  agent_name          text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
#variable_conflict use_column
DECLARE
  v_first date;
BEGIN
  IF auth.uid() IS NULL OR NOT public._am_staff_ok() THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
  END IF;
  IF p_rent_request_id IS NULL THEN
    RAISE EXCEPTION 'PLAN_REQUIRED: p_rent_request_id is required' USING ERRCODE = '22023';
  END IF;

  SELECT k.first_landlord_paid_on INTO v_first
    FROM public._am_plan_clock_core(ARRAY[p_rent_request_id]) k
   WHERE k.bucket IN ('counting', 'outstanding_balance');
  IF v_first IS NULL THEN RETURN; END IF;

  RETURN QUERY
  SELECT ac.id, ac.created_at, (ac.created_at AT TIME ZONE 'Africa/Kampala')::date,
         ((ac.created_at AT TIME ZONE 'Africa/Kampala')::date - v_first)::int,
         ac.amount, ac.payment_method::text, ac.collection_channel, ac.agent_id, ap.full_name
    FROM public.agent_collections ac
    LEFT JOIN public.profiles ap ON ap.id = ac.agent_id
   WHERE ac.rent_request_id = p_rent_request_id
     AND ac.reversed_at IS NULL
     AND (ac.created_at AT TIME ZONE 'Africa/Kampala')::date BETWEEN v_first + 1 AND v_first + 7
   ORDER BY ac.created_at, ac.id;
END;
$function$;

COMMENT ON FUNCTION public.am_new_tenant_first7_payments(uuid) IS
  'Read-only Agent Monitoring: every non-reversed collection (time, amount, method, agent) in the seven days after the plan''s first landlord payout. Staff only (_am_staff_ok).';

REVOKE ALL ON FUNCTION public.am_new_tenant_first7_v2(date, date, text, uuid) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.am_new_tenant_first7_v2(date, date, text, uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.am_new_tenant_first7_summary_v2(date, date, text, uuid) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.am_new_tenant_first7_summary_v2(date, date, text, uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.am_new_tenant_first7_payments(uuid) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.am_new_tenant_first7_payments(uuid) TO authenticated;
