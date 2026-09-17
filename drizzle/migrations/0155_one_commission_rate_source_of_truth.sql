-- One commission rate, decided in one place, read by everyone.
--
-- THE COMPLAINT
-- Agent +256748787893 (KENNETH DERRICK DALAA SEKABEMBE) reported that he is
-- "not getting commission" on his rent collections. He is. Every collection he
-- has made paid out correctly:
--
--   8,000 collected -> 640 to him (8%) + 160 to his recruiter (2%)
--
-- He is a sub-agent: linked to Ssebunya Yasin on 2026-06-28, status `verified`,
-- not whitelisted. 8% is exactly what the signed agent agreement promises him
-- (AgentAgreementContent.ts section B) and exactly what the allocator pays.
--
-- What is wrong is the SCREEN. `AgentTenantCollectDialog.tsx` hard-codes 10%
-- in four places and never asks what the agent actually earns, so it promised
-- him 800 and his wallet received 640. `AgentTopUpTenantDialog.tsx` does the
-- same. The ledger leg description repeats the error - it reads "10% commission
-- on rent collection allocation" while carrying 640 - so the receipt does not
-- correct the screen either.
--
-- VERIFIED BEFORE WRITING THIS: the money is right. Across all 222 collections
-- since the 2026-09-16 float fix (48 agents), agent share + recruiter override
-- equals exactly 10% of the collection on 222 of 222. 118 correct 8/2 splits,
-- 104 correct full 10%, zero mismatches, zero missing float legs. This
-- migration changes NO amount. It is a truth-in-display fix.
--
-- SCOPE OF THE DISPLAY DEFECT
--   32,199 verified sub-agent links across 751 recruiters
--        4 whitelisted back to the full 10%
--       64 sub-agents actually collected in September, paid UGX 12,200,784
--       22 recruiters took UGX 4,880,314 in overrides
-- Every one of those 64 saw "10%" on screen. Any of the other ~32,000 will the
-- moment they collect.
--
-- WHY THE FIX IS A SHARED FUNCTION AND NOT A SECOND COPY OF THE RULE
-- The obvious patch is to work the rate out in TypeScript. That is how this
-- defect was born: `v_total_commission := round(p_amount * 0.10, 2)` lives
-- inside the allocator, the UI could not reach it, so someone re-typed the
-- constant. One money rule in two places, drifting silently, is the same shape
-- as all three incidents this week (2026-09-10, 2026-09-15, and approve-deposit
-- before them).
--
-- So the rate moves OUT of the allocator into `get_agent_commission_rate`, and
-- the allocator calls it. The screen calls `get_my_commission_rate`, which is
-- the same function behind an auth.uid() wrapper. They cannot disagree, because
-- there is only one of them.
--
-- WHAT THIS CHANGES
--   NEW  get_agent_commission_rate(uuid)  the single decision (not client-callable)
--   NEW  get_my_commission_rate()         the caller's own rate, for the UI
--   MOD  agent_allocate_tenant_payment_internal
--          - reads the rate from the shared function instead of inlining it
--          - the commission leg description states the rate actually paid
--          - the RPC response carries `rate` and `rate_label`
--   MOD  assert_money_path_intact()       two checks re-pointed, four added
--
-- WHAT THIS DELIBERATELY DOES NOT CHANGE
--   * Any amount. The arithmetic is identical and Part E proves it agent by
--     agent against the old inline predicate before anything is committed.
--   * The recruiter leg's "2% recruiter override..." description. 2% is the
--     residual of 10 - 8 and is always literally 2%, and reporting greps that
--     string. Only the leg that was actually wrong is corrected.
--   * The whitelist. `agent_ops_set_subagent_commission_whitelist` remains the
--     lever for putting a specific sub-agent back on the full 10%. That is a
--     commercial decision and must NOT be used to close this defect - it would
--     fix one agent and leave 32,198 still reading the wrong number.

