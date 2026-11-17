-- Withdrawals (Lillian, 2026-11-16) failed with "permission denied for function normalize_momo_tid".
-- The IMMUTABLE pure helper was closed by the doc 247 step 23 sweep, but column defaults, views and
-- triggers evaluated as the signed-in user call it. Plain helper: no data access, safe to open.
grant execute on function public.normalize_momo_tid(text) to authenticated;
