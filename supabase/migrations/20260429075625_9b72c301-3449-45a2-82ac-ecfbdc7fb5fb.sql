-- ============================================================
-- PART 1: Fresh-Start Anchor table
-- ============================================================
CREATE TABLE IF NOT EXISTS public.wallet_fresh_start_anchors (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  anchor_at timestamptz NOT NULL DEFAULT now(),
  pre_anchor_ledger_net numeric NOT NULL,
  reason text NOT NULL,
  created_by uuid,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.wallet_fresh_start_anchors ENABLE ROW LEVEL SECURITY;

CREATE POLICY "CFO and managers can view anchors"
  ON public.wallet_fresh_start_anchors FOR SELECT
  USING (
    public.has_role(auth.uid(), 'cfo'::app_role)
    OR public.has_role(auth.uid(), 'manager'::app_role)
  );

CREATE POLICY "CFO and managers can manage anchors"
  ON public.wallet_fresh_start_anchors FOR ALL
  USING (
    public.has_role(auth.uid(), 'cfo'::app_role)
    OR public.has_role(auth.uid(), 'manager'::app_role)
  )
  WITH CHECK (
    public.has_role(auth.uid(), 'cfo'::app_role)
    OR public.has_role(auth.uid(), 'manager'::app_role)
  );

CREATE INDEX IF NOT EXISTS idx_wallet_fresh_start_anchors_at
  ON public.wallet_fresh_start_anchors(anchor_at);

-- ============================================================
-- PART 2: Historical Drift Review Queue
-- ============================================================
CREATE TABLE IF NOT EXISTS public.wallet_historical_drift_review (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  cached_withdrawable numeric NOT NULL,
  pre_anchor_ledger_net numeric NOT NULL,
  phantom_amount numeric NOT NULL,
  status text NOT NULL DEFAULT 'pending_review'
    CHECK (status IN ('pending_review','approved_release','approved_writedown','escalated')),
  cfo_decision text,
  cfo_actor uuid,
  decided_at timestamptz,
  correction_ledger_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id)
);

ALTER TABLE public.wallet_historical_drift_review ENABLE ROW LEVEL SECURITY;

CREATE POLICY "CFO and managers can view drift review"
  ON public.wallet_historical_drift_review FOR SELECT
  USING (
    public.has_role(auth.uid(), 'cfo'::app_role)
    OR public.has_role(auth.uid(), 'manager'::app_role)
  );

CREATE POLICY "CFO and managers can manage drift review"
  ON public.wallet_historical_drift_review FOR ALL
  USING (
    public.has_role(auth.uid(), 'cfo'::app_role)
    OR public.has_role(auth.uid(), 'manager'::app_role)
  )
  WITH CHECK (
    public.has_role(auth.uid(), 'cfo'::app_role)
    OR public.has_role(auth.uid(), 'manager'::app_role)
  );

CREATE INDEX IF NOT EXISTS idx_drift_review_status
  ON public.wallet_historical_drift_review(status);
CREATE INDEX IF NOT EXISTS idx_drift_review_phantom_amount
  ON public.wallet_historical_drift_review(phantom_amount DESC);

-- ============================================================
-- PART 3: Updated strict withdrawable RPC honoring the anchor
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_user_available_balance(p_user_id uuid)
RETURNS numeric
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _withdrawable_cached numeric := 0;
  _ledger_net_now      numeric := 0;
  _pending_holds       numeric := 0;
  _allowed_cap         numeric := 0;
  _available           numeric := 0;
  _anchor_at           timestamptz;
BEGIN
  SELECT COALESCE(withdrawable_balance, 0)
    INTO _withdrawable_cached
  FROM public.wallets
  WHERE user_id = p_user_id;

  -- Per-user anchor narrows the ledger window when present
  SELECT anchor_at INTO _anchor_at
  FROM public.wallet_fresh_start_anchors
  WHERE user_id = p_user_id;

  SELECT COALESCE(SUM(CASE WHEN direction = 'cash_in'  THEN amount
                           WHEN direction = 'cash_out' THEN -amount
                           ELSE 0 END), 0)
    INTO _ledger_net_now
  FROM public.general_ledger
  WHERE user_id = p_user_id
    AND ledger_scope = 'wallet'
    AND (classification IS NULL OR classification = 'production')
    AND (_anchor_at IS NULL OR created_at >= _anchor_at);

  SELECT COALESCE(SUM(amount), 0)
    INTO _pending_holds
  FROM public.withdrawal_requests
  WHERE user_id = p_user_id
    AND status IN ('pending','requested','manager_approved','processing');

  -- Strict rule preserved: ledger is truth, negative => 0
  _allowed_cap := GREATEST(0, _ledger_net_now);

  _available := GREATEST(
    0,
    LEAST(COALESCE(_withdrawable_cached, 0), _allowed_cap) - COALESCE(_pending_holds, 0)
  );

  RETURN _available;
