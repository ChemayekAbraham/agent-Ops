-- Rollback of 20261027233000_special_advances_payout_repayment. Needs explicit CFO approval.
-- Only possible BEFORE anything was posted: it refuses (nothing changed) while any Special Advance has been paid out,
-- any repayment is recorded, or any general_ledger leg uses a special_advance_* category. Posted money is never
-- unwound by a schema rollback; that needs reversing entries, approved separately.
-- Removes: the payout / repayment functions, repayment tables, payout columns, the six mapping rows, account A20 and
-- the six allowlist categories (the allowlist body is restored to exactly what it was before this migration).
-- TRANSACTION: run as ONE transaction (by hand: BEGIN; ... COMMIT;).
SET lock_timeout = '5s';
DO $pre$
BEGIN
  IF to_regprocedure('public.special_advance_disburse(uuid,timestamptz,jsonb)') IS NULL THEN
    RAISE EXCEPTION 'precondition failed: 20261027233000 is not applied; nothing was changed';
  END IF;
  IF EXISTS (SELECT 1 FROM public.special_advances WHERE status IN ('disbursed', 'settled') OR payout_ledger_group_id IS NOT NULL)
     OR EXISTS (SELECT 1 FROM public.special_advance_repayments)
     OR EXISTS (SELECT 1 FROM public.general_ledger WHERE category LIKE 'special\_advance\_%') THEN
    RAISE EXCEPTION 'precondition failed: Special Advances have been posted to the ledger; a schema rollback cannot unwind posted money; nothing was changed';
  END IF;
END
$pre$;

DROP FUNCTION public.special_advance_reconciliation();
DROP FUNCTION public.special_advance_statement(uuid);
DROP FUNCTION public.special_advance_record_repayment(uuid, jsonb);
DROP FUNCTION public.special_advance_disburse(uuid, timestamptz, jsonb);
DROP FUNCTION public._special_advance_position(uuid);
DROP TABLE public.special_advance_repayment_allocations;
DROP TABLE public.special_advance_repayments;
DROP FUNCTION public._special_advance_verify_repayments();
DROP TRIGGER special_advances_guard_payout_fields ON public.special_advances;
DROP FUNCTION public._special_advance_guard_payout_fields();
ALTER TABLE public.special_advances DROP CONSTRAINT special_advances_payout_record;
ALTER TABLE public.special_advances DROP COLUMN payout_ledger_group_id, DROP COLUMN payout_reference, DROP COLUMN payout_method;

DELETE FROM public.ledger_account_map
 WHERE category IN ('special_advance_credit', 'special_advance_receivable', 'special_advance_payout_cash',
                    'special_advance_fee_revenue', 'special_advance_repayment_received', 'special_advance_repayment');
DELETE FROM public.ledger_account_catalog WHERE code = 'A20';

DO $allow$
DECLARE
  v_before text[] := public.ledger_category_allowlist();
  v_src text;
  v_expr text;
  v_after text[];
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = 'public.ledger_category_allowlist()'::regprocedure;
  v_expr := substring(v_src FROM '(?s)^\s*SELECT \((.*)\) \|\| ARRAY\[''special_advance_credit'', ''special_advance_receivable'', ''special_advance_payout_cash'',\s+''special_advance_fee_revenue'', ''special_advance_repayment_received'', ''special_advance_repayment''\]::text\[\];\s*$');
  IF v_expr IS NULL THEN
    RAISE EXCEPTION 'rollback failed: the allowlist was changed after this migration; restore it by hand';
  END IF;
  EXECUTE format($f$CREATE OR REPLACE FUNCTION public.ledger_category_allowlist()
    RETURNS text[] LANGUAGE sql IMMUTABLE AS $body$
  SELECT %s;
$body$$f$, v_expr);
  v_after := public.ledger_category_allowlist();
  IF cardinality(v_after) <> cardinality(v_before) - 6 OR NOT (v_before @> v_after)
     OR v_after && ARRAY['special_advance_credit', 'special_advance_receivable', 'special_advance_payout_cash',
                         'special_advance_fee_revenue', 'special_advance_repayment_received', 'special_advance_repayment'] THEN
    RAISE EXCEPTION 'rollback check failed: the allowlist was not restored exactly';
  END IF;
END
$allow$;
RESET lock_timeout;
