-- =========================================================
-- PHASE 10: MERCHANT FLOAT RECONCILIATION -> LEDGER TRUTH
-- Authoritative source of truth = public.general_ledger, read
-- through v_user_wallet_strict (the wallet<->ledger pivot).
-- merchant_float_reconciliations stays a DISPLAY-ONLY narrative
-- record and is now forced to carry the ledger truth at post time
-- so it can never make the UI look correct while the ledger is wrong.
-- =========================================================

ALTER TABLE public.merchant_float_reconciliations
  ADD COLUMN IF NOT EXISTS ledger_effect text NOT NULL DEFAULT 'display_only',
  ADD COLUMN IF NOT EXISTS stored_float_at_post numeric,
  ADD COLUMN IF NOT EXISTS ledger_float_at_post numeric,
  ADD COLUMN IF NOT EXISTS variance_at_post numeric;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'merchant_float_reconciliations_ledger_effect_check'
  ) THEN
    ALTER TABLE public.merchant_float_reconciliations
      ADD CONSTRAINT merchant_float_reconciliations_ledger_effect_check
      CHECK (ledger_effect IN ('display_only', 'ledger_posted'));
  END IF;
END $$;

COMMENT ON COLUMN public.merchant_float_reconciliations.ledger_effect IS
  'display_only = narrative correction, no ledger movement. The general_ledger remains the source of truth.';

-- ---------------------------------------------------------
-- Ledger-derived merchant float (single definition)
-- ---------------------------------------------------------
CREATE OR REPLACE FUNCTION public.merchant_ledger_float(p_agent_id uuid)
RETURNS numeric
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE((SELECT s.float_balance FROM public.v_user_wallet_strict s
                   WHERE s.user_id = p_agent_id), 0);
$$;

-- ---------------------------------------------------------
-- Stored vs ledger comparison, per merchant desk
-- ---------------------------------------------------------
CREATE OR REPLACE VIEW public.v_merchant_float_ledger_variance AS
SELECT
  ca.id                                        AS desk_id,
  ca.agent_id,
  ca.label,
  ca.is_active,
  p.full_name                                  AS agent_name,
  p.phone                                      AS agent_phone,
  COALESCE(GREATEST(w.float_balance, 0), 0)    AS stored_float,
  COALESCE(s.float_balance, 0)                 AS ledger_float,
  COALESCE(GREATEST(w.float_balance, 0), 0) - COALESCE(s.float_balance, 0) AS variance,
  COALESCE(adj.display_only_total, 0)          AS display_only_adjustments,
  COALESCE(adj.adjustment_count, 0)            AS adjustment_count,
  adj.last_adjustment_at,
  CASE
    WHEN ABS(COALESCE(GREATEST(w.float_balance, 0), 0) - COALESCE(s.float_balance, 0)) <= 1000
      THEN 'aligned'
    WHEN COALESCE(GREATEST(w.float_balance, 0), 0) > COALESCE(s.float_balance, 0)
      THEN 'stored_above_ledger'
    ELSE 'stored_below_ledger'
  END                                          AS variance_state,
  now()                                        AS computed_at
FROM public.cashout_agents ca
LEFT JOIN public.profiles p ON p.id = ca.agent_id
LEFT JOIN public.wallets w ON w.user_id = ca.agent_id
LEFT JOIN public.v_user_wallet_strict s ON s.user_id = ca.agent_id
LEFT JOIN (
  SELECT desk_id,
         SUM(amount) FILTER (WHERE ledger_effect = 'display_only') AS display_only_total,
         COUNT(*) AS adjustment_count,
         MAX(created_at) AS last_adjustment_at
  FROM public.merchant_float_reconciliations
  GROUP BY desk_id
) adj ON adj.desk_id = ca.id;

-- ---------------------------------------------------------
-- Stamp ledger truth onto every reconciliation record
-- ---------------------------------------------------------
CREATE OR REPLACE FUNCTION public.stamp_merchant_reconciliation_truth()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_stored numeric := 0;
  v_ledger numeric := 0;
BEGIN
  NEW.ledger_effect := 'display_only';

  IF NEW.agent_id IS NOT NULL THEN
    SELECT COALESCE(GREATEST(float_balance, 0), 0) INTO v_stored
    FROM public.wallets WHERE user_id = NEW.agent_id;
    v_ledger := public.merchant_ledger_float(NEW.agent_id);
  END IF;

  NEW.stored_float_at_post := COALESCE(v_stored, 0);
  NEW.ledger_float_at_post := COALESCE(v_ledger, 0);
  NEW.variance_at_post := COALESCE(v_stored, 0) - COALESCE(v_ledger, 0);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_stamp_merchant_reconciliation_truth ON public.merchant_float_reconciliations;
CREATE TRIGGER trg_stamp_merchant_reconciliation_truth
BEFORE INSERT ON public.merchant_float_reconciliations
FOR EACH ROW EXECUTE FUNCTION public.stamp_merchant_reconciliation_truth();

-- ---------------------------------------------------------
-- Variance watchlist
-- ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.merchant_float_variance_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  desk_id uuid NOT NULL,
  agent_id uuid,
  agent_name text,
  stored_float numeric NOT NULL DEFAULT 0,
  ledger_float numeric NOT NULL DEFAULT 0,
  variance numeric NOT NULL DEFAULT 0,
  variance_state text NOT NULL,
  display_only_adjustments numeric NOT NULL DEFAULT 0,
  severity text NOT NULL DEFAULT 'medium',
  detected_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_mfva_desk_open
  ON public.merchant_float_variance_alerts (desk_id) WHERE resolved_at IS NULL;

