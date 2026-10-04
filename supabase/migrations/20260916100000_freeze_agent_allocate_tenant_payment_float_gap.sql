-- Emergency platform-wide freeze of agent rent-collection allocation.
--
-- Why: the 2026-09-15 float redesign (see
-- docs/HANDOVER/30-incident-2026-09-16-collection-guard-vs-float-redesign-drift.md) made agent
-- float a non-consuming per-transaction gate instead of cash that gets debited per collection.
-- Because the gate checks only float_balance >= this-transaction-amount and never decrements
-- float, a single float balance can back unlimited collections in a day. Confirmed live: agent
-- e05d2e42-3fa4-4fac-beb3-98328163aad9 recorded UGX 1,655,666 across 10 collections in a 28-minute
-- window on 2026-09-16 while holding a flat UGX 300,000 float throughout (float_before ==
-- float_after == 300000 on every row); over 3 days the same agent recorded UGX 60,059,171 against
-- that same 300,000 float. The eligibility gate is not enforcing anything above the size of one
-- transaction.
--
-- Frozen at the request of the platform owner (Josh Wanda) pending a proper fix (restoring
-- per-collection float consumption or a cumulative daily-collected-vs-float cap). Both the public
-- entry point and the SECURITY DEFINER internal function are frozen because both are independently
-- EXECUTE-granted to `authenticated` (and `anon`) — freezing only the wrapper would not stop a
-- direct RPC call to the internal function.
--
-- To unfreeze: revert this migration (CREATE OR REPLACE with the pre-freeze bodies from git
-- history at commit 457c56d88, or the fixed version once the float-consumption/cap fix lands).
-- Do not just drop the freeze block without also closing the over-collection gap it exists to stop.

CREATE OR REPLACE FUNCTION public.agent_allocate_tenant_payment(p_agent_id uuid, p_tenant_id uuid, p_rent_request_id uuid, p_amount numeric, p_notes text DEFAULT NULL::text, p_partial_confirmed boolean DEFAULT false, p_partial_reason text DEFAULT NULL::text, p_client_ref uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  RETURN jsonb_build_object(
    'success', false,
    'error_code', 'ALLOCATION_FROZEN',
    'error', 'Rent collection allocation is temporarily paused platform-wide while a float-allowance issue is fixed. No collections can be recorded right now — please try again later.'
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.agent_allocate_tenant_payment_internal(p_agent_id uuid, p_tenant_id uuid, p_rent_request_id uuid, p_amount numeric, p_notes text DEFAULT NULL::text, p_client_ref uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  RETURN jsonb_build_object(
    'success', false,
    'error_code', 'ALLOCATION_FROZEN',
    'error', 'Rent collection allocation is temporarily paused platform-wide while a float-allowance issue is fixed. No collections can be recorded right now — please try again later.'
  );
END;
$function$;
