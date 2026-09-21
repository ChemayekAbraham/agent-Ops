-- =====================================================================
-- PSO-FACIL-REGISTER-2026-09-21-M
-- Facilitation register for the COO and finance
-- =====================================================================

create or replace view public.v_pso_facilitation_position
with (security_invoker = true) as
select
  r.id                                   as requisition_id,
  r.requisition_code,
  s.staff_ref                            as officer_ref,
  coalesce(p.full_name, r.requester_name) as officer_name,
  r.amount,
  r.currency,
  r.title,
  case r.stage
    when 'coo'      then '1 Awaiting COO'
    when 'approved' then case when r.wallet_credit_status = 'credited'
                              then '3 Disbursed' else '2 Approved - awaiting disbursement' end
    when 'rejected' then 'X Declined'
    else r.stage
  end                                    as position,
  r.created_at                           as submitted_at,
  r.coo_decided_at,
  r.credited_at,
  case when r.credited_at is not null
       then (current_date - r.credited_at::date) end as days_since_disbursement,
  plan.line_count                        as plan_lines,
  plan.plan_total,
  (rep.id is not null)                   as report_filed,
  rep.submitted_at                       as report_submitted_at,
  rep.amount_received,
  rep.amount_used                        as amount_spent,
  case when rep.id is not null
       then coalesce(rep.amount_received,0) - coalesce(rep.amount_used,0) end as balance,
  rep.review_status                      as report_review_status,
  coalesce(notes.note_count, 0)          as promissory_notes_linked,
  coalesce(notes.note_value, 0)          as promissory_notes_value,
  coalesce(pr.snooze_count, 0)           as times_deferred,
  case
    when r.stage = 'coo' and coalesce(pr.snooze_count,0) >= 3
      then 'REPEATEDLY DEFERRED'
    when r.stage = 'coo'
      then 'AWAITING APPROVAL'
    when r.stage = 'approved' and r.wallet_credit_status is distinct from 'credited'
      then 'APPROVED NOT DISBURSED'
    when r.wallet_credit_status = 'credited' and rep.id is null
         and r.credited_at < now() - interval '7 days'
      then 'ACCOUNTABILITY OVERDUE'
    when r.wallet_credit_status = 'credited' and rep.id is null
      then 'ACCOUNTABILITY DUE'
    when rep.id is not null and coalesce(rep.amount_used,0) > coalesce(rep.amount_received,0)
      then 'SPENT EXCEEDS RECEIVED'
    when rep.id is not null
         and coalesce(rep.amount_received,0) - coalesce(rep.amount_used,0) > 0
      then 'UNSPENT BALANCE'
    else 'OK'
  end                                    as exception_flag
from public.staff_requisitions r
left join public.hr_staff s on s.user_id = r.requester_id
left join public.profiles p on p.id = r.requester_id
left join lateral (
  select count(*) as line_count, coalesce(sum(amount),0) as plan_total
    from public.staff_facilitation_plan_lines l
   where l.requisition_id = r.id
) plan on true
left join lateral (
  select u.id, u.submitted_at, u.amount_received, u.amount_used, u.review_status
    from public.staff_requisition_usage_reports u
   where u.requisition_id = r.id
   order by u.submitted_at desc nulls last
   limit 1
) rep on true
left join lateral (
  select count(*) as note_count, coalesce(sum(pn.amount),0) as note_value
    from public.staff_facilitation_notes fn
    join public.promissory_notes pn on pn.id = fn.promissory_note_id
   where fn.requisition_id = r.id
) notes on true
left join lateral (
  select max(snooze_count) as snooze_count
    from public.pso_facilitation_prompts q
   where q.requisition_id = r.id
) pr on true
where r.request_kind = 'facilitation';

comment on view public.v_pso_facilitation_position is
  'Facilitation register. One row per request. exception_flag names anything that needs attention: overdue accountability, unspent balance, approval repeatedly deferred, or money approved but never disbursed. security_invoker is on, so the caller''s own RLS on staff_requisitions applies.';

revoke all on public.v_pso_facilitation_position from public;
revoke all on public.v_pso_facilitation_position from anon;
grant select on public.v_pso_facilitation_position to authenticated;

do $$
declare v_anon boolean; v_pub boolean; v_inv boolean;
begin
  select has_table_privilege('anon','public.v_pso_facilitation_position','select') into v_anon;
  if v_anon then raise exception 'FAIL A: anon can read the facilitation register'; end if;

  select has_table_privilege('public','public.v_pso_facilitation_position','select') into v_pub;
  if v_pub then raise exception 'FAIL B: PUBLIC can read the facilitation register'; end if;

  select coalesce((select true from pg_class c
                    where c.oid='public.v_pso_facilitation_position'::regclass
                      and c.reloptions::text like '%security_invoker=true%'), false)
    into v_inv;
  if not v_inv then raise exception 'FAIL C: security_invoker not set on the register'; end if;

  perform 1 from public.v_pso_facilitation_position limit 1;

  if (select count(*) from public.staff_requisitions) <> 96 then
    raise exception 'FAIL D: requisition rows changed';
  end if;

  raise notice 'PSO-FACIL-REGISTER-2026-09-21-M PASSED — register live, % facilitation row(s) today',
    (select count(*) from public.v_pso_facilitation_position);
end $$;

-- =====================================================================
-- END PSO-FACIL-REGISTER-2026-09-21-M
-- =====================================================================