drop policy if exists "Anyone can upload a resume" on storage.objects;

drop policy if exists "Authenticated users can create conversations" on public.conversations;

drop policy if exists "Surface bindings readable by signed-in users" on public.access_surface_positions;
create policy "Surface bindings readable by custodians" on public.access_surface_positions
  for select to authenticated
  using ((select public.has_role((select auth.uid()), 'super_admin'::app_role)) or (select public.has_role((select auth.uid()), 'access_admin'::app_role)));

drop policy if exists "Anyone can submit landlord lead" on public.landlord_leads;
create policy "Anyone can submit landlord lead" on public.landlord_leads
  for insert to anon, authenticated
  with check (
    length(btrim(full_name)) between 2 and 120
    and length(btrim(phone)) between 7 and 20
    and coalesce(status,'new_lead') = 'new_lead'
    and coalesce(is_test_contact,false) = false
    and (property_location is null or length(property_location) <= 300)
    and coalesce(number_of_units,1) between 1 and 1000
  );

drop policy if exists "Anyone can record a share event" on public.house_share_events;
create policy "Anyone can record a share event" on public.house_share_events
  for insert to anon, authenticated
  with check (
    (user_id is null or user_id = (select auth.uid()))
    and (share_method is null or length(share_method) <= 40)
    and (short_code is null or length(short_code) <= 64)
  );

drop policy if exists "Anyone can insert public error logs" on public.public_error_logs;
create policy "Anyone can insert public error logs" on public.public_error_logs
  for insert to anon, authenticated
  with check (
    coalesce(length(pathname),0) <= 2000
    and coalesce(length(user_agent),0) <= 1000
    and coalesce(length(error_message),0) <= 5000
    and coalesce(length(error_stack),0) <= 20000
    and coalesce(pg_column_size(metadata),0) <= 20000
  );

drop policy if exists "Anyone can insert browser compat events" on public.browser_compat_events;
create policy "Anyone can insert browser compat events" on public.browser_compat_events
  for insert to anon, authenticated
  with check (
    coalesce(length(event_type),0) <= 100
    and coalesce(length(user_agent),0) <= 1000
    and coalesce(length(error_message),0) <= 5000
    and coalesce(length(choice),0) <= 100
    and coalesce(pg_column_size(device),0) <= 10000
  );

drop policy if exists "Anyone can log oauth funnel events" on public.oauth_funnel_events;
create policy "Anyone can log oauth funnel events" on public.oauth_funnel_events
  for insert to anon, authenticated
  with check (
    (user_id is null or user_id = (select auth.uid()))
    and coalesce(length(stage),0) <= 100
    and coalesce(length(provider),0) <= 50
    and coalesce(length(error_message),0) <= 5000
    and coalesce(length(user_agent),0) <= 1000
  );

drop policy if exists "insert perf metrics" on public.ops_perf_metrics;
create policy "insert perf metrics" on public.ops_perf_metrics
  for insert to authenticated
  with check (
    (user_id is null or user_id = (select auth.uid()))
    and coalesce(length(screen),0) <= 200
    and coalesce(length(action),0) <= 200
  );

drop policy if exists "Anyone can log update-failure telemetry" on public.update_failure_events;
create policy "Anyone can log update-failure telemetry" on public.update_failure_events
  for insert to anon, authenticated
  with check (
    coalesce(length(event_type),0) <= 100
    and coalesce(length(user_agent),0) <= 1000
    and coalesce(length(url),0) <= 2000
    and coalesce(length(session_id),0) <= 200
    and coalesce(pg_column_size(details),0) <= 20000
  );