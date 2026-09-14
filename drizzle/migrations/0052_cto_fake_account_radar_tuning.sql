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
      (b.auth_email like '%@welile.user' or b.auth_email like '%@welile.agent') as synthetic,
      date_trunc('hour', b.created_at)
        + floor(extract(minute from b.created_at) / 10) * interval '10 minutes' as burst_bucket
    from base b
  ),
  marked as (
    select
      k.*,
      (
        not k.synthetic
        and k.email_confirmed_at is null
        and k.created_at < now() - interval '24 hours'
      ) as unverified
    from keyed k
  ),
  counted as (
    select
      m.*,
      case when length(m.phone_key) = 9 then count(*) over (partition by m.phone_key) else 1 end as phone_dupes,
      case when m.nid_key <> '' then count(*) over (partition by m.nid_key) else 1 end as nid_dupes,
      case when m.name_key <> '' then count(*) over (partition by m.name_key) else 1 end as name_dupes,
      case when m.referrer_id is not null then count(*) over (partition by m.referrer_id, m.burst_bucket) else 1 end as burst_peers
    from marked m
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
      c.synthetic as is_synthetic,
      c.unverified as unverified_email,
      (c.email_domain in (
        'mailinator.com','tempmail.com','temp-mail.org','yopmail.com','guerrillamail.com',
        '10minutemail.com','sharklasers.com','trashmail.com','getnada.com','dispostable.com',
        'maildrop.cc','fakeinbox.com','throwawaymail.com','mailnesia.com','tempr.email',
        'emailondeck.com','moakt.com','luxusmail.org','inboxbear.com','mailcatch.com'
      )) as disposable_email,
      (c.phone_dupes > 1) as duplicate_phone,
      (c.nid_dupes > 1) as duplicate_national_id,
      (c.name_dupes > 3 and c.unverified) as duplicate_name,
      (
        btrim(coalesce(c.full_name, '')) = ''
        or c.full_name ~ '\d'
        or array_length(regexp_split_to_array(btrim(c.full_name), '\s+'), 1) < 2
      ) as suspicious_name,
      (
        c.created_at < now() - interval '7 days'
        and (c.last_active_at is null or c.last_active_at <= c.created_at + interval '5 minutes')
      ) as dormant,
      (c.burst_peers >= 10 and c.unverified) as burst_signup
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