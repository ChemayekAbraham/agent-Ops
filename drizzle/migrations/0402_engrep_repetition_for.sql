create or replace function public.engrep_repetition_for(p_window_id uuid)
returns table(window_id uuid, unit_kind text, unit_key text, commits integer, engineers text[], repeat_kind text, repeat_refs text[], repeat_evidence text, safe_to_zero boolean)
language sql
stable
security definer
set search_path to 'public'
as $fn$
with p as (
  select w.id as window_id, w.period_end from public.engrep_windows w where w.id = p_window_id
),
bases as (
  select distinct split_part(co.object_name, '(', 1) as object_base
    from public.engrep_rows r join p on r.window_id = p.window_id
    cross join lateral unnest(r.claimed_objects) co(object_name)
),
fp_changed as (
  select s.object_base, s.captured_for,
         s.fingerprint is distinct from lag(s.fingerprint) over (partition by s.object_key order by s.captured_for) as changed_at
    from public.engrep_catalog_snapshot s
    join bases b on b.object_base = s.object_base
    cross join p
   where s.captured_for <= p.period_end
),
obj_facts as (
  select r.window_id, 'object'::text as unit_kind, co.object_name as unit_key, r.evidence_ref, r.engineer_code, r.commit_subject,
         coalesce(r.committed_at, r.harvested_at) as touched_at,
         coalesce(array_length(r.claimed_objects, 1), 0) > 25 as bulk_claim
    from public.engrep_rows r join p on r.window_id = p.window_id
    cross join lateral unnest(r.claimed_objects) co(object_name)
   where r.claimed_objects is not null and array_length(r.claimed_objects, 1) > 0
),
file_facts as (
  select t.window_id, 'file'::text as unit_kind, t.path as unit_key, t.evidence_ref, e.code as engineer_code, r.commit_subject,
         coalesce(t.touched_at, r.committed_at, r.harvested_at) as touched_at,
         coalesce(array_length(r.claimed_objects, 1), 0) > 25 as bulk_claim
    from public.engrep_file_touches t join p on t.window_id = p.window_id
    left join public.engrep_engineers e on e.id = t.engineer_id
    left join public.engrep_rows r on r.window_id = t.window_id and r.evidence_ref = t.evidence_ref
   where not public.engrep_is_generated_path(t.path)
),
file_blob as (
  select t.window_id, t.path as unit_key, count(*)::integer as touches, count(distinct t.blob_sha)::integer as distinct_blobs
    from public.engrep_file_touches t join p on t.window_id = p.window_id
   where not public.engrep_is_generated_path(t.path)
   group by t.window_id, t.path
),
facts as (select * from obj_facts union all select * from file_facts),
commits as (
  select f.window_id, f.unit_kind, f.unit_key, f.evidence_ref,
         min(f.engineer_code) as engineer_code, min(f.commit_subject) as commit_subject,
         min(f.touched_at) as touched_at, bool_or(f.bulk_claim) as bulk_claim
    from facts f group by f.window_id, f.unit_kind, f.unit_key, f.evidence_ref
),
agg as (
  select c.window_id, c.unit_kind, c.unit_key,
         count(*) filter (where not c.bulk_claim)::integer as commits,
         count(*) filter (where c.bulk_claim)::integer as bulk_commits,
         array(select distinct x.x from unnest(array_agg(c.engineer_code) filter (where not c.bulk_claim)) x(x) where x.x is not null order by x.x) as engineers,
         array_agg(c.evidence_ref order by c.touched_at, c.evidence_ref) as repeat_refs,
         bool_or(not c.bulk_claim and coalesce(c.commit_subject, '') ~* '^(revert|reverted to commit)') as has_undo
    from commits c group by c.window_id, c.unit_kind, c.unit_key
),
dupes as (
  select distinct a.window_id, a.unit_kind, a.unit_key
    from commits a
    join commits b on b.window_id = a.window_id and b.unit_kind = a.unit_kind and b.unit_key = a.unit_key and b.evidence_ref <> a.evidence_ref
   where a.unit_kind = 'object' and not a.bulk_claim and not b.bulk_claim
     and a.engineer_code is not null and a.engineer_code = b.engineer_code
     and coalesce(a.commit_subject, '') <> '' and a.commit_subject = b.commit_subject
     and a.touched_at is not null and b.touched_at is not null
     and a.touched_at < b.touched_at and (b.touched_at - a.touched_at) <= interval '24 hours'
),
undo_shas as (
  select c.window_id, c.unit_kind, c.unit_key,
         string_agg(distinct substring(c.commit_subject, '[0-9a-f]{7,40}'), ', ') as shas
    from commits c
   where not c.bulk_claim and coalesce(c.commit_subject, '') ~* '^(revert|reverted to commit)'
     and substring(c.commit_subject, '[0-9a-f]{7,40}') is not null
   group by c.window_id, c.unit_kind, c.unit_key
),
unit_changed_map as (
  select p.window_id, c.object_base, bool_or(coalesce(c.changed_at, false)) as changed
    from fp_changed c cross join p where c.captured_for = p.period_end
   group by p.window_id, c.object_base
),
delta_map as (
  select p.window_id, c.object_base, bool_or(coalesce(c.changed_at, false)) as in_delta
    from fp_changed c cross join p where c.captured_for <= p.period_end
   group by p.window_id, c.object_base
),
moved_map as (
  select p.window_id, m.object_base, bool_or(coalesce(m.moved_nearby, false)) as moved_nearby
    from public.engrep_catalog_movement m
    join bases b on b.object_base = m.object_base
    cross join p
   where m.captured_for = p.period_end
   group by p.window_id, m.object_base
),
sibling as (
  select c.window_id, c.unit_kind, c.unit_key, bool_or(coalesce(m.changed, false)) as sibling_changed
    from commits c
    join public.engrep_rows r on r.window_id = c.window_id and r.evidence_ref = c.evidence_ref
    cross join lateral unnest(r.claimed_objects) so(object_name)
    left join unit_changed_map m on m.window_id = c.window_id and m.object_base = split_part(so.object_name, '(', 1)
   where not c.bulk_claim and r.claimed_objects is not null and so.object_name <> c.unit_key
   group by c.window_id, c.unit_kind, c.unit_key
),
kinds as (
  select a.window_id, a.unit_kind, a.unit_key, a.commits, a.bulk_commits, a.engineers, a.repeat_refs, a.has_undo,
         coalesce(uc.changed, false) as unit_changed,
         d.unit_key is not null as is_dupe,
         s.shas as undo_sha_list,
         case when a.unit_kind <> 'object' then false else coalesce(dm.in_delta, false) end as in_catalog_delta,
         case when a.unit_kind <> 'object' then true else not coalesce(mm.moved_nearby, false) end as stable_around_window,
         coalesce(sb.sibling_changed, false) as sibling_changed,
         a.unit_kind = 'file' and coalesce(fb.touches, 0) >= 2 and coalesce(fb.distinct_blobs, 0) = 1 as file_no_op_evidence,
         wu.unit_state
    from agg a
    join public.engrep_work_units wu on wu.window_id = a.window_id and wu.unit_kind = a.unit_kind and wu.unit_key = a.unit_key
    left join unit_changed_map uc on a.unit_kind = 'object' and uc.window_id = a.window_id and uc.object_base = split_part(a.unit_key, '(', 1)
    left join delta_map dm on a.unit_kind = 'object' and dm.window_id = a.window_id and dm.object_base = split_part(a.unit_key, '(', 1)
    left join moved_map mm on a.unit_kind = 'object' and mm.window_id = a.window_id and mm.object_base = split_part(a.unit_key, '(', 1)
    left join dupes d on d.window_id = a.window_id and d.unit_kind = a.unit_kind and d.unit_key = a.unit_key
    left join undo_shas s on s.window_id = a.window_id and s.unit_kind = a.unit_kind and s.unit_key = a.unit_key
    left join sibling sb on sb.window_id = a.window_id and sb.unit_kind = a.unit_kind and sb.unit_key = a.unit_key
    left join file_blob fb on a.unit_kind = 'file' and fb.window_id = a.window_id and fb.unit_key = a.unit_key
   where a.commits > 1
),
classified as (
  select k.*,
         case
           when k.unit_state = 'never_landed' then 'never_landed'
           when k.has_undo then 'undo'
           when k.is_dupe and k.unit_kind <> 'file' then 'duplicate'
           when coalesce(array_length(k.engineers, 1), 0) > 1 then 're_entry_shared'
           when k.unit_kind = 'file' then case when k.file_no_op_evidence then 'no_op' else 're_entry_solo' end
           when k.unit_changed = false and k.in_catalog_delta = false and k.stable_around_window and k.sibling_changed = false then 'no_op'
           else 're_entry_solo'
         end as repeat_kind
    from kinds k
)
select c.window_id, c.unit_kind, c.unit_key, c.commits, c.engineers, c.repeat_kind,
       case when c.repeat_kind = 'undo' and c.undo_sha_list is not null then array[c.undo_sha_list] || c.repeat_refs else c.repeat_refs end,
       c.unit_kind || ' ' || c.unit_key || ': ' || c.commits::text || ' commits'
         || case when coalesce(array_length(c.engineers, 1), 0) > 0 then ' by ' || array_to_string(c.engineers, '/') else '' end
         || case when c.bulk_commits > 0 then ' (+' || c.bulk_commits::text || ' bulk-claim commit(s) with >25 claimed objects excluded from repeat counting)' else '' end,
       c.repeat_kind in ('no_op', 'duplicate')
  from classified c
$fn$;

revoke all on function public.engrep_repetition_for(uuid) from public, anon;
grant execute on function public.engrep_repetition_for(uuid) to authenticated, service_role, claude_investigator, sandbox_exec, sandbox_exec_wirntoujqoyjobfhyelc;

create or replace view public.engrep_repetition as
select f.window_id, f.unit_kind, f.unit_key, f.commits, f.engineers, f.repeat_kind, f.repeat_refs, f.repeat_evidence, f.safe_to_zero
  from public.engrep_windows w
  cross join lateral public.engrep_repetition_for(w.id) f
 where w.granularity = 'day';