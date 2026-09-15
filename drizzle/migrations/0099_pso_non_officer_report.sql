-- Parallel promissory-note report for posters who are NOT platform sales
-- officers. Mirrors pso_daily_series / pso_funded_summary column-for-column so
-- the same table headings apply; keyed by the poster's user id + real name.

CREATE OR REPLACE FUNCTION public.pso_non_officer_series(p_from date, p_to date)
RETURNS TABLE(person_user_id uuid, person_name text, day date, notes_created integer, notes_reversed integer, net_notes integer, partner_registered integer)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
declare
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
    raise exception 'pso_non_officer_series: invalid window';
  end if;
  if (p_to - p_from) > 366 then
    raise exception 'pso_non_officer_series: window exceeds 366 days';
  end if;
  if not v_reviewer then
    raise exception 'pso_non_officer_series: not permitted';
  end if;

  return query
  with posters as (
    select distinct n.agent_id as person_user_id
    from public.promissory_notes n
    where n.agent_id is not null
      and not exists (select 1 from public.v_pso_officers o where o.user_id = n.agent_id)
      and ((n.created_at at time zone 'Africa/Kampala')::date between p_from and p_to)
  ),
  people as (
    select po.person_user_id,
           coalesce(nullif(btrim(pr.full_name), ''), nullif(btrim(pr.phone), ''), 'Unknown') as person_name
    from posters po
    left join public.profiles pr on pr.id = po.person_user_id
  ),
  spine as (
    select p.person_user_id, p.person_name, d::date as day
    from people p
    cross join lateral generate_series(
      p_from::timestamp,
      least(p_to, (now() at time zone 'Africa/Kampala')::date)::timestamp,
      interval '1 day'
    ) as d
  ),
  ev as (
    select n.agent_id as ev_user_id,
           ((n.created_at at time zone 'Africa/Kampala')::date) as ev_day,
           count(*)::int as created_n,
           count(*) filter (where r.reversed_at is not null)::int as rev_n,
           count(*) filter (where n.partner_user_id is not null)::int as reg_n
    from public.promissory_notes n
    left join public.pso_note_reversals r on r.note_id = n.id
    where n.agent_id is not null
      and not exists (select 1 from public.v_pso_officers o where o.user_id = n.agent_id)
      and ((n.created_at at time zone 'Africa/Kampala')::date between p_from and p_to)
    group by n.agent_id, ((n.created_at at time zone 'Africa/Kampala')::date)
  )
  select sp.person_user_id,
         sp.person_name,
         sp.day,
         coalesce(e.created_n, 0)::int,
         coalesce(e.rev_n, 0)::int,
         (coalesce(e.created_n, 0) - coalesce(e.rev_n, 0))::int,
         coalesce(e.reg_n, 0)::int
  from spine sp
  left join ev e on e.ev_user_id = sp.person_user_id and e.ev_day = sp.day
  order by sp.person_name, sp.day;
end;
$function$;

