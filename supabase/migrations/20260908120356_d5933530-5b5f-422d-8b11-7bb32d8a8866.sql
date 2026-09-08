create or replace function public.pso_can_view_my_performance()
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $function$
  select public.pso_is_officer()
    or public.hr_is_admin()
    or public.hr_is_executive()
    or exists (
      select 1
      from public.user_roles ur
      where ur.user_id = auth.uid()
        and ur.enabled = true
        and ur.role = any (array['coo'::app_role, 'ceo'::app_role, 'super_admin'::app_role])
    );
$function$;

comment on function public.pso_can_view_my_performance() is
  'True when the caller may open /me/performance: an enrolled Platform Sales Officer, or the reviewer chain (hr, super_admin, coo, ceo). Decides only whether the menu entry appears. pso_is_officer() remains the narrow test of whether the caller has personal figures of their own, and the two must never be conflated: a reviewer has no personal series and pso_daily_series returns the whole cohort to them.';

revoke all on function public.pso_can_view_my_performance() from public, anon;
grant execute on function public.pso_can_view_my_performance() to authenticated;