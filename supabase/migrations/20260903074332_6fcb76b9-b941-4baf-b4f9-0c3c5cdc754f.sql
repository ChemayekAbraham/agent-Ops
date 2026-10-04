CREATE OR REPLACE FUNCTION public.enforce_rent_request_landlord_agreement()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Signed agreements are mandatory only for an agent's ordinary new request.
  -- Renewals and outstanding-balance continuation requests are existing-tenant
  -- workflows and must remain postable without new agreement evidence.
  IF NEW.landlord_id IS NULL
     OR NEW.registration_type IN ('renewal', 'outstanding_balance')
     OR auth.uid() IS DISTINCT FROM NEW.agent_id THEN
    RETURN NEW;
  END IF;

  IF NOT public.landlord_has_current_agreement(NEW.landlord_id) THEN
    RAISE EXCEPTION 'LANDLORD_AGREEMENT_REQUIRED'
      USING ERRCODE = '23514',
            DETAIL = 'A current signed 12-month landlord agreement is required before posting a new rent request as an agent.';
  END IF;

  RETURN NEW;
END;
$$;