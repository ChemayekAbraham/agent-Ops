-- SC-2: renewals no longer need family size or work / business.
--
-- Agents renewing a tenant's Rent Plan were blocked with
--   "SC-2: fill family size, work / business before this request can go to Agent Ops."
-- A renewal is the same tenant in the same house, so those intake details are
-- not asked again. New requests (registration_type <> 'renewal') are unchanged.
-- The LC1 item (letter or phone confirmation) still applies to every request.
--
-- Rebuilt from the live production definitions on 2026-11-09. CREATE OR REPLACE
-- keeps the existing grants.
--
-- _sc2_missing feeds: trg_e32_sc2_status_guard (service_center_review -> pending),
-- trg_e32_sc_review_rules (Service Centre "pass" review) and _ao_items_missing.
-- agent_requests_missing_details is the agent home "Complete your requests" list,
-- which asked for the same two fields.

create or replace function public._sc2_missing(p_request_id uuid)
 returns text[]
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select array_remove(array[
    case when coalesce(r.registration_type, '') <> 'renewal'
              and not exists (select 1 from public.pipeline_intake_details i where i.rent_request_id = r.id and i.family_size is not null) then 'family size' end,
    case when coalesce(r.registration_type, '') <> 'renewal'
              and not exists (select 1 from public.pipeline_intake_details i where i.rent_request_id = r.id and i.work_business is not null)
              and nullif(btrim(coalesce(t.occupation, '')), '') is null then 'work / business' end,
    case when nullif(btrim(coalesce(r.lc_letter_path, '')), '') is null
              and not exists (select 1 from public.pipeline_intake_details i where i.rent_request_id = r.id and nullif(btrim(coalesce(i.lc1_phone_confirmation, '')), '') is not null)
         then 'LC1 (letter or phone confirmation)' end
  ], null)
  from public.rent_requests r left join public.profiles t on t.id = r.tenant_id
  where r.id = p_request_id
$function$;

create or replace function public.agent_requests_missing_details()
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'Not authenticated' using errcode = '42501'; end if;
  return jsonb_build_object('rows', coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', r.id, 'req', left(r.id::text, 8), 'tenant', coalesce(t.full_name, '—'), 'status', r.status,
             'submitted_at', r.created_at, 'rent', r.rent_amount,
             'missing', to_jsonb(array_remove(array[
                case when coalesce(r.registration_type, '') <> 'renewal'
                          and not exists (select 1 from public.pipeline_intake_details i where i.rent_request_id = r.id and i.family_size is not null) then 'family_size' end,
                case when coalesce(r.registration_type, '') <> 'renewal'
                          and not exists (select 1 from public.pipeline_intake_details i where i.rent_request_id = r.id and i.work_business is not null)
                          and nullif(btrim(coalesce(t.occupation, '')), '') is null then 'work_business' end,
                case when nullif(btrim(coalesce(r.lc_letter_path, '')), '') is null
                          and not exists (select 1 from public.pipeline_intake_details i where i.rent_request_id = r.id and i.lc1_phone_confirmation is not null) then 'lc1_letter' end,
                case when array_length(regexp_split_to_array(btrim(coalesce(t.full_name, '')), E'\\s+'), 1) < 2 then 'tenant_full_name' end
             ], null)))
           order by r.created_at)
    from public.rent_requests r
    left join public.profiles t on t.id = r.tenant_id
    where v_uid in (r.agent_id, r.assigned_agent_id)
      and r.status in ('service_center_review','pending')
      and not (r.created_at >= '2026-08-11' and r.created_at < '2026-08-20')
      and ((coalesce(r.registration_type, '') <> 'renewal'
            and (not exists (select 1 from public.pipeline_intake_details i where i.rent_request_id = r.id and i.family_size is not null)
                 or not exists (select 1 from public.pipeline_intake_details i where i.rent_request_id = r.id and i.work_business is not null)))
           or (nullif(btrim(coalesce(r.lc_letter_path, '')), '') is null
               and not exists (select 1 from public.pipeline_intake_details i where i.rent_request_id = r.id and i.lc1_phone_confirmation is not null))
           or array_length(regexp_split_to_array(btrim(coalesce(t.full_name, '')), E'\\s+'), 1) < 2)
  ), '[]'::jsonb),
  'rule', 'E30 T4: agent completes family size, work, LC1 letter and the tenant''s full name before Agent Ops (renewals: LC1 letter and full name only)');
end $function$;
