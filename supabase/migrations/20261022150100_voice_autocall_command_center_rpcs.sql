-- Automated call centre — Command Center RPCs.
--
-- Every function here starts with voice_autocall_assert(): crm, cto and
-- super_admin only. Each is granted to `authenticated` explicitly because new
-- functions are closed by default (doc 247 step 23).

-- ───────────────────────── overview ─────────────────────────

create or replace function public.voice_autocall_overview()
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_today date := (now() at time zone 'Africa/Kampala')::date;
begin
  perform public.voice_autocall_assert();
  return jsonb_build_object(
    'as_at', now(),
    'today', v_today,
    'system', (select to_jsonb(s) from public.voice_autocall_system_status s where id = 1),
    'categories', (
      select coalesce(jsonb_agg(x order by x ->> 'category'), '[]'::jsonb) from (
        select jsonb_build_object(
          'category', cs.category,
          'paused', cs.paused,
          'pause_reason', cs.pause_reason,
          'paused_at', cs.paused_at,
          'paused_by_name', (select full_name from public.profiles where id = cs.paused_by),
          'active_campaigns', (select count(*) from public.voice_autocall_campaigns c
                               where c.category = cs.category and c.status = 'active'),
          'people_paused', (select count(*) from public.voice_autocall_person_pauses pp
                            where pp.lifted_at is null and (pp.paused_until is null or pp.paused_until > now())
                              and (pp.category is null or pp.category = cs.category)),
          'today', (
            select jsonb_build_object(
              'total', count(*),
              'queued', count(*) filter (where j.status = 'queued'),
              'live', count(*) filter (where j.status in ('dialing', 'in_progress')),
              'completed', count(*) filter (where j.status = 'completed'),
              'no_answer', count(*) filter (where j.status in ('no_answer', 'busy')),
              'failed', count(*) filter (where j.status = 'failed'),
              'expired', count(*) filter (where j.status in ('expired', 'cancelled')),
              'opted_out', count(*) filter (where j.outcome = 'opted_out'),
              'talk_seconds', coalesce(sum(j.total_duration_seconds), 0),
              'cost', coalesce(sum(j.total_cost), 0))
            from public.voice_autocall_jobs j
            where j.category = cs.category
              and (coalesce(j.last_attempt_at, j.created_at) at time zone 'Africa/Kampala')::date = v_today)
        ) as x
        from public.voice_autocall_category_settings cs
      ) q
    )
  );
end;
$$;

-- ───────────────────────── pause switches ─────────────────────────

-- p_category null = every category (the master switch).
create or replace function public.voice_autocall_set_category_paused(
  p_category text, p_paused boolean, p_reason text default null)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  perform public.voice_autocall_assert();
  if p_paused and coalesce(btrim(p_reason), '') = '' then
    raise exception 'reason_required';
  end if;
  update public.voice_autocall_category_settings set
    paused = p_paused,
    pause_reason = case when p_paused then btrim(p_reason) else null end,
    paused_by = case when p_paused then auth.uid() else null end,
    paused_at = case when p_paused then now() else null end,
    updated_at = now()
  where p_category is null or category = p_category;
  if not found then raise exception 'unknown_category'; end if;
end;
$$;

create or replace function public.voice_autocall_pause_person(
  p_person_id uuid,
  p_category text default null,
  p_reason text default null,
  p_until timestamptz default null,
  p_phone text default null)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_phone text := public.voice_autocall_e164(p_phone);
  v_id uuid;
