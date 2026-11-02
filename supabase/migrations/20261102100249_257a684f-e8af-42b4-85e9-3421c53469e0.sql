-- Agent assistant, step 2: team, sub-agent tenants and Rent Plans, league standing, house
-- listings and landlord float status.
--
-- Same model as the earlier tools: read-only, STABLE, SECURITY DEFINER, identity from auth.uid()
-- and NEVER a parameter, every function starts with assistant_require_agent(), every column that
-- leaves the database is on an explicit whitelist (no `select *`), search strings are validated
-- and only FILTER inside the signed-in agent's own set.
--
-- Network scope: DIRECT, VERIFIED sub-agents only (agent_subagents.status = 'verified' with
-- parent_agent_id = the caller). A sub-agent's tenants are visible as names, Rent Plan status and
-- amounts, but NEVER their phone, email, location or national ID.
--
-- League standing uses the same source and the same public fields as the in-app league
-- leaderboard: other teams appear only as "Team <first name>" with a performance percentage, never
-- with amounts. Only the caller's own team shows expected / collected figures.
--
-- Landlord float: status per allocation and per payout (paid, awaiting the agent's receipt, failed,
-- returned). Receipts, receipt numbers, receipt images, payout references, mobile-money numbers
-- and landlord phone numbers are never returned.
--
-- Houses: the agent's own listings only. No caretaker or LC1 details, no coordinates, no photos.