REVOKE ALL ON FUNCTION public.pso_non_officer_series(date, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pso_non_officer_series(date, date) TO authenticated;

CREATE OR REPLACE FUNCTION public.pso_non_officer_funded_summary(p_from date, p_to date)
RETURNS TABLE(person_user_id uuid, person_name text, notes_in_cohort integer, notes_unapproved integer, notes_funded integer, funders_converted integer, topups integer, amount_deployed numeric, commission_base numeric, commission_accrued numeric, pre_enrolment_notes integer, pre_enrolment_funded integer, pre_enrolment_amount numeric, as_at timestamp with time zone)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
declare
  v_reviewer boolean := public.hr_is_admin()
    or public.hr_is_executive()
    or exists (
      select 1 from public.user_roles ur
      where ur.user_id = auth.uid() and ur.enabled = true
        and ur.role = any (array['coo'::app_role,'ceo'::app_role,'super_admin'::app_role])
    );
begin
  if p_from is null or p_to is null or p_to < p_from then
    raise exception 'pso_non_officer_funded_summary: invalid window';
  end if;
  if (p_to - p_from) > 366 then
    raise exception 'pso_non_officer_funded_summary: window exceeds 366 days';
  end if;
  if not v_reviewer then
    raise exception 'pso_non_officer_funded_summary: not permitted';
  end if;

  return query
  with posters as (
    select distinct n.agent_id as person_user_id
    from public.promissory_notes n
    where n.agent_id is not null
      and not exists (select 1 from public.v_pso_officers o where o.user_id = n.agent_id)
      and ((n.created_at at time zone 'Africa/Kampala')::date between p_from and p_to)
  ),
  people as (
    select po.person_user_id,
           coalesce(nullif(btrim(pr.full_name), ''), nullif(btrim(pr.phone), ''), 'Unknown') as person_name
    from posters po
    left join public.profiles pr on pr.id = po.person_user_id
  ),
  notes as (
    select n.agent_id as n_user_id,
           count(*) filter (where r.reversed_at is null)::int as live_n,
           count(*) filter (where r.reversed_at is null
                             and coalesce(n.approval_bonus_paid, false) = false)::int as unapproved_n
    from public.promissory_notes n
    left join public.pso_note_reversals r on r.note_id = n.id
    where n.agent_id is not null
      and not exists (select 1 from public.v_pso_officers o where o.user_id = n.agent_id)
      and ((n.created_at at time zone 'Africa/Kampala')::date between p_from and p_to)
    group by n.agent_id
  ),
  allc as (
    -- Same three conversion sources as v_pso_conversions, keyed by the poster's
    -- user id, excluding platform sales officers.
    select ce.id as source_id,
           ce.kind as conversion_kind,
           coalesce(nn.agent_id, ce.agent_id) as poster_user_id,
           ce.note_id,
           ce.partner_id,
           case when ce.kind = 'portfolio_topup' then ce.base_amount
                else coalesce(p.investment_amount, ce.base_amount) end as amount_deployed,
           ce.base_amount as commission_base,
           ce.amount as commission_amount,
           ce.created_at as converted_at
    from public.promissory_commission_events ce
    left join public.promissory_notes nn on nn.id = ce.note_id
    left join public.investor_portfolios p
      on ce.source_table = 'investor_portfolios' and p.id = ce.source_id::uuid
    where ce.status = 'paid'

    union all

    select p.id as source_id,
           'portfolio_creation'::text as conversion_kind,
           nn.agent_id as poster_user_id,
           nn.id as note_id,
           nn.partner_user_id as partner_id,
           p.investment_amount as amount_deployed,
           0::numeric as commission_base,
           0::numeric as commission_amount,
           p.created_at as converted_at
    from public.promissory_notes nn
    join public.investor_portfolios p
      on p.investor_id = nn.partner_user_id and p.created_at >= nn.created_at
    where nn.partner_user_id is not null
      and p.status = any (array['active'::text, 'locked'::text])
      and not exists (
        select 1 from public.promissory_commission_events x
        where x.status = 'paid' and x.source_table = 'investor_portfolios' and x.source_id = p.id::text
      )

    union all

    select b.intent_id as source_id,
           'rent_funding'::text as conversion_kind,
           nn.agent_id as poster_user_id,
           b.note_id,
           nn.partner_user_id as partner_id,
           b.booked_amount::numeric as amount_deployed,
           0::numeric as commission_base,
           0::numeric as commission_amount,
           b.funded_at as converted_at
    from public.v_cfo_promissory_bookings b
    join public.promissory_notes nn on nn.id = b.note_id
    where b.funded_at is not null
  ),
  conv as (
    select c.poster_user_id as c_user_id,
           count(distinct c.note_id)::int as funded_n,
           count(distinct c.partner_id)::int as funders_n,
           count(*) filter (where c.conversion_kind = 'portfolio_topup')::int as topup_n,
           coalesce(sum(c.amount_deployed), 0)::numeric as deployed_amt,
           coalesce(sum(c.commission_base), 0)::numeric as base_amt,
           coalesce(sum(c.commission_amount), 0)::numeric as comm_amt
    from allc c
    where c.poster_user_id is not null
      and not exists (select 1 from public.v_pso_officers o where o.user_id = c.poster_user_id)
      and not exists (select 1 from public.pso_note_reversals r where r.note_id = c.note_id)
      and ((c.converted_at at time zone 'Africa/Kampala')::date between p_from and p_to)
    group by c.poster_user_id
  )
  select pe.person_user_id,
         pe.person_name,
         coalesce(nt.live_n, 0)::int,
         coalesce(nt.unapproved_n, 0)::int,
         coalesce(cv.funded_n, 0)::int,
         coalesce(cv.funders_n, 0)::int,
         coalesce(cv.topup_n, 0)::int,
         coalesce(cv.deployed_amt, 0)::numeric,
         coalesce(cv.base_amt, 0)::numeric,
         coalesce(cv.comm_amt, 0)::numeric,
         0::int,
         0::int,
         0::numeric,
         now()
  from people pe
  left join notes nt on nt.n_user_id = pe.person_user_id
  left join conv cv on cv.c_user_id = pe.person_user_id
  order by pe.person_name;
end;
$function$;

REVOKE ALL ON FUNCTION public.pso_non_officer_funded_summary(date, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pso_non_officer_funded_summary(date, date) TO authenticated;