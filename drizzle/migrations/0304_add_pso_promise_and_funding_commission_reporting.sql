CREATE FUNCTION public.pso_promise_summary(p_from date, p_to date, p_staff_id uuid DEFAULT NULL::uuid)
RETURNS TABLE(staff_id uuid, staff_ref text,
              notes_activated integer, notes_pending integer,
              promised_amount numeric, promised_activated numeric,
              pre_enrolment_promised numeric,
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
    raise exception 'pso_promise_summary: invalid window';
  end if;
  if (p_to - p_from) > 366 then
    raise exception 'pso_promise_summary: window exceeds 366 days';
  end if;
  if not v_reviewer then
    if v_self is null then raise exception 'pso_promise_summary: not permitted'; end if;
    if p_staff_id is not null and p_staff_id <> v_self then
      raise exception 'pso_promise_summary: not permitted';
    end if;
    p_staff_id := v_self;
  end if;

  return query
  with officers as (
    select o.staff_id as o_staff_id, o.staff_ref as o_staff_ref
    from public.v_pso_officers o
    where p_staff_id is null or o.staff_id = p_staff_id
  ),
  pn as (
    select e.staff_id as s_id,
           count(*) filter (where not e.pre_enrolment and e.reversed_at is null and e.note_status = 'activated')::int as act_n,
           count(*) filter (where not e.pre_enrolment and e.reversed_at is null and e.note_status = 'pending')::int as pend_n,
           coalesce(sum(e.amount) filter (where not e.pre_enrolment and e.reversed_at is null),0)::numeric as prom,
           coalesce(sum(e.amount) filter (where not e.pre_enrolment and e.reversed_at is null and e.note_status = 'activated'),0)::numeric as prom_act,
           coalesce(sum(e.amount) filter (where e.pre_enrolment and e.reversed_at is null),0)::numeric as pre_prom
    from public.v_pso_note_events e
    where e.note_day between p_from and p_to
      and (p_staff_id is null or e.staff_id = p_staff_id)
    group by e.staff_id
  )
  select o.o_staff_id, o.o_staff_ref,
         coalesce(pn.act_n,0)::int, coalesce(pn.pend_n,0)::int,
         coalesce(pn.prom,0)::numeric, coalesce(pn.prom_act,0)::numeric,
         coalesce(pn.pre_prom,0)::numeric,
         now()
  from officers o
  left join pn on pn.s_id = o.o_staff_id
  order by o.o_staff_ref;
end;
$function$;

REVOKE ALL ON FUNCTION public.pso_promise_summary(date,date,uuid) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.pso_promise_summary(date,date,uuid) TO authenticated;

REVOKE ALL ON FUNCTION public.pso_facilitation_guard() FROM anon, public;
REVOKE ALL ON FUNCTION public.pso_facilitation_report_guard() FROM anon, public;

CREATE OR REPLACE VIEW public.v_funding_commission AS
SELECT e.id AS source_id,
       'promissory_note'::text AS path,
       e.kind,
       e.agent_id AS earner_id,
       e.partner_id,
       e.note_id,
       e.base_amount::numeric AS base_amount,
       e.rate::numeric AS rate,
       e.amount::numeric AS commission_amount,
       e.status,
       e.source_table,
       e.source_id::text AS funding_source_id,
       e.created_at
FROM public.promissory_commission_events e
WHERE e.kind IN ('portfolio_creation','portfolio_topup')
UNION ALL
SELECT q.id,
       'managed_proxy'::text,
       q.kind,
       q.agent_id,
       q.partner_id,
       NULL::uuid,
       q.base_amount::numeric,
       q.rate::numeric,
       q.amount::numeric,
       q.status,
       q.source_table,
       q.source_id::text,
       q.created_at
FROM public.proxy_commission_queue q
WHERE q.kind IN ('portfolio_creation','portfolio_topup');

ALTER VIEW public.v_funding_commission SET (security_invoker = on);
REVOKE ALL ON public.v_funding_commission FROM anon, authenticated, public;

CREATE FUNCTION public.funding_commission_summary(p_from date, p_to date)
RETURNS TABLE(earner_id uuid, earner_name text, staff_ref text, is_pso boolean, paths text,
              creations integer, topups integer,
              base_creation numeric, base_topup numeric,
              commission_paid numeric, commission_pending numeric,
              as_at timestamp with time zone)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
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
  if not v_reviewer then
    raise exception 'funding_commission_summary: not permitted';
  end if;
  if p_from is null or p_to is null or p_to < p_from then
    raise exception 'funding_commission_summary: invalid window';
  end if;
  if (p_to - p_from) > 366 then
    raise exception 'funding_commission_summary: window exceeds 366 days';
  end if;

  return query
  with f as (
    select fc.* from public.v_funding_commission fc
    where (fc.created_at at time zone 'Africa/Kampala')::date between p_from and p_to
  )
  select f.earner_id,
         coalesce(nullif(btrim(p.full_name),''), 'Unknown')::text,
         s.staff_ref::text,
         exists (select 1 from public.v_pso_officers o where o.user_id = f.earner_id),
         string_agg(distinct f.path, ', ')::text,
         count(*) filter (where f.status = 'paid' and f.kind = 'portfolio_creation')::int,
         count(*) filter (where f.status = 'paid' and f.kind = 'portfolio_topup')::int,
         coalesce(sum(f.base_amount) filter (where f.status = 'paid' and f.kind = 'portfolio_creation'),0)::numeric,
         coalesce(sum(f.base_amount) filter (where f.status = 'paid' and f.kind = 'portfolio_topup'),0)::numeric,
         coalesce(sum(f.commission_amount) filter (where f.status = 'paid'),0)::numeric,
         coalesce(sum(f.commission_amount) filter (where f.status = 'pending'),0)::numeric,
         now()
  from f
  left join public.profiles p on p.id = f.earner_id
  left join public.hr_staff s on s.user_id = f.earner_id
  group by f.earner_id, p.full_name, s.staff_ref
  order by 10 desc, 2;
end;
$function$;

REVOKE ALL ON FUNCTION public.funding_commission_summary(date,date) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.funding_commission_summary(date,date) TO authenticated;

CREATE OR REPLACE VIEW public.v_pso_conversions AS
 WITH ce AS (
         SELECT ce.id AS source_id,
            'commission_event'::text AS source,
            ce.kind AS conversion_kind,
            COALESCE(n_1.agent_id, ce.agent_id) AS officer_user_id,
            ce.note_id,
            ce.partner_id,
                CASE
                    WHEN ce.kind = 'portfolio_topup'::text THEN ce.base_amount
                    ELSE COALESCE(p.investment_amount, ce.base_amount)
                END AS amount_deployed,
            ce.base_amount AS commission_base,
            ce.amount AS commission_amount,
            ce.created_at AS converted_at
           FROM promissory_commission_events ce
             LEFT JOIN promissory_notes n_1 ON n_1.id = ce.note_id
             LEFT JOIN investor_portfolios p ON ce.source_table = 'investor_portfolios'::text AND p.id = ce.source_id::uuid
          WHERE ce.status = 'paid'::text
        ), ip AS (
         SELECT DISTINCT ON (p.id) p.id AS source_id,
            'investor_portfolio'::text AS source,
            'portfolio_creation'::text AS conversion_kind,
            n_1.agent_id AS officer_user_id,
            n_1.id AS note_id,
            n_1.partner_user_id AS partner_id,
            p.investment_amount AS amount_deployed,
            0::numeric AS commission_base,
            0::numeric AS commission_amount,
            p.created_at AS converted_at
           FROM promissory_notes n_1
             JOIN investor_portfolios p ON p.investor_id = n_1.partner_user_id AND p.created_at >= n_1.created_at
          WHERE n_1.partner_user_id IS NOT NULL AND (p.status = ANY (ARRAY['active'::text, 'locked'::text])) AND NOT (EXISTS ( SELECT 1
                   FROM promissory_commission_events x
                  WHERE x.status = 'paid'::text AND x.kind = 'portfolio_creation'::text AND x.source_table = 'investor_portfolios'::text AND x.source_id = p.id::text))
          ORDER BY p.id, n_1.created_at
        ), pi AS (
         SELECT b.intent_id AS source_id,
            'plan_intent'::text AS source,
            'rent_funding'::text AS conversion_kind,
            n_1.agent_id AS officer_user_id,
            b.note_id,
            n_1.partner_user_id AS partner_id,
            b.booked_amount::numeric AS amount_deployed,
            0::numeric AS commission_base,
            0::numeric AS commission_amount,
            b.funded_at AS converted_at
           FROM v_cfo_promissory_bookings b
             JOIN promissory_notes n_1 ON n_1.id = b.note_id
          WHERE b.funded_at IS NOT NULL
        ), pq AS (
         SELECT q.id AS source_id,
            'proxy_commission'::text AS source,
            q.kind AS conversion_kind,
            q.agent_id AS officer_user_id,
            NULL::uuid AS note_id,
            q.partner_id,
            q.base_amount::numeric AS amount_deployed,
            q.base_amount::numeric AS commission_base,
            q.amount::numeric AS commission_amount,
            q.created_at AS converted_at
           FROM proxy_commission_queue q
          WHERE q.status = 'paid'::text AND q.kind = ANY (ARRAY['portfolio_creation'::text, 'portfolio_topup'::text])
        ), allc AS (
         SELECT ce.source_id,
            ce.source,
            ce.conversion_kind,
            ce.officer_user_id,
            ce.note_id,
            ce.partner_id,
            ce.amount_deployed,
            ce.commission_base,
            ce.commission_amount,
            ce.converted_at
           FROM ce
        UNION ALL
         SELECT ip.source_id,
            ip.source,
            ip.conversion_kind,
            ip.officer_user_id,
            ip.note_id,
            ip.partner_id,
            ip.amount_deployed,
            ip.commission_base,
            ip.commission_amount,
            ip.converted_at
           FROM ip
        UNION ALL
         SELECT pi.source_id,
            pi.source,
            pi.conversion_kind,
            pi.officer_user_id,
            pi.note_id,
            pi.partner_id,
            pi.amount_deployed,
            pi.commission_base,
            pi.commission_amount,
            pi.converted_at
           FROM pi
        UNION ALL
         SELECT pq.source_id,
            pq.source,
            pq.conversion_kind,
            pq.officer_user_id,
            pq.note_id,
            pq.partner_id,
            pq.amount_deployed,
            pq.commission_base,
            pq.commission_amount,
            pq.converted_at
           FROM pq
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
    (n.created_at AT TIME ZONE 'Africa/Kampala'::text)::date < o.officer_since AS from_pre_enrolment_note
   FROM allc a
     JOIN v_pso_officers o ON o.user_id = a.officer_user_id
     LEFT JOIN promissory_notes n ON n.id = a.note_id
  WHERE a.converted_at IS NOT NULL;

ALTER VIEW public.v_pso_conversions SET (security_invoker = on);
REVOKE ALL ON public.v_pso_conversions FROM anon;
GRANT SELECT ON public.v_pso_conversions TO authenticated;