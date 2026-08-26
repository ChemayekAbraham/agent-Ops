CREATE TABLE IF NOT EXISTS public.receivables_forecast_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  granularity text NOT NULL,
  as_at date NOT NULL,
  period_index integer NOT NULL,
  period_start date NOT NULL,
  period_end date NOT NULL,
  horizon_days integer NOT NULL DEFAULT 0,
  forecast_amount numeric NOT NULL DEFAULT 0,
  modelled_amount numeric NOT NULL DEFAULT 0,
  low_amount numeric NOT NULL DEFAULT 0,
  high_amount numeric NOT NULL DEFAULT 0,
  confidence numeric,
  quality text,
  model_version text,
  sources jsonb NOT NULL DEFAULT '[]'::jsonb,
  actual_amount numeric,
  graded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS receivables_forecast_snapshots_unique
  ON public.receivables_forecast_snapshots (granularity, as_at, period_start);
CREATE INDEX IF NOT EXISTS receivables_forecast_snapshots_grade_idx
  ON public.receivables_forecast_snapshots (period_end) WHERE actual_amount IS NULL;

GRANT SELECT ON public.receivables_forecast_snapshots TO authenticated;
GRANT ALL ON public.receivables_forecast_snapshots TO service_role;

ALTER TABLE public.receivables_forecast_snapshots ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Finance and executives can read forecast snapshots" ON public.receivables_forecast_snapshots;
CREATE POLICY "Finance and executives can read forecast snapshots"
ON public.receivables_forecast_snapshots
FOR SELECT
TO authenticated
USING (
  has_role(auth.uid(),'cfo') OR has_role(auth.uid(),'ceo') OR has_role(auth.uid(),'coo')
  OR has_role(auth.uid(),'manager') OR has_role(auth.uid(),'financial_ops')
  OR has_role(auth.uid(),'super_admin') OR has_role(auth.uid(),'cto')
);

-- Capture the forecast exactly as published (idempotent per granularity + as-at + period)
CREATE OR REPLACE FUNCTION public.record_receivables_forecast_snapshot(
  p_granularity text DEFAULT 'month',
  p_periods integer DEFAULT 6
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_fc jsonb;
  v_as_at date;
  v_gran text := lower(COALESCE(p_granularity,'month'));
  v_inserted integer := 0;
BEGIN
  IF auth.uid() IS NOT NULL THEN
    PERFORM receivables_guard();
  END IF;

  v_fc := get_receivables_predictive_forecast(v_gran, LEAST(GREATEST(COALESCE(p_periods,6),1),24), NULL);
  v_as_at := (v_fc->>'as_at')::date;

  INSERT INTO public.receivables_forecast_snapshots (
    granularity, as_at, period_index, period_start, period_end, horizon_days,
    forecast_amount, modelled_amount, low_amount, high_amount, confidence, quality, model_version, sources
  )
  SELECT v_gran, v_as_at, (pe->>'index')::int, (pe->>'period_start')::date, (pe->>'period_end')::date,
         GREATEST(0, (pe->>'period_end')::date - v_as_at),
         ROUND(COALESCE((pe->>'forecast_amount')::numeric,0),2),
         ROUND(COALESCE((SELECT SUM((s->>'amount')::numeric) FROM jsonb_array_elements(pe->'sources') s
                         WHERE s->>'basis' = 'modelled'),0),2),
         ROUND(COALESCE((pe->>'low')::numeric,0),2),
         ROUND(COALESCE((pe->>'high')::numeric,0),2),
         (pe->>'confidence')::numeric, pe->>'quality',
         v_fc->'meta'->>'model_version', COALESCE(pe->'sources','[]'::jsonb)
  FROM jsonb_array_elements(COALESCE(v_fc->'periods','[]'::jsonb)) pe
  WHERE (pe->>'is_partial_period')::boolean IS NOT TRUE
  ON CONFLICT (granularity, as_at, period_start) DO NOTHING;

  v_inserted := (SELECT COUNT(*) FROM public.receivables_forecast_snapshots
                 WHERE granularity = v_gran AND as_at = v_as_at);

  RETURN jsonb_build_object('granularity', v_gran, 'as_at', v_as_at, 'periods_recorded', v_inserted);
END;
$function$;

REVOKE ALL ON FUNCTION public.record_receivables_forecast_snapshot(text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_receivables_forecast_snapshot(text, integer) FROM anon;
GRANT EXECUTE ON FUNCTION public.record_receivables_forecast_snapshot(text, integer) TO authenticated, service_role;

-- Grade closed periods against actual collections
CREATE OR REPLACE FUNCTION public.grade_receivables_forecast_snapshots()
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_today date := (now() AT TIME ZONE 'Africa/Nairobi')::date;
  v_graded integer;
BEGIN
  WITH due AS (
    SELECT id, period_start, period_end FROM public.receivables_forecast_snapshots
    WHERE actual_amount IS NULL AND period_end < v_today
  ), calc AS (
    SELECT d.id, COALESCE((SELECT SUM(h.amount) FROM v_receivables_collection_history h
                           WHERE h.d BETWEEN d.period_start AND d.period_end AND h.amount > 0),0) AS actual
    FROM due d
  )
  UPDATE public.receivables_forecast_snapshots s
     SET actual_amount = ROUND(c.actual,2), graded_at = now()
    FROM calc c WHERE c.id = s.id;
  GET DIAGNOSTICS v_graded = ROW_COUNT;
  RETURN jsonb_build_object('graded', v_graded, 'as_at', v_today);
END;
$function$;

REVOKE ALL ON FUNCTION public.grade_receivables_forecast_snapshots() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.grade_receivables_forecast_snapshots() FROM anon;
GRANT EXECUTE ON FUNCTION public.grade_receivables_forecast_snapshots() TO authenticated, service_role;

-- Read the issued-forecast track record
CREATE OR REPLACE FUNCTION public.get_receivables_forecast_snapshot_accuracy(
  p_granularity text DEFAULT NULL,
  p_limit integer DEFAULT 60
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_gran text := NULLIF(lower(COALESCE(p_granularity,'')),'');
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit,60),1),365);
  v_result jsonb;
