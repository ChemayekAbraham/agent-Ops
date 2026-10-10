-- Lock down get_agent_float_balance(uuid) and get_agent_lp_float_available(uuid).
--
-- Both were SECURITY DEFINER, owned by postgres, took ANY agent id, and had no caller check.
-- Their ACL granted EXECUTE to PUBLIC, anon and authenticated, so anyone, including a logged-out
-- visitor, could read any agent's float by UUID over PostgREST (/rest/v1/rpc/...).
--
-- Fix (defence in depth):
--   1. A caller check inside each function (new helper agent_float_read_allowed):
--        - service_role requests (the edge functions use the admin client);
--        - trusted direct database sessions (migrations, SQL editor, pg_cron) - the same
--          session_user rule cancel_tenant_and_return_landlord_float already uses;
--        - the agent themself (auth.uid() = p_agent_id);
--        - staff, with the SAME gate get_agent_ops_overview uses (ops role, manager, CFO, CEO,
--          COO, CTO, super_admin), so existing ops tooling keeps working.
--      Anyone else gets `not_authorized`.
--   2. EXECUTE revoked from PUBLIC and anon. authenticated keeps EXECUTE (the agent's own
--      dashboard calls get_agent_lp_float_available with their own id) and relies on (1).
--
-- Callers audited before this change: src/ passes the signed-in user's own id only; the three
-- edge functions (agent-cash-deposit-create/-confirm, landlord-payout-disburse) call through
-- the service-role client; agent_record_landlord_float_withdrawal calls it with auth.uid().
-- No view, policy, trigger or cron job references either function.
--
-- The function bodies below are the live production definitions (read from pg_proc, since
-- migrations in this repo do not faithfully reflect the live schema) with ONLY the caller
-- check added. get_agent_lp_float_available changes from LANGUAGE sql to plpgsql solely so it
-- can raise; its arithmetic is unchanged.

