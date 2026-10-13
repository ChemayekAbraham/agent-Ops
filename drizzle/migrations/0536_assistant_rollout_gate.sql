-- Agent assistant: rollout gate, CRM access alignment, tamper-proof escalation resolution.
--
-- 1. Rollout gate. Until the assistant is opened to everyone it is enabled only for users on an
--    allowlist, keyed by USER ID. Not by email: sign-in here is phone-based, so auth.users.email
--    is a synthetic address and a check on the signed-in email would never match the real person.
--    A single config row switches the whole feature to every agent later:
--        update public.assistant_config set value = 'all_agents' where key = 'rollout';
--    The gate is enforced in assistant_require_agent(), which every tool RPC calls first, so it
--    cannot be bypassed by calling the database functions directly instead of the edge function.
-- 2. The /crm/dashboard route admits crm, super_admin and cto, but the log-table policies omitted
--    cto, so a CTO-only user would have seen an empty view. cto is added.
-- 3. resolved_by / resolved_at are stamped by a trigger from auth.uid() instead of being sent by
--    the client, so the audit trail of who closed an escalation cannot be forged.

-- ---------------------------------------------------------------------------
-- 1. Rollout configuration (no client access; service role / migrations only)
-- ---------------------------------------------------------------------------
create table if not exists public.assistant_config (
  key         text primary key,
  value       text not null,
  updated_at  timestamptz not null default now()
);

create table if not exists public.assistant_access_allowlist (
  user_id     uuid primary key,
  note        text,
  created_at  timestamptz not null default now()
);

alter table public.assistant_config enable row level security;
alter table public.assistant_access_allowlist enable row level security;
revoke all on public.assistant_config from anon, authenticated;
revoke all on public.assistant_access_allowlist from anon, authenticated;

insert into public.assistant_config (key, value)
values ('rollout', 'allowlist')
on conflict (key) do nothing;

-- pexpert46@gmail.com (profile email; the login email is a phone-based synthetic address).
insert into public.assistant_access_allowlist (user_id, note)
values ('0b109aad-212a-4fd0-ab03-3d7aee9cf397', 'pexpert46@gmail.com - initial rollout')
on conflict (user_id) do nothing;

create or replace function public.assistant_has_access()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select auth.uid() is not null
     and (
       coalesce((select c.value from public.assistant_config c where c.key = 'rollout'), 'allowlist') = 'all_agents'
       or exists (select 1 from public.assistant_access_allowlist a where a.user_id = auth.uid())
     );
$$;

-- Every tool RPC calls this first: signed in -> rollout access -> agent footprint.
create or replace function public.assistant_require_agent()
returns void
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  if not public.assistant_has_access() then
    raise exception 'assistant_not_enabled' using errcode = '42501';
  end if;
  if not public.assistant_is_agent() then
    raise exception 'not_an_agent' using errcode = '42501';
  end if;
end;
$$;

revoke execute on function public.assistant_has_access() from public, anon;
grant  execute on function public.assistant_has_access() to authenticated, service_role;

-- CREATE OR REPLACE keeps the existing ACL, but state it so the intent survives a future edit.
revoke execute on function public.assistant_require_agent() from public, anon, authenticated;
grant  execute on function public.assistant_require_agent() to service_role;

-- ---------------------------------------------------------------------------
-- 2. CRM access: add cto (the /crm/dashboard route admits crm, super_admin, cto)
-- ---------------------------------------------------------------------------
alter policy "CRM team reads assistant conversations" on public.assistant_conversations
  using (
    public.has_role(auth.uid(), 'crm'::app_role) or public.has_role(auth.uid(), 'cto'::app_role)
    or public.has_role(auth.uid(), 'manager'::app_role) or public.has_role(auth.uid(), 'coo'::app_role)
    or public.has_role(auth.uid(), 'ceo'::app_role) or public.has_role(auth.uid(), 'super_admin'::app_role)
  );

alter policy "CRM team reads assistant messages" on public.assistant_messages
  using (
    public.has_role(auth.uid(), 'crm'::app_role) or public.has_role(auth.uid(), 'cto'::app_role)
    or public.has_role(auth.uid(), 'manager'::app_role) or public.has_role(auth.uid(), 'coo'::app_role)
    or public.has_role(auth.uid(), 'ceo'::app_role) or public.has_role(auth.uid(), 'super_admin'::app_role)
  );

alter policy "CRM team reads assistant escalations" on public.assistant_escalations
  using (
    public.has_role(auth.uid(), 'crm'::app_role) or public.has_role(auth.uid(), 'cto'::app_role)
    or public.has_role(auth.uid(), 'manager'::app_role) or public.has_role(auth.uid(), 'coo'::app_role)
    or public.has_role(auth.uid(), 'ceo'::app_role) or public.has_role(auth.uid(), 'super_admin'::app_role)
  );

alter policy "CRM team works assistant escalations" on public.assistant_escalations
  using (
    public.has_role(auth.uid(), 'crm'::app_role) or public.has_role(auth.uid(), 'cto'::app_role)
    or public.has_role(auth.uid(), 'manager'::app_role) or public.has_role(auth.uid(), 'coo'::app_role)
    or public.has_role(auth.uid(), 'ceo'::app_role) or public.has_role(auth.uid(), 'super_admin'::app_role)
  )
  with check (
    public.has_role(auth.uid(), 'crm'::app_role) or public.has_role(auth.uid(), 'cto'::app_role)
    or public.has_role(auth.uid(), 'manager'::app_role) or public.has_role(auth.uid(), 'coo'::app_role)
    or public.has_role(auth.uid(), 'ceo'::app_role) or public.has_role(auth.uid(), 'super_admin'::app_role)
  );

-- ---------------------------------------------------------------------------
-- 3. Server-stamped resolution
-- ---------------------------------------------------------------------------
-- The CRM may now change only status, assignee and notes. Who resolved it, and when, is stamped
-- here from the verified session.
revoke update on public.assistant_escalations from authenticated;
grant  update (status, assigned_to, resolution_notes) on public.assistant_escalations to authenticated;

create or replace function public.assistant_escalation_stamp_resolution()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.status in ('resolved', 'dismissed') then
    if old.status is distinct from new.status or new.resolved_by is null then
      new.resolved_by := auth.uid();
      new.resolved_at := now();
    else
      new.resolved_by := old.resolved_by;
      new.resolved_at := old.resolved_at;
    end if;
  else
    new.resolved_by := null;
    new.resolved_at := null;
  end if;
  return new;
end;
$$;

drop trigger if exists assistant_escalations_stamp_resolution on public.assistant_escalations;
create trigger assistant_escalations_stamp_resolution
  before update on public.assistant_escalations
  for each row execute function public.assistant_escalation_stamp_resolution();