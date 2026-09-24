DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM public.ledger_account_map
   WHERE id='b9658591-5c93-4b4d-912d-ab1b89f0e1f0' AND category='partner_funding'
     AND ledger_scope='wallet' AND wallet_bucket='float' AND account_code='A2' AND debit_when='cash_out';
  IF n <> 1 THEN RAISE EXCEPTION 'Guard: expected float partner_funding A2 row not found in expected state (found %)', n; END IF;
  SELECT count(*) INTO n FROM public.ledger_account_map
   WHERE id='e3ba7afe-f803-49eb-8d7b-cf95082a710a' AND account_code='L6';
  IF n <> 1 THEN RAISE EXCEPTION 'Guard: pending_portfolio_topup L6 row missing'; END IF;

  UPDATE public.ledger_account_map
     SET account_code='L1', updated_at=now(),
         notes='Accounting-only correction 2026-09-24: float-bucket partner_funding wallet leg is a transfer out of partner custody (Dr L1 on cash_out), not company cash. Previously A2.'
   WHERE id='b9658591-5c93-4b4d-912d-ab1b89f0e1f0' AND account_code='A2';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'Guard: expected exactly 1 row updated, got %', n; END IF;
END $$;