-- Stage 4A/4C/4D/4E: smartphone lifecycle, secure tenant dashboard links,
-- device evidence and dashboard activation tracking.
--
-- Replaces a single boolean with a lifecycle that can distinguish "we know
-- this tenant has a smartphone" from "we have never asked". That distinction
-- is the whole point: communication routing is worthless if every tenant
-- looks confirmed.

-- ---------------------------------------------------------------------------
-- Part 1: lifecycle columns (Stage 4A).
--
-- Added ALONGSIDE profiles.has_smartphone, which has ~195 references across
-- the codebase and cannot be swapped out in one step.
-- ---------------------------------------------------------------------------
alter table public.profiles
  add column if not exists smartphone_status text not null default 'UNKNOWN',
  add column if not exists smartphone_source text,
  add column if not exists smartphone_verified_at timestamptz,
  add column if not exists dashboard_first_access_at timestamptz,
  add column if not exists dashboard_last_access_at timestamptz,
  add column if not exists dashboard_access_count int not null default 0,
  add column if not exists dashboard_activated boolean not null default false;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'profiles_smartphone_status_check') then
    alter table public.profiles
      add constraint profiles_smartphone_status_check
      check (smartphone_status in ('UNKNOWN','CONFIRMED_SMARTPHONE','CONFIRMED_FEATURE_PHONE'));
  end if;

  if not exists (select 1 from pg_constraint where conname = 'profiles_smartphone_source_check') then
    alter table public.profiles
      add constraint profiles_smartphone_source_check
      check (smartphone_source is null or smartphone_source in
        ('ONBOARDING','AGENT','CALL_CENTER','DASHBOARD_ACCESS','SYSTEM_DETECTION'));
  end if;
end $$;

create index if not exists idx_profiles_smartphone_status
  on public.profiles (smartphone_status)
  where deleted_at is null;

create index if not exists idx_profiles_dashboard_activated
  on public.profiles (dashboard_activated)
  where deleted_at is null;

-- ---------------------------------------------------------------------------
-- Part 2: backfill -- deliberately conservative.
--
-- profiles.has_smartphone is NOT NULL DEFAULT true. Measured 2026-09-09:
-- 61,961 rows true, 93 false, 0 null out of 62,054 live profiles. The `true`
-- value is therefore almost entirely the column default and carries no
-- information at all -- treating it as a confirmation would manufacture
-- ~62,000 false confirmations and make smartphone segmentation meaningless on
-- its first day, which is precisely the false-positive failure this lifecycle
-- exists to prevent.
--
-- So `true` backfills to UNKNOWN (the default), and only genuinely deliberate
-- signals produce a CONFIRMED_FEATURE_PHONE:
--   * the 93 profiles someone actively set to false against a true default
--   * the 430 distinct tenants flagged tenant_no_smartphone on a rent request
--     (624 requests), which agents record explicitly at registration
--
-- Everything else stays UNKNOWN. Starting with ~62k UNKNOWN is the truthful
-- state, and is exactly what SMARTPHONE_DISCOVERY exists to resolve.
-- ---------------------------------------------------------------------------
update public.profiles p
set smartphone_status = 'CONFIRMED_FEATURE_PHONE',
    smartphone_source = 'AGENT',
    smartphone_verified_at = coalesce(p.smartphone_verified_at, now())
where p.deleted_at is null
  and p.smartphone_status = 'UNKNOWN'
  and (
    p.has_smartphone is false
    or exists (
      select 1 from public.rent_requests rr
      where rr.tenant_id = p.id and rr.tenant_no_smartphone is true
    )
  );

