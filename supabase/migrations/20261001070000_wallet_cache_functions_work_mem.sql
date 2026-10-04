-- Doc 177: stop the wallet cache maintenance functions spilling to temp files.
--
-- From the 2026-09-30 CTO report, verified on live pg_stat_statements 2026-10-01:
--   refresh_wallet_totals_cache()  mean ~15.4 s, ~35 MB temp written per run,
--                                  cron job 2723 every 3 minutes
--   repair_wallet_cache_drift(int) / detect_wallet_projection_drift(int)
--                                  ~10 s, ~2 MB temp per run, every 15 minutes
-- All three sort/hash more than the default work_mem. Raising work_mem for these
-- functions only (function-level SET, not role- or database-wide) lets the sorts
-- and hashes stay in memory.
--
-- Function bodies are NOT changed: no ledger or wallet math is touched, and none of
-- the three is in critical_function_baselines (checked live), so nothing to
-- re-baseline. ALTER FUNCTION ... SET keeps each function's existing settings
-- (search_path, statement_timeout) and adds work_mem alongside them.
--
-- Rollback: ALTER FUNCTION public.<name>(<args>) RESET work_mem;

ALTER FUNCTION public.refresh_wallet_totals_cache()        SET work_mem = '64MB';
ALTER FUNCTION public.repair_wallet_cache_drift(integer)   SET work_mem = '64MB';
ALTER FUNCTION public.detect_wallet_projection_drift(integer) SET work_mem = '64MB';
