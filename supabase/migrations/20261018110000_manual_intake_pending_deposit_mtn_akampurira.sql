-- Manual intake of one MTN payment lost to the MTN SMS feed outage.
--
-- TID 44342798510, UGX 40,000, paid 2026-10-18 22:13 EAT to WELILE TECHNOLOGIES
-- LIMITED (till 090777) by ONESMUS AKAMPURIRA (+256779332561), an agent topping up
-- operational float, as in his earlier deposits. He has no Rent Plan of his own.
-- Read from a payer-side SMS. The payer was confirmed among two agents with the
-- same name (the other is +256743657091).
--
-- Inserts ONE PENDING deposit request and moves no money. Run 20261018110100
-- next to register the TID as finance-verified, then approve. Check the TID on
-- the MTN till 090777 statement first.
--
-- Idempotent. One statement, no apostrophes or semicolons in comments.

INSERT INTO public.deposit_requests (
  user_id, amount, status, provider, transaction_id, deposit_purpose, notes
)
SELECT
  t.user_id, t.amount, 'pending', 'mtn', t.tid, t.purpose,
  'Manual intake 2026-10-18: MTN SMS feed outage, payer-side SMS. Verify TID on till 090777 statement before approving.'
FROM (VALUES
  ('7c3c3436-e1b9-4e02-bcf5-689e2e89f763'::uuid, '779332561', '44342798510', 40000::numeric, 'operational_float'::public.deposit_purpose)
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
