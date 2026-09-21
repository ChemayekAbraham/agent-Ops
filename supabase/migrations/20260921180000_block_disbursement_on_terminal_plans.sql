-- APPLIED TO PRODUCTION 2026-09-21 ~18:45 UTC. Recorded here after the fact.
--
-- Control fix: refuse a rent disbursement on a terminal plan, whatever the
-- ledger count says.
--
-- WHY
-- `enforce_single_rent_disbursement` blocked a second disbursement by counting
-- legs: net(cash_out - cash_in) >= 1 on platform `rent_disbursement`. It never
-- looked at `rent_requests.status`.
--
-- That leaves a terminal plan unprotected once legitimate cash_in legs bring
-- the net below 1. Two real cases:
--   b6eba685  cancelled  net -2  (three duplicate-cleanup reversals, plus the
--                                 three from 20260921160000 -- since undone by
--                                 20260921170000, restoring net to +1)
--   4a71ad18  rejected   net  0  (one "CFO-approved allocation return" on
--                                 2026-07-30, plus three correct reversals
--                                 from 20260921160000)
--
-- 4a71ad18's prior cash_in is a genuine business event, not duplicate cleanup,
-- so its reversals are correct and must NOT be undone. Its net of 0 is the
-- arithmetic consequence of four legitimately distinct cash_in legs -- not an
-- accounting error, but a guard whose logic does not fit that shape.
--
-- THE FIX
-- A status predicate before the existing count logic. Strictly additive: it
-- only ever raises where the guard previously permitted, and can never allow
-- anything the count rule blocked. It fixes the class, not the two instances --
-- every terminal plan is now protected.
--
-- Control-only. No INSERT/UPDATE/DELETE against any financial or operational
-- table. No ledger row, wallet, repayment or balance touched.
--
-- VERIFIED on a rolled-back transaction:
--   terminal plan 4a71ad18 (rejected) -> blocked,
--     "Rent request 4a71ad18... is rejected — disbursement refused"
--   active plan c62755d0 (net < 1)    -> accepted, no error
--   assert_money_path_intact() 17/17, npm run guard:all all passed.

CREATE OR REPLACE FUNCTION public.enforce_single_rent_disbursement()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_net    integer;
  v_status text;
BEGIN
  IF NEW.category <> 'rent_disbursement'
     OR NEW.ledger_scope <> 'platform'
     OR NEW.direction <> 'cash_out'
     OR NEW.source_table <> 'rent_requests'
     OR NEW.source_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Terminal plans can never be disbursed, whatever the ledger count says.
  -- Added 2026-09-21: the net-count test alone leaves a terminal plan
  -- unprotected once legitimate cash_in reversals bring the net below 1
  -- (e.g. a CFO-approved allocation return, or duplicate cleanup).
  SELECT rr.status INTO v_status
    FROM public.rent_requests rr
   WHERE rr.id = NEW.source_id;

  IF v_status IN ('rejected', 'cancelled', 'deleted_by_agent') THEN
    RAISE EXCEPTION 'Rent request % is % — disbursement refused', NEW.source_id, v_status
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT COALESCE(SUM(CASE WHEN direction = 'cash_out' THEN 1 ELSE -1 END), 0)
    INTO v_net
  FROM public.general_ledger
  WHERE source_id = NEW.source_id
    AND source_table = 'rent_requests'
    AND category = 'rent_disbursement'
    AND ledger_scope = 'platform';

  IF v_net >= 1 THEN
    RAISE EXCEPTION 'Rent request % is already funded in the ledger (duplicate rent_disbursement blocked)', NEW.source_id
      USING ERRCODE = 'unique_violation';
  END IF;

  RETURN NEW;
END;
$function$;
