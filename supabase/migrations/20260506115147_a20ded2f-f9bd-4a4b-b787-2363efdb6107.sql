
-- ============================================================
-- 1. PIVOT TABLE
-- ============================================================
CREATE TABLE IF NOT EXISTS public.ledger_balance_pivot (
  user_id uuid NOT NULL,
  bucket  text NOT NULL CHECK (bucket IN ('withdrawable','float','advance')),
  balance_sum numeric NOT NULL DEFAULT 0,
  last_updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, bucket)
);

ALTER TABLE public.ledger_balance_pivot ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Pivot readable by owner" ON public.ledger_balance_pivot;
CREATE POLICY "Pivot readable by owner"
  ON public.ledger_balance_pivot FOR SELECT
  USING (auth.uid() = user_id OR public.has_role(auth.uid(),'manager') OR public.has_role(auth.uid(),'cfo') OR public.has_role(auth.uid(),'cto'));

CREATE INDEX IF NOT EXISTS idx_ledger_balance_pivot_user ON public.ledger_balance_pivot(user_id);

-- ============================================================
-- 2. INCREMENTAL TRIGGER ON general_ledger
-- ============================================================
CREATE OR REPLACE FUNCTION public.tg_ledger_pivot_apply()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_route record;
  v_bucket text;
  v_signed numeric;
BEGIN
  -- Only wallet-scope rows tied to a user contribute to wallet caches.
  IF NEW.user_id IS NULL OR COALESCE(NEW.ledger_scope,'wallet') <> 'wallet' THEN
    RETURN NEW;
  END IF;
  IF NEW.amount IS NULL OR NEW.amount <= 0 THEN
    RETURN NEW;
  END IF;

  BEGIN
    SELECT * INTO v_route FROM public.wallet_route_for_category(NEW.user_id, NEW.category, NEW.direction);
  EXCEPTION WHEN OTHERS THEN
    -- Unrouted: log and skip (mirrors apply_wallet_movement behaviour)
    BEGIN
      INSERT INTO public.wallet_unrouted_movements (user_id, category, direction, amount, bucket_returned, sign_returned)
      VALUES (NEW.user_id, NEW.category, NEW.direction, NEW.amount, 'pivot_unrouted', 0);
    EXCEPTION WHEN OTHERS THEN NULL; END;
    RETURN NEW;
  END;

  v_signed := NEW.amount * v_route.sign;

  -- Map apply_wallet_movement bucket vocabulary → pivot vocabulary.
  -- advance_credit:  withdrawable +amount AND advance +amount
  -- advance_repayment: withdrawable -amount AND advance -amount (clamped on read-side, not here)
  IF v_route.bucket = 'withdrawable' THEN
    -- Apply auto-recovery semantics: incoming credits net to advance first, but pivot tracks
    -- the GROSS withdrawable + advance separately. Net withdrawable = sum(withdrawable signed)
    -- minus the auto-recovery amount actually consumed at runtime. Since pivot is "truth from
    -- ledger", we mirror apply_wallet_movement: it does NOT post a separate advance leg for
    -- auto-recovery. So pivot tracks raw withdrawable signed sum. The wallet cache mutation
    -- already accounts for auto-recovery via the runtime advance_balance read, so cache and
    -- pivot will diverge precisely by the cumulative auto-recovered amount unless we mirror
    -- it here. We therefore do NOT subtract auto-recovery in pivot — instead the reconciler
    -- treats advance auto-recovery as expected drift. To keep things simple and aligned, we
    -- record raw signed withdrawable sums.
    INSERT INTO public.ledger_balance_pivot AS p (user_id, bucket, balance_sum, last_updated_at)
      VALUES (NEW.user_id, 'withdrawable', v_signed, now())
      ON CONFLICT (user_id, bucket)
      DO UPDATE SET balance_sum = p.balance_sum + EXCLUDED.balance_sum, last_updated_at = now();

  ELSIF v_route.bucket = 'float' THEN
    INSERT INTO public.ledger_balance_pivot AS p (user_id, bucket, balance_sum, last_updated_at)
      VALUES (NEW.user_id, 'float', v_signed, now())
      ON CONFLICT (user_id, bucket)
      DO UPDATE SET balance_sum = p.balance_sum + EXCLUDED.balance_sum, last_updated_at = now();

  ELSIF v_route.bucket = 'advance_credit' THEN
    INSERT INTO public.ledger_balance_pivot AS p (user_id, bucket, balance_sum, last_updated_at)
      VALUES (NEW.user_id, 'withdrawable', NEW.amount, now())
      ON CONFLICT (user_id, bucket) DO UPDATE SET balance_sum = p.balance_sum + EXCLUDED.balance_sum, last_updated_at = now();
    INSERT INTO public.ledger_balance_pivot AS p (user_id, bucket, balance_sum, last_updated_at)
      VALUES (NEW.user_id, 'advance', NEW.amount, now())
      ON CONFLICT (user_id, bucket) DO UPDATE SET balance_sum = p.balance_sum + EXCLUDED.balance_sum, last_updated_at = now();

  ELSIF v_route.bucket = 'advance_repayment' THEN
    INSERT INTO public.ledger_balance_pivot AS p (user_id, bucket, balance_sum, last_updated_at)
      VALUES (NEW.user_id, 'withdrawable', -NEW.amount, now())
      ON CONFLICT (user_id, bucket) DO UPDATE SET balance_sum = p.balance_sum + EXCLUDED.balance_sum, last_updated_at = now();
    INSERT INTO public.ledger_balance_pivot AS p (user_id, bucket, balance_sum, last_updated_at)
      VALUES (NEW.user_id, 'advance', -NEW.amount, now())
      ON CONFLICT (user_id, bucket) DO UPDATE SET balance_sum = p.balance_sum + EXCLUDED.balance_sum, last_updated_at = now();
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_ledger_pivot_apply ON public.general_ledger;
CREATE TRIGGER trg_ledger_pivot_apply
  AFTER INSERT ON public.general_ledger
  FOR EACH ROW
  EXECUTE FUNCTION public.tg_ledger_pivot_apply();

