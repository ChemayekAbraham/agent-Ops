CREATE OR REPLACE FUNCTION public.wallet_strict_for_user(p_user_id uuid)
RETURNS TABLE (
  user_id uuid,
  withdrawable numeric,
  float_balance numeric,
  advance_balance numeric,
  pending_holds numeric,
  restricted_held numeric,
  total_visible numeric,
  float_balance_signed numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  WITH anchor AS (
    SELECT a.anchor_at FROM public.wallet_fresh_start_anchors a
    WHERE a.user_id = p_user_id LIMIT 1
  ), ledger AS (
    SELECT gl.category, gl.direction, gl.amount, gl.wallet_bucket,
           gl.maturity_met, gl.maturity_expired, gl.withdrawable_after
    FROM public.general_ledger gl
    LEFT JOIN anchor a ON true
    WHERE gl.user_id = p_user_id
      AND gl.ledger_scope = 'wallet'
      AND (
        gl.classification IS NULL
        OR gl.classification = 'production'
        OR (gl.classification = 'admin_correction'
            AND gl.category = 'system_balance_correction'
            AND gl.direction = ANY (ARRAY['debit','cash_out']))
        OR (gl.classification = 'admin_correction'
            AND gl.category = 'merchant_float_correction_writedown'
            AND gl.direction = ANY (ARRAY['debit','cash_out']))
      )
      AND (a.anchor_at IS NULL OR gl.created_at >= a.anchor_at)
      AND NOT (
        gl.source_table = 'commission_engine'
        AND EXISTS (
          SELECT 1 FROM public.commission_accrual_ledger cal
          WHERE cal.agent_id = p_user_id
            AND cal.event_type = 'rent_funded_landlord_float'
            AND cal.status = 'reversed'
            AND cal.source_id = gl.source_id::text
        )
      )
      AND NOT (
        gl.source_table = 'commission_engine_reversal'
        AND gl.classification = 'admin_correction'
        AND gl.category = 'system_balance_correction'
        AND gl.amount = 10000::numeric
        AND EXISTS (
          SELECT 1 FROM public.commission_accrual_ledger cal
          WHERE cal.agent_id = p_user_id
            AND cal.event_type = 'rent_funded_landlord_float'
            AND cal.status = 'reversed'
        )
      )
  ), routed AS (
    SELECT l.amount, l.wallet_bucket AS bucket,
           CASE WHEN l.direction = ANY (ARRAY['cash_in','credit']) THEN 1
                WHEN l.direction = ANY (ARRAY['cash_out','debit']) THEN -1
                ELSE 0 END AS sign,
           l.maturity_met, l.maturity_expired, l.withdrawable_after, l.direction
    FROM ledger l
    WHERE l.wallet_bucket = ANY (ARRAY['withdrawable','float','advance_credit','advance_repayment'])
    UNION ALL
    SELECT l.amount, r.bucket, r.sign,
           l.maturity_met, l.maturity_expired, l.withdrawable_after, l.direction
    FROM ledger l
    CROSS JOIN LATERAL public.wallet_route_for_category(p_user_id, l.category, l.direction) AS r(bucket, sign)
    WHERE l.wallet_bucket IS NULL
  ), buckets AS (
    SELECT
      COALESCE(SUM(CASE WHEN bucket = 'withdrawable' THEN sign::numeric * amount ELSE 0 END), 0) AS withdrawable_raw,
      COALESCE(SUM(CASE WHEN bucket = 'float' THEN sign::numeric * amount ELSE 0 END), 0) AS float_raw,
      COALESCE(SUM(CASE WHEN bucket = ANY (ARRAY['advance_credit','advance_repayment']) THEN sign::numeric * amount ELSE 0 END), 0) AS advance_raw,
      COALESCE(SUM(CASE
        WHEN bucket = 'withdrawable'
         AND direction = ANY (ARRAY['cash_in','credit'])
         AND (maturity_expired = true OR (maturity_met = false AND now() <= COALESCE(withdrawable_after, now())))
        THEN amount ELSE 0 END), 0) AS restricted_held
    FROM routed
  ), holds AS (
    SELECT COALESCE(SUM(wr.amount), 0) AS pending_holds
    FROM public.withdrawal_requests wr
    WHERE (CASE WHEN wr.proxy_partner_id IS NOT NULL AND wr.agent_id IS NOT NULL THEN wr.agent_id ELSE wr.user_id END) = p_user_id
      AND wr.status = ANY (ARRAY['pending','requested','manager_approved','processing','approved'])
      AND (wr.reason IS NULL OR wr.reason NOT LIKE 'Landlord float payout%')
      AND NOT EXISTS (
        SELECT 1 FROM public.general_ledger g
        WHERE g.source_table = 'withdrawal_requests'
          AND g.source_id = wr.id
          AND g.ledger_scope = 'wallet'
          AND g.direction = ANY (ARRAY['cash_out','debit'])
      )
  )
  SELECT
    p_user_id,
    GREATEST(0::numeric, b.withdrawable_raw - b.restricted_held - h.pending_holds),
    GREATEST(0::numeric, b.float_raw),
    GREATEST(0::numeric, b.advance_raw),
    h.pending_holds,
    b.restricted_held,
    GREATEST(0::numeric, b.withdrawable_raw - b.restricted_held - h.pending_holds) + GREATEST(0::numeric, b.float_raw),
    b.float_raw
  FROM buckets b CROSS JOIN holds h;
$function$;

GRANT EXECUTE ON FUNCTION public.wallet_strict_for_user(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.merchant_ledger_float(p_agent_id uuid)
 RETURNS numeric
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT COALESCE((SELECT s.float_balance FROM public.wallet_strict_for_user(p_agent_id) s), 0);
$function$;

CREATE OR REPLACE FUNCTION public.sync_merchant_desk_float_cache(p_desk_id uuid, p_reason text DEFAULT 'merchant float adjustment'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_agent uuid;
  v_cached numeric;
  v_ledger numeric;
BEGIN
  SELECT agent_id INTO v_agent FROM public.cashout_agents WHERE id = p_desk_id;
  IF v_agent IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'Merchant desk not found or has no linked agent');
  END IF;

  SELECT COALESCE(float_balance, 0) INTO v_cached FROM public.wallets WHERE user_id = v_agent;
  v_cached := COALESCE(v_cached, 0);

  SELECT GREATEST(COALESCE(s.float_balance, 0), 0) INTO v_ledger
    FROM public.wallet_strict_for_user(v_agent) s;
  v_ledger := COALESCE(v_ledger, 0);

  IF ABS(v_cached - v_ledger) < 1 THEN
    RETURN jsonb_build_object('ok', true, 'no_op', true,
      'agent_id', v_agent, 'float_before', v_cached, 'float_after', v_cached);
  END IF;

  PERFORM set_config('wallet.sync_authorized', 'true', true);
  UPDATE public.wallets
     SET float_balance = v_ledger,
         updated_at = now()
   WHERE user_id = v_agent;
  PERFORM set_config('wallet.sync_authorized', 'false', true);

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, metadata)
  VALUES (auth.uid(), 'merchant_float_cache_reseeded', 'wallets', v_agent,
          jsonb_build_object('desk_id', p_desk_id, 'float_before', v_cached,
                             'float_after', v_ledger, 'reason', p_reason));

  RETURN jsonb_build_object('ok', true, 'no_op', false, 'agent_id', v_agent,
                            'float_before', v_cached, 'float_after', v_ledger);
END;
$function$;

CREATE OR REPLACE FUNCTION public.repair_wallet_cache_for_user(p_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_strict record;
  v_before record;
BEGIN
  SELECT withdrawable, float_balance, advance_balance
    INTO v_strict
    FROM public.wallet_strict_for_user(p_user_id);

  IF v_strict IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_strict_row');
  END IF;

  SELECT COALESCE(withdrawable_balance,0) AS w,
         COALESCE(float_balance,0)         AS f,
         COALESCE(advance_balance,0)       AS a
    INTO v_before
    FROM public.wallets
   WHERE user_id = p_user_id
   FOR UPDATE;

  IF v_before IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'no_wallet_row'); END IF;

  IF v_before.w = COALESCE(v_strict.withdrawable,0)
 AND v_before.f = COALESCE(v_strict.float_balance,0)
 AND v_before.a = COALESCE(v_strict.advance_balance,0) THEN
    RETURN jsonb_build_object('ok', true, 'no_op', true);
  END IF;

  PERFORM set_config('wallet.sync_authorized', 'true', true);
  UPDATE public.wallets
     SET withdrawable_balance = COALESCE(v_strict.withdrawable, 0),
         float_balance        = COALESCE(v_strict.float_balance, 0),
         advance_balance      = COALESCE(v_strict.advance_balance, 0),
         balance              = COALESCE(v_strict.withdrawable, 0) + COALESCE(v_strict.float_balance, 0),
         updated_at           = now()
   WHERE user_id = p_user_id;
  PERFORM set_config('wallet.sync_authorized', 'false', true);

  RETURN jsonb_build_object(
    'ok', true,
    'before', to_jsonb(v_before),
    'after', jsonb_build_object(
      'w', v_strict.withdrawable, 'f', v_strict.float_balance, 'a', v_strict.advance_balance
    )
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.lift_withdrawable_to_ledger(p_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_strict numeric := 0;
  v_holds  numeric := 0;
BEGIN
  IF p_user_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'missing_user');
  END IF;

  SELECT COALESCE(withdrawable, 0), COALESCE(pending_holds, 0)
    INTO v_strict, v_holds
    FROM public.wallet_strict_for_user(p_user_id);

  RETURN jsonb_build_object(
    'ok', true,
    'no_op', true,
    'note', 'wallets is a ledger-derived view; no cache to lift',
    'strict_withdrawable', v_strict,
    'pending_holds', v_holds
  );
END;
$function$;