CREATE OR REPLACE FUNCTION public.finalize_withdrawal_from_matched_payout_sms()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.validation_result = 'matched'
     AND NEW.withdrawal_request_id IS NOT NULL
     AND NEW.extracted_tid IS NOT NULL
     AND btrim(NEW.extracted_tid) <> '' THEN
    UPDATE public.withdrawal_requests
       SET status = CASE
                      WHEN status IN ('completed', 'disbursed') THEN status
                      ELSE 'paid'
                    END,
           fin_ops_reference = COALESCE(fin_ops_reference, upper(btrim(NEW.extracted_tid))),
           transaction_id = COALESCE(transaction_id, upper(btrim(NEW.extracted_tid))),
           processed_at = COALESCE(processed_at, NEW.created_at, now()),
           processed_by = COALESCE(processed_by, NEW.approver_id),
           fin_ops_verified_at = COALESCE(fin_ops_verified_at, NEW.created_at, now()),
           fin_ops_verified_by = COALESCE(fin_ops_verified_by, NEW.approver_id),
           updated_at = now()
     WHERE id = NEW.withdrawal_request_id
       AND status IN ('pending', 'requested', 'manager_approved', 'cfo_approved', 'fin_ops_approved', 'approved', 'processing', 'paid');
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_finalize_withdrawal_from_matched_payout_sms ON public.payout_claim_sms_audit_log;
CREATE TRIGGER trg_finalize_withdrawal_from_matched_payout_sms
AFTER INSERT ON public.payout_claim_sms_audit_log
FOR EACH ROW
EXECUTE FUNCTION public.finalize_withdrawal_from_matched_payout_sms();

CREATE OR REPLACE FUNCTION public.get_dispatch_context(p_withdrawal_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_agent_id uuid := auth.uid();
  v_w public.withdrawal_requests%ROWTYPE;
  v_name text;
  v_loc record;
  v_reason_lc text;
  v_initiator text;
  v_kind text;
  v_open_statuses text[] := ARRAY['pending','requested','manager_approved','cfo_approved','fin_ops_approved'];
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.cashout_agents
     WHERE agent_id = v_agent_id AND is_active = true
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_merchant_agent');
  END IF;

  SELECT * INTO v_w FROM public.withdrawal_requests WHERE id = p_withdrawal_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_found');
  END IF;

  IF NOT (v_w.status = ANY (v_open_statuses))
     OR v_w.processed_at IS NOT NULL
     OR v_w.fin_ops_reference IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_actionable', 'status', v_w.status);
  END IF;

  SELECT full_name INTO v_name FROM public.profiles WHERE id = v_w.user_id;

  SELECT city, address, latitude, longitude
    INTO v_loc
    FROM public.user_locations
   WHERE user_id = v_w.user_id
   ORDER BY captured_at DESC
   LIMIT 1;

  v_reason_lc := lower(coalesce(v_w.reason, ''));
  v_initiator := lower(coalesce(v_w.metadata->>'initiated_by', ''));

  IF v_initiator LIKE '%proxy%'
     OR v_reason_lc LIKE '%proxy%'
     OR v_reason_lc LIKE '%roi%'
     OR v_reason_lc LIKE '%return%'
     OR v_reason_lc LIKE '%partner%' THEN
    v_kind := 'partner_returns';
  ELSE
    v_kind := 'standard';
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'withdrawal_id', v_w.id,
    'amount', v_w.amount,
    'payout_method', v_w.payout_method,
    'status', v_w.status,
    'reason', v_w.reason,
    'dispatch_kind', v_kind,
    'created_at', v_w.created_at,
    'dispatch_expires_at', v_w.dispatch_expires_at,
    'dispatch_claimed_by', v_w.dispatch_claimed_by,
    'customer_name', v_name,
    'city', v_loc.city,
    'address', v_loc.address,
    'latitude', v_loc.latitude,
    'longitude', v_loc.longitude
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_dispatch_context(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_dispatch_context(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_dispatch_context(uuid) TO service_role;