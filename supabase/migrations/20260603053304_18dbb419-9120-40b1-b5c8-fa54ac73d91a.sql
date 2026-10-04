-- Auto-expire cash deposit codes and reject the underlying deposits.
-- A 4-digit cash receipt code already has a 24h expiry window
-- (cash_deposit_verifications.expires_at). Until now, expiry was only
-- enforced lazily when a user tried to enter a code; a deposit whose code
-- was never entered stayed 'pending' forever. This sweep actively closes
-- those out: it marks the verification 'expired' and the deposit 'rejected'.

CREATE OR REPLACE FUNCTION public.expire_stale_cash_deposit_codes()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row record;
  v_count integer := 0;
  v_reason text := 'Cash deposit rejected automatically — the receipt code expired before it was entered.';
BEGIN
  FOR v_row IN
    SELECT v.id AS verification_id,
           v.deposit_request_id,
           v.user_id,
           v.amount,
           v.attempts,
           v.expires_at
    FROM public.cash_deposit_verifications v
    JOIN public.deposit_requests dr ON dr.id = v.deposit_request_id
    WHERE v.status = 'awaiting_code'
      AND v.expires_at < now()
      AND dr.status = 'pending'
      AND dr.provider = 'cash_deposit'
  LOOP
    -- 1) Close the verification window.
    UPDATE public.cash_deposit_verifications
       SET status = 'expired'
     WHERE id = v_row.verification_id
       AND status = 'awaiting_code';

    -- 2) Reject the still-pending deposit (never touch credited/verified rows).
    UPDATE public.deposit_requests
       SET status = 'rejected',
           rejection_reason = v_reason,
           rejected_at = now()
     WHERE id = v_row.deposit_request_id
       AND status = 'pending';

    -- 3) Verification event trail.
    INSERT INTO public.cash_deposit_verification_events (
      verification_id, deposit_request_id, user_id, event_type,
      attempt_no, amount, detail, metadata
    ) VALUES (
      v_row.verification_id, v_row.deposit_request_id, v_row.user_id, 'expired',
      v_row.attempts, v_row.amount,
      'Code window expired — deposit auto-rejected by the expiry sweep.',
      jsonb_build_object('expires_at', v_row.expires_at, 'auto_rejected', true, 'source', 'expiry_sweep')
    );

    -- 4) Deposit decision audit trail.
    BEGIN
      INSERT INTO public.deposit_decision_audit (
        deposit_request_id, source, decision, reason, amount, metadata
      ) VALUES (
        v_row.deposit_request_id, 'approval', 'rejected', 'cash_code_expired',
        v_row.amount,
        jsonb_build_object('verification_id', v_row.verification_id, 'expires_at', v_row.expires_at)
      );
    EXCEPTION WHEN OTHERS THEN NULL;
    END;

    -- 5) System event.
    BEGIN
      PERFORM public.log_system_event(
        'deposit_rejected',
        v_row.user_id,
        'deposit_requests',
        v_row.deposit_request_id::text,
        jsonb_build_object('amount', v_row.amount, 'reason', 'cash_code_expired')
      );
    EXCEPTION WHEN OTHERS THEN NULL;
    END;

    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$$;

GRANT EXECUTE ON FUNCTION public.expire_stale_cash_deposit_codes() TO service_role;

-- Run the sweep every 5 minutes.
SELECT cron.schedule(
  'expire-cash-deposit-codes',
  '*/5 * * * *',
  $$ SELECT public.expire_stale_cash_deposit_codes(); $$
);