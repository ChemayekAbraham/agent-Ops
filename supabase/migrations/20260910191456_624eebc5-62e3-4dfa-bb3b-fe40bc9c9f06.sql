DO $$
DECLARE
  r record;
  v_res jsonb;
  v_posted int := 0;
  v_total numeric := 0;
BEGIN
  FOR r IN
    SELECT ia.source_id AS collection_id,
           ROUND(COALESCE(ia.registration_fee_component,0) + COALESCE(ia.access_fee_component,0), 2) AS fee
    FROM public.instalment_allocations ia
    JOIN public.agent_collections c ON c.id = ia.source_id
    WHERE ia.source_table = 'agent_collections'
      AND c.reversed_at IS NULL
      AND ROUND(COALESCE(ia.registration_fee_component,0) + COALESCE(ia.access_fee_component,0), 2) > 0
      AND NOT EXISTS (
        SELECT 1 FROM public.general_ledger gl
        WHERE gl.source_table = 'agent_collections'
          AND gl.source_id = ia.source_id
          AND gl.ledger_scope = 'platform'
          AND gl.category = 'cash_receipt_in_transit'
          AND gl.direction = 'cash_in'
      )
  LOOP
    v_res := public.post_treasury_fee_cash_transfer(r.collection_id);
    IF v_res->>'status' = 'posted' THEN
      v_posted := v_posted + 1;
      v_total := v_total + r.fee;
    END IF;
    RAISE NOTICE 'collection % -> %', r.collection_id, v_res->>'status';
  END LOOP;

  RAISE NOTICE 'Treasury fee catch-up: % movements posted, total UGX %', v_posted, v_total;
END $$;