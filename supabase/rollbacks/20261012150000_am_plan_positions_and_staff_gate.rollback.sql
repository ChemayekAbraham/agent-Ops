-- Rollback for 20261012150000_am_plan_positions_and_staff_gate.sql
-- Drops the new positions function and restores am_plan_clock / am_plan_arrears exactly as
-- created by 20261012100000 (the original six-role check), then drops the staff-gate helper.
-- Read-only objects only; no data is touched.

DROP FUNCTION IF EXISTS public.am_plan_positions(date, date, boolean);

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
  IF v_uid IS NULL OR NOT (
       public.has_role(v_uid, 'tenant_ops') OR public.has_role(v_uid, 'coo')
    OR public.has_role(v_uid, 'ceo')        OR public.has_role(v_uid, 'cfo')
    OR public.has_role(v_uid, 'super_admin') OR public.has_role(v_uid, 'manager')
  ) THEN
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
  IF v_uid IS NULL OR NOT (
       public.has_role(v_uid, 'tenant_ops') OR public.has_role(v_uid, 'coo')
    OR public.has_role(v_uid, 'ceo')        OR public.has_role(v_uid, 'cfo')
    OR public.has_role(v_uid, 'super_admin') OR public.has_role(v_uid, 'manager')
  ) THEN
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

DROP FUNCTION IF EXISTS public._am_staff_ok();
