CREATE OR REPLACE FUNCTION public.hr_pay_advance_due(_staff_id uuid, _gross numeric, _run_id uuid)
 RETURNS numeric
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select coalesce(sum(least(
           case when a.recovery_mode = 'fixed' then a.recovery_value
                else round(_gross * a.recovery_value / 100) end,
           a.principal - coalesce((select sum(r.amount)
                                   from public.hr_pay_advance_recoveries r
                                   join public.hr_pay_runs pr on pr.id = r.run_id
                                   where r.advance_id = a.id
                                     and r.run_id <> _run_id
                                     and pr.status in ('approved','paid')), 0)
         )), 0)
  from public.hr_pay_advances a
  where a.staff_id = _staff_id and a.status = 'approved'
    and a.first_recovery_on <= current_date
    and a.principal > coalesce((select sum(r.amount)
                                from public.hr_pay_advance_recoveries r
                                join public.hr_pay_runs pr on pr.id = r.run_id
                                where r.advance_id = a.id
                                  and r.run_id <> _run_id
                                  and pr.status in ('approved','paid')), 0);
$function$;