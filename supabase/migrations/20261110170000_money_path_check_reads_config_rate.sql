-- assert_money_path_intact: two checks went stale on 2026-11-10.
--
-- Migration 20261110140741 agent_commission_8pct_to_buffer (applied on production, not in this repo)
-- moved the agent commission rate into field_deposit_commission_config: get_agent_commission_rate now
-- reads get_platform_agent_commission_rate() instead of the literals 0.08 / 0.06. Behaviour is unchanged
-- (8% total, sub-agent 6% + parent 2%, whitelisted sub-agent 8%), but the two checks searched the
-- function text for those literals and have failed since. They now check the configured rate and the
-- split the function computes. Nothing else in the function changes.

CREATE OR REPLACE FUNCTION public.assert_money_path_intact()
 RETURNS TABLE(check_name text, ok boolean, detail text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_alloc text; v_guard text; v_rate_fn text;
BEGIN
  SELECT p.prosrc INTO v_alloc FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='agent_allocate_tenant_payment_internal';
  SELECT p.prosrc INTO v_guard FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='guard_rent_request_agent_updates';
  SELECT p.prosrc INTO v_rate_fn FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='get_agent_commission_rate';

  RETURN QUERY SELECT 'allocator_exists', v_alloc IS NOT NULL, coalesce('length '||length(v_alloc)::text,'MISSING');
  RETURN QUERY SELECT 'float_is_consumed', coalesce(position('agent_float_used_for_rent' in v_alloc)>0,false),
    'the wallet float debit leg must be posted on every collection';
  RETURN QUERY SELECT 'float_leg_matches_guard', coalesce(position('''recipient_type'', ''operational_wallet''' in v_alloc)>0,false),
    'the guard matches on recipient_type=operational_wallet';
  RETURN QUERY SELECT 'repayment_is_verified', coalesce(position('the repayment was not applied' in v_alloc)>0,false),
    'stops commission being paid for a repayment that was reverted';
  RETURN QUERY SELECT 'plan_row_is_locked', coalesce(position('FOR UPDATE' in v_alloc)>0,false),
    'concurrent taps on one plan must queue';

  RETURN QUERY SELECT 'rate_fn_exists', v_rate_fn IS NOT NULL,
    'get_agent_commission_rate is the single source of truth for the split';
  RETURN QUERY SELECT 'allocator_uses_shared_rate', coalesce(position('get_agent_commission_rate' in v_alloc)>0,false),
    'the allocator must not decide the rate itself';
  RETURN QUERY SELECT 'rate_not_reinlined_in_allocator',
    coalesce(position('round(p_amount * 0.10' in v_alloc)=0 AND position('round(p_amount * 0.08' in v_alloc)=0, false),
    'a constant back in the allocator means the screen can disagree with the wallet again';
  -- Since 2026-11-10 (agent_commission_8pct_to_buffer) the rate lives in field_deposit_commission_config
  -- and get_agent_commission_rate reads it, so these two checks test behaviour, not literal text.
  RETURN QUERY SELECT 'rate_fn_total_8_pct',
    coalesce(public.get_platform_agent_commission_rate() = 0.08
             AND (public.get_agent_commission_rate(NULL) ->> 'total_rate')::numeric = 0.08
             AND position('get_platform_agent_commission_rate()' in v_rate_fn) > 0, false),
    'total commission is 8% of the collection (since 2026-11-04; configured rate read by get_agent_commission_rate)';
  RETURN QUERY SELECT 'rate_fn_subagent_6_pct',
    coalesce(position('''agent_rate'', v_total - 0.02, ''recruiter_rate'', 0.02' in v_rate_fn) > 0
             AND public.get_platform_agent_commission_rate() - 0.02 = 0.06, false),
    'a sub-agent keeps 6%, the recruiting parent takes 2%';
  RETURN QUERY SELECT 'rate_fn_honours_whitelist', coalesce(position('is_subagent_commission_whitelisted' in v_rate_fn)>0,false),
    'a whitelisted sub-agent keeps the full 8%';
  RETURN QUERY SELECT 'receipt_states_real_rate', coalesce(position('v_rate ->> ''label''' in v_alloc)>0,false),
    'the commission leg description must state the rate actually paid, not a hard-coded 10%';

  RETURN QUERY SELECT 'unpaid_budget_released', coalesce(position('_release_unpaid_commission_budget' in v_alloc)>0,false),
    'the fee split funds a 10% commission budget; the unpaid part must be released to Platform Fee or X3 goes negative';

  RETURN QUERY SELECT 'custody_leg_absent', coalesce(position('cash_receipt_in_transit' in v_alloc)=0,false),
    'presence means drizzle 0114 was re-applied and float is no longer consumed';
  RETURN QUERY SELECT 'platform_float_leg_absent',
    coalesce(position('''agent_float_used_for_rent'', ''ledger_scope'', ''platform''' in v_alloc)=0,false),
    'sofp_ledger_legs already resolves the wallet float leg to DR A2 and flips the repayment leg to CR A3; adding a platform float counterpart double-counts the debit and unbalances mapped DR/CR by 2x the collection, which raw_net=0 hides from the one_sided/E4 net';
  RETURN QUERY SELECT 'not_frozen', coalesce(position('ALLOCATION_FROZEN' in v_alloc)=0,false),
    'the emergency stub blocks every agent';
  RETURN QUERY SELECT 'guard_trusts_float_leg', coalesce(position('agent_float_used_for_rent' in v_guard)>0,false),
    'the guard must still recognise the shape the allocator writes';
  RETURN QUERY SELECT 'single_overload',
    (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname='agent_allocate_tenant_payment_internal')=1,
    'two overloads means an undeclared deploy added one';
END $function$;
