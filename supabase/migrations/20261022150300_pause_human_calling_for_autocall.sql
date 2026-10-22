-- The Africa's Talking voice number moves to automated calls.
--
-- Human calling from the app (CRM Call Centre and the Tenant Ops Calling
-- Center, both on that number) is PAUSED. Three places refuse it while the flag
-- is set: crm-voice-capability-token and crm-place-call (no new call starts)
-- and crm-voice-callback (any live human leg, e.g. from a browser still holding
-- a voice token, is hung up). crm-voice-callback forwards robot-call callbacks
-- to voice-autocall-ivr, so the number needs no change in the AT dashboard.
--
-- Turning human calling back on is one call by crm, cto or super_admin:
--   select public.voice_autocall_set_human_calling_paused(false, null);

alter table public.voice_autocall_system_status
  add column if not exists human_calling_paused boolean not null default false,
  add column if not exists human_calling_pause_reason text,
  add column if not exists human_calling_paused_at timestamptz,
  add column if not exists human_calling_paused_by uuid references auth.users(id);

update public.voice_autocall_system_status set
  human_calling_paused = true,
  human_calling_pause_reason = 'The phone line moved to automated calls',
  human_calling_paused_at = now()
where id = 1 and not human_calling_paused;

-- Any signed-in staff screen may ask, so call buttons can be hidden.
create or replace function public.crm_human_calling_paused()
returns jsonb
language sql
stable
security definer
set search_path to 'public'
as $$
  select jsonb_build_object(
    'paused', coalesce(s.human_calling_paused, false),
    'reason', s.human_calling_pause_reason,
    'paused_at', s.human_calling_paused_at)
  from public.voice_autocall_system_status s where s.id = 1;
$$;

revoke all on function public.crm_human_calling_paused() from public, anon;
grant execute on function public.crm_human_calling_paused() to authenticated, service_role;

create or replace function public.voice_autocall_set_human_calling_paused(p_paused boolean, p_reason text default null)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  perform public.voice_autocall_assert();
  if p_paused and coalesce(btrim(p_reason), '') = '' then raise exception 'reason_required'; end if;
  update public.voice_autocall_system_status set
    human_calling_paused = p_paused,
    human_calling_pause_reason = case when p_paused then btrim(p_reason) else null end,
    human_calling_paused_at = case when p_paused then now() else null end,
    human_calling_paused_by = case when p_paused then auth.uid() else null end,
    updated_at = now()
  where id = 1;
end;
$$;

revoke all on function public.voice_autocall_set_human_calling_paused(boolean, text) from public, anon;
grant execute on function public.voice_autocall_set_human_calling_paused(boolean, text) to authenticated, service_role;
