-- Register the two pending Peter Bukoma manual-intake TIDs as finance-verified so
-- approving the deposits also counts the float as TID-backed. See 20261018040100.
--
-- Run AFTER 20261018090000 and BEFORE approving. Registering means finance has
-- checked the TIDs on the MTN till 090777 statement.
--
-- Idempotent. One statement, no apostrophes or semicolons in comments.

INSERT INTO public.manual_verified_tids (tid_normalized, user_id, amount, note)
SELECT regexp_replace(lower(btrim(dr.transaction_id)), '^tid', ''),
       dr.user_id,
       dr.amount,
       'Manual intake 2026-10-18 - verified on MTN till statement'
  FROM public.deposit_requests dr
 WHERE dr.status = 'pending'
   AND dr.deposit_purpose = 'operational_float'
   AND dr.notes LIKE 'Manual intake 2026-10-18%'
   AND regexp_replace(lower(btrim(dr.transaction_id)), '^tid', '')
       IN ('44309187293', '44311812094')
ON CONFLICT (tid_normalized) DO NOTHING;
