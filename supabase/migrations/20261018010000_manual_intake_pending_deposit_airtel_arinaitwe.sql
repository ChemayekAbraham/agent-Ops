-- Manual intake of one Airtel payment that never reached gmail_transactions.
--
-- TID 159128404754, UGX 5,000, paid 2026-10-17 22:02 EAT to WELILE TECHNOLOGIES
-- LIMITED by ARINAITWE MARTIN BRIAN (+256751487521), an agent topping up float.
-- The Airtel feed was otherwise working: the neighbouring TID 159128357241 was
-- ingested at 19:02:03 UTC. This single message was dropped before the poller.
--
-- Inserts ONE PENDING deposit request and moves no money. A manager approves it
-- in Financial Ops, which credits operational float through approve-deposit.
-- Check the TID and amount on the Airtel statement before approving.
-- After approval run 20261018010100_tid_backed_float_manual_intake_backfill_airtel.sql
-- so the float counts as TID-backed for rent collection.
--
-- Idempotent: skipped when the profile phone does not match, when the TID already
-- has a live deposit request, or when it is in ledger_reconciled_tids.
-- One statement, no DO block, no apostrophes or semicolons in comments.

INSERT INTO public.deposit_requests (
  user_id, amount, status, provider, transaction_id, deposit_purpose, notes
)
SELECT
  t.user_id, t.amount, 'pending', 'airtel', 'TID' || t.tid, t.purpose,
  'Manual intake 2026-10-17: Airtel message dropped before ingestion, payer-side SMS. Verify TID on Airtel statement before approving.'
FROM (VALUES
  ('1b683203-d500-4c21-a6cb-8f1eb6d4c874'::uuid, '751487521', '159128404754', 5000::numeric, 'operational_float'::public.deposit_purpose)
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
