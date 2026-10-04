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
      'auto_clear_pending_topups',
      'pending_wallet_operations',
      rec.source_id,
      'Auto-cleared by scheduled top-up cron (no Financial Ops)',
      jsonb_build_object(
        'count', rec.cnt,
        'total_amount', rec.total,
        'auto_applied', true,
        'source', 'cron_topups',
        'reason', 'Automatic daily top-up clearance — parked ready to merge at next Returns payout, no Financial Ops verification required'
      )
    );
    v_count := v_count + rec.cnt;
    v_total := v_total + rec.total;
  END LOOP;

  -- Advance pending -> approved directly (parked & ready; NO awaiting_verification, NO FinOps).
  -- The actual merge into portfolio principal happens at the next Returns payout
  -- (process-supporter-roi POST-PAYOUT block). No money moves here.
  UPDATE public.pending_wallet_operations
  SET status = 'approved',
      reviewed_at = v_now
  WHERE operation_type = 'portfolio_topup'
    AND source_table = 'investor_portfolios'
    AND status = 'pending';

  RETURN jsonb_build_object(
    'cleared_count', v_count,
    'total_amount', v_total,
    'ran_at', v_now
  );
END;
$$;