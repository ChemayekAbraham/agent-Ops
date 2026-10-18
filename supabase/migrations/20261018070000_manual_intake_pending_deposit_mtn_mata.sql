-- Manual intake of one MTN payment lost to the MTN SMS feed outage.
--
-- TID 44315364132, UGX 15,000, paid to WELILE TECHNOLOGIES LIMITED (till 090777)
-- by Mata Pius (+256776368807), an agent topping up operational float, as in her
-- earlier deposits. Read from a payer-side SMS. The time is not on the screenshot.
-- The TID sits between 44313474818 (2026-10-17 evening) and 44326931080 (2026-10-18).
--
-- Inserts ONE PENDING deposit request and moves no money. Run 20261018070100
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
  ('6aac6c81-b0f8-45eb-a67b-6483e7dcf82f'::uuid, '776368807', '44315364132', 15000::numeric, 'operational_float'::public.deposit_purpose)
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