begin
  perform public.voice_autocall_assert();
  if p_person_id is null and v_phone is null then raise exception 'person_or_phone_required'; end if;
  if coalesce(btrim(p_reason), '') = '' then raise exception 'reason_required'; end if;
  if p_category is not null and p_category not in ('tenant', 'partner', 'agent', 'employee', 'general') then
    raise exception 'unknown_category';
  end if;
  if p_until is not null and p_until <= now() then raise exception 'until_must_be_in_future'; end if;
  if v_phone is null and p_person_id is not null then
    select public.voice_autocall_e164(phone) into v_phone from public.profiles where id = p_person_id;
  end if;

  insert into public.voice_autocall_person_pauses (person_id, phone, category, reason, source, paused_until, created_by)
  values (p_person_id, v_phone, p_category, btrim(p_reason), 'staff', p_until, auth.uid())
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.voice_autocall_lift_pause(p_pause_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  perform public.voice_autocall_assert();
  update public.voice_autocall_person_pauses set lifted_at = now(), lifted_by = auth.uid()
  where id = p_pause_id and lifted_at is null;
  if not found then raise exception 'pause_not_found_or_already_lifted'; end if;
end;
$$;

create or replace function public.voice_autocall_pauses_list(
  p_category text default null, p_include_lifted boolean default false, p_search text default null)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
begin
  perform public.voice_autocall_assert();
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', pp.id,
      'person_id', pp.person_id,
      'person_name', pr.full_name,
      'phone_masked', public.voice_autocall_mask_phone(pp.phone),
      'category', pp.category,
      'reason', pp.reason,
      'source', pp.source,
      'paused_until', pp.paused_until,
      'created_at', pp.created_at,
      'created_by_name', cb.full_name,
      'lifted_at', pp.lifted_at,
      'lifted_by_name', lb.full_name,
      'active', pp.lifted_at is null and (pp.paused_until is null or pp.paused_until > now())
    ) order by pp.created_at desc)
    from public.voice_autocall_person_pauses pp
    left join public.profiles pr on pr.id = pp.person_id
    left join public.profiles cb on cb.id = pp.created_by
    left join public.profiles lb on lb.id = pp.lifted_by
    where (p_include_lifted or pp.lifted_at is null)
      and (p_category is null or pp.category is null or pp.category = p_category)
      and (p_search is null or pr.full_name ilike '%' || p_search || '%' or pp.phone like '%' || regexp_replace(p_search, '\D', '', 'g') || '%')
  ), '[]'::jsonb);
end;
$$;

-- ───────────────────────── scripts ─────────────────────────

create or replace function public.voice_autocall_scripts_list(
  p_category text default null, p_include_inactive boolean default true)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
begin
  perform public.voice_autocall_assert();
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', s.id, 'code', s.code, 'category', s.category, 'name', s.name, 'occasion', s.occasion,
      'description', s.description, 'language', s.language, 'steps', s.steps, 'version', s.version,
      'is_active', s.is_active, 'updated_at', s.updated_at,
      'updated_by_name', (select full_name from public.profiles where id = s.updated_by),
      'used_by_campaigns', (select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'status', c.status)), '[]'::jsonb)
                            from public.voice_autocall_campaigns c where c.script_id = s.id and c.status <> 'archived')
    ) order by s.category, s.name)
    from public.voice_autocall_scripts s
    where (p_category is null or s.category = p_category) and (p_include_inactive or s.is_active)
  ), '[]'::jsonb);
end;
$$;

-- Create (p_id null) or edit. Every save keeps the previous text as a version.
create or replace function public.voice_autocall_script_save(
  p_id uuid,
  p_category text,
  p_name text,
  p_occasion text,
  p_description text,
  p_steps jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  s public.voice_autocall_scripts;
begin
  perform public.voice_autocall_assert();
  perform public.voice_autocall_validate_steps(p_steps);
  if p_category not in ('tenant', 'partner', 'agent', 'employee', 'general') then raise exception 'unknown_category'; end if;

  if p_id is null then
    insert into public.voice_autocall_scripts (category, name, occasion, description, steps, created_by, updated_by)
    values (p_category, btrim(p_name), coalesce(nullif(btrim(p_occasion), ''), 'general'), p_description, p_steps, auth.uid(), auth.uid())
    returning * into s;
  else
    select * into s from public.voice_autocall_scripts where id = p_id for update;
    if not found then raise exception 'script_not_found'; end if;
    if s.category <> p_category and exists (
      select 1 from public.voice_autocall_campaigns where script_id = p_id and status <> 'archived') then
      raise exception 'script_in_use: move its campaigns to another script before changing the category';
    end if;
    update public.voice_autocall_scripts set
      category = p_category,
      name = btrim(p_name),
      occasion = coalesce(nullif(btrim(p_occasion), ''), 'general'),
      description = p_description,
      steps = p_steps,
      version = version + 1,
      updated_by = auth.uid(),
      updated_at = now()
    where id = p_id
    returning * into s;
  end if;

  insert into public.voice_autocall_script_versions (script_id, version, name, occasion, description, steps, saved_by)
  values (s.id, s.version, s.name, s.occasion, s.description, s.steps, auth.uid());

  return jsonb_build_object('id', s.id, 'version', s.version);
end;
$$;

create or replace function public.voice_autocall_script_set_active(p_id uuid, p_active boolean)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  perform public.voice_autocall_assert();
  if not p_active and exists (
    select 1 from public.voice_autocall_campaigns where script_id = p_id and status = 'active') then
    raise exception 'script_in_use: an active campaign uses this script';
  end if;
  update public.voice_autocall_scripts set is_active = p_active, updated_by = auth.uid(), updated_at = now()
  where id = p_id;
  if not found then raise exception 'script_not_found'; end if;
end;
$$;

create or replace function public.voice_autocall_script_versions(p_script_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
begin
  perform public.voice_autocall_assert();
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'version', v.version, 'name', v.name, 'occasion', v.occasion, 'description', v.description,
      'steps', v.steps, 'saved_at', v.saved_at, 'saved_by_name', pr.full_name
    ) order by v.version desc)
    from public.voice_autocall_script_versions v
    left join public.profiles pr on pr.id = v.saved_by
    where v.script_id = p_script_id
  ), '[]'::jsonb);
