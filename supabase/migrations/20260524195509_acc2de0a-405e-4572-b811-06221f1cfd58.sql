CREATE TABLE IF NOT EXISTS public.agent_daily_eligibility_history (
  agent_id        uuid        NOT NULL,
  day             date        NOT NULL,
  expected_daily  numeric     NOT NULL DEFAULT 0,
  paid            numeric     NOT NULL DEFAULT 0,
  ratio           numeric     NOT NULL DEFAULT 0,
  rating          text        NOT NULL,
  status          text        NOT NULL,
  active_count    int         NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_id, day)
);

CREATE INDEX IF NOT EXISTS idx_agent_elig_history_day
  ON public.agent_daily_eligibility_history (day DESC);
CREATE INDEX IF NOT EXISTS idx_agent_elig_history_agent_day
  ON public.agent_daily_eligibility_history (agent_id, day DESC);

ALTER TABLE public.agent_daily_eligibility_history ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Staff read agent eligibility history"
  ON public.agent_daily_eligibility_history;
CREATE POLICY "Staff read agent eligibility history"
  ON public.agent_daily_eligibility_history
  FOR SELECT
  TO authenticated
  USING (
    auth.uid() = agent_id
    OR public.has_role(auth.uid(), 'manager')
    OR public.has_role(auth.uid(), 'super_admin')
    OR public.has_role(auth.uid(), 'coo')
    OR public.has_role(auth.uid(), 'cfo')
  );

CREATE OR REPLACE FUNCTION public._classify_daily_rating(
  p_active_count int,
  p_ratio numeric
) RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT CASE
    WHEN p_active_count <= 0 THEN 'Starter'
    WHEN p_ratio >= 0.50 THEN 'Very Good'
    WHEN p_ratio >= 0.20 THEN 'Good'
    WHEN p_ratio >= 0.15 THEN 'Fair'
    WHEN p_ratio >= 0.05 THEN 'Bad'
    ELSE 'Very Bad'
  END;
$$;

CREATE OR REPLACE FUNCTION public.snapshot_agent_daily_eligibility(
  p_days int DEFAULT 1
) RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rows int := 0;
  v_start date;
  v_end   date;
BEGIN
  IF p_days IS NULL OR p_days < 1 THEN
    p_days := 1;
  END IF;
  v_end := (now() AT TIME ZONE 'UTC')::date - 1;
  v_start := v_end - (p_days - 1);

  WITH active AS (
    SELECT
      rr.agent_id,
      rr.id            AS rent_request_id,
      COALESCE(rr.daily_repayment, 0)::numeric AS daily_repayment
    FROM public.rent_requests rr
    LEFT JOIN public.agent_tenant_float_reversals rev
      ON rev.rent_request_id = rr.id
    WHERE rr.agent_id IS NOT NULL
      AND rr.status IN (
        'pending','agent_verified','tenant_ops_approved',
        'agent_ops_approved','landlord_ops_approved',
        'coo_approved','funded','repaying'
      )
      AND NOT (rev.rent_request_id IS NOT NULL AND COALESCE(rr.amount_repaid,0) <= 0)
  ),
  agent_expected AS (
    SELECT
      agent_id,
      SUM(daily_repayment)::numeric AS expected_daily,
      COUNT(*)::int                  AS active_count
    FROM active
    GROUP BY agent_id
  ),
  days AS (
    SELECT generate_series(v_start, v_end, INTERVAL '1 day')::date AS day
  ),
  agent_days AS (
    SELECT ae.agent_id, ae.expected_daily, ae.active_count, d.day
    FROM agent_expected ae
    CROSS JOIN days d
  ),
  paid_per_day AS (
    SELECT
      a.agent_id,
      (r.created_at AT TIME ZONE 'UTC')::date AS day,
      SUM(COALESCE(r.amount,0))::numeric       AS paid
    FROM public.repayments r
    JOIN active a ON a.rent_request_id = r.rent_request_id
    WHERE (r.created_at AT TIME ZONE 'UTC')::date BETWEEN v_start AND v_end
    GROUP BY a.agent_id, (r.created_at AT TIME ZONE 'UTC')::date
  ),
  paid_ledger AS (
    SELECT
      gl.user_id AS agent_id,
      (gl.created_at AT TIME ZONE 'UTC')::date AS day,
      SUM(COALESCE(gl.amount,0))::numeric AS paid
    FROM public.general_ledger gl
    WHERE gl.category IN ('rent_payment_for_tenant')
      AND (gl.created_at AT TIME ZONE 'UTC')::date BETWEEN v_start AND v_end
      AND gl.user_id IN (SELECT agent_id FROM agent_expected)
    GROUP BY gl.user_id, (gl.created_at AT TIME ZONE 'UTC')::date
  ),
  paid_total AS (
    SELECT agent_id, day, SUM(paid)::numeric AS paid
    FROM (
      SELECT * FROM paid_per_day
      UNION ALL
      SELECT * FROM paid_ledger
    ) u
    GROUP BY agent_id, day
  ),
  joined AS (
    SELECT
      ad.agent_id,
      ad.day,
      ad.expected_daily,
      ad.active_count,
      COALESCE(p.paid, 0) AS paid,
      CASE WHEN ad.expected_daily > 0
        THEN COALESCE(p.paid,0) / ad.expected_daily
        ELSE 0
      END AS ratio
    FROM agent_days ad
    LEFT JOIN paid_total p
      ON p.agent_id = ad.agent_id AND p.day = ad.day
  )
  INSERT INTO public.agent_daily_eligibility_history AS h
    (agent_id, day, expected_daily, paid, ratio, rating, status, active_count, updated_at)
  SELECT
    j.agent_id,
    j.day,
    j.expected_daily,
    j.paid,
    j.ratio,
    public._classify_daily_rating(j.active_count, j.ratio),
    CASE
      WHEN j.active_count <= 0 THEN 'starter'
      WHEN j.ratio >= 0.20    THEN 'good'
      ELSE 'blocked'
    END,
    j.active_count,
    now()
  FROM joined j
  ON CONFLICT (agent_id, day) DO UPDATE
    SET expected_daily = EXCLUDED.expected_daily,
        paid           = EXCLUDED.paid,
        ratio          = EXCLUDED.ratio,
        rating         = EXCLUDED.rating,
        status         = EXCLUDED.status,
        active_count   = EXCLUDED.active_count,
        updated_at     = now();

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows;
END;
$$;

GRANT EXECUTE ON FUNCTION public.snapshot_agent_daily_eligibility(int) TO authenticated, service_role;

SELECT public.snapshot_agent_daily_eligibility(90);

DO $$
BEGIN
  PERFORM cron.unschedule('snapshot-agent-daily-eligibility');
EXCEPTION WHEN OTHERS THEN
  NULL;
END;
$$;

SELECT cron.schedule(
  'snapshot-agent-daily-eligibility',
  '30 0 * * *',
  $$SELECT public.snapshot_agent_daily_eligibility(1);$$
);