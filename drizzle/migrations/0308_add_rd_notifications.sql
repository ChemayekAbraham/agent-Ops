CREATE OR REPLACE FUNCTION public.block_all_notification_inserts()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF COALESCE(NEW.type, '') IN ('merchandise_recovery', 'director_requisition', 'advance_arrears', 'budget', 'staff_requisition', 'hr_birthday', 'rd_alert') THEN
    RETURN NEW;
  END IF;
  IF COALESCE(NEW.metadata->>'action','') IN (
    'listing_rejected',
    'subagent_listing_rejected'
  ) THEN
    RETURN NEW;
  END IF;
  RETURN NULL;
END;
$function$;

create or replace function public.rd_lead_user_ids()
returns setof uuid language sql stable security definer set search_path = public as $$
  select distinct s.user_id
    from public.hr_assignments a
    join public.hr_positions p on p.id = a.position_id
    join public.hr_staff s on s.id = a.staff_id
   where a.ended_on is null and s.active and p.key = 'chief_product_officer';
$$;

create or replace function public.rd_notify(p_user uuid, p_title text, p_message text, p_link text, p_event_key text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if p_user is null then
    return;
  end if;
  if exists (select 1 from public.notifications n where n.user_id = p_user and n.event_key = p_event_key) then
    return;
  end if;
  insert into public.notifications(user_id, title, message, type, event_key, link_path, metadata)
  values (p_user, p_title, p_message, 'rd_alert', p_event_key, p_link, jsonb_build_object('source', 'rd'));
end $$;

create or replace function public.rd_signals_notify()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  u uuid;
begin
  if NEW.severity = 'p0' then
    for u in select public.rd_lead_user_ids() loop
      perform public.rd_notify(u, 'R&D: new P0 signal', left(NEW.body, 200), '/rd/signals', 'rd_p0_signal:' || NEW.id::text);
    end loop;
  end if;
  return NEW;
end $$;

create trigger rd_signals_notify_trg after insert on public.rd_signals
  for each row execute function public.rd_signals_notify();

create or replace function public.rd_missions_notify()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if NEW.owner_id is not null and NEW.owner_id is distinct from auth.uid()
     and (TG_OP = 'INSERT' or NEW.owner_id is distinct from OLD.owner_id) then
    perform public.rd_notify(NEW.owner_id, 'R&D: you own a mission', NEW.title, '/rd/missions/' || NEW.id::text,
      'rd_assign:' || NEW.id::text || ':owner:' || NEW.owner_id::text);
  end if;
  if NEW.deputy_id is not null and NEW.deputy_id is distinct from auth.uid()
     and (TG_OP = 'INSERT' or NEW.deputy_id is distinct from OLD.deputy_id) then
    perform public.rd_notify(NEW.deputy_id, 'R&D: you are deputy on a mission', NEW.title, '/rd/missions/' || NEW.id::text,
      'rd_assign:' || NEW.id::text || ':deputy:' || NEW.deputy_id::text);
  end if;
  return NEW;
end $$;

create trigger rd_missions_notify_trg after insert or update of owner_id, deputy_id on public.rd_missions
  for each row execute function public.rd_missions_notify();

create or replace function public.rd_p0_overdue_sweep()
returns integer language plpgsql security definer set search_path = public as $$
declare
  s record;
  u uuid;
  n integer := 0;
begin
  for s in select id, body from public.rd_signals
            where severity = 'p0' and status = 'new' and created_at < now() - interval '48 hours' loop
    for u in select public.rd_lead_user_ids() loop
      perform public.rd_notify(u, 'R&D: P0 signal unseen for 48 hours', left(s.body, 200), '/rd/signals', 'rd_p0_48h:' || s.id::text);
      n := n + 1;
    end loop;
  end loop;
  return n;
end $$;

revoke execute on function public.rd_lead_user_ids() from public, anon, authenticated;
revoke execute on function public.rd_notify(uuid, text, text, text, text) from public, anon, authenticated;
revoke execute on function public.rd_signals_notify() from public, anon, authenticated;
revoke execute on function public.rd_missions_notify() from public, anon, authenticated;
revoke execute on function public.rd_p0_overdue_sweep() from public, anon, authenticated;

select cron.schedule('rd-p0-signal-48h', '7 * * * *', $$select public.rd_p0_overdue_sweep()$$);