end;
$$;

-- ───────────────────────── campaigns ─────────────────────────

create or replace function public.voice_autocall_campaigns_list(p_category text default null)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
begin
  perform public.voice_autocall_assert();
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', c.id, 'code', c.code, 'category', c.category, 'name', c.name, 'description', c.description,
      'script_id', c.script_id, 'script_name', s.name, 'script_version', s.version,
      'audience_kind', c.audience_kind, 'schedule_kind', c.schedule_kind, 'start_at', c.start_at,
      'window_start', to_char(c.window_start, 'HH24:MI'), 'window_end', to_char(c.window_end, 'HH24:MI'),
      'days_of_week', c.days_of_week, 'max_attempts', c.max_attempts, 'retry_minutes', c.retry_minutes,
      'record_calls', c.record_calls, 'status', c.status, 'updated_at', c.updated_at,
      'updated_by_name', (select full_name from public.profiles where id = c.updated_by),
      'last_run', (
        select jsonb_build_object(
          'run_date', r.run_date, 'built_at', r.built_at, 'audience', r.audience_count,
          'skipped_paused', r.skipped_count, 'expires_at', r.expires_at,
          'queued', count(j.*) filter (where j.status = 'queued'),
          'live', count(j.*) filter (where j.status in ('dialing', 'in_progress')),
          'completed', count(j.*) filter (where j.status = 'completed'),
          'no_answer', count(j.*) filter (where j.status in ('no_answer', 'busy')),
          'failed', count(j.*) filter (where j.status = 'failed'),
          'expired', count(j.*) filter (where j.status in ('expired', 'cancelled')))
        from public.voice_autocall_runs r
        left join public.voice_autocall_jobs j on j.run_id = r.id
        where r.campaign_id = c.id
        group by r.id
        order by r.run_date desc
        limit 1)
    ) order by c.category, c.window_start)
    from public.voice_autocall_campaigns c
    join public.voice_autocall_scripts s on s.id = c.script_id
    where (p_category is null or c.category = p_category) and c.status <> 'archived'
  ), '[]'::jsonb);
end;
$$;

create or replace function public.voice_autocall_campaign_save(
  p_id uuid,
  p_category text,
  p_name text,
  p_description text,
  p_script_id uuid,
  p_audience_kind text,
  p_schedule_kind text,
  p_start_at timestamptz,
  p_window_start time,
  p_window_end time,
  p_days_of_week smallint[],
  p_max_attempts smallint default 3,
  p_retry_minutes integer default 120,
  p_record_calls boolean default true)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_script_cat text;
  v_id uuid;
