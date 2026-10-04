-- Fix the inverted collection ledger direction, and keep it fixed.
--
-- INCIDENT, 2026-09-10 07:29:39 -> 09:21:56 EAT
-- New overloads of agent_allocate_tenant_payment / _internal carrying a
-- `p_client_ref` parameter were deployed straight to production, with no
-- migration in this repository. They reversed BOTH legs of the collection
-- entry, so every collection did the opposite of its job: instead of the agent
-- spending float to settle a tenant's rent, the platform CREDITED the agent's
-- float, still paid 10% commission, and still cleared the tenant's debt.
--
-- 16 collections, 3 agents, 6,064,036 of float wrongly credited and 606,403.60
-- of commission. Reversed as system corrections; 183,334.80 unrecoverable and
-- written off rather than driving two already-negative agents further negative.
--
-- Four things were wrong. All four are corrected here:
--   1. agent leg    'agent_float_used_for_rent'   cash_in  -> cash_out
--   2. tenant leg   platform repayment            cash_out -> cash_in
--   3. receipt col  float_after = balance + amount -> GREATEST(0, balance - amount)
--   4. guard_rent_request_agent_updates trusted-allocation test, which had been
--      changed to expect cash_in and therefore waved the inverted entries
--      through. A guard that is edited to match a bug stops being a guard.
--
-- WHY THIS MIGRATION IS WRITTEN AS A CONDITIONAL REPAIR RATHER THAN A REWRITE
-- The broken version is not in source control, so it can be redeployed at any
-- time by whoever deployed it. Restating the whole function here would fight
-- that deployment and could clobber the legitimate `p_client_ref` idempotency
-- work it carries. Instead this patches only the four wrong things, in place,
-- and does nothing at all when they are already correct - so it is safe to run
-- repeatedly and safe to run after a redeployment.
--
-- THIS IS A BACKSTOP, NOT A SOLUTION. The real fix is that money-path RPCs and
-- their guards must not be deployed outside a reviewed migration.

DO $migration$
DECLARE
  v_def text;
  v_n   int;
BEGIN
  ---------------------------------------------------------------- collection RPC
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'agent_allocate_tenant_payment_internal'
  LIMIT 1;

  IF v_def IS NOT NULL THEN
    -- 1. the agent's float must be DEBITED when they settle a tenant's rent
    v_def := replace(v_def,
      'jsonb_build_object(''user_id'', p_agent_id, ''amount'', p_amount, ''direction'', ''cash_in'',',
      'jsonb_build_object(''user_id'', p_agent_id, ''amount'', p_amount, ''direction'', ''cash_out'',');

    -- 2. the platform tenant-repayment leg must be a CREDIT
    v_def := replace(v_def,
      'jsonb_build_object(''user_id'', p_tenant_id, ''amount'', p_amount, ''direction'', ''cash_out'',',
      'jsonb_build_object(''user_id'', p_tenant_id, ''amount'', p_amount, ''direction'', ''cash_in'',');

    -- 3. the receipt's float_after audit column must fall, not rise
    v_def := replace(v_def, 'v_float_balance + p_amount', 'GREATEST(0, v_float_balance - p_amount)');

    EXECUTE v_def;
  END IF;

  ------------------------------------------------------------------------ guard
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'guard_rent_request_agent_updates'
  LIMIT 1;

  IF v_def IS NOT NULL THEN
    v_n := (length(v_def) - length(replace(v_def, 'gl.direction = ''cash_in''', ''))) / length('gl.direction = ''cash_in''');
    -- exactly one such test exists, and it belongs to the float-debit shape
    IF v_n = 1 AND position('agent_float_used_for_rent' in v_def) > 0 THEN
      v_def := replace(v_def, 'gl.direction = ''cash_in''', 'gl.direction = ''cash_out''');
      EXECUTE v_def;
    END IF;
  END IF;
END
$migration$;

-- Post-condition: a collection must debit the agent's float. If this ever fails
-- again, the deployment that broke it did so outside source control.
DO $verify$
DECLARE v_ok boolean;
BEGIN
  SELECT p.prosrc LIKE '%p_agent_id, ''amount'', p_amount, ''direction'', ''cash_out''%'
    INTO v_ok
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'agent_allocate_tenant_payment_internal'
  LIMIT 1;

  IF v_ok IS NOT TRUE THEN
    RAISE EXCEPTION
      'agent_allocate_tenant_payment_internal does not debit agent float - refusing to leave the collection path inverted';
  END IF;
END
$verify$;
