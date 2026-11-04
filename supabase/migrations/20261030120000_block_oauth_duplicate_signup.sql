-- Google/Apple sign-in must not open a second account for someone who already has one.
--
-- Supabase links a Google sign-in to an existing account only when that account's
-- LOGIN email (auth.users.email) is the same address. Phone signups log in with a
-- placeholder such as 256701355245@welile.user and keep their real address on
-- profiles.email only, so "Continue with Google" found no match and created a new,
-- empty account with all four roles (seen 2026-10-14 for pexpert46@gmail.com; 22
-- live Google accounts share a Gmail address with another account's profile).
--
-- This BEFORE INSERT trigger on auth.users refuses a Google/Apple signup whose email
-- (Gmail dots and +tags ignored) is already on another live account. Nothing is
-- created. Supabase returns "Database error saving new user" to the browser, which
-- tells the person to sign in with their phone number; Google is then linked to that
-- account (src/lib/oauthErrorLog.ts + pendingIdentityLink).
--
-- Not affected: password/phone signups, agent-created accounts (admin API, provider
-- 'email'/'phone'), and sign-ins to accounts that already exist (no insert happens).

create or replace function public.normalize_email_for_match(p_email text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select case
    when lower(btrim(p_email)) not like '%_@_%' then null
    -- Placeholder and tombstone addresses are not anyone's real email.
    when split_part(lower(btrim(p_email)), '@', 2)
         ~ '^((noapp\.)?welile\.(user|agent)|proxy\.welile\.local|deleted\.invalid)$' then null
    -- Gmail ignores dots and anything after '+'; googlemail.com is the same mailbox.
    when split_part(lower(btrim(p_email)), '@', 2) in ('gmail.com', 'googlemail.com')
      then replace(split_part(split_part(lower(btrim(p_email)), '@', 1), '+', 1), '.', '') || '@gmail.com'
    else lower(btrim(p_email))
  end;
$$;

comment on function public.normalize_email_for_match(text) is
  'Comparable form of an email: lower-cased, Gmail dots/+tags removed, placeholder addresses -> null.';

create index if not exists profiles_email_match_idx
  on public.profiles (public.normalize_email_for_match(email))
  where email is not null;

-- The live account (if any) other than p_new_id that already carries p_email.
create or replace function public.oauth_signup_duplicate_of(p_email text, p_new_id uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select p.id
  from public.profiles p
  join auth.users au on au.id = p.id
  where public.normalize_email_for_match(p.email) = public.normalize_email_for_match(p_email)
    and p.id <> p_new_id
    and p.deleted_at is null
    and coalesce(au.email, '') not ilike '%@deleted.invalid'
    and not exists (
      select 1 from public.deleted_accounts d
      where d.user_id = p.id and d.status <> 'restored'
    )
  order by p.created_at
  limit 1;
$$;

revoke execute on function public.oauth_signup_duplicate_of(text, uuid) from public, anon, authenticated;

create or replace function public.block_oauth_duplicate_signup()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing uuid;
begin
  if coalesce(new.raw_app_meta_data->>'provider', '') not in ('google', 'apple') then
    return new;
  end if;

  v_existing := public.oauth_signup_duplicate_of(new.email, new.id);
  if v_existing is not null then
    raise log 'block_oauth_duplicate_signup: % sign-up refused, email already on account %',
      new.raw_app_meta_data->>'provider', v_existing;
    raise exception 'oauth_duplicate_account: this email already belongs to a Welile account; sign in with your phone number and link Google from there'
      using errcode = '28000';
  end if;

  return new;
end;
$$;

revoke execute on function public.block_oauth_duplicate_signup() from public, anon, authenticated;

drop trigger if exists trg_block_oauth_duplicate_signup on auth.users;
create trigger trg_block_oauth_duplicate_signup
  before insert on auth.users
  for each row execute function public.block_oauth_duplicate_signup();
