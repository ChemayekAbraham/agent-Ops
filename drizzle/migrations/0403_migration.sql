create or replace function public._cto_dossier_allowed() returns boolean language sql stable security definer set search_path=public as $$
  select exists(select 1 from user_roles where user_id=auth.uid() and role in ('cto','super_admin') and coalesce(enabled,true));
$$;

create or replace function public.cto_user_dossier_search(p_q text) returns jsonb language plpgsql stable security definer set search_path=public as $$
declare q text := trim(coalesce(p_q,'')); r jsonb;
begin
  if not _cto_dossier_allowed() then raise exception 'not authorized'; end if;
  if length(q) < 2 then return '[]'::jsonb; end if;
  select coalesce(jsonb_agg(x),'[]') into r from (
    select id, full_name, phone, email, avatar_url, 'WEL-'||upper(substr(replace(id::text,'-',''),1,6)) ai_id
    from profiles
    where full_name ilike '%'||q||'%' or phone ilike '%'||q||'%' or email ilike '%'||q||'%'
       or replace(id::text,'-','') ilike replace(lower(q),'wel-','')||'%'
    order by last_active_at desc nulls last limit 20) x;
  return r;
end $$;

create or replace function public.cto_user_dossier_profile(p_user uuid) returns jsonb language plpgsql stable security definer set search_path=public,auth as $$
declare r jsonb;
begin
  if not _cto_dossier_allowed() then raise exception 'not authorized'; end if;
  select jsonb_build_object(
    'profile', to_jsonb(p) - 'national_id_photo_path' - 'selfie_photo_path' - 'national_id_back_photo_path' - 'selfie_image_hash' - 'id_image_hash',
    'ai_id', 'WEL-'||upper(substr(replace(p.id::text,'-',''),1,6)),
    'roles', (select coalesce(jsonb_agg(jsonb_build_object('role',role,'enabled',coalesce(enabled,true))),'[]') from user_roles where user_id=p.id),
    'last_sign_in_at', (select last_sign_in_at from auth.users where id=p.id),
    'referral_count', (select count(*) from referrals where referrer_id=p.id),
    'contact_changes', (select coalesce(jsonb_agg(jsonb_build_object('field',field_name,'old',old_value,'new',new_value,'at',a.created_at,'by',cp.full_name) order by a.created_at desc),'[]')
        from profile_field_audit a left join profiles cp on cp.id=a.changed_by where a.user_id=p.id),
    'balances', (select to_jsonb(w) from v_user_wallet_strict w where w.user_id=p.id limit 1),
    'available', get_user_available_balance(p.id)
  ) into r from profiles p where p.id=p_user;
  return r;
end $$;

create or replace function public.cto_user_dossier_money(p_user uuid, p_category text default null, p_direction text default null, p_from date default null, p_to date default null, p_search text default null, p_offset int default 0) returns jsonb language plpgsql stable security definer set search_path=public as $$
declare r jsonb;
begin
  if not _cto_dossier_allowed() then raise exception 'not authorized'; end if;
  with legs as (
    select id, coalesce(transaction_date,created_at) at, amount, direction, category, description, reference_id, wallet_bucket, linked_party
    from general_ledger
    where user_id=p_user and ledger_scope='wallet'
      and classification is distinct from 'admin_correction' and category <> 'system_balance_correction'),
  f as (select * from legs where (p_category is null or category=p_category) and (p_direction is null or direction=p_direction)
      and (p_from is null or at::date>=p_from) and (p_to is null or at::date<=p_to)
      and (p_search is null or reference_id ilike '%'||p_search||'%' or description ilike '%'||p_search||'%'))
  select jsonb_build_object(
    'categories', (select coalesce(jsonb_agg(jsonb_build_object('category',category,'in',si,'out',so,'count',n) order by si+so desc),'[]') from (
        select category, sum(amount) filter (where direction='cash_in') si, sum(amount) filter (where direction='cash_out') so, count(*) n from legs group by category) c),
    'total', (select count(*) from f),
    'rows', (select coalesce(jsonb_agg(to_jsonb(x)),'[]') from (select * from f order by at desc limit 50 offset greatest(p_offset,0)) x)
  ) into r;
  return r;
end $$;

