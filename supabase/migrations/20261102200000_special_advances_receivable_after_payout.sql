-- 2026-11-02: Special Advances readiness, Phase A. Production apply needs explicit CFO approval.
-- An advance is a receivable only once it has been paid out. Until now _special_advance_position reported the whole
-- agreed total as "outstanding" for an advance that was only pending approval, approved, rejected or cancelled (read-only
-- audit 2026-11-02: UGX 238,000 for an approved, unpaid advance), and the CFO statement screen showed that figure.
-- The reconciliation (A24) already counted paid-out advances only and is not changed.
--
-- Change (this function only; no table, ledger, mapping, account or posting changes):
--   * new field paid_out: true for status disbursed / settled;
--   * new field scheduled_outstanding: the agreed schedule still unpaid (what "outstanding" used to show);
--   * outstanding, outstanding_access_fee, outstanding_registration_fee, outstanding_principal, overdue_amount and
--     overdue_instalments are 0 until the advance is paid out; after payout they are exactly as before;
--   * total_repayable, total_paid and the per-instalment rows are unchanged.
-- Callers checked: special_advance_record_repayment, the settlement check and special_advance_disburse only read the
-- position of a paid-out advance (same figures as before); special_advance_reconciliation filters to disbursed /
-- settled (same figures); special_advance_statement and the CFO detail sheet now show 0 receivable before payout.
--
-- Preflight refuses (nothing changed) unless the live function is exactly the Phase 4 definition (md5 of its body,
-- read-only check 2026-11-02). CREATE OR REPLACE keeps its owner and privileges (no client may execute it).
-- Rollback: supabase/rollbacks/20261102200000_special_advances_receivable_after_payout.rollback.sql
-- Tests: src/test/specialAdvancePayout.test.ts, describe "Receivable only after payout (Phase A)".
-- TRANSACTION: run as ONE transaction.

SET lock_timeout = '5s';
DO $pre$
BEGIN
  IF to_regprocedure('public._special_advance_position(uuid)') IS NULL THEN
    RAISE EXCEPTION 'precondition failed: Special Advances Phase 4 (20261028153000) is not applied; nothing was changed';
  END IF;
  IF (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = 'public._special_advance_position(uuid)'::regprocedure)
       IS DISTINCT FROM '2a4a08a6f1ce3c56aed9c2344ffaa1eb' THEN
    RAISE EXCEPTION 'precondition failed: _special_advance_position differs from the Phase 4 definition; nothing was changed';
  END IF;
END
$pre$;

CREATE OR REPLACE FUNCTION public._special_advance_position(p_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH adv AS (
    SELECT a.total_repayable, a.status IN ('disbursed', 'settled') AS paid_out
      FROM public.special_advances a WHERE a.id = p_id
  ), inst AS (
    SELECT i.number, i.due_date, i.amount, i.access_fee, i.registration_fee, i.principal,
           COALESCE(s.a, 0) AS paid_access, COALESCE(s.g, 0) AS paid_registration, COALESCE(s.p, 0) AS paid_principal
      FROM public.special_advance_instalments i
      LEFT JOIN (SELECT instalment_number, sum(access_fee) a, sum(registration_fee) g, sum(principal) p
                   FROM public.special_advance_repayment_allocations WHERE advance_id = p_id GROUP BY instalment_number) s
        ON s.instalment_number = i.number
     WHERE i.advance_id = p_id
  ), rows AS (
    SELECT *, amount - paid_access - paid_registration - paid_principal AS outstanding FROM inst
  ), g AS (
    SELECT COALESCE((SELECT paid_out FROM adv), false) AS paid_out
  )
  SELECT jsonb_build_object(
    'total_repayable', (SELECT total_repayable FROM adv),
    'paid_out', g.paid_out,
    'scheduled_outstanding', COALESCE((SELECT sum(outstanding) FROM rows), 0),
    'total_paid', COALESCE((SELECT sum(paid_access + paid_registration + paid_principal) FROM rows), 0),
    'outstanding', CASE WHEN g.paid_out THEN COALESCE((SELECT sum(outstanding) FROM rows), 0) ELSE 0 END,
    'outstanding_access_fee', CASE WHEN g.paid_out THEN COALESCE((SELECT sum(access_fee - paid_access) FROM rows), 0) ELSE 0 END,
    'outstanding_registration_fee', CASE WHEN g.paid_out THEN COALESCE((SELECT sum(registration_fee - paid_registration) FROM rows), 0) ELSE 0 END,
    'outstanding_principal', CASE WHEN g.paid_out THEN COALESCE((SELECT sum(principal - paid_principal) FROM rows), 0) ELSE 0 END,
    'overdue_amount', CASE WHEN g.paid_out THEN COALESCE((SELECT sum(outstanding) FROM rows WHERE due_date < public._special_advance_kampala_today() AND outstanding > 0), 0) ELSE 0 END,
    'overdue_instalments', CASE WHEN g.paid_out THEN (SELECT count(*) FROM rows WHERE due_date < public._special_advance_kampala_today() AND outstanding > 0) ELSE 0 END,
    'instalments', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'number', number, 'due_date', due_date, 'amount', amount,
        'paid', paid_access + paid_registration + paid_principal, 'outstanding', outstanding,
        'status', CASE WHEN outstanding = 0 THEN 'paid'
                       WHEN due_date IS NULL THEN 'not_due'
                       WHEN due_date < public._special_advance_kampala_today() THEN 'overdue'
                       WHEN outstanding < amount THEN 'part_paid' ELSE 'due' END) ORDER BY number) FROM rows), '[]'::jsonb))
  FROM g;
$$;

-- The replacement must keep the function internal: owner rights, fixed search_path, no client execute.
DO $post$
BEGIN
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = 'public._special_advance_position(uuid)'::regprocedure)
     OR (SELECT proconfig FROM pg_proc WHERE oid = 'public._special_advance_position(uuid)'::regprocedure) IS DISTINCT FROM ARRAY['search_path=public']
     OR has_function_privilege('authenticated', 'public._special_advance_position(uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public._special_advance_position(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'postcondition failed: _special_advance_position lost its security settings; nothing was changed';
  END IF;
END
$post$;

RESET lock_timeout;
