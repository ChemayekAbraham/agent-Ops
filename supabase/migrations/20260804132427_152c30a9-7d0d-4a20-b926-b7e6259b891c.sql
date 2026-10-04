-- ============================================================
-- Stale withdrawal hold reconciliation
-- ============================================================

CREATE TABLE public.withdrawal_hold_reconciliation_config (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stale_after_days integer NOT NULL DEFAULT 14,
  critical_after_days integer NOT NULL DEFAULT 30,
  auto_release_pre_anchor_holds boolean NOT NULL DEFAULT true,
  enabled boolean NOT NULL DEFAULT true,
  updated_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.withdrawal_hold_reconciliation_config TO authenticated;
GRANT ALL ON public.withdrawal_hold_reconciliation_config TO service_role;
ALTER TABLE public.withdrawal_hold_reconciliation_config ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Finance leadership reads hold config"
  ON public.withdrawal_hold_reconciliation_config FOR SELECT TO authenticated
  USING (
    public.has_role(auth.uid(), 'cfo') OR public.has_role(auth.uid(), 'ceo')
    OR public.has_role(auth.uid(), 'manager') OR public.has_role(auth.uid(), 'super_admin')
    OR public.has_role(auth.uid(), 'financial_ops')
  );

CREATE POLICY "CFO updates hold config"
  ON public.withdrawal_hold_reconciliation_config FOR UPDATE TO authenticated
  USING (public.has_role(auth.uid(), 'cfo') OR public.has_role(auth.uid(), 'super_admin'))
  WITH CHECK (public.has_role(auth.uid(), 'cfo') OR public.has_role(auth.uid(), 'super_admin'));

INSERT INTO public.withdrawal_hold_reconciliation_config (stale_after_days, critical_after_days)
VALUES (14, 30);

-- ------------------------------------------------------------
-- Decision register (one row per reconciled withdrawal)
-- ------------------------------------------------------------
CREATE TABLE public.withdrawal_hold_reconciliations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  withdrawal_id uuid NOT NULL,
  hold_user_id uuid NOT NULL,
  amount numeric NOT NULL,
  action text NOT NULL,
  reason text NOT NULL,
  payment_reference text,
  ledger_group_id uuid,
  previous_status text,
  new_status text,
  withdrawable_before numeric,
  withdrawable_after numeric,
  decided_by uuid,
  decided_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX withdrawal_hold_reconciliations_wr_uniq
  ON public.withdrawal_hold_reconciliations (withdrawal_id);

GRANT SELECT ON public.withdrawal_hold_reconciliations TO authenticated;
GRANT ALL ON public.withdrawal_hold_reconciliations TO service_role;
ALTER TABLE public.withdrawal_hold_reconciliations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Finance leadership reads hold reconciliations"
  ON public.withdrawal_hold_reconciliations FOR SELECT TO authenticated
  USING (
    public.has_role(auth.uid(), 'cfo') OR public.has_role(auth.uid(), 'ceo')
    OR public.has_role(auth.uid(), 'manager') OR public.has_role(auth.uid(), 'super_admin')
    OR public.has_role(auth.uid(), 'financial_ops')
    OR hold_user_id = auth.uid()
  );

-- ------------------------------------------------------------
-- Alerts
-- ------------------------------------------------------------
CREATE TABLE public.withdrawal_hold_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  withdrawal_id uuid NOT NULL,
  hold_user_id uuid,
  amount numeric NOT NULL DEFAULT 0,
  age_days integer NOT NULL DEFAULT 0,
  alert_type text NOT NULL,
  severity text NOT NULL DEFAULT 'medium',
  status text NOT NULL DEFAULT 'open',
  withdrawal_status text,
  detected_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  acknowledged_by uuid,
  acknowledged_at timestamptz,
  resolved_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX withdrawal_hold_alerts_uniq
  ON public.withdrawal_hold_alerts (withdrawal_id, alert_type);

GRANT SELECT ON public.withdrawal_hold_alerts TO authenticated;
GRANT ALL ON public.withdrawal_hold_alerts TO service_role;
ALTER TABLE public.withdrawal_hold_alerts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Finance leadership reads hold alerts"
  ON public.withdrawal_hold_alerts FOR SELECT TO authenticated
  USING (
    public.has_role(auth.uid(), 'cfo') OR public.has_role(auth.uid(), 'ceo')
    OR public.has_role(auth.uid(), 'manager') OR public.has_role(auth.uid(), 'super_admin')
    OR public.has_role(auth.uid(), 'financial_ops')
  );

CREATE TRIGGER trg_withdrawal_hold_alerts_updated_at
  BEFORE UPDATE ON public.withdrawal_hold_alerts
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER trg_withdrawal_hold_config_updated_at
  BEFORE UPDATE ON public.withdrawal_hold_reconciliation_config
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ------------------------------------------------------------
-- Access helper
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_withdrawal_hold_reviewer(_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.has_role(_user_id, 'cfo')
      OR public.has_role(_user_id, 'ceo')
      OR public.has_role(_user_id, 'manager')
      OR public.has_role(_user_id, 'super_admin')
      OR public.has_role(_user_id, 'financial_ops')
$$;

-- ------------------------------------------------------------
-- Detection view: every hold-bearing withdrawal with no wallet debit
-- ------------------------------------------------------------
CREATE OR REPLACE VIEW public.v_withdrawal_holds_unbacked AS
SELECT
  wr.id                                        AS withdrawal_id,
  CASE WHEN wr.proxy_partner_id IS NOT NULL AND wr.agent_id IS NOT NULL
       THEN wr.agent_id ELSE wr.user_id END    AS hold_user_id,
  wr.user_id                                   AS requested_by,
  wr.amount,
  wr.status,
  wr.created_at,
  wr.updated_at,
  FLOOR(EXTRACT(EPOCH FROM (now() - wr.created_at)) / 86400)::integer AS age_days,
  wr.mobile_money_number,
  wr.mobile_money_provider,
  wr.mobile_money_name,
  wr.transaction_id,
  wr.fin_ops_reference,
  wr.payout_method,
  wr.reason,
  wr.proxy_partner_id,
  wr.agent_id,
  a.anchor_at,
  (a.anchor_at IS NOT NULL AND wr.created_at < a.anchor_at) AS is_pre_anchor
FROM public.withdrawal_requests wr
LEFT JOIN public.wallet_fresh_start_anchors a
  ON a.user_id = CASE WHEN wr.proxy_partner_id IS NOT NULL AND wr.agent_id IS NOT NULL
                      THEN wr.agent_id ELSE wr.user_id END
WHERE wr.status IN ('pending','requested','manager_approved','processing','approved')
  AND (wr.reason IS NULL OR wr.reason NOT LIKE 'Landlord float payout%')
  AND NOT EXISTS (
    SELECT 1 FROM public.general_ledger g
    WHERE g.source_table = 'withdrawal_requests'
      AND g.source_id = wr.id
      AND g.ledger_scope = 'wallet'
      AND g.direction IN ('cash_out','debit')
  );

REVOKE ALL ON public.v_withdrawal_holds_unbacked FROM anon, authenticated;

-- ------------------------------------------------------------
-- CFO review queue (report only, never mutates)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_stale_withdrawal_hold_queue(p_min_age_days integer DEFAULT NULL)
RETURNS TABLE (
  withdrawal_id uuid,
  hold_user_id uuid,
  full_name text,
  phone text,
  amount numeric,
  status text,
  created_at timestamptz,
  age_days integer,
  ledger_debit_exists boolean,
  wallet_withdrawable numeric,
  wallet_pending_holds numeric,
  mobile_money_number text,
  mobile_money_provider text,
  mobile_money_name text,
  payment_reference text,
  mobile_money_reference text,
  is_pre_anchor boolean,
  anchor_at timestamptz,
  severity text,
  recommendation text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_stale integer;
  v_critical integer;
  v_min integer;
BEGIN
  IF NOT public.is_withdrawal_hold_reviewer(auth.uid()) THEN
    RAISE EXCEPTION 'Not authorized to review withdrawal holds';
  END IF;

  SELECT c.stale_after_days, c.critical_after_days
    INTO v_stale, v_critical
  FROM public.withdrawal_hold_reconciliation_config c
  ORDER BY c.created_at LIMIT 1;

  v_stale := COALESCE(v_stale, 14);
  v_critical := COALESCE(v_critical, 30);
  v_min := COALESCE(p_min_age_days, v_stale);

  RETURN QUERY
  SELECT
    h.withdrawal_id,
    h.hold_user_id,
    p.full_name,
    p.phone,
    h.amount,
    h.status,
    h.created_at,
    h.age_days,
    false AS ledger_debit_exists,
    COALESCE(w.withdrawable, 0) AS wallet_withdrawable,
    COALESCE(w.pending_holds, 0) AS wallet_pending_holds,
    h.mobile_money_number,
    h.mobile_money_provider,
    h.mobile_money_name,
    h.fin_ops_reference AS payment_reference,
    h.transaction_id AS mobile_money_reference,
    h.is_pre_anchor,
    h.anchor_at,
    CASE
      WHEN h.is_pre_anchor THEN 'critical'
      WHEN h.age_days >= v_critical THEN 'high'
      ELSE 'medium'
    END AS severity,
    CASE
      WHEN h.is_pre_anchor
        THEN 'Cancel and release — hold predates the wallet fresh-start anchor, so it can never be settled from current ledger history.'
      WHEN h.transaction_id IS NOT NULL OR h.fin_ops_reference IS NOT NULL
        THEN 'Verify the payment reference. If the payout truly reached the customer, post the missing wallet debit and complete it. Otherwise cancel and release.'
      ELSE 'No payment reference on record. Most likely the payout never left. Confirm with FinOps, then cancel and release the hold.'
    END AS recommendation
  FROM public.v_withdrawal_holds_unbacked h
  LEFT JOIN public.profiles p ON p.id = h.hold_user_id
  LEFT JOIN public.wallet_balances_projection w ON w.user_id = h.hold_user_id
  WHERE h.age_days >= v_min
    AND NOT EXISTS (
      SELECT 1 FROM public.withdrawal_hold_reconciliations r
      WHERE r.withdrawal_id = h.withdrawal_id
    )
  ORDER BY h.is_pre_anchor DESC, h.age_days DESC, h.amount DESC;
END;
$$;

REVOKE ALL ON FUNCTION public.get_stale_withdrawal_hold_queue(integer) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_stale_withdrawal_hold_queue(integer) TO authenticated;

-- ------------------------------------------------------------
-- Per-request reconciliation (one withdrawal per call, never bulk)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.cfo_reconcile_stale_withdrawal(
  p_withdrawal_id uuid,
  p_action text,
  p_reason text,
  p_payment_reference text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_wr public.withdrawal_requests;
  v_hold_user uuid;
  v_before numeric;
  v_after numeric;
  v_group uuid;
  v_new_status text;
  v_actor uuid := auth.uid();
BEGIN
  IF NOT public.is_withdrawal_hold_reviewer(v_actor) THEN
    RAISE EXCEPTION 'Not authorized to reconcile withdrawal holds';
  END IF;

  IF p_action NOT IN ('settle','cancel') THEN
    RAISE EXCEPTION 'Invalid action: expected settle or cancel';
  END IF;

  IF p_reason IS NULL OR length(btrim(p_reason)) < 10 THEN
    RAISE EXCEPTION 'A written reason of at least 10 characters is required';
  END IF;

  SELECT * INTO v_wr FROM public.withdrawal_requests WHERE id = p_withdrawal_id FOR UPDATE;
  IF v_wr.id IS NULL THEN
    RAISE EXCEPTION 'Withdrawal request not found';
  END IF;

  IF v_wr.status NOT IN ('pending','requested','manager_approved','processing','approved') THEN
    RAISE EXCEPTION 'Withdrawal is % and no longer holds balance', v_wr.status;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.general_ledger g
    WHERE g.source_table = 'withdrawal_requests' AND g.source_id = v_wr.id
      AND g.ledger_scope = 'wallet' AND g.direction IN ('cash_out','debit')
  ) THEN
    RAISE EXCEPTION 'This withdrawal already has a wallet debit — nothing to reconcile';
  END IF;

  IF EXISTS (SELECT 1 FROM public.withdrawal_hold_reconciliations WHERE withdrawal_id = v_wr.id) THEN
    RAISE EXCEPTION 'This withdrawal has already been reconciled';
  END IF;

  v_hold_user := CASE WHEN v_wr.proxy_partner_id IS NOT NULL AND v_wr.agent_id IS NOT NULL
                      THEN v_wr.agent_id ELSE v_wr.user_id END;

  SELECT COALESCE(withdrawable, 0) INTO v_before
  FROM public.wallet_balances_projection WHERE user_id = v_hold_user;

  IF p_action = 'settle' THEN
    -- The payout genuinely happened: post the missing double-entry through the
    -- normal ledger engine. No wallet field is touched directly.
    v_group := public.create_ledger_transaction(
      entries := jsonb_build_array(
        jsonb_build_object(
          'user_id', v_hold_user,
          'amount', v_wr.amount,
          'direction', 'cash_out',
          'category', 'wallet_withdrawal',
          'ledger_scope', 'wallet',
          'wallet_bucket', 'withdrawable',
          'recipient_type', 'user',
          'currency', 'UGX',
          'source_table', 'withdrawal_requests',
          'source_id', v_wr.id,
          'transaction_date', now(),
          'description', 'Backdated wallet debit for reconciled withdrawal ' || v_wr.id::text,
          'metadata', jsonb_build_object(
            'reconciliation', 'stale_withdrawal_hold',
            'payment_reference', p_payment_reference,
            'decided_by', v_actor
          )
        ),
        jsonb_build_object(
          'amount', v_wr.amount,
          'direction', 'cash_in',
          'category', 'wallet_withdrawal',
          'ledger_scope', 'platform',
          'currency', 'UGX',
          'source_table', 'withdrawal_requests',
          'source_id', v_wr.id,
          'transaction_date', now(),
          'description', 'Platform records reconciled withdrawal payout ' || v_wr.id::text
        )
      ),
      idempotency_key := 'stale-hold-settle-' || v_wr.id::text,
      skip_balance_check := true
    );

    v_new_status := 'completed';
    UPDATE public.withdrawal_requests
       SET status = 'completed',
           processed_at = COALESCE(processed_at, now()),
           processed_by = COALESCE(processed_by, v_actor),
           fin_ops_reference = COALESCE(p_payment_reference, fin_ops_reference)
     WHERE id = v_wr.id;
  ELSE
    v_new_status := 'cancelled';
    UPDATE public.withdrawal_requests
       SET status = 'cancelled',
           rejection_reason = 'Hold reconciliation: ' || btrim(p_reason),
           processed_at = COALESCE(processed_at, now()),
           processed_by = COALESCE(processed_by, v_actor)
     WHERE id = v_wr.id;
  END IF;

  PERFORM public.refresh_wallet_projection_for(v_hold_user);

  SELECT COALESCE(withdrawable, 0) INTO v_after
  FROM public.wallet_balances_projection WHERE user_id = v_hold_user;

  INSERT INTO public.withdrawal_hold_reconciliations (
    withdrawal_id, hold_user_id, amount, action, reason, payment_reference,
    ledger_group_id, previous_status, new_status,
    withdrawable_before, withdrawable_after, decided_by, metadata
  ) VALUES (
    v_wr.id, v_hold_user, v_wr.amount,
    CASE WHEN p_action = 'settle' THEN 'settled' ELSE 'cancelled' END,
    btrim(p_reason), p_payment_reference, v_group, v_wr.status, v_new_status,
    v_before, v_after, v_actor,
    jsonb_build_object('mobile_money_number', v_wr.mobile_money_number,
                       'mobile_money_reference', v_wr.transaction_id)
  );

  UPDATE public.withdrawal_hold_alerts
     SET status = 'resolved', resolved_at = now()
   WHERE withdrawal_id = v_wr.id AND status <> 'resolved';

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, metadata)
  VALUES (
    v_actor,
    CASE WHEN p_action = 'settle' THEN 'WITHDRAWAL_HOLD_SETTLED' ELSE 'WITHDRAWAL_HOLD_CANCELLED' END,
    'withdrawal_requests',
    v_wr.id::text,
    jsonb_build_object(
      'reason', btrim(p_reason),
      'amount', v_wr.amount,
      'hold_user_id', v_hold_user,
      'previous_status', v_wr.status,
      'new_status', v_new_status,
      'payment_reference', p_payment_reference,
      'ledger_group_id', v_group,
      'withdrawable_before', v_before,
      'withdrawable_after', v_after
    )
  );

  BEGIN
    INSERT INTO public.system_events (event_type, user_id, metadata)
    VALUES ('withdrawal_approved', v_hold_user,
            jsonb_build_object('kind', 'withdrawal_hold_reconciled',
                               'action', p_action,
                               'withdrawal_id', v_wr.id,
                               'amount', v_wr.amount));
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  RETURN jsonb_build_object(
    'success', true,
    'withdrawal_id', v_wr.id,
    'action', p_action,
    'new_status', v_new_status,
    'ledger_group_id', v_group,
    'withdrawable_before', v_before,
    'withdrawable_after', v_after
  );
END;
$$;

REVOKE ALL ON FUNCTION public.cfo_reconcile_stale_withdrawal(uuid, text, text, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.cfo_reconcile_stale_withdrawal(uuid, text, text, text) TO authenticated;

-- ------------------------------------------------------------
-- Detector: refresh alerts, auto-release pre-anchor holds
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.detect_stale_withdrawal_holds()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_stale integer;
  v_critical integer;
  v_auto boolean;
  v_enabled boolean;
  v_stale_count integer := 0;
  v_orphan_count integer := 0;
  v_released integer := 0;
  r record;
BEGIN
  SELECT stale_after_days, critical_after_days, auto_release_pre_anchor_holds, enabled
    INTO v_stale, v_critical, v_auto, v_enabled
  FROM public.withdrawal_hold_reconciliation_config
  ORDER BY created_at LIMIT 1;

  v_stale := COALESCE(v_stale, 14);
  v_critical := COALESCE(v_critical, 30);
  v_auto := COALESCE(v_auto, true);
  IF COALESCE(v_enabled, true) = false THEN
    RETURN jsonb_build_object('success', true, 'skipped', 'disabled');
  END IF;

  -- 1. Stale holds still suppressing balance
  INSERT INTO public.withdrawal_hold_alerts (
    withdrawal_id, hold_user_id, amount, age_days, alert_type, severity,
    withdrawal_status, metadata
  )
  SELECT h.withdrawal_id, h.hold_user_id, h.amount, h.age_days,
         CASE WHEN h.is_pre_anchor THEN 'pre_anchor_hold' ELSE 'stale_hold' END,
         CASE WHEN h.is_pre_anchor THEN 'critical'
              WHEN h.age_days >= v_critical THEN 'high' ELSE 'medium' END,
         h.status,
         jsonb_build_object('anchor_at', h.anchor_at, 'created_at', h.created_at)
  FROM public.v_withdrawal_holds_unbacked h
  WHERE h.age_days >= v_stale
  ON CONFLICT (withdrawal_id, alert_type) DO UPDATE
    SET age_days = EXCLUDED.age_days,
        severity = EXCLUDED.severity,
        withdrawal_status = EXCLUDED.withdrawal_status,
        last_seen_at = now();
  v_stale_count := COALESCE((SELECT count(*) FROM public.v_withdrawal_holds_unbacked WHERE age_days >= v_stale), 0);

  -- 2. Completed withdrawals with no wallet debit -> immediate critical alert
  INSERT INTO public.withdrawal_hold_alerts (
    withdrawal_id, hold_user_id, amount, age_days, alert_type, severity,
    withdrawal_status, metadata
  )
  SELECT wr.id,
         CASE WHEN wr.proxy_partner_id IS NOT NULL AND wr.agent_id IS NOT NULL
              THEN wr.agent_id ELSE wr.user_id END,
         wr.amount,
         FLOOR(EXTRACT(EPOCH FROM (now() - wr.created_at)) / 86400)::integer,
         'completed_without_debit', 'critical', wr.status,
         jsonb_build_object('processed_at', wr.processed_at)
  FROM public.withdrawal_requests wr
  WHERE wr.status = 'completed'
    AND wr.created_at >= now() - interval '90 days'
    AND (wr.reason IS NULL OR wr.reason NOT LIKE 'Landlord float payout%')
    AND NOT EXISTS (
      SELECT 1 FROM public.general_ledger g
      WHERE g.source_table = 'withdrawal_requests' AND g.source_id = wr.id
        AND g.ledger_scope = 'wallet' AND g.direction IN ('cash_out','debit')
    )
  ON CONFLICT (withdrawal_id, alert_type) DO UPDATE
    SET last_seen_at = now(), age_days = EXCLUDED.age_days;

  SELECT count(*) INTO v_orphan_count
  FROM public.withdrawal_hold_alerts
  WHERE alert_type = 'completed_without_debit' AND status = 'open';

  -- 3. Pre-anchor holds can never settle from current ledger history:
  --    release them so they stop suppressing balances indefinitely.
  IF v_auto THEN
    FOR r IN
      SELECT h.* FROM public.v_withdrawal_holds_unbacked h
      WHERE h.is_pre_anchor
        AND h.age_days >= v_critical
        AND NOT EXISTS (
          SELECT 1 FROM public.withdrawal_hold_reconciliations rr
          WHERE rr.withdrawal_id = h.withdrawal_id
        )
    LOOP
      UPDATE public.withdrawal_requests
         SET status = 'cancelled',
             rejection_reason = 'Auto-released: hold predates wallet fresh-start anchor and has no wallet debit'
       WHERE id = r.withdrawal_id;

      PERFORM public.refresh_wallet_projection_for(r.hold_user_id);

      INSERT INTO public.withdrawal_hold_reconciliations (
        withdrawal_id, hold_user_id, amount, action, reason,
        previous_status, new_status, decided_by, metadata
      ) VALUES (
        r.withdrawal_id, r.hold_user_id, r.amount, 'auto_released_pre_anchor',
        'Automatically released: hold predates the wallet fresh-start anchor and carries no wallet debit leg.',
        r.status, 'cancelled', NULL,
        jsonb_build_object('anchor_at', r.anchor_at, 'age_days', r.age_days)
      );

      INSERT INTO public.audit_logs (action_type, table_name, record_id, metadata)
      VALUES ('WITHDRAWAL_HOLD_AUTO_RELEASED', 'withdrawal_requests', r.withdrawal_id::text,
              jsonb_build_object(
                'reason', 'Pre-anchor hold with no wallet debit released by reconciliation job',
                'hold_user_id', r.hold_user_id,
                'amount', r.amount,
                'anchor_at', r.anchor_at));

      UPDATE public.withdrawal_hold_alerts
         SET status = 'resolved', resolved_at = now()
       WHERE withdrawal_id = r.withdrawal_id AND status <> 'resolved';

      v_released := v_released + 1;
    END LOOP;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'stale_holds', v_stale_count,
    'completed_without_debit', v_orphan_count,
    'pre_anchor_released', v_released,
    'ran_at', now()
  );
END;
$$;

REVOKE ALL ON FUNCTION public.detect_stale_withdrawal_holds() FROM anon, authenticated;

SELECT cron.schedule(
  'detect-stale-withdrawal-holds',
  '17 */6 * * *',
  $$SELECT public.detect_stale_withdrawal_holds();$$
);
