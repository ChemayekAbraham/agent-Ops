ALTER TABLE public.portfolio_redemptions
  ADD COLUMN IF NOT EXISTS payout_status text NOT NULL DEFAULT 'awaiting_cfo',
  ADD COLUMN IF NOT EXISTS payout_decided_by uuid,
  ADD COLUMN IF NOT EXISTS payout_decided_at timestamptz,
  ADD COLUMN IF NOT EXISTS payout_reason text,
  ADD COLUMN IF NOT EXISTS payout_ledger_ref uuid;

-- Redemptions closed before the approval workflow existed are marked legacy so they can never be paid twice by accident.
UPDATE public.portfolio_redemptions SET payout_status = 'legacy'
 WHERE created_at < '2026-10-02'::timestamptz AND payout_status = 'awaiting_cfo';

ALTER TABLE public.portfolio_redemptions
  ADD CONSTRAINT portfolio_redemptions_payout_status_ck
  CHECK (payout_status IN ('awaiting_cfo','paid','rejected','legacy'));

CREATE OR REPLACE FUNCTION public.cfo_list_redemptions(p_status text DEFAULT 'awaiting_cfo')
RETURNS TABLE (
  id uuid, portfolio_id uuid, portfolio_code text, partner_id uuid, partner_name text, partner_phone text, partner_email text,
  scope text, redeemed_amount numeric, old_principal numeric, note text, processed_by uuid, processed_by_name text,
  created_at timestamptz, payout_status text, payout_decided_by uuid, payout_decided_by_name text,
  payout_decided_at timestamptz, payout_reason text, payout_ledger_ref uuid
) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.is_cfo_approver(auth.uid()) THEN RAISE EXCEPTION 'not_authorized'; END IF;
  RETURN QUERY
  SELECT r.id, r.portfolio_id, r.portfolio_code, r.partner_id, p.full_name, p.phone, p.email,
         r.scope, r.redeemed_amount, r.old_principal, r.note, r.processed_by, pb.full_name,
         r.created_at, r.payout_status, r.payout_decided_by, pd.full_name,
         r.payout_decided_at, r.payout_reason, r.payout_ledger_ref
    FROM public.portfolio_redemptions r
    LEFT JOIN public.profiles p ON p.id = r.partner_id
    LEFT JOIN public.profiles pb ON pb.id = r.processed_by
    LEFT JOIN public.profiles pd ON pd.id = r.payout_decided_by
   WHERE NOT r.is_test
     AND (p_status IS NULL OR p_status = 'all' OR r.payout_status = p_status)
   ORDER BY r.created_at DESC;
END $$;

CREATE OR REPLACE FUNCTION public.cfo_approve_redemption(p_id uuid, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_r record;
  v_group uuid;
BEGIN
  IF NOT public.is_cfo_approver(v_uid) THEN RAISE EXCEPTION 'not_authorized'; END IF;
  IF length(trim(coalesce(p_reason,''))) < 10 THEN RAISE EXCEPTION 'reason_too_short'; END IF;

  SELECT * INTO v_r FROM public.portfolio_redemptions WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'redemption_not_found'; END IF;
  IF v_r.is_test THEN RAISE EXCEPTION 'test_record'; END IF;
  IF v_r.payout_status <> 'awaiting_cfo' THEN RAISE EXCEPTION 'already_%', v_r.payout_status; END IF;
  IF v_r.processed_by IS NOT NULL AND v_r.processed_by = v_uid THEN RAISE EXCEPTION 'approver_cannot_be_processor'; END IF;
  IF v_r.partner_id IS NULL OR v_r.redeemed_amount IS NULL OR v_r.redeemed_amount <= 0 THEN RAISE EXCEPTION 'invalid_redemption'; END IF;

  v_group := public.create_ledger_transaction(
    jsonb_build_array(
      jsonb_build_object(
        'user_id', v_r.partner_id, 'ledger_scope', 'wallet', 'direction', 'cash_in',
        'category', 'partner_funding', 'amount', v_r.redeemed_amount,
        'recipient_type', 'user', 'wallet_bucket', 'withdrawable', 'linked_party', 'platform',
        'source_table', 'portfolio_redemptions', 'source_id', v_r.id, 'reference_id', v_r.portfolio_code,
        'description', 'Redemption principal returned to Supporter wallet for ' || v_r.portfolio_code || '. Reason: ' || left(p_reason, 200)),
      jsonb_build_object(
        'ledger_scope', 'platform', 'direction', 'cash_out',
        'category', 'partner_funding', 'amount', v_r.redeemed_amount,
        'source_table', 'portfolio_redemptions', 'source_id', v_r.id, 'reference_id', v_r.portfolio_code,
        'description', 'Partner capital released on redemption of ' || v_r.portfolio_code)
    ),
    'redemption-' || v_r.id::text,
    false
  );

  UPDATE public.portfolio_redemptions
     SET payout_status = 'paid', payout_decided_by = v_uid, payout_decided_at = now(),
         payout_reason = p_reason, payout_ledger_ref = v_group
   WHERE id = p_id;

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, action, reason, metadata)
  VALUES (v_uid, 'redemption_payout_approved', 'portfolio_redemptions', p_id::text, 'approve', p_reason,
          jsonb_build_object('amount', v_r.redeemed_amount, 'portfolio_code', v_r.portfolio_code,
                             'partner_id', v_r.partner_id, 'ledger_group', v_group));

  BEGIN
    INSERT INTO public.system_events (event_type, user_id, related_entity_type, related_entity_id, metadata, description, actor_id)
    VALUES ('funds_added', v_r.partner_id, 'portfolio_redemption', p_id,
            jsonb_build_object('amount', v_r.redeemed_amount, 'portfolio_code', v_r.portfolio_code, 'ledger_group', v_group),
            'Redemption principal paid to Supporter wallet', v_uid);
  EXCEPTION WHEN OTHERS THEN NULL; END;

  RETURN jsonb_build_object('ok', true, 'ledger_group', v_group, 'amount', v_r.redeemed_amount,
    'partner_id', v_r.partner_id, 'portfolio_code', v_r.portfolio_code);
END $$;

CREATE OR REPLACE FUNCTION public.cfo_reject_redemption(p_id uuid, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid(); v_r record;
BEGIN
  IF NOT public.is_cfo_approver(v_uid) THEN RAISE EXCEPTION 'not_authorized'; END IF;
  IF length(trim(coalesce(p_reason,''))) < 10 THEN RAISE EXCEPTION 'reason_too_short'; END IF;
  SELECT * INTO v_r FROM public.portfolio_redemptions WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'redemption_not_found'; END IF;
  IF v_r.payout_status <> 'awaiting_cfo' THEN RAISE EXCEPTION 'already_%', v_r.payout_status; END IF;
  UPDATE public.portfolio_redemptions
     SET payout_status = 'rejected', payout_decided_by = v_uid, payout_decided_at = now(), payout_reason = p_reason
   WHERE id = p_id;
  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, action, reason, metadata)
  VALUES (v_uid, 'redemption_payout_rejected', 'portfolio_redemptions', p_id::text, 'reject', p_reason,
          jsonb_build_object('amount', v_r.redeemed_amount, 'portfolio_code', v_r.portfolio_code));
  RETURN jsonb_build_object('ok', true);
END $$;

REVOKE ALL ON FUNCTION public.cfo_list_redemptions(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.cfo_approve_redemption(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.cfo_reject_redemption(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cfo_list_redemptions(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.cfo_approve_redemption(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.cfo_reject_redemption(uuid, text) TO authenticated;