-- Control fix: require the correct collection shape, don't merely permit it.
--
-- Control change only. The collection accounting is NOT touched: this file does
-- not alter agent_allocate_tenant_payment_internal, ledger_account_map, any
-- ledger row, wallet or repayment record.
--
-- WHAT WAS WRONG WITH THE CHECK SHIPPED IN 20260921120000
-- `custody_leg_paired_with_float` tested that the A5 custody leg and the
-- platform float leg were both present OR both absent:
--
--     (A5 present) = (platform float leg present)
--
-- That correctly refuses the 2026-09-15 drizzle 0114 shape (A5 with no float
-- leg). But BOTH ABSENT also satisfies it, so the check would stay green if the
-- allocator were reverted to the old four-leg shape - the very shape whose A3
-- debit 20260921120000 exists to correct. The check permitted the fix; it did
-- not require it.
--
-- THE REQUIRED CONDITION
--     A5 present AND platform float leg present
--
--   A5 + platform float   -> PASS
--   A5, no platform float -> FAIL   (drizzle 0114 - float stopped being consumed)
--   platform float, no A5 -> FAIL   (custody of the tenant's cash unrecorded)
--   neither               -> FAIL   (reverted to the pre-2026-09-21 A3 debit)
--
-- `float_is_consumed` continues to guarantee the WALLET float leg independently,
-- so all three legs of the corrected entry are now pinned by the detector.

BEGIN;

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
  RETURN QUERY SELECT 'rate_fn_total_10_pct', coalesce(position('''total_rate'', 0.10' in v_rate_fn)>0,false),
    'total commission is 10% of the collection';
  RETURN QUERY SELECT 'rate_fn_subagent_8_pct', coalesce(position('''agent_rate'', 0.08' in v_rate_fn)>0,false),
    'a sub-agent keeps 8%, the recruiting parent takes 2%';
  RETURN QUERY SELECT 'rate_fn_honours_whitelist', coalesce(position('is_subagent_commission_whitelisted' in v_rate_fn)>0,false),
    'a whitelisted sub-agent keeps the full 10%';
  RETURN QUERY SELECT 'receipt_states_real_rate', coalesce(position('v_rate ->> ''label''' in v_alloc)>0,false),
    'the commission leg description must state the rate actually paid, not a hard-coded 10%';

  -- REQUIRES the corrected shape. Both legs must be present; any other
  -- combination fails. See the header for the truth table.
  RETURN QUERY SELECT 'custody_leg_paired_with_float',
    coalesce(
      (position('cash_receipt_in_transit' in v_alloc)>0)
      AND (position('''agent_float_used_for_rent'', ''ledger_scope'', ''platform''' in v_alloc)>0),
      false),
    'the A5 custody leg AND the platform float leg must both be posted: A5 alone is drizzle 0114 with float no longer consumed, and neither present is the pre-2026-09-21 shape that debited A3 on a repayment';
  RETURN QUERY SELECT 'not_frozen', coalesce(position('ALLOCATION_FROZEN' in v_alloc)=0,false),
    'the emergency stub blocks every agent';
  RETURN QUERY SELECT 'guard_trusts_float_leg', coalesce(position('agent_float_used_for_rent' in v_guard)>0,false),
    'the guard must still recognise the shape the allocator writes';
  RETURN QUERY SELECT 'single_overload',
    (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname='agent_allocate_tenant_payment_internal')=1,
    'two overloads means an undeclared deploy added one';
END $function$;

-- Refuse to leave a failing money path behind.
DO $verify$
DECLARE v_failed text;
BEGIN
  SELECT string_agg(check_name, ', ') INTO v_failed
    FROM public.assert_money_path_intact() WHERE NOT ok;
  IF v_failed IS NOT NULL THEN
    RAISE EXCEPTION
      'Refused: strengthening the check leaves the money path failing (%). Rolling back.',
      v_failed USING ERRCODE = '55000';
  END IF;
END
$verify$;

-- This migration changes a baselined function, so it moves the baseline with
-- it, in the same transaction. No-ops with a notice if 20260921110000 has not
-- been applied yet.
DO $rebaseline$
BEGIN
  UPDATE public.critical_function_baselines
     SET expected_sha256 = encode(sha256(convert_to(
           pg_get_functiondef('assert_money_path_intact()'::regprocedure), 'UTF8')), 'hex'),
         baselined_at = now(),
         baselined_by = 'migration 20260921130000',
         note         = 'the detector itself: weakening a check must be as visible as weakening the code'
   WHERE function_signature = 'assert_money_path_intact()';

  IF NOT FOUND THEN
    RAISE NOTICE 'no baseline row for assert_money_path_intact() - apply 20260921110000 next';
  END IF;
END
$rebaseline$;

COMMIT;
