-- Register the pending Nagasha Mellon Airtel TID as finance-verified so approving the
-- deposit also counts the float as TID-backed. See 20261018040100.
--
-- Run AFTER 20261021040000 and BEFORE approving.
--
-- Idempotent. One statement, no apostrophes or semicolons in comments.

INSERT INTO public.manual_verified_tids (tid_normalized, user_id, amount, note)
SELECT regexp_replace(lower(btrim(dr.transaction_id)), '^tid', ''),
       dr.user_id,
       dr.amount,
       'Manual intake 2026-10-21 - Airtel receipt in gmail_transactions, assigned by the payer'
  FROM public.deposit_requests dr
 WHERE dr.status = 'pending'
   AND dr.deposit_purpose = 'operational_float'
   AND dr.notes LIKE 'Manual intake 2026-10-21%'
   AND dr.user_id = '34f9591f-47fb-4d51-9104-9d821247ebb6'
   AND regexp_replace(lower(btrim(dr.transaction_id)), '^tid', '') = '159383609108'
ON CONFLICT (tid_normalized) DO NOTHING;
