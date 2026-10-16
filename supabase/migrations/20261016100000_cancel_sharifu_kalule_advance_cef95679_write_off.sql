-- Cancel (write off) Sharifu Kalule's overdue advance cef95679 (principal 800,000;
-- outstanding 901,909.20 at cancel time) as approved by the CFO, 2026-10-16.
-- Already applied live 2026-10-16 08:30 UTC in two steps; this file records both and is
-- replay-safe.
--
-- 1) Fix tg_advance_balance_must_be_on_statement. It looked the cause up with
--    `audit_logs.record_id = NEW.id` (text = uuid) and raised 42883 whenever a balance
--    change had no statement row, which made cancel_agent_advance (write-off) and the CFO
--    Cancel button fail. Only change: `NEW.id::text`.
-- 2) Cancel in write-off mode, mirroring cancel_agent_advance(p_recoup := false).
--    Idempotent: only acts while the advance is not cancelled/completed. Wallet
--    deductions already taken are not refunded (see the follow-up reallocation migration
--    20261016120000).
CREATE OR REPLACE FUNCTION public.tg_advance_balance_must_be_on_statement()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_outstanding numeric;
  v_last record;
  v_diff numeric;
  v_cause text;
  v_row_id uuid;
BEGIN
  SELECT outstanding_balance INTO v_outstanding FROM public.agent_advances WHERE id = NEW.id;
  IF v_outstanding IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT closing_balance INTO v_last
  FROM public.agent_advance_ledger
  WHERE advance_id = NEW.id
  ORDER BY created_at DESC, opening_balance ASC, id DESC
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  v_diff := v_outstanding - v_last.closing_balance;
  IF abs(v_diff) < 0.01 THEN
    RETURN NULL;
  END IF;

  v_cause := nullif(current_setting('welile.advance_adjustment_note', true), '');
  IF v_cause IS NULL THEN
    SELECT action_type || coalesce(': ' || nullif(coalesce(reason, metadata->>'reason'), ''), '')
      INTO v_cause
    FROM public.audit_logs
    WHERE record_id = NEW.id::text AND created_at = now()
    ORDER BY id DESC
    LIMIT 1;
  END IF;
  v_cause := left(coalesce(v_cause, 'Balance changed with no statement entry and no audit reason'), 500);

  INSERT INTO public.agent_advance_ledger
    (advance_id, date, opening_balance, interest_accrued, amount_deducted,
     adjustment_amount, closing_balance, deduction_status, recovery_source, note)
  VALUES
    (NEW.id, (now() AT TIME ZONE 'Africa/Kampala')::date, v_last.closing_balance, 0, 0,
     v_diff, v_outstanding, 'none', 'balance_adjustment', v_cause)
  RETURNING id INTO v_row_id;

  INSERT INTO public.advance_statement_exceptions (advance_id, statement_row_id, kind, amount, detail)
  VALUES (NEW.id, v_row_id, 'unrecorded_balance_change', v_diff, v_cause);

  RETURN NULL;
END;
$function$;

DO $$
DECLARE
  v_id uuid := 'cef95679-bd3b-4b4a-88a0-bae32e39a1c5';
  v_by uuid := 'cb798acb-68bc-4b4e-a414-a3d374e030b6';
  v_reason text := 'CFO approved cancellation of advance - outstanding waived';
  v_adv record;
BEGIN
  SELECT * INTO v_adv FROM public.agent_advances
  WHERE id = v_id AND status NOT IN ('cancelled','completed') FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;

  UPDATE public.agent_advances
  SET status='cancelled', pre_cancel_outstanding=outstanding_balance,
      outstanding_balance=0, arrears_balance=0, daily_installment=0,
      cancelled_at=now(), cancelled_by=v_by, cancellation_reason=v_reason,
      cancellation_mode='write_off', updated_at=now()
  WHERE id = v_id;

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, metadata)
  VALUES (v_by, 'agent_advance_cancelled', 'agent_advances', v_id,
    jsonb_build_object('mode','write_off','reason',v_reason,
      'previous_outstanding', v_adv.outstanding_balance,
      'agent_id', v_adv.agent_id, 'principal', v_adv.principal));
END $$;