-- ---------------------------------------------------------------------------
-- Team summary: who in my team is active, who has gone quiet
-- ---------------------------------------------------------------------------
create or replace function public.assistant_agent_team_summary(
  p_from  date default null,
  p_to    date default null,
  p_limit integer default 10
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid     uuid := auth.uid();
  v_today   date := (now() at time zone 'Africa/Kampala')::date;
  v_to      date := coalesce(p_to, v_today);
  v_from    date := coalesce(p_from, coalesce(p_to, v_today) - 6);
  v_from_ts timestamptz := v_from::timestamp at time zone 'Africa/Kampala';
  v_to_ts   timestamptz := (v_to + 1)::timestamp at time zone 'Africa/Kampala';
  v_limit   integer := least(greatest(coalesce(p_limit, 10), 1), 25);
  v_result  jsonb;
begin
  perform public.assistant_require_agent();

  if v_from > v_to or v_to - v_from > 92 or v_to > v_today then
    raise exception 'invalid_range' using errcode = '22023';
  end if;

  with subs as (
    select sa.sub_agent_id
      from public.agent_subagents sa
     where sa.parent_agent_id = v_uid and sa.status = 'verified'
     group by sa.sub_agent_id
  ),
  people as (
    select s.sub_agent_id, p.full_name
      from subs s
      join public.profiles p on p.id = s.sub_agent_id and p.deleted_at is null
  ),
  cash as (
    select ac.agent_id as sub_agent_id, sum(ac.amount) as total, count(*) as n
      from public.agent_collections ac
     where ac.agent_id in (select sub_agent_id from people)
       and ac.reversed_at is null and ac.amount > 0
       and ac.created_at >= v_from_ts and ac.created_at < v_to_ts
     group by ac.agent_id
  ),
  ranked as (
    select pe.sub_agent_id, pe.full_name,
           coalesce(c.total, 0) as collected, coalesce(c.n, 0) as collections
      from people pe left join cash c using (sub_agent_id)
  ),
  quiet as (
    select r.*,
           (select max((a2.created_at at time zone 'Africa/Kampala')::date)
              from public.agent_collections a2
             where a2.agent_id = r.sub_agent_id and a2.reversed_at is null and a2.amount > 0) as last_on
      from ranked r
     where r.collections = 0
     order by r.full_name nulls last
     limit v_limit
  )
  select jsonb_build_object(
    'period', jsonb_build_object('from', v_from, 'to', v_to),
    'sub_agents_verified_total', (select count(*) from subs),
    'sub_agents_live_accounts',  (select count(*) from people),
    'active_in_period',          (select count(*) from ranked where collections > 0),
    'quiet_in_period',           (select count(*) from ranked where collections = 0),
    'team_collected',            coalesce((select sum(collected) from ranked), 0),
    'team_collections',          coalesce((select sum(collections) from ranked), 0),
    'my_collected', coalesce((
        select sum(ac.amount) from public.agent_collections ac
         where ac.agent_id = v_uid and ac.reversed_at is null and ac.amount > 0
           and ac.created_at >= v_from_ts and ac.created_at < v_to_ts), 0),
    'top', coalesce((
      select jsonb_agg(jsonb_build_object(
               'name', public.assistant_clean_text(t.full_name, 80),
               'collected', t.collected, 'collections', t.collections) order by t.collected desc, t.full_name nulls last)
        from (select * from ranked where collections > 0 order by collected desc, full_name nulls last limit 5) t), '[]'::jsonb),
    'quiet_examples', coalesce((
      select jsonb_agg(jsonb_build_object(
               'name', public.assistant_clean_text(q.full_name, 80),
               'last_collection_on', q.last_on) order by q.full_name nulls last)
        from quiet q), '[]'::jsonb)
  ) into v_result;

  return v_result;
end;
$$;

-- ---------------------------------------------------------------------------
-- A sub-agent's tenants and their Rent Plans (names, status, amounts; no contacts)
-- ---------------------------------------------------------------------------
create or replace function public.assistant_agent_subagent_tenants(
  p_search text,
  p_plan   text default 'all',
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
  v_plan   text := lower(coalesce(nullif(btrim(p_plan), ''), 'all'));
  v_term   text := nullif(btrim(left(coalesce(p_search, ''), 40)), '');
  v_words  text[];
  v_digits text;
  v_sub    uuid;
  v_matches integer;
  v_result jsonb;
begin
  perform public.assistant_require_agent();

  if v_term is null then
    raise exception 'search_required' using errcode = '22023';
  end if;
  if v_term !~ '^[[:alnum:] .''+-]+$' then
    raise exception 'invalid_search' using errcode = '22023';
  end if;
  if v_plan not in ('all', 'active', 'in_review', 'completed') then
    raise exception 'invalid_plan' using errcode = '22023';
  end if;
  v_words := array(
    select '%' || replace(replace(replace(w, '\', '\\'), '%', '\%'), '_', '\_') || '%'
      from unnest(string_to_array(v_term, ' ')) w
     where w <> '');
  v_digits := nullif(regexp_replace(v_term, '\D', '', 'g'), '');

  -- Which of MY direct verified sub-agents does the search name?
  with subs as (
    select sa.sub_agent_id from public.agent_subagents sa
     where sa.parent_agent_id = v_uid and sa.status = 'verified'
     group by sa.sub_agent_id
  ),
  m as (
    select p.id, p.full_name
      from subs s join public.profiles p on p.id = s.sub_agent_id and p.deleted_at is null
     where p.full_name ilike all (v_words)
        or (v_digits is not null and length(v_digits) >= 4
            and regexp_replace(coalesce(p.phone, ''), '\D', '', 'g') like '%' || v_digits || '%')
  )
  select count(*), (array_agg(id order by full_name nulls last, id))[1] into v_matches, v_sub from m;

  if v_matches = 0 then
    return jsonb_build_object('search', v_term, 'match_count', 0);
  end if;
  if v_matches > 1 then
    -- More than one person: names only, so the agent can say which one they mean.
    return jsonb_build_object(
      'search', v_term, 'match_count', v_matches,
      'sub_agents', coalesce((
        select jsonb_agg(jsonb_build_object('name', public.assistant_clean_text(x.full_name, 80)) order by x.full_name nulls last)
          from (
            select p.full_name
              from public.agent_subagents sa
              join public.profiles p on p.id = sa.sub_agent_id and p.deleted_at is null
             where sa.parent_agent_id = v_uid and sa.status = 'verified'
               and (p.full_name ilike all (v_words)
                    or (v_digits is not null and length(v_digits) >= 4
                        and regexp_replace(coalesce(p.phone, ''), '\D', '', 'g') like '%' || v_digits || '%'))
             group by p.id, p.full_name
             order by p.full_name nulls last limit 5) x), '[]'::jsonb));
  end if;

  with sub_tenants as (
    select rr.tenant_id from public.rent_requests rr
     where rr.tenant_id is not null and rr.status <> 'deleted_by_agent'
       and (rr.agent_id = v_sub or rr.assigned_agent_id = v_sub)
    union
    select ac.tenant_id from public.agent_collections ac
     where ac.tenant_id is not null and ac.agent_id = v_sub
       and ac.reversed_at is null and ac.amount > 0
  ),
  base as (
    select p.id, p.full_name
      from public.profiles p join sub_tenants t on t.tenant_id = p.id
     where p.deleted_at is null
  ),
  plans as (
    select rr.tenant_id, rr.created_at, rr.status, rr.rent_amount, rr.duration_days, rr.daily_repayment,
           rr.amount_repaid, rr.funded_at, rr.repayment_starts_on, rr.tenancy_status,
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
       and (rr.agent_id = v_sub or rr.assigned_agent_id = v_sub)
  ),
  filtered as (
    select b.* from base b
     where v_plan = 'all' or exists (select 1 from plans pf where pf.tenant_id = b.id and pf.stage = v_plan)
  ),
  page as (select f.* from filtered f order by f.full_name nulls last, f.id limit v_limit)
  select jsonb_build_object(
    'search', v_term,
    'match_count', 1,
    'sub_agent', (select public.assistant_clean_text(p.full_name, 80) from public.profiles p where p.id = v_sub),
    'plan_filter', v_plan,
    'tenants_total', (select count(*) from base),
    'total_matching', (select count(*) from filtered),
    'returned', (select count(*) from page),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'name', public.assistant_clean_text(pg.full_name, 80),
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
                   'tenancy_status', lp.tenancy_status)
            from plans lp
           where lp.tenant_id = pg.id and (v_plan = 'all' or lp.stage = v_plan)
           order by lp.created_at desc limit 1)
      ) order by pg.full_name nulls last)
      from page pg), '[]'::jsonb)
  ) into v_result;

  return v_result;
