-- Manual intake of one MTN payment lost to the MTN SMS feed outage of 2026-10-17.
--
-- TID 44302747719, UGX 90,000, paid 2026-10-17 16:10:10 EAT to WELILE TECHNOLOGIES
-- LIMITED by SHAKIRAH NAKIMBUGWE (+256770603906). She is an agent and this is an
-- operational float top-up, matching her usual deposits. It is NOT a payment
-- towards her own Rent Plan.
--
-- Inserts ONE PENDING deposit request and moves no money. A manager approves it
-- in Financial Ops, which credits operational float through approve-deposit.
-- Check the TID and amount on the MTN till 090777 statement before approving.
-- After approval run 20261018020100_tid_backed_float_manual_intake_backfill_shakirah.sql
-- so the float counts as TID-backed for rent collection.
--
-- Idempotent: skipped when the profile phone does not match, when the TID already
-- has a live deposit request, or when it is in ledger_reconciled_tids.
-- One statement, no DO block, no apostrophes or semicolons in comments.

INSERT INTO public.deposit_requests (
  user_id, amount, status, provider, transaction_id, deposit_purpose, notes
)
SELECT
  t.user_id, t.amount, 'pending', 'mtn', t.tid, t.purpose,
  'Manual intake 2026-10-17: MTN SMS feed outage, payer-side SMS. Verify TID on till 090777 statement before approving.'
FROM (VALUES
  ('34ed279b-f6cf-4291-ab0f-1339b8afe28c'::uuid, '770603906', '44302747719', 90000::numeric, 'operational_float'::public.deposit_purpose)
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
