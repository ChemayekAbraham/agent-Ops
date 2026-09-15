-- Pure partner: holds at least one live investor portfolio and has NO agent activity.
CREATE OR REPLACE FUNCTION public.user_is_pure_partner(p_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT p_user_id IS NOT NULL
     AND public.user_is_funder_with_portfolio(p_user_id)
     AND NOT EXISTS (
       SELECT 1 FROM public.agent_collections c WHERE c.agent_id = p_user_id
     )
     AND NOT EXISTS (
       SELECT 1 FROM public.rent_requests r WHERE r.agent_id = p_user_id
     )
     AND NOT EXISTS (
       SELECT 1 FROM public.user_roles ur
       WHERE ur.user_id = p_user_id
         AND COALESCE(ur.enabled, true)
         AND ur.role IN ('agent','sub_agent','senior_agent')
     );
$function$;

REVOKE ALL ON FUNCTION public.user_is_pure_partner(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.user_is_pure_partner(uuid) TO authenticated, service_role;

-- Single source of truth for the payout-destination gate. One call, one round
-- trip: returns whether the destination check passes and WHY, so callers never
-- re-implement the exemption ladder.
CREATE OR REPLACE FUNCTION public.withdrawal_destination_gate(p_withdrawal_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  w public.withdrawal_requests;
  m text;
BEGIN
  SELECT * INTO w FROM public.withdrawal_requests WHERE id = p_withdrawal_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;

  m := lower(coalesce(w.payout_method, ''));
  IF m NOT IN ('mobile_money','bank_transfer') THEN
    RETURN jsonb_build_object('ok', true, 'reason', 'method_not_gated');
  END IF;

  -- System-routed landlord float payout (destination verified in that flow).
  IF w.landlord_payout_id IS NOT NULL
     OR coalesce(w.reason,'') LIKE 'Landlord float payout%' THEN
    RETURN jsonb_build_object('ok', true, 'reason', 'landlord_payout');
  END IF;

  -- One-time legacy grandfather snapshot (per-withdrawal, immutable).
  IF public.withdrawal_verification_exempt(p_withdrawal_id) THEN
    RETURN jsonb_build_object('ok', true, 'reason', 'legacy_pending_cutoff');
  END IF;

  -- Proxy-agent initiated payout on a partner's behalf (includes returns payouts).
  IF w.proxy_partner_id IS NOT NULL
     AND w.initiated_by IS NOT NULL
     AND w.initiated_by <> w.user_id THEN
    RETURN jsonb_build_object('ok', true, 'reason', 'proxy_initiated');
  END IF;

  -- Partner (one or more portfolios) with no agent activity.
  IF public.user_is_pure_partner(w.user_id) THEN
    RETURN jsonb_build_object('ok', true, 'reason', 'partner_exempt');
  END IF;

  IF public.payout_destination_is_verified(
       w.user_id, w.payout_method, w.mobile_money_number, w.bank_name, w.bank_account_number) THEN
    RETURN jsonb_build_object('ok', true, 'reason', 'verified');
  END IF;

  RETURN jsonb_build_object('ok', false, 'reason', 'unverified');
END;
$function$;

REVOKE ALL ON FUNCTION public.withdrawal_destination_gate(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.withdrawal_destination_gate(uuid) TO authenticated, service_role;

-- Creation-time gate: on-behalf exemption narrowed to genuine proxy rows, and
-- the funder exemption tightened to partners with no agent activity.
CREATE OR REPLACE FUNCTION public.enforce_withdrawal_destination_verified()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF lower(coalesce(NEW.payout_method,'')) NOT IN ('mobile_money','bank_transfer') THEN
    RETURN NEW;
  END IF;

  IF NEW.landlord_payout_id IS NOT NULL THEN
    RETURN NEW;
  END IF;

  -- Proxy-agent initiated payout for a partner (returns payouts included).
  IF NEW.proxy_partner_id IS NOT NULL
     AND NEW.initiated_by IS NOT NULL
     AND NEW.initiated_by <> NEW.user_id THEN
    RETURN NEW;
  END IF;

  -- Partner with one or more portfolios and no agent activity.
  IF public.user_is_pure_partner(NEW.user_id) THEN
    RETURN NEW;
  END IF;

  IF NOT public.payout_destination_is_verified(
       NEW.user_id, NEW.payout_method, NEW.mobile_money_number, NEW.bank_name, NEW.bank_account_number) THEN
    RAISE EXCEPTION 'This payout destination is not yet verified. Financial Ops will call you to confirm it belongs to you.';
  END IF;

  RETURN NEW;
END;
$function$;

-- Merchant queue visibility: partner and proxy-initiated payouts must reach the
-- merchant desks, not sit invisible behind the National ID gate.
CREATE OR REPLACE FUNCTION public.withdrawal_merchant_id_gate(p_user_id uuid, p_landlord_payout_id uuid DEFAULT NULL::uuid, p_reason text DEFAULT NULL::text)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  select p_landlord_payout_id is not null
      or coalesce(p_reason, '') like 'Landlord float payout%'
      or public.withdrawal_user_id_verified(p_user_id)
      or public.user_is_pure_partner(p_user_id)
      or exists (
        select 1
        from public.withdrawal_requests w
        where w.user_id = p_user_id
          and w.proxy_partner_id is not null
          and w.initiated_by is not null
          and w.initiated_by <> w.user_id
      )
      or exists (
        select 1
        from public.withdrawal_requests w
        join public.withdrawal_id_gate_exemptions e
          on e.active
         and e.agent_user_id in (w.agent_id, w.initiated_by)
        where w.user_id = p_user_id
          and w.proxy_partner_id is not null
      )
$function$;