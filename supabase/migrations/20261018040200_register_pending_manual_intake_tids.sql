-- Register the manual-intake TIDs that are still PENDING so approval makes them
-- TID-backed automatically (no backfill file needed for these).
--
-- Applies to Arinaitwe (Airtel 159128404754), Shakirah (MTN 44302747719) and
-- Watsala (Airtel 159133034540). Only rows still pending are registered. A row
-- that was already approved keeps using its 2026-10-18 backfill file instead.
--
-- Run 20261018040000 and 20261018040100 first. Verify each TID on the telco
-- statement BEFORE approving, because registering means finance vouches for it.
-- If a backfill file is run after approval it adds 0 and is harmless, because the
-- credit is capped at float minus the TID-backed balance.
--
-- Idempotent. One statement, no apostrophes or semicolons in comments.

INSERT INTO public.manual_verified_tids (tid_normalized, user_id, amount, note)
SELECT regexp_replace(lower(btrim(dr.transaction_id)), '^tid', ''),
       dr.user_id,
       dr.amount,
       'Manual intake 2026-10-17 - TID to be verified on telco statement before approval'
  FROM public.deposit_requests dr
 WHERE dr.status = 'pending'
   AND dr.deposit_purpose = 'operational_float'
   AND dr.notes LIKE 'Manual intake 2026-10-17%'
   AND regexp_replace(lower(btrim(dr.transaction_id)), '^tid', '')
       IN ('159128404754', '44302747719', '159133034540')
ON CONFLICT (tid_normalized) DO NOTHING;
