-- Manual intake of two MTN payments lost to the MTN SMS feed outage.
--
-- Payer: ROBERT MUGISHA (+256794402225, mobile money 0794402225), who has his own
-- Rent Plan and pays it from his wallet. There are two profiles named Robert Mugisha.
-- The other one (+256779166640) must not receive these.
--   TID 44312047263  UGX 20,000  paid 2026-10-17 20:52:47 EAT (till 090777)
--   TID 44336592658  UGX 20,000  paid 2026-10-18 19:20:10 EAT (till 090777)
-- Confirmed by the account holder and read from the MTN till statement of 2026-10-20.
-- Neither TID is in gmail_transactions, deposit_requests or ledger_reconciled_tids.
--
-- Inserts PENDING deposit requests only and moves no money. Run 20261020010100
-- next to register the TIDs as finance-verified, then approve.
--
-- Idempotent. One statement, no apostrophes or semicolons in comments.

INSERT INTO public.deposit_requests (
  user_id, amount, status, provider, transaction_id, deposit_purpose, notes
)
SELECT
  t.user_id, t.amount, 'pending', 'mtn', t.tid, t.purpose,
  'Manual intake 2026-10-20: MTN SMS feed outage, confirmed against MTN till 090777 statement.'
FROM (VALUES
  ('86eb32d3-43a5-462b-b698-186b83cec8d0'::uuid, '794402225', '44312047263', 20000::numeric, 'operational_float'::public.deposit_purpose),
  ('86eb32d3-43a5-462b-b698-186b83cec8d0'::uuid, '794402225', '44336592658', 20000::numeric, 'operational_float'::public.deposit_purpose)
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
