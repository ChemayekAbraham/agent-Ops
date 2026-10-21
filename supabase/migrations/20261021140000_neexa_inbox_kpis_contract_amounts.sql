-- Neexa Inbox KPIs v2: partner figures come from the partnership agreements (contract amounts),
-- the same records /partner-onboarding works from, instead of portfolio rows and review flags.
--
-- Why: the CMO reads "pending" as partners NeexaBot referred whose agreement is still awaiting the
-- company countersign, and the money as the contract amount on that agreement. v1 counted
-- funder-onboarding review flags and pending PORTFOLIO amounts, which showed UGX 0 while
-- six NeexaBot partners had UGX 4,300,000 of pending agreements (2026-10-21).
--
-- "Referred by Neexa" = profiles.referrer_id is the NeexaBot profile (neexabot@welileapp.com),
-- shown as "Referred by NeexaBot" in the partner-onboarding Source column.
--
--   referred_signups     profiles referred by NeexaBot (headline count)
--   came_in_users        distinct signed-in users matched to a NeexaBot lead-link click
--   came_in_new_signups  of those, clicks that were new registrations
--   active_partners      referred, with at least one 'active' investor portfolio
--   active_portfolios    those active portfolios
--   active_volume        contract amount (partnership_amount) of the countersigned agreements of the
--                        active partners. Falls back to the active portfolios' investment_amount for
--                        an active partner with no countersigned agreement.
--   pending_partners     referred, with at least one agreement in status 'pending' (awaiting countersign)
--   pending_agreements   those pending agreements
--   pending_volume       contract amount of those pending agreements
--   pending_portfolios   referred users' portfolios still in the invite pipeline
--                        (awaiting_partner_details, pending_ops_approval). Informational.
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
    select p.id from public.profiles p where v_bot is not null and p.referrer_id = v_bot
  ),
  active_pf as (
    select ip.investor_id, ip.investment_amount
      from public.investor_portfolios ip
      join referred on referred.id = ip.investor_id
     where ip.status = 'active'
  ),
  active_partner as (
    select a.investor_id,
           sum(a.investment_amount) as portfolio_amount,
           (select sum(pa.partnership_amount) from public.partner_agreements pa
             where pa.partner_id = a.investor_id and pa.status = 'countersigned') as contract_amount
      from active_pf a
     group by a.investor_id
  ),
  pending_ag as (
    select pa.partner_id, pa.partnership_amount
      from public.partner_agreements pa
      join referred on referred.id = pa.partner_id
     where pa.status = 'pending'
  ),
  clicks as (
    select c.user_id, bool_or(coalesce(c.is_new_registration, false)) as is_new
      from public.lead_link_clicks c
      join public.lead_links l on l.id = c.link_id
     where c.user_id is not null and l.referrer_label = 'NeexaBot'
     group by c.user_id
  )
  select jsonb_build_object(
    'referred_signups',    (select count(*) from referred),
    'came_in_users',       (select count(*) from clicks),
    'came_in_new_signups', (select count(*) from clicks where is_new),
    'active_partners',     (select count(*) from active_partner),
    'active_portfolios',   (select count(*) from active_pf),
    'active_volume',       (select coalesce(sum(coalesce(contract_amount, portfolio_amount)), 0) from active_partner),
    'pending_partners',    (select count(distinct partner_id) from pending_ag),
    'pending_agreements',  (select count(*) from pending_ag),
    'pending_volume',      (select coalesce(sum(partnership_amount), 0) from pending_ag),
    'pending_portfolios',  (select count(*) from public.investor_portfolios ip
                             join referred on referred.id = ip.investor_id
                            where ip.status in ('awaiting_partner_details','pending_ops_approval')),
    'currency',            'UGX',
    'as_of',               now()
  ) into r;

  return r;
end;
$f$;
revoke all on function public.get_neexa_inbox_kpis() from public, anon;
grant execute on function public.get_neexa_inbox_kpis() to authenticated, service_role;
