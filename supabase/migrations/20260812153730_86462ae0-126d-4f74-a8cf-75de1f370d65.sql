DO $$
DECLARE
  r record; v_msg text; v_cnt int := 0;
BEGIN
  FOR r IN
    SELECT w.id FROM public.withdrawal_requests w
    WHERE w.status IN ('paid','completed')
      AND (EXISTS (SELECT 1 FROM public.merchant_float_reservations mr WHERE mr.withdrawal_id=w.id)
        OR EXISTS (SELECT 1 FROM public.cashout_agents ca WHERE ca.is_active AND ca.agent_id IN (w.dispatch_claimed_by,w.processed_by,w.processing_started_by)))
      AND NOT EXISTS (SELECT 1 FROM public.merchant_payout_funding f WHERE f.withdrawal_id=w.id)
    LIMIT 3
  LOOP
    BEGIN
      PERFORM public.classify_merchant_payout_funding(r.id, 'probe');
      RAISE NOTICE 'ok %', r.id;
    EXCEPTION WHEN OTHERS THEN
      v_msg := SQLSTATE || ' ' || SQLERRM;
      RAISE NOTICE 'FAIL % -> %', r.id, v_msg;
    END;
    v_cnt := v_cnt + 1;
  END LOOP;
  RAISE NOTICE 'probed %', v_cnt;
END $$;