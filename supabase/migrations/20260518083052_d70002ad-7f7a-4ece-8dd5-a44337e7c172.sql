-- 1. Auto-reject function
CREATE OR REPLACE FUNCTION public.auto_reject_unmatched_deposits(
  p_age_hours integer DEFAULT 24,
  p_email_lookback_hours integer DEFAULT 48
)
RETURNS TABLE(deposit_request_id uuid, amount numeric, user_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row RECORD;
  v_reason text;
BEGIN
  FOR v_row IN
    SELECT d.id, d.user_id, d.amount, d.transaction_id, d.created_at
      FROM deposit_requests d
     WHERE d.status = 'pending'
       AND d.created_at < (now() - (p_age_hours || ' hours')::interval)
       -- No email has been linked to this deposit request
       AND NOT EXISTS (
         SELECT 1 FROM gmail_transactions g
          WHERE g.linked_deposit_request_id = d.id
       )
       -- And no parsed inbox email exists with the same amount in the lookback window
       AND NOT EXISTS (
         SELECT 1 FROM gmail_transactions g
          WHERE g.parsed = true
            AND g.amount IS NOT NULL
            AND abs(g.amount - d.amount) < 0.5
            AND (g.direction IS NULL OR g.direction IN ('in','credit'))
            AND (g.internal_date IS NULL
                 OR g.internal_date >= (d.created_at - (p_email_lookback_hours || ' hours')::interval))
       )
       -- And the user-entered TID (if any) wasn't seen in inbox either
       AND NOT EXISTS (
         SELECT 1 FROM gmail_transactions g
          WHERE d.transaction_id IS NOT NULL
            AND g.transaction_id IS NOT NULL
            AND lower(btrim(g.transaction_id)) = lower(btrim(d.transaction_id))
       )
     ORDER BY d.created_at ASC
     LIMIT 200
  LOOP
    v_reason := format(
      'No matching mobile-money confirmation email was received within %s hours of your deposit request. If you did pay, contact support with your Transaction ID and we will reopen it.',
      p_age_hours
    );

    UPDATE deposit_requests
       SET status = 'rejected',
           rejection_reason = v_reason,
           rejected_at = now(),
           updated_at = now()
     WHERE id = v_row.id
       AND status = 'pending';

    -- Audit trail: general audit_logs (regulator record)
    INSERT INTO audit_logs (user_id, action_type, table_name, record_id, metadata)
    VALUES (
      NULL,
      'auto_reject_deposit',
      'deposit_requests',
      v_row.id::text,
      jsonb_build_object(
        'amount', v_row.amount,
        'user_id', v_row.user_id,
        'age_hours', p_age_hours,
        'email_lookback_hours', p_email_lookback_hours,
        'reason', v_reason,
        'triggered_by', 'auto_reject_unmatched_deposits'
      )
    );

    -- Mirror into the email-match audit feed so ops sees it inline
    INSERT INTO email_match_audit_log (
      gmail_transaction_id, deposit_request_id, action,
      matcher_type, amount, actor_id, notes
    ) VALUES (
      NULL, v_row.id, 'skip',
      'auto_reject', v_row.amount, NULL,
      'Auto-rejected — no matching email confirmation found'
    );

    deposit_request_id := v_row.id;
    amount := v_row.amount;
    user_id := v_row.user_id;
    RETURN NEXT;
  END LOOP;
END
$$;

-- 2. Allow 'auto_reject' as a valid matcher_type label in the audit log
ALTER TABLE public.email_match_audit_log
  DROP CONSTRAINT IF EXISTS email_match_audit_log_action_check;
ALTER TABLE public.email_match_audit_log
  ADD CONSTRAINT email_match_audit_log_action_check
  CHECK (action IN ('auto_claim','unclaim','manual_link','approve','bulk_approve','skip','auto_reject'));

-- 3. Schedule the job to run every 15 minutes
DO $$
DECLARE
  v_job_id bigint;
BEGIN
  SELECT jobid INTO v_job_id FROM cron.job WHERE jobname = 'auto-reject-unmatched-deposits';
  IF v_job_id IS NOT NULL THEN
    PERFORM cron.unschedule(v_job_id);
  END IF;

  PERFORM cron.schedule(
    'auto-reject-unmatched-deposits',
    '*/15 * * * *',
    $cron$ SELECT public.auto_reject_unmatched_deposits(24, 48); $cron$
  );
END $$;