create or replace function public.cto_fake_account_base()
returns table (
  user_id uuid,
  full_name text,
  auth_email text,
  phone text,
  created_at timestamptz,
  national_id text,
  last_active_at timestamptz,
  email_confirmed boolean,
  is_synthetic boolean,
  unverified_email boolean,
  disposable_email boolean,
  duplicate_phone boolean,
  duplicate_national_id boolean,
  duplicate_name boolean,
  suspicious_name boolean,
  dormant boolean,
  burst_signup boolean,
  risk_score integer
)
language sql
stable
security definer
set search_path = public
as $$
  with base as (
    select
      p.id,
      p.full_name,
      coalesce(nullif(btrim(u.email), ''), p.email) as auth_email,
      p.phone,
      p.created_at,
      p.national_id,
      p.last_active_at,
      p.referrer_id,
      u.email_confirmed_at
    from public.profiles p
    left join auth.users u on u.id = p.id
    where p.deleted_at is null
  ),
  keyed as (
    select
      b.*,
      right(regexp_replace(coalesce(b.phone, ''), '\D', '', 'g'), 9) as phone_key,
      upper(btrim(coalesce(b.national_id, ''))) as nid_key,
      lower(btrim(coalesce(b.full_name, ''))) as name_key,
      lower(split_part(coalesce(b.auth_email, ''), '@', 2)) as email_domain,
      date_trunc('hour', b.created_at)
        + floor(extract(minute from b.created_at) / 10) * interval '10 minutes' as burst_bucket
    from base b
  ),
  counted as (
    select
      k.*,
      case when length(k.phone_key) = 9 then count(*) over (partition by k.phone_key) else 1 end as phone_dupes,
      case when k.nid_key <> '' then count(*) over (partition by k.nid_key) else 1 end as nid_dupes,
      case when k.name_key <> '' then count(*) over (partition by k.name_key) else 1 end as name_dupes,
      case when k.referrer_id is not null then count(*) over (partition by k.referrer_id, k.burst_bucket) else 1 end as burst_peers
    from keyed k
  ),
  flagged as (
    select
      c.id as user_id,
      c.full_name,
      c.auth_email,
      c.phone,
      c.created_at,
      c.national_id,
      c.last_active_at,
      (c.email_confirmed_at is not null) as email_confirmed,
      (c.auth_email like '%@welile.user' or c.auth_email like '%@welile.agent') as is_synthetic,
      (
        c.auth_email not like '%@welile.user'
        and c.auth_email not like '%@welile.agent'
        and c.email_confirmed_at is null
        and c.created_at < now() - interval '24 hours'
      ) as unverified_email,
      (c.email_domain in (
        'mailinator.com','tempmail.com','temp-mail.org','yopmail.com','guerrillamail.com',
        '10minutemail.com','sharklasers.com','trashmail.com','getnada.com','dispostable.com',
        'maildrop.cc','fakeinbox.com','throwawaymail.com','mailnesia.com','tempr.email',
        'emailondeck.com','moakt.com','luxusmail.org','inboxbear.com','mailcatch.com'
      )) as disposable_email,
      (c.phone_dupes > 1) as duplicate_phone,
      (c.nid_dupes > 1) as duplicate_national_id,
      (c.name_dupes > 2) as duplicate_name,
      (
        btrim(coalesce(c.full_name, '')) = ''
        or c.full_name ~ '\d'
        or array_length(regexp_split_to_array(btrim(c.full_name), '\s+'), 1) < 2
      ) as suspicious_name,
      (c.last_active_at is null and c.created_at < now() - interval '7 days') as dormant,
      (c.burst_peers >= 5) as burst_signup
    from counted c
  )
  select
    f.user_id, f.full_name, f.auth_email, f.phone, f.created_at, f.national_id,
    f.last_active_at, f.email_confirmed, f.is_synthetic,
    f.unverified_email, f.disposable_email, f.duplicate_phone, f.duplicate_national_id,
    f.duplicate_name, f.suspicious_name, f.dormant, f.burst_signup,
    (case when f.unverified_email then 30 else 0 end
     + case when f.disposable_email then 35 else 0 end
     + case when f.duplicate_phone then 25 else 0 end
     + case when f.duplicate_national_id then 40 else 0 end
     + case when f.duplicate_name then 15 else 0 end
     + case when f.suspicious_name then 10 else 0 end
     + case when f.dormant then 10 else 0 end
     + case when f.burst_signup then 20 else 0 end)::integer as risk_score
  from flagged f
