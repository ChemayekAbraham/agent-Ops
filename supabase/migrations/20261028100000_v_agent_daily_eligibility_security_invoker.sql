-- 2026-10-28: Supabase lint "Security Definer View" on public.v_agent_daily_eligibility.
-- The view already gated rows itself (own agent row, or staff via can_view_staff_reports; a tenant sees 0 of 116), but it ran with its owner's rights.
-- Now it runs as the caller, like `wallets` (doc 247 step 33). Verified in a rolled-back transaction before and after: an agent sees 1 row (own), staff see all 116 with
-- identical expected_daily total (21,953,348) and per-agent figures for the 4 busiest agents, a tenant 0. Warm timings equal or better (agent 400 vs 340 ms).
-- The 8 SECURITY DEFINER functions that read the view (get_agent_advance_limits, enforce_agent_daily_eligibility, ...) run as owner and are unaffected.
-- Also removed unused write grants (INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER) the view held for authenticated. Applied to production 2026-10-28 by hand.
alter view public.v_agent_daily_eligibility set (security_invoker = true);
revoke insert, update, delete, truncate, references, trigger on public.v_agent_daily_eligibility from authenticated, anon;
