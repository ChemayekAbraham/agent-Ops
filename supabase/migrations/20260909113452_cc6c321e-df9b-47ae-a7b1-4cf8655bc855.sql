CREATE OR REPLACE FUNCTION public.pso_funded_summary(p_from date, p_to date, p_staff_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(staff_id uuid, staff_ref text, notes_in_cohort integer, notes_funded integer, amount_funded numeric, commission_accrued numeric, as_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_self uuid := public.hr_my_staff_id();
  v_reviewer boolean := public.hr_is_admin()
    or public.hr_is_executive()
    or exists (
      select 1
      from public.user_roles ur
      where ur.user_id = auth.uid()
        and ur.enabled = true
        and ur.role = any (array['coo'::app_role, 'ceo'::app_role, 'super_admin'::app_role])
    );
begin
  if p_from is null or p_to is null or p_to < p_from then
    raise exception 'pso_funded_summary: invalid window';
  end if;
  if (p_to - p_from) > 366 then
    raise exception 'pso_funded_summary: window exceeds 366 days';
  end if;
  if not v_reviewer then
    if v_self is null then
      raise exception 'pso_funded_summary: not permitted';
    end if;
    if p_staff_id is not null and p_staff_id <> v_self then
      raise exception 'pso_funded_summary: not permitted';
    end if;
    p_staff_id := v_self;
  end if;

  return query
  with cohort as (
    select e.staff_id, e.staff_ref, e.note_id
    from public.v_pso_note_events e
    where e.note_day between p_from and p_to
      and e.reversed_at is null
      and (p_staff_id is null or e.staff_id = p_staff_id)
  ),
  officers as (
    select o.staff_id, o.staff_ref
    from public.v_pso_officers o
    where p_staff_id is null or o.staff_id = p_staff_id
  ),
  -- money committed through a plan booking that reached funding
  plan_funded as (
    select c.staff_id, c.note_id, sum(b.booked_amount)::numeric as amt
    from cohort c
    join public.v_cfo_promissory_bookings b
      on b.note_id = c.note_id and b.funded_at is not null
    group by c.staff_id, c.note_id
  ),
  -- real money a registered partner funded into a portfolio after the note
  portfolio_funded as (
    select distinct on (ip.id) c.staff_id, c.note_id, ip.investment_amount::numeric as amt
    from cohort c
    join public.promissory_notes n
      on n.id = c.note_id and n.partner_user_id is not null
    join public.investor_portfolios ip
      on ip.investor_id = n.partner_user_id
     and ip.created_at >= n.created_at
    where ip.status in ('active', 'locked')
    order by ip.id, n.created_at
  ),
  all_funded as (
    select staff_id, note_id, amt from plan_funded
    union all
    select staff_id, note_id, amt from portfolio_funded
  ),
  funded as (
    select a.staff_id,
           count(distinct a.note_id)::int as funded_n,
           coalesce(sum(a.amt), 0)::numeric as funded_amt
    from all_funded a
    group by a.staff_id
  ),
  -- commission attributed to the officer who earned it, in the window it was
  -- paid (Kampala calendar), independent of when the underlying note was created
  commissions as (
    select o.staff_id,
           coalesce(sum(ce.amount), 0)::numeric as commission_amt
    from public.promissory_commission_events ce
    join public.v_pso_officers o on o.user_id = ce.agent_id
    where ce.status = 'paid'
      and (ce.created_at at time zone 'Africa/Kampala')::date between p_from and p_to
      and (p_staff_id is null or o.staff_id = p_staff_id)
    group by o.staff_id
  ),
  sized as (
    select c.staff_id, count(*)::int as cohort_n
    from cohort c
    group by c.staff_id
  )
  select o.staff_id,
         o.staff_ref,
         coalesce(s.cohort_n, 0)::int,
         coalesce(f.funded_n, 0)::int,
         coalesce(f.funded_amt, 0)::numeric,
         coalesce(m.commission_amt, 0)::numeric,
         now()
  from officers o
  left join sized s on s.staff_id = o.staff_id
  left join funded f on f.staff_id = o.staff_id
  left join commissions m on m.staff_id = o.staff_id
  order by o.staff_ref;
end;
$function$;

comment on function public.pso_funded_summary(date, date, uuid) is
  'Funded sales for a Platform Sales Officer creation cohort, measured as-at now and never frozen. Funded means the booking carries funded_at or a real partner portfolio funded after the note. Commission is promissory_commission_events rows with status paid, attributed to the earning officer and to the Kampala window in which they were paid, not to the note creation cohort.';

revoke all on function public.pso_funded_summary(date, date, uuid) from public, anon;
grant execute on function public.pso_funded_summary(date, date, uuid) to authenticated;