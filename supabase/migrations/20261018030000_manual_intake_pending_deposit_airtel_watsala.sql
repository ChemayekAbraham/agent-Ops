-- Manual intake of one Airtel payment that never reached gmail_transactions.
--
-- TID 159133034540, UGX 31,000, paid 2026-10-17 23:45 EAT to WELILE TECHNOLOGIES
-- LIMITED by Watsala Enock (+256750223152). She is an agent and this is an
-- operational float top-up, matching her usual deposits. It is NOT a payment
-- towards her own Rent Plan.
--
-- Airtel rows stopped at 20:19 UTC while this message arrived at about 20:45 UTC,
-- so the Airtel feed may be dropping messages too.
--
-- Inserts ONE PENDING deposit request and moves no money. A manager approves it
-- in Financial Ops, which credits operational float through approve-deposit.
-- Check the TID and amount on the Airtel statement before approving.
-- After approval run 20261018030100_tid_backed_float_manual_intake_backfill_watsala.sql
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
  'Manual intake 2026-10-17: Airtel message not ingested, payer-side SMS. Verify TID on Airtel statement before approving.'
FROM (VALUES
  ('ebf0897b-dfdf-4403-ad5c-1c988c72e67c'::uuid, '750223152', '159133034540', 31000::numeric, 'operational_float'::public.deposit_purpose)
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