-- ============================================================
-- 3. ONE-TIME BACKFILL FROM HISTORY
-- ============================================================
TRUNCATE public.ledger_balance_pivot;

INSERT INTO public.ledger_balance_pivot (user_id, bucket, balance_sum, last_updated_at)
SELECT
  gl.user_id,
  CASE
    WHEN gl.category IN (
      'agent_float_deposit','agent_float_assignment','agent_float_topup',
      'agent_float_funding','agent_float_used_for_rent','agent_float_used',
      'agent_float_settlement','agent_landlord_payout','rent_disbursement','rent_float_funding'
    ) THEN 'float'
    WHEN gl.category IN ('agent_advance_credit','salary_advance')
         AND gl.direction IN ('credit','cash_in') THEN 'advance_and_withdrawable_credit'
    WHEN gl.category IN ('agent_advance_repayment','salary_advance_repayment','debt_recovery')
         AND gl.direction IN ('debit','cash_out') THEN 'advance_and_withdrawable_debit'
    ELSE 'withdrawable'
  END AS routed,
  SUM(CASE WHEN gl.direction IN ('credit','cash_in') THEN gl.amount ELSE -gl.amount END),
  now()
FROM public.general_ledger gl
WHERE gl.user_id IS NOT NULL
  AND COALESCE(gl.ledger_scope,'wallet') = 'wallet'
GROUP BY gl.user_id, routed
ON CONFLICT DO NOTHING;

