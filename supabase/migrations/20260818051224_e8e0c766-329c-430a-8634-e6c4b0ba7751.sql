-- Guarantee: every completed merchant-desk payout reduces the merchant's company float.
CREATE OR REPLACE FUNCTION public.ensure_merchant_payout_float_debit(p_withdrawal_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_wr record;
  v_agent uuid;
  v_pos jsonb;
  v_available numeric := 0;
  v_debit numeric := 0;
  v_now timestamptz := now();
BEGIN
  SELECT w.id, w.amount, w.status, w.reason, w.assigned_cashout_agent_id, w.user_id
    INTO v_wr
  FROM public.withdrawal_requests w
  WHERE w.id = p_withdrawal_id;

  IF v_wr.id IS NULL OR v_wr.status <> 'completed' OR COALESCE(v_wr.amount, 0) <= 0 THEN
    RETURN jsonb_build_object('action', 'skipped', 'reason', 'not_a_completed_payout');
  END IF;

  IF v_wr.assigned_cashout_agent_id IS NULL THEN
    RETURN jsonb_build_object('action', 'skipped', 'reason', 'no_merchant_desk');
  END IF;

  -- Landlord float payouts already deducted their money in agent_landlord_float.
  IF COALESCE(v_wr.reason, '') ILIKE 'Landlord float payout%' THEN
    RETURN jsonb_build_object('action', 'skipped', 'reason', 'landlord_float_payout');
  END IF;

  SELECT ca.agent_id INTO v_agent
  FROM public.cashout_agents ca
  WHERE ca.id = v_wr.assigned_cashout_agent_id;

  IF v_agent IS NULL THEN
    RETURN jsonb_build_object('action', 'skipped', 'reason', 'desk_has_no_agent');
  END IF;

  -- Already has ANY float debit leg for this payout (consume, telecom, pool proxy)? nothing to do.
  IF EXISTS (
    SELECT 1 FROM public.general_ledger g
    WHERE g.source_table = 'withdrawal_requests'
      AND g.source_id = v_wr.id
      AND g.ledger_scope = 'wallet'
      AND g.wallet_bucket = 'float'
      AND g.direction = 'cash_out'
      AND g.user_id = v_agent
  ) THEN
    RETURN jsonb_build_object('action', 'skipped', 'reason', 'float_debit_already_posted');
  END IF;

  v_pos := public.get_merchant_float_position(v_agent);
  v_available := GREATEST(COALESCE((v_pos->>'available_float')::numeric, 0), 0);
  v_debit := round(LEAST(v_available, COALESCE(v_wr.amount, 0)));

  IF v_debit <= 0 THEN
    -- Agent held no company float: the payout genuinely came off their own line.
    BEGIN
      PERFORM public.classify_merchant_payout_funding(v_wr.id, 'float_debit_guard');
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
    RETURN jsonb_build_object('action', 'no_float_available', 'agent_id', v_agent);
  END IF;

  PERFORM public.create_ledger_transaction(
    jsonb_build_array(
      jsonb_build_object(
        'user_id', v_agent, 'ledger_scope', 'wallet', 'direction', 'cash_out',
        'amount', v_debit, 'category', 'agent_float_settlement',
        'recipient_type', 'operational_wallet', 'wallet_bucket', 'float',
        'source_table', 'withdrawal_requests', 'source_id', v_wr.id,
        'description', format('Company float used to settle customer cash-out %s (guard)', v_wr.id),
        'currency', 'UGX',
        'reference_id', v_wr.id::text || '-merchant-float-consume',
        'transaction_date', v_now
      ),
      jsonb_build_object(
        'user_id', v_agent, 'ledger_scope', 'platform', 'direction', 'cash_in',
        'amount', v_debit, 'category', 'agent_float_settlement',
        'source_table', 'withdrawal_requests', 'source_id', v_wr.id,
        'description', format('Merchant float settled to customer for withdrawal %s (guard)', v_wr.id),
        'currency', 'UGX',
        'reference_id', v_wr.id::text || '-merchant-float-consume',
        'transaction_date', v_now
      )
    ),
    'approve-withdrawal-merchant-float-consume-' || v_wr.id::text,
    false
  );

  BEGIN
    PERFORM public.consume_merchant_float(v_wr.id, v_agent, v_debit, 0,
      GREATEST(round(COALESCE(v_wr.amount, 0) - v_debit), 0));
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  BEGIN
    PERFORM public.classify_merchant_payout_funding(v_wr.id, 'float_debit_guard');
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  RETURN jsonb_build_object(
    'action', 'float_debited',
    'agent_id', v_agent,
    'withdrawal_id', v_wr.id,
    'amount', COALESCE(v_wr.amount, 0),
    'float_debited', v_debit,
    'available_before', v_available
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.ensure_merchant_payout_float_debit(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ensure_merchant_payout_float_debit(uuid) TO service_role;

-- Trigger: fires the guard the moment a payout lands on 'completed'.
CREATE OR REPLACE FUNCTION public.trg_merchant_payout_float_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.status = 'completed'
     AND COALESCE(OLD.status, '') <> 'completed'
     AND NEW.assigned_cashout_agent_id IS NOT NULL THEN
    BEGIN
      PERFORM public.ensure_merchant_payout_float_debit(NEW.id);
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'merchant float guard failed for %: %', NEW.id, SQLERRM;
    END;
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_merchant_payout_float_guard ON public.withdrawal_requests;
CREATE TRIGGER trg_merchant_payout_float_guard
AFTER UPDATE OF status ON public.withdrawal_requests
FOR EACH ROW
EXECUTE FUNCTION public.trg_merchant_payout_float_guard();

-- Finance-only repair sweep for payouts that completed without a float debit.
CREATE OR REPLACE FUNCTION public.sweep_merchant_payout_float_debits(
  p_days integer DEFAULT 7,
  p_dry_run boolean DEFAULT true
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_days integer := greatest(1, least(120, coalesce(p_days, 7)));
  v_rows jsonb := '[]'::jsonb;
  v_r record;
  v_res jsonb;
  v_total numeric := 0;
BEGIN
  IF NOT (has_role(auth.uid(), 'cfo') OR has_role(auth.uid(), 'financial_ops')
          OR has_role(auth.uid(), 'manager') OR has_role(auth.uid(), 'super_admin')) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  FOR v_r IN
    SELECT w.id, w.amount, ca.agent_id, COALESCE(p.full_name, 'Unknown') AS agent_name
    FROM public.withdrawal_requests w
    JOIN public.cashout_agents ca ON ca.id = w.assigned_cashout_agent_id
    LEFT JOIN public.profiles p ON p.id = ca.agent_id
    WHERE w.status = 'completed'
      AND COALESCE(w.processed_at, w.updated_at) >= now() - (v_days || ' days')::interval
      AND COALESCE(w.reason, '') NOT ILIKE 'Landlord float payout%'
      AND NOT EXISTS (
        SELECT 1 FROM public.general_ledger g
        WHERE g.source_table = 'withdrawal_requests' AND g.source_id = w.id
          AND g.ledger_scope = 'wallet' AND g.wallet_bucket = 'float'
          AND g.direction = 'cash_out' AND g.user_id = ca.agent_id
      )
      AND COALESCE((public.get_merchant_float_position(ca.agent_id)->>'available_float')::numeric, 0) > 0
    ORDER BY COALESCE(w.processed_at, w.updated_at) DESC
    LIMIT 500
  LOOP
    IF p_dry_run THEN
      v_res := jsonb_build_object('action', 'would_debit', 'withdrawal_id', v_r.id,
                                  'agent_name', v_r.agent_name, 'amount', v_r.amount);
    ELSE
      v_res := public.ensure_merchant_payout_float_debit(v_r.id)
               || jsonb_build_object('agent_name', v_r.agent_name);
      v_total := v_total + COALESCE((v_res->>'float_debited')::numeric, 0);
    END IF;
    v_rows := v_rows || v_res;
  END LOOP;

  RETURN jsonb_build_object('days', v_days, 'dry_run', p_dry_run,
                            'candidates', jsonb_array_length(v_rows),
                            'float_debited_total', v_total, 'rows', v_rows);
END;
$function$;

REVOKE ALL ON FUNCTION public.sweep_merchant_payout_float_debits(integer, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sweep_merchant_payout_float_debits(integer, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.sweep_merchant_payout_float_debits(integer, boolean) TO service_role;