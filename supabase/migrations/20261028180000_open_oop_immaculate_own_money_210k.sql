-- Opens one own-money (OOP) claim of UGX 210,000 for merchant IMMACULATE NAMULINDWA (1a88b1b8-6601-477b-b119-8e18d5dc9ebd), 28 Oct 2026.
--
-- WHY: the "IMMY 210,000" line on her paper for 28 Oct is her own money. Management confirmed it. It is not tied to one customer payout, so the claim has no
-- withdrawal (withdrawal_id is empty). With this, what the company owes her for own-money payouts on the 28 Oct sheet is 17,476,500 + 210,000 = 17,686,500.
--
-- WHAT THIS DOES: records the debt only, as a finance-attested 'pending_reimbursement' claim. No wallet or float entries. It is settled like the others,
-- by the CFO, Financial Ops or a super admin (never by her), which credits her withdrawable wallet.
-- SAFE TO RE-RUN: skipped if it was already opened. Stops (and writes nothing) unless exactly one claim of UGX 210,000 exists afterwards.
-- Roll back with 20261028180000_open_oop_immaculate_own_money_210k.rollback.sql.

INSERT INTO public.merchant_out_of_pocket_advances
  (agent_id, withdrawal_id, kind, payout_amount, telecom_charge, float_used,
   shortfall_amount, status, note, attested_at, attested_by, evidence)
SELECT '1a88b1b8-6601-477b-b119-8e18d5dc9ebd', NULL, 'payout', 210000, 0, 0,
       210000, 'pending_reimbursement',
       'Her own money used on 28 Oct 2026 (the "IMMY 210,000" line on her desk sheet). Per management.',
       now(), 'cb798acb-68bc-4b4e-a414-a3d374e030b6',
       jsonb_build_object(
         'finance_attested', true,
         'attested_reason', 'Her own money, confirmed by management 28 Oct 2026',
         'opened_by_migration', '20261028180000_open_oop_immaculate_own_money_210k')
WHERE NOT EXISTS (
  SELECT 1 FROM public.merchant_out_of_pocket_advances
  WHERE evidence->>'opened_by_migration' = '20261028180000_open_oop_immaculate_own_money_210k'
);

DO $$
DECLARE
  v_rows integer;
  v_total numeric;
BEGIN
  SELECT count(*), COALESCE(sum(shortfall_amount), 0) INTO v_rows, v_total
  FROM public.merchant_out_of_pocket_advances
  WHERE agent_id = '1a88b1b8-6601-477b-b119-8e18d5dc9ebd'
    AND evidence->>'opened_by_migration' = '20261028180000_open_oop_immaculate_own_money_210k';

  IF v_rows <> 1 OR v_total <> 210000 THEN
    RAISE EXCEPTION 'Expected one claim of UGX 210,000, got % claims totalling UGX %. Nothing was written.', v_rows, v_total;
  END IF;
END $$;
