CREATE OR REPLACE FUNCTION public.post_merchant_opening_float_ledger(
  p_desk_id uuid,
  p_agent_id uuid,
  p_amount numeric,
  p_reason text,
  p_evidence_note text DEFAULT NULL
)
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

  PERFORM public.apply_wallet_movement(
    p_user_id := v_desk_agent,
    p_category := 'agent_float_deposit',
    p_amount := round(p_amount),
    p_direction := 'cash_in',
    p_recipient_type := 'operational_wallet'
  );

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, metadata)
  VALUES (v_actor, 'merchant_opening_float_ledger_posted', 'merchant_float_reconciliations',
          v_recon_id,
          jsonb_build_object('desk_id', p_desk_id, 'agent_id', v_desk_agent,
                             'amount', round(p_amount), 'ledger_group_id', v_group_id,
                             'reason', btrim(p_reason)));

  RETURN jsonb_build_object('ok', true, 'reconciliation_id', v_recon_id,
                            'ledger_group_id', v_group_id, 'amount', round(p_amount));
END
$function$;

REVOKE ALL ON FUNCTION public.post_merchant_opening_float_ledger(uuid, uuid, numeric, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.post_merchant_opening_float_ledger(uuid, uuid, numeric, text, text) TO authenticated;