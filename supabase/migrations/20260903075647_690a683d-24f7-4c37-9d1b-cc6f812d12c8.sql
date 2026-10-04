CREATE OR REPLACE FUNCTION public.enforce_rent_request_landlord_agreement()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- A signed landlord agreement is required only at the point an authenticated
  -- agent posts a brand-new ordinary rent request. This trigger runs on INSERT
  -- only; later review, approval, funding, and other pipeline updates do not
  -- evaluate agreement presence.
  IF TG_OP <> 'INSERT'
     OR NEW.landlord_id IS NULL
     OR auth.uid() IS DISTINCT FROM NEW.agent_id
     OR COALESCE(NEW.registration_type, 'normal') <> 'normal' THEN
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