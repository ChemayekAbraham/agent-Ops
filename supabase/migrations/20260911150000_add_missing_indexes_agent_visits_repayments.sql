-- Add missing indexes on agent_visits and repayments, flagged in the
-- 2026-09-10 Daily CTO Report (Database Diagnostics - Missing Index
-- Candidates): agent_visits had 624,884 sequential scans reading
-- 3,561,523,322 rows (63 index scans), repayments had 710,892 sequential
-- scans reading 3,403,100,260 rows (450 index scans). Both tables had zero
-- indexes beyond primary key / RLS-referenced columns before this migration
-- (repayments had one partial index on deposit_request_id, added
-- 2026-09-03, unrelated to these hot paths).
--
-- Column choices are based on the actual WHERE/ORDER BY predicates hitting
-- each table, found in this repo:
--
-- repayments:
--   - rent_request_id: correlated per-row subquery
--     `SELECT SUM(r.amount) FROM public.repayments r
--      WHERE r.rent_request_id = t.rent_request_id`
--     (20260806170917_b3f65fec...sql) plus a direct frontend .eq() lookup —
--     the likely single biggest contributor to the 3.4B rows read, since a
--     correlated subquery without an index degrades to one full table scan
--     per outer row.
--   - tenant_id: frontend .eq() lookup, plus the first-repayment-bonus
--     trigger's `SELECT COUNT(*) FROM public.repayments WHERE tenant_id =
--     NEW.tenant_id` on every insert.
--
-- agent_visits:
--   - (created_at) WHERE agent_id IS NOT NULL: the exact repeated predicate
--     `WHERE created_at >= v_start AND created_at < v_end AND agent_id IS
--     NOT NULL` appearing verbatim in multiple commission/report RPCs
--     (20260713050943, 20260713051044) — a date-range scan, not a specific
--     agent lookup, so created_at is the selective leading column.
--   - (agent_id, checked_in_at): the frontend's per-agent visit list
--     (.eq('agent_id', ...).order('checked_in_at')).
--
-- These are plain (non-CONCURRENTLY) CREATE INDEX statements, matching
-- every existing index in this repo's migration history — there is no
-- CONCURRENTLY precedent here. On tables this large a plain CREATE INDEX
-- holds a SHARE lock for the build duration, blocking writes to the table.
-- Given known migrations/production drift (see CLAUDE.md), verify current
-- row counts and traffic before applying; consider running the CONCURRENTLY
-- form by hand in the SQL editor instead of this file if the table is too
-- hot for a blocking build.

CREATE INDEX IF NOT EXISTS idx_repayments_rent_request_id
  ON public.repayments (rent_request_id);

CREATE INDEX IF NOT EXISTS idx_repayments_tenant_id
  ON public.repayments (tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_visits_created_at_agent_not_null
  ON public.agent_visits (created_at)
  WHERE agent_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_agent_visits_agent_id_checked_in_at
  ON public.agent_visits (agent_id, checked_in_at DESC);