begin
  perform public.voice_autocall_assert();
  select category into v_script_cat from public.voice_autocall_scripts where id = p_script_id and is_active;
  if v_script_cat is null then raise exception 'script_not_found_or_inactive'; end if;
  if v_script_cat <> p_category then raise exception 'script_category_mismatch'; end if;
  if p_audience_kind like 'tenant_%' and p_category <> 'tenant' then
    raise exception 'audience_category_mismatch';
  end if;

  if p_id is null then
    insert into public.voice_autocall_campaigns (
      category, name, description, script_id, audience_kind, schedule_kind, start_at,
      window_start, window_end, days_of_week, max_attempts, retry_minutes, record_calls,
      status, created_by, updated_by)
    values (
      p_category, btrim(p_name), p_description, p_script_id, p_audience_kind, p_schedule_kind, p_start_at,
      p_window_start, p_window_end, p_days_of_week, p_max_attempts, p_retry_minutes, p_record_calls,
      'draft', auth.uid(), auth.uid())
    returning id into v_id;
  else
    update public.voice_autocall_campaigns set
      category = p_category, name = btrim(p_name), description = p_description, script_id = p_script_id,
      audience_kind = p_audience_kind, schedule_kind = p_schedule_kind, start_at = p_start_at,
      window_start = p_window_start, window_end = p_window_end, days_of_week = p_days_of_week,
      max_attempts = p_max_attempts, retry_minutes = p_retry_minutes, record_calls = p_record_calls,
      updated_by = auth.uid(), updated_at = now()
    where id = p_id and status <> 'archived'
    returning id into v_id;
    if v_id is null then raise exception 'campaign_not_found'; end if;
  end if;
  return v_id;
end;
$$;

-- active = Start / Resume, paused = Pause, archived = remove. Pausing keeps the
-- queue (it resumes where it stopped) unless p_cancel_queued is true.
create or replace function public.voice_autocall_campaign_set_status(
  p_id uuid, p_status text, p_cancel_queued boolean default false)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  perform public.voice_autocall_assert();
  if p_status not in ('active', 'paused', 'archived') then raise exception 'invalid_status'; end if;
  update public.voice_autocall_campaigns set status = p_status, updated_by = auth.uid(), updated_at = now()
  where id = p_id and status <> 'archived';
  if not found then raise exception 'campaign_not_found'; end if;
  if p_status = 'archived' or p_cancel_queued then
    update public.voice_autocall_jobs set status = 'cancelled', failure_reason = 'cancelled_by_staff', updated_at = now()
    where campaign_id = p_id and status = 'queued';
  end if;
end;
$$;

-- Manual campaigns: add specific people to today's run.
create or replace function public.voice_autocall_add_people(p_campaign_id uuid, p_person_ids uuid[])
returns integer
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  c public.voice_autocall_campaigns;
  s public.voice_autocall_scripts;
  v_run uuid;
  v_today date := (now() at time zone 'Africa/Kampala')::date;
  v_n int;
begin
  perform public.voice_autocall_assert();
  select * into c from public.voice_autocall_campaigns where id = p_campaign_id and status <> 'archived';
  if not found then raise exception 'campaign_not_found'; end if;
  if c.audience_kind <> 'manual' then raise exception 'not_a_manual_campaign'; end if;
  if cardinality(p_person_ids) > 2000 then raise exception 'at_most_2000_people_per_call'; end if;
  select * into s from public.voice_autocall_scripts where id = c.script_id;

  perform public.voice_autocall_build_run(c.id, v_today);
  select id into v_run from public.voice_autocall_runs where campaign_id = c.id and run_date = v_today;

  insert into public.voice_autocall_jobs (
    run_id, campaign_id, script_id, script_version, script_snapshot, category,
    person_id, person_name, phone, variables, max_attempts, retry_minutes, record_calls, expires_at, requested_by)
  select v_run, c.id, s.id, s.version, s.steps, c.category,
         pr.id, pr.full_name, public.voice_autocall_e164(pr.phone),
         jsonb_build_object('first_name', public.voice_autocall_first_name(pr.full_name)),
         c.max_attempts, c.retry_minutes, c.record_calls, r.expires_at, auth.uid()
  from public.profiles pr
  join public.voice_autocall_runs r on r.id = v_run
  where pr.id = any (p_person_ids)
    and pr.deleted_at is null
    and public.voice_autocall_e164(pr.phone) is not null
    and not public.voice_autocall_is_blocked(pr.id, public.voice_autocall_e164(pr.phone), c.category)
  on conflict do nothing;
  get diagnostics v_n = row_count;

  update public.voice_autocall_runs set audience_count = audience_count + v_n where id = v_run;
  return v_n;
