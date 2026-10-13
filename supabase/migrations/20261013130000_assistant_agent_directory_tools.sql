-- Agent assistant: profile, tenants (with Rent Plans and landlords) and sub-agents.
--
-- Same model as the first tools: read-only, STABLE, SECURITY DEFINER, identity comes from
-- auth.uid() and is NEVER a parameter, every function starts with assistant_require_agent()
-- (signed in -> rollout access -> agent footprint).
--
-- Isolation: these functions read the tables directly. They do not call any other service or
-- existing RPC, because those return broader rows. Every column that leaves the database is on an
-- explicit whitelist below; nothing is `select *`.
--
-- NEVER returned (by design): passwords/credentials, avatar URLs, last-login/last-active/dashboard
-- access fields, national ID numbers and photos, selfie/ID image paths and hashes, device
-- fingerprints, payout destinations (mobile money / bank numbers), GPS coordinates, staff notes
-- and comments, freeze/deletion reasons, funder/supporter identities, internal reviewer ids.
--
-- Reversed collections are excluded everywhere (reversed_at is null and amount > 0).
--
-- The only model-supplied inputs are a short search string (letters, digits, space . ' + -),
-- optional dates and small enums. The search string only FILTERS inside the signed-in agent's own
-- set; LIKE wildcards are escaped and it is length-limited. Names/addresses that come back are
-- stripped of control and markup characters, because other people typed them.

-- ---------------------------------------------------------------------------
-- Text cleaners (internal; the definer functions below call them)
-- ---------------------------------------------------------------------------
create or replace function public.assistant_clean_text(
  p_text text,
  p_max integer default 80,
  p_address boolean default false
)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select nullif(
    left(
      btrim(regexp_replace(
        case when p_address
          then regexp_replace(coalesce(p_text, ''), '[^[:alnum:] .,''/#()-]', ' ', 'g')
          else regexp_replace(coalesce(p_text, ''), '[^[:alnum:] .''-]', ' ', 'g')
        end,
        '\s+', ' ', 'g')),
      greatest(coalesce(p_max, 80), 1)),
    '');
$$;

create or replace function public.assistant_clean_phone(p_phone text)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select nullif(left(regexp_replace(coalesce(p_phone, ''), '[^0-9+]', '', 'g'), 16), '');
$$;

-- A real contact email, or null for the platform's placeholder login addresses.
create or replace function public.assistant_real_email(p_email text)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case
    when p_email is null or p_email = '' then null
    when p_email ~* '@(noapp\.)?welile\.(user|agent)$' or p_email ~* '@deleted\.invalid$' then null
    else left(p_email, 120)
  end;
$$;

revoke execute on function public.assistant_clean_text(text, integer, boolean) from public, anon, authenticated;
revoke execute on function public.assistant_clean_phone(text) from public, anon, authenticated;
revoke execute on function public.assistant_real_email(text) from public, anon, authenticated;
grant  execute on function public.assistant_clean_text(text, integer, boolean) to service_role;
grant  execute on function public.assistant_clean_phone(text) to service_role;
grant  execute on function public.assistant_real_email(text) to service_role;

-- ---------------------------------------------------------------------------
-- The signed-in agent's own profile
-- ---------------------------------------------------------------------------
create or replace function public.assistant_agent_my_profile()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_result jsonb;
begin
  perform public.assistant_require_agent();

  select jsonb_build_object(
    'name',            public.assistant_clean_text(p.full_name, 80),
    'phone',           public.assistant_clean_phone(p.phone),
    'email',           public.assistant_real_email(p.email),
    'has_email',       (public.assistant_real_email(p.email) is not null),
    'joined',          p.created_at::date,
    'verified',        coalesce(p.verified, false),
    'phone_verified',  coalesce(p.phone_verified, false),
    'account_frozen',  coalesce(p.is_frozen, false),
    'agent_type',      public.assistant_clean_text(p.agent_type, 40),
    'agent_tier',      public.assistant_clean_text(p.agent_tier::text, 40),
    'territory',       public.assistant_clean_text(p.territory, 80),
    'occupation',      public.assistant_clean_text(p.occupation, 60),
    'preferred_language', public.assistant_clean_text(p.preferred_language, 20),
    'location', jsonb_strip_nulls(jsonb_build_object(
      'village',    public.assistant_clean_text(p.village, 60),
      'parish',     public.assistant_clean_text(p.parish, 60),
      'sub_county', public.assistant_clean_text(p.sub_county, 60),
      'district',   public.assistant_clean_text(p.district, 60),
      'region',     public.assistant_clean_text(p.region, 60),
      'town',       public.assistant_clean_text(p.town, 60),
      'city',       public.assistant_clean_text(p.city, 60),
      'country',    public.assistant_clean_text(p.country, 60))),
    'parent_agent', (
      select jsonb_build_object(
               'name',  public.assistant_clean_text(pp.full_name, 80),
               'phone', public.assistant_clean_phone(pp.phone))
        from public.agent_subagents sa
        join public.profiles pp on pp.id = sa.parent_agent_id and pp.deleted_at is null
       where sa.sub_agent_id = v_uid and sa.status = 'verified'
       order by coalesce(sa.verified_at, sa.accepted_at, sa.created_at) desc
       limit 1),
    'sub_agents_verified', (select count(*) from public.agent_subagents sa where sa.parent_agent_id = v_uid and sa.status = 'verified'),
    'sub_agents_pending',  (select count(*) from public.agent_subagents sa where sa.parent_agent_id = v_uid and sa.status = 'pending_acceptance')
  ) into v_result
  from public.profiles p
  where p.id = v_uid and p.deleted_at is null;

  return coalesce(v_result, '{}'::jsonb);
end;
$$;

-- ---------------------------------------------------------------------------
-- Tenant counts (same keys as before; linkage now ignores reversed collections and plans the
-- agent deleted, so every tenant tool agrees)
-- ---------------------------------------------------------------------------
create or replace function public.assistant_agent_tenants()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid   uuid := auth.uid();
  v_today date := (now() at time zone 'Africa/Kampala')::date;
  v_result jsonb;
begin
  perform public.assistant_require_agent();

  with linked as (
    select rr.tenant_id from public.rent_requests rr
     where rr.tenant_id is not null and rr.status <> 'deleted_by_agent'
       and (rr.agent_id = v_uid or rr.assigned_agent_id = v_uid)
    union
    select ac.tenant_id from public.agent_collections ac
     where ac.tenant_id is not null and ac.agent_id = v_uid
       and ac.reversed_at is null and ac.amount > 0
  ),
  active_plans as (
    select rr.id, rr.tenant_id from public.rent_requests rr
     where (rr.agent_id = v_uid or rr.assigned_agent_id = v_uid)
       and rr.tenant_id is not null
       and rr.status in ('funded', 'repaying', 'disbursed', 'active')
       and coalesce(rr.tenancy_status, 'active') <> 'ended'
  )
  select jsonb_build_object(
    'tenants_linked',          (select count(*) from linked),
    'active_rent_plans',       (select count(*) from active_plans),
    'tenants_on_active_plans', (select count(distinct tenant_id) from active_plans),
    'tenants_billed_today',    (select count(distinct pl.tenant_id)
                                  from public.agent_expected_day_plans pl
                                 where pl.agent_id = v_uid and pl.day = v_today)
  ) into v_result;

  return v_result;
end;
$$;

-- ---------------------------------------------------------------------------
-- Find the agent's tenants (list view)
-- ---------------------------------------------------------------------------
create or replace function public.assistant_agent_find_tenants(
  p_search text default null,
  p_plan   text default 'all',
  p_from   date default null,
  p_to     date default null,
  p_limit  integer default 15,
  p_email  text default 'any'
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid    uuid := auth.uid();
  v_today  date := (now() at time zone 'Africa/Kampala')::date;
  v_to     date := coalesce(p_to, v_today);
  v_from   date := coalesce(p_from, coalesce(p_to, v_today) - 29);
  -- Plain timestamp bounds (Kampala midnight to midnight) so the collections index can be used.
  v_from_ts timestamptz := v_from::timestamp at time zone 'Africa/Kampala';
  v_to_ts   timestamptz := (v_to + 1)::timestamp at time zone 'Africa/Kampala';
  v_limit  integer := least(greatest(coalesce(p_limit, 15), 1), 25);
  v_plan   text := lower(coalesce(nullif(btrim(p_plan), ''), 'all'));
  v_email  text := lower(coalesce(nullif(btrim(p_email), ''), 'any'));
  v_term   text := nullif(btrim(left(coalesce(p_search, ''), 40)), '');
  v_words  text[];
  v_digits text;
  v_result jsonb;
begin
  perform public.assistant_require_agent();

  if v_from > v_to or v_to - v_from > 92 or v_to > v_today then
    raise exception 'invalid_range' using errcode = '22023';
  end if;
  if v_plan not in ('all', 'active', 'in_review', 'completed') then
    raise exception 'invalid_plan' using errcode = '22023';
  end if;
  if v_email not in ('any', 'missing', 'present') then
    raise exception 'invalid_email_filter' using errcode = '22023';
  end if;
  if v_term is not null and v_term !~ '^[[:alnum:] .''+-]+$' then
    raise exception 'invalid_search' using errcode = '22023';
  end if;

  v_words := array(
    select '%' || replace(replace(replace(w, '\', '\\'), '%', '\%'), '_', '\_') || '%'
      from unnest(string_to_array(coalesce(v_term, ''), ' ')) w
     where w <> '');
  v_digits := nullif(regexp_replace(coalesce(v_term, ''), '\D', '', 'g'), '');

  with my_tenants as (
    select rr.tenant_id from public.rent_requests rr
     where rr.tenant_id is not null and rr.status <> 'deleted_by_agent'
       and (rr.agent_id = v_uid or rr.assigned_agent_id = v_uid)
    union
    select ac.tenant_id from public.agent_collections ac
     where ac.tenant_id is not null and ac.agent_id = v_uid
       and ac.reversed_at is null and ac.amount > 0
  ),
  base as (
    select p.id, p.full_name, p.phone, p.email, p.village, p.sub_county, p.district
      from public.profiles p
      join my_tenants t on t.tenant_id = p.id
     where p.deleted_at is null
       and (cardinality(v_words) = 0
            or p.full_name ilike all (v_words)
            or (v_digits is not null and length(v_digits) >= 4
                and regexp_replace(coalesce(p.phone, ''), '\D', '', 'g') like '%' || v_digits || '%'))
  ),
  plans as (
    select rr.tenant_id, rr.created_at, rr.status, rr.rent_amount, rr.duration_days, rr.daily_repayment,
           rr.amount_repaid, rr.funded_at, rr.repayment_starts_on, rr.repayment_frequency, rr.tenancy_status,
           case when rr.status in ('funded', 'repaying', 'disbursed', 'active') then 'active'
                when rr.status = 'completed' then 'completed'
                when rr.status = 'rejected' then 'rejected'
                when rr.status = 'cancelled' then 'cancelled'
                else 'in_review' end as stage,
           case when rr.registration_type = 'outstanding_balance'
                then coalesce(nullif(rr.initial_outstanding_balance, 0), rr.total_repayment, 0)
                else coalesce(rr.total_repayment, 0) end as plan_total
      from public.rent_requests rr
     where rr.tenant_id in (select id from base)
       and rr.status <> 'deleted_by_agent'
       and (rr.agent_id = v_uid or rr.assigned_agent_id = v_uid)
  ),
  -- Everyone matching the search and plan filter, WITH or WITHOUT an email on file. The email
  -- filter below only narrows this on request; nobody is ever dropped for lacking an email.
  pre as (
    select b.*, (public.assistant_real_email(b.email) is not null) as has_email
      from base b
     where v_plan = 'all' or exists (select 1 from plans pf where pf.tenant_id = b.id and pf.stage = v_plan)
  ),
  filtered as (
    select * from pre
     where v_email = 'any' or (v_email = 'present') = has_email
  ),
  page as (
    select f.* from filtered f order by f.full_name nulls last, f.id limit v_limit
  ),
  cash as (
    select ac.tenant_id, sum(ac.amount) as total, count(*) as n
      from public.agent_collections ac
     where ac.agent_id = v_uid and ac.reversed_at is null and ac.amount > 0
       and ac.created_at >= v_from_ts and ac.created_at < v_to_ts
       and ac.tenant_id in (select id from page)
     group by ac.tenant_id
  )
  select jsonb_build_object(
    'search', v_term,
    'plan_filter', v_plan,
    'email_filter', v_email,
    'period', jsonb_build_object('from', v_from, 'to', v_to),
    'total_matching', (select count(*) from filtered),
    'email_summary', jsonb_build_object(
      'with_email',    (select count(*) from pre where has_email),
      'without_email', (select count(*) from pre where not has_email)),
    'returned', (select count(*) from page),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'name',  public.assistant_clean_text(pg.full_name, 80),
        'phone', public.assistant_clean_phone(pg.phone),
        'email', public.assistant_real_email(pg.email),
        'has_email', pg.has_email,
        'location', public.assistant_clean_text(concat_ws(', ', pg.village, pg.sub_county, pg.district), 100, true),
        'plans_total', (select count(*) from plans pf where pf.tenant_id = pg.id),
        'latest_plan', (
          select jsonb_build_object(
                   'stage', lp.stage,
                   'status', lp.status,
                   'rent_amount', lp.rent_amount,
                   'duration_days', lp.duration_days,
                   'daily_repayment', lp.daily_repayment,
                   'plan_total', lp.plan_total,
                   'recorded_repaid', coalesce(lp.amount_repaid, 0),
                   'plan_balance', greatest(lp.plan_total - coalesce(lp.amount_repaid, 0), 0),
                   'funded_on', lp.funded_at::date,
                   'repayment_starts_on', lp.repayment_starts_on,
                   'repayment_frequency', lp.repayment_frequency,
                   'tenancy_status', lp.tenancy_status)
            from plans lp
           where lp.tenant_id = pg.id and (v_plan = 'all' or lp.stage = v_plan)
           order by lp.created_at desc limit 1),
        'collected_in_period', jsonb_build_object(
          'amount', coalesce((select c.total from cash c where c.tenant_id = pg.id), 0),
          'count',  coalesce((select c.n from cash c where c.tenant_id = pg.id), 0))
      ) order by pg.full_name nulls last)
      from page pg), '[]'::jsonb)
  ) into v_result;

  return v_result;
end;
$$;

-- ---------------------------------------------------------------------------
-- One tenant in full: profile, Rent Plans, landlord, the agent's own collections
-- ---------------------------------------------------------------------------
create or replace function public.assistant_agent_tenant_detail(
  p_search text,
  p_from   date default null,
  p_to     date default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid    uuid := auth.uid();
  v_today  date := (now() at time zone 'Africa/Kampala')::date;
  v_to     date := coalesce(p_to, v_today);
  v_from   date := coalesce(p_from, coalesce(p_to, v_today) - 29);
  -- Plain timestamp bounds (Kampala midnight to midnight) so the collections index can be used.
  v_from_ts timestamptz := v_from::timestamp at time zone 'Africa/Kampala';
  v_to_ts   timestamptz := (v_to + 1)::timestamp at time zone 'Africa/Kampala';
  v_term   text := nullif(btrim(left(coalesce(p_search, ''), 40)), '');
  v_words  text[];
  v_digits text;
  v_result jsonb;
begin
  perform public.assistant_require_agent();

  if v_term is null then
    raise exception 'search_required' using errcode = '22023';
  end if;
  if v_from > v_to or v_to - v_from > 92 or v_to > v_today then
    raise exception 'invalid_range' using errcode = '22023';
  end if;
  if v_term !~ '^[[:alnum:] .''+-]+$' then
    raise exception 'invalid_search' using errcode = '22023';
  end if;

  v_words := array(
    select '%' || replace(replace(replace(w, '\', '\\'), '%', '\%'), '_', '\_') || '%'
      from unnest(string_to_array(v_term, ' ')) w
     where w <> '');
  v_digits := nullif(regexp_replace(v_term, '\D', '', 'g'), '');

  with my_tenants as (
    select rr.tenant_id from public.rent_requests rr
     where rr.tenant_id is not null and rr.status <> 'deleted_by_agent'
       and (rr.agent_id = v_uid or rr.assigned_agent_id = v_uid)
    union
    select ac.tenant_id from public.agent_collections ac
     where ac.tenant_id is not null and ac.agent_id = v_uid
       and ac.reversed_at is null and ac.amount > 0
  ),
  matches as (
    select p.id, p.full_name, p.phone, p.email, p.created_at, p.verified, p.monthly_rent, p.tenant_status,
           p.village, p.parish, p.sub_county, p.district, p.region, p.town
      from public.profiles p
      join my_tenants t on t.tenant_id = p.id
     where p.deleted_at is null
       and (p.full_name ilike all (v_words)
            or (v_digits is not null and length(v_digits) >= 4
                and regexp_replace(coalesce(p.phone, ''), '\D', '', 'g') like '%' || v_digits || '%'))
  ),
  top3 as (
    select * from matches order by full_name nulls last, id limit 3
  )
  select jsonb_build_object(
    'search', v_term,
    'period', jsonb_build_object('from', v_from, 'to', v_to),
    'match_count', (select count(*) from matches),
    'tenants', coalesce((
      select jsonb_agg(jsonb_build_object(
        'name',    public.assistant_clean_text(t.full_name, 80),
        'phone',   public.assistant_clean_phone(t.phone),
        'email',   public.assistant_real_email(t.email),
        'has_email', (public.assistant_real_email(t.email) is not null),
        'joined',  t.created_at::date,
        'verified', coalesce(t.verified, false),
        'monthly_rent', t.monthly_rent,
        'tenant_status', public.assistant_clean_text(t.tenant_status, 30),
        'location', jsonb_strip_nulls(jsonb_build_object(
          'village',    public.assistant_clean_text(t.village, 60),
          'parish',     public.assistant_clean_text(t.parish, 60),
          'sub_county', public.assistant_clean_text(t.sub_county, 60),
          'district',   public.assistant_clean_text(t.district, 60),
          'region',     public.assistant_clean_text(t.region, 60),
          'town',       public.assistant_clean_text(t.town, 60))),
        'rent_plans_total', (
          select count(*) from public.rent_requests rr
           where rr.tenant_id = t.id and rr.status <> 'deleted_by_agent'
             and (rr.agent_id = v_uid or rr.assigned_agent_id = v_uid)),
        'rent_plans', coalesce((
          select jsonb_agg(plan_row order by plan_created desc)
            from (
              select rr.created_at as plan_created,
                     jsonb_build_object(
                       'stage', case when rr.status in ('funded', 'repaying', 'disbursed', 'active') then 'active'
                                     when rr.status = 'completed' then 'completed'
                                     when rr.status = 'rejected' then 'rejected'
                                     when rr.status = 'cancelled' then 'cancelled'
                                     else 'in_review' end,
                       'status', rr.status,
                       'rent_amount', rr.rent_amount,
                       'duration_days', rr.duration_days,
                       'access_fee', rr.access_fee,
                       'request_fee', rr.request_fee,
                       'daily_repayment', rr.daily_repayment,
                       'plan_total', case when rr.registration_type = 'outstanding_balance'
                                          then coalesce(nullif(rr.initial_outstanding_balance, 0), rr.total_repayment, 0)
                                          else coalesce(rr.total_repayment, 0) end,
                       'recorded_repaid', coalesce(rr.amount_repaid, 0),
                       'plan_balance', greatest((case when rr.registration_type = 'outstanding_balance'
                                                      then coalesce(nullif(rr.initial_outstanding_balance, 0), rr.total_repayment, 0)
                                                      else coalesce(rr.total_repayment, 0) end) - coalesce(rr.amount_repaid, 0), 0),
                       'requested_on', rr.created_at::date,
                       'funded_on', rr.funded_at::date,
                       'disbursed_on', rr.disbursed_at::date,
                       'repayment_starts_on', rr.repayment_starts_on,
                       'repayment_frequency', rr.repayment_frequency,
                       'tenancy_status', rr.tenancy_status,
                       'tenancy_ended_on', rr.tenancy_ended_at::date,
                       'landlord', (
                         select jsonb_build_object(
                                  'name',  public.assistant_clean_text(l.name, 80),
                                  'phone', public.assistant_clean_phone(l.phone),
                                  'property_address', public.assistant_clean_text(l.property_address, 120, true))
                           from public.landlords l where l.id = rr.landlord_id)
                     ) as plan_row
                from public.rent_requests rr
               where rr.tenant_id = t.id and rr.status <> 'deleted_by_agent'
                 and (rr.agent_id = v_uid or rr.assigned_agent_id = v_uid)
               order by rr.created_at desc
               limit 5
            ) q), '[]'::jsonb),
        'my_collections', (
          select jsonb_build_object(
                   'total', coalesce(sum(ac.amount), 0),
                   'count', count(*),
                   'partial_payments', count(*) filter (where ac.is_partial),
                   'last_collected_on', max((ac.created_at at time zone 'Africa/Kampala')::date),
                   'recent', coalesce((
                     select jsonb_agg(jsonb_build_object('date', d, 'amount', amt) order by d desc)
                       from (select (a2.created_at at time zone 'Africa/Kampala')::date as d, a2.amount as amt
                               from public.agent_collections a2
                              where a2.agent_id = v_uid and a2.tenant_id = t.id
                                and a2.reversed_at is null and a2.amount > 0
                                and a2.created_at >= v_from_ts and a2.created_at < v_to_ts
                              order by a2.created_at desc limit 5) r), '[]'::jsonb))
            from public.agent_collections ac
           where ac.agent_id = v_uid and ac.tenant_id = t.id
             and ac.reversed_at is null and ac.amount > 0
             and ac.created_at >= v_from_ts and ac.created_at < v_to_ts)
      ) order by t.full_name nulls last)
      from top3 t), '[]'::jsonb)
  ) into v_result;

  return v_result;
end;
$$;

-- ---------------------------------------------------------------------------
-- Landlords of the agent's tenants
-- ---------------------------------------------------------------------------
create or replace function public.assistant_agent_landlords(
  p_search text default null,
  p_limit  integer default 15
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid    uuid := auth.uid();
  v_limit  integer := least(greatest(coalesce(p_limit, 15), 1), 25);
  v_term   text := nullif(btrim(left(coalesce(p_search, ''), 40)), '');
  v_words  text[];
  v_digits text;
  v_result jsonb;
begin
  perform public.assistant_require_agent();

  if v_term is not null and v_term !~ '^[[:alnum:] .''+-]+$' then
    raise exception 'invalid_search' using errcode = '22023';
  end if;
  v_words := array(
    select '%' || replace(replace(replace(w, '\', '\\'), '%', '\%'), '_', '\_') || '%'
      from unnest(string_to_array(coalesce(v_term, ''), ' ')) w
     where w <> '');
  v_digits := nullif(regexp_replace(coalesce(v_term, ''), '\D', '', 'g'), '');

  with mine as (
    select l.id, l.name, l.phone, l.property_address, l.verified,
           count(distinct rr.tenant_id) as tenants_count,
           count(*) as plans_count
      from public.rent_requests rr
      join public.landlords l on l.id = rr.landlord_id
     where rr.status <> 'deleted_by_agent'
       and (rr.agent_id = v_uid or rr.assigned_agent_id = v_uid)
       and (cardinality(v_words) = 0
            or l.name ilike all (v_words)
            or (v_digits is not null and length(v_digits) >= 4
                and regexp_replace(coalesce(l.phone, ''), '\D', '', 'g') like '%' || v_digits || '%'))
     group by l.id, l.name, l.phone, l.property_address, l.verified
  ),
  page as (select * from mine order by name nulls last, id limit v_limit)
  select jsonb_build_object(
    'search', v_term,
    'total_matching', (select count(*) from mine),
    'returned', (select count(*) from page),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'name', public.assistant_clean_text(g.name, 80),
        'phone', public.assistant_clean_phone(g.phone),
        'property_address', public.assistant_clean_text(g.property_address, 120, true),
        'verified', coalesce(g.verified, false),
        'my_tenants_here', g.tenants_count,
        'my_rent_plans_here', g.plans_count) order by g.name nulls last)
      from page g), '[]'::jsonb)
  ) into v_result;

  return v_result;
end;
$$;

-- ---------------------------------------------------------------------------
-- Sub-agents (direct, verified): who they are and what they collected
-- ---------------------------------------------------------------------------
create or replace function public.assistant_agent_subagents(
  p_search text default null,
  p_from   date default null,
  p_to     date default null,
  p_limit  integer default 15,
  p_email  text default 'any'
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid    uuid := auth.uid();
  v_today  date := (now() at time zone 'Africa/Kampala')::date;
  v_to     date := coalesce(p_to, v_today);
  v_from   date := coalesce(p_from, coalesce(p_to, v_today) - 29);
  -- Plain timestamp bounds (Kampala midnight to midnight) so the collections index can be used.
  v_from_ts timestamptz := v_from::timestamp at time zone 'Africa/Kampala';
  v_to_ts   timestamptz := (v_to + 1)::timestamp at time zone 'Africa/Kampala';
  v_limit  integer := least(greatest(coalesce(p_limit, 15), 1), 25);
  v_email  text := lower(coalesce(nullif(btrim(p_email), ''), 'any'));
  v_term   text := nullif(btrim(left(coalesce(p_search, ''), 40)), '');
  v_words  text[];
  v_digits text;
  v_result jsonb;
begin
  perform public.assistant_require_agent();

  if v_from > v_to or v_to - v_from > 92 or v_to > v_today then
    raise exception 'invalid_range' using errcode = '22023';
  end if;
  if v_email not in ('any', 'missing', 'present') then
    raise exception 'invalid_email_filter' using errcode = '22023';
  end if;
  if v_term is not null and v_term !~ '^[[:alnum:] .''+-]+$' then
    raise exception 'invalid_search' using errcode = '22023';
  end if;
  v_words := array(
    select '%' || replace(replace(replace(w, '\', '\\'), '%', '\%'), '_', '\_') || '%'
      from unnest(string_to_array(coalesce(v_term, ''), ' ')) w
     where w <> '');
  v_digits := nullif(regexp_replace(coalesce(v_term, ''), '\D', '', 'g'), '');

  with subs as (
    select sa.sub_agent_id, min(coalesce(sa.verified_at, sa.accepted_at, sa.created_at)) as linked_at
      from public.agent_subagents sa
     where sa.parent_agent_id = v_uid and sa.status = 'verified'
     group by sa.sub_agent_id
  ),
  people as (
    select s.sub_agent_id, s.linked_at, p.full_name, p.phone, p.email, p.district, p.region
      from subs s
      join public.profiles p on p.id = s.sub_agent_id and p.deleted_at is null
     where cardinality(v_words) = 0
        or p.full_name ilike all (v_words)
        or (v_digits is not null and length(v_digits) >= 4
            and regexp_replace(coalesce(p.phone, ''), '\D', '', 'g') like '%' || v_digits || '%')
  ),
  cash as (
    select ac.agent_id as sub_agent_id, sum(ac.amount) as total, count(*) as n,
           max((ac.created_at at time zone 'Africa/Kampala')::date) as last_on
      from public.agent_collections ac
     where ac.agent_id in (select sub_agent_id from people)
       and ac.reversed_at is null and ac.amount > 0
       and ac.created_at >= v_from_ts and ac.created_at < v_to_ts
     group by ac.agent_id
  ),
  -- Everyone matching the search, WITH or WITHOUT an email on file. The email filter below only
  -- narrows this on request; nobody is ever dropped for lacking an email.
  ranked as (
    select pe.*, coalesce(c.total, 0) as collected, coalesce(c.n, 0) as collections, c.last_on,
           (public.assistant_real_email(pe.email) is not null) as has_email
      from people pe left join cash c using (sub_agent_id)
  ),
  ranked_f as (
    select * from ranked
     where v_email = 'any' or (v_email = 'present') = has_email
  ),
  page as (
    select * from ranked_f order by collected desc, full_name nulls last, sub_agent_id limit v_limit
  )
  select jsonb_build_object(
    'search', v_term,
    'email_filter', v_email,
    'period', jsonb_build_object('from', v_from, 'to', v_to),
    'sub_agents_verified_total', (select count(*) from subs),
    'sub_agents_pending', (select count(*) from public.agent_subagents sa where sa.parent_agent_id = v_uid and sa.status = 'pending_acceptance'),
    'total_matching', (select count(*) from ranked_f),
    'email_summary', jsonb_build_object(
      'with_email',    (select count(*) from ranked where has_email),
      'without_email', (select count(*) from ranked where not has_email)),
    'collected_by_matching', coalesce((select sum(collected) from ranked_f), 0),
    'collections_by_matching', coalesce((select sum(collections) from ranked_f), 0),
    'active_matching', (select count(*) from ranked_f where collections > 0),
    'returned', (select count(*) from page),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'name', public.assistant_clean_text(g.full_name, 80),
        'phone', public.assistant_clean_phone(g.phone),
        'email', public.assistant_real_email(g.email),
        'has_email', g.has_email,
        'district', public.assistant_clean_text(g.district, 60),
        'region', public.assistant_clean_text(g.region, 60),
        'linked_since', g.linked_at::date,
        'collected_in_period', g.collected,
        'collections_in_period', g.collections,
        'last_collection_on', g.last_on,
        'tenants_count', (
          select count(*) from (
            select rr.tenant_id from public.rent_requests rr
             where rr.tenant_id is not null and rr.status <> 'deleted_by_agent'
               and (rr.agent_id = g.sub_agent_id or rr.assigned_agent_id = g.sub_agent_id)
            union
            select ac.tenant_id from public.agent_collections ac
             where ac.tenant_id is not null and ac.agent_id = g.sub_agent_id
               and ac.reversed_at is null and ac.amount > 0) tt)
      ) order by g.collected desc, g.full_name nulls last)
      from page g), '[]'::jsonb)
  ) into v_result;

  return v_result;
end;
$$;

-- ---------------------------------------------------------------------------
-- One sub-agent: profile, collections, tenants
-- ---------------------------------------------------------------------------
create or replace function public.assistant_agent_subagent_detail(
  p_search text,
  p_from   date default null,
  p_to     date default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid    uuid := auth.uid();
  v_today  date := (now() at time zone 'Africa/Kampala')::date;
  v_to     date := coalesce(p_to, v_today);
  v_from   date := coalesce(p_from, coalesce(p_to, v_today) - 29);
  -- Plain timestamp bounds (Kampala midnight to midnight) so the collections index can be used.
  v_from_ts timestamptz := v_from::timestamp at time zone 'Africa/Kampala';
  v_to_ts   timestamptz := (v_to + 1)::timestamp at time zone 'Africa/Kampala';
  v_term   text := nullif(btrim(left(coalesce(p_search, ''), 40)), '');
  v_words  text[];
  v_digits text;
  v_result jsonb;
begin
  perform public.assistant_require_agent();

  if v_term is null then
    raise exception 'search_required' using errcode = '22023';
  end if;
  if v_from > v_to or v_to - v_from > 92 or v_to > v_today then
    raise exception 'invalid_range' using errcode = '22023';
  end if;
  if v_term !~ '^[[:alnum:] .''+-]+$' then
    raise exception 'invalid_search' using errcode = '22023';
  end if;
  v_words := array(
    select '%' || replace(replace(replace(w, '\', '\\'), '%', '\%'), '_', '\_') || '%'
      from unnest(string_to_array(v_term, ' ')) w
     where w <> '');
  v_digits := nullif(regexp_replace(v_term, '\D', '', 'g'), '');

  with subs as (
    select sa.sub_agent_id, min(coalesce(sa.verified_at, sa.accepted_at, sa.created_at)) as linked_at
      from public.agent_subagents sa
     where sa.parent_agent_id = v_uid and sa.status = 'verified'
     group by sa.sub_agent_id
  ),
  matches as (
    select s.sub_agent_id, s.linked_at, p.full_name, p.phone, p.email, p.district, p.region, p.occupation, p.created_at
      from subs s
      join public.profiles p on p.id = s.sub_agent_id and p.deleted_at is null
     where p.full_name ilike all (v_words)
        or (v_digits is not null and length(v_digits) >= 4
            and regexp_replace(coalesce(p.phone, ''), '\D', '', 'g') like '%' || v_digits || '%')
  ),
  top3 as (select * from matches order by full_name nulls last, sub_agent_id limit 3)
  select jsonb_build_object(
    'search', v_term,
    'period', jsonb_build_object('from', v_from, 'to', v_to),
    'match_count', (select count(*) from matches),
    'sub_agents', coalesce((
      select jsonb_agg(jsonb_build_object(
        'name',  public.assistant_clean_text(m.full_name, 80),
        'phone', public.assistant_clean_phone(m.phone),
        'email', public.assistant_real_email(m.email),
        'has_email', (public.assistant_real_email(m.email) is not null),
        'district', public.assistant_clean_text(m.district, 60),
        'region', public.assistant_clean_text(m.region, 60),
        'occupation', public.assistant_clean_text(m.occupation, 60),
        'joined', m.created_at::date,
        'linked_since', m.linked_at::date,
        'collections', (
          select jsonb_build_object(
                   'total', coalesce(sum(ac.amount), 0),
                   'count', count(*),
                   'last_collected_on', max((ac.created_at at time zone 'Africa/Kampala')::date),
                   'by_day', case when v_to - v_from <= 30 then coalesce((
                       select jsonb_agg(jsonb_build_object('date', d, 'collected', amt) order by d)
                         from (select (a2.created_at at time zone 'Africa/Kampala')::date as d, sum(a2.amount) as amt
                                 from public.agent_collections a2
                                where a2.agent_id = m.sub_agent_id and a2.reversed_at is null and a2.amount > 0
                                  and a2.created_at >= v_from_ts and a2.created_at < v_to_ts
                                group by 1) x), '[]'::jsonb) else '[]'::jsonb end)
            from public.agent_collections ac
           where ac.agent_id = m.sub_agent_id and ac.reversed_at is null and ac.amount > 0
             and ac.created_at >= v_from_ts and ac.created_at < v_to_ts),
        'tenants_count', (
          select count(*) from (
            select rr.tenant_id from public.rent_requests rr
             where rr.tenant_id is not null and rr.status <> 'deleted_by_agent'
               and (rr.agent_id = m.sub_agent_id or rr.assigned_agent_id = m.sub_agent_id)
            union
            select ac.tenant_id from public.agent_collections ac
             where ac.tenant_id is not null and ac.agent_id = m.sub_agent_id
               and ac.reversed_at is null and ac.amount > 0) tt),
        'tenants', coalesce((
          select jsonb_agg(jsonb_build_object(
                   'name', public.assistant_clean_text(tp.full_name, 80),
                   'phone', public.assistant_clean_phone(tp.phone)) order by tp.full_name nulls last)
            from (
              select p2.full_name, p2.phone
                from public.profiles p2
               where p2.deleted_at is null
                 and p2.id in (
                   select rr.tenant_id from public.rent_requests rr
                    where rr.tenant_id is not null and rr.status <> 'deleted_by_agent'
                      and (rr.agent_id = m.sub_agent_id or rr.assigned_agent_id = m.sub_agent_id)
                   union
                   select ac.tenant_id from public.agent_collections ac
                    where ac.tenant_id is not null and ac.agent_id = m.sub_agent_id
                      and ac.reversed_at is null and ac.amount > 0)
               order by p2.full_name nulls last limit 25) tp), '[]'::jsonb)
      ) order by m.full_name nulls last)
      from top3 m), '[]'::jsonb)
  ) into v_result;

  return v_result;
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants: authenticated + service_role only; never PUBLIC / anon.
-- ---------------------------------------------------------------------------
revoke execute on function public.assistant_agent_my_profile() from public, anon;
grant  execute on function public.assistant_agent_my_profile() to authenticated, service_role;

revoke execute on function public.assistant_agent_tenants() from public, anon;
grant  execute on function public.assistant_agent_tenants() to authenticated, service_role;

revoke execute on function public.assistant_agent_find_tenants(text, text, date, date, integer, text) from public, anon;
grant  execute on function public.assistant_agent_find_tenants(text, text, date, date, integer, text) to authenticated, service_role;

revoke execute on function public.assistant_agent_tenant_detail(text, date, date) from public, anon;
grant  execute on function public.assistant_agent_tenant_detail(text, date, date) to authenticated, service_role;

revoke execute on function public.assistant_agent_landlords(text, integer) from public, anon;
grant  execute on function public.assistant_agent_landlords(text, integer) to authenticated, service_role;

revoke execute on function public.assistant_agent_subagents(text, date, date, integer, text) from public, anon;
grant  execute on function public.assistant_agent_subagents(text, date, date, integer, text) to authenticated, service_role;

revoke execute on function public.assistant_agent_subagent_detail(text, date, date) from public, anon;
grant  execute on function public.assistant_agent_subagent_detail(text, date, date) to authenticated, service_role;
