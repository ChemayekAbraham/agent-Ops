-- Rollback of 20261107100500_assistant_partner_new_portfolio_rate.sql (Partner Returns Phase 4a-assistant).
-- Run only after the get_my_new_portfolio_rate tool is removed from supabase/functions/agent-assistant/tools.ts
-- AND that removal is deployed (Lovable redeploys every edge function from `lovable`; check the deployed
-- version). Until then the deployed assistant degrades to {available:false} on PGRST202 (design §3.5.10),
-- but the turn should not depend on that.
SET LOCAL lock_timeout = '5s';
DROP FUNCTION IF EXISTS public.assistant_partner_new_portfolio_rate();