-- ---------------------------------------------------------------------------
-- Part 3: legacy synchronisation.
--
-- One trigger, deliberately asymmetric:
--
--   status -> has_smartphone : only for the two CONFIRMED states. UNKNOWN
--     leaves the legacy flag untouched. Mapping 62k UNKNOWN rows to false
--     would silently switch off every feature gated on has_smartphone.
--
--   has_smartphone -> status : on UPDATE only, never on INSERT. A deliberate
--     update (an agent editing a tenant) is real evidence; the INSERT default
--     is not. This is what keeps EditTenantDialog working without the default
--     leaking back in as a confirmation.
-- ---------------------------------------------------------------------------
create or replace function public.sync_profile_smartphone_fields()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if TG_OP = 'UPDATE'
     and NEW.smartphone_status is distinct from OLD.smartphone_status then
    -- New lifecycle is authoritative for this write.
    if NEW.smartphone_status = 'CONFIRMED_SMARTPHONE' then
      NEW.has_smartphone := true;
    elsif NEW.smartphone_status = 'CONFIRMED_FEATURE_PHONE' then
      NEW.has_smartphone := false;
    end if;
    if NEW.smartphone_status <> 'UNKNOWN' and NEW.smartphone_verified_at is null then
      NEW.smartphone_verified_at := now();
    end if;

  elsif TG_OP = 'UPDATE'
        and NEW.has_smartphone is distinct from OLD.has_smartphone then
    -- Legacy write: treat as an explicit agent statement.
    NEW.smartphone_status := case
      when NEW.has_smartphone then 'CONFIRMED_SMARTPHONE'
      else 'CONFIRMED_FEATURE_PHONE'
    end;
    NEW.smartphone_source := coalesce(NEW.smartphone_source, 'AGENT');
    NEW.smartphone_verified_at := now();
  end if;

  return NEW;
end;
$$;

drop trigger if exists trg_sync_profile_smartphone_fields on public.profiles;

create trigger trg_sync_profile_smartphone_fields
  before update on public.profiles
  for each row
  execute function public.sync_profile_smartphone_fields();

-- ---------------------------------------------------------------------------
-- Part 4: secure dashboard links (Stage 4C).
--
-- Only the SHA-256 hash of a token is stored, so a database read cannot
-- reproduce a working link. The raw token exists only in the SMS and in the
-- edge function that minted it.
--
-- The raw tenant UUID never appears in the URL.
-- ---------------------------------------------------------------------------
create table if not exists public.tenant_dashboard_links (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.profiles(id),
  token_hash text not null unique,
  purpose text not null default 'dashboard'
    check (purpose in ('dashboard','discovery','invite','call_centre')),
  created_at timestamptz not null default now(),
  created_by uuid,
  expires_at timestamptz,
  revoked_at timestamptz,
  last_used_at timestamptz,
  use_count int not null default 0
);

create index if not exists idx_tenant_dashboard_links_tenant
  on public.tenant_dashboard_links (tenant_id, created_at desc);

alter table public.tenant_dashboard_links enable row level security;

create policy "tenant_dashboard_links_ops_read"
  on public.tenant_dashboard_links for select
  using (
    public.has_role(auth.uid(),'super_admin') or public.has_role(auth.uid(),'tenant_ops')
    or public.has_role(auth.uid(),'manager') or public.has_role(auth.uid(),'coo')
    or public.has_role(auth.uid(),'ceo')
  );

-- Service role only: a token row must never be writable from the client.
revoke insert, update, delete on public.tenant_dashboard_links from authenticated;

-- ---------------------------------------------------------------------------
-- Part 5: access log (Stage 4D).
--
-- counted_as_smartphone records whether THIS open was accepted as evidence,
-- so a later audit can tell a genuine phone open from a desktop or bot open
-- that was deliberately not counted.
-- ---------------------------------------------------------------------------
create table if not exists public.tenant_dashboard_access_log (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.profiles(id),
  link_id uuid references public.tenant_dashboard_links(id),
  opened_at timestamptz not null default now(),
  user_agent text,
  device_class text,
  browser text,
  os text,
  referrer text,
  ip_hash text,
  counted_as_smartphone boolean not null default false,
  was_first_access boolean not null default false
);

create index if not exists idx_tenant_dashboard_access_tenant
  on public.tenant_dashboard_access_log (tenant_id, opened_at desc);

alter table public.tenant_dashboard_access_log enable row level security;

create policy "tenant_dashboard_access_log_ops_read"
  on public.tenant_dashboard_access_log for select
  using (
    public.has_role(auth.uid(),'super_admin') or public.has_role(auth.uid(),'tenant_ops')
    or public.has_role(auth.uid(),'manager') or public.has_role(auth.uid(),'coo')
    or public.has_role(auth.uid(),'ceo')
  );

revoke insert, update, delete on public.tenant_dashboard_access_log from authenticated;

