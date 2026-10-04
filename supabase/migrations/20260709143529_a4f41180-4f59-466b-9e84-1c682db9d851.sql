
-- ============================================================
-- ASC 606 Revenue Recognition Pipeline
-- Recognizes deferred fee revenue over the rent financing period
-- (straight-line by elapsed time, 100% once the plan is fully repaid),
-- tracks every run for pipeline/job monitoring, and schedules a daily cron.
-- ============================================================

-- 1. Job run tracking table
CREATE TABLE public.revenue_recognition_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  status TEXT NOT NULL DEFAULT 'running',           -- running | success | error
  trigger_source TEXT NOT NULL DEFAULT 'cron',      -- cron | manual
  triggered_by UUID REFERENCES public.profiles(id),
  rows_scanned INTEGER NOT NULL DEFAULT 0,
  rows_updated INTEGER NOT NULL DEFAULT 0,
  recognized_delta NUMERIC NOT NULL DEFAULT 0,
  total_recognized_after NUMERIC NOT NULL DEFAULT 0,
  total_deferred_after NUMERIC NOT NULL DEFAULT 0,
  error_message TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT ON public.revenue_recognition_runs TO authenticated;
GRANT ALL ON public.revenue_recognition_runs TO service_role;

ALTER TABLE public.revenue_recognition_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can view recognition runs" ON public.revenue_recognition_runs
  FOR SELECT TO authenticated
  USING (
    public.has_role(auth.uid(), 'cfo') OR public.has_role(auth.uid(), 'manager')
    OR public.has_role(auth.uid(), 'super_admin') OR public.has_role(auth.uid(), 'coo')
    OR public.has_role(auth.uid(), 'ceo')
  );

CREATE INDEX idx_recognition_runs_started ON public.revenue_recognition_runs(started_at DESC);

-- 2. Recognition engine — single set-based pass (scales to 40M+ rows)
CREATE OR REPLACE FUNCTION public.run_fee_revenue_recognition()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_run_id UUID;
  v_scanned INTEGER := 0;
  v_updated INTEGER := 0;
  v_delta NUMERIC := 0;
  v_rec_after NUMERIC := 0;
  v_def_after NUMERIC := 0;
  v_source TEXT := 'cron';
BEGIN
  -- Manual invocations (real signed-in users) must be staff; cron runs with auth.uid() = NULL.
  IF auth.uid() IS NOT NULL THEN
    IF NOT (
      public.has_role(auth.uid(), 'cfo') OR public.has_role(auth.uid(), 'manager')
      OR public.has_role(auth.uid(), 'super_admin') OR public.has_role(auth.uid(), 'ceo')
    ) THEN
      RAISE EXCEPTION 'Not authorized to run revenue recognition';
    END IF;
    v_source := 'manual';
  END IF;

  INSERT INTO public.revenue_recognition_runs (status, trigger_source, triggered_by)
  VALUES ('running', v_source, auth.uid())
  RETURNING id INTO v_run_id;

  WITH basis AS (
    SELECT f.id,
           f.total_amount,
           f.recognized_amount AS old_recognized,
           CASE
             WHEN r.status IN ('fully_repaid','closed','completed') THEN 1::numeric
             WHEN r.funded_at IS NULL THEN 0::numeric
             ELSE LEAST(1::numeric, GREATEST(0::numeric,
               (EXTRACT(EPOCH FROM (now() - r.funded_at)) / 86400.0)
               / NULLIF(COALESCE(r.duration_days, 30), 0)))
           END AS pct
    FROM public.fee_revenue_ledger f
    JOIN public.rent_requests r ON r.id = f.rent_request_id
    WHERE f.status <> 'recognized'
  ),
  calc AS (
    SELECT id, total_amount, old_recognized,
           round(total_amount * pct) AS new_recognized
    FROM basis
  ),
  upd AS (
    UPDATE public.fee_revenue_ledger f
    SET recognized_amount = c.new_recognized,
        deferred_amount   = f.total_amount - c.new_recognized,
        status = CASE
                   WHEN c.new_recognized >= f.total_amount THEN 'recognized'
                   WHEN c.new_recognized > 0 THEN 'partial'
                   ELSE 'deferred'
                 END,
        recognition_date = CASE
                             WHEN c.new_recognized >= f.total_amount THEN now()
                             ELSE f.recognition_date
                           END,
        updated_at = now()
    FROM calc c
    WHERE f.id = c.id
      AND c.new_recognized <> f.recognized_amount
    RETURNING (c.new_recognized - c.old_recognized) AS d
  )
  SELECT count(*)::int, COALESCE(sum(d), 0) INTO v_updated, v_delta FROM upd;

  SELECT count(*)::int INTO v_scanned FROM public.fee_revenue_ledger;
  SELECT COALESCE(sum(recognized_amount), 0), COALESCE(sum(deferred_amount), 0)
    INTO v_rec_after, v_def_after FROM public.fee_revenue_ledger;

  UPDATE public.revenue_recognition_runs
  SET status = 'success', finished_at = now(),
      rows_scanned = v_scanned, rows_updated = v_updated,
      recognized_delta = v_delta,
      total_recognized_after = v_rec_after,
      total_deferred_after = v_def_after
  WHERE id = v_run_id;

  RETURN jsonb_build_object(
    'run_id', v_run_id,
    'rows_scanned', v_scanned,
    'rows_updated', v_updated,
    'recognized_delta', v_delta,
    'total_recognized', v_rec_after,
    'total_deferred', v_def_after
  );
EXCEPTION WHEN OTHERS THEN
  UPDATE public.revenue_recognition_runs
  SET status = 'error', finished_at = now(), error_message = SQLERRM
  WHERE id = v_run_id;
  RAISE;
END;
$$;

GRANT EXECUTE ON FUNCTION public.run_fee_revenue_recognition() TO authenticated, service_role;

-- 3. Schedule the daily cron (01:00 UTC). Pure SQL job, no secrets.
SELECT cron.schedule(
  'recognize-fee-revenue-daily',
  '0 1 * * *',
  $cron$ SELECT public.run_fee_revenue_recognition(); $cron$
);
