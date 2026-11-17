-- Doc 274 (20261116103000): record every database change, and give the nightly CTO email a "Backend changes" digest.
--
-- WHY: the CTO cannot see what developers change. Commits are harvested by engrep-harvest-commits,
-- but that harvest has failed every day since 2026-10-10 (GitHub 401, dead token) and nothing said so.
-- Changes made straight in the SQL editor never reach git at all.
--
-- WHAT:
--   1. public.schema_change_log: one row per object created / altered / dropped / granted,
--      with the statement text, login role, application name and client address.
--      Filled by two event triggers. The trigger can never block a change: any failure is a WARNING.
--   2. public.get_backend_change_digest(since, until): commits per person (from engrep_rows),
--      database changes, database changes with no migration claiming them, and harvest health.
--      Read by daily-cto-report (service_role only).
--
-- LIMIT: the database sees a login role (usually postgres), not a person. Who did it comes from git.
-- LIMIT: cron.schedule() and edge-function deploys are not DDL and are not in this log.

create table if not exists public.schema_change_log (
  id              bigint generated always as identity primary key,
  at              timestamptz not null default now(),
  command_tag     text not null,
  object_type     text,
  schema_name     text,
  object_identity text,
  statement       text,
  db_role         text not null default session_user,
  app_name        text default current_setting('application_name', true),
  client_addr     inet default inet_client_addr()
);
create index if not exists schema_change_log_at_idx on public.schema_change_log (at desc);

alter table public.schema_change_log enable row level security;

drop policy if exists schema_change_log_cto_read on public.schema_change_log;
create policy schema_change_log_cto_read on public.schema_change_log
  for select to authenticated
  using ((select public.has_role((select auth.uid()), 'cto'::app_role))
      or (select public.has_role((select auth.uid()), 'super_admin'::app_role)));

drop policy if exists mfa_required_for_staff on public.schema_change_log;
create policy mfa_required_for_staff on public.schema_change_log as restrictive for all to authenticated
  using ((select public.staff_mfa_ok())) with check ((select public.staff_mfa_ok()));

revoke all on public.schema_change_log from anon, authenticated;
grant select on public.schema_change_log to authenticated;
grant select, insert, update, delete on public.schema_change_log to service_role;

-- ddl_command_end: creates, alters, grants, comments.
create or replace function public.schema_change_log_capture()
returns event_trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  r record;
  q text := left(current_query(), 8000);
begin
  for r in select * from pg_event_trigger_ddl_commands() loop
    if r.schema_name like 'pg_temp%' or r.schema_name like 'pg_toast%'
       or r.object_identity like 'public.schema_change_log%' then
      continue;
    end if;
    insert into public.schema_change_log (command_tag, object_type, schema_name, object_identity, statement)
    values (r.command_tag, r.object_type, r.schema_name, r.object_identity, q);
  end loop;
exception when others then
  raise warning 'schema_change_log_capture skipped: %', sqlerrm;  -- never block the change itself
end;
$$;

-- sql_drop: drops.
create or replace function public.schema_change_log_capture_drop()
returns event_trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  r record;
  q text := left(current_query(), 8000);
begin
  for r in select * from pg_event_trigger_dropped_objects() where original loop
    if r.schema_name like 'pg_temp%' or r.schema_name like 'pg_toast%' or r.is_temporary then
      continue;
    end if;
    insert into public.schema_change_log (command_tag, object_type, schema_name, object_identity, statement)
    values (tg_tag, r.object_type, r.schema_name, r.object_identity, q);
  end loop;
exception when others then
  raise warning 'schema_change_log_capture_drop skipped: %', sqlerrm;
end;
$$;

revoke all on function public.schema_change_log_capture() from public, anon, authenticated;
revoke all on function public.schema_change_log_capture_drop() from public, anon, authenticated;

drop event trigger if exists zz_schema_change_log;
create event trigger zz_schema_change_log on ddl_command_end
  execute function public.schema_change_log_capture();

drop event trigger if exists zz_schema_change_log_drop;
create event trigger zz_schema_change_log_drop on sql_drop
  execute function public.schema_change_log_capture_drop();

