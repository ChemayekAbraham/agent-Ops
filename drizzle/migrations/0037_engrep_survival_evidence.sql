-- ENGREP T3 · SURVIVAL
-- Records, separately from the harvested row, whether a change held after maturity.
-- Survival is evidence for the adjudicator only: it changes no band, no zero, no point.
-- Nothing here adds a column to engrep_rows and nothing here UPDATEs engrep_rows.

create table if not exists public.engrep_survival (
  row_id              uuid primary key references public.engrep_rows(id),
  evaluated_at        timestamptz not null default now(),
  matured_on          date not null,
  reverted_by_row     uuid references public.engrep_rows(id),
  reverted_by_self    boolean not null default false,
  retouch_same_file   integer not null default 0,
  retouch_by_other    integer not null default 0,
  object_reclaimed    integer not null default 0,
  verdict             text not null,
  constraint engrep_survival_verdict
    check (verdict in ('held','retouched','reverted','too_early'))
);

comment on table public.engrep_survival is
  'Survival evidence per harvested ENGREP row, held apart from engrep_rows because a harvested row may already be locked (locked rows are read-only; corrections are dated addenda only). Evidence for the adjudicator; never an automatic score input.';

create index if not exists engrep_survival_verdict_idx on public.engrep_survival (verdict);

alter table public.engrep_survival enable row level security;

drop policy if exists "engrep survival readable by adjudicator cto ceo" on public.engrep_survival;
create policy "engrep survival readable by adjudicator cto ceo"
  on public.engrep_survival
  for select
  using (
    public.engrep_is_adjudicator()
    or public.has_role(auth.uid(), 'cto')
    or public.has_role(auth.uid(), 'ceo')
  );
-- No insert / update / delete policy: only engrep_svc_evaluate_survival writes.

revoke all on table public.engrep_survival from public, anon;
grant select on table public.engrep_survival to authenticated;
grant all on table public.engrep_survival to service_role;

create or replace function public.engrep_svc_evaluate_survival(p_maturity_days integer default 7)
returns integer
language plpgsql
security definer
set search_path to 'public','pg_temp'
as $$
declare
  r record;
  v_revert_row      uuid;
  v_revert_self     boolean;
  v_retouch_same    integer;
  v_retouch_other   integer;
  v_reclaimed       integer;
  v_verdict         text;
  v_count           integer := 0;
begin
  for r in
    select ro.*
    from public.engrep_rows ro
    where ro.engineer_id is not null
      and ro.committed_at is not null
      and ro.committed_at + make_interval(days => p_maturity_days) < now()
      and not exists (select 1 from public.engrep_survival s where s.row_id = ro.id)
  loop
    -- (a) REVERTED. Lovable tree rollbacks ('reverted to commit ...') are excluded absolutely:
    -- one of them rolled back 108 files at once and is no judgement on anyone's work.
    select v.id, (v.engineer_id = r.engineer_id)
      into v_revert_row, v_revert_self
    from public.engrep_rows v
    where v.id <> r.id
      and v.committed_at is not null
      and v.committed_at > r.committed_at
      and coalesce(v.commit_subject, '') !~* '^reverted to commit'
      and (
        (
          coalesce(r.commit_subject, '') <> ''
          and v.commit_subject ilike 'revert "' || split_part(r.commit_subject, E'\n', 1) || '%'
        )
        or (
          coalesce(r.evidence_ref, '') <> ''
          and position(r.evidence_ref in coalesce(v.commit_subject, '')) > 0
        )
      )
    order by v.committed_at asc
    limit 1;

    -- (b) RETOUCHED. Volume context only; a file under active development is touched constantly.
    select count(*)::int,
           count(*) filter (where v.engineer_id is distinct from r.engineer_id)::int
      into v_retouch_same, v_retouch_other
    from public.engrep_rows v
    where v.id <> r.id
      and v.committed_at is not null
      and v.committed_at > r.committed_at
      and v.committed_at <= r.committed_at + make_interval(days => p_maturity_days)
      and coalesce(v.commit_subject, '') !~* '^reverted to commit'
      and coalesce(r.paths, '{}') <> '{}'
      and v.paths && r.paths;

    -- (c) OBJECT RECLAIMED. The same claim being attempted again.
    if r.live_verified in ('no','part') and coalesce(r.claimed_objects, '{}') <> '{}' then
      select count(*)::int
        into v_reclaimed
      from public.engrep_rows v
      where v.id <> r.id
        and v.committed_at is not null
        and v.committed_at > r.committed_at
        and coalesce(v.commit_subject, '') !~* '^reverted to commit'
        and v.claimed_objects && r.claimed_objects;
    else
      v_reclaimed := 0;
    end if;

    -- (d) verdict, first match wins. 'too_early' is never written: an immature row gets no row here.
    if v_revert_row is not null then
      v_verdict := 'reverted';
    elsif coalesce(v_retouch_other, 0) > 0 or coalesce(v_reclaimed, 0) > 0 then
      v_verdict := 'retouched';
    else
      v_verdict := 'held';
    end if;

    insert into public.engrep_survival (
      row_id, matured_on, reverted_by_row, reverted_by_self,
      retouch_same_file, retouch_by_other, object_reclaimed, verdict
    ) values (
      r.id,
      (r.committed_at + make_interval(days => p_maturity_days))::date,
      v_revert_row,
      coalesce(v_revert_self, false),
      coalesce(v_retouch_same, 0),
      coalesce(v_retouch_other, 0),
      coalesce(v_reclaimed, 0),
      v_verdict
    )
    on conflict (row_id) do nothing;

    v_count := v_count + 1;
    v_revert_row := null;
    v_revert_self := null;
  end loop;

  return v_count;
end;
$$;

revoke all on function public.engrep_svc_evaluate_survival(integer) from public, anon, authenticated;
grant execute on function public.engrep_svc_evaluate_survival(integer) to service_role;

create or replace view public.engrep_survival_summary
with (security_invoker = true) as
select
  ro.window_id,
  ro.engineer_id,
  ro.engineer_code,
  count(*)::int                                                     as rows_matured,
  count(*) filter (where s.verdict = 'held')::int                   as held,
  count(*) filter (where s.verdict = 'retouched')::int              as retouched,
  count(*) filter (where s.verdict = 'reverted')::int               as reverted,
  round(
    (count(*) filter (where s.verdict = 'held'))::numeric
      / nullif(count(*), 0) * 100, 1
  )                                                                 as held_share_pct
from public.engrep_survival s
join public.engrep_rows ro on ro.id = s.row_id
group by ro.window_id, ro.engineer_id, ro.engineer_code;

comment on view public.engrep_survival_summary is
  'Per engineer per window: matured rows, held / retouched / reverted counts and held share. Reporting only.';

revoke all on public.engrep_survival_summary from public, anon;
grant select on public.engrep_survival_summary to authenticated, service_role;

-- Cron: 17:12 EAT, after the 17:08 lineage job. Existing jobs are untouched.
select cron.unschedule('engrep-evaluate-survival')
where exists (select 1 from cron.job where jobname = 'engrep-evaluate-survival');

select cron.schedule(
  'engrep-evaluate-survival',
  '12 14 * * *',
  $cron$select public.engrep_svc_evaluate_survival(7);$cron$
);