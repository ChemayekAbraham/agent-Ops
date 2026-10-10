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

  SELECT w.float_balance, true
  INTO v_cached_float, v_has_wallet
  FROM public.wallets w
  WHERE w.user_id = p_agent_id
  LIMIT 1;

  IF v_has_wallet THEN
    RETURN GREATEST(0, COALESCE(v_cached_float, 0));
  END IF;

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
    - COALESCE((
        SELECT SUM(amount)
        FROM public.landlord_payouts
        WHERE agent_id = p_agent_id
          AND status IN ('otp_verified','pending_merchant_payout')
      ), 0)
    - COALESCE((
        SELECT SUM(remaining_amount)
        FROM public.agent_landlord_float_allocations
        WHERE agent_id = p_agent_id
          AND status = 'return_pending'
      ), 0)
  );
END;
$function$;

revoke execute on function public.get_agent_float_balance(uuid) from public, anon;
grant  execute on function public.get_agent_float_balance(uuid) to authenticated, service_role;

revoke execute on function public.get_agent_lp_float_available(uuid) from public, anon;
grant  execute on function public.get_agent_lp_float_available(uuid) to authenticated, service_role;

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