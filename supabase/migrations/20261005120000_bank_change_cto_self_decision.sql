-- Let the CTO and super admin decide their own bank account change.
--
-- 20261005090000_locked_bank_account.sql made finops_decide_bank_account_change() refuse EVERYONE deciding their own
-- application (copied from the withdrawal number change). That is the safeguard that stops a person asking to redirect
-- their own withdrawals and approving it themselves.
--
-- This relaxes it for exactly two roles: cto and super_admin. Anyone else still gets "You cannot decide your own bank
-- account change." A self-decision is allowed to go through but is recorded: audit_logs.new_values has
-- self_decided = true, and the verification note says the account holder decided it.
--
-- Everything else in the function is unchanged from 20261005090000: the Financial Ops / CFO / super admin / manager role
-- gate, the 10-character reason, one decision per request, the check that the account is not locked to another user, the
-- lock moving to the new account, and the new account being marked verified for withdrawals.
--
-- Trade-off to be aware of: the three holders of the CTO role can now approve their own bank account changes without a
-- second person. Roll back with 20261005120000_bank_change_cto_self_decision.rollback.sql.

CREATE OR REPLACE FUNCTION public.finops_decide_bank_account_change(p_request_id uuid, p_decision text, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_decision text := lower(btrim(coalesce(p_decision, '')));
  v_reason text := btrim(coalesce(p_reason, ''));
  v_row public.bank_account_change_requests;
  v_key text;
  v_dest record;
  v_self boolean;
BEGIN
  IF NOT (public.has_role(v_uid, 'financial_ops') OR public.has_role(v_uid, 'cfo')
          OR public.has_role(v_uid, 'super_admin') OR public.has_role(v_uid, 'manager')) THEN
    RAISE EXCEPTION 'Only Financial Ops can decide a bank account change.';
  END IF;
  IF v_decision NOT IN ('approved', 'rejected') THEN
    RAISE EXCEPTION 'Decision must be approved or rejected.';
  END IF;
  IF length(v_reason) < 10 THEN
    RAISE EXCEPTION 'Write at least 10 characters explaining the decision.';
  END IF;

  SELECT * INTO v_row FROM public.bank_account_change_requests WHERE id = p_request_id FOR UPDATE;
  IF v_row.id IS NULL THEN
    RAISE EXCEPTION 'Request not found.';
  END IF;
  IF v_row.status <> 'pending' THEN
    RAISE EXCEPTION 'This request was already decided.';
  END IF;

  -- Nobody else may decide their own application. The CTO and super admin may; it is recorded as a self-decision.
  v_self := v_row.user_id = v_uid;
  IF v_self AND NOT (public.has_role(v_uid, 'cto') OR public.has_role(v_uid, 'super_admin')) THEN
    RAISE EXCEPTION 'You cannot decide your own bank account change.';
  END IF;

  IF v_decision = 'approved' THEN
    v_key := public.payout_destination_key('bank_transfer', NULL, v_row.requested_bank_name, v_row.requested_account_number);
    IF v_key IS NULL THEN
      RAISE EXCEPTION 'The requested account details are not valid.';
    END IF;
    IF EXISTS (SELECT 1 FROM public.locked_bank_accounts WHERE account_key = v_key AND user_id <> v_row.user_id) THEN
      RAISE EXCEPTION 'That bank account is already registered to another user. Reject this request with that reason.';
    END IF;

    INSERT INTO public.locked_bank_accounts (user_id, bank_name, account_number, account_name, account_key, source)
    VALUES (v_row.user_id, v_row.requested_bank_name, v_row.requested_account_number, v_row.requested_account_name, v_key, 'change_approved')
    ON CONFLICT (user_id) DO UPDATE
      SET bank_name = EXCLUDED.bank_name, account_number = EXCLUDED.account_number,
          account_name = EXCLUDED.account_name, account_key = EXCLUDED.account_key,
          source = 'change_approved', updated_at = now();

    SELECT * INTO v_dest FROM public.ensure_payout_destination(
      v_row.user_id, 'bank_transfer', NULL, NULL, NULL,
      v_row.requested_bank_name, v_row.requested_account_number, v_row.requested_account_name);

    UPDATE public.payout_destination_verifications
       SET status = 'verified',
           decision_reason = 'Bank account change approved by '
             || CASE WHEN v_self THEN 'the account holder (CTO / super admin self-decision)' ELSE 'Financial Ops' END
             || ': ' || v_reason,
           decided_by = v_uid,
           decided_at = now()
     WHERE id = v_dest.id;
  END IF;

  UPDATE public.bank_account_change_requests
     SET status = v_decision, decision_reason = v_reason, decided_by = v_uid, decided_at = now(), updated_at = now()
   WHERE id = p_request_id;

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, old_values, new_values)
  VALUES (v_uid,
          CASE WHEN v_decision = 'approved' THEN 'BANK_ACCOUNT_CHANGE_APPROVED' ELSE 'BANK_ACCOUNT_CHANGE_REJECTED' END,
          'bank_account_change_requests', p_request_id::text, v_reason,
          jsonb_build_object('locked_last4', right(regexp_replace(coalesce(v_row.current_account_number, ''), '\D', '', 'g'), 4)),
          jsonb_build_object('owner', v_row.user_id,
                             'new_last4', right(regexp_replace(v_row.requested_account_number, '\D', '', 'g'), 4),
                             'bank', v_row.requested_bank_name,
                             'self_decided', v_self));

  RETURN jsonb_build_object('success', true, 'status', v_decision);
END;
$function$;