END;
$function$;

-- ============================================================
-- PART 4: Backfill — anchor all currently-negative agents at
-- 2026-04-29 00:00 Africa/Kampala and seed review-queue rows.
-- ============================================================
WITH anchor_ts AS (
  SELECT timestamp '2026-04-29 00:00:00' AT TIME ZONE 'Africa/Kampala' AS ts
),
candidates AS (
  SELECT
    w.user_id,
    COALESCE(w.withdrawable_balance, 0) AS cached,
    COALESCE(SUM(
      CASE WHEN gl.direction='cash_in'  THEN gl.amount
           WHEN gl.direction='cash_out' THEN -gl.amount
           ELSE 0 END
    ), 0) AS prod_net
  FROM public.wallets w
  LEFT JOIN public.general_ledger gl
    ON gl.user_id = w.user_id
   AND gl.ledger_scope = 'wallet'
   AND (gl.classification IS NULL OR gl.classification = 'production')
  GROUP BY w.user_id, w.withdrawable_balance
),
to_anchor AS (
  SELECT * FROM candidates WHERE prod_net < 0
)
INSERT INTO public.wallet_fresh_start_anchors (user_id, anchor_at, pre_anchor_ledger_net, reason, created_by, notes)
SELECT
  t.user_id,
  (SELECT ts FROM anchor_ts),
  t.prod_net,
  '2026-04-29 system-wide commission reset (hybrid fresh-start)',
  NULL,
  'Backfilled by migration; ledger window narrowed to anchor_at; cache cap retained.'
FROM to_anchor t
ON CONFLICT (user_id) DO NOTHING;

-- Seed review queue rows for the same set
WITH anchored AS (
  SELECT a.user_id, a.pre_anchor_ledger_net,
         COALESCE(w.withdrawable_balance, 0) AS cached
  FROM public.wallet_fresh_start_anchors a
  JOIN public.wallets w ON w.user_id = a.user_id
)
INSERT INTO public.wallet_historical_drift_review
  (user_id, cached_withdrawable, pre_anchor_ledger_net, phantom_amount, status)
SELECT
  user_id,
  cached,
  pre_anchor_ledger_net,
  GREATEST(0, cached - GREATEST(0, pre_anchor_ledger_net)) AS phantom_amount,
  'pending_review'
FROM anchored
ON CONFLICT (user_id) DO NOTHING;