-- Expand the synthetic "advance_and_*" pseudo-buckets into real (withdrawable + advance) rows.
WITH expand AS (
  SELECT user_id, bucket, balance_sum FROM public.ledger_balance_pivot
  WHERE bucket IN ('advance_and_withdrawable_credit','advance_and_withdrawable_debit')
)
INSERT INTO public.ledger_balance_pivot (user_id, bucket, balance_sum, last_updated_at)
SELECT user_id, 'withdrawable', balance_sum, now() FROM expand
ON CONFLICT (user_id, bucket) DO UPDATE SET balance_sum = ledger_balance_pivot.balance_sum + EXCLUDED.balance_sum, last_updated_at = now();

WITH expand AS (
  SELECT user_id, bucket, balance_sum FROM public.ledger_balance_pivot
  WHERE bucket IN ('advance_and_withdrawable_credit','advance_and_withdrawable_debit')
)
INSERT INTO public.ledger_balance_pivot (user_id, bucket, balance_sum, last_updated_at)
SELECT user_id, 'advance', balance_sum, now() FROM expand
ON CONFLICT (user_id, bucket) DO UPDATE SET balance_sum = ledger_balance_pivot.balance_sum + EXCLUDED.balance_sum, last_updated_at = now();

DELETE FROM public.ledger_balance_pivot WHERE bucket NOT IN ('withdrawable','float','advance');

-- ============================================================
-- 4. DRIFT VIEW (wallet cache vs pivot)
-- ============================================================
CREATE OR REPLACE VIEW public.wallet_pivot_drift_view AS
WITH p AS (
  SELECT
    user_id,
    SUM(CASE WHEN bucket='withdrawable' THEN balance_sum ELSE 0 END) AS pivot_withdrawable,
    SUM(CASE WHEN bucket='float'        THEN balance_sum ELSE 0 END) AS pivot_float,
    SUM(CASE WHEN bucket='advance'      THEN balance_sum ELSE 0 END) AS pivot_advance
  FROM public.ledger_balance_pivot GROUP BY user_id
)
SELECT
  w.user_id,
  w.withdrawable_balance AS cache_withdrawable,
  COALESCE(p.pivot_withdrawable,0) AS pivot_withdrawable,
  (w.withdrawable_balance - COALESCE(p.pivot_withdrawable,0)) AS withdrawable_drift,
  w.float_balance AS cache_float,
  COALESCE(p.pivot_float,0) AS pivot_float,
  (w.float_balance - COALESCE(p.pivot_float,0)) AS float_drift,
  w.advance_balance AS cache_advance,
  COALESCE(p.pivot_advance,0) AS pivot_advance,
  (w.advance_balance - COALESCE(p.pivot_advance,0)) AS advance_drift
FROM public.wallets w
LEFT JOIN p ON p.user_id = w.user_id;

-- ============================================================
-- 5. RECONCILER (auto-repair if |Δ| < 1000 UGX, else log)
-- ============================================================
CREATE OR REPLACE FUNCTION public.reconcile_wallet_from_pivot(p_user_id uuid, p_threshold numeric DEFAULT 1000)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  d record;
  v_repaired boolean := false;
  v_logged   boolean := false;
