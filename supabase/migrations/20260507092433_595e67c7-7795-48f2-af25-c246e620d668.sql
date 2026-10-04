-- 1) Audit tables
CREATE TABLE IF NOT EXISTS public.phantom_drift_run_audit (
  run_id uuid PRIMARY KEY,
  executed_at timestamptz NOT NULL DEFAULT now(),
  new_drift_rows int NOT NULL DEFAULT 0,
  updated_drift_rows int NOT NULL DEFAULT 0,
  auto_resolved int NOT NULL DEFAULT 0,
  skipped_anchored int NOT NULL DEFAULT 0,
  skipped_recently_resolved int NOT NULL DEFAULT 0,
  total_drift_ugx numeric NOT NULL DEFAULT 0,
  notes text
);

CREATE TABLE IF NOT EXISTS public.phantom_drift_run_user_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES public.phantom_drift_run_audit(run_id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('skipped_anchored','skipped_recently_resolved','auto_resolved','detected_new','detected_updated')),
  wallet_balance numeric,
  ledger_net numeric,
  drift_amount numeric,
  reason text,
  recorded_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pdrua_run ON public.phantom_drift_run_user_audit(run_id);
CREATE INDEX IF NOT EXISTS idx_pdrua_user ON public.phantom_drift_run_user_audit(user_id);
CREATE INDEX IF NOT EXISTS idx_pdra_executed_at ON public.phantom_drift_run_audit(executed_at DESC);

ALTER TABLE public.phantom_drift_run_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.phantom_drift_run_user_audit ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "CFO can read drift audit" ON public.phantom_drift_run_audit;
CREATE POLICY "CFO can read drift audit"
  ON public.phantom_drift_run_audit FOR SELECT
  USING (EXISTS (SELECT 1 FROM public.user_roles
                 WHERE user_id = auth.uid() AND role IN ('cfo','super_admin')));

DROP POLICY IF EXISTS "CFO can read drift audit users" ON public.phantom_drift_run_user_audit;
CREATE POLICY "CFO can read drift audit users"
  ON public.phantom_drift_run_user_audit FOR SELECT
  USING (EXISTS (SELECT 1 FROM public.user_roles
                 WHERE user_id = auth.uid() AND role IN ('cfo','super_admin')));

-- 2) Patched detector with audit trail
CREATE OR REPLACE FUNCTION public.detect_phantom_wallet_drift()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
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
  v_skipped_anchored int := 0;
  v_skipped_recent int := 0;
  v_total_drift_ugx numeric := 0;
