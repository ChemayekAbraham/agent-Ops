-- Item 7: capture IP/user-agent on the claim/dispatch notification action.
--
-- withdrawal_notification_log tracks who was notified of a payout dispatch
-- and their response (pending/accepted/superseded). payout_claim_sms_audit_
-- log and payout_code_audit_log (adjacent claim-evidence tables) already
-- carry ip_address/user_agent; this table did not.
--
-- accept_withdrawal_dispatch() is the function that turns 'pending' into
-- 'accepted' -- the actual dispatch-claim action, called via RPC from the
-- merchant agent's own client, so request headers are available. Captured
-- once and stamped only on the accepting agent's own row; the 'superseded'
-- rows for other notified agents are a side effect of that action, not an
-- action of their own, so they are left unstamped rather than misattributing
-- someone else's IP to them.
--
-- Same request.headers pattern as the rest of the series, non-blocking.
-- All of accept_withdrawal_dispatch's original guard clauses
-- (not_merchant_agent, not_found, provider_not_assigned) and its delegation
-- to claim_withdrawal_verified are unchanged.

ALTER TABLE public.withdrawal_notification_log
  ADD COLUMN IF NOT EXISTS ip_address text,
  ADD COLUMN IF NOT EXISTS user_agent text;

CREATE OR REPLACE FUNCTION public.accept_withdrawal_dispatch(p_withdrawal_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_w record;
  v_result jsonb;
  v_ok boolean;
  v_headers jsonb;
  v_ip text;
  v_ua text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.cashout_agents WHERE agent_id = v_uid AND is_active = true
  ) THEN
    RETURN jsonb_build_object('ok', false, 'success', false, 'error', 'not_merchant_agent');
  END IF;

  SELECT payout_method, mobile_money_provider, bank_name, mobile_money_number, mobile_money_name
    INTO v_w
  FROM public.withdrawal_requests WHERE id = p_withdrawal_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'success', false, 'error', 'not_found');
  END IF;

  IF NOT public.merchant_handles_payout(v_uid, v_w.payout_method, v_w.mobile_money_provider, v_w.bank_name) THEN
    RETURN jsonb_build_object('ok', false, 'success', false, 'error', 'provider_not_assigned');
  END IF;

  v_result := public.claim_withdrawal_verified(p_withdrawal_id, v_w.mobile_money_number, v_w.mobile_money_name);
  v_ok := COALESCE((v_result->>'success')::boolean, false);

  IF v_ok THEN
    BEGIN
      v_headers := coalesce(current_setting('request.headers', true), '{}')::jsonb;
      v_ip := nullif(split_part(coalesce(v_headers ->> 'x-forwarded-for', ''), ',', 1), '');
      IF v_ip IS NULL THEN
        v_ip := nullif(v_headers ->> 'cf-connecting-ip', '');
      END IF;
      v_ua := v_headers ->> 'user-agent';
    EXCEPTION WHEN OTHERS THEN
      v_ip := NULL;
      v_ua := NULL;
    END;

    UPDATE public.withdrawal_notification_log
       SET response = 'accepted', claimed_at = now(), updated_at = now(),
           ip_address = v_ip, user_agent = v_ua
     WHERE withdrawal_id = p_withdrawal_id AND recipient_id = v_uid;
    UPDATE public.withdrawal_notification_log
       SET response = 'superseded', claimed_at = now(), updated_at = now()
     WHERE withdrawal_id = p_withdrawal_id AND recipient_id <> v_uid AND response = 'pending';
  END IF;

  RETURN v_result || jsonb_build_object('ok', v_ok);
END;
$function$;
