CREATE OR REPLACE VIEW public.v_pso_conversions AS
WITH ce AS (
  SELECT ce.id AS source_id,
         'commission_event'::text AS source,
         ce.kind AS conversion_kind,
         COALESCE(n.agent_id, ce.agent_id) AS officer_user_id,
         ce.note_id,
         ce.partner_id,
         CASE WHEN ce.kind = 'portfolio_topup' THEN ce.base_amount::numeric
              ELSE COALESCE(p.investment_amount, ce.base_amount)::numeric END AS amount_deployed,
         ce.base_amount::numeric AS commission_base,
         ce.amount::numeric AS commission_amount,
         ce.created_at AS converted_at
  FROM public.promissory_commission_events ce
  LEFT JOIN public.promissory_notes n ON n.id = ce.note_id
  LEFT JOIN public.investor_portfolios p
         ON ce.source_table = 'investor_portfolios'
        AND p.id = ce.source_id::uuid
  WHERE ce.status = 'paid'
),
ip AS (
  SELECT DISTINCT ON (p.id)
         p.id AS source_id,
         'investor_portfolio'::text AS source,
         'portfolio_creation'::text AS conversion_kind,
         n.agent_id AS officer_user_id,
         n.id AS note_id,
         n.partner_user_id AS partner_id,
         p.investment_amount::numeric AS amount_deployed,
         0::numeric AS commission_base,
         0::numeric AS commission_amount,
         p.created_at AS converted_at
  FROM public.promissory_notes n
  JOIN public.investor_portfolios p
    ON p.investor_id = n.partner_user_id
   AND p.created_at >= n.created_at
  WHERE n.partner_user_id IS NOT NULL
    AND p.status IN ('active','locked')
    AND NOT EXISTS (
      SELECT 1 FROM public.promissory_commission_events x
      WHERE x.status = 'paid'
        AND x.source_table = 'investor_portfolios'
        AND x.source_id = p.id::text
    )
  ORDER BY p.id, n.created_at
),
pi AS (
  SELECT b.intent_id AS source_id,
         'plan_intent'::text AS source,
         'rent_funding'::text AS conversion_kind,
         n.agent_id AS officer_user_id,
         b.note_id,
         n.partner_user_id AS partner_id,
         b.booked_amount::numeric AS amount_deployed,
         0::numeric AS commission_base,
         0::numeric AS commission_amount,
         b.funded_at AS converted_at
  FROM public.v_cfo_promissory_bookings b
  JOIN public.promissory_notes n ON n.id = b.note_id
  WHERE b.funded_at IS NOT NULL
),
allc AS (
  SELECT * FROM ce UNION ALL SELECT * FROM ip UNION ALL SELECT * FROM pi
)
SELECT a.source_id,
       a.source,
       a.conversion_kind,
       a.officer_user_id,
       o.staff_id,
       o.staff_ref,
       o.officer_since,
       a.note_id,
       a.partner_id,
       a.amount_deployed,
       a.commission_base,
       a.commission_amount,
       a.converted_at,
       (a.converted_at AT TIME ZONE 'Africa/Kampala'::text)::date AS converted_day,
       ((n.created_at AT TIME ZONE 'Africa/Kampala'::text)::date < o.officer_since) AS from_pre_enrolment_note
FROM allc a
JOIN public.v_pso_officers o ON o.user_id = a.officer_user_id
LEFT JOIN public.promissory_notes n ON n.id = a.note_id
WHERE a.converted_at IS NOT NULL;

ALTER VIEW public.v_pso_conversions SET (security_invoker = on);
REVOKE ALL ON public.v_pso_conversions FROM anon;
GRANT SELECT ON public.v_pso_conversions TO authenticated;

DROP FUNCTION IF EXISTS public.pso_funded_summary(date, date, uuid);

CREATE FUNCTION public.pso_funded_summary(p_from date, p_to date, p_staff_id uuid DEFAULT NULL::uuid)
RETURNS TABLE(staff_id uuid, staff_ref text,
              notes_in_cohort integer, notes_unapproved integer,
              notes_funded integer, funders_converted integer, topups integer,
              amount_deployed numeric, commission_base numeric, commission_accrued numeric,
              pre_enrolment_notes integer, pre_enrolment_funded integer, pre_enrolment_amount numeric,
              as_at timestamp with time zone)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
