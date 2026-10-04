
-- Allow agents to UPDATE basic contact fields of tenants they manage
-- (referred tenants OR tenants they have a rent_request relationship with)
CREATE POLICY "Agents can update managed tenant contact info"
ON public.profiles
FOR UPDATE
TO authenticated
USING (
  has_role(auth.uid(), 'agent'::app_role)
  AND (
    referrer_id = auth.uid()
    OR id IN (
      SELECT rr.tenant_id
      FROM public.rent_requests rr
      WHERE rr.agent_id = auth.uid()
    )
  )
)
WITH CHECK (
  has_role(auth.uid(), 'agent'::app_role)
  AND (
    referrer_id = auth.uid()
    OR id IN (
      SELECT rr.tenant_id
      FROM public.rent_requests rr
      WHERE rr.agent_id = auth.uid()
    )
  )
);

-- Trigger to ensure agents can ONLY change phone, full_name, email, national_id
-- (any attempt to change other columns is silently reverted)
CREATE OR REPLACE FUNCTION public.restrict_agent_profile_edits()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Only enforce when the editor is an agent (and not the profile owner, manager, hr, etc.)
  IF has_role(auth.uid(), 'agent'::app_role)
     AND auth.uid() <> NEW.id
     AND NOT has_role(auth.uid(), 'manager'::app_role)
     AND NOT has_role(auth.uid(), 'hr'::app_role)
     AND NOT has_role(auth.uid(), 'super_admin'::app_role) THEN

    -- Lock everything except the 4 allowed fields
    NEW.id := OLD.id;
    NEW.created_at := OLD.created_at;
    NEW.referrer_id := OLD.referrer_id;
    NEW.verified := OLD.verified;
    NEW.monthly_rent := OLD.monthly_rent;
    NEW.avatar_url := OLD.avatar_url;
    NEW.role := OLD.role;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_restrict_agent_profile_edits ON public.profiles;
CREATE TRIGGER trg_restrict_agent_profile_edits
BEFORE UPDATE ON public.profiles
FOR EACH ROW
EXECUTE FUNCTION public.restrict_agent_profile_edits();
