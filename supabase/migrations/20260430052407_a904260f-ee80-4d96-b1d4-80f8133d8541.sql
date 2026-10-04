-- Diagnostic view: anchored agents whose cached withdrawable bucket
-- exceeds the strict ledger-true available balance (= reseed candidates).
CREATE OR REPLACE VIEW public.wallet_anchored_drift_view
WITH (security_invoker = on) AS
SELECT
  a.user_id,
  p.full_name,
  p.phone,
  w.withdrawable_balance       AS cached_withdrawable,
  w.float_balance              AS cached_float,
  w.balance                    AS cached_total,
  public.get_user_available_balance(a.user_id) AS strict_available,
  GREATEST(
    0,
    COALESCE(w.withdrawable_balance, 0)
    - public.get_user_available_balance(a.user_id)
  )                            AS over_cache_delta,
  a.anchor_at,
  a.pre_anchor_ledger_net,
  a.reason                     AS anchor_reason
FROM public.wallet_fresh_start_anchors a
JOIN public.wallets  w ON w.user_id = a.user_id
LEFT JOIN public.profiles p ON p.id = a.user_id
WHERE COALESCE(w.withdrawable_balance, 0)
      - public.get_user_available_balance(a.user_id) >= 1000;

GRANT SELECT ON public.wallet_anchored_drift_view TO authenticated;

CREATE OR REPLACE FUNCTION public.reseed_anchored_withdrawable(
  p_user_id uuid,
  p_reason  text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor          uuid := auth.uid();
  v_is_authorized  boolean;
  v_cached         numeric;
  v_strict         numeric;
  v_delta          numeric;
  v_anchor_exists  boolean;
  v_review_id      uuid;
  v_txn_group      uuid := gen_random_uuid();
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) < 10 THEN
    RAISE EXCEPTION 'Reason must be at least 10 characters';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = v_actor
      AND role IN ('cfo','super_admin')
  ) INTO v_is_authorized;

  IF NOT v_is_authorized THEN
    RAISE EXCEPTION 'Forbidden: CFO or super_admin only';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.wallet_fresh_start_anchors WHERE user_id = p_user_id
  ) INTO v_anchor_exists;

  IF NOT v_anchor_exists THEN
    RAISE EXCEPTION 'No fresh-start anchor for user %', p_user_id;
  END IF;

  SELECT COALESCE(withdrawable_balance, 0)
    INTO v_cached
    FROM public.wallets WHERE user_id = p_user_id;

  v_strict := public.get_user_available_balance(p_user_id);
  v_delta  := GREATEST(0, v_cached - v_strict);

  IF v_delta < 1 THEN
    RETURN jsonb_build_object(
      'ok', true,
      'no_op', true,
      'cached_withdrawable', v_cached,
      'strict_available',    v_strict
    );
  END IF;

  INSERT INTO public.wallet_historical_drift_review (
    user_id, cached_withdrawable, pre_anchor_ledger_net,
    phantom_amount, status
  )
  SELECT p_user_id, v_cached, a.pre_anchor_ledger_net, v_delta, 'pending_decision'
    FROM public.wallet_fresh_start_anchors a
   WHERE a.user_id = p_user_id
  RETURNING id INTO v_review_id;

  PERFORM public.create_ledger_transaction(
    p_transaction_group_id => v_txn_group,
    p_entries => jsonb_build_array(
      jsonb_build_object(
        'user_id',      p_user_id,
        'amount',       v_delta,
        'direction',    'cash_out',
        'category',     'system_balance_correction',
        'ledger_scope', 'wallet',
        'classification','admin_correction',
        'description',  'Anchored cache reseed: ' || p_reason,
        'reference_id', 'reseed_' || v_review_id::text
      ),
      jsonb_build_object(
        'user_id',      NULL,
        'amount',       v_delta,
        'direction',    'cash_in',
        'category',     'phantom_writedown_clearing',
        'ledger_scope', 'platform',
        'classification','admin_correction',
        'description',  'Phantom withdrawable cleared during reseed for ' || p_user_id::text,
        'reference_id', 'reseed_' || v_review_id::text
      )
    )
  );

  UPDATE public.wallet_historical_drift_review
     SET status        = 'reseed_posted',
         decided_at    = now(),
         cfo_actor     = v_actor,
         cfo_decision  = 'reseed_to_strict'
   WHERE id = v_review_id;

  RETURN jsonb_build_object(
    'ok', true,
    'review_id',          v_review_id,
    'cached_withdrawable',v_cached,
    'strict_available',   v_strict,
    'delta_cleared',      v_delta
  );
END
$$;

REVOKE ALL ON FUNCTION public.reseed_anchored_withdrawable(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reseed_anchored_withdrawable(uuid, text) TO authenticated;