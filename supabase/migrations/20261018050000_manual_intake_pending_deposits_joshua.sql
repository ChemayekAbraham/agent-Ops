-- Manual intake of two MTN payments lost to the MTN SMS feed outage.
--
-- Payer: JOSHUA BALIRAINE (+256786793933), an agent topping up operational float.
-- He has no Rent Plan of his own, so purpose is operational_float.
--   TID 44310577634  UGX 7,000  paid 2026-10-17 evening (till 090777)
--   TID 44312237576  UGX 2,000  paid 2026-10-17 20:59:27 EAT
-- Both were read from payer-side SMS screenshots. Neither TID is in
-- gmail_transactions, deposit_requests or ledger_reconciled_tids.
--
-- Inserts PENDING deposit requests only and moves no money. Run
-- 20261018050100 next to register the TIDs as finance-verified, then approve.
-- Check both TIDs on the MTN till 090777 statement first.
--
-- Idempotent. One statement, no apostrophes or semicolons in comments.

INSERT INTO public.deposit_requests (
  user_id, amount, status, provider, transaction_id, deposit_purpose, notes
)
SELECT
  t.user_id, t.amount, 'pending', 'mtn', t.tid, t.purpose,
  'Manual intake 2026-10-18: MTN SMS feed outage, payer-side SMS. Verify TID on till 090777 statement before approving.'
FROM (VALUES
  ('bbd290dd-4e97-4524-9853-86eb01851edf'::uuid, '786793933', '44310577634', 7000::numeric, 'operational_float'::public.deposit_purpose),
  ('bbd290dd-4e97-4524-9853-86eb01851edf'::uuid, '786793933', '44312237576', 2000::numeric, 'operational_float'::public.deposit_purpose)
) AS t(user_id, phone_last9, tid, amount, purpose)
JOIN public.profiles p
  ON p.id = t.user_id
 AND right(regexp_replace(coalesce(p.phone, ''), '\D', '', 'g'), 9) = t.phone_last9
WHERE NOT EXISTS (
        SELECT 1 FROM public.deposit_requests d
         WHERE regexp_replace(lower(btrim(d.transaction_id)), '^tid', '') = t.tid
           AND d.status NOT IN ('rejected', 'cancelled', 'failed')
      )
  AND NOT EXISTS (
        SELECT 1 FROM public.ledger_reconciled_tids l
         WHERE l.tid_normalized = t.tid
      );
