-- The AFTER INSERT trigger ran the full 24h email auto-match sweep synchronously
-- on every pending deposit insert, which exceeded the statement timeout and
-- aborted legitimate deposit inserts (auto-credit + confirmation SMS never ran).
-- The identical sweep is already scheduled every 2 minutes (cron job
-- "email-auto-match-retry-24h"), so the trigger is pure redundant cost.
DROP TRIGGER IF EXISTS trg_deposit_request_auto_rematch ON public.deposit_requests;