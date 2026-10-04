-- 2026-09-11 Daily CTO Report (Database Diagnostics - Missing Index
-- Candidates): payout_proof_integrity_alerts had 3,863 sequential scans
-- reading 20,214,935 rows with 0 index scans — the table had no index
-- beyond its primary key.
--
-- The only query against this table in the repo is
-- src/components/shared/PayoutProofIntegrityPanel.tsx:
--   .eq('resolved', false).order('created_at', { ascending: false }).limit(50)
-- which the CFO/COO/finance-ops dashboard polls on every panel load/refresh.
-- A partial index matching that exact predicate lets Postgres seek instead
-- of scanning the whole table (and the daily proof-integrity check job that
-- inserts into it) every time.

CREATE INDEX IF NOT EXISTS idx_payout_proof_integrity_alerts_unresolved
  ON public.payout_proof_integrity_alerts (created_at DESC)
  WHERE resolved = false;
