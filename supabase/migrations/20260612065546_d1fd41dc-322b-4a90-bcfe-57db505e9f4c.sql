-- Pay recruiter override (UGX 3,000) when a sub-agent's tenant gets its landlord funded.
-- "Funded" = rent_requests.funded_at transitions from NULL to a value (CFO sent rent to landlord float).
CREATE OR REPLACE FUNCTION public.pay_recruiter_override_tenant_landlord_funded()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.funded_at IS NOT NULL
     AND OLD.funded_at IS NULL
     AND NEW.agent_id IS NOT NULL
  THEN
    PERFORM public.credit_recruiter_override(
      NEW.agent_id,
      'tenant_landlord_funded',
      'rent_requests',
      NEW.id::text,
      COALESCE(NEW.fund_recipient_name, NEW.tenant_id::text)
    );
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_recruiter_override_tenant_landlord_funded ON public.rent_requests;
CREATE TRIGGER trg_recruiter_override_tenant_landlord_funded
AFTER UPDATE OF funded_at ON public.rent_requests
FOR EACH ROW
EXECUTE FUNCTION public.pay_recruiter_override_tenant_landlord_funded();