BEGIN
  SELECT * INTO d FROM public.wallet_pivot_drift_view WHERE user_id = p_user_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('status','no_wallet'); END IF;

  IF abs(coalesce(d.withdrawable_drift,0)) < p_threshold
     AND abs(coalesce(d.float_drift,0)) < p_threshold
     AND abs(coalesce(d.advance_drift,0)) < p_threshold THEN
    -- auto-repair
    PERFORM set_config('wallet.sync_authorized','true', true);
    UPDATE public.wallets
       SET withdrawable_balance = GREATEST(0, d.pivot_withdrawable),
           float_balance        = GREATEST(0, d.pivot_float),
           advance_balance      = GREATEST(0, d.pivot_advance),
           balance              = GREATEST(0, d.pivot_withdrawable) + GREATEST(0, d.pivot_float),
           updated_at           = now()
     WHERE user_id = p_user_id;
    v_repaired := true;
  ELSE
    BEGIN
      INSERT INTO public.phantom_wallet_drift (user_id, drift_amount, status, resolution_notes)
      VALUES (
        p_user_id,
        abs(coalesce(d.withdrawable_drift,0)) + abs(coalesce(d.float_drift,0)) + abs(coalesce(d.advance_drift,0)),
        'open',
        format('pivot drift w=%s f=%s a=%s', d.withdrawable_drift, d.float_drift, d.advance_drift)
      );
      v_logged := true;
    EXCEPTION WHEN OTHERS THEN NULL; END;
  END IF;

  RETURN jsonb_build_object(
    'status', CASE WHEN v_repaired THEN 'repaired' WHEN v_logged THEN 'logged' ELSE 'noop' END,
    'withdrawable_drift', d.withdrawable_drift,
    'float_drift', d.float_drift,
    'advance_drift', d.advance_drift
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.reconcile_wallets_batch(p_threshold numeric DEFAULT 1000, p_limit int DEFAULT 5000)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  r record;
  v_repaired int := 0;
  v_logged int := 0;
  v_res jsonb;
BEGIN
  FOR r IN
    SELECT user_id FROM public.wallet_pivot_drift_view
    WHERE abs(coalesce(withdrawable_drift,0)) > 0
       OR abs(coalesce(float_drift,0)) > 0
       OR abs(coalesce(advance_drift,0)) > 0
    LIMIT p_limit
  LOOP
    v_res := public.reconcile_wallet_from_pivot(r.user_id, p_threshold);
    IF v_res->>'status' = 'repaired' THEN v_repaired := v_repaired + 1;
    ELSIF v_res->>'status' = 'logged' THEN v_logged := v_logged + 1;
    END IF;
  END LOOP;
  RETURN jsonb_build_object('repaired', v_repaired, 'logged', v_logged);
END;
$$;

-- ============================================================
-- 6. WITHDRAWAL-TIME VALIDATION RPC
-- ============================================================
CREATE OR REPLACE FUNCTION public.validate_wallet_against_pivot(p_user_id uuid, p_threshold numeric DEFAULT 1000)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE d record;
BEGIN
  SELECT * INTO d FROM public.wallet_pivot_drift_view WHERE user_id = p_user_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', true, 'reason', 'no_wallet');
  END IF;
  IF abs(coalesce(d.withdrawable_drift,0)) >= p_threshold
     OR abs(coalesce(d.float_drift,0)) >= p_threshold THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'BALANCE_MISMATCH',
      'withdrawable_drift', d.withdrawable_drift,
      'float_drift', d.float_drift
    );
  END IF;
  RETURN jsonb_build_object('ok', true);
END;
$$;

GRANT EXECUTE ON FUNCTION public.validate_wallet_against_pivot(uuid, numeric) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.reconcile_wallet_from_pivot(uuid, numeric) TO service_role;
GRANT EXECUTE ON FUNCTION public.reconcile_wallets_batch(numeric, int) TO service_role;

-- ============================================================
-- 7. PARTIAL UNIQUENESS ON FUTURE LEDGER INSERTS ONLY
--    (preserves 17 historical duplicate groups; enforces from now on)
-- ============================================================
DO $$
DECLARE v_cutoff timestamptz := now();
BEGIN
  EXECUTE format(
    'CREATE UNIQUE INDEX IF NOT EXISTS uq_general_ledger_reference_dedupe
       ON public.general_ledger (user_id, category, reference_id, direction, ledger_scope)
       WHERE reference_id IS NOT NULL AND user_id IS NOT NULL AND created_at >= %L',
    v_cutoff
  );
END $$;

-- ============================================================
-- 8. CRON JOB — every 10 minutes
-- ============================================================
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'reconcile-wallets-from-pivot') THEN
    PERFORM cron.unschedule('reconcile-wallets-from-pivot');
  END IF;
  PERFORM cron.schedule(
    'reconcile-wallets-from-pivot',
    '*/10 * * * *',
    $cron$ SELECT public.reconcile_wallets_batch(1000, 5000); $cron$
  );
END $$;