-- ============================================================
-- PART 5: CFO action RPCs - release / writedown
-- ============================================================
CREATE OR REPLACE FUNCTION public.release_historical_drift(
  p_review_id uuid,
  p_amount numeric,
  p_reason text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _row public.wallet_historical_drift_review%ROWTYPE;
  _ledger_id uuid;
BEGIN
  IF NOT (public.has_role(auth.uid(), 'cfo'::app_role)
          OR public.has_role(auth.uid(), 'manager'::app_role)) THEN
    RAISE EXCEPTION 'Only CFO or manager may release historical drift';
  END IF;

  IF p_reason IS NULL OR length(trim(p_reason)) < 10 THEN
    RAISE EXCEPTION 'Reason must be at least 10 characters';
  END IF;

  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Amount must be positive';
  END IF;

  SELECT * INTO _row FROM public.wallet_historical_drift_review WHERE id = p_review_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Review row not found';
  END IF;

  IF _row.status <> 'pending_review' THEN
    RAISE EXCEPTION 'Review row already decided (status=%)', _row.status;
  END IF;

  IF p_amount > _row.phantom_amount THEN
    RAISE EXCEPTION 'Release amount % exceeds phantom amount %', p_amount, _row.phantom_amount;
  END IF;

  -- Balanced admin_correction pair: wallet leg credits the user post-anchor,
  -- platform leg debits the corresponding control account.
  _ledger_id := public.create_ledger_transaction(
    p_classification := 'admin_correction',
    p_category := 'system_balance_correction',
    p_entries := jsonb_build_array(
      jsonb_build_object(
        'user_id', _row.user_id,
        'ledger_scope', 'wallet',
        'direction', 'cash_in',
        'amount', p_amount,
        'description', 'CFO historical drift release: ' || p_reason
      ),
      jsonb_build_object(
        'user_id', NULL,
        'ledger_scope', 'platform',
        'direction', 'cash_out',
        'amount', p_amount,
        'description', 'CFO historical drift release: ' || p_reason
      )
    )
  );

  UPDATE public.wallet_historical_drift_review
     SET status = 'approved_release',
         cfo_decision = p_reason,
         cfo_actor = auth.uid(),
         decided_at = now(),
         correction_ledger_id = _ledger_id
   WHERE id = p_review_id;

  INSERT INTO public.audit_logs (action_type, table_name, record_id, actor_id, reason, metadata)
  VALUES (
    'historical_drift_release',
    'wallet_historical_drift_review',
    p_review_id,
    auth.uid(),
    p_reason,
    jsonb_build_object('user_id', _row.user_id, 'amount', p_amount, 'ledger_id', _ledger_id)
  );

  RETURN _ledger_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.writedown_historical_drift(
  p_review_id uuid,
  p_amount numeric,
  p_reason text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _row public.wallet_historical_drift_review%ROWTYPE;
  _ledger_id uuid;
BEGIN
  IF NOT (public.has_role(auth.uid(), 'cfo'::app_role)
          OR public.has_role(auth.uid(), 'manager'::app_role)) THEN
    RAISE EXCEPTION 'Only CFO or manager may write down historical drift';
  END IF;

  IF p_reason IS NULL OR length(trim(p_reason)) < 10 THEN
    RAISE EXCEPTION 'Reason must be at least 10 characters';
  END IF;

  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Amount must be positive';
  END IF;

  SELECT * INTO _row FROM public.wallet_historical_drift_review WHERE id = p_review_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Review row not found';
  END IF;

  IF _row.status <> 'pending_review' THEN
    RAISE EXCEPTION 'Review row already decided (status=%)', _row.status;
  END IF;

  IF p_amount > _row.cached_withdrawable THEN
    RAISE EXCEPTION 'Write-down amount % exceeds cached balance %', p_amount, _row.cached_withdrawable;
  END IF;

  -- Balanced admin_correction: wallet leg debits the user; platform leg credits
  -- the offset (recognizing the previously-phantom amount as no longer owed).
  _ledger_id := public.create_ledger_transaction(
    p_classification := 'admin_correction',
    p_category := 'system_balance_correction',
    p_entries := jsonb_build_array(
      jsonb_build_object(
        'user_id', _row.user_id,
        'ledger_scope', 'wallet',
        'direction', 'cash_out',
        'amount', p_amount,
        'description', 'CFO historical drift write-down: ' || p_reason
      ),
      jsonb_build_object(
        'user_id', NULL,
        'ledger_scope', 'platform',
        'direction', 'cash_in',
        'amount', p_amount,
        'description', 'CFO historical drift write-down: ' || p_reason
      )
    )
  );

  UPDATE public.wallet_historical_drift_review
     SET status = 'approved_writedown',
         cfo_decision = p_reason,
         cfo_actor = auth.uid(),
         decided_at = now(),
         correction_ledger_id = _ledger_id
   WHERE id = p_review_id;

  INSERT INTO public.audit_logs (action_type, table_name, record_id, actor_id, reason, metadata)
  VALUES (
    'historical_drift_writedown',
    'wallet_historical_drift_review',
    p_review_id,
    auth.uid(),
    p_reason,
    jsonb_build_object('user_id', _row.user_id, 'amount', p_amount, 'ledger_id', _ledger_id)
  );

  RETURN _ledger_id;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.release_historical_drift(uuid, numeric, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.writedown_historical_drift(uuid, numeric, text) TO authenticated;