-- PHASE 2 (G7): APPLIED 2026-09-08.
--
-- All three pre-checks below were run before applying: (1) confirmed
-- auto_assign_ledger_scope() respects an explicitly-set ledger_scope and does
-- not override 'platform' for the new leg; (2) dry-ran one real collection
-- inside BEGIN...ROLLBACK -- confirmed the new leg posts as
-- category='tenant_repayment'/ledger_scope='platform', and
-- ledger_account_map confirms that combination maps to A3 with
-- debit_when='cash_out', so the cash_in leg now CREDITS A3 instead of
-- debiting it; (3) confirmed the collection path completes end to end
-- (float debited, commission credited, outstanding balance reduced
-- correctly). Applied for real immediately after, via the same DO block
-- below, against production (project 43e6c2e1-18a6-4503-badb-5bb6c23491cc).
-- Verified live: the function body no longer contains 'rent_receivable_created'.
--
-- THE DEFECT
-- public.agent_allocate_tenant_payment_internal() posts a tenant collection as:
--     bridge.rent_receivable_created / cash_in  ->  DR A3
-- A3 is Rent Access Receivables. debit_when for bridge.rent_receivable_created
-- is 'cash_in', so a cash_in leg DEBITS A3 - i.e. every collection INCREASES the
-- tenant receivable instead of clearing it. Population to date:
-- 10,774 legs / UGX 274,332,954 (2026-05-09 .. 2026-09-07).
--
-- THE FIX
-- Re-point that single leg to the convention tenant-pay-rent already uses
-- correctly:
--     platform.tenant_repayment / cash_in  ->  CR A3
-- platform.tenant_repayment maps to A3 with debit_when 'cash_out', so the SAME
-- raw direction (cash_in) now produces a CREDIT. Keeping the raw direction
-- unchanged is deliberate: it preserves the group's raw cash_in/cash_out balance,
-- so the existing raw-direction control in create_ledger_transaction still passes
-- while the mapped DR/CR treatment is corrected.
--
-- SCOPE
-- Prospective only. This rewrites NO historical row. The existing 10,774 legs
-- remain exactly as posted and are surfaced by v_g7_receivable_direction_defect.
-- Historical remediation is a separate, append-only, separately-approved phase.
--
-- BEFORE APPLYING
--   1. Confirm auto_assign_ledger_scope() does not override ledger_scope for
--      category 'tenant_repayment' (it would defeat the fix silently).
--   2. Dry-run one collection inside BEGIN ... SET CONSTRAINTS ALL IMMEDIATE ...
--      ROLLBACK and confirm the group balances on BOTH the raw-direction and the
--      mapped DR/CR controls, and that A3 is credited.
--   3. Confirm the collection path still completes end to end.

DO $do$
DECLARE
  v_def text; v_new text; v_cnt int;
  v_old text := E'''category'', ''rent_receivable_created'',\n      ''ledger_scope'', ''bridge'',';
  v_rep text := E'''category'', ''tenant_repayment'',\n      ''ledger_scope'', ''platform'',';
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'agent_allocate_tenant_payment_internal';
  IF v_def IS NULL THEN RAISE EXCEPTION 'agent_allocate_tenant_payment_internal not found'; END IF;

  IF position('''rent_receivable_created''' in v_def) = 0 THEN
    RAISE NOTICE 'G7 already fixed - skipping';
    RETURN;
  END IF;

  v_cnt := (length(v_def) - length(replace(v_def, v_old, ''))) / NULLIF(length(v_old), 0);
  IF v_cnt <> 1 THEN
    RAISE EXCEPTION 'expected exactly 1 occurrence of the defective leg, found % - aborting rather than guessing', v_cnt;
  END IF;

  EXECUTE replace(v_def, v_old, v_rep);
  RAISE NOTICE 'G7 prospective fix applied';
END $do$;
