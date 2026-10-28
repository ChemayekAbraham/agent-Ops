-- Makes the Board Technology Report load inside the 8-second limit signed-in users have.
--
-- WHAT WAS HAPPENING: get_board_tech_memo (the report's RPC) took 12.4 seconds on a cold run and about 2 seconds warm (28 Oct). Signed-in users are
-- cut off at 8 seconds, so the report showed "canceling statement due to statement timeout" whenever the database had not just read the same logs.
-- The biggest cost: it scans login_phase_events (about 480,000 rows a week) five separate times, each time reading roughly 14,000 to 18,000 blocks to
-- keep a few dozen rows, because the only time index covers every phase and the report wants four rare ones.
--   auth.signin.attempt, auth.init.timeout_forced, guard.resolved, gate.account_frozen.check
--
-- WHAT THIS ADDS: a small partial index on created_at for just those four phases. The report's queries filter on one of those phases and a time range,
-- so they read only the few thousand matching rows. Other inserts into login_phase_events (the vast majority) do not touch it, so writes are not slowed.
-- The report's own results do not change.
--
-- RUN THIS ON ITS OWN, as a single statement (CREATE INDEX CONCURRENTLY cannot run inside a transaction). It builds without blocking sign-in logging.
-- Roll back with 20261028130000_login_phase_events_board_memo_index.rollback.sql.

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_login_phase_events_board_phases
  ON public.login_phase_events (created_at)
  WHERE phase IN ('auth.signin.attempt', 'auth.init.timeout_forced', 'guard.resolved', 'gate.account_frozen.check');
