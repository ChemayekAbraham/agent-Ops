-- Self-support merchant-direct: the Financial Ops list behind the "settle a held payment" button.
-- Read-only list + one shared staff check; self_support_staff_resolve now uses the same check.
SET LOCAL lock_timeout = '5s';

-- Financial Ops: the same people refund_agent_float_for_payout lets through, and service_role.
CREATE OR REPLACE FUNCTION public._ssd_is_finance_staff() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT COALESCE(auth.role(), '') = 'service_role'
      OR EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = auth.uid()
                  AND ur.role::text = ANY (ARRAY['super_admin','ceo','coo','cfo','financial_ops']))
      OR EXISTS (SELECT 1 FROM public.staff_permissions sp WHERE sp.user_id = auth.uid() AND sp.revoked_at IS NULL
                  AND sp.permitted_dashboard = 'financial-ops');
$$;
REVOKE ALL ON FUNCTION public._ssd_is_finance_staff() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._ssd_is_finance_staff() TO service_role;

CREATE OR REPLACE FUNCTION public.self_support_staff_resolve(p_payment_id uuid, p_outcome text, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_uid uuid := auth.uid(); s public.self_support_landlord_payments%ROWTYPE; v_ws text;
BEGIN
  IF NOT public._ssd_is_finance_staff() THEN
    RAISE EXCEPTION 'only Financial Ops can resolve a self-support landlord payment' USING ERRCODE = '42501';
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


-- Payments for the Financial Ops screen, one query (no per-row lookups).
--   p_filter 'attention' (default): held or flagged, or past 48 hours and still waiting
--            'queued': everything still waiting for a merchant
--            'all':    the latest, any status
CREATE OR REPLACE FUNCTION public.self_support_staff_landlord_payments(p_filter text DEFAULT 'attention', p_limit integer DEFAULT 100)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_rows jsonb;
BEGIN
  IF NOT public._ssd_is_finance_staff() THEN
    RAISE EXCEPTION 'only Financial Ops can see self-support landlord payments' USING ERRCODE = '42501';
  END IF;
  IF COALESCE(p_filter, 'attention') NOT IN ('attention', 'queued', 'all') THEN
    RAISE EXCEPTION 'filter must be attention, queued or all';
  END IF;

  SELECT COALESCE(jsonb_agg(x ORDER BY x->>'created_at' DESC), '[]'::jsonb) INTO v_rows FROM (
    SELECT jsonb_build_object(
      'id', s.id, 'status', s.status, 'rent_request_id', s.rent_request_id, 'amount', s.amount,
      'landlord_name', s.landlord_name, 'landlord_phone', s.landlord_phone,
      'created_at', s.created_at, 'expires_at', s.expires_at, 'paid_at', s.paid_at,
      'refunded_at', s.refunded_at, 'refund_reason', s.refund_reason, 'earning_from', s.earning_from,
      'stuck_flagged_at', s.stuck_flagged_at,
      'overdue', s.status = 'queued' AND s.expires_at < now(),
      'withdrawal_id', s.withdrawal_request_id, 'withdrawal_status', w.status,
      'merchant_claimed', w.assigned_cashout_agent_id IS NOT NULL,
      'landlord_payout_id', s.landlord_payout_id, 'payout_status', lp.status, 'payout_error', lp.last_error,
      'agent_id', s.agent_id, 'agent_name', ap.full_name,
      'tenant_name', tp.full_name,
      'partners', pn.partners,
      -- what the button may do now
      'can_refund', s.status = 'queued' AND COALESCE(w.status, '') NOT IN ('completed', 'paid', 'disbursed'),
      'can_mark_paid', s.status = 'queued' AND COALESCE(w.status, '') IN ('completed', 'paid', 'disbursed')
    ) AS x
    FROM public.self_support_landlord_payments s
    LEFT JOIN public.withdrawal_requests w ON w.id = s.withdrawal_request_id
    LEFT JOIN public.landlord_payouts lp ON lp.id = s.landlord_payout_id
    LEFT JOIN public.profiles ap ON ap.id = s.agent_id
    LEFT JOIN public.rent_requests rr ON rr.id = s.rent_request_id
    LEFT JOIN public.profiles tp ON tp.id = rr.tenant_id
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(jsonb_build_object('partner_id', p.id, 'name', p.full_name,
                                          'share', (SELECT SUM(l.principal) FROM public.partner_self_funding_lines l
                                                     WHERE l.id = ANY (s.line_ids) AND l.partner_id = p.id))) AS partners
        FROM public.profiles p WHERE p.id = ANY (s.partner_ids)
    ) pn ON true
    WHERE CASE COALESCE(p_filter, 'attention')
            WHEN 'attention' THEN s.status = 'queued' AND (s.stuck_flagged_at IS NOT NULL OR s.expires_at < now()
                                                           OR lp.status = 'failed')
            WHEN 'queued' THEN s.status = 'queued'
            ELSE true END
    ORDER BY s.created_at DESC
    LIMIT LEAST(GREATEST(COALESCE(p_limit, 100), 1), 500)
  ) q;
  RETURN v_rows;
END $$;
REVOKE ALL ON FUNCTION public.self_support_staff_landlord_payments(text, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.self_support_staff_landlord_payments(text, integer) TO authenticated, service_role;
