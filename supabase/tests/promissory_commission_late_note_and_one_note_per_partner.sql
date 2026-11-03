-- Promissory commission: late notes count, one approved note per partner (20261023100000_promissory_commission_late_note_and_one_note_per_partner.sql).
-- One DO block that ends in an exception, so NOTHING is kept; the report is the exception message. Run AFTER the migration is applied.
-- (1) An unattributed fund-in whose approved note was created after the money is attributed to that note's agent and paid once at the rate in force;
--     a second call is a no-op (status paid) and the ledger has exactly one pair for the fund-in key.
-- (2) A pending note whose partner already has an approved note cannot be approved (NOTE_ALREADY_APPROVED).
-- (3) A fund-in with no approved note stays unattributed (commission is paid on promissory notes only).
DO $$
DECLARE
  fi record; res jsonb; res2 jsonb; msg text := ''; pend record; blocked text; nonote record;
BEGIN
  SELECT f.id, f.fund_in_key INTO fi
    FROM commission_fund_ins f
   WHERE f.status = 'unattributed'
     AND EXISTS (SELECT 1 FROM commission_resolve_earner(f.partner_id, f.occurred_at, true) e WHERE e.earner_id IS NOT NULL)
   LIMIT 1;
  IF fi.id IS NULL THEN
    msg := msg || E'\n(1) skipped: no unattributed fund-in currently has an approved late note';
  ELSE
    res := commission_pay_fund_in(fi.id);
    res2 := commission_pay_fund_in(fi.id);
    msg := msg || format(E'\n(1) first call=%s\n    second call=%s  ledger rows for the key=%s  [expect paid / skipped status_paid / 2]',
      res::text, res2::text, (SELECT count(*) FROM general_ledger WHERE idempotency_key = 'fund_in_commission:' || fi.fund_in_key));
  END IF;

  SELECT n.id AS pid INTO pend FROM promissory_notes n JOIN promissory_notes m ON m.id <> n.id AND coalesce(m.approval_bonus_paid, false)
      AND promissory_note_same_partner(n, m) WHERE coalesce(n.approval_bonus_paid, false) = false LIMIT 1;
  IF pend.pid IS NULL THEN
    msg := msg || E'\n(2) skipped: no pending note shares a partner with an approved note';
  ELSE
    BEGIN UPDATE promissory_notes SET approval_bonus_paid = true WHERE id = pend.pid; blocked := 'NOT BLOCKED';
    EXCEPTION WHEN check_violation THEN blocked := left(SQLERRM, 70); END;
    msg := msg || format(E'\n(2) approving a duplicate note -> %s  [expect NOTE_ALREADY_APPROVED...]', blocked);
  END IF;

  SELECT f.id INTO nonote FROM commission_fund_ins f
   WHERE f.status = 'unattributed' AND NOT EXISTS (SELECT 1 FROM commission_resolve_earner(f.partner_id, f.occurred_at, true) e WHERE e.earner_id IS NOT NULL) LIMIT 1;
  IF nonote.id IS NOT NULL THEN
    msg := msg || format(E'\n(3) fund-in with no approved note -> %s  [expect skipped no_earner_yet]', commission_pay_fund_in(nonote.id)::text);
  END IF;
  RAISE EXCEPTION E'promissory_commission_late_note_and_one_note_per_partner test report (rolled back):%', msg;
END $$;
