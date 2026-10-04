-- System-wide audit of profile field changes.
-- A DB trigger captures every change to user-facing profile fields,
-- regardless of which UI or backend path made the update.

CREATE TABLE public.profile_field_audit (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  changed_by UUID,
  field_name TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

CREATE INDEX idx_profile_field_audit_user ON public.profile_field_audit (user_id, created_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.profile_field_audit TO authenticated;
GRANT ALL ON public.profile_field_audit TO service_role;

ALTER TABLE public.profile_field_audit ENABLE ROW LEVEL SECURITY;

-- Users can read their own profile change history.
CREATE POLICY "Users can view their own profile audit"
ON public.profile_field_audit
FOR SELECT
TO authenticated
USING (auth.uid() = user_id);

-- Managers can read everyone's profile change history.
CREATE POLICY "Managers can view all profile audit"
ON public.profile_field_audit
FOR SELECT
TO authenticated
USING (public.has_role(auth.uid(), 'manager'));

-- Trigger function: diff OLD vs NEW for an allowlist of profile fields
-- and record one audit row per changed field.
CREATE OR REPLACE FUNCTION public.log_profile_field_changes()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  audited TEXT[] := ARRAY[
    'full_name','phone','email','avatar_url','national_id',
    'mobile_money_number','mobile_money_provider',
    'continent','country','region','district','city','town',
    'sub_county','parish','village','landmark',
    'residence_lat','residence_lng',
    'primary_persona','occupation','has_smartphone',
    'address_complete','referrer_id','territory','agent_type'
  ];
  f TEXT;
  oldj JSONB := to_jsonb(OLD);
  newj JSONB := to_jsonb(NEW);
  ov TEXT;
  nv TEXT;
BEGIN
  FOREACH f IN ARRAY audited LOOP
    ov := oldj ->> f;
    nv := newj ->> f;
    IF ov IS DISTINCT FROM nv THEN
      INSERT INTO public.profile_field_audit (user_id, changed_by, field_name, old_value, new_value)
      VALUES (NEW.id, auth.uid(), f, ov, nv);
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_log_profile_field_changes
AFTER UPDATE ON public.profiles
FOR EACH ROW
EXECUTE FUNCTION public.log_profile_field_changes();