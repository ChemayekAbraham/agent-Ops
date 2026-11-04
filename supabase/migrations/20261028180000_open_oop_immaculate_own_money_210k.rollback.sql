-- Removes the UGX 210,000 claim opened by 20261028180000_open_oop_immaculate_own_money_210k.sql, only while it is still unsettled.
-- If it has been settled (status 'reimbursed') this stops: reverse the settlement first, do not delete it.
-- If the integrity trigger on this table refuses the delete, reject the claim instead with review_merchant_out_of_pocket (reason of 10+ characters).

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.merchant_out_of_pocket_advances
    WHERE evidence->>'opened_by_migration' = '20261028180000_open_oop_immaculate_own_money_210k'
      AND status <> 'pending_reimbursement'
  ) THEN
    RAISE EXCEPTION 'The claim is already settled or changed. Nothing was removed.';
  END IF;

  DELETE FROM public.merchant_out_of_pocket_advances
  WHERE evidence->>'opened_by_migration' = '20261028180000_open_oop_immaculate_own_money_210k'
    AND status = 'pending_reimbursement';
END $$;
