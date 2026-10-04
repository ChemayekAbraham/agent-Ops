
-- Drop the old trigger that deducts on approval (now handled by deduct-on-request + refund-on-reject pattern)
DROP TRIGGER IF EXISTS trg_process_agent_commission_payout_approval ON public.agent_commission_payouts;
DROP FUNCTION IF EXISTS public.process_agent_commission_payout_approval();
