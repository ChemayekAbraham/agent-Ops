-- Rollback for 20261117130000: drop the list, put the resolve check back inline (as in 20261117120000).
DROP FUNCTION IF EXISTS public.self_support_staff_landlord_payments(text, integer);
CREATE OR REPLACE FUNCTION public.self_support_staff_resolve(p_payment_id uuid, p_outcome text, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_uid uuid := auth.uid(); s public.self_support_landlord_payments%ROWTYPE; v_ws text;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN
    IF v_uid IS NULL OR NOT (
         EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = v_uid
                  AND ur.role::text = ANY (ARRAY['super_admin','ceo','coo','cfo','financial_ops']))
      OR EXISTS (SELECT 1 FROM public.staff_permissions sp WHERE sp.user_id = v_uid AND sp.revoked_at IS NULL
                  AND sp.permitted_dashboard = 'financial-ops')) THEN
      RAISE EXCEPTION 'only Financial Ops can resolve a self-support landlord payment' USING ERRCODE = '42501';
    END IF;
  END IF;
  IF p_outcome NOT IN ('refund', 'paid') THEN RAISE EXCEPTION 'outcome must be refund or paid'; END IF;
  IF length(btrim(COALESCE(p_reason, ''))) < 10 THEN RAISE EXCEPTION 'Reason must be at least 10 characters'; END IF;

  -- lock order: withdrawal, payout, payment (as the merchant path)
  SELECT * INTO s FROM public.self_support_landlord_payments WHERE id = p_payment_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'PAYMENT_NOT_FOUND'; END IF;
  SELECT status INTO v_ws FROM public.withdrawal_requests WHERE id = s.withdrawal_request_id FOR UPDATE;
  PERFORM 1 FROM public.landlord_payouts WHERE id = s.landlord_payout_id FOR UPDATE;
  SELECT * INTO s FROM public.self_support_landlord_payments WHERE id = p_payment_id FOR UPDATE;
  IF s.status <> 'queued' THEN
    RETURN jsonb_build_object('ok', true, 'noop', true, 'status', s.status);
  END IF;

  IF p_outcome = 'refund' THEN
    IF v_ws IN ('completed', 'paid', 'disbursed') THEN
      RAISE EXCEPTION 'The merchant withdrawal is %: the landlord was paid. Resolve as paid.', v_ws;
    END IF;
    UPDATE public.withdrawal_requests
       SET status = 'cancelled', rejection_reason = 'Financial Ops: ' || left(btrim(p_reason), 280), updated_at = now()
     WHERE id = s.withdrawal_request_id AND status NOT IN ('cancelled', 'rejected');
    UPDATE public.landlord_payouts SET status = 'failed', last_error = 'Financial Ops: ' || left(btrim(p_reason), 280), updated_at = now()
     WHERE id = s.landlord_payout_id AND status <> 'failed';
    PERFORM public._ssd_refund(s.id, 'Financial Ops: ' || btrim(p_reason));   -- no-op if the trigger already did it
  ELSE
    IF v_ws NOT IN ('completed', 'paid', 'disbursed') THEN
      RAISE EXCEPTION 'The merchant withdrawal is %, not completed: the landlord was not paid.', v_ws;
    END IF;
    UPDATE public.landlord_payouts
       SET status = 'awaiting_agent_receipt', disbursed_at = COALESCE(disbursed_at, now()), last_error = NULL, updated_at = now(),
           metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('resolved_paid_by', v_uid, 'resolved_reason', btrim(p_reason))
     WHERE id = s.landlord_payout_id AND status NOT IN ('awaiting_agent_receipt', 'completed');
    PERFORM public._ssd_activate(s.id);   -- no-op if the trigger already did it
    PERFORM public._ssd_notify(s.id, 'paid');
  END IF;

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, action, reason, metadata)
  VALUES (v_uid, 'self_support_staff_resolve', 'self_support_landlord_payments', s.id::text,
          'self_support_staff_resolve', btrim(p_reason), jsonb_build_object('outcome', p_outcome, 'withdrawal_status', v_ws));
  RETURN jsonb_build_object('ok', true, 'outcome', p_outcome,
                            'status', (SELECT status FROM public.self_support_landlord_payments WHERE id = s.id));
END $$;

DROP FUNCTION IF EXISTS public._ssd_is_finance_staff();