BEGIN
  -- Seed the run row early so user-audit FK is satisfied
  INSERT INTO public.phantom_drift_run_audit(run_id, executed_at) VALUES (v_run_id, v_now);

  -- Record skipped users (anchored OR recently Layer A/B resolved)
  WITH anchors AS (
    SELECT user_id FROM public.wallet_fresh_start_anchors
  ),
  recently_resolved AS (
    SELECT DISTINCT user_id
    FROM public.phantom_wallet_drift
    WHERE status='resolved' AND resolved_at > v_now - interval '30 days'
      AND (resolution_notes ILIKE 'layer_a_%' OR resolution_notes ILIKE 'layer_b_%' OR resolution_notes ILIKE 'stale phantom%')
  ),
  skipped AS (
    SELECT a.user_id, 'skipped_anchored' AS outcome,
           'has wallet_fresh_start_anchor — counted from anchor cutoff via v_user_wallet_strict' AS reason
      FROM anchors a
    UNION
    SELECT r.user_id, 'skipped_recently_resolved',
           'resolved by Layer A/B sweep within last 30 days; not re-detecting'
      FROM recently_resolved r
      WHERE r.user_id NOT IN (SELECT user_id FROM anchors)
  )
  INSERT INTO public.phantom_drift_run_user_audit(run_id, user_id, outcome, reason)
  SELECT v_run_id, user_id, outcome, reason FROM skipped;

  SELECT count(*) FILTER (WHERE outcome='skipped_anchored'),
         count(*) FILTER (WHERE outcome='skipped_recently_resolved')
    INTO v_skipped_anchored, v_skipped_recent
    FROM public.phantom_drift_run_user_audit WHERE run_id = v_run_id;

  -- Drift detection (anchor-aware)
  FOR v_drifted IN
    WITH anchors AS (
      SELECT user_id, anchor_at FROM public.wallet_fresh_start_anchors
    ),
    ledger AS (
      SELECT gl.user_id,
             COALESCE(SUM(CASE WHEN gl.direction='cash_in' THEN gl.amount ELSE -gl.amount END), 0) AS net
      FROM public.general_ledger gl
      LEFT JOIN anchors a ON a.user_id = gl.user_id
      WHERE gl.ledger_scope='wallet'
        AND gl.user_id IS NOT NULL
        AND (gl.classification IS NULL OR gl.classification IN ('production','admin_correction'))
        AND (a.anchor_at IS NULL OR gl.created_at >= a.anchor_at)
      GROUP BY gl.user_id
    ),
    recently_resolved AS (
      SELECT DISTINCT user_id FROM public.phantom_wallet_drift
      WHERE status='resolved' AND resolved_at > v_now - interval '30 days'
        AND (resolution_notes ILIKE 'layer_a_%' OR resolution_notes ILIKE 'layer_b_%' OR resolution_notes ILIKE 'stale phantom%')
    )
    SELECT w.user_id, w.balance,
           COALESCE(l.net, 0) AS ledger_net,
           w.balance - COALESCE(l.net, 0) AS drift
    FROM public.wallets w
    LEFT JOIN ledger l USING (user_id)
    WHERE w.user_id IS NOT NULL
      AND ABS(w.balance - COALESCE(l.net, 0)) >= 1
      AND w.user_id NOT IN (SELECT user_id FROM recently_resolved)
  LOOP
    v_abs := ABS(v_drifted.drift);
    v_drift_type := CASE WHEN v_drifted.drift > 0 THEN 'positive_phantom' ELSE 'negative_overdebit' END;
    v_severity := CASE WHEN v_abs >= 10000000 THEN 'critical'
                       WHEN v_abs >= 1000000 THEN 'high'
                       WHEN v_abs >= 100000 THEN 'medium'
                       ELSE 'low' END;
    v_total_drift_ugx := v_total_drift_ugx + v_abs;

    UPDATE public.phantom_wallet_drift
       SET wallet_balance=v_drifted.balance, ledger_net=v_drifted.ledger_net,
           drift_amount=v_drifted.drift, drift_type=v_drift_type, severity=v_severity,
           last_detected_at=v_now, detection_run_id=v_run_id, updated_at=v_now
     WHERE user_id=v_drifted.user_id AND status IN ('open','investigating');

    IF FOUND THEN
      v_updated_count := v_updated_count + 1;
      INSERT INTO public.phantom_drift_run_user_audit(run_id, user_id, outcome, wallet_balance, ledger_net, drift_amount, reason)
      VALUES (v_run_id, v_drifted.user_id, 'detected_updated', v_drifted.balance, v_drifted.ledger_net, v_drifted.drift, v_severity||' drift refreshed');
    ELSE
      INSERT INTO public.phantom_wallet_drift
        (user_id, wallet_balance, ledger_net, drift_amount, drift_type, severity, status, first_detected_at, last_detected_at, detection_run_id)
      VALUES (v_drifted.user_id, v_drifted.balance, v_drifted.ledger_net, v_drifted.drift, v_drift_type, v_severity, 'open', v_now, v_now, v_run_id);
      v_new_count := v_new_count + 1;
      INSERT INTO public.phantom_drift_run_user_audit(run_id, user_id, outcome, wallet_balance, ledger_net, drift_amount, reason)
      VALUES (v_run_id, v_drifted.user_id, 'detected_new', v_drifted.balance, v_drifted.ledger_net, v_drifted.drift, v_severity||' new drift');
    END IF;
  END LOOP;

  -- Auto-resolve under anchor-aware comparison
  WITH anchors AS (SELECT user_id, anchor_at FROM public.wallet_fresh_start_anchors),
  current_drift AS (
    SELECT pwd.id, pwd.user_id, w.balance,
           COALESCE((
             SELECT SUM(CASE WHEN gl.direction='cash_in' THEN gl.amount ELSE -gl.amount END)
             FROM public.general_ledger gl
             LEFT JOIN anchors a ON a.user_id = gl.user_id
             WHERE gl.ledger_scope='wallet' AND gl.user_id = pwd.user_id
               AND (gl.classification IS NULL OR gl.classification IN ('production','admin_correction'))
               AND (a.anchor_at IS NULL OR gl.created_at >= a.anchor_at)
           ), 0) AS net
    FROM public.phantom_wallet_drift pwd
    JOIN public.wallets w ON w.user_id = pwd.user_id
    WHERE pwd.status IN ('open','investigating')
  ),
  resolved AS (
    UPDATE public.phantom_wallet_drift pwd
       SET status='resolved', resolved_at=v_now,
           resolution_notes=COALESCE(resolution_notes,'')||E'\nAuto-resolved (anchor-aware): drift cleared at '||v_now::text,
           updated_at=v_now
      FROM current_drift cd
     WHERE pwd.id=cd.id AND ABS(cd.balance-cd.net) < 1
     RETURNING pwd.user_id, cd.balance, cd.net
  )
  INSERT INTO public.phantom_drift_run_user_audit(run_id, user_id, outcome, wallet_balance, ledger_net, drift_amount, reason)
  SELECT v_run_id, user_id, 'auto_resolved', balance, net, balance-net,
         'drift cleared under anchor-aware comparison'
    FROM resolved;

  GET DIAGNOSTICS v_auto_resolved = ROW_COUNT;

  -- Finalize run summary
  UPDATE public.phantom_drift_run_audit
     SET new_drift_rows=v_new_count,
         updated_drift_rows=v_updated_count,
         auto_resolved=v_auto_resolved,
         skipped_anchored=v_skipped_anchored,
         skipped_recently_resolved=v_skipped_recent,
         total_drift_ugx=v_total_drift_ugx,
         notes='anchor-aware run with full audit trail'
   WHERE run_id=v_run_id;

  RETURN jsonb_build_object(
    'run_id', v_run_id, 'executed_at', v_now,
    'new_drift_rows', v_new_count,
    'updated_drift_rows', v_updated_count,
    'auto_resolved', v_auto_resolved,
    'skipped_anchored', v_skipped_anchored,
    'skipped_recently_resolved', v_skipped_recent,
    'total_drift_ugx', v_total_drift_ugx,
    'anchor_aware', true
  );
END;
$function$;