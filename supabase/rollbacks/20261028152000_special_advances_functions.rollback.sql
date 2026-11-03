-- Rollback of 20261028152000_special_advances_functions. Needs explicit CFO approval. Removes the CFO-only
-- functions, the one-open-advance index and the external identity constraint. Keeps every agreement, schedule and
-- event (those belong to the Phase 2 storage). Touches no ledger, wallet, payment or existing advance object.
-- Refuses while later phases still call these functions (roll those back first).
-- TRANSACTION: run as ONE transaction (by hand: BEGIN; ... COMMIT;).
SET lock_timeout = '5s';
DO $pre$
BEGIN
  IF to_regprocedure('public.special_advance_create(jsonb)') IS NULL THEN
    RAISE EXCEPTION 'precondition failed: 20261028152000_special_advances_functions is not applied; nothing was changed';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p
              WHERE p.pronamespace = 'public'::regnamespace
                AND p.proname NOT IN ('special_advance_quote', 'special_advance_create', 'special_advance_approve', 'special_advance_reject',
                                      'special_advance_cancel', 'special_advance_get', 'special_advance_list',
                                      '_special_advance_require_cfo', '_special_advance_issuance_enabled', '_special_advance_kampala_today',
                                      '_special_advance_norm_phone', '_special_advance_eligibility', '_special_advance_parse_borrower',
                                      '_special_advance_parse_terms', '_special_advance_json', '_special_advance_lock', '_special_advance_reason')
                AND p.prosrc ~ '_special_advance_(require_cfo|issuance_enabled|kampala_today|norm_phone|eligibility|parse_borrower|parse_terms|json|lock|reason)\(') THEN
    RAISE EXCEPTION 'precondition failed: later Special Advances phases still call these functions; roll those back first';
  END IF;
END
$pre$;
DROP FUNCTION public.special_advance_list(text, integer, integer);
DROP FUNCTION public.special_advance_get(uuid);
DROP FUNCTION public.special_advance_cancel(uuid, timestamptz, text);
DROP FUNCTION public.special_advance_reject(uuid, timestamptz, text);
DROP FUNCTION public.special_advance_approve(uuid, timestamptz, text);
DROP FUNCTION public.special_advance_create(jsonb);
DROP FUNCTION public.special_advance_quote(jsonb);
DROP FUNCTION public._special_advance_reason(text, boolean);
DROP FUNCTION public._special_advance_lock(uuid, timestamptz);
DROP FUNCTION public._special_advance_json(uuid);
DROP FUNCTION public._special_advance_parse_terms(jsonb, date);
DROP FUNCTION public._special_advance_parse_borrower(jsonb);
DROP FUNCTION public._special_advance_eligibility(text, uuid, text, text, text, uuid);
DROP FUNCTION public._special_advance_norm_phone(text);
DROP FUNCTION public._special_advance_kampala_today();
DROP FUNCTION public._special_advance_issuance_enabled();
DROP FUNCTION public._special_advance_require_cfo();
DROP INDEX public.special_advances_one_open_per_user;
ALTER TABLE public.special_advance_external_borrowers DROP CONSTRAINT special_advance_external_borrowers_identity;
RESET lock_timeout;
