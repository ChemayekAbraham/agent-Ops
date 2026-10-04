-- 2026-09-11 Daily CTO Report: public.auto_create_deposits_from_gmail_impl()
-- (invoked via public.auto_create_deposits_from_gmail($1)) is 52,787 calls/day
-- at 3,676ms mean — flagged critical, "within work_mem" (not a caching
-- issue; a plan/index issue).
--
-- Per candidate gmail_transactions row, the loop body
-- (20260911181000_deposit_intake_races_and_auto_reject_window.sql:334-378)
-- probes deposit_requests and profiles using expression predicates that no
-- existing index matches:
--   - `lower(trim(d.transaction_id)) = lower(trim(v_tx.transaction_id))`
--     against deposit_requests — the only existing index on that column
--     (deposit_requests_transaction_id_idx, 20260124054446) is on the raw
--     column, which Postgres cannot use for a lower(trim(...)) predicate.
--   - `regexp_replace(coalesce(p.phone, ''), '[^0-9]', '', 'g') IN (...)`
--     against profiles — the existing phone indexes (idx_profiles_phone,
--     idx_profiles_phone_trgm, idx_profiles_phone_last9) are on the raw
--     column, a trigram index, and a different expression
--     (right(regexp_replace(phone,'\D','','g'),9)) respectively; none match
--     this exact expression text, so none are usable here.
--
-- Add expression indexes matching the exact predicates used.

CREATE INDEX IF NOT EXISTS idx_deposit_requests_transaction_id_lower_trim
  ON public.deposit_requests (lower(trim(transaction_id)))
  WHERE transaction_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_profiles_phone_digits_only
  ON public.profiles (regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g'));
