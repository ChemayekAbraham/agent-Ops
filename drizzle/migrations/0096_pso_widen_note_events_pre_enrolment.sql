CREATE OR REPLACE VIEW public.v_pso_note_events AS
SELECT n.id AS note_id,
    n.agent_id AS officer_user_id,
    o.staff_id,
    o.staff_ref,
    o.officer_since,
    (n.created_at AT TIME ZONE 'Africa/Kampala'::text)::date AS note_day,
    n.created_at,
    n.amount,
    n.status AS note_status,
    n.partner_user_id IS NOT NULL AS partner_registered,
    r.reversed_at,
    r.kind AS reversal_kind,
    n.recorded_on AS recorded_day,
    ((n.created_at AT TIME ZONE 'Africa/Kampala'::text)::date < o.officer_since) AS pre_enrolment
   FROM public.promissory_notes n
     JOIN public.v_pso_officers o ON o.user_id = n.agent_id
     LEFT JOIN public.pso_note_reversals r ON r.note_id = n.id;

ALTER VIEW public.v_pso_note_events SET (security_invoker = on);
REVOKE ALL ON public.v_pso_note_events FROM anon;
GRANT SELECT ON public.v_pso_note_events TO authenticated;

CREATE OR REPLACE FUNCTION public.pso_cohort_volume(p_from date, p_to date)
 RETURNS TABLE(staff_ref text, mon integer, tue integer, wed integer, thu integer, fri integer, sat integer, sun integer, total_net integer, is_me boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_self uuid := public.hr_my_staff_id();
  v_is_officer boolean;
  v_reviewer boolean;
begin
  v_is_officer := v_self is not null and exists (
    select 1 from public.v_pso_officers o where o.staff_id = v_self
  );
  v_reviewer := public.hr_is_admin()
    or public.hr_is_executive()
    or exists (
      select 1
      from public.user_roles ur
      where ur.user_id = auth.uid()
        and ur.enabled = true
        and ur.role = any (array['coo'::app_role, 'ceo'::app_role, 'super_admin'::app_role])
    );

  if not (v_is_officer or v_reviewer) then
    raise exception 'pso_cohort_volume: not permitted';
  end if;

  if p_from is null or p_to is null or p_to < p_from then
    raise exception 'pso_cohort_volume: invalid window';
  end if;
  if (p_to - p_from) > 366 then
    raise exception 'pso_cohort_volume: window exceeds 366 days';
  end if;

  return query
  with cohort as (
    select o.staff_id, o.staff_ref
    from public.v_pso_officers o
  ),
  ev as (
    select v.staff_id as ev_staff_id,
           v.note_day as ev_day,
           (count(*) - count(*) filter (where v.reversed_at is not null))::int as net_n
    from public.v_pso_note_events v
    where v.note_day between p_from and p_to
      and v.pre_enrolment = false
    group by v.staff_id, v.note_day
  )
  select c.staff_ref,
         coalesce(sum(e.net_n) filter (where extract(isodow from e.ev_day) = 1), 0)::int,
         coalesce(sum(e.net_n) filter (where extract(isodow from e.ev_day) = 2), 0)::int,
         coalesce(sum(e.net_n) filter (where extract(isodow from e.ev_day) = 3), 0)::int,
         coalesce(sum(e.net_n) filter (where extract(isodow from e.ev_day) = 4), 0)::int,
         coalesce(sum(e.net_n) filter (where extract(isodow from e.ev_day) = 5), 0)::int,
         coalesce(sum(e.net_n) filter (where extract(isodow from e.ev_day) = 6), 0)::int,
         coalesce(sum(e.net_n) filter (where extract(isodow from e.ev_day) = 7), 0)::int,
         coalesce(sum(e.net_n), 0)::int as total_net,
         bool_or(c.staff_id is not distinct from v_self)
  from cohort c
  left join ev e on e.ev_staff_id = c.staff_id
  group by c.staff_ref
  order by coalesce(sum(e.net_n), 0) desc, c.staff_ref;
end;
$function$;

CREATE OR REPLACE FUNCTION public.pso_daily_series(p_from date, p_to date, p_staff_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(staff_id uuid, staff_ref text, day date, notes_created integer, notes_reversed integer, net_notes integer, partner_registered integer)
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
    raise exception 'pso_daily_series: invalid window';
  end if;
  if (p_to - p_from) > 366 then
    raise exception 'pso_daily_series: window exceeds 366 days';
  end if;
  if not v_reviewer then
    if v_self is null then
      raise exception 'pso_daily_series: not permitted';
    end if;
    if p_staff_id is not null and p_staff_id <> v_self then
      raise exception 'pso_daily_series: not permitted';
    end if;
    p_staff_id := v_self;
  end if;

  return query
  with cohort as (
    select o.staff_id, o.staff_ref, o.officer_since
    from public.v_pso_officers o
    where p_staff_id is null or o.staff_id = p_staff_id
  ),
  spine as (
    select c.staff_id, c.staff_ref, d::date as day
    from cohort c
    cross join lateral generate_series(
      greatest(p_from, c.officer_since)::timestamp,
      least(p_to, (now() at time zone 'Africa/Kampala')::date)::timestamp,
      interval '1 day'
    ) as d
  ),
  ev as (
    select v.staff_id as ev_staff_id,
           v.note_day as ev_day,
           count(*)::int as created_n,
           count(*) filter (where v.reversed_at is not null)::int as rev_n,
           count(*) filter (where v.partner_registered)::int as reg_n
    from public.v_pso_note_events v
    where v.pre_enrolment = false
    group by v.staff_id, v.note_day
  )
  select sp.staff_id,
         sp.staff_ref,
         sp.day,
         coalesce(e.created_n, 0)::int,
         coalesce(e.rev_n, 0)::int,
         (coalesce(e.created_n, 0) - coalesce(e.rev_n, 0))::int,
         coalesce(e.reg_n, 0)::int
  from spine sp
  left join ev e on e.ev_staff_id = sp.staff_id and e.ev_day = sp.day
  order by sp.staff_ref, sp.day;
end;
$function$;

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
    select e.staff_id as c_staff_id, e.staff_ref as c_staff_ref, e.note_id as c_note_id
    from public.v_pso_note_events e
    where e.note_day between p_from and p_to
      and e.reversed_at is null
      and e.pre_enrolment = false
      and (p_staff_id is null or e.staff_id = p_staff_id)
  ),
  officers as (
    select o.staff_id as o_staff_id, o.staff_ref as o_staff_ref
    from public.v_pso_officers o
    where p_staff_id is null or o.staff_id = p_staff_id
  ),
  plan_funded as (
    select c.c_staff_id as f_staff_id, c.c_note_id as f_note_id, sum(b.booked_amount)::numeric as amt
    from cohort c
    join public.v_cfo_promissory_bookings b
      on b.note_id = c.c_note_id and b.funded_at is not null
    group by c.c_staff_id, c.c_note_id
  ),
  portfolio_funded as (
    select distinct on (ip.id) c.c_staff_id as f_staff_id, c.c_note_id as f_note_id, ip.investment_amount::numeric as amt
    from cohort c
    join public.promissory_notes n
      on n.id = c.c_note_id and n.partner_user_id is not null
    join public.investor_portfolios ip
      on ip.investor_id = n.partner_user_id
     and ip.created_at >= n.created_at
    where ip.status in ('active', 'locked')
    order by ip.id, n.created_at
  ),
  all_funded as (
    select pf.f_staff_id, pf.f_note_id, pf.amt from plan_funded pf
    union all
    select po.f_staff_id, po.f_note_id, po.amt from portfolio_funded po
  ),
  funded as (
    select a.f_staff_id as fn_staff_id,
           count(distinct a.f_note_id)::int as funded_n,
           coalesce(sum(a.amt), 0)::numeric as funded_amt
    from all_funded a
    group by a.f_staff_id
  ),
  commissions as (
    select o.staff_id as m_staff_id,
           coalesce(sum(ce.amount), 0)::numeric as commission_amt
    from public.promissory_commission_events ce
    join public.v_pso_officers o on o.user_id = ce.agent_id
    where ce.status = 'paid'
      and (ce.created_at at time zone 'Africa/Kampala')::date between p_from and p_to
      and (p_staff_id is null or o.staff_id = p_staff_id)
    group by o.staff_id
  ),
  sized as (
    select c.c_staff_id as s_staff_id, count(*)::int as cohort_n
    from cohort c
    group by c.c_staff_id
  )
  select o.o_staff_id,
         o.o_staff_ref,
         coalesce(s.cohort_n, 0)::int,
         coalesce(f.funded_n, 0)::int,
         coalesce(f.funded_amt, 0)::numeric,
         coalesce(m.commission_amt, 0)::numeric,
         now()
  from officers o
  left join sized s on s.s_staff_id = o.o_staff_id
  left join funded f on f.fn_staff_id = o.o_staff_id
  left join commissions m on m.m_staff_id = o.o_staff_id
  order by o.o_staff_ref;
end;
$function$;