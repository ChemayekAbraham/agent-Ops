-- ECHO: ENGREP-PERF-20260917-K
-- Performance only. No column change, no logic change to the cross-boundary
-- `changed` comparison from ENGREP-WORKUNITS-FIX-20260917-F.
-- No band, no score, no points, no payout anywhere in this file.

alter table public.engrep_catalog_snapshot
  add column if not exists object_base text
  generated always as (split_part(object_key, '(', 1)) stored;

create index if not exists engrep_cat_base_day
  on public.engrep_catalog_snapshot (object_base, captured_for desc);

create index if not exists engrep_cat_key_day
  on public.engrep_catalog_snapshot (object_key, captured_for desc);

drop index if exists public.engrep_catalog_snapshot_day_idx;

create or replace view public.engrep_work_units as
with obj as (
  select r.window_id,
         co.object_name as unit_key,
         r.evidence_ref,
         r.engineer_code,
         r.source,
         coalesce(r.committed_at, r.harvested_at) as touched_at
    from engrep_rows r
    cross join lateral unnest(r.claimed_objects) co(object_name)
   where r.claimed_objects is not null
     and array_length(r.claimed_objects, 1) > 0
), obj_agg as (
  select obj.window_id,
         obj.unit_key,
         count(distinct obj.evidence_ref)::integer as commits,
         array( select distinct x.x
                  from unnest(array_agg(obj.engineer_code)) x(x)
                 where x.x is not null
                 order by x.x ) as engineers,
         min(obj.touched_at) as first_touch,
         max(obj.touched_at) as last_touch,
         array( select distinct x.x
                  from unnest(array_agg(obj.source)) x(x)
                 where x.x is not null
                 order by x.x ) as sources
    from obj
   group by obj.window_id, obj.unit_key
), obj_final as (
  select oa.window_id,
         'object'::text as unit_kind,
         oa.unit_key,
         oa.commits,
         oa.engineers,
         case
           when oa.engineers = '{}'::text[] then array['none'::text]
           when array_length(oa.engineers, 1) > 1 then array['shared'::text]
           else array['named'::text]
         end as owner_classes,
         oa.first_touch,
         oa.last_touch,
         coalesce(( select s_now.fingerprint is distinct from s_prev.fingerprint
                      from engrep_windows w
                      join engrep_catalog_snapshot s_now
                        on s_now.captured_for = w.period_end
                       and s_now.object_base = split_part(oa.unit_key, '(', 1)
                      left join lateral ( select sp.fingerprint
                                            from engrep_catalog_snapshot sp
                                           where sp.object_key = s_now.object_key
                                             and sp.captured_for < w.period_end
                                           order by sp.captured_for desc
                                           limit 1 ) s_prev on true
                     where w.id = oa.window_id
                     limit 1 ), false) as changed,
         (exists ( select 1
                     from engrep_catalog_snapshot s2
                     join engrep_windows w2 on w2.id = oa.window_id
                    where s2.object_base = split_part(oa.unit_key, '(', 1)
                      and s2.captured_for = w2.period_end )) as verified_live,
         oa.sources
    from obj_agg oa
), fil_agg as (
  select t.window_id,
         'file'::text as unit_kind,
         t.path as unit_key,
         count(distinct t.evidence_ref)::integer as commits,
         array( select distinct x.x
                  from unnest(array_agg(e.code)) x(x)
                 where x.x is not null
                 order by x.x ) as engineers,
         min(t.touched_at) as first_touch,
         max(t.touched_at) as last_touch,
         count(distinct t.blob_sha) > 1 as changed,
         array( select distinct x.x
                  from unnest(array_agg(t.source)) x(x)
                 where x.x is not null
                 order by x.x ) as sources
    from engrep_file_touches t
    left join engrep_engineers e on e.id = t.engineer_id
   group by t.window_id, t.path
)
select obj_final.window_id,
       obj_final.unit_kind,
       obj_final.unit_key,
       obj_final.commits,
       obj_final.engineers,
       obj_final.owner_classes,
       obj_final.first_touch,
       obj_final.last_touch,
       obj_final.changed,
       obj_final.verified_live,
       obj_final.sources
  from obj_final
union all
select fil_agg.window_id,
       fil_agg.unit_kind,
       fil_agg.unit_key,
       fil_agg.commits,
       fil_agg.engineers,
       case
         when fil_agg.engineers = '{}'::text[] then array['none'::text]
         when array_length(fil_agg.engineers, 1) > 1 then array['shared'::text]
         else array['named'::text]
       end as owner_classes,
       fil_agg.first_touch,
       fil_agg.last_touch,
       fil_agg.changed,
       null::boolean as verified_live,
       fil_agg.sources
  from fil_agg;