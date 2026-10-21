-- Register the two pending Annet Nabutsale manual-intake TIDs as finance-verified so
-- approving the deposits also counts the float as TID-backed. See 20261018040100.
--
-- Run AFTER 20261021010000 and BEFORE approving.
--
-- Idempotent. One statement, no apostrophes or semicolons in comments.

INSERT INTO public.manual_verified_tids (tid_normalized, user_id, amount, note)
SELECT regexp_replace(lower(btrim(dr.transaction_id)), '^tid', ''),
       dr.user_id,
       dr.amount,
       'Manual intake 2026-10-21 - verified on MTN till statement'
  FROM public.deposit_requests dr
 WHERE dr.status = 'pending'
   AND dr.deposit_purpose = 'operational_float'
   AND dr.notes LIKE 'Manual intake 2026-10-21%'
   AND dr.user_id = 'ed3168bf-c97c-4cb9-9520-542493f99a6b'
   AND regexp_replace(lower(btrim(dr.transaction_id)), '^tid', '')
       IN ('44302867702', '44332406991')
ON CONFLICT (tid_normalized) DO NOTHING;
