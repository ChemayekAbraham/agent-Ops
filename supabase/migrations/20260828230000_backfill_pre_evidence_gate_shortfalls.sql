-- Two landlord-float payouts from 2026-07-29 (Nankambo sharimah) have a
-- commission leg but no float-settlement leg and no merchant_out_of_pocket_
-- advances row at all -- unlike every later case of this same "merchant had
-- zero float" pattern. These predate the out-of-pocket shortfall filing step
-- being evidence-gated on 2026-08-13 (see approve-withdrawal/index.ts's
-- comment on that block), so the claim was simply never created back then.
-- Backfilling it applies today's standard rule retroactively rather than
-- leaving these two as the only unexplained rows of their kind on the
-- platform. Status is needs_review, same as any other zero-float shortfall
-- would file as -- this is not a payment decision, just closing the same gap
-- 20260828170000/20260828210000 already closed for every payout after
-- 2026-08-13.

INSERT INTO public.merchant_out_of_pocket_advances (
  agent_id, withdrawal_id, kind, payout_amount, telecom_charge, float_used,
  shortfall_amount, status, note
)
SELECT
  '59d45ad2-0d44-433c-b4ec-20927a25c281'::uuid,
  wr.id,
  'payout',
  wr.amount,
  0,
  0,
  wr.amount,
  'needs_review',
  'Backfilled 2026-08-28: no out-of-pocket claim was ever filed for this zero-float landlord payout (predates the 2026-08-13 evidence gate). Amount and status match what approve-withdrawal would file today for the same shortfall.'
FROM public.withdrawal_requests wr
WHERE wr.id IN ('83469d9e-2491-42a4-8ff2-4bc81b0de3d2', 'a0b22194-8802-42ed-9ca5-92288e7cc93f')
ON CONFLICT (withdrawal_id, kind) DO NOTHING;
