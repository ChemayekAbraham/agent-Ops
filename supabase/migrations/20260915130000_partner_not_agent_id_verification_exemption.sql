-- Exempt eligible partners from the manual payout-destination / National-ID
-- verification gate (public.withdrawal_user_id_verified — the single choke
-- point documented in 20260914240000_id_verification_exceptions.sql).
--
-- Eligibility (Josh, 2026-09-15): a user who holds at least one
-- investor_portfolios row (is a partner) AND has never acted as an agent
-- (no agent_collections, no rent_requests served as agent/assigned_agent/
-- proxy_agent). Deliberately activity-based rather than role-based: the
-- `agent` role is granted by default to every tenant created via
-- submit-tenant-form (see PUBLIC_ROLES in that function), so checking
-- user_roles would wrongly disqualify partners who are agents in name only.
--
-- Explicit decision: portfolio ownership alone is treated as sufficient
-- prior identity capture. profiles.national_id being blank does NOT
-- disqualify — checked against production 2026-09-15: of 805 partners
-- who'd qualify by activity alone, only 177 actually have a national_id
-- value on file. Josh's call was to exempt all 805 anyway rather than
-- narrow it to the 177, so this function does not check national_id.
CREATE OR REPLACE FUNCTION public.is_partner_not_agent(p_user_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select
    exists (select 1 from public.investor_portfolios ip where ip.investor_id = p_user_id)
    and not exists (select 1 from public.agent_collections ac where ac.agent_id = p_user_id)
    and not exists (
      select 1 from public.rent_requests rr
      where rr.agent_id = p_user_id
         or rr.assigned_agent_id = p_user_id
         or rr.proxy_agent_id = p_user_id
    )
$function$;

REVOKE ALL ON FUNCTION public.is_partner_not_agent(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_partner_not_agent(uuid) TO authenticated, service_role;

-- Extend the choke point with the partner-self-withdrawal exemption as a
-- third OR branch, alongside the existing CTO-grantable per-user exception
-- and the full documents+photos+verified-destination path.
CREATE OR REPLACE FUNCTION public.withdrawal_user_id_verified(p_user_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select exists (
    select 1 from public.id_verification_exceptions e
    where e.user_id = p_user_id and e.revoked_at is null
  )
  or (
    exists (
      select 1
      from public.profiles p
      where p.id = p_user_id
        and coalesce(btrim(p.national_id), '') <> ''
        and coalesce(btrim(p.national_id_photo_path), '') <> ''
        and coalesce(btrim(p.selfie_photo_path), '') <> ''
    )
    and exists (
      select 1
      from public.payout_destination_verifications v
      where v.user_id = p_user_id
        and v.status = 'verified'
    )
  )
  or public.is_partner_not_agent(p_user_id)
$function$;

INSERT INTO public.audit_logs (action_type, table_name, reason, metadata)
VALUES (
  'withdrawal_id_verification_policy_change',
  'withdrawal_user_id_verified',
  'Added partner-not-agent exemption: a portfolio holder with no agent activity (no agent_collections, no rent_requests as agent) now passes withdrawal_user_id_verified without a National-ID upload or Financial-Ops verified payout destination.',
  jsonb_build_object(
    'eligible_partner_count_at_change', (
      select count(*)
      from (select distinct investor_id as uid from public.investor_portfolios) ip
      where public.is_partner_not_agent(ip.uid)
    ),
    'changed_by', 'joshua.wanda@welile.com',
    'changed_at', now()
  )
);
