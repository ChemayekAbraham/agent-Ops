-- Landlord payout number must match the landlord's record (20261022100000_landlord_payout_number_must_match_record.sql).
-- One DO block that ends in an exception, so NOTHING is kept; the report is the exception message. Run AFTER the migration is applied,
-- and between 06:00 and 22:00 Africa/Kampala (the payout trigger refuses outside those hours before it reaches the number check).
-- (A) a payout to the approved number that differs from the registered number is refused with PAYOUT_NUMBER_MISMATCH;
-- (B) a payout to a number that matches both is not refused for the number (it may still stop on float, which is a different check);
-- (C) confirm_landlord_payout_number refuses a number that is not the registered payout number and accepts the registered one,
--     after which (A)'s landlord is no longer refused for the number.
DO $$
DECLARE
  bad record; good record; msg text := ''; e text; lo uuid; res jsonb; hit boolean;
BEGIN
  SELECT l.id, l.verified_mobile_money_number AS approved, COALESCE(NULLIF(btrim(l.mobile_money_number), ''), l.phone) AS onfile
    INTO bad FROM landlords l
   WHERE l.verification_status = 'verified' AND l.verified = true AND COALESCE(l.verified_mobile_money_number, '') <> ''
     AND right(regexp_replace(l.verified_mobile_money_number, '\D', '', 'g'), 9) <> right(regexp_replace(COALESCE(NULLIF(btrim(l.mobile_money_number), ''), l.phone, ''), '\D', '', 'g'), 9)
   LIMIT 1;
  SELECT l.id, l.verified_mobile_money_number AS approved INTO good FROM landlords l
   WHERE l.verification_status = 'verified' AND l.verified = true AND COALESCE(l.verified_mobile_money_number, '') <> ''
     AND right(regexp_replace(l.verified_mobile_money_number, '\D', '', 'g'), 9) = right(regexp_replace(COALESCE(NULLIF(btrim(l.mobile_money_number), ''), l.phone, ''), '\D', '', 'g'), 9)
   LIMIT 1;

  hit := false;
  BEGIN INSERT INTO landlord_payouts (landlord_id, landlord_phone, amount) VALUES (bad.id, bad.approved, 1000);
  EXCEPTION WHEN check_violation THEN e := SQLERRM; hit := e LIKE 'PAYOUT_NUMBER_MISMATCH%'; WHEN OTHERS THEN e := SQLERRM; END;
  msg := msg || format(E'\n(A) approved-differs landlord refused with PAYOUT_NUMBER_MISMATCH=%s  [expect true]  (%s)', hit, left(COALESCE(e, ''), 90));

  hit := false; e := NULL;
  BEGIN INSERT INTO landlord_payouts (landlord_id, landlord_phone, amount) VALUES (good.id, good.approved, 1000);
  EXCEPTION WHEN OTHERS THEN e := SQLERRM; END;
  msg := msg || format(E'\n(B) matching landlord refused for the number=%s  [expect false]  (%s)', COALESCE(e, '') LIKE 'PAYOUT_NUMBER_MISMATCH%', left(COALESCE(e, 'no error'), 90));

  SELECT user_id INTO lo FROM user_roles WHERE role::text = 'landlord_ops' AND COALESCE(enabled, true) LIMIT 1;
  PERFORM set_config('request.jwt.claim.sub', lo::text, true);
  hit := false;
  BEGIN PERFORM confirm_landlord_payout_number(bad.id, bad.approved, 'Test: the approved number is not the registered one');
  EXCEPTION WHEN OTHERS THEN hit := true; END;
  msg := msg || format(E'\n(C1) confirming the non-registered approved number refused=%s  [expect true]', hit);
  res := confirm_landlord_payout_number(bad.id, bad.onfile, 'Test: confirming the number on the landlord record');
  msg := msg || format(E'\n(C2) confirming the registered number ok=%s approved now=%s  [expect true]', res->>'ok', res->>'approved_number');
  hit := false; e := NULL;
  BEGIN INSERT INTO landlord_payouts (landlord_id, landlord_phone, amount) VALUES (bad.id, bad.onfile, 1000);
  EXCEPTION WHEN OTHERS THEN e := SQLERRM; END;
  msg := msg || format(E'\n(C3) after reconciling, refused for the number=%s  [expect false]  (%s)', COALESCE(e, '') LIKE 'PAYOUT_NUMBER_MISMATCH%', left(COALESCE(e, 'no error'), 90));

  RAISE EXCEPTION E'landlord_payout_number_must_match_record test report (rolled back):%', msg;
END $$;
