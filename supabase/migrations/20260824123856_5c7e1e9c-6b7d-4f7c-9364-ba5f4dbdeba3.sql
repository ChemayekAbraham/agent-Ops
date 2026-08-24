REVOKE ALL ON FUNCTION public.pay_merchant_agent_referral_generations(uuid, uuid, text) FROM anon, authenticated, PUBLIC;
REVOKE ALL ON FUNCTION public.release_merchant_agent_referral_on_first_payout() FROM anon, authenticated, PUBLIC;
REVOKE ALL ON FUNCTION public.pay_merchant_agent_referral_bonus() FROM anon, authenticated, PUBLIC;