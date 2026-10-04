BEGIN;

CREATE OR REPLACE FUNCTION public.hr_pay_exceptions(_run_id uuid)
RETURNS TABLE(severity text, staff_ref text, issue text, detail text)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  select 'BLOCK', s.staff_ref::text, 'Negative net pay',
         'Net is ' || ps.net::text
  from public.hr_pay_payslips ps join public.hr_staff s on s.id = ps.staff_id
  where ps.run_id = _run_id and ps.is_current and ps.net < 0
  union all
  select 'REVIEW', s.staff_ref::text, 'Zero net pay',
         'Staff member is on the run but is not payable for this period. Confirm the reason before approval.'
  from public.hr_pay_payslips ps join public.hr_staff s on s.id = ps.staff_id
  where ps.run_id = _run_id and ps.is_current and ps.net = 0
  union all
  select 'BLOCK', s.staff_ref::text, 'No linked user account',
         'Cannot be paid — no wallet can be resolved'
  from public.hr_pay_payslips ps join public.hr_staff s on s.id = ps.staff_id
  where ps.run_id = _run_id and ps.is_current and s.user_id is null
  union all
  select 'REVIEW', s.staff_ref::text, 'No live assignment',
         'Nobody owns this staff member in the org chart'
  from public.hr_pay_payslips ps join public.hr_staff s on s.id = ps.staff_id
  where ps.run_id = _run_id and ps.is_current
    and not exists (select 1 from public.hr_assignments a
                    where a.staff_id = s.id and a.started_on <= current_date
                      and (a.ended_on is null or a.ended_on >= current_date))
  union all
  select 'REVIEW', s.staff_ref::text, 'Pay outside grade band',
         'Gross ' || ps.gross::text || ' against band ' || g.code
  from public.hr_pay_payslips ps
  join public.hr_staff s on s.id = ps.staff_id
  join public.hr_pay_compensation c on c.staff_id = s.id and c.grade_id is not null
  join public.hr_pay_grades g on g.id = c.grade_id
  where ps.run_id = _run_id and ps.is_current
    and (ps.gross < g.band_min or ps.gross > g.band_max)
  union all
  select 'REVIEW', s.staff_ref::text, 'Missing statutory identifier',
         trim(case when si.tin is null then 'TIN ' else '' end ||
              case when si.nssf_number is null then 'NSSF ' else '' end ||
              case when si.lst_district is null then 'LST district' else '' end)
  from public.hr_pay_payslips ps
  join public.hr_staff s on s.id = ps.staff_id
  left join public.hr_pay_statutory_ids si on si.staff_id = s.id
  where ps.run_id = _run_id and ps.is_current
    and (si.id is null or si.tin is null or si.nssf_number is null or si.lst_district is null)
  union all
  select 'REVIEW', s.staff_ref::text, 'Duplicate wallet account',
         'Another staff member shares this user account'
  from public.hr_pay_payslips ps join public.hr_staff s on s.id = ps.staff_id
  where ps.run_id = _run_id and ps.is_current and s.user_id is not null
    and (select count(*) from public.hr_staff h where h.user_id = s.user_id and h.active) > 1
  union all
  select 'INFO', s.staff_ref::text, 'Statutory item switched off',
         'PAYE ' || sp.paye_applicable::text || ' · NSSF ' || sp.nssf_applicable::text ||
         ' · LST ' || sp.lst_applicable::text || ' — basis: ' || coalesce(sp.exemption_basis,'none')
  from public.hr_pay_payslips ps
  join public.hr_staff s on s.id = ps.staff_id
  join public.hr_pay_statutory_profiles sp on sp.staff_id = s.id and sp.effective_to is null
  where ps.run_id = _run_id and ps.is_current
    and not (sp.paye_applicable and sp.nssf_applicable and sp.lst_applicable)
  order by 1, 2;
$function$;

COMMIT;