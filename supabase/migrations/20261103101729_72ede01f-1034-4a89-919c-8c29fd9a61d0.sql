create table public.explanation_demands (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  reference text not null,
  amount numeric,
  message text not null,
  response text,
  responded_at timestamptz,
  cleared_at timestamptz,
  cleared_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
grant select, update on public.explanation_demands to authenticated;
grant all on public.explanation_demands to service_role;
alter table public.explanation_demands enable row level security;
create policy mfa_required_for_staff on public.explanation_demands as restrictive for all to authenticated using ((select public.staff_mfa_ok())) with check ((select public.staff_mfa_ok()));
create policy ed_select on public.explanation_demands for select to authenticated using (
  user_id = (select auth.uid())
  or (select public.has_role((select auth.uid()), 'super_admin'::app_role))
  or (select public.has_role((select auth.uid()), 'ceo'::app_role))
  or (select public.has_role((select auth.uid()), 'admin'::app_role)));
create policy ed_admin_update on public.explanation_demands for update to authenticated using (
  (select public.has_role((select auth.uid()), 'super_admin'::app_role))
  or (select public.has_role((select auth.uid()), 'ceo'::app_role))
  or (select public.has_role((select auth.uid()), 'admin'::app_role)));

create or replace function public.submit_explanation(p_id uuid, p_response text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if length(trim(coalesce(p_response,''))) < 10 then raise exception 'Explanation must be at least 10 characters'; end if;
  update explanation_demands set response = trim(p_response), responded_at = now(), updated_at = now()
   where id = p_id and user_id = auth.uid() and cleared_at is null;
  if not found then raise exception 'Not found'; end if;
end $$;
revoke all on function public.submit_explanation(uuid, text) from public, anon;
grant execute on function public.submit_explanation(uuid, text) to authenticated;

insert into public.explanation_demands (user_id, reference, amount, message) values (
 '59d45ad2-0d44-433c-b4ec-20927a25c281', 'CASHREQ-2660d454', 1005000000,
 'A cash float deposit of UGX 1,005,000,000 (CASHREQ-2660d454) was recorded on your account on 3 Nov 2026 at 11:44 EAT, and UGX 100,000,000 was sent from it to Cherotich Kabbale Sherry. You must explain this transaction to Welile management immediately. — Benjamin Muhanguzi, CEO');