-- Register the pending Shafeeq Ssenabulya Airtel TID as finance-verified so approving the
-- deposit also counts the float as TID-backed. See 20261018040100.
--
-- Run AFTER 20261022010000 and BEFORE approving.
--
-- Idempotent. One statement, no apostrophes or semicolons in comments.

INSERT INTO public.manual_verified_tids (tid_normalized, user_id, amount, note)
SELECT regexp_replace(lower(btrim(dr.transaction_id)), '^tid', ''),
       dr.user_id,
       dr.amount,
       'Manual intake 2026-10-22 - verified on Airtel statement'
  FROM public.deposit_requests dr
 WHERE dr.status = 'pending'
   AND dr.deposit_purpose = 'operational_float'
   AND dr.notes LIKE 'Manual intake 2026-10-22%'
   AND dr.user_id = '98b7b07a-3d03-4600-b94e-cda122bbe4ae'
   AND regexp_replace(lower(btrim(dr.transaction_id)), '^tid', '') = '159457826158'
ON CONFLICT (tid_normalized) DO NOTHING;