$$;

revoke all on function public.cto_fake_account_base() from public;

create or replace function public.cto_fake_account_signal_counts()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v jsonb;
begin
  if not (
    public.has_role(auth.uid(), 'cto')
    or public.has_role(auth.uid(), 'super_admin')
    or public.has_role(auth.uid(), 'manager')
    or public.has_role(auth.uid(), 'ceo')
  ) then
    raise exception 'Not authorized';
  end if;

  select jsonb_build_object(
    'total_accounts', count(*),
    'flagged', count(*) filter (where risk_score > 0),
    'high_risk', count(*) filter (where risk_score >= 50),
    'unverified_email', count(*) filter (where unverified_email),
    'disposable_email', count(*) filter (where disposable_email),
    'duplicate_phone', count(*) filter (where duplicate_phone),
    'duplicate_national_id', count(*) filter (where duplicate_national_id),
    'duplicate_name', count(*) filter (where duplicate_name),
    'suspicious_name', count(*) filter (where suspicious_name),
    'dormant', count(*) filter (where dormant),
    'burst_signup', count(*) filter (where burst_signup),
    'generated_at', now()
  )
  into v
  from public.cto_fake_account_base();

  return v;
end;
$$;

grant execute on function public.cto_fake_account_signal_counts() to authenticated;

create or replace function public.cto_fake_account_list(
  p_signal text default 'all',
  p_search text default null,
  p_limit integer default 25,
  p_offset integer default 0
)
returns table (
  user_id uuid,
  full_name text,
  auth_email text,
  phone text,
  created_at timestamptz,
  national_id text,
  last_active_at timestamptz,
  email_confirmed boolean,
  is_synthetic boolean,
  signals text[],
  risk_score integer,
  total_count bigint
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 25), 1), 100);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
  v_search text := nullif(btrim(coalesce(p_search, '')), '');
  v_signal text := lower(coalesce(nullif(btrim(p_signal), ''), 'all'));
begin
  if not (
    public.has_role(auth.uid(), 'cto')
    or public.has_role(auth.uid(), 'super_admin')
    or public.has_role(auth.uid(), 'manager')
    or public.has_role(auth.uid(), 'ceo')
  ) then
    raise exception 'Not authorized';
  end if;

  return query
  with scanned as (
    select b.*,
      array_remove(array[
        case when b.unverified_email then 'unverified_email' end,
        case when b.disposable_email then 'disposable_email' end,
        case when b.duplicate_phone then 'duplicate_phone' end,
        case when b.duplicate_national_id then 'duplicate_national_id' end,
        case when b.duplicate_name then 'duplicate_name' end,
        case when b.suspicious_name then 'suspicious_name' end,
        case when b.dormant then 'dormant' end,
        case when b.burst_signup then 'burst_signup' end
      ], null) as sig
    from public.cto_fake_account_base() b
    where b.risk_score > 0
  ),
  filtered as (
    select s.*
    from scanned s
    where (v_signal = 'all' or v_signal = any(s.sig))
      and (
        v_search is null
        or s.full_name ilike '%' || v_search || '%'
        or s.auth_email ilike '%' || v_search || '%'
        or coalesce(s.phone, '') ilike '%' || v_search || '%'
        or coalesce(s.national_id, '') ilike '%' || v_search || '%'
      )
  ),
  total as (select count(*) as n from filtered)
  select f.user_id, f.full_name, f.auth_email, f.phone, f.created_at, f.national_id,
         f.last_active_at, f.email_confirmed, f.is_synthetic, f.sig, f.risk_score,
         (select n from total)
  from filtered f
  order by f.risk_score desc, f.created_at desc
  limit v_limit offset v_offset;
end;
$$;

grant execute on function public.cto_fake_account_list(text, text, integer, integer) to authenticated;