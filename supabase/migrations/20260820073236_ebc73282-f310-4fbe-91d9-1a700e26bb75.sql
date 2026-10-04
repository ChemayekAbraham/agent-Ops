REVOKE EXECUTE ON FUNCTION public.hr_claim_ticket(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.hr_claim_ticket(uuid) TO authenticated;