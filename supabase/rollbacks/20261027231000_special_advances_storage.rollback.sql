-- Rollback of 20261027231000_special_advances_storage. Needs explicit CFO approval. Touches no ledger, wallet or
-- payment object and no existing advance product.
-- Refuses, changing nothing, while any Special Advance agreement or external borrower exists, unless the operator
-- deliberately discards them (export first): SET LOCAL special_advances.rollback_discard_data = 'yes';
-- Also refuses while later Special Advances phases still depend on these tables (roll those back first).
-- TRANSACTION: run as ONE transaction (by hand: BEGIN; ... COMMIT;).
SET lock_timeout = '5s';
DO $pre$
BEGIN
  IF to_regclass('public.special_advances') IS NULL THEN
    RAISE EXCEPTION 'precondition failed: 20261027231000_special_advances_storage is not applied; nothing was changed';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p
              WHERE p.pronamespace = 'public'::regnamespace
                AND p.proname NOT LIKE '\_special\_advance\_%' AND p.proname <> 'special_advance_cfo_ok'
                AND p.prosrc ~ 'special_advance(s|_instalments|_events|_settings|_external_borrowers)\b') THEN
    RAISE EXCEPTION 'precondition failed: other functions still use the Special Advances tables; roll back the later phases first';
  END IF;
  IF (EXISTS (SELECT 1 FROM public.special_advances) OR EXISTS (SELECT 1 FROM public.special_advance_external_borrowers))
     AND coalesce(current_setting('special_advances.rollback_discard_data', true), '') <> 'yes' THEN
    RAISE EXCEPTION 'precondition failed: Special Advances records exist; export them, then set special_advances.rollback_discard_data = yes to discard; nothing was changed';
  END IF;
END
$pre$;

DROP TABLE public.special_advance_events;
DROP TABLE public.special_advance_instalments;
DROP TABLE public.special_advances;
DROP TABLE public.special_advance_external_borrowers;
DROP TABLE public.special_advance_settings;
DROP SEQUENCE public.special_advance_ref_seq;
DROP FUNCTION public._special_advance_verify_agreement();
DROP FUNCTION public._special_advance_guard_instalment();
DROP FUNCTION public._special_advance_set_due_dates();
DROP FUNCTION public._special_advance_audit();
DROP FUNCTION public._special_advance_guard_update();
DROP FUNCTION public._special_advance_guard_insert();
DROP FUNCTION public._special_advance_block_mutation();
DROP FUNCTION public.special_advance_cfo_ok();
RESET lock_timeout;
