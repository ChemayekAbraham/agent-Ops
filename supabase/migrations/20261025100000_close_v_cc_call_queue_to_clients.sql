-- 2026-10-25: Security Definer View lint on public.v_cc_call_queue (call-centre queue: names, districts, arrears, outstanding, linked agents).
-- The view ran with owner rights, had no gate and was readable by every signed-in user: tested as an ordinary operations user, a direct read returned all 3,975 queue rows.
-- Nothing in the app reads it directly (no source references, no API reads in the logs). The call-centre screens use cc_call_queue_page, cc_state_counts and cc_filter_values,
-- which are SECURITY DEFINER, check cc_queue_access_allowed() (operations, hr, ceo, coo, super_admin, or the matching tenant_ops / landlord_ops / agent_ops) and read the view as owner.
-- Fix: take direct access away from signed-in users. After the change a direct read is refused (42501) and cc_state_counts / cc_call_queue_page still work (tested).
-- Applied to production 2026-10-25. Undo: grant select on public.v_cc_call_queue to authenticated;  (not recommended)
revoke select on public.v_cc_call_queue from authenticated;
