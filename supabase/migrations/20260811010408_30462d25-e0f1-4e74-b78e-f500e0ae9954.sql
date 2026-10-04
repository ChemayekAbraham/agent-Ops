ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS ug_village_id INTEGER NULL;

CREATE OR REPLACE FUNCTION public.log_profile_field_changes()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  audited TEXT[] := ARRAY[
    'full_name','phone','email','avatar_url','national_id',
    'mobile_money_number','mobile_money_provider',
    'continent','country','region','district','city','town',
    'sub_county','parish','village','landmark','ug_village_id',
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
$function$;