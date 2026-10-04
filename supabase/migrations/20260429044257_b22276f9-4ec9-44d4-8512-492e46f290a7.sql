
-- Drop existing function so we can change return type
DROP FUNCTION IF EXISTS public.get_user_available_balance(uuid);

-- 1. Baseline snapshot table
CREATE TABLE IF NOT EXISTS public.wallet_ledger_baseline (
  user_id uuid PRIMARY KEY,
  withdrawable_at_baseline numeric NOT NULL DEFAULT 0,
  float_at_baseline numeric NOT NULL DEFAULT 0,
  advance_at_baseline numeric NOT NULL DEFAULT 0,
  ledger_net_at_baseline numeric NOT NULL DEFAULT 0,
  baseline_at timestamptz NOT NULL DEFAULT now(),
  baseline_reason text NOT NULL DEFAULT 'initial_snapshot_2026_04_29',
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.wallet_ledger_baseline ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users see own baseline" ON public.wallet_ledger_baseline;
CREATE POLICY "Users see own baseline"
  ON public.wallet_ledger_baseline FOR SELECT
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Privileged see all baselines" ON public.wallet_ledger_baseline;
CREATE POLICY "Privileged see all baselines"
  ON public.wallet_ledger_baseline FOR SELECT
  USING (
    public.has_role(auth.uid(), 'manager')
    OR public.has_role(auth.uid(), 'cfo')
    OR public.has_role(auth.uid(), 'coo')
  );

-- 2. Review queue
CREATE TABLE IF NOT EXISTS public.wallet_ledger_review_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  reason text NOT NULL,
  withdrawable_balance numeric NOT NULL DEFAULT 0,
  float_balance numeric NOT NULL DEFAULT 0,
  advance_balance numeric NOT NULL DEFAULT 0,
  ledger_net numeric NOT NULL DEFAULT 0,
  gap numeric NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'open',
  resolved_by uuid,
  resolved_at timestamptz,
  resolution_notes text,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_wlrq_status ON public.wallet_ledger_review_queue (status);
CREATE INDEX IF NOT EXISTS idx_wlrq_user ON public.wallet_ledger_review_queue (user_id);

ALTER TABLE public.wallet_ledger_review_queue ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Privileged see review queue" ON public.wallet_ledger_review_queue;
CREATE POLICY "Privileged see review queue"
  ON public.wallet_ledger_review_queue FOR SELECT
  USING (
    public.has_role(auth.uid(), 'manager')
    OR public.has_role(auth.uid(), 'cfo')
    OR public.has_role(auth.uid(), 'coo')
  );

DROP POLICY IF EXISTS "Privileged update review queue" ON public.wallet_ledger_review_queue;
CREATE POLICY "Privileged update review queue"
  ON public.wallet_ledger_review_queue FOR UPDATE
  USING (
    public.has_role(auth.uid(), 'manager')
    OR public.has_role(auth.uid(), 'cfo')
    OR public.has_role(auth.uid(), 'coo')
  );

-- 3. Snapshot function
CREATE OR REPLACE FUNCTION public.snapshot_wallet_ledger_baseline()
RETURNS TABLE(snapshotted_count integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer := 0;
BEGIN
  WITH ledger_nets AS (
    SELECT user_id,
           SUM(CASE WHEN direction='cash_in' THEN amount
                    WHEN direction='cash_out' THEN -amount ELSE 0 END) AS net
    FROM public.general_ledger
    WHERE ledger_scope = 'wallet'
      AND (classification IS NULL OR classification = 'production')
    GROUP BY user_id
  ),
  ins AS (
    INSERT INTO public.wallet_ledger_baseline (
      user_id, withdrawable_at_baseline, float_at_baseline,
      advance_at_baseline, ledger_net_at_baseline, baseline_reason
    )
    SELECT w.user_id,
           COALESCE(w.withdrawable_balance, 0),
           COALESCE(w.float_balance, 0),
           COALESCE(w.advance_balance, 0),
           COALESCE(l.net, 0),
           'initial_snapshot_2026_04_29'
    FROM public.wallets w
    LEFT JOIN ledger_nets l ON l.user_id = w.user_id
    ON CONFLICT (user_id) DO NOTHING
    RETURNING 1
  )
  SELECT COUNT(*)::int INTO v_count FROM ins;

  RETURN QUERY SELECT v_count;
END;
$$;

-- 4. Phantom clamp
CREATE OR REPLACE FUNCTION public.run_phantom_clamp_pass(p_dry_run boolean DEFAULT true)
RETURNS TABLE(
  user_id uuid,
  withdrawable_before numeric,
  ledger_net numeric,
  clamp_amount numeric,
  executed boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r record;
  v_clamp numeric;
BEGIN
  FOR r IN
    WITH ledger_nets AS (
      SELECT gl.user_id,
             SUM(CASE WHEN gl.direction='cash_in' THEN gl.amount
                      WHEN gl.direction='cash_out' THEN -gl.amount ELSE 0 END) AS net
      FROM public.general_ledger gl
      WHERE gl.ledger_scope = 'wallet'
        AND (gl.classification IS NULL OR gl.classification = 'production')
      GROUP BY gl.user_id
    )
    SELECT w.user_id AS uid,
           COALESCE(w.withdrawable_balance, 0) AS w_bal,
           COALESCE(l.net, 0) AS net
    FROM public.wallets w
    LEFT JOIN ledger_nets l ON l.user_id = w.user_id
    WHERE COALESCE(l.net, 0) >= 0
      AND COALESCE(w.withdrawable_balance, 0)
          > GREATEST(0, COALESCE(l.net, 0)) + 1
  LOOP
    v_clamp := r.w_bal - GREATEST(0, r.net);

    IF NOT p_dry_run THEN
      PERFORM public.apply_wallet_movement(
        r.uid,
        'system_balance_correction',
        v_clamp,
        'cash_out'
      );
    END IF;

    user_id := r.uid;
    withdrawable_before := r.w_bal;
    ledger_net := r.net;
    clamp_amount := v_clamp;
    executed := NOT p_dry_run;
    RETURN NEXT;
  END LOOP;
END;
$$;

-- 5. Populate review queue
CREATE OR REPLACE FUNCTION public.populate_wallet_review_queue()
RETURNS TABLE(inserted_count integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer := 0;
BEGIN
  WITH ledger_nets AS (
    SELECT gl.user_id,
           SUM(CASE WHEN gl.direction='cash_in' THEN gl.amount
                    WHEN gl.direction='cash_out' THEN -gl.amount ELSE 0 END) AS net
    FROM public.general_ledger gl
    WHERE gl.ledger_scope = 'wallet'
      AND (gl.classification IS NULL OR gl.classification = 'production')
    GROUP BY gl.user_id
  ),
  candidates AS (
    SELECT w.user_id AS uid,
           COALESCE(w.withdrawable_balance,0) AS wb,
           COALESCE(w.float_balance,0)        AS fb,
           COALESCE(w.advance_balance,0)      AS ab,
           COALESCE(l.net,0)                  AS net
    FROM public.wallets w
    LEFT JOIN ledger_nets l ON l.user_id = w.user_id
  ),
  classified AS (
    SELECT c.*,
           CASE
             WHEN c.net < 0 THEN 'negative_ledger_net'
             WHEN c.net > (c.wb + c.fb - c.ab) + 1 THEN 'understated'
             ELSE NULL
           END AS reason,
           (c.net - (c.wb + c.fb - c.ab)) AS gap
    FROM candidates c
  ),
  ins AS (
    INSERT INTO public.wallet_ledger_review_queue (
      user_id, reason, withdrawable_balance, float_balance,
      advance_balance, ledger_net, gap
    )
    SELECT cl.uid, cl.reason, cl.wb, cl.fb, cl.ab, cl.net, cl.gap
    FROM classified cl
    WHERE cl.reason IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM public.wallet_ledger_review_queue q
        WHERE q.user_id = cl.uid
          AND q.status = 'open'
          AND q.reason = cl.reason
      )
    RETURNING 1
  )
  SELECT COUNT(*)::int INTO v_count FROM ins;

  RETURN QUERY SELECT v_count;
END;
$$;

-- 6. Baseline-anchored available RPC
CREATE OR REPLACE FUNCTION public.get_user_available_balance(p_user_id uuid)
RETURNS numeric
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _withdrawable_cached numeric := 0;
  _ledger_net_now      numeric := 0;
  _baseline_w          numeric;
  _baseline_net        numeric;
  _allowed_cap         numeric;
  _pending_holds       numeric := 0;
  _available           numeric := 0;
BEGIN
  SELECT COALESCE(withdrawable_balance, 0) INTO _withdrawable_cached
  FROM public.wallets WHERE user_id = p_user_id;

  SELECT COALESCE(SUM(CASE WHEN direction='cash_in' THEN amount
                           WHEN direction='cash_out' THEN -amount
                           ELSE 0 END), 0)
    INTO _ledger_net_now
  FROM public.general_ledger
  WHERE user_id = p_user_id
    AND ledger_scope = 'wallet'
    AND (classification IS NULL OR classification = 'production');

  SELECT withdrawable_at_baseline, ledger_net_at_baseline
    INTO _baseline_w, _baseline_net
  FROM public.wallet_ledger_baseline
  WHERE user_id = p_user_id;

  IF _baseline_w IS NULL THEN
    _allowed_cap := COALESCE(_withdrawable_cached, 0);
  ELSE
    _allowed_cap := GREATEST(0, _baseline_w + (_ledger_net_now - _baseline_net));
  END IF;

  SELECT COALESCE(SUM(amount), 0) INTO _pending_holds
  FROM public.withdrawal_requests
  WHERE user_id = p_user_id
    AND status IN ('pending','requested','manager_approved','processing');

  _available := GREATEST(0,
    LEAST(COALESCE(_withdrawable_cached, 0), _allowed_cap) - COALESCE(_pending_holds, 0)
  );

  RETURN _available;
END;
$$;

-- 7. Run snapshot + populate review queue immediately
SELECT public.snapshot_wallet_ledger_baseline();
SELECT public.populate_wallet_review_queue();
