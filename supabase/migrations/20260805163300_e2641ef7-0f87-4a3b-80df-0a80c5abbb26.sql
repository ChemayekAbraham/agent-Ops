CREATE OR REPLACE FUNCTION public.auto_dispatch_withdrawals(p_batch_size integer DEFAULT 100)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_run_id uuid;
  v_dispatched int := 0;
  v_rec RECORD;
  v_agent_id uuid;
  v_cashout_agent_row_id uuid;
BEGIN
  INSERT INTO batch_processing_runs (run_type) VALUES ('auto_dispatch_withdrawals') RETURNING id INTO v_run_id;

  FOR v_rec IN
    SELECT wr.id, wr.amount, wr.payout_method, wr.mobile_money_provider, wr.bank_name
    FROM withdrawal_requests wr
    WHERE wr.status = 'cfo_approved'
      AND wr.assigned_cashout_agent_id IS NULL
      AND wr.auto_dispatched = false
    ORDER BY
      CASE WHEN wr.amount >= 500000 THEN 0 ELSE 1 END,
      wr.created_at ASC
    LIMIT p_batch_size
  LOOP
    UPDATE withdrawal_requests SET priority_level =
      CASE WHEN v_rec.amount >= 500000 THEN 'vip'
           WHEN v_rec.amount >= 100000 THEN 'high'
           ELSE 'standard' END
    WHERE id = v_rec.id;

    v_agent_id := NULL;
    v_cashout_agent_row_id := NULL;

    SELECT ca.agent_id, ca.id INTO v_agent_id, v_cashout_agent_row_id
    FROM cashout_agents ca
    WHERE ca.is_active = true
      AND ca.current_queue_count < ca.max_daily_payouts
      AND public.merchant_handles_payout(
            ca.agent_id, v_rec.payout_method, v_rec.mobile_money_provider, v_rec.bank_name
          )
    ORDER BY ca.current_queue_count ASC
    LIMIT 1;

    IF v_agent_id IS NOT NULL THEN
      UPDATE withdrawal_requests
      SET assigned_cashout_agent_id = v_cashout_agent_row_id,
          auto_dispatched = true,
          dispatched_at = now()
      WHERE id = v_rec.id;

      UPDATE cashout_agents
      SET current_queue_count = current_queue_count + 1
      WHERE agent_id = v_agent_id;

      v_dispatched := v_dispatched + 1;
    END IF;
  END LOOP;

  UPDATE batch_processing_runs
  SET completed_at = now(), records_processed = v_dispatched, records_dispatched = v_dispatched
  WHERE id = v_run_id;

  RETURN jsonb_build_object('run_id', v_run_id, 'dispatched', v_dispatched);
END;
$function$;