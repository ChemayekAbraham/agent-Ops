drop policy if exists "v360_settings_read" on public.v360_settings;
create policy v360_settings_read on public.v360_settings
  for select to authenticated
  using (
    (select has_role((select auth.uid()), 'cfo'::app_role))
    or (select has_role((select auth.uid()), 'coo'::app_role))
    or (select has_role((select auth.uid()), 'super_admin'::app_role))
  );