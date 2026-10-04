
-- =========================================================================
-- 1. Projection table
-- =========================================================================
CREATE TABLE IF NOT EXISTS public.wallet_balances_projection (
  user_id uuid PRIMARY KEY,
  withdrawable numeric NOT NULL DEFAULT 0,
  float_balance numeric NOT NULL DEFAULT 0,
  advance_balance numeric NOT NULL DEFAULT 0,
  pending_holds numeric NOT NULL DEFAULT 0,
  restricted_held numeric NOT NULL DEFAULT 0,
  total_visible numeric NOT NULL DEFAULT 0,
  ledger_version bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.wallet_balances_projection TO authenticated;
GRANT ALL ON public.wallet_balances_projection TO service_role;

ALTER TABLE public.wallet_balances_projection ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "user reads own projection" ON public.wallet_balances_projection;
CREATE POLICY "user reads own projection"
  ON public.wallet_balances_projection FOR SELECT
  TO authenticated
  USING (
    auth.uid() = user_id
    OR public.has_role(auth.uid(), 'cfo'::app_role)
    OR public.has_role(auth.uid(), 'coo'::app_role)
    OR public.has_role(auth.uid(), 'ceo'::app_role)
    OR public.has_role(auth.uid(), 'manager'::app_role)
    OR public.has_role(auth.uid(), 'financial_ops'::app_role)
  );

-- =========================================================================
-- 2. Drift alerts table
-- =========================================================================
CREATE TABLE IF NOT EXISTS public.wallet_projection_drift_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  detected_at timestamptz NOT NULL DEFAULT now(),
  user_id uuid NOT NULL,
  projection_withdrawable numeric NOT NULL,
  ledger_withdrawable numeric NOT NULL,
  projection_float numeric NOT NULL,
  ledger_float numeric NOT NULL,
  projection_advance numeric NOT NULL,
  ledger_advance numeric NOT NULL,
  delta_withdrawable numeric GENERATED ALWAYS AS (projection_withdrawable - ledger_withdrawable) STORED,
  auto_healed boolean NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS idx_wbp_drift_detected ON public.wallet_projection_drift_alerts(detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_wbp_drift_user ON public.wallet_projection_drift_alerts(user_id, detected_at DESC);

GRANT SELECT ON public.wallet_projection_drift_alerts TO authenticated;
GRANT ALL ON public.wallet_projection_drift_alerts TO service_role;

ALTER TABLE public.wallet_projection_drift_alerts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ops reads drift alerts" ON public.wallet_projection_drift_alerts;
CREATE POLICY "ops reads drift alerts"
  ON public.wallet_projection_drift_alerts FOR SELECT
  TO authenticated
  USING (
    public.has_role(auth.uid(), 'cfo'::app_role)
    OR public.has_role(auth.uid(), 'coo'::app_role)
    OR public.has_role(auth.uid(), 'ceo'::app_role)
    OR public.has_role(auth.uid(), 'manager'::app_role)
    OR public.has_role(auth.uid(), 'financial_ops'::app_role)
  );

-- =========================================================================
-- 3. Refresh a single user's projection row from the strict ledger view.
--    Deterministic; same math the existing v_user_wallet_strict uses,
--    so the projection is by construction consistent with the ledger.
-- =========================================================================
CREATE OR REPLACE FUNCTION public.refresh_wallet_projection_for(p_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r record;
BEGIN
  IF p_user_id IS NULL THEN
    RETURN;
  END IF;

  SELECT * INTO r FROM public.v_user_wallet_strict WHERE user_id = p_user_id;

  IF NOT FOUND THEN
    -- No ledger rows / no wallet → ensure a zero row exists so reads never miss.
    INSERT INTO public.wallet_balances_projection (user_id, updated_at, ledger_version)
    VALUES (p_user_id, now(), 0)
    ON CONFLICT (user_id) DO UPDATE
      SET withdrawable = 0,
          float_balance = 0,
          advance_balance = 0,
          pending_holds = 0,
          restricted_held = 0,
          total_visible = 0,
          ledger_version = public.wallet_balances_projection.ledger_version + 1,
          updated_at = now();
    RETURN;
  END IF;

  INSERT INTO public.wallet_balances_projection AS w (
    user_id, withdrawable, float_balance, advance_balance,
    pending_holds, restricted_held, total_visible, ledger_version, updated_at
  ) VALUES (
    r.user_id,
    COALESCE(r.withdrawable, 0),
    COALESCE(r.float_balance, 0),
    COALESCE(r.advance_balance, 0),
    COALESCE(r.pending_holds, 0),
    COALESCE(r.restricted_held, 0),
    COALESCE(r.total_visible, 0),
    1,
    now()
  )
  ON CONFLICT (user_id) DO UPDATE
    SET withdrawable = EXCLUDED.withdrawable,
        float_balance = EXCLUDED.float_balance,
        advance_balance = EXCLUDED.advance_balance,
        pending_holds = EXCLUDED.pending_holds,
        restricted_held = EXCLUDED.restricted_held,
        total_visible = EXCLUDED.total_visible,
        ledger_version = w.ledger_version + 1,
        updated_at = now();
END;
$$;

REVOKE ALL ON FUNCTION public.refresh_wallet_projection_for(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.refresh_wallet_projection_for(uuid) TO service_role;

-- =========================================================================
-- 4. Rebuild everything (or a single user) from ledger truth.
--    Safe to call at any time; deterministic.
-- =========================================================================
CREATE OR REPLACE FUNCTION public.rebuild_wallet_projection(p_user_id uuid DEFAULT NULL)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count bigint := 0;
BEGIN
  IF p_user_id IS NOT NULL THEN
    PERFORM public.refresh_wallet_projection_for(p_user_id);
    RETURN 1;
  END IF;

  -- Full rebuild: upsert every user that appears in the strict view.
  WITH src AS (
    SELECT * FROM public.v_user_wallet_strict WHERE user_id IS NOT NULL
  ),
  upsert AS (
    INSERT INTO public.wallet_balances_projection AS w (
      user_id, withdrawable, float_balance, advance_balance,
      pending_holds, restricted_held, total_visible, ledger_version, updated_at
    )
    SELECT
      user_id,
      COALESCE(withdrawable, 0),
      COALESCE(float_balance, 0),
      COALESCE(advance_balance, 0),
      COALESCE(pending_holds, 0),
      COALESCE(restricted_held, 0),
      COALESCE(total_visible, 0),
      1,
      now()
    FROM src
    ON CONFLICT (user_id) DO UPDATE
      SET withdrawable = EXCLUDED.withdrawable,
          float_balance = EXCLUDED.float_balance,
          advance_balance = EXCLUDED.advance_balance,
          pending_holds = EXCLUDED.pending_holds,
          restricted_held = EXCLUDED.restricted_held,
          total_visible = EXCLUDED.total_visible,
          ledger_version = w.ledger_version + 1,
          updated_at = now()
    RETURNING 1
  )
  SELECT count(*) INTO v_count FROM upsert;

  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.rebuild_wallet_projection(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rebuild_wallet_projection(uuid) TO service_role;

-- =========================================================================
-- 5. Batch read RPC (indexed single scan over projection table).
-- =========================================================================
CREATE OR REPLACE FUNCTION public.get_wallets_batch(p_user_ids uuid[])
RETURNS TABLE (
  user_id uuid,
  withdrawable numeric,
  float_balance numeric,
  advance_balance numeric,
  pending_holds numeric,
  restricted_held numeric,
  total_visible numeric,
  updated_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    w.user_id,
    w.withdrawable,
    w.float_balance,
    w.advance_balance,
    w.pending_holds,
    w.restricted_held,
    w.total_visible,
    w.updated_at
  FROM public.wallet_balances_projection w
  WHERE w.user_id = ANY(p_user_ids);
$$;

GRANT EXECUTE ON FUNCTION public.get_wallets_batch(uuid[]) TO authenticated, service_role;

-- =========================================================================
-- 6. Ledger write trigger → refresh affected user's projection row
--    in the same transaction as the ledger insert.
-- =========================================================================
CREATE OR REPLACE FUNCTION public.tg_refresh_wallet_projection_on_ledger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.user_id IS NOT NULL AND NEW.ledger_scope = 'wallet' THEN
    PERFORM public.refresh_wallet_projection_for(NEW.user_id);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_wallet_projection_ledger ON public.general_ledger;
CREATE TRIGGER trg_wallet_projection_ledger
AFTER INSERT ON public.general_ledger
FOR EACH ROW
EXECUTE FUNCTION public.tg_refresh_wallet_projection_on_ledger();

-- Also refresh when maturity flips (restricted → withdrawable).
CREATE OR REPLACE FUNCTION public.tg_refresh_wallet_projection_on_maturity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.user_id IS NOT NULL
     AND NEW.ledger_scope = 'wallet'
     AND (NEW.maturity_met IS DISTINCT FROM OLD.maturity_met
          OR NEW.maturity_expired IS DISTINCT FROM OLD.maturity_expired) THEN
    PERFORM public.refresh_wallet_projection_for(NEW.user_id);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_wallet_projection_maturity ON public.general_ledger;
CREATE TRIGGER trg_wallet_projection_maturity
AFTER UPDATE OF maturity_met, maturity_expired ON public.general_ledger
FOR EACH ROW
EXECUTE FUNCTION public.tg_refresh_wallet_projection_on_maturity();

-- =========================================================================
-- 7. Withdrawal-request trigger → recompute pending_holds live.
-- =========================================================================
CREATE OR REPLACE FUNCTION public.tg_refresh_wallet_projection_on_wr()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_user := CASE
      WHEN OLD.proxy_partner_id IS NOT NULL AND OLD.agent_id IS NOT NULL THEN OLD.agent_id
      ELSE OLD.user_id
    END;
  ELSE
    v_user := CASE
      WHEN NEW.proxy_partner_id IS NOT NULL AND NEW.agent_id IS NOT NULL THEN NEW.agent_id
      ELSE NEW.user_id
    END;
  END IF;

  IF v_user IS NOT NULL THEN
    PERFORM public.refresh_wallet_projection_for(v_user);
  END IF;

  -- If status changed and old user differs (rare: reassignment), refresh both.
  IF TG_OP = 'UPDATE' THEN
    DECLARE v_old uuid;
    BEGIN
      v_old := CASE
        WHEN OLD.proxy_partner_id IS NOT NULL AND OLD.agent_id IS NOT NULL THEN OLD.agent_id
        ELSE OLD.user_id
      END;
      IF v_old IS NOT NULL AND v_old IS DISTINCT FROM v_user THEN
        PERFORM public.refresh_wallet_projection_for(v_old);
      END IF;
    END;
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS trg_wallet_projection_wr ON public.withdrawal_requests;
CREATE TRIGGER trg_wallet_projection_wr
AFTER INSERT OR UPDATE OR DELETE ON public.withdrawal_requests
FOR EACH ROW
EXECUTE FUNCTION public.tg_refresh_wallet_projection_on_wr();

-- =========================================================================
-- 8. Drift detector RPC (samples users, logs divergences, auto-heals).
-- =========================================================================
CREATE OR REPLACE FUNCTION public.detect_wallet_projection_drift(p_sample_size integer DEFAULT 500)
RETURNS TABLE (
  users_checked bigint,
  users_drifted bigint,
  auto_healed bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_checked bigint := 0;
  v_drifted bigint := 0;
  v_healed bigint := 0;
BEGIN
  WITH sampled AS (
    SELECT user_id
    FROM public.wallet_balances_projection
    ORDER BY updated_at ASC
    LIMIT p_sample_size
  ),
  compared AS (
    SELECT
      p.user_id,
      p.withdrawable AS p_w, p.float_balance AS p_f, p.advance_balance AS p_a,
      s.withdrawable AS s_w, s.float_balance AS s_f, s.advance_balance AS s_a
    FROM public.wallet_balances_projection p
    JOIN sampled ON sampled.user_id = p.user_id
    LEFT JOIN public.v_user_wallet_strict s ON s.user_id = p.user_id
  ),
  divergent AS (
    SELECT * FROM compared
    WHERE (COALESCE(p_w,0) - COALESCE(s_w,0)) <> 0
       OR (COALESCE(p_f,0) - COALESCE(s_f,0)) <> 0
       OR (COALESCE(p_a,0) - COALESCE(s_a,0)) <> 0
  ),
  logged AS (
    INSERT INTO public.wallet_projection_drift_alerts
      (user_id, projection_withdrawable, ledger_withdrawable,
       projection_float, ledger_float, projection_advance, ledger_advance, auto_healed)
    SELECT user_id, p_w, COALESCE(s_w,0), p_f, COALESCE(s_f,0), p_a, COALESCE(s_a,0), true
    FROM divergent
    RETURNING user_id
  ),
  heal AS (
    SELECT public.refresh_wallet_projection_for(user_id) FROM logged
  )
  SELECT
    (SELECT count(*) FROM sampled),
    (SELECT count(*) FROM divergent),
    (SELECT count(*) FROM logged)
  INTO v_checked, v_drifted, v_healed;

  RETURN QUERY SELECT v_checked, v_drifted, v_healed;
END;
$$;

REVOKE ALL ON FUNCTION public.detect_wallet_projection_drift(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.detect_wallet_projection_drift(integer) TO service_role;
