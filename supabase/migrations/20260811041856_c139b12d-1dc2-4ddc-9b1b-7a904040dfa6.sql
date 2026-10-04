CREATE OR REPLACE FUNCTION public.my_partner_lead_invite()
 RETURNS TABLE(code text, uses_count integer, expires_at timestamp with time zone, revoked boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
#variable_conflict use_column
declare v_code text;
begin
  if auth.uid() is null then return; end if;

  -- Allowed: staff holding an active "Lead Partner Growth" position, OR any agent
  if not exists (
    select 1
      from public.hr_staff s
      join public.hr_assignments a on a.staff_id = s.id and a.ended_on is null
      join public.hr_positions p on p.id = a.position_id
     where s.user_id = auth.uid()
       and s.active
       and lower(p.title) = 'lead partner growth'
  ) and not exists (
    select 1 from public.user_roles ur
     where ur.user_id = auth.uid()
       and ur.role::text in ('agent','senior_agent','sub_agent')
  ) then
    return;
  end if;

  select i.code into v_code
    from public.partner_lead_invites i
   where i.lead_user_id = auth.uid() and i.revoked_at is null
   limit 1;

  if v_code is null then
    v_code := upper(substring(replace(gen_random_uuid()::text, '-', '') from 1 for 8));

    insert into public.partner_lead_invites as t (code, lead_user_id)
    values (v_code, auth.uid())
    on conflict (code) do nothing;

    select i.code into v_code
      from public.partner_lead_invites i
     where i.lead_user_id = auth.uid() and i.revoked_at is null
     limit 1;
  end if;

  if v_code is null then return; end if;

  return query
  select i.code, i.uses_count, i.expires_at, (i.revoked_at is not null)
    from public.partner_lead_invites i
   where i.code = v_code;
end;
$function$;