create or replace function public.agent_float_read_allowed(p_agent_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
begin
  if coalesce(auth.role(), '') = 'service_role' then
    return true;
  end if;

  -- A direct database session (not a PostgREST/API connection). API requests always connect
  -- as 'authenticator', and a caller cannot change session_user.
  if session_user not in ('authenticator', 'anon', 'authenticated', 'service_role') then
    return true;
  end if;

  if v_uid is null or p_agent_id is null then
    return false;
  end if;

  if v_uid = p_agent_id then
    return true;
  end if;

  return public.is_ops_role(v_uid)
      or public.has_role(v_uid, 'manager')
      or public.has_role(v_uid, 'cfo')
      or public.has_role(v_uid, 'ceo')
      or public.has_role(v_uid, 'coo')
      or public.has_role(v_uid, 'cto')
      or public.has_role(v_uid, 'super_admin');
end;
$$;

revoke execute on function public.agent_float_read_allowed(uuid) from public, anon, authenticated;
grant  execute on function public.agent_float_read_allowed(uuid) to service_role;

-- ---------------------------------------------------------------------------------------------
-- get_agent_float_balance: live body + caller check
-- ---------------------------------------------------------------------------------------------
create or replace function public.get_agent_float_balance(p_agent_id uuid)
 returns numeric
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
DECLARE
  v_cached_float numeric;
  v_has_wallet boolean;
  v_total_wallet numeric;
  v_commission numeric;
BEGIN
  IF p_agent_id IS NULL THEN
    RETURN 0;
  END IF;

  IF NOT public.agent_float_read_allowed(p_agent_id) THEN
    RAISE EXCEPTION 'not_authorized' USING ERRCODE = '42501';
  END IF;

  -- Trust the wallets cache when present.
  -- `wallets.float_balance` is exclusively maintained by `apply_wallet_movement`
  -- (the sole writer of wallet buckets), so it is the authoritative figure for
  -- "company float available to the agent" — and it is not clipped by any
  -- post-anchor ledger window.
  SELECT w.float_balance, true
  INTO v_cached_float, v_has_wallet
  FROM public.wallets w
  WHERE w.user_id = p_agent_id
  LIMIT 1;

  IF v_has_wallet THEN
    RETURN GREATEST(0, COALESCE(v_cached_float, 0));
  END IF;

  -- Legacy fallback (no wallet row): historical ledger-based computation.
  SELECT COALESCE(SUM(CASE WHEN direction IN ('cash_in','credit') THEN amount ELSE -amount END), 0)
  INTO v_total_wallet
  FROM public.general_ledger
  WHERE user_id = p_agent_id
    AND ledger_scope = 'wallet';

  SELECT COALESCE(SUM(
    CASE
      WHEN direction IN ('cash_in','credit')
        AND category IN (
          'agent_commission_earned','agent_commission','agent_bonus',
          'referral_bonus','proxy_investment_commission',
          'agent_advance_credit','partner_commission'
        )
      THEN amount
      WHEN direction IN ('cash_out','debit')
        AND category IN (
          'agent_commission_withdrawal','agent_commission_used_for_rent',
          'wallet_withdrawal','wallet_transfer','wallet_deduction',
          'wallet_deduction_general_adjustment'
        )
      THEN -amount
      ELSE 0
    END
  ), 0)
  INTO v_commission
  FROM public.general_ledger
  WHERE user_id = p_agent_id
    AND ledger_scope = 'wallet';

  v_commission := GREATEST(0, v_commission);
  RETURN GREATEST(0, v_total_wallet - v_commission);
END;
$function$;

-- ---------------------------------------------------------------------------------------------
-- get_agent_lp_float_available: live arithmetic + caller check
-- ---------------------------------------------------------------------------------------------
create or replace function public.get_agent_lp_float_available(p_agent_id uuid)
 returns numeric
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
BEGIN
  IF p_agent_id IS NOT NULL AND NOT public.agent_float_read_allowed(p_agent_id) THEN
    RAISE EXCEPTION 'not_authorized' USING ERRCODE = '42501';
  END IF;

  RETURN GREATEST(
    0,
    COALESCE((SELECT balance FROM public.agent_landlord_float WHERE agent_id = p_agent_id), 0)
    -- Ring-fenced by a payout already verified but not yet paid out.
    - COALESCE((
        SELECT SUM(amount)
        FROM public.landlord_payouts
        WHERE agent_id = p_agent_id
          AND status IN ('otp_verified','pending_merchant_payout')
      ), 0)
    -- Float already on its way back to the pool. The agent cannot spend it,
    -- so showing it as available means offering money the payout will refuse.
    - COALESCE((
        SELECT SUM(remaining_amount)
        FROM public.agent_landlord_float_allocations
        WHERE agent_id = p_agent_id
          AND status = 'return_pending'
      ), 0)
  );
END;
$function$;

-- ---------------------------------------------------------------------------------------------
-- Grants. CREATE OR REPLACE preserves the old ACL (which included PUBLIC and anon), so revoke
-- explicitly. authenticated keeps EXECUTE; the in-function check is what scopes it.
-- ---------------------------------------------------------------------------------------------
revoke execute on function public.get_agent_float_balance(uuid) from public, anon;
grant  execute on function public.get_agent_float_balance(uuid) to authenticated, service_role;

revoke execute on function public.get_agent_lp_float_available(uuid) from public, anon;
grant  execute on function public.get_agent_lp_float_available(uuid) to authenticated, service_role;

-- Fail the migration loudly rather than leave the hole open.
do $$
begin
  if has_function_privilege('anon', 'public.get_agent_float_balance(uuid)', 'execute')
     or has_function_privilege('anon', 'public.get_agent_lp_float_available(uuid)', 'execute')
     or has_function_privilege('public', 'public.get_agent_float_balance(uuid)', 'execute')
     or has_function_privilege('public', 'public.get_agent_lp_float_available(uuid)', 'execute')
     or has_function_privilege('anon', 'public.agent_float_read_allowed(uuid)', 'execute') then
    raise exception 'agent float RPCs are still executable by anon/PUBLIC';
  end if;
end;
$$;
