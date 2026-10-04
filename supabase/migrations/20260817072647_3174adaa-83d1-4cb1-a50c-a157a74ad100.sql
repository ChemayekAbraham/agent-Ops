-- 1) Reseed the merchant desk float cache to the ledger-derived float.
CREATE OR REPLACE FUNCTION public.sync_merchant_desk_float_cache(
  p_desk_id uuid,
  p_reason text DEFAULT 'merchant float adjustment'
)
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
    FROM public.v_user_wallet_strict s WHERE s.user_id = v_agent;
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

REVOKE ALL ON FUNCTION public.sync_merchant_desk_float_cache(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sync_merchant_desk_float_cache(uuid, text) TO authenticated, service_role;

-- 2) Starting-balance path: stop double-applying the wallet movement and
--    reseed the cache to the books, returning the real before/after figures.
CREATE OR REPLACE FUNCTION public.post_merchant_opening_float_ledger(p_desk_id uuid, p_agent_id uuid, p_amount numeric, p_reason text, p_evidence_note text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_recon_id uuid;
  v_group_id uuid;
  v_desk_agent uuid;
  v_float_before numeric;
  v_float_after numeric;
  v_sync jsonb;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF NOT (
    public.has_role(v_actor, 'cfo')
    OR public.has_role(v_actor, 'financial_ops')
    OR public.has_role(v_actor, 'manager')
    OR public.has_role(v_actor, 'super_admin')
  ) THEN
    RAISE EXCEPTION 'Only finance roles can post a ledger-backed float fix';
  END IF;

  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Amount must be greater than zero. Use CFO Direct Debit to reduce float.';
  END IF;

  IF char_length(btrim(coalesce(p_reason, ''))) < 10 THEN
    RAISE EXCEPTION 'A reason of at least 10 characters is required';
  END IF;

  SELECT agent_id INTO v_desk_agent FROM public.cashout_agents WHERE id = p_desk_id;
  IF v_desk_agent IS NULL THEN
    RAISE EXCEPTION 'Merchant desk not found or has no linked agent';
  END IF;
  IF p_agent_id IS NOT NULL AND p_agent_id <> v_desk_agent THEN
    RAISE EXCEPTION 'Agent does not match this merchant desk';
  END IF;

  SELECT COALESCE(float_balance, 0) INTO v_float_before FROM public.wallets WHERE user_id = v_desk_agent;
  v_float_before := COALESCE(v_float_before, 0);

  INSERT INTO public.merchant_float_reconciliations
    (desk_id, agent_id, adjustment_type, amount, reason, evidence_note, created_by, ledger_effect)
  VALUES
    (p_desk_id, v_desk_agent, 'opening_balance', round(p_amount), btrim(p_reason),
     nullif(btrim(coalesce(p_evidence_note, '')), ''), v_actor, 'ledger_posted')
  RETURNING id INTO v_recon_id;

  v_group_id := public.create_ledger_transaction(
    entries := jsonb_build_array(
      jsonb_build_object(
        'user_id', v_desk_agent,
        'amount', round(p_amount),
        'direction', 'cash_in',
        'category', 'agent_float_deposit',
        'ledger_scope', 'wallet',
        'wallet_bucket', 'float',
        'recipient_type', 'operational_wallet',
        'source_table', 'merchant_float_reconciliations',
        'source_id', v_recon_id,
        'description', format('Merchant float opening balance recognised on the books: %s', btrim(p_reason)),
        'currency', 'UGX',
        'transaction_date', now()
      ),
      jsonb_build_object(
        'amount', round(p_amount),
        'direction', 'cash_out',
        'category', 'agent_float_deposit',
        'ledger_scope', 'platform',
        'source_table', 'merchant_float_reconciliations',
        'source_id', v_recon_id,
        'description', 'Platform: merchant float opening balance recognised',
        'currency', 'UGX',
        'transaction_date', now()
      )
    ),
    idempotency_key := 'merchant_opening_float:' || v_recon_id::text,
    skip_balance_check := true
  );

  -- The ledger posting is the sole wallet writer here. Reseed the cached float
  -- to the ledger figure so the board shows exactly what the books say.
  v_sync := public.sync_merchant_desk_float_cache(p_desk_id, 'opening balance fix ' || v_recon_id::text);

  SELECT COALESCE(float_balance, 0) INTO v_float_after FROM public.wallets WHERE user_id = v_desk_agent;

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, metadata)
  VALUES (v_actor, 'merchant_opening_float_ledger_posted', 'merchant_float_reconciliations',
          v_recon_id,
          jsonb_build_object('desk_id', p_desk_id, 'agent_id', v_desk_agent,
                             'amount', round(p_amount), 'ledger_group_id', v_group_id,
                             'float_before', v_float_before, 'float_after', COALESCE(v_float_after, 0),
                             'cache_sync', v_sync,
                             'reason', btrim(p_reason)));

  RETURN jsonb_build_object('ok', true, 'reconciliation_id', v_recon_id,
                            'ledger_group_id', v_group_id, 'amount', round(p_amount),
                            'float_before', v_float_before,
                            'float_after', COALESCE(v_float_after, 0),
                            'cache_sync', v_sync);
END
$function$;

