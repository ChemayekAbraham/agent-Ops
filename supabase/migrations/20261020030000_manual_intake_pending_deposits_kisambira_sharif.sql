-- Manual intake of four MTN payments lost to the MTN SMS feed outage.
--
-- Payer: KISAMBIRA SHARIF (+256795510067), an agent with 12 Rent Plans and no Rent Plan of
-- his own, topping up operational float. Named SALAFA KISAMBIRA on the MTN till statement.
-- Confirmed from payer-side SMS photos and the MTN till statement of 2026-10-20.
--   TID 44294552012  UGX 13,000  paid 2026-10-17 10:40:04 EAT
--   TID 44311006957  UGX  9,200  paid 2026-10-17 20:21:00 EAT
--   TID 44311082013  UGX 10,000  paid 2026-10-17 20:23:16 EAT
--   TID 44338958605  UGX  9,200  paid 2026-10-18 20:21:45 EAT
-- None of the TIDs is in gmail_transactions, deposit_requests or ledger_reconciled_tids.
--
-- Inserts PENDING deposit requests only and moves no money. Run 20261020030100 next to
-- register the TIDs as finance-verified, then approve.
--
-- Idempotent. One statement, no apostrophes or semicolons in comments.

INSERT INTO public.deposit_requests (
  user_id, amount, status, provider, transaction_id, deposit_purpose, notes
)
SELECT
  t.user_id, t.amount, 'pending', 'mtn', t.tid, t.purpose,
  'Manual intake 2026-10-20: MTN SMS feed outage, confirmed against MTN till 090777 statement and payer SMS.'
FROM (VALUES
  ('eeab982f-36e2-4a59-9fd8-40316927941a'::uuid, '795510067', '44294552012', 13000::numeric, 'operational_float'::public.deposit_purpose),
  ('eeab982f-36e2-4a59-9fd8-40316927941a'::uuid, '795510067', '44311006957', 9200::numeric, 'operational_float'::public.deposit_purpose),
  ('eeab982f-36e2-4a59-9fd8-40316927941a'::uuid, '795510067', '44311082013', 10000::numeric, 'operational_float'::public.deposit_purpose),
  ('eeab982f-36e2-4a59-9fd8-40316927941a'::uuid, '795510067', '44338958605', 9200::numeric, 'operational_float'::public.deposit_purpose)
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
