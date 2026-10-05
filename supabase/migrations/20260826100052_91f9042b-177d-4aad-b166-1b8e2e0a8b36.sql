REVOKE EXECUTE ON FUNCTION public.resolve_promissory_note_for_partner(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.credit_promissory_agent_commission(uuid, numeric, text, text, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.trg_credit_promissory_portfolio_creation() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.trg_credit_promissory_portfolio_topup() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_promissory_note_for_partner(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.credit_promissory_agent_commission(uuid, numeric, text, text, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.trg_credit_promissory_portfolio_creation() TO service_role;
GRANT EXECUTE ON FUNCTION public.trg_credit_promissory_portfolio_topup() TO service_role;