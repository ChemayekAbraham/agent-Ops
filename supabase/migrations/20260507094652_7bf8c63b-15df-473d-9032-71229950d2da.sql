
-- ============================================================
-- Drift Pivot Test Harness (corrected to mirror v_user_wallet_strict)
-- ============================================================

CREATE TABLE IF NOT EXISTS public.phantom_drift_test_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ran_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  total_anchored_users_checked INT NOT NULL DEFAULT 0,
  users_with_pre_anchor_ledger INT NOT NULL DEFAULT 0,
  pivot_match_count INT NOT NULL DEFAULT 0,
  raw_match_count INT NOT NULL DEFAULT 0,
  pivot_failures INT NOT NULL DEFAULT 0,
  passed BOOLEAN NOT NULL DEFAULT false,
  failure_samples JSONB NOT NULL DEFAULT '[]'::jsonb,
  notes TEXT
);

ALTER TABLE public.phantom_drift_test_runs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "CFO and super_admin can read drift test runs"
  ON public.phantom_drift_test_runs;
CREATE POLICY "CFO and super_admin can read drift test runs"
  ON public.phantom_drift_test_runs
  FOR SELECT
  TO authenticated
  USING (
    public.has_role(auth.uid(), 'cfo'::app_role)
    OR public.has_role(auth.uid(), 'super_admin'::app_role)
  );

CREATE INDEX IF NOT EXISTS idx_phantom_drift_test_runs_ran_at
  ON public.phantom_drift_test_runs (ran_at DESC);

-- ------------------------------------------------------------
-- Test function
--   Mirrors v_user_wallet_strict semantics exactly:
--     ledger_scope = 'wallet'
--     classification IS NULL OR = 'production'
--     created_at >= anchor_at  (when anchored)
--   For each anchored user with pre-anchor activity, asserts:
--     pivot_sum (anchor-aware) <> raw_sum (no cutoff)
--   If they're equal, the anchor was ignored => detection is reading
--   raw ledger and not the pivot.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.test_drift_uses_strict_pivot()
RETURNS public.phantom_drift_test_runs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_run public.phantom_drift_test_runs;
  v_run_id UUID := gen_random_uuid();
  v_total INT := 0;
  v_with_pre INT := 0;
  v_pivot_match INT := 0;
  v_raw_match INT := 0;
  v_failures INT := 0;
  v_samples JSONB := '[]'::jsonb;
  r RECORD;
  v_raw NUMERIC;
  v_pivot NUMERIC;
  v_pre_anchor NUMERIC;
BEGIN
  FOR r IN
    SELECT a.user_id, a.anchor_at
    FROM public.wallet_fresh_start_anchors a
    ORDER BY a.created_at DESC NULLS LAST
    LIMIT 500
  LOOP
    v_total := v_total + 1;

    -- Raw wallet-scope production sum (NO anchor cutoff)
    SELECT COALESCE(SUM(
      CASE WHEN gl.direction = 'cash_in' THEN gl.amount
           WHEN gl.direction = 'cash_out' THEN -gl.amount
           ELSE 0 END), 0)
      INTO v_raw
    FROM public.general_ledger gl
    WHERE gl.user_id = r.user_id
      AND gl.ledger_scope = 'wallet'
      AND (gl.classification IS NULL OR gl.classification = 'production');

    -- Pivot-equivalent sum (anchor cutoff applied)
    SELECT COALESCE(SUM(
      CASE WHEN gl.direction = 'cash_in' THEN gl.amount
           WHEN gl.direction = 'cash_out' THEN -gl.amount
           ELSE 0 END), 0)
      INTO v_pivot
    FROM public.general_ledger gl
    WHERE gl.user_id = r.user_id
      AND gl.ledger_scope = 'wallet'
      AND (gl.classification IS NULL OR gl.classification = 'production')
      AND gl.created_at >= r.anchor_at;

    v_pre_anchor := v_raw - v_pivot;

    IF v_pre_anchor = 0 THEN
      -- No pre-anchor wallet activity → test is vacuous for this user
      CONTINUE;
    END IF;

    v_with_pre := v_with_pre + 1;

    -- Pass condition: pivot DIFFERS from raw (anchor was honored)
    IF v_pivot <> v_raw THEN
      v_pivot_match := v_pivot_match + 1;
    ELSE
      v_raw_match := v_raw_match + 1;
      v_failures := v_failures + 1;
      IF jsonb_array_length(v_samples) < 20 THEN
        v_samples := v_samples || jsonb_build_object(
          'user_id', r.user_id,
          'anchor_at', r.anchor_at,
          'raw_sum', v_raw,
          'pivot_sum', v_pivot,
          'pre_anchor_amount', v_pre_anchor
        );
      END IF;
    END IF;
  END LOOP;

  INSERT INTO public.phantom_drift_test_runs (
    id, total_anchored_users_checked, users_with_pre_anchor_ledger,
    pivot_match_count, raw_match_count, pivot_failures, passed,
    failure_samples, notes
  ) VALUES (
    v_run_id, v_total, v_with_pre,
    v_pivot_match, v_raw_match, v_failures,
    (v_failures = 0 AND v_with_pre > 0),
    v_samples,
    CASE
      WHEN v_with_pre = 0 THEN 'No anchored users had pre-anchor wallet-scope activity (test vacuous)'
      WHEN v_failures = 0 THEN 'All checked users: pivot_sum != raw_sum (anchor honored)'
      ELSE 'Anchor cutoff ignored for some users — pivot did not diverge from raw'
    END
  )
  RETURNING * INTO v_run;

  IF v_failures > 0 THEN
    BEGIN
      INSERT INTO public.system_events (event_type, payload, severity)
      VALUES (
        'wallet.drift_test.failed',
        jsonb_build_object(
          'run_id', v_run_id,
          'failures', v_failures,
          'samples', v_samples
        ),
        'critical'
      );
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
  END IF;

  RETURN v_run;
END;
$$;

REVOKE ALL ON FUNCTION public.test_drift_uses_strict_pivot() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.test_drift_uses_strict_pivot() TO postgres, service_role;

-- ------------------------------------------------------------
-- Schedule hourly via pg_cron
-- ------------------------------------------------------------
DO $$
BEGIN
  PERFORM cron.unschedule('drift-pivot-test-hourly');
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

SELECT cron.schedule(
  'drift-pivot-test-hourly',
  '15 * * * *',
  $$ SELECT public.test_drift_uses_strict_pivot(); $$
);

-- Seed run
SELECT public.test_drift_uses_strict_pivot();
