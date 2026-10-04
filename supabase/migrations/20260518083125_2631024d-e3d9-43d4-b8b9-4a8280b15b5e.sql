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
       AND NOT EXISTS (
         SELECT 1 FROM gmail_transactions g
          WHERE g.linked_deposit_request_id = d.id
       )
       AND NOT EXISTS (
         SELECT 1 FROM gmail_transactions g
          WHERE g.parsed = true
            AND g.amount IS NOT NULL
            AND abs(g.amount - d.amount) < 0.5
            AND (g.direction IS NULL OR g.direction IN ('in','credit'))
            AND (g.internal_date IS NULL
                 OR g.internal_date >= (d.created_at - (p_email_lookback_hours || ' hours')::interval))
       )
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

    INSERT INTO audit_logs (user_id, action_type, table_name, record_id, metadata)
    VALUES (
      NULL, 'auto_reject_deposit', 'deposit_requests', v_row.id::text,
      jsonb_build_object(
        'amount', v_row.amount, 'user_id', v_row.user_id,
        'age_hours', p_age_hours, 'email_lookback_hours', p_email_lookback_hours,
        'reason', v_reason, 'triggered_by', 'auto_reject_unmatched_deposits'
      )
    );

    INSERT INTO email_match_audit_log (
      gmail_transaction_id, deposit_request_id, action, matcher_type, amount, actor_id, notes
    ) VALUES (
      NULL, v_row.id, 'auto_reject', 'no_email', v_row.amount, NULL,
      'Auto-rejected — no matching email confirmation found in window'
    );

    deposit_request_id := v_row.id;
    amount := v_row.amount;
    user_id := v_row.user_id;
    RETURN NEXT;
  END LOOP;
END
$$;