CREATE TABLE public.phantom_wallet_drift (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  wallet_balance numeric NOT NULL,
  ledger_net numeric NOT NULL,
  drift_amount numeric NOT NULL,
  drift_type text NOT NULL CHECK (drift_type IN ('positive_phantom','negative_overdebit')),
  severity text NOT NULL CHECK (severity IN ('low','medium','high','critical')),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','investigating','resolved','false_positive')),
  first_detected_at timestamptz NOT NULL DEFAULT now(),
  last_detected_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolved_by uuid,
  resolution_notes text,
  detection_run_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- One open/investigating row per user (partial unique)
CREATE UNIQUE INDEX idx_phantom_drift_one_open_per_user
  ON public.phantom_wallet_drift(user_id)
  WHERE status IN ('open','investigating');

CREATE INDEX idx_phantom_drift_status ON public.phantom_wallet_drift(status);
CREATE INDEX idx_phantom_drift_severity ON public.phantom_wallet_drift(severity, status);
CREATE INDEX idx_phantom_drift_user ON public.phantom_wallet_drift(user_id);
CREATE INDEX idx_phantom_drift_last_detected ON public.phantom_wallet_drift(last_detected_at DESC);

ALTER TABLE public.phantom_wallet_drift ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Finance staff read drift"
  ON public.phantom_wallet_drift FOR SELECT
  TO authenticated
  USING (
    public.has_role(auth.uid(), 'cfo'::app_role)
    OR public.has_role(auth.uid(), 'coo'::app_role)
    OR public.has_role(auth.uid(), 'manager'::app_role)
    OR public.has_role(auth.uid(), 'ceo'::app_role)
    OR public.has_role(auth.uid(), 'super_admin'::app_role)
  );

CREATE POLICY "Finance staff update drift status"
  ON public.phantom_wallet_drift FOR UPDATE
  TO authenticated
  USING (
    public.has_role(auth.uid(), 'cfo'::app_role)
    OR public.has_role(auth.uid(), 'coo'::app_role)
    OR public.has_role(auth.uid(), 'manager'::app_role)
    OR public.has_role(auth.uid(), 'super_admin'::app_role)
  );

CREATE TRIGGER update_phantom_drift_updated_at
BEFORE UPDATE ON public.phantom_wallet_drift
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE OR REPLACE FUNCTION public.detect_phantom_wallet_drift()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_run_id uuid := gen_random_uuid();
  v_now timestamptz := now();
  v_drifted RECORD;
  v_severity text;
  v_drift_type text;
  v_abs numeric;
  v_new_count int := 0;
  v_updated_count int := 0;
  v_auto_resolved int := 0;
  v_total_drift_ugx numeric := 0;
BEGIN
  FOR v_drifted IN
    WITH ledger AS (
      SELECT user_id,
        COALESCE(SUM(CASE WHEN direction='cash_in' THEN amount ELSE -amount END), 0) AS net
      FROM public.general_ledger
      WHERE ledger_scope='wallet' AND user_id IS NOT NULL
        AND classification IN ('production','admin_correction')
      GROUP BY user_id
    )
    SELECT w.user_id, w.balance,
           COALESCE(l.net, 0) AS ledger_net,
           w.balance - COALESCE(l.net, 0) AS drift
    FROM public.wallets w
    LEFT JOIN ledger l USING (user_id)
    WHERE ABS(w.balance - COALESCE(l.net, 0)) >= 1
  LOOP
    v_abs := ABS(v_drifted.drift);
    v_drift_type := CASE WHEN v_drifted.drift > 0 THEN 'positive_phantom' ELSE 'negative_overdebit' END;
    v_severity := CASE
      WHEN v_abs >= 10000000 THEN 'critical'
      WHEN v_abs >= 1000000  THEN 'high'
      WHEN v_abs >= 100000   THEN 'medium'
      ELSE 'low'
    END;
    v_total_drift_ugx := v_total_drift_ugx + v_abs;

    UPDATE public.phantom_wallet_drift
       SET wallet_balance = v_drifted.balance,
           ledger_net = v_drifted.ledger_net,
           drift_amount = v_drifted.drift,
           drift_type = v_drift_type,
           severity = v_severity,
           last_detected_at = v_now,
           detection_run_id = v_run_id,
           updated_at = v_now
     WHERE user_id = v_drifted.user_id
       AND status IN ('open','investigating');

    IF FOUND THEN
      v_updated_count := v_updated_count + 1;
    ELSE
      INSERT INTO public.phantom_wallet_drift
        (user_id, wallet_balance, ledger_net, drift_amount, drift_type,
         severity, status, first_detected_at, last_detected_at, detection_run_id)
      VALUES
        (v_drifted.user_id, v_drifted.balance, v_drifted.ledger_net, v_drifted.drift,
         v_drift_type, v_severity, 'open', v_now, v_now, v_run_id);
      v_new_count := v_new_count + 1;
    END IF;
  END LOOP;

  -- Auto-resolve rows whose users no longer drift
  WITH no_longer_drifting AS (
    SELECT pwd.id
    FROM public.phantom_wallet_drift pwd
    JOIN public.wallets w ON w.user_id = pwd.user_id
    LEFT JOIN LATERAL (
      SELECT COALESCE(SUM(CASE WHEN direction='cash_in' THEN amount ELSE -amount END), 0) AS net
      FROM public.general_ledger
      WHERE ledger_scope='wallet' AND user_id = pwd.user_id
        AND classification IN ('production','admin_correction')
    ) l ON TRUE
    WHERE pwd.status IN ('open','investigating')
      AND ABS(w.balance - COALESCE(l.net, 0)) < 1
  )
  UPDATE public.phantom_wallet_drift
     SET status = 'resolved',
         resolved_at = v_now,
         resolution_notes = COALESCE(resolution_notes,'') || E'\nAuto-resolved: drift cleared at ' || v_now::text,
         updated_at = v_now
   WHERE id IN (SELECT id FROM no_longer_drifting);

  GET DIAGNOSTICS v_auto_resolved = ROW_COUNT;

  RETURN jsonb_build_object(
    'run_id', v_run_id,
    'executed_at', v_now,
    'new_drift_rows', v_new_count,
    'updated_drift_rows', v_updated_count,
    'auto_resolved', v_auto_resolved,
    'total_drift_ugx', v_total_drift_ugx
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.detect_phantom_wallet_drift() TO service_role;