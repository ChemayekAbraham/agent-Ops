-- Manual intake of one MTN payment lost to the MTN SMS feed outage.
--
-- Payer: NATTU SHARIFAH (+256781515171), an agent with 18 Rent Plans and no Rent Plan of
-- her own, topping up operational float as in her earlier deposits.
--   TID 44296365338  UGX 50,000  paid 2026-10-17 11:53:44 EAT (till 090777)
-- Confirmed by the account holder and read from the MTN till statement of 2026-10-20.
-- The TID is not in gmail_transactions, deposit_requests or ledger_reconciled_tids.
--
-- Inserts a PENDING deposit request only and moves no money. Run 20261021020100 next to
-- register the TID as finance-verified, then approve.
--
-- Idempotent. One statement, no apostrophes or semicolons in comments.

INSERT INTO public.deposit_requests (
  user_id, amount, status, provider, transaction_id, deposit_purpose, notes
)
SELECT
  t.user_id, t.amount, 'pending', 'mtn', t.tid, t.purpose,
  'Manual intake 2026-10-21: MTN SMS feed outage, confirmed against MTN till 090777 statement.'
FROM (VALUES
  ('cc3bacad-ad59-412d-ac4d-df99aee61cb0'::uuid, '781515171', '44296365338', 50000::numeric, 'operational_float'::public.deposit_purpose)
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
