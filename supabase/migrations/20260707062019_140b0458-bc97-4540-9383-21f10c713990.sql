DROP TRIGGER IF EXISTS trg_enforce_agent_listing_eligibility ON public.house_listings;
DROP FUNCTION IF EXISTS public.enforce_agent_listing_eligibility();
DROP FUNCTION IF EXISTS public.get_agent_listing_eligibility(uuid);