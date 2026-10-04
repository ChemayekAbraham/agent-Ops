begin;

revoke update, delete, truncate, references, trigger on public.pso_note_reversals from authenticated;

create or replace function public.pso_funded_summary(
  p_from date,
  p_to date,
  p_staff_id uuid default null
)
returns table (
  staff_id uuid,
  staff_ref text,
  notes_in_cohort integer,
  notes_funded integer,
  amount_funded numeric,
  commission_accrued numeric,
  as_at timestamptz
)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
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
  funded as (
    select c.staff_id,
           count(distinct b.note_id)::int as funded_n,
           coalesce(sum(b.booked_amount), 0)::numeric as funded_amt
    from cohort c
    join public.v_cfo_promissory_bookings b
      on b.note_id = c.note_id and b.funded_at is not null
    group by c.staff_id
  ),
  commissions as (
    select c.staff_id,
           coalesce(sum(ce.amount), 0)::numeric as commission_amt
    from cohort c
    join public.promissory_commission_events ce
      on ce.note_id = c.note_id and ce.status = 'paid'
    group by c.staff_id
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
  'Funded sales for a Platform Sales Officer creation cohort, measured as-at now and never frozen. Funded means the booking carries funded_at, that is money actually deployed. Note that promissory_note_plan_intents.status = funded is a different and narrower measure and the two do not agree across the book. Commission is whatever promissory_commission_events has already paid against those notes, accrued at portfolio deployment and top-up, not on receipt against the note.';

revoke all on function public.pso_funded_summary(date, date, uuid) from public, anon;
grant execute on function public.pso_funded_summary(date, date, uuid) to authenticated;

commit;