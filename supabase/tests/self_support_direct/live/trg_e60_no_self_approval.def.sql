CREATE OR REPLACE FUNCTION public.trg_e60_no_self_approval()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if auth.uid() is not null and auth.uid() = new.partner_id then
    -- Direct release: the funder releases their own float, no Partner Ops approval by design.
    if coalesce(current_setting('app.funder_direct_release', true), '') = 'on'
       and public._pipeline_switch_on('funder_direct_release') then
      return new;
    end if;
    raise exception 'E60_SELF_APPROVAL: you cannot approve your own funding. Another Partner Ops approver must approve it.' using errcode = '42501';
  end if;
  return new;
end $function$
