-- Puts the 15 plans back to the figures they had before 20261023190000_restore_kwenseri_tenant_balances.sql.
DO $rb$
DECLARE r record;
BEGIN
  FOR r IN SELECT * FROM public.rent_balance_correction_20261023 LOOP
    IF r.registration_type = 'outstanding_balance' THEN
      UPDATE public.rent_requests SET initial_outstanding_balance = r.old_initial_outstanding WHERE id = r.rent_request_id;
    ELSE
      UPDATE public.rent_requests SET total_repayment = r.old_total_repayment, daily_repayment = r.old_daily_repayment WHERE id = r.rent_request_id;
    END IF;
  END LOOP;
END
$rb$;
-- DROP TABLE public.rent_balance_correction_20261023;  -- keep until you are sure