create or replace function public.cto_user_dossier_partner(p_user uuid) returns jsonb language plpgsql stable security definer set search_path=public as $$
declare r jsonb;
begin
  if not _cto_dossier_allowed() then raise exception 'not authorized'; end if;
  select jsonb_build_object(
    'counts', jsonb_build_object('total',(select count(*) from investor_portfolios where investor_id=p_user),
      'active',(select count(*) from investor_portfolios where investor_id=p_user and status='active'),
      'suspended',(select count(*) from investor_portfolios where investor_id=p_user and status in ('suspended','paused')),
      'deleted',(select count(distinct portfolio_id) from portfolio_change_log where partner_id=p_user and action='deleted')),
    'portfolios', (select coalesce(jsonb_agg(jsonb_build_object(
        'id',ip.id,'code',ip.portfolio_code,'status',ip.status,'amount',ip.investment_amount,'rate',ip.roi_percentage,
        'duration',ip.duration_months,'created_at',ip.created_at,'maturity_date',ip.maturity_date,'returns_earned',ip.total_roi_earned,
        'history',(select coalesce(jsonb_agg(jsonb_build_object('action',action,'fields',changed_fields,'before',before_values,'after',after_values,'at',changed_at,'by',cp.full_name) order by changed_at desc),'[]')
            from portfolio_change_log l left join profiles cp on cp.id=l.changed_by where l.portfolio_id=ip.id)
      ) order by ip.created_at desc),'[]') from investor_portfolios ip where ip.investor_id=p_user),
    'deleted', (select coalesce(jsonb_agg(jsonb_build_object('code',portfolio_code,'at',changed_at,'before',before_values)),'[]') from portfolio_change_log where partner_id=p_user and action='deleted'),
    'returns_withdrawals', (select coalesce(jsonb_agg(jsonb_build_object('at',coalesce(transaction_date,created_at),'amount',amount,'reference',reference_id) order by created_at desc),'[]')
        from general_ledger where user_id=p_user and ledger_scope='wallet' and direction='cash_out' and category ilike '%withdraw%' and classification is distinct from 'admin_correction')
  ) into r;
  return r;
end $$;

create or replace function public.cto_user_dossier_activity(p_user uuid) returns jsonb language plpgsql stable security definer set search_path=public,auth as $$
declare r jsonb;
begin
  if not _cto_dossier_allowed() then raise exception 'not authorized'; end if;
  with ev as (
    select 'account' grp, 'Joined' kind, created_at at, null::numeric amount, signup_channel detail from profiles where id=p_user
    union all select 'account','Last sign-in', last_sign_in_at, null, null from auth.users where id=p_user and last_sign_in_at is not null
    union all select 'account','Profile change', created_at, null, field_name from profile_field_audit where user_id=p_user
    union all select 'agent','House listed', created_at, monthly_rent, coalesce(title,address) from (select * from house_listings where agent_id=p_user order by created_at desc limit 300) h
    union all select 'agent','Tenant registered (Rent Plan)', created_at, rent_amount, status from (select * from rent_requests where agent_id=p_user order by created_at desc limit 300) a
    union all select 'agent','Collection', created_at, amount, coalesce(location_name, payment_method::text) from (select * from agent_collections where agent_id=p_user order by created_at desc limit 300) c
    union all select 'agent','Visit', checked_in_at, null, location_name from (select * from agent_visits where agent_id=p_user order by checked_in_at desc limit 300) v
    union all select 'tenant','Rent Plan', created_at, rent_amount, status from rent_requests where tenant_id=p_user
    union all select 'tenant','Repayment collected', created_at, amount, payment_method::text from (select * from agent_collections where tenant_id=p_user order by created_at desc limit 300) t
    union all select 'landlord','Property', l.created_at, l.monthly_rent, coalesce(l.property_address,'') from landlords l join profiles p on p.id=p_user where l.tenant_id=p_user or (p.phone is not null and l.phone=p.phone)
    union all select 'supporter','Deposit', created_at, amount, status from deposit_requests where user_id=p_user
    union all select 'supporter','Portfolio '||action, changed_at, null, portfolio_code from portfolio_change_log where partner_id=p_user
  ), devs as (
    select ua, min(at) first_seen, max(at) last_seen, count(*) n from (
      select user_agent ua, created_at at from general_ledger where user_id=p_user and user_agent is not null
      union all select request_user_agent, created_at from deposit_requests where user_id=p_user and request_user_agent is not null
      union all select user_agent, created_at from profile_field_audit where user_id=p_user and user_agent is not null) d group by ua)
  select jsonb_build_object(
    'counts', (select coalesce(jsonb_object_agg(grp,n),'{}') from (select grp,count(*) n from ev where at is not null group by grp) c),
    'events', (select coalesce(jsonb_agg(to_jsonb(e) order by e.at desc),'[]') from (select * from ev where at is not null order by at desc limit 1000) e),
    'devices', (select coalesce(jsonb_agg(to_jsonb(d) order by d.last_seen desc),'[]') from devs d)
  ) into r;
  return r;
end $$;

revoke all on function public._cto_dossier_allowed(), public.cto_user_dossier_search(text), public.cto_user_dossier_profile(uuid), public.cto_user_dossier_money(uuid,text,text,date,date,text,int), public.cto_user_dossier_partner(uuid), public.cto_user_dossier_activity(uuid) from public, anon;
grant execute on function public._cto_dossier_allowed(), public.cto_user_dossier_search(text), public.cto_user_dossier_profile(uuid), public.cto_user_dossier_money(uuid,text,text,date,date,text,int), public.cto_user_dossier_partner(uuid), public.cto_user_dossier_activity(uuid) to authenticated;