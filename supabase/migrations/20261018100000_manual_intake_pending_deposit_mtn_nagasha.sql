-- Manual intake of one MTN payment lost to the MTN SMS feed outage.
--
-- TID 44332597060, UGX 9,200, paid 2026-10-18 afternoon to WELILE TECHNOLOGIES
-- LIMITED (till 090777) by NAGASHA Mellon (+256792790529), an agent topping up
-- operational float, as in her earlier deposits. She has no Rent Plan of her own.
-- Read from a payer-side SMS. The time is not on the screenshot. The TID sits after
-- 44329606530 (2026-10-18 15:13 EAT).
--
-- Inserts ONE PENDING deposit request and moves no money. Run 20261018100100
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
  ('34f9591f-47fb-4d51-9104-9d821247ebb6'::uuid, '792790529', '44332597060', 9200::numeric, 'operational_float'::public.deposit_purpose)
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