-- 3) Write-down path: reseed the cache to the books before reporting the result.
CREATE OR REPLACE FUNCTION public.post_merchant_evidenced_writedown(p_desk_id uuid, p_agent_id uuid, p_amount numeric, p_reason text, p_evidence_note text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_desk_agent uuid;
  v_recon_id uuid;
  v_group_id uuid;
  v_amount numeric;
  v_float_before numeric;
  v_float_after numeric;
  v_reason text := btrim(coalesce(p_reason, ''));
  v_evidence text := btrim(coalesce(p_evidence_note, ''));
  v_description text;
  v_sync jsonb;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF NOT (
    public.has_role(v_actor, 'cfo')
    OR public.has_role(v_actor, 'financial_ops')
    OR public.has_role(v_actor, 'super_admin')
  ) THEN
    RAISE EXCEPTION 'Only the CFO, Financial Ops or a super admin can post an evidenced write-down';
  END IF;

  v_amount := round(coalesce(p_amount, 0));
  IF v_amount <= 0 THEN
    RAISE EXCEPTION 'Enter a positive amount. The write-down is applied as a reduction of the desk float.';
  END IF;

  IF char_length(v_reason) < 10 THEN
    RAISE EXCEPTION 'A reason of at least 10 characters is required';
  END IF;

  IF char_length(v_evidence) < 20 THEN
    RAISE EXCEPTION 'Evidence is required: which agent, what was actually seen on their phone (balance, screenshot reference or provider TID) and the date and time it was checked';
  END IF;

  SELECT agent_id INTO v_desk_agent FROM public.cashout_agents WHERE id = p_desk_id;
  IF v_desk_agent IS NULL THEN
    RAISE EXCEPTION 'Merchant desk not found or has no linked agent';
  END IF;
  IF p_agent_id IS NOT NULL AND p_agent_id <> v_desk_agent THEN
    RAISE EXCEPTION 'Agent does not match this merchant desk';
  END IF;
  IF v_desk_agent = v_actor THEN
    RAISE EXCEPTION 'You cannot write down your own merchant desk. Another authorized finance officer must post this entry.';
  END IF;

  SELECT COALESCE(float_balance, 0) INTO v_float_before FROM public.wallets WHERE user_id = v_desk_agent;
  v_float_before := COALESCE(v_float_before, 0);
  IF v_amount > v_float_before THEN
    RAISE EXCEPTION 'Write-down of % exceeds the float on the books for this desk (%). Float can never go negative.', v_amount, v_float_before;
  END IF;

  INSERT INTO public.merchant_float_reconciliations
    (desk_id, agent_id, adjustment_type, amount, reason, evidence_note, created_by, ledger_effect)
  VALUES
    (p_desk_id, v_desk_agent, 'evidenced_writedown', v_amount, v_reason, v_evidence, v_actor, 'ledger_posted')
  RETURNING id INTO v_recon_id;

  v_description := format(
    'Merchant float evidenced write-down to the amount actually seen with the agent. Reason: %s | Evidence: %s',
    v_reason, v_evidence
  );

  v_group_id := public.create_ledger_transaction(
    entries := jsonb_build_array(
      jsonb_build_object(
        'user_id', v_desk_agent,
        'amount', v_amount,
        'direction', 'cash_out',
        'category', 'merchant_float_correction_writedown',
        'ledger_scope', 'wallet',
        'wallet_bucket', 'float',
        'recipient_type', 'operational_wallet',
        'classification', 'admin_correction',
        'solvency_bypass_reason', 'other_with_note',
        'source_table', 'merchant_float_reconciliations',
        'source_id', v_recon_id,
        'description', v_description,
        'currency', 'UGX',
        'transaction_date', now()
      ),
      jsonb_build_object(
        'amount', v_amount,
        'direction', 'cash_in',
        'category', 'merchant_float_correction_writedown',
        'ledger_scope', 'platform',
        'classification', 'admin_correction',
        'source_table', 'merchant_float_reconciliations',
        'source_id', v_recon_id,
        'description', 'Platform: merchant float evidenced write-down recognised',
        'currency', 'UGX',
        'transaction_date', now()
      )
    ),
    idempotency_key := 'merchant_evidenced_writedown:' || v_recon_id::text,
    skip_balance_check := true
  );

  v_sync := public.sync_merchant_desk_float_cache(p_desk_id, 'evidenced write-down ' || v_recon_id::text);

  SELECT COALESCE(float_balance, 0) INTO v_float_after FROM public.wallets WHERE user_id = v_desk_agent;

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, metadata)
  VALUES (v_actor, 'merchant_evidenced_writedown_posted', 'merchant_float_reconciliations',
          v_recon_id,
          jsonb_build_object('desk_id', p_desk_id, 'agent_id', v_desk_agent,
                             'amount', v_amount, 'ledger_group_id', v_group_id,
                             'float_before', v_float_before, 'float_after', v_float_after,
                             'cache_sync', v_sync,
                             'reason', v_reason, 'evidence', v_evidence));

  RETURN jsonb_build_object(
    'ok', true,
    'reconciliation_id', v_recon_id,
    'ledger_group_id', v_group_id,
    'amount', v_amount,
    'float_before', v_float_before,
    'float_after', COALESCE(v_float_after, 0),
    'cache_sync', v_sync
  );
END;
$function$;