-- Manual intake of two MTN payments lost to the MTN SMS feed outage.
--
-- Payer: ANNET NABUTSALE (+256784773880), an agent with 21 Rent Plans and no Rent Plan of
-- her own, topping up operational float as in her earlier deposits. She is the only
-- profile with this name.
--   TID 44302867702  UGX 16,000  paid 2026-10-17 16:15:16 EAT
--   TID 44332406991  UGX 40,000  paid 2026-10-18 17:03:01 EAT
-- Read from payer-side SMS screenshots and matched to the MTN till statement of 2026-10-20.
-- Neither TID is in gmail_transactions, deposit_requests or ledger_reconciled_tids.
--
-- Inserts PENDING deposit requests only and moves no money. Run 20261021010100 next to
-- register the TIDs as finance-verified, then approve.
--
-- Idempotent. One statement, no apostrophes or semicolons in comments.

INSERT INTO public.deposit_requests (
  user_id, amount, status, provider, transaction_id, deposit_purpose, notes
)
SELECT
  t.user_id, t.amount, 'pending', 'mtn', t.tid, t.purpose,
  'Manual intake 2026-10-21: MTN SMS feed outage, confirmed against MTN till 090777 statement and payer SMS.'
FROM (VALUES
  ('ed3168bf-c97c-4cb9-9520-542493f99a6b'::uuid, '784773880', '44302867702', 16000::numeric, 'operational_float'::public.deposit_purpose),
  ('ed3168bf-c97c-4cb9-9520-542493f99a6b'::uuid, '784773880', '44332406991', 40000::numeric, 'operational_float'::public.deposit_purpose)
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