declare
  v_self uuid := public.hr_my_staff_id();
  v_reviewer boolean := public.hr_is_admin()
    or public.hr_is_executive()
    or exists (
      select 1 from public.user_roles ur
      where ur.user_id = auth.uid() and ur.enabled = true
        and ur.role = any (array['coo'::app_role,'ceo'::app_role,'super_admin'::app_role])
    );
begin
  if p_from is null or p_to is null or p_to < p_from then
    raise exception 'pso_funded_summary: invalid window';
  end if;
  if (p_to - p_from) > 366 then
    raise exception 'pso_funded_summary: window exceeds 366 days';
  end if;
  if not v_reviewer then
    if v_self is null then raise exception 'pso_funded_summary: not permitted'; end if;
    if p_staff_id is not null and p_staff_id <> v_self then
      raise exception 'pso_funded_summary: not permitted';
    end if;
    p_staff_id := v_self;
  end if;

  return query
  with officers as (
    select o.staff_id as o_staff_id, o.staff_ref as o_staff_ref
    from public.v_pso_officers o
    where p_staff_id is null or o.staff_id = p_staff_id
  ),
  notes as (
    select e.staff_id as n_staff_id,
           count(*) filter (where not e.pre_enrolment and e.reversed_at is null)::int as live_n,
           count(*) filter (where not e.pre_enrolment and e.reversed_at is null
                              and coalesce(n.approval_bonus_paid,false) = false)::int as unapproved_n,
           count(*) filter (where e.pre_enrolment and e.reversed_at is null)::int as pre_n
    from public.v_pso_note_events e
    join public.promissory_notes n on n.id = e.note_id
    where e.note_day between p_from and p_to
      and (p_staff_id is null or e.staff_id = p_staff_id)
    group by e.staff_id
  ),
  conv as (
    select c.staff_id as c_staff_id,
           count(distinct c.note_id)::int as funded_n,
           count(distinct c.partner_id)::int as funders_n,
           count(*) filter (where c.conversion_kind = 'portfolio_topup')::int as topup_n,
           coalesce(sum(c.amount_deployed),0)::numeric as deployed_amt,
           coalesce(sum(c.commission_base),0)::numeric as base_amt,
           coalesce(sum(c.commission_amount),0)::numeric as comm_amt,
           count(distinct c.note_id) filter (where c.from_pre_enrolment_note)::int as pre_funded_n,
           coalesce(sum(c.amount_deployed) filter (where c.from_pre_enrolment_note),0)::numeric as pre_amt
    from public.v_pso_conversions c
    where c.converted_day between p_from and p_to
      and not exists (select 1 from public.pso_note_reversals r where r.note_id = c.note_id)
      and (p_staff_id is null or c.staff_id = p_staff_id)
    group by c.staff_id
  )
  select o.o_staff_id,
         o.o_staff_ref,
         coalesce(nt.live_n,0)::int,
         coalesce(nt.unapproved_n,0)::int,
         coalesce(cv.funded_n,0)::int,
         coalesce(cv.funders_n,0)::int,
         coalesce(cv.topup_n,0)::int,
         coalesce(cv.deployed_amt,0)::numeric,
         coalesce(cv.base_amt,0)::numeric,
         coalesce(cv.comm_amt,0)::numeric,
         coalesce(nt.pre_n,0)::int,
         coalesce(cv.pre_funded_n,0)::int,
         coalesce(cv.pre_amt,0)::numeric,
         now()
  from officers o
  left join notes nt on nt.n_staff_id = o.o_staff_id
  left join conv cv on cv.c_staff_id = o.o_staff_id
  order by o.o_staff_ref;
end;
$function$;

REVOKE ALL ON FUNCTION public.pso_funded_summary(date,date,uuid) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.pso_funded_summary(date,date,uuid) TO authenticated;