end;
$$;

-- ---------------------------------------------------------------------------
-- League standing: my team's rank and the top teams, as the in-app leaderboard shows them
-- ---------------------------------------------------------------------------
create or replace function public.assistant_agent_leaderboard(
  p_week_start date default null
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
  v_this   date := public.agent_league_week_start(now());
  v_week   date;
  v_parent uuid;
  v_result jsonb;
begin
  perform public.assistant_require_agent();

  v_week := case when p_week_start is null then v_this
                 else public.agent_league_week_start((p_week_start::timestamp at time zone 'Africa/Kampala')) end;
  if v_week > v_this or v_week < v_this - 84 then
    raise exception 'invalid_range' using errcode = '22023';
  end if;

  v_parent := public.agent_league_team_parent(v_uid);

  with ranks as (select * from public.agent_league_week_ranks(v_week))
  select jsonb_build_object(
    'week_start', v_week,
    'week_in_progress', (v_week = v_this),
    'total_teams', (select count(*) from ranks),
    'my_team', (
      select jsonb_build_object(
               'rank', r.team_rank,
               'performance_percent', r.performance,
               'expected', r.expected_amount,
               'collected', r.collected_amount,
               'active_rate_percent', r.active_rate,
               'members', r.total_members,
               'active_collectors', r.active_collectors,
               'days_at_80_percent', r.consistency,
               'is_team_leader', (v_parent = v_uid))
        from ranks r where r.parent_agent_id = v_parent),
    'top_teams', coalesce((
      select jsonb_agg(jsonb_build_object(
               'rank', t.team_rank,
               'team', 'Team ' || coalesce(nullif(split_part(coalesce(pr.full_name, ''), ' ', 1), ''), 'Welile'),
               'performance_percent', t.performance,
               'is_my_team', (t.parent_agent_id = v_parent)) order by t.team_rank)
        from (select * from ranks order by team_rank limit 5) t
        left join public.profiles pr on pr.id = t.parent_agent_id), '[]'::jsonb)
  ) into v_result;

  return v_result;
end;
$$;

-- ---------------------------------------------------------------------------
-- My house listings
-- ---------------------------------------------------------------------------
create or replace function public.assistant_agent_houses(
  p_search text default null,
  p_status text default 'all',
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
  v_status text := lower(coalesce(nullif(btrim(p_status), ''), 'all'));
  v_term   text := nullif(btrim(left(coalesce(p_search, ''), 40)), '');
  v_words  text[];
  v_result jsonb;
begin
  perform public.assistant_require_agent();

  if v_status not in ('all', 'available', 'occupied', 'rejected', 'verified', 'unverified') then
    raise exception 'invalid_status' using errcode = '22023';
  end if;
  if v_term is not null and v_term !~ '^[[:alnum:] .''+-]+$' then
    raise exception 'invalid_search' using errcode = '22023';
  end if;
  v_words := array(
    select '%' || replace(replace(replace(w, '\', '\\'), '%', '\%'), '_', '\_') || '%'
      from unnest(string_to_array(coalesce(v_term, ''), ' ')) w
     where w <> '');

  with mine as (
    select h.id, h.title, h.house_category, h.number_of_rooms, h.monthly_rent, h.district, h.sub_county,
           h.village, h.status, coalesce(h.verified, false) as verified, h.verified_at, h.created_at,
           h.tenant_id, h.landlord_id, h.listed_bonus_paid, h.house_verified_bonus_paid
      from public.house_listings h
     where h.agent_id = v_uid
       and (cardinality(v_words) = 0
            or h.title ilike all (v_words) or h.district ilike all (v_words)
            or h.village ilike all (v_words) or h.sub_county ilike all (v_words))
       and (v_status = 'all'
            or (v_status in ('available', 'occupied', 'rejected') and h.status = v_status)
            or (v_status = 'verified' and coalesce(h.verified, false))
            or (v_status = 'unverified' and not coalesce(h.verified, false)))
  ),
  page as (select * from mine order by created_at desc, id limit v_limit)
  select jsonb_build_object(
    'search', v_term,
    'status_filter', v_status,
    'total_matching', (select count(*) from mine),
    'summary', jsonb_build_object(
      'available', (select count(*) from mine where status = 'available'),
      'occupied',  (select count(*) from mine where status = 'occupied'),
      'rejected',  (select count(*) from mine where status = 'rejected'),
      'verified',  (select count(*) from mine where verified)),
    'returned', (select count(*) from page),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'title', public.assistant_clean_text(g.title, 100),
        'category', public.assistant_clean_text(g.house_category, 40),
        'rooms', g.number_of_rooms,
        'monthly_rent', g.monthly_rent,
        'location', public.assistant_clean_text(concat_ws(', ', g.village, g.sub_county, g.district), 100, true),
        'status', g.status,
        'verified', g.verified,
        'verified_on', g.verified_at::date,
        'listed_on', g.created_at::date,
        'has_tenant', (g.tenant_id is not null),
        'landlord', (select public.assistant_clean_text(l.name, 80) from public.landlords l where l.id = g.landlord_id),
        'listing_bonus_paid', coalesce(g.listed_bonus_paid, false),
        'verification_bonus_paid', coalesce(g.house_verified_bonus_paid, false),
        'rejection_reason', case when g.status = 'rejected'
          then (select public.assistant_clean_text(rj.rejection_reason, 160)
                  from public.v_house_listing_latest_rejection rj where rj.listing_id = g.id) end
      ) order by g.created_at desc)
      from page g), '[]'::jsonb)
  ) into v_result;

  return v_result;
end;
$$;

-- ---------------------------------------------------------------------------
-- Landlord float status: was it paid, is it waiting on my receipt, did it fail, was it returned
-- ---------------------------------------------------------------------------
create or replace function public.assistant_agent_landlord_float(
  p_search text default null,
  p_status text default 'all',
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
  v_status text := lower(coalesce(nullif(btrim(p_status), ''), 'all'));
  v_term   text := nullif(btrim(left(coalesce(p_search, ''), 40)), '');
  v_words  text[];
  v_result jsonb;
begin
  perform public.assistant_require_agent();

  if v_status not in ('all', 'open', 'paid', 'returned', 'cancelled') then
    raise exception 'invalid_status' using errcode = '22023';
  end if;
  if v_term is not null and v_term !~ '^[[:alnum:] .''+-]+$' then
    raise exception 'invalid_search' using errcode = '22023';
  end if;
  v_words := array(
    select '%' || replace(replace(replace(w, '\', '\\'), '%', '\%'), '_', '\_') || '%'
      from unnest(string_to_array(coalesce(v_term, ''), ' ')) w
     where w <> '');

  with mine as (
    select a.id, a.landlord_id, a.landlord_name, a.tenant_id, a.allocated_amount, a.paid_out_amount,
           a.remaining_amount, a.created_at,
           case a.status when 'open' then 'open'
                         when 'fully_paid' then 'paid'
                         when 'return_pending' then 'returned'
                         when 'cancelled' then 'cancelled'
                         else 'open' end as state
      from public.agent_landlord_float_allocations a
     where a.agent_id = v_uid
       and (cardinality(v_words) = 0 or a.landlord_name ilike all (v_words))
  ),
  filtered as (select * from mine where v_status = 'all' or state = v_status),
  page as (select * from filtered order by created_at desc, id limit v_limit)
  select jsonb_build_object(
    'search', v_term,
    'status_filter', v_status,
    'float', (select jsonb_build_object(
                'recorded_balance', f.balance, 'total_funded', f.total_funded, 'total_paid_out', f.total_paid_out)
                from public.agent_landlord_float f where f.agent_id = v_uid limit 1),
    'summary', jsonb_build_object(
      'open',      (select count(*) from mine where state = 'open'),
      'paid',      (select count(*) from mine where state = 'paid'),
      'returned',  (select count(*) from mine where state = 'returned'),
      'cancelled', (select count(*) from mine where state = 'cancelled'),
      'open_remaining_total', coalesce((select sum(remaining_amount) from mine where state = 'open'), 0)),
    'total_matching', (select count(*) from filtered),
    'returned_rows', (select count(*) from page),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'landlord', public.assistant_clean_text(g.landlord_name, 80),
        'tenant', (select public.assistant_clean_text(p.full_name, 80) from public.profiles p where p.id = g.tenant_id and p.deleted_at is null),
        'allocated', g.allocated_amount,
        'paid_out', g.paid_out_amount,
        'remaining', g.remaining_amount,
        'state', g.state,
        'allocated_on', g.created_at::date,
        'payout', (
          select jsonb_build_object(
                   'state', case lp.status when 'completed' then 'paid'
                                           when 'awaiting_agent_receipt' then 'awaiting_your_receipt'
                                           when 'failed' then 'failed'
                                           when 'pending_merchant_payout' then 'being_processed'
                                           else 'in_progress' end,
                   'amount', lp.amount,
                   'paid_on', lp.disbursed_at::date)
            from public.landlord_payouts lp
           where lp.allocation_applied_id = g.id
           order by lp.created_at desc limit 1)
      ) order by g.created_at desc)
      from page g), '[]'::jsonb)
  ) into v_result;

  return v_result;
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants: authenticated + service_role only; never PUBLIC / anon.
-- ---------------------------------------------------------------------------
revoke execute on function public.assistant_agent_team_summary(date, date, integer) from public, anon;
grant  execute on function public.assistant_agent_team_summary(date, date, integer) to authenticated, service_role;

revoke execute on function public.assistant_agent_subagent_tenants(text, text, integer) from public, anon;
grant  execute on function public.assistant_agent_subagent_tenants(text, text, integer) to authenticated, service_role;

revoke execute on function public.assistant_agent_leaderboard(date) from public, anon;
grant  execute on function public.assistant_agent_leaderboard(date) to authenticated, service_role;

revoke execute on function public.assistant_agent_houses(text, text, integer) from public, anon;
grant  execute on function public.assistant_agent_houses(text, text, integer) to authenticated, service_role;

revoke execute on function public.assistant_agent_landlord_float(text, text, integer) from public, anon;
grant  execute on function public.assistant_agent_landlord_float(text, text, integer) to authenticated, service_role;