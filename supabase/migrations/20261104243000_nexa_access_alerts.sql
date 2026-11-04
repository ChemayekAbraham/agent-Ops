-- Alerts for blocked Nexa access attempts by non-staff callers. Approved 4 Nov 2026.
-- Written by the welile-ai-chat edge function (service role). Read by staff only.
-- Rollback: drop table public.nexa_access_alerts;
create table if not exists public.nexa_access_alerts (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  user_id uuid,
  phone text,
  channel text not null default 'web' check (channel in ('web','whatsapp')),
  roles text[] not null default '{}',
  attempted_resource text not null,
  user_message text,
  reason text not null,
  notified_founder boolean not null default false
);
create index if not exists nexa_access_alerts_unnotified_idx on public.nexa_access_alerts(created_at desc) where not notified_founder;
create index if not exists nexa_access_alerts_user_idx on public.nexa_access_alerts(user_id, created_at desc);

alter table public.nexa_access_alerts enable row level security;
revoke all on public.nexa_access_alerts from public, anon, authenticated;
grant all on public.nexa_access_alerts to service_role;
grant select on public.nexa_access_alerts to authenticated;

-- No insert/update/delete policies: only the service role (bypasses RLS) can write.
drop policy if exists "Staff can read Nexa access alerts" on public.nexa_access_alerts;
create policy "Staff can read Nexa access alerts" on public.nexa_access_alerts
  for select to authenticated
  using ((select exists (
    select 1 from public.user_roles ur
    where ur.user_id = (select auth.uid()) and ur.enabled = true
      and ur.role::text in ('super_admin','admin','ceo','cto','coo','cfo','cmo','manager','operations','hr','crm','partner_ops','financial_ops')
  )));

drop policy if exists mfa_required_for_staff on public.nexa_access_alerts;
create policy mfa_required_for_staff on public.nexa_access_alerts as restrictive for all to authenticated
  using ((select public.staff_mfa_ok())) with check ((select public.staff_mfa_ok()));
