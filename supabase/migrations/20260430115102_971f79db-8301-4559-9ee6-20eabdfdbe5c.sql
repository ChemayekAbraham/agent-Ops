CREATE OR REPLACE FUNCTION public.enforce_agent_personal_deposit_confirmation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_is_agent boolean;
  v_confirmed text;
BEGIN
  -- Only enforce on personal_deposit. Avoid COALESCE(..., '') because
  -- deposit_purpose is an enum and '' is not a valid enum value.
  IF NEW.deposit_purpose IS DISTINCT FROM 'personal_deposit'::deposit_purpose THEN
    RETURN NEW;
  END IF;

  -- Skip when there's no depositor on the row (defensive; should never happen).
  IF NEW.user_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = NEW.user_id AND role = 'agent'::app_role
  ) INTO v_is_agent;

  IF NOT v_is_agent THEN
    RETURN NEW;
  END IF;

  -- Pull the confirmation stamp out of the audit blob. NULL or missing
  -- → reject with a clear, client-decodable error code.
  v_confirmed := NULLIF(
    (NEW.purpose_audit::jsonb ->> 'agent_personal_confirmed_at'),
    ''
  );

  IF v_confirmed IS NULL THEN
    RAISE EXCEPTION
      'agent_personal_deposit_requires_confirmation: agents must explicitly confirm a Personal Deposit before submission. Choose Operational Float, or use the in-app confirmation gate.'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.enforce_agent_personal_deposit_confirmation IS
  'Server backstop for the agent default-to-float policy: blocks any agent personal_deposit submission lacking an explicit purpose_audit.agent_personal_confirmed_at stamp. Uses enum-safe comparisons only.';