end;
$$;

-- Ring a staff member's own phone with a script, to hear it before launch.
-- Dialled within a minute, 07:00–21:00; staff numbers only.
create or replace function public.voice_autocall_test_call(p_script_id uuid, p_person_id uuid default null)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  s public.voice_autocall_scripts;
  v_target uuid := coalesce(p_person_id, auth.uid());
  v_name text;
  v_phone text;
  v_id uuid;
begin
  perform public.voice_autocall_assert();
  if not public.is_welile_staff(v_target) then
    raise exception 'test_calls_are_for_staff_numbers_only';
  end if;
  select * into s from public.voice_autocall_scripts where id = p_script_id;
  if not found then raise exception 'script_not_found'; end if;
  select full_name, public.voice_autocall_e164(phone) into v_name, v_phone from public.profiles where id = v_target;
  if v_phone is null then raise exception 'no_valid_phone_on_profile'; end if;

  insert into public.voice_autocall_jobs (
    script_id, script_version, script_snapshot, category, person_id, person_name, phone, variables,
    is_test, requested_by, max_attempts, retry_minutes, record_calls, expires_at)
  values (
    s.id, s.version, s.steps, s.category, v_target, v_name, v_phone,
    jsonb_build_object(
      'first_name', public.voice_autocall_first_name(v_name),
      'amount', '50,000',
      'date', to_char((now() at time zone 'Africa/Kampala')::date, 'FMDD FMMonth'),
      'agent_name', 'your agent',
      'message', 'This is a test message from the Welile automated call centre'),
    true, auth.uid(), 1, 15, true, now() + interval '30 minutes')
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.voice_autocall_cancel_job(p_job_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  perform public.voice_autocall_assert();
  update public.voice_autocall_jobs set status = 'cancelled', failure_reason = 'cancelled_by_staff', updated_at = now()
  where id = p_job_id and status = 'queued';
  if not found then raise exception 'job_not_queued'; end if;
end;
$$;

-- ───────────────────────── call log + playback ─────────────────────────

create or replace function public.voice_autocall_calls_feed(
  p_category text default null,
  p_campaign_id uuid default null,
  p_status text default null,
  p_outcome text default null,
  p_from date default null,
  p_to date default null,
  p_search text default null,
  p_limit integer default 50,
  p_offset integer default 0)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_digits text := nullif(regexp_replace(coalesce(p_search, ''), '\D', '', 'g'), '');
begin
  perform public.voice_autocall_assert();
  return (
    with f as (
      select j.*, c.name as campaign_name, s.name as script_name
      from public.voice_autocall_jobs j
      left join public.voice_autocall_campaigns c on c.id = j.campaign_id
      join public.voice_autocall_scripts s on s.id = j.script_id
      where (p_category is null or j.category = p_category)
        and (p_campaign_id is null or j.campaign_id = p_campaign_id)
        and (p_status is null or j.status = p_status)
        and (p_outcome is null or j.outcome = p_outcome)
        and (p_from is null or (j.created_at at time zone 'Africa/Kampala')::date >= p_from)
        and (p_to is null or (j.created_at at time zone 'Africa/Kampala')::date <= p_to)
        and (p_search is null or j.person_name ilike '%' || p_search || '%'
             or (v_digits is not null and j.phone like '%' || v_digits || '%'))
    )
    select jsonb_build_object(
      'total', (select count(*) from f),
      'rows', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', f.id, 'category', f.category, 'campaign_id', f.campaign_id, 'campaign_name', f.campaign_name,
          'script_name', f.script_name, 'script_version', f.script_version,
          'person_id', f.person_id, 'person_name', f.person_name,
          'phone_masked', public.voice_autocall_mask_phone(f.phone),
          'status', f.status, 'outcome', f.outcome, 'attempts', f.attempts, 'max_attempts', f.max_attempts,
          'next_attempt_at', case when f.status = 'queued' then f.next_attempt_at end,
          'last_attempt_at', f.last_attempt_at, 'answered_at', f.answered_at, 'ended_at', f.ended_at,
          'duration_seconds', f.total_duration_seconds, 'cost', f.total_cost, 'currency', f.cost_currency,
          'hangup_cause', f.hangup_cause, 'failure_reason', f.failure_reason,
          'has_recording', f.recording_path is not null
                           or exists (select 1 from public.voice_autocall_responses r where r.job_id = f.id and r.recording_path is not null),
          'is_test', f.is_test, 'created_at', f.created_at
        ) order by coalesce(f.last_attempt_at, f.created_at) desc)
        from (select * from f order by coalesce(last_attempt_at, created_at) desc
              limit least(greatest(coalesce(p_limit, 50), 1), 200) offset greatest(coalesce(p_offset, 0), 0)) f
      ), '[]'::jsonb)
    )
  );
