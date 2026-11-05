create or replace function public._welile_signages_audit()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' or new.status is distinct from old.status then
    insert into public.welile_signage_status_events(signage_id, from_status, to_status, changed_by, note)
    values (new.id, case when tg_op = 'UPDATE' then old.status end, new.status, auth.uid(),
            case when new.status = 'rejected' then new.rejection_reason else new.review_notes end);
  end if;
  return new;
end $$;