-- Digest for the nightly CTO email.
create or replace function public.get_backend_change_digest(
  p_since timestamptz default now() - interval '24 hours',
  p_until timestamptz default now()
)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
with
harvest as (
  select
    (select max(started_at) from engrep_harvest_runs where zone = 'external_commit') as last_run_at,
    (select max(started_at) from engrep_harvest_runs where zone = 'external_commit' and outcome = 'ok') as last_ok_at,
    (select outcome from engrep_harvest_runs where zone = 'external_commit' order by started_at desc limit 1) as last_outcome,
    (select left(error, 200) from engrep_harvest_runs where zone = 'external_commit' order by started_at desc limit 1) as last_error
),
commits as (
  select
    coalesce(
      r.engineer_code || coalesce(' · ' || regexp_replace(split_part(e.git_emails[1], '@', 1), '^\d+\+', ''), ''),
      nullif(nullif(r.attribution, ''), 'none'), r.author_email,
      case when r.source = 'lovable_edit' then 'Lovable (no co-author)' end, 'unknown') as who,
    r.commit_subject,
    r.paths,
    r.committed_at
  from engrep_rows r
  left join engrep_engineers e on e.code = r.engineer_code
  where r.committed_at >= p_since and r.committed_at < p_until
),
per_person as (
  select
    who,
    count(*) as commits,
    count(*) filter (where exists (select 1 from unnest(paths) p
                                   where p like 'supabase/%' or p like 'src/lib/%' or p like 'src/hooks/%')) as backend_commits,
    count(*) filter (where exists (select 1 from unnest(paths) p where p like 'supabase/migrations/%')) as migration_commits,
    count(*) filter (where exists (select 1 from unnest(paths) p where p like 'supabase/functions/%')) as edge_function_commits,
    (array_agg(commit_subject order by committed_at desc))[1:5] as latest_subjects
  from commits
  group by who
),
changes as (
  select *,
         regexp_replace(split_part(coalesce(object_identity, ''), '(', 1), '^.*\.', '') as short_name
  from schema_change_log
  where at >= p_since and at < p_until
),
claimed as (
  select distinct lower(o) as o
  from engrep_rows r, unnest(r.claimed_objects) o
  where r.committed_at >= p_since - interval '3 days' and r.committed_at < p_until + interval '1 day'
)
select jsonb_build_object(
  'since', p_since,
  'until', p_until,
  'harvest', (select to_jsonb(h) || jsonb_build_object(
                 'broken', h.last_outcome is distinct from 'ok',
                 'days_since_ok', extract(day from now() - h.last_ok_at)::int) from harvest h),
  'commits_total', (select count(*) from commits),
  'per_person', coalesce((select jsonb_agg(to_jsonb(p) order by p.backend_commits desc, p.commits desc) from per_person p), '[]'::jsonb),
  'db_changes_total', (select count(*) from changes),
  'db_changes_by_schema', coalesce((select jsonb_object_agg(coalesce(schema_name, '-'), n)
                                    from (select schema_name, count(*) n from changes group by 1) s), '{}'::jsonb),
  'db_changes', coalesce((select jsonb_agg(jsonb_build_object(
                    'at', at, 'command', command_tag, 'type', object_type, 'object', object_identity,
                    'role', db_role, 'app', app_name) order by at desc)
                  from (select * from changes where schema_name = 'public' or schema_name is null
                        order by at desc limit 80) c), '[]'::jsonb),
  'db_changes_without_migration', coalesce((select jsonb_agg(jsonb_build_object(
                    'at', at, 'command', command_tag, 'object', object_identity, 'role', db_role, 'app', app_name)
                    order by at desc)
                  from (select * from changes c
                        where (c.schema_name = 'public' or c.schema_name is null)
                          and c.short_name <> ''
                          and not exists (select 1 from claimed where claimed.o = lower(c.short_name))
                        order by at desc limit 80) u), '[]'::jsonb)
);
$$;

revoke all on function public.get_backend_change_digest(timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.get_backend_change_digest(timestamptz, timestamptz) to service_role;