end;
$$;

create or replace function public.voice_autocall_call_detail(p_job_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  j public.voice_autocall_jobs;
begin
  perform public.voice_autocall_assert();
  select * into j from public.voice_autocall_jobs where id = p_job_id;
  if not found then raise exception 'call_not_found'; end if;
  return jsonb_build_object(
    'call', jsonb_build_object(
      'id', j.id, 'category', j.category, 'person_id', j.person_id, 'person_name', j.person_name,
      'phone_masked', public.voice_autocall_mask_phone(j.phone),
      'campaign_id', j.campaign_id,
      'campaign_name', (select name from public.voice_autocall_campaigns where id = j.campaign_id),
      'script_id', j.script_id, 'script_version', j.script_version, 'script_snapshot', j.script_snapshot,
      'variables', j.variables, 'status', j.status, 'outcome', j.outcome,
      'attempts', j.attempts, 'max_attempts', j.max_attempts, 'next_attempt_at', j.next_attempt_at,
      'expires_at', j.expires_at, 'answered_at', j.answered_at, 'ended_at', j.ended_at,
      'duration_seconds', j.total_duration_seconds, 'cost', j.total_cost, 'currency', j.cost_currency,
      'hangup_cause', j.hangup_cause, 'failure_reason', j.failure_reason,
      'recording_path', j.recording_path, 'is_test', j.is_test,
      'requested_by_name', (select full_name from public.profiles where id = j.requested_by),
      'created_at', j.created_at),
    'responses', coalesce((
      select jsonb_agg(jsonb_build_object(
        'attempt', r.attempt, 'step', r.step, 'digits', r.digits, 'outcome', r.outcome,
        'recording_path', r.recording_path, 'at', r.created_at) order by r.id)
      from public.voice_autocall_responses r where r.job_id = j.id), '[]'::jsonb),
    'events', coalesce((
      select jsonb_agg(jsonb_build_object(
        'attempt', e.attempt, 'kind', e.kind, 'step', e.step, 'payload', e.payload, 'at', e.created_at) order by e.id)
      from public.voice_autocall_events e where e.job_id = j.id), '[]'::jsonb)
  );
end;
$$;

do $$
declare sig text;
begin
  foreach sig in array array[
    'public.voice_autocall_overview()',
    'public.voice_autocall_set_category_paused(text, boolean, text)',
    'public.voice_autocall_pause_person(uuid, text, text, timestamptz, text)',
    'public.voice_autocall_lift_pause(uuid)',
    'public.voice_autocall_pauses_list(text, boolean, text)',
    'public.voice_autocall_scripts_list(text, boolean)',
    'public.voice_autocall_script_save(uuid, text, text, text, text, jsonb)',
    'public.voice_autocall_script_set_active(uuid, boolean)',
    'public.voice_autocall_script_versions(uuid)',
    'public.voice_autocall_campaigns_list(text)',
    'public.voice_autocall_campaign_save(uuid, text, text, text, uuid, text, text, timestamptz, time, time, smallint[], smallint, integer, boolean)',
    'public.voice_autocall_campaign_set_status(uuid, text, boolean)',
    'public.voice_autocall_add_people(uuid, uuid[])',
    'public.voice_autocall_test_call(uuid, uuid)',
    'public.voice_autocall_cancel_job(uuid)',
    'public.voice_autocall_calls_feed(text, uuid, text, text, date, date, text, integer, integer)',
    'public.voice_autocall_call_detail(uuid)'
  ] loop
    execute format('revoke all on function %s from public, anon', sig);
    execute format('grant execute on function %s to authenticated, service_role', sig);
  end loop;
end $$;
