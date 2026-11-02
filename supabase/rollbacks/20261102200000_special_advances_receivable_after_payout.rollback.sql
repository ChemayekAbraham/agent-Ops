-- Rollback of 20261102200000_special_advances_receivable_after_payout. Needs explicit CFO approval.
-- Restores _special_advance_position to its Phase 4 definition (20261028153000), verbatim: an unpaid advance then
-- reports its agreed total as "outstanding" again. Read model only; no data, ledger or posting is touched.
-- Refuses (nothing changed) unless the live function is exactly the Phase A definition.
-- TRANSACTION: run as ONE transaction.

SET lock_timeout = '5s';
DO $pre$
BEGIN
  IF (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = 'public._special_advance_position(uuid)'::regprocedure)
       IS DISTINCT FROM 'b2515026024dcd7ff7b2744f58d35b27' THEN
    RAISE EXCEPTION 'precondition failed: _special_advance_position is not the Phase A definition; nothing was changed';
  END IF;
END
$pre$;

CREATE OR REPLACE FUNCTION public._special_advance_position(p_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH inst AS (
    SELECT i.number, i.due_date, i.amount, i.access_fee, i.registration_fee, i.principal,
           COALESCE(s.a, 0) AS paid_access, COALESCE(s.g, 0) AS paid_registration, COALESCE(s.p, 0) AS paid_principal
      FROM public.special_advance_instalments i
      LEFT JOIN (SELECT instalment_number, sum(access_fee) a, sum(registration_fee) g, sum(principal) p
                   FROM public.special_advance_repayment_allocations WHERE advance_id = p_id GROUP BY instalment_number) s
        ON s.instalment_number = i.number
     WHERE i.advance_id = p_id
  ), rows AS (
    SELECT *, amount - paid_access - paid_registration - paid_principal AS outstanding FROM inst
  )
  SELECT jsonb_build_object(
    'total_repayable', (SELECT total_repayable FROM public.special_advances WHERE id = p_id),
    'total_paid', COALESCE((SELECT sum(paid_access + paid_registration + paid_principal) FROM rows), 0),
    'outstanding', COALESCE((SELECT sum(outstanding) FROM rows), 0),
    'outstanding_access_fee', COALESCE((SELECT sum(access_fee - paid_access) FROM rows), 0),
    'outstanding_registration_fee', COALESCE((SELECT sum(registration_fee - paid_registration) FROM rows), 0),
    'outstanding_principal', COALESCE((SELECT sum(principal - paid_principal) FROM rows), 0),
    'overdue_amount', COALESCE((SELECT sum(outstanding) FROM rows WHERE due_date < public._special_advance_kampala_today() AND outstanding > 0), 0),
    'overdue_instalments', (SELECT count(*) FROM rows WHERE due_date < public._special_advance_kampala_today() AND outstanding > 0),
    'instalments', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'number', number, 'due_date', due_date, 'amount', amount,
        'paid', paid_access + paid_registration + paid_principal, 'outstanding', outstanding,
        'status', CASE WHEN outstanding = 0 THEN 'paid'
                       WHEN due_date IS NULL THEN 'not_due'
                       WHEN due_date < public._special_advance_kampala_today() THEN 'overdue'
                       WHEN outstanding < amount THEN 'part_paid' ELSE 'due' END) ORDER BY number) FROM rows), '[]'::jsonb));
$$;

RESET lock_timeout;
