-- Follow-up to 20261017230000_manual_intake_pending_deposits_mtn_outage.sql.
--
-- That migration left out TID 44313474818 because the amount on the payer's
-- screenshot was cut off. The full amount is now confirmed as UGX 21,000 (agent
-- float top-up by DERRICK LUTAMAGUZI, payer-side SMS, MTN feed outage of
-- 2026-10-17).
--
-- Same behaviour as the first file: inserts ONE PENDING deposit_requests row and
-- moves no money. A manager approves it in Financial Ops; approve-deposit then
-- credits operational float. Verify the TID and amount on the MTN till (090777)
-- statement before approving.
--
-- Idempotent: skipped when the profile phone does not match, when the TID already
-- has a non-rejected deposit request, or when it is in ledger_reconciled_tids.
-- Single statement, no DO block (pastes cleanly into the dashboard SQL editor).

INSERT INTO public.deposit_requests (
  user_id, amount, status, provider, transaction_id, deposit_purpose, notes
)
SELECT
  t.user_id, t.amount, 'pending', 'mtn', t.tid, t.purpose,
  'Manual intake 2026-10-17: MTN SMS feed outage, payer-side SMS. Verify TID on till 090777 statement before approving.'
FROM (VALUES
  ('92d867f6-1a01-4bec-b3c1-5bf875328ada'::uuid, '795634656', '44313474818', 21000::numeric, 'operational_float'::public.deposit_purpose)
) AS t(user_id, phone_last9, tid, amount, purpose)
JOIN public.profiles p
  ON p.id = t.user_id
 AND right(regexp_replace(coalesce(p.phone, ''), '\D', '', 'g'), 9) = t.phone_last9
WHERE NOT EXISTS (
        SELECT 1 FROM public.deposit_requests d
         WHERE lower(btrim(d.transaction_id)) = t.tid
           AND d.status NOT IN ('rejected', 'cancelled', 'failed')
      )
  AND NOT EXISTS (
        SELECT 1 FROM public.ledger_reconciled_tids l
         WHERE l.tid_normalized = t.tid
      );
