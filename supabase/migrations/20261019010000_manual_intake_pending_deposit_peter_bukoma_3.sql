-- Manual intake of one MTN payment lost to the MTN SMS feed outage.
--
-- Payer: PETER BUKOMA (+256791844340, mobile money 0791844340), an agent topping up
-- operational float, as in his earlier deposits.
--   TID 44335320021  UGX 20,000  paid 2026-10-18 18:45 EAT (till 090777)
-- Read from a payer-side SMS screenshot. The TID is not in gmail_transactions,
-- deposit_requests or ledger_reconciled_tids.
--
-- Inserts a PENDING deposit request only and moves no money. Run 20261019010100
-- next to register the TID as finance-verified, then approve. Check the TID on
-- the MTN till 090777 statement first.
--
-- Idempotent. One statement, no apostrophes or semicolons in comments.

INSERT INTO public.deposit_requests (
  user_id, amount, status, provider, transaction_id, deposit_purpose, notes
)
SELECT
  t.user_id, t.amount, 'pending', 'mtn', t.tid, t.purpose,
  'Manual intake 2026-10-19: MTN SMS feed outage, payer-side SMS. Verify TID on till 090777 statement before approving.'
FROM (VALUES
  ('35fba2e3-bb3d-45b2-a0a8-f5db3acdf251'::uuid, '791844340', '44335320021', 20000::numeric, 'operational_float'::public.deposit_purpose)
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
