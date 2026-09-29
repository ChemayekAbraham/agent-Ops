-- Doc 167: manual FinOps float credits count as TID-backed float.
--
-- Josh (2026-09-29): "allow the float through manual float credit in financial
-- ops be used by agents to pay for their tenants because I have added a TID on
-- it which is a requirement".
--
-- Watsala Enock was credited UGX 16,000 (TID 157665927432) through the Manual
-- Float Credit panel. Allocating 9,178 to tenant Najjinda Jesca then failed with
-- "TID-backed balance: 0". finops_manual_float_credit posts category
-- agent_float_deposit with source_table 'ledger_transaction' and no TID in
-- sub_category. tg_credit_tid_backed_float() only recognises deposit_requests
-- and cfo_direct_credit, so every manual credit was invisible to the gate.
--
-- The manual RPC already requires a TID and refuses one that is already in
-- ledger_reconciled_tids, so each TID can back float only once, whether it
-- arrives by email/IFTTT or by hand. The RPC now credits
-- agent_tid_backed_float itself. The trigger is left unchanged, because it
-- never sees these rows, so nothing is counted twice. The raw-float check in
-- agent_allocate_tenant_payment_internal still applies. The body is the same
-- as 20260929200000 apart from the PERFORM.
--
-- Backfill is scoped to the three manual credits made after the gate went live
-- that are still unspent (2026-09-29 19:27-19:29 UTC). Each is capped at the
-- agent's float minus their current TID-backed balance, so TID-backed can never
-- go above real float. SHAFEEQ SSENABULYA's 09-24 and 09-25 credits are already
-- spent (float 204), so they are not backfilled. As in 20260923090000, there is no
-- platform-wide recompute.

CREATE OR REPLACE FUNCTION public.finops_manual_float_credit(p_user_id uuid, p_tid text, p_amount numeric, p_deposited_at timestamp with time zone, p_depositor_name text, p_notes text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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

  v_tid := regexp_replace(coalesce(p_tid,''), '[^A-Za-z0-9]', '', 'g');
  v_tid := regexp_replace(v_tid, '^[Tt][Ii][Dd]([0-9]{4,})$', '\1');
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

  -- A general_ledger trigger may have already recorded this TID as reconciled
  -- during create_ledger_transaction. Swallow the duplicate quietly so the
  -- manual credit still succeeds; genuine replays are caught by the EXISTS
  -- check above before any ledger posting happens.
  INSERT INTO public.ledger_reconciled_tids (
    tid_normalized, source, source_id, amount, user_id, notes, created_by
  ) VALUES (
    v_tid, 'finops_manual', v_group_id, v_amt, p_user_id,
    format('Manual FinOps credit — depositor: %s', v_depositor),
    auth.uid()
  )
  ON CONFLICT (tid_normalized) DO NOTHING;

  -- Doc 167: the TID was just proven unique by the ledger_reconciled_tids
  -- check above, so this credit is TID-backed and may fund rent collection.
  -- tg_credit_tid_backed_float() cannot see it: create_ledger_transaction
  -- stamps source_table='ledger_transaction' with no TID in sub_category.
  PERFORM public.credit_agent_tid_backed_float(p_user_id, v_amt);

  RETURN jsonb_build_object(
    'ok', true,
    'transaction_group_id', v_group_id,
    'tid', v_tid,
    'amount', v_amt,
    'user_id', p_user_id
  );
END;
$function$;

-- Scoped backfill (see header). Idempotent via audit_logs marker.
DO $$
DECLARE r record; v_add numeric;
BEGIN
  FOR r IN
    SELECT gl.user_id, gl.amount, gl.id
      FROM public.general_ledger gl
     WHERE gl.id IN ('45c40483-a2ee-49a7-b578-c5b6967c1701',  -- Watsala Enock 16,000
                     'c88ef049-e46b-4bea-8a91-60fbaf995c69',  -- Tijan Edris 7,200
                     '27c00d49-6312-47a3-9718-af4c5bf20a45')  -- NATTU SHARIFAH 50,000
       AND NOT EXISTS (SELECT 1 FROM public.audit_logs a
                        WHERE a.action_type = 'tid_backed_float_manual_credit_backfill'
                          AND a.record_id = gl.id::text)
  LOOP
    SELECT LEAST(r.amount,
                 GREATEST(0, coalesce(w.float_balance,0) - coalesce(tb.balance,0)))
      INTO v_add
      FROM (SELECT r.user_id AS uid) u
      LEFT JOIN public.wallets w ON w.user_id = u.uid
      LEFT JOIN public.agent_tid_backed_float tb ON tb.agent_id = u.uid;
    PERFORM public.credit_agent_tid_backed_float(r.user_id, v_add);
    INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, new_values)
    VALUES (r.user_id, 'tid_backed_float_manual_credit_backfill', 'agent_tid_backed_float', r.id::text,
            'Doc 167: manual FinOps float credit recognised as TID-backed.',
            jsonb_build_object('ledger_amount', r.amount, 'credited', v_add));
  END LOOP;
END $$;