BEGIN
  PERFORM receivables_guard();

  WITH rows AS (
    SELECT * FROM public.receivables_forecast_snapshots
    WHERE (v_gran IS NULL OR granularity = v_gran)
    ORDER BY period_start DESC, as_at DESC
    LIMIT v_limit
  ), scored AS (
    SELECT r.*,
      CASE WHEN r.actual_amount > 0 THEN ABS(r.modelled_amount - r.actual_amount)/r.actual_amount END ape,
      CASE WHEN r.actual_amount > 0 THEN (r.modelled_amount - r.actual_amount)/r.actual_amount END pe,
      CASE WHEN r.actual_amount IS NULL THEN NULL
           ELSE (r.actual_amount >= r.low_amount AND r.actual_amount <= r.high_amount) END in_band
    FROM rows r
  )
  SELECT jsonb_build_object(
    'currency','UGX',
    'as_at', (now() AT TIME ZONE 'Africa/Nairobi')::date,
    'granularity', v_gran,
    'summary', jsonb_build_object(
      'snapshots', (SELECT COUNT(*) FROM scored),
      'graded', (SELECT COUNT(*) FROM scored WHERE actual_amount IS NOT NULL),
      'pending', (SELECT COUNT(*) FROM scored WHERE actual_amount IS NULL),
      'accuracy_pct', (SELECT ROUND((1 - LEAST(1, COALESCE(AVG(ape),1)))*100,1) FROM scored WHERE ape IS NOT NULL),
      'mape_pct', (SELECT ROUND(AVG(ape)*100,1) FROM scored WHERE ape IS NOT NULL),
      'bias_pct', (SELECT ROUND(AVG(pe)*100,1) FROM scored WHERE pe IS NOT NULL),
      'band_hit_pct', (SELECT ROUND(AVG(CASE WHEN in_band THEN 1 ELSE 0 END)*100,1) FROM scored WHERE in_band IS NOT NULL),
      'first_snapshot', (SELECT MIN(as_at) FROM public.receivables_forecast_snapshots)
    ),
    'rows', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'granularity', granularity, 'issued_on', as_at,
        'period_start', period_start, 'period_end', period_end,
        'horizon_days', horizon_days, 'quality', quality, 'confidence', confidence,
        'forecast', forecast_amount, 'modelled_forecast', modelled_amount,
        'low', low_amount, 'high', high_amount,
        'actual', actual_amount, 'graded_at', graded_at,
        'error_pct', ROUND(pe*100,1), 'abs_error', CASE WHEN actual_amount IS NULL THEN NULL
            ELSE ROUND(modelled_amount - actual_amount,2) END,
        'in_band', in_band) ORDER BY period_start DESC) FROM scored), '[]'::jsonb),
    'meta', jsonb_build_object(
      'method_note', 'Every published forecast is stored on the day it is issued and graded once the period closes, comparing the modelled component with actual collections in that period. This is a true issued-forecast track record - nothing is recomputed after the fact.',
      'source', 'receivables_forecast_snapshots + v_receivables_collection_history'
    )
  ) INTO v_result;

  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.get_receivables_forecast_snapshot_accuracy(text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_receivables_forecast_snapshot_accuracy(text, integer) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_receivables_forecast_snapshot_accuracy(text, integer) TO authenticated, service_role;

SELECT cron.unschedule('snapshot-receivables-forecast') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname='snapshot-receivables-forecast');
SELECT cron.schedule('snapshot-receivables-forecast','20 22 * * *',
  $$SELECT public.record_receivables_forecast_snapshot('month', 6); SELECT public.record_receivables_forecast_snapshot('day', 30);$$);

SELECT cron.unschedule('grade-receivables-forecast') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname='grade-receivables-forecast');
SELECT cron.schedule('grade-receivables-forecast','40 22 * * *',
  $$SELECT public.grade_receivables_forecast_snapshots();$$);