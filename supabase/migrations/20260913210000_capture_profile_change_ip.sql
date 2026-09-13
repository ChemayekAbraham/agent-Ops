-- Item 3: capture IP/user-agent on profile changes, extending the existing
-- profile_field_audit trail rather than building a parallel one.
--
-- Directly closes the gap CASE MP-20260913-01 hit hardest: whoever visited
-- Settings at 11:56:47 on 09-13, four minutes before the disputed
-- withdrawal, left no trace of what they did there or from where -- because
-- no audit table captured a mobile_money_name change at all (only number
-- and provider were tracked), and nothing captured IP for any profile
-- change.
--
-- log_profile_field_changes() already writes to profile_field_audit for a
-- fixed list of sensitive fields, including mobile_money_number and
-- mobile_money_provider -- but not mobile_money_name, the field most likely
-- to reveal a fraudulent registered-account swap. Adding it.
--
-- Same request.headers capture pattern as the prior two items in this
-- series (20260913180000 withdrawal_requests, 20260913200000
-- general_ledger). Non-blocking: captured once per trigger invocation and
-- reused for every audited field that changed in that UPDATE, never allowed
-- to fail a real profile save.

ALTER TABLE public.profile_field_audit
  ADD COLUMN IF NOT EXISTS ip_address text,
  ADD COLUMN IF NOT EXISTS user_agent text;

CREATE OR REPLACE FUNCTION public.log_profile_field_changes()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  audited TEXT[] := ARRAY[
    'full_name','phone','email','avatar_url','national_id',
    'mobile_money_number','mobile_money_name','mobile_money_provider',
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
  v_headers jsonb;
  v_ip text;
  v_ua text;
BEGIN
  BEGIN
    v_headers := coalesce(current_setting('request.headers', true), '{}')::jsonb;
    v_ip := nullif(split_part(coalesce(v_headers ->> 'x-forwarded-for', ''), ',', 1), '');
    IF v_ip IS NULL THEN
      v_ip := nullif(v_headers ->> 'cf-connecting-ip', '');
    END IF;
    v_ua := v_headers ->> 'user-agent';
  EXCEPTION WHEN OTHERS THEN
    v_ip := NULL;
    v_ua := NULL;
  END;

  FOREACH f IN ARRAY audited LOOP
    ov := oldj ->> f;
    nv := newj ->> f;
    IF ov IS DISTINCT FROM nv THEN
      INSERT INTO public.profile_field_audit (user_id, changed_by, field_name, old_value, new_value, ip_address, user_agent)
      VALUES (NEW.id, auth.uid(), f, ov, nv, v_ip, v_ua);
    END IF;
  END LOOP;
  RETURN NEW;
END;
$function$;
