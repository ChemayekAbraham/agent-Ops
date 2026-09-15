-- Fix: finops_payout_verification_queue times out (57014, canceling statement
-- due to statement timeout) whenever anyone loads the Financial Ops payout
-- verification queue.
--
-- Root cause: duplicate_national_id_owner(user_id, national_id) — called TWICE
-- per row returned by finops_payout_verification_queue (once directly, once
-- nested inside a correlated subquery for the duplicate owner's name) — does a
--   WHERE upper(regexp_replace(national_id, '[^A-Za-z0-9]', '', 'g')) = v_id
-- lookup against public.profiles (96,573 rows) with NO matching index, so
-- Postgres falls back to a full sequential scan, run as a PL/pgSQL function
-- call (not inlined) for every one of up to 20 rows on a page. The queue's own
-- inline duplicate_id_accounts subquery does the same normalization a second,
-- syntactically different way (regexp_replace(upper(...)) instead of
-- upper(regexp_replace(...))) against the same column, so it needs its own
-- matching index — a Postgres expression index only matches an identical
-- expression tree, not a semantically-equivalent one.
--
-- Fix is purely additive (two expression indexes) — no function body changed,
-- so this cannot alter any existing query's output, only its cost.
CREATE INDEX IF NOT EXISTS idx_profiles_national_id_normalized_a
  ON public.profiles (upper(regexp_replace(national_id, '[^A-Za-z0-9]', '', 'g')))
  WHERE national_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_profiles_national_id_normalized_b
  ON public.profiles (regexp_replace(upper(coalesce(national_id, '')), '[^A-Z0-9]', '', 'g'));

-- duplicate_national_id_owner() also falls back to scanning
-- payout_destination_verifications (currently ~3,300 rows) with the same
-- normalization when no profiles match — much cheaper today, but not free,
-- and it's on the same hot path, so index it too.
CREATE INDEX IF NOT EXISTS idx_payout_destination_verifications_national_id_normalized
  ON public.payout_destination_verifications (upper(regexp_replace(national_id, '[^A-Za-z0-9]', '', 'g')))
  WHERE status = 'verified' AND national_id IS NOT NULL;
