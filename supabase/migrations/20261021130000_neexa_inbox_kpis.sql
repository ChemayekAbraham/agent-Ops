-- KPI cards for the CMO Neexa Inbox: who came in through Neexa and what partners it produced.
--
-- "Referred by Neexa" = profiles.referrer_id is the NeexaBot profile (neexabot@welileapp.com).
-- claim_lead_click sets it when a NEW registration follows a click on a NeexaBot lead link.
--
--   came_in_users           distinct signed-in users matched to a NeexaBot lead-link click
--                           (lead_link_clicks.user_id). Includes existing users who clicked.
--   came_in_new_signups     of those, clicks flagged is_new_registration
--   referred_signups        profiles referred by NeexaBot
--   active_partners         referred profiles with at least one 'active' investor portfolio
--   active_portfolios       those active portfolios
--   active_volume           sum(investment_amount) of those active portfolios (UGX)
--   pending_partners        referred profiles pending review in partner onboarding: same rule as
--                           /partner-onboarding "Pending Review" (signup_source funder-onboarding,
--                           not verified, not rejected), excluding anyone already active
--   pending_portfolios      referred users' portfolios in the invite pipeline
--                           (awaiting_partner_details, pending_ops_approval)
--   pending_volume          sum(investment_amount) of those pending portfolios (UGX)
--
-- Read-only. Gated to cmo / super_admin / cto via can_view_neexa_inbox.

create or replace function public.get_neexa_inbox_kpis()
 returns jsonb language plpgsql stable security definer set search_path to 'public'
as $f$
declare
  v_bot uuid;
  r jsonb;
begin
  if not public.can_view_neexa_inbox(auth.uid()) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;

  select id into v_bot from public.profiles where email = 'neexabot@welileapp.com';

  with referred as (
    select p.id, p.signup_source, p.funder_verified_at, p.funder_rejected_at
      from public.profiles p
     where v_bot is not null and p.referrer_id = v_bot
  ),
  active as (
    select ip.investor_id, ip.investment_amount
      from public.investor_portfolios ip
      join referred on referred.id = ip.investor_id
     where ip.status = 'active'
  ),
  pending_pf as (
    select ip.investor_id, ip.investment_amount
      from public.investor_portfolios ip
      join referred on referred.id = ip.investor_id
     where ip.status in ('awaiting_partner_details','pending_ops_approval')
  ),
  clicks as (
    select c.user_id, bool_or(coalesce(c.is_new_registration, false)) as is_new
      from public.lead_link_clicks c
      join public.lead_links l on l.id = c.link_id
     where c.user_id is not null and l.referrer_label = 'NeexaBot'
     group by c.user_id
  )
  select jsonb_build_object(
    'came_in_users',       (select count(*) from clicks),
    'came_in_new_signups', (select count(*) from clicks where is_new),
    'referred_signups',    (select count(*) from referred),
    'active_partners',     (select count(distinct investor_id) from active),
    'active_portfolios',   (select count(*) from active),
    'active_volume',       (select coalesce(sum(investment_amount), 0) from active),
    'pending_partners',    (select count(*) from referred r
                             where r.signup_source = 'funder-onboarding'
                               and r.funder_verified_at is null and r.funder_rejected_at is null
                               and not exists (select 1 from active a where a.investor_id = r.id)),
    'pending_portfolios',  (select count(*) from pending_pf),
    'pending_volume',      (select coalesce(sum(investment_amount), 0) from pending_pf),
    'currency',            'UGX',
    'as_of',               now()
  ) into r;

  return r;
end;
$f$;
revoke all on function public.get_neexa_inbox_kpis() from public, anon;
grant execute on function public.get_neexa_inbox_kpis() to authenticated, service_role;
