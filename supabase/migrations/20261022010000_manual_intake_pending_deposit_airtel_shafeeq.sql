-- Manual intake of one Airtel payment that never reached gmail_transactions.
--
-- TID 159457826158, UGX 72,000, paid 2026-10-21 20:59 EAT to WELILE TECHNOLOGIES LIMITED
-- by SHAFEEQ SSENABULYA (+256748762871), an agent with 162 Rent Plans and no Rent Plan of his
-- own, topping up operational float as in his earlier Airtel deposits. Read from the payer
-- SMS. The TID is not in gmail_transactions, deposit_requests or ledger_reconciled_tids.
--
-- Inserts ONE PENDING deposit request and moves no money. Run 20261022010100 next to
-- register the TID as finance-verified, then approve.
--
-- Idempotent. One statement, no apostrophes or semicolons in comments.

INSERT INTO public.deposit_requests (
  user_id, amount, status, provider, transaction_id, deposit_purpose, notes
)
SELECT
  t.user_id, t.amount, 'pending', 'airtel', 'TID' || t.tid, t.purpose,
  'Manual intake 2026-10-22: Airtel message dropped before ingestion, payer-side SMS. Verify TID on Airtel statement before approving.'
FROM (VALUES
  ('98b7b07a-3d03-4600-b94e-cda122bbe4ae'::uuid, '748762871', '159457826158', 72000::numeric, 'operational_float'::public.deposit_purpose)
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