GRANT SELECT ON public.merchant_float_variance_alerts TO authenticated;
GRANT ALL ON public.merchant_float_variance_alerts TO service_role;
ALTER TABLE public.merchant_float_variance_alerts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Finance can view merchant float variance alerts" ON public.merchant_float_variance_alerts;
CREATE POLICY "Finance can view merchant float variance alerts"
ON public.merchant_float_variance_alerts FOR SELECT TO authenticated
USING (
  public.has_role(auth.uid(), 'cfo') OR public.has_role(auth.uid(), 'financial_ops')
  OR public.has_role(auth.uid(), 'manager') OR public.has_role(auth.uid(), 'super_admin')
  OR public.has_role(auth.uid(), 'ceo') OR public.has_role(auth.uid(), 'coo')
  OR agent_id = auth.uid()
);

DROP TRIGGER IF EXISTS trg_mfva_updated_at ON public.merchant_float_variance_alerts;
CREATE TRIGGER trg_mfva_updated_at BEFORE UPDATE ON public.merchant_float_variance_alerts
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE OR REPLACE FUNCTION public.detect_merchant_float_variances()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_raised int := 0;
  v_resolved int := 0;
  r record;
BEGIN
  FOR r IN SELECT * FROM public.v_merchant_float_ledger_variance WHERE variance_state <> 'aligned'
  LOOP
    INSERT INTO public.merchant_float_variance_alerts
      (desk_id, agent_id, agent_name, stored_float, ledger_float, variance,
       variance_state, display_only_adjustments, severity)
    VALUES (r.desk_id, r.agent_id, r.agent_name, r.stored_float, r.ledger_float,
            r.variance, r.variance_state, r.display_only_adjustments,
            CASE WHEN ABS(r.variance) >= 1000000 THEN 'critical'
                 WHEN ABS(r.variance) >= 100000 THEN 'high'
                 ELSE 'medium' END)
    ON CONFLICT (desk_id) WHERE resolved_at IS NULL DO UPDATE
      SET stored_float = EXCLUDED.stored_float,
          ledger_float = EXCLUDED.ledger_float,
          variance = EXCLUDED.variance,
          variance_state = EXCLUDED.variance_state,
          display_only_adjustments = EXCLUDED.display_only_adjustments,
          severity = EXCLUDED.severity,
          agent_name = EXCLUDED.agent_name,
          detected_at = now(),
          updated_at = now();
    v_raised := v_raised + 1;
  END LOOP;

  UPDATE public.merchant_float_variance_alerts a
     SET resolved_at = now(), updated_at = now()
   WHERE a.resolved_at IS NULL
     AND EXISTS (
       SELECT 1 FROM public.v_merchant_float_ledger_variance v
       WHERE v.desk_id = a.desk_id AND v.variance_state = 'aligned'
     );
  v_resolved := (SELECT COUNT(*) FROM public.merchant_float_variance_alerts
                 WHERE resolved_at >= now() - interval '1 minute');

  RETURN jsonb_build_object('ok', true, 'open_or_updated', v_raised,
                            'auto_resolved', v_resolved, 'ran_at', now());
END;
$$;

REVOKE ALL ON FUNCTION public.detect_merchant_float_variances() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.detect_merchant_float_variances() TO service_role;

-- ---------------------------------------------------------
-- Role-gated reporting RPC for the UI
-- ---------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_merchant_float_ledger_variance()
RETURNS TABLE (
  desk_id uuid,
  agent_id uuid,
  agent_name text,
  agent_phone text,
  label text,
  is_active boolean,
  stored_float numeric,
  ledger_float numeric,
  variance numeric,
  variance_state text,
  display_only_adjustments numeric,
  adjustment_count bigint,
  last_adjustment_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT (public.has_role(auth.uid(), 'cfo') OR public.has_role(auth.uid(), 'financial_ops')
          OR public.has_role(auth.uid(), 'manager') OR public.has_role(auth.uid(), 'super_admin')
          OR public.has_role(auth.uid(), 'ceo') OR public.has_role(auth.uid(), 'coo')) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  RETURN QUERY
  SELECT v.desk_id, v.agent_id, v.agent_name, v.agent_phone, v.label, v.is_active,
         v.stored_float, v.ledger_float, v.variance, v.variance_state,
         v.display_only_adjustments, v.adjustment_count, v.last_adjustment_at
  FROM public.v_merchant_float_ledger_variance v
  ORDER BY ABS(v.variance) DESC;
END;
$$;

REVOKE ALL ON FUNCTION public.get_merchant_float_ledger_variance() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_merchant_float_ledger_variance() TO authenticated, service_role;

-- ---------------------------------------------------------
-- Refresh the watchlist every 30 minutes
-- ---------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.unschedule('detect-merchant-float-variances')
      WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'detect-merchant-float-variances');
    PERFORM cron.schedule('detect-merchant-float-variances', '*/30 * * * *',
                          $cron$SELECT public.detect_merchant_float_variances();$cron$);
  END IF;
END $$;

SELECT public.detect_merchant_float_variances();