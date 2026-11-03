-- Removes the claims opened by 20261028150000_open_oop_immaculate_28oct.sql, only while none has been settled.
-- If any has been settled (status 'reimbursed') this stops: reverse that settlement first, do not delete it.
-- If the integrity trigger on this table refuses the delete, reject the claims instead with review_merchant_out_of_pocket (reason of 10+ characters).

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.merchant_out_of_pocket_advances
    WHERE evidence->>'opened_by_migration' = '20261028150000_open_oop_immaculate_28oct'
      AND status <> 'pending_reimbursement'
  ) THEN
    RAISE EXCEPTION 'Some of these claims are already settled or changed. Nothing was removed.';
  END IF;

  DELETE FROM public.merchant_out_of_pocket_advances
  WHERE evidence->>'opened_by_migration' = '20261028150000_open_oop_immaculate_28oct'
    AND status = 'pending_reimbursement';
END $$;