-- A. The single decision -----------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_agent_commission_rate(p_agent_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $rate$
DECLARE
  v_parent uuid;
  v_whitelisted boolean := false;
BEGIN
  IF p_agent_id IS NULL THEN
    RETURN jsonb_build_object('agent_rate', 0.10, 'recruiter_rate', 0,
      'total_rate', 0.10, 'is_subagent', false, 'whitelisted', false,
      'recruiter_id', NULL, 'label', '10%');
  END IF;

  -- Identical predicate to the one that lived in the allocator. A link only
  -- counts when it is verified AND is not the agent pointing at themselves.
  SELECT sa.parent_agent_id INTO v_parent
    FROM public.agent_subagents sa
   WHERE sa.sub_agent_id = p_agent_id
     AND sa.status IN ('verified', 'approved', 'accepted')
     AND sa.parent_agent_id <> p_agent_id
   LIMIT 1;

  v_whitelisted := public.is_subagent_commission_whitelisted(p_agent_id);

  IF v_parent IS NOT NULL AND NOT v_whitelisted THEN
    RETURN jsonb_build_object(
      'agent_rate', 0.08, 'recruiter_rate', 0.02, 'total_rate', 0.10,
      'is_subagent', true, 'whitelisted', false,
      'recruiter_id', v_parent, 'label', '8%');
  END IF;

  RETURN jsonb_build_object(
    'agent_rate', 0.10, 'recruiter_rate', 0, 'total_rate', 0.10,
    'is_subagent', v_parent IS NOT NULL, 'whitelisted', COALESCE(v_whitelisted, false),
    'recruiter_id', v_parent, 'label', '10%');
END $rate$;

-- Not client-callable: it takes an arbitrary agent id and returns that agent's
-- recruiter. The allocator is SECURITY DEFINER owned by postgres, so it reaches
-- this regardless of the grants below.
REVOKE ALL ON FUNCTION public.get_agent_commission_rate(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_agent_commission_rate(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.get_agent_commission_rate(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.get_agent_commission_rate(uuid) TO service_role;

COMMENT ON FUNCTION public.get_agent_commission_rate(uuid) IS
  'THE commission rate for an agent. agent_allocate_tenant_payment_internal and '
  'get_my_commission_rate both read this - do not re-implement the split anywhere '
  'else, in SQL or in the client. Guarded by assert_money_path_intact().';

-- B. What the screen asks -----------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_my_commission_rate()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $mine$
  SELECT public.get_agent_commission_rate(auth.uid());
$mine$;

GRANT EXECUTE ON FUNCTION public.get_my_commission_rate() TO authenticated;

COMMENT ON FUNCTION public.get_my_commission_rate() IS
  'The calling agent''s own commission rate, for the collect dialog to show '
  'before a collection is made. Same source as the allocator, so the screen '
  'cannot promise a rate the wallet does not pay.';

-- C. Point the allocator at it ------------------------------------------------
-- Patched in place (pg_get_functiondef -> replace -> EXECUTE) rather than
-- restated: this function carries work that is not in this repository and
-- restating it would clobber that. Every anchor is asserted before it is used.
DO $alloc$
DECLARE v_def text; v_before text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'agent_allocate_tenant_payment_internal';
  IF v_def IS NULL THEN RAISE EXCEPTION 'agent_allocate_tenant_payment_internal missing'; END IF;

  IF position('get_agent_commission_rate' in v_def) > 0 THEN
    RAISE NOTICE 'allocator already reads the shared rate function'; RETURN;
  END IF;
  v_before := v_def;

  -- C1. a variable to hold it
  IF position('  v_fee jsonb := jsonb_build_object(''status'',''not_attempted'');' in v_def) = 0 THEN
    RAISE EXCEPTION 'DECLARE anchor not found - inspect by hand';
  END IF;
  v_def := replace(v_def,
    '  v_fee jsonb := jsonb_build_object(''status'',''not_attempted'');',
    '  v_rate jsonb;' || chr(10) ||
    '  v_fee jsonb := jsonb_build_object(''status'',''not_attempted'');');

  -- C2. the rate decision itself
  IF position('v_total_commission := round(p_amount * 0.10, 2);' in v_def) = 0 THEN
    RAISE EXCEPTION 'commission block not found - inspect by hand';
  END IF;
  v_def := replace(v_def,
    '  v_total_commission := round(p_amount * 0.10, 2);' || chr(10) || chr(10) ||
    '  SELECT sa.parent_agent_id INTO v_parent_agent_id' || chr(10) ||
    '    FROM public.agent_subagents sa' || chr(10) ||
    '   WHERE sa.sub_agent_id = p_agent_id' || chr(10) ||
    '     AND sa.status IN (''verified'', ''approved'', ''accepted'')' || chr(10) ||
    '     AND sa.parent_agent_id <> p_agent_id' || chr(10) ||
    '   LIMIT 1;' || chr(10) || chr(10) ||
    '  v_whitelisted := public.is_subagent_commission_whitelisted(p_agent_id);' || chr(10) || chr(10) ||
    '  IF v_parent_agent_id IS NOT NULL AND NOT v_whitelisted THEN' || chr(10) ||
    '    v_commission_earned := round(p_amount * 0.08, 2);' || chr(10) ||
    '    v_parent_override   := v_total_commission - v_commission_earned;' || chr(10) ||
    '  ELSE' || chr(10) ||
    '    v_commission_earned := v_total_commission;' || chr(10) ||
    '    v_parent_override   := 0;' || chr(10) ||
    '  END IF;',
    -- ---- replacement ----
    '  -- THE RATE IS NOT DECIDED HERE. `get_agent_commission_rate` is the single' || chr(10) ||
    '  -- source of truth, and `get_my_commission_rate` shows the agent the same' || chr(10) ||
    '  -- number BEFORE they collect. Re-inlining 0.10 / 0.08 here would let the' || chr(10) ||
    '  -- screen and the wallet disagree again - assert_money_path_intact() fails' || chr(10) ||
    '  -- if that happens.' || chr(10) ||
    '  v_rate := public.get_agent_commission_rate(p_agent_id);' || chr(10) ||
    '  v_parent_agent_id   := nullif(v_rate ->> ''recruiter_id'', '''')::uuid;' || chr(10) ||
    '  v_whitelisted       := COALESCE((v_rate ->> ''whitelisted'')::boolean, false);' || chr(10) ||
    '  v_total_commission  := round(p_amount * (v_rate ->> ''total_rate'')::numeric, 2);' || chr(10) ||
    '  v_commission_earned := round(p_amount * (v_rate ->> ''agent_rate'')::numeric, 2);' || chr(10) ||
    '  -- The recruiter takes the RESIDUAL, never its own rounding. Rounding both' || chr(10) ||
    '  -- sides independently can leave the two cash_in legs a cent short of the' || chr(10) ||
    '  -- cash_out payable leg, and trg_enforce_ledger_group_balance would then' || chr(10) ||
    '  -- refuse the whole collection.' || chr(10) ||
    '  v_parent_override   := v_total_commission - v_commission_earned;');

  -- C3. stop the receipt claiming 10% while paying 8%
  IF position('ELSE ''10% commission on rent collection allocation'' END,' in v_def) = 0 THEN
    RAISE EXCEPTION 'commission leg description not found - inspect by hand';
  END IF;
  v_def := replace(v_def,
    'ELSE ''10% commission on rent collection allocation'' END,',
    'ELSE format(''%s commission on rent collection allocation'', v_rate ->> ''label'') END,');

  -- C4. hand the rate back so the post-collection screen need not guess
  IF position('''full_commission_whitelisted'', v_whitelisted)' in v_def) = 0 THEN
    RAISE EXCEPTION 'response commission block not found - inspect by hand';
  END IF;
  v_def := replace(v_def,
    '''full_commission_whitelisted'', v_whitelisted)',
    '''full_commission_whitelisted'', v_whitelisted,' || chr(10) ||
    '      ''rate'', (v_rate ->> ''agent_rate'')::numeric,' || chr(10) ||
    '      ''rate_label'', v_rate ->> ''label'',' || chr(10) ||
    '      ''recruiter_rate'', (v_rate ->> ''recruiter_rate'')::numeric)');

  IF v_def = v_before THEN RAISE EXCEPTION 'nothing changed'; END IF;
  EXECUTE v_def;
  RAISE NOTICE 'allocator now reads the shared rate function';
END $alloc$;

-- D. Teach the drift detector the new shape -----------------------------------
-- Two existing checks assert the literal strings `round(p_amount * 0.10, 2)`
-- and `round(p_amount * 0.08, 2)` inside the allocator. Part C removes both, so
-- leaving them would trip the alarm this migration is meant to keep honest.
-- They are re-pointed at the function that now holds the constants, and the
-- allocator is checked for the opposite: that the constants have NOT come back.
CREATE OR REPLACE FUNCTION public.assert_money_path_intact()
RETURNS TABLE(check_name text, ok boolean, detail text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $drift$
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

  -- Commission: the rate lives in ONE function and the allocator must read it.
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

  RETURN QUERY SELECT 'custody_leg_absent', coalesce(position('cash_receipt_in_transit' in v_alloc)=0,false),
    'presence means drizzle 0114 was re-applied and float is no longer consumed';
  RETURN QUERY SELECT 'not_frozen', coalesce(position('ALLOCATION_FROZEN' in v_alloc)=0,false),
    'the emergency stub blocks every agent';
  RETURN QUERY SELECT 'guard_trusts_float_leg', coalesce(position('agent_float_used_for_rent' in v_guard)>0,false),
    'the guard must still recognise the shape the allocator writes';
  RETURN QUERY SELECT 'single_overload',
    (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname='agent_allocate_tenant_payment_internal')=1,
    'two overloads means an undeclared deploy added one';
END $drift$;

-- The two retired check names can never report `ok` again, so any open event
-- against them would stay open forever. There are none today (drift is clean),
-- but resolve defensively so this is safe to re-run.
UPDATE public.money_path_drift_events
   SET resolved_at = now()
 WHERE resolved_at IS NULL
   AND check_name IN ('commission_rate_10_pct', 'subagent_split_8_pct');

-- E. Prove no amount moved ----------------------------------------------------
DO $verify$
DECLARE v_bad int; v_agents int; v_fail text;
BEGIN
  -- E1. The new function must agree with the OLD inline predicate for every
  -- agent who has ever collected. This is the check that matters: if it passes,
  -- no agent's pay changes by a shilling.
  WITH agents AS (
    SELECT DISTINCT agent_id FROM public.agent_collections WHERE agent_id IS NOT NULL
  ), old AS (
    SELECT a.agent_id,
           (SELECT sa.parent_agent_id FROM public.agent_subagents sa
             WHERE sa.sub_agent_id = a.agent_id
               AND sa.status IN ('verified','approved','accepted')
               AND sa.parent_agent_id <> a.agent_id LIMIT 1) AS parent,
           public.is_subagent_commission_whitelisted(a.agent_id) AS wl
      FROM agents a
  ), expected AS (
    SELECT o.agent_id,
           CASE WHEN o.parent IS NOT NULL AND NOT o.wl THEN 0.08 ELSE 0.10 END AS rate
      FROM old o
  )
  SELECT count(*), count(*) FILTER (
           WHERE (public.get_agent_commission_rate(e.agent_id) ->> 'agent_rate')::numeric
                 IS DISTINCT FROM e.rate)
    INTO v_agents, v_bad
    FROM expected e;

  IF v_bad > 0 THEN
    RAISE EXCEPTION 'rate function disagrees with the old inline rule for % of % agents - rolled back',
      v_bad, v_agents;
  END IF;
  RAISE NOTICE 'rate function matches the previous behaviour for all % collecting agents', v_agents;

  -- E2. The split must still close to exactly 10%, or the ledger balance
  -- trigger would refuse the next collection.
  SELECT count(*) INTO v_bad
    FROM (SELECT DISTINCT agent_id FROM public.agent_collections WHERE agent_id IS NOT NULL) a,
         LATERAL public.get_agent_commission_rate(a.agent_id) r
   WHERE (r ->> 'agent_rate')::numeric + (r ->> 'recruiter_rate')::numeric
         IS DISTINCT FROM (r ->> 'total_rate')::numeric;
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'agent + recruiter does not equal total for % agents - rolled back', v_bad;
  END IF;

  -- E3. The drift detector must be green on its own new checks.
  SELECT string_agg(c.check_name, ', ') INTO v_fail
    FROM public.assert_money_path_intact() c WHERE NOT c.ok;
  IF v_fail IS NOT NULL THEN
    RAISE EXCEPTION 'money path drift after this migration: % - rolled back', v_fail;
  END IF;

  RAISE NOTICE 'commission rate now has one source of truth; no amount changed';
END $verify$;