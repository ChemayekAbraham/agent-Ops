-- Manual intake of three MTN payments lost to the MTN SMS feed outage.
--
-- Payer: WALYAMBOGA ISAAC (+256770798094), an agent with 18 Rent Plans and one Rent Plan
-- of his own, topping up operational float as in his earlier deposits.
--   TID 44298256508  UGX 8,000  paid 2026-10-17 13:09:41 EAT
--   TID 44314080364  UGX 6,000  paid 2026-10-17 21:54:16 EAT
--   TID 44342377093  UGX 4,000  paid 2026-10-18 21:59:08 EAT
-- Read from payer-side SMS screenshots and matched to the MTN till statement of 2026-10-20
-- (payer ISAAC WALYAMBOGA). The SMS do not show a phone number, so the account match is by
-- name and history. None of the TIDs is in gmail_transactions, deposit_requests or
-- ledger_reconciled_tids.
--
-- Inserts PENDING deposit requests only and moves no money. Run 20261020040100 next to
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
  ('aab93167-289b-4522-94c4-4e87c8d58f8b'::uuid, '770798094', '44298256508', 8000::numeric, 'operational_float'::public.deposit_purpose),
  ('aab93167-289b-4522-94c4-4e87c8d58f8b'::uuid, '770798094', '44314080364', 6000::numeric, 'operational_float'::public.deposit_purpose),
  ('aab93167-289b-4522-94c4-4e87c8d58f8b'::uuid, '770798094', '44342377093', 4000::numeric, 'operational_float'::public.deposit_purpose)
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
