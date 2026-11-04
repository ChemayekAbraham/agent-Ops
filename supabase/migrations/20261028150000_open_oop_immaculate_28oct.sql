-- Opens own-money (OOP) claims for merchant IMMACULATE NAMULINDWA (1a88b1b8-6601-477b-b119-8e18d5dc9ebd), 28 Oct 2026.
--
-- WHY: she returned her float (UGX 5,143,200) to the merchant phone on 27 Oct, so she had none. On 28 Oct she paid 25 customer payouts from her own
-- money before the 13:00 float delivery (UGX 17,176,500), plus the UGX 300,000 okwii joel payout (still "processing"). The company owes her
-- UGX 17,476,500. Management confirmed this.
--
-- WHAT THIS DOES: records the debt only, as 'pending_reimbursement' claims marked finance_attested (the books show float at those times, so without
-- the attestation settle_merchant_out_of_pocket would skip them as "not_evidenced_by_books"). It moves no money: no wallet or float entries. CFO,
-- Financial Ops or a super admin (not her, not the owner of the claim) then settles them from the OOP screen, which credits her withdrawable wallet.
-- Her float stays at 98M. Do not also take this out of the 98M, or she is paid twice.
--
-- SAFE TO RE-RUN: a payout that already has a payout claim is skipped. If any are skipped, the totals check below fails and nothing is written.
-- Telecom fees (UGX 95,650) are separate claims that already exist and are not touched.
-- Roll back with 20261028150000_open_oop_immaculate_28oct.rollback.sql.

WITH src AS (
  SELECT w.id AS withdrawal_id, w.amount
  FROM public.withdrawal_requests w
  WHERE w.processed_by = '1a88b1b8-6601-477b-b119-8e18d5dc9ebd'
    AND w.status = 'completed'
    AND w.processed_at >= '2026-10-28 00:00+03'
    AND w.processed_at <  '2026-10-28 13:00+03'
  UNION ALL
  SELECT w.id, w.amount
  FROM public.withdrawal_requests w
  WHERE w.id = '2786c710-6c02-4353-996e-eb92dbf2c030'
)
INSERT INTO public.merchant_out_of_pocket_advances
  (agent_id, withdrawal_id, kind, payout_amount, telecom_charge, float_used,
   shortfall_amount, status, note, attested_at, attested_by, evidence)
SELECT '1a88b1b8-6601-477b-b119-8e18d5dc9ebd', s.withdrawal_id, 'payout', s.amount, 0, 0,
       s.amount, 'pending_reimbursement',
       'Paid from her own money on 28 Oct, before the 13:00 float delivery. Her float was returned to the merchant phone the day before (UGX 5,143,200). Per management.',
       now(), 'cb798acb-68bc-4b4e-a414-a3d374e030b6',
       jsonb_build_object(
         'finance_attested', true,
         'attested_reason', 'No float at the time of payout; confirmed by management 28 Oct 2026',
         'opened_by_migration', '20261028150000_open_oop_immaculate_28oct')
FROM src s
WHERE NOT EXISTS (
  SELECT 1 FROM public.merchant_out_of_pocket_advances o
  WHERE o.withdrawal_id = s.withdrawal_id AND o.kind = 'payout'
);

-- Stop (and write nothing) unless exactly the 26 expected claims, UGX 17,476,500, were opened.
DO $$
DECLARE
  v_rows integer;
  v_total numeric;
BEGIN
  SELECT count(*), COALESCE(sum(shortfall_amount), 0) INTO v_rows, v_total
  FROM public.merchant_out_of_pocket_advances
  WHERE agent_id = '1a88b1b8-6601-477b-b119-8e18d5dc9ebd'
    AND evidence->>'opened_by_migration' = '20261028150000_open_oop_immaculate_28oct';

  IF v_rows <> 26 OR v_total <> 17476500 THEN
    RAISE EXCEPTION 'Expected 26 claims totalling UGX 17,476,500, got % claims totalling UGX %. Nothing was written.', v_rows, v_total;
  END IF;
END $$;