-- ---------------------------------------------------------------------------
-- Part 6: link issue + access recording.
-- ---------------------------------------------------------------------------
create or replace function public.issue_tenant_dashboard_link(
  p_tenant_id uuid,
  p_token_hash text,
  p_purpose text default 'dashboard',
  p_ttl_days int default 90,
  p_created_by uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  insert into public.tenant_dashboard_links
    (tenant_id, token_hash, purpose, expires_at, created_by)
  values (
    p_tenant_id,
    p_token_hash,
    coalesce(p_purpose, 'dashboard'),
    case when p_ttl_days is null then null
         else now() + make_interval(days => greatest(p_ttl_days, 1)) end,
    p_created_by
  )
  returning id into v_id;

  return v_id;
end;
$$;

revoke all on function public.issue_tenant_dashboard_link(uuid, text, text, int, uuid) from public;
grant execute on function public.issue_tenant_dashboard_link(uuid, text, text, int, uuid)
  to service_role, postgres;

/*
 * Validates a dashboard token and records the open.
 *
 * p_is_smartphone_evidence is decided by the caller from the user agent, and
 * is the guard against false positives: an open from a desktop browser, a
 * tablet, a crawler or a link-preview bot (WhatsApp fetches every URL it is
 * sent) must NOT confirm smartphone ownership. Those opens are still logged --
 * they are real engagement -- but leave smartphone_status untouched.
 *
 * Device evidence outranks an agent's claim, so a phone open upgrades a
 * profile previously marked CONFIRMED_FEATURE_PHONE. The access log keeps the
 * contradiction visible.
 *
 * Returns jsonb rather than raising for an invalid token: the caller is a
 * public endpoint and must answer uniformly whether a token is unknown,
 * expired or revoked, so the response cannot be used to probe for live tokens.
 */
create or replace function public.record_tenant_dashboard_access(
  p_token_hash text,
  p_is_smartphone_evidence boolean default false,
  p_user_agent text default null,
  p_device_class text default null,
  p_browser text default null,
  p_os text default null,
  p_referrer text default null,
  p_ip_hash text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_link public.tenant_dashboard_links;
  v_first boolean := false;
  v_confirmed boolean := false;
  v_prev_status text;
begin
  select * into v_link
  from public.tenant_dashboard_links
  where token_hash = p_token_hash;

  if not found
     or v_link.revoked_at is not null
     or (v_link.expires_at is not null and v_link.expires_at < now()) then
    return jsonb_build_object('valid', false);
  end if;

  select smartphone_status into v_prev_status
  from public.profiles where id = v_link.tenant_id;

  v_first := not exists (
    select 1 from public.tenant_dashboard_access_log
    where tenant_id = v_link.tenant_id
  );

  update public.tenant_dashboard_links
  set last_used_at = now(), use_count = use_count + 1
  where id = v_link.id;

  update public.profiles
  set dashboard_first_access_at = coalesce(dashboard_first_access_at, now()),
      dashboard_last_access_at = now(),
      dashboard_access_count = dashboard_access_count + 1,
      dashboard_activated = true,
      smartphone_status = case
        when p_is_smartphone_evidence then 'CONFIRMED_SMARTPHONE'
        else smartphone_status end,
      smartphone_source = case
        when p_is_smartphone_evidence then 'DASHBOARD_ACCESS'
        else smartphone_source end,
      smartphone_verified_at = case
        when p_is_smartphone_evidence then now()
        else smartphone_verified_at end
  where id = v_link.tenant_id;

  v_confirmed := p_is_smartphone_evidence;

  insert into public.tenant_dashboard_access_log (
    tenant_id, link_id, user_agent, device_class, browser, os,
    referrer, ip_hash, counted_as_smartphone, was_first_access
  ) values (
    v_link.tenant_id, v_link.id, p_user_agent, p_device_class, p_browser, p_os,
    p_referrer, p_ip_hash, v_confirmed, v_first
  );

  return jsonb_build_object(
    'valid', true,
    'tenant_id', v_link.tenant_id,
    'first_access', v_first,
    'smartphone_confirmed', v_confirmed,
    'previous_status', v_prev_status
  );
end;
$$;

revoke all on function public.record_tenant_dashboard_access(text, boolean, text, text, text, text, text, text) from public;
grant execute on function public.record_tenant_dashboard_access(text, boolean, text, text, text, text, text, text)
  to service_role, postgres;

-- ---------------------------------------------------------------------------
-- Part 7: manual status capture (Stage 4B onboarding, Stage 4H call centre).
--
-- UNKNOWN is a legitimate answer and clears any prior confirmation, so an
-- operator can correct a wrong one rather than being forced to pick yes or no.
-- ---------------------------------------------------------------------------
create or replace function public.set_tenant_smartphone_status(
  p_tenant_id uuid,
  p_status text,
  p_source text default 'CALL_CENTER'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid := auth.uid();
begin
  if p_status not in ('UNKNOWN','CONFIRMED_SMARTPHONE','CONFIRMED_FEATURE_PHONE') then
    raise exception 'invalid smartphone_status: %', p_status;
  end if;
  if p_source not in ('ONBOARDING','AGENT','CALL_CENTER','DASHBOARD_ACCESS','SYSTEM_DETECTION') then
    raise exception 'invalid smartphone_source: %', p_source;
  end if;

  -- Service-role callers (onboarding edge functions) have no auth.uid().
  if v_actor is not null and not (
    public.has_role(v_actor,'super_admin') or public.has_role(v_actor,'tenant_ops')
    or public.has_role(v_actor,'manager') or public.has_role(v_actor,'coo')
    or public.has_role(v_actor,'ceo') or public.has_role(v_actor,'operations')
    or public.has_role(v_actor,'agent_ops') or public.has_role(v_actor,'agent')
    -- 'crm' is the call-centre role in this codebase (see crm-place-call,
    -- crm-voice-callback); has_role's second arg is a strict app_role enum
    -- with no 'call_centre' member, so that literal would fail every call.
    or public.has_role(v_actor,'crm')
  ) then
    raise exception 'not authorized';
  end if;

  update public.profiles
  set smartphone_status = p_status,
      smartphone_source = case when p_status = 'UNKNOWN' then null else p_source end,
      smartphone_verified_at = case when p_status = 'UNKNOWN' then null else now() end
  where id = p_tenant_id and deleted_at is null;

  if not found then
    return jsonb_build_object('updated', false, 'reason', 'tenant_not_found');
  end if;

  return jsonb_build_object('updated', true, 'status', p_status, 'source', p_source);
end;
$$;

revoke all on function public.set_tenant_smartphone_status(uuid, text, text) from public;
grant execute on function public.set_tenant_smartphone_status(uuid, text, text)
  to authenticated, service_role, postgres;

-- ---------------------------------------------------------------------------
-- Part 8: candidate selectors for the Stage 4F/4G senders.
--
-- Both restricted to tenants on an active Rent Plan: a dashboard invite is
-- only meaningful to someone with rent activity to look at.
-- ---------------------------------------------------------------------------
create or replace function public.get_tenant_dashboard_link_candidates(
  p_mode text default 'invite',
  p_limit int default 2000
)
returns table (
  tenant_id uuid,
  tenant_name text,
  tenant_phone text,
  smartphone_status text,
  dashboard_activated boolean
)
language sql
stable
security definer
set search_path = public
as $$
  select p.id as tenant_id,
         p.full_name as tenant_name,
         p.phone as tenant_phone,
         p.smartphone_status,
         p.dashboard_activated
  from public.profiles p
  join (
    select distinct e.tenant_id
    from public.v_tenant_daily_eligibility e
    where e.status in ('funded','disbursed','repaying')
  ) t on t.tenant_id = p.id
  where p.deleted_at is null
    and coalesce(p.phone, '') <> ''
    and (
      -- 4G: known smartphone, never opened the dashboard.
      (p_mode = 'invite'
        and p.smartphone_status = 'CONFIRMED_SMARTPHONE'
        and p.dashboard_activated = false)
      -- 4F: we have never established what device they use.
      or (p_mode = 'discovery' and p.smartphone_status = 'UNKNOWN')
    )
  order by p.id
  limit greatest(1, least(coalesce(p_limit, 2000), 5000));
$$;

revoke all on function public.get_tenant_dashboard_link_candidates(text, int) from public;
grant execute on function public.get_tenant_dashboard_link_candidates(text, int)
  to authenticated, service_role, postgres;
