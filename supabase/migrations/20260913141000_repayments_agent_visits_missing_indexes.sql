-- 2026-09-12 Daily CTO Report (Database Diagnostics - Missing Index
-- Candidates):
--   agent_visits:  625,415 seq scans / 3,566,990,210 rows read / 63 idx scans
--   repayments:    738,389 seq scans / 3,550,806,818 rows read / 609 idx scans
-- Both tables only had a primary-key index; every other lookup fell back to
-- a full sequential scan, repeated per-call from PostgREST.
--
-- pg_stat_statements shows the actual hot queries (most-called first):
--   repayments:
--     WHERE rent_request_id = ANY($1) AND created_at >= $2         (256,672 calls)
--     WHERE tenant_id = $1 ORDER BY created_at DESC                (218,515 + 35,314 calls)
--     WHERE tenant_id = ANY($1) AND created_at >= $2 AND < $3      ( 13,544 calls)
--     WHERE tenant_id = ANY($1) ORDER BY created_at DESC           ( 10,047 calls)
--   agent_visits:
--     WHERE agent_id = $1                                         (186,604 calls)
--     WHERE agent_id = ANY($1)                                    ( 26,247 calls)
--     WHERE agent_id = $1 AND checked_in_at >= $2                  (  3,094 calls)
--     ORDER BY checked_in_at DESC (no filter, capacity/ops feed)   (  3,318 calls, 81ms mean)
--
-- Both tables are small (~5.5k and ~10.5k live rows respectively), so this
-- isn't about individual query cost -- it's call volume: hundreds of
-- thousands of PostgREST calls/day each re-scanning the full table.

CREATE INDEX IF NOT EXISTS idx_repayments_rent_request_created
  ON public.repayments (rent_request_id, created_at);

CREATE INDEX IF NOT EXISTS idx_repayments_tenant_created
  ON public.repayments (tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_visits_agent_checked_in
  ON public.agent_visits (agent_id, checked_in_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_visits_checked_in
  ON public.agent_visits (checked_in_at DESC);
