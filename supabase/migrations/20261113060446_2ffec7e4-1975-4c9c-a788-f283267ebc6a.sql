REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.partner_agreement_rate_requests FROM authenticated, anon, PUBLIC;
GRANT SELECT ON public.partner_agreement_rate_requests TO authenticated;
GRANT ALL ON public.partner_agreement_rate_requests TO service_role;