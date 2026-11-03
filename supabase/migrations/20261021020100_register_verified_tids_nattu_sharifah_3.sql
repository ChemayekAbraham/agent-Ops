-- Register the pending Nattu Sharifah manual-intake TID as finance-verified so approving
-- the deposit also counts the float as TID-backed. See 20261018040100.
--
-- Run AFTER 20261021020000 and BEFORE approving.
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
   AND dr.user_id = 'cc3bacad-ad59-412d-ac4d-df99aee61cb0'
   AND regexp_replace(lower(btrim(dr.transaction_id)), '^tid', '') = '44296365338'
ON CONFLICT (tid_normalized) DO NOTHING;
