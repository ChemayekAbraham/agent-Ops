CREATE OR REPLACE FUNCTION public.restrict_agent_profile_edits()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  -- Only enforce when the editor is an agent (and not the profile owner, manager, hr, etc.)
  IF has_role(auth.uid(), 'agent'::app_role)
     AND auth.uid() <> NEW.id
     AND NOT has_role(auth.uid(), 'manager'::app_role)
     AND NOT has_role(auth.uid(), 'hr'::app_role)
     AND NOT has_role(auth.uid(), 'super_admin'::app_role) THEN

    -- Lock sensitive fields. (NEW.role removed: profiles no longer has a role column;
    -- referencing it raised 'record "new" has no field "role"' and blocked every agent edit.)
    NEW.id := OLD.id;
    NEW.created_at := OLD.created_at;
    NEW.referrer_id := OLD.referrer_id;
    NEW.verified := OLD.verified;
    NEW.monthly_rent := OLD.monthly_rent;
    NEW.avatar_url := OLD.avatar_url;
  END IF;

  RETURN NEW;
END;
$function$;