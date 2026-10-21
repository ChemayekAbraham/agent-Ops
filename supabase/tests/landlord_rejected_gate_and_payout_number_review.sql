-- Landlord rejected gate and payout-number review (20261020170000_landlord_rejected_gate_and_payout_number_review.sql).
-- One DO block that ends in an exception, so NOTHING is kept; the report is the exception message. Run AFTER the migration is applied.
-- (A) a Rent Plan at the Landlord Ops desk cannot move forward while its landlord is rejected, and the message names the landlord and reason;
-- (B) rejecting that Rent Plan is still allowed; (C) once the landlord is verified again the same move is allowed;
-- (D) the review list returns rows for a Landlord Ops user and is refused for a normal agent; (E) confirm only accepts a number already on the record.
DO $$
DECLARE
  rr record; lo uuid; plain uuid; msg text := ''; blocked boolean := false; e text; ok boolean; st text; r record; cnt int; picked text; res jsonb;
BEGIN
  SELECT id, landlord_id INTO rr FROM rent_requests WHERE status = 'tenant_ops_approved' AND landlord_id IS NOT NULL LIMIT 1;
  IF rr.id IS NULL THEN RAISE EXCEPTION 'No Rent Plan at the Landlord Ops desk to test with'; END IF;

  PERFORM set_config('landlord_verification.sync_authorized', 'true', true);
  UPDATE landlords SET verification_status = 'rejected', verification_reason = 'Number for landlord is unreachable' WHERE id = rr.landlord_id;
  PERFORM set_config('landlord_verification.sync_authorized', 'false', true);

  BEGIN UPDATE rent_requests SET status = 'landlord_ops_approved', landlord_ops_reviewed_at = now() WHERE id = rr.id;
  EXCEPTION WHEN check_violation THEN blocked := true; e := SQLERRM; END;
  msg := msg || format(E'\n(A) forward move blocked=%s  [expect true]  message: %s', blocked, left(e, 140));

  ok := true;
  BEGIN UPDATE rent_requests SET status = 'rejected', landlord_ops_reviewed_at = now() WHERE id = rr.id;
  EXCEPTION WHEN OTHERS THEN ok := false; e := SQLERRM; END;
  SELECT status INTO st FROM rent_requests WHERE id = rr.id;
  msg := msg || format(E'\n(B) reject allowed=%s status=%s  [expect true / rejected]', ok, st);

  -- (C) re-verify the landlord, put the Rent Plan back at the desk, and the same move must pass
  PERFORM set_config('landlord_verification.sync_authorized', 'true', true);
  UPDATE landlords SET verification_status = 'verified', verified = true WHERE id = rr.landlord_id;
  PERFORM set_config('landlord_verification.sync_authorized', 'false', true);
  UPDATE rent_requests SET status = 'tenant_ops_approved', landlord_ops_reviewed_at = NULL WHERE id = rr.id;
  ok := true;
  BEGIN UPDATE rent_requests SET status = 'landlord_ops_approved', landlord_ops_reviewed_at = now() WHERE id = rr.id;
  EXCEPTION WHEN check_violation THEN ok := false; e := SQLERRM; END;
  msg := msg || format(E'\n(C) after re-verification the move is allowed=%s  [expect true]', ok);

  -- (D) access
  SELECT user_id INTO lo FROM user_roles WHERE role::text = 'landlord_ops' AND COALESCE(enabled, true) LIMIT 1;
  SELECT u.id INTO plain FROM profiles u WHERE NOT EXISTS (SELECT 1 FROM user_roles ur WHERE ur.user_id = u.id AND ur.role::text IN ('landlord_ops','manager','super_admin','coo','operations','cto')) LIMIT 1;
  PERFORM set_config('request.jwt.claim.sub', lo::text, true);
  SELECT count(*) INTO cnt FROM get_landlord_payout_number_review(NULL, 500, 0);
  msg := msg || format(E'\n(D1) Landlord Ops sees %s review rows  [expect > 0 while backfill mismatches remain]', cnt);
  PERFORM set_config('request.jwt.claim.sub', plain::text, true);
  ok := false;
  BEGIN PERFORM * FROM get_landlord_payout_number_review(NULL, 5, 0); EXCEPTION WHEN OTHERS THEN ok := true; END;
  msg := msg || format(E'\n(D2) normal user refused=%s  [expect true]', ok);

  -- (E) confirm: a number that is not on the record is refused; one that is on the record is accepted
  PERFORM set_config('request.jwt.claim.sub', lo::text, true);
  SELECT l.id, COALESCE(NULLIF(btrim(l.mobile_money_number), ''), l.phone) AS onfile INTO r
    FROM landlords l WHERE l.verification_status = 'verified' AND COALESCE(NULLIF(btrim(l.mobile_money_number), ''), l.phone) IS NOT NULL LIMIT 1;
  ok := false;
  BEGIN PERFORM confirm_landlord_payout_number(r.id, '0700000000', 'Test of a number that is not on the record'); EXCEPTION WHEN OTHERS THEN ok := true; END;
  msg := msg || format(E'\n(E1) number not on the record refused=%s  [expect true]', ok);
  res := confirm_landlord_payout_number(r.id, r.onfile, 'Test confirmation of the number on the record');
  msg := msg || format(E'\n(E2) number on the record accepted=%s approved=%s source=%s  [expect true / same number / payout_number_reconcile]',
    res->>'ok', res->>'approved_number', (SELECT verified_mobile_money_source FROM landlords WHERE id = r.id));

  RAISE EXCEPTION E'landlord_rejected_gate_and_payout_number_review test report (rolled back):%', msg;
END $$;
