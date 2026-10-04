CREATE OR REPLACE FUNCTION public.get_unmatched_postings_breakdown(p_as_at timestamp with time zone DEFAULT now())
 RETURNS TABLE(group_label text, legs bigint, amount numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '120s'
AS $function$
begin
  if auth.uid() is null
     or not (
       has_role(auth.uid(),'cfo') or has_role(auth.uid(),'ceo') or has_role(auth.uid(),'coo')
       or has_role(auth.uid(),'manager') or has_role(auth.uid(),'financial_ops')
       or has_role(auth.uid(),'super_admin') or has_role(auth.uid(),'cto')
     ) then
    raise exception 'Not authorised to view the statement of financial position';
  end if;

  return query
  with legs as (
    select l.category,
           count(*) as legs,
           round(sum(l.dr - l.cr)) as amount
    from sofp_ledger_legs(p_as_at) l
    where l.group_one_sided
      and l.account_code <> 'E4'
    group by l.category
  ), labelled as (
    select case when abs(amount) >= 50000
                then initcap(replace(category, '_', ' '))
                else 'Other small postings'
           end as group_label,
           legs, amount
    from legs
  )
  select group_label, sum(legs)::bigint as legs, sum(amount) as amount
  from labelled
  group by group_label
  order by abs(sum(amount)) desc;
end;
$function$;