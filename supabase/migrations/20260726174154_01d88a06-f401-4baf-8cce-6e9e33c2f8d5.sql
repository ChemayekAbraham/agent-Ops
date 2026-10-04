CREATE OR REPLACE FUNCTION public.finops_manual_float_credit(
  p_user_id uuid,
  p_tid text,
  p_amount numeric,
  p_deposited_at timestamptz,
  p_depositor_name text,
  p_notes text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role_ok boolean;
  v_tid text;
  v_amt numeric;
  v_group_id uuid;
  v_depositor text;
  v_desc_credit text;
  v_desc_offset text;
BEGIN
  v_role_ok := has_role(auth.uid(),'manager'::app_role)
            OR has_role(auth.uid(),'super_admin'::app_role)
            OR has_role(auth.uid(),'cfo'::app_role)
            OR has_role(auth.uid(),'operations'::app_role)
            OR has_role(auth.uid(),'financial_ops'::app_role);
  IF NOT v_role_ok THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  IF p_user_id IS NULL THEN RAISE EXCEPTION 'user_id required'; END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN RAISE EXCEPTION 'amount must be positive'; END IF;
  IF p_deposited_at IS NULL THEN RAISE EXCEPTION 'deposited_at required'; END IF;

  v_tid := regexp_replace(coalesce(p_tid,''), '\s+', '', 'g');
  IF length(v_tid) < 4 THEN RAISE EXCEPTION 'TID too short'; END IF;

  v_amt := round(p_amount::numeric, 2);
  v_depositor := coalesce(nullif(trim(p_depositor_name),''),'(unnamed)');

  IF EXISTS (SELECT 1 FROM public.ledger_reconciled_tids WHERE tid_normalized = v_tid) THEN
    RAISE EXCEPTION 'TID % has already been reconciled', v_tid;
  END IF;

  v_desc_credit := format(
    'Manual FinOps float credit — MoMo TID %s UGX %s deposited by %s on %s',
    v_tid,
    to_char(v_amt, 'FM999,999,999,999'),
    v_depositor,
    to_char(p_deposited_at AT TIME ZONE 'Africa/Kampala', 'DD-Mon-YYYY HH24:MI')
  );
  IF p_notes IS NOT NULL AND length(trim(p_notes)) > 0 THEN
    v_desc_credit := v_desc_credit || ' — ' || trim(p_notes);
  END IF;
  v_desc_offset := format('Platform offset (platform scope) — manual FinOps credit TID %s', v_tid);

  v_group_id := public.create_ledger_transaction(
    entries := jsonb_build_array(
      jsonb_build_object(
        'user_id', p_user_id,
        'amount', v_amt,
        'direction', 'cash_in',
        'category', 'agent_float_deposit',
        'ledger_scope', 'wallet',
        'wallet_bucket', 'float',
        'recipient_type', 'operational_wallet',
        'description', v_desc_credit,
        'transaction_date', p_deposited_at
      ),
      jsonb_build_object(
        'user_id', p_user_id,
        'amount', v_amt,
        'direction', 'cash_out',
        'category', 'agent_float_deposit',
        'ledger_scope', 'platform',
        'description', v_desc_offset,
        'transaction_date', p_deposited_at
      )
    ),
    idempotency_key := 'finops_manual_float:' || v_tid,
    skip_balance_check := true
  );

  INSERT INTO public.ledger_reconciled_tids (
    tid_normalized, source, source_id, amount, user_id, notes, created_by
  ) VALUES (
    v_tid, 'finops_manual', v_group_id, v_amt, p_user_id,
    format('Manual FinOps credit — depositor: %s', v_depositor),
    auth.uid()
  );

  RETURN jsonb_build_object(
    'ok', true,
    'transaction_group_id', v_group_id,
    'tid', v_tid,
    'amount', v_amt,
    'user_id', p_user_id
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.finops_manual_float_credit(uuid, text, numeric, timestamptz, text, text) TO authenticated;