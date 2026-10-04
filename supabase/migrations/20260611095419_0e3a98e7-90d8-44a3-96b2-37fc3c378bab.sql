CREATE OR REPLACE FUNCTION public.auto_apply_pending_topups()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count   int := 0;
  v_total   numeric := 0;
  v_now     timestamptz := now();
  rec       record;
BEGIN
  -- Audit each portfolio that has pending top-ups BEFORE the status change
  FOR rec IN
    SELECT source_id, count(*) AS cnt, coalesce(sum(amount), 0) AS total
    FROM public.pending_wallet_operations
    WHERE operation_type = 'portfolio_topup'
      AND source_table = 'investor_portfolios'
      AND status = 'pending'
    GROUP BY source_id
  LOOP
    INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, action, metadata)
    VALUES (
      NULL,
      'submit_topups_for_verification',
      'pending_wallet_operations',
      rec.source_id,
      'Auto-applied by 6PM scheduled top-up cron',
      jsonb_build_object(
        'count', rec.cnt,
        'total_amount', rec.total,
        'auto_applied', true,
        'source', 'cron_6pm',
        'reason', 'Automatic 6PM daily top-up submission for Financial Ops verification'
      )
    );
    v_count := v_count + rec.cnt;
    v_total := v_total + rec.total;
  END LOOP;

  -- Advance pending -> awaiting_verification (no money moves)
  UPDATE public.pending_wallet_operations
  SET status = 'awaiting_verification',
      reviewed_at = v_now
  WHERE operation_type = 'portfolio_topup'
    AND source_table = 'investor_portfolios'
    AND status = 'pending';

  RETURN jsonb_build_object(
    'applied_count', v_count,
    'total_amount', v_total,
    'ran_at', v_now
  );
END;
$$;

-- 6:00 PM Uganda time (EAT, UTC+3) = 15:00 UTC
SELECT cron.schedule(
  'auto-apply-pending-topups-6pm',
  '0 15 * * *',
  $$ SELECT public.auto_apply_pending_topups(); $$
);