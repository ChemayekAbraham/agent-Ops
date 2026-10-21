-- Register the four pending Kisambira Sharif manual-intake TIDs as finance-verified so
-- approving the deposits also counts the float as TID-backed. See 20261018040100.
--
-- Run AFTER 20261020030000 and BEFORE approving.
--
-- Idempotent. One statement, no apostrophes or semicolons in comments.

INSERT INTO public.manual_verified_tids (tid_normalized, user_id, amount, note)
SELECT regexp_replace(lower(btrim(dr.transaction_id)), '^tid', ''),
       dr.user_id,
       dr.amount,
       'Manual intake 2026-10-20 - verified on MTN till statement'
  FROM public.deposit_requests dr
 WHERE dr.status = 'pending'
   AND dr.deposit_purpose = 'operational_float'
   AND dr.notes LIKE 'Manual intake 2026-10-20%'
   AND dr.user_id = 'eeab982f-36e2-4a59-9fd8-40316927941a'
   AND regexp_replace(lower(btrim(dr.transaction_id)), '^tid', '')
       IN ('44294552012', '44311006957', '44311082013', '44338958605')
ON CONFLICT (tid_normalized) DO NOTHING;
