CREATE OR REPLACE FUNCTION public.trg_e34_empty_house_funding_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if public._pipeline_switch_on('funders_empty_houses') then return new; end if;
  if exists (select 1 from public.promissory_note_house_intents i where i.house_id = new.house_id and i.status = 'reserved') then
    return new;  -- an existing reservation is honoured
  end if;
  insert into public.audit_logs (action_type, table_name, record_id, user_id, metadata)
  values ('EmptyHouseFundingBlocked', 'house_listings', new.house_id::text, auth.uid(),
          jsonb_build_object('partner_id', new.partner_id, 'principal', new.principal, 'rule', 'E34 FUND-4'));
  raise exception 'Funding empty houses is paused. Fund a verified tenant from "Houses to fund" instead.' using errcode = 'P0001';
end $function$
