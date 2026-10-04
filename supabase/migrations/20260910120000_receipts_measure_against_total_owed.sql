-- D1: a receipt must be measured against everything the tenant owes, not just
-- today's instalment.
--
-- THE DEFECT (found in the SMALLS Ronald Musana end-to-end test, 2026-09-10)
-- The collection wrapper stamped the receipt like this:
--
--     v_expected  := agent_expected_collection(plan);          -- TODAY only
--     v_shortfall := GREATEST(0, v_expected - amount);
--     v_is_partial := v_expected > 0 AND amount < v_expected;
--
-- So an agent who collects exactly one day's instalment from a tenant who is
-- five days behind gets a receipt stamped `shortfall 0, is_partial false` -
-- "paid in full" - while 19,068 is still owed. Measured on the live plan:
--
--   scenario            paid    stamped shortfall   truth after the payment
--   one day behind      4,767   0, not partial      today got nothing
--   five days behind    4,767   0, not partial      4 days / 19,068 behind
--   expired cycle       4,767   0, not partial      29 days / 138,233 owed
--
-- Every ops surface that counts partial collections (PartialCollectionsPanel,
-- agent_ops_report_agent_tenant_ledgers, the agent monitoring feeds) therefore
-- under-counts. This is a reporting fault, not a money fault: the ledger, the
-- day settlements and the arrears queue were all correct throughout.
--
-- THE FIX
-- `expected_amount` keeps its established meaning - TODAY's pinned instalment -
-- because existing reports sum it against the pinned bill. Two new columns
-- record what was actually owed at the moment of payment, and `shortfall_amount`
-- and `is_partial` are measured against that total instead:
--
--     total_due = LEAST(today's instalment + arrears, outstanding)
--     shortfall = GREATEST(0, total_due - amount)
--     is_partial = total_due > 0 AND amount < total_due
--
-- The LEAST() cap matters: a tenant can never be recorded as owing more than
-- their plan's outstanding balance.
--
-- TIMING. Arrears are 0 right now - the queue went live today (2026-09-10) and
-- no day before today is in scope - so this changes nothing on today's 43
-- receipts. It starts telling the truth tomorrow, when today becomes yesterday.
--
-- NOTE ON HOW THE WRAPPER IS PATCHED. `agent_allocate_tenant_payment` is
-- deployed outside this repository (that is what caused the 2026-09-10 inverted
-- collection incident). Restating it here would fight that deployment and could
-- clobber the `p_client_ref` idempotency work it carries. So this patches the
-- live definition in place, is a no-op when already patched, and asserts that
-- every edit landed.

-- 1. Where the money actually stands ------------------------------------
CREATE OR REPLACE FUNCTION public.rent_plan_arrears_ugx(p_rent_request_id uuid)
RETURNS numeric
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  SELECT COALESCE(SUM(l.remaining_ugx), 0)
    FROM public.v_rent_day_ledger l
   WHERE l.rent_request_id = p_rent_request_id
     AND l.day < (now() AT TIME ZONE 'Africa/Kampala')::date;
$function$;

COMMENT ON FUNCTION public.rent_plan_arrears_ugx(uuid) IS
  'Unsettled instalments on days before today, for days inside the arrears window. '
  'Scoped by rent_arrears_go_live(): days before the floor are not owed to this engine.';

CREATE OR REPLACE FUNCTION public.rent_plan_amount_due_now(p_rent_request_id uuid)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  SELECT jsonb_build_object(
           'rent_request_id', p_rent_request_id,
           'expected_today',  e.expected_today,
           'arrears',         e.arrears,
           'outstanding',     e.outstanding,
           'total_due',       LEAST(e.expected_today + e.arrears, e.outstanding))
    FROM (
      SELECT COALESCE(public.agent_expected_collection(p_rent_request_id), 0) AS expected_today,
             COALESCE(public.rent_plan_arrears_ugx(p_rent_request_id), 0)     AS arrears,
             GREATEST(0, COALESCE(rr.total_repayment, 0) - COALESCE(rr.amount_repaid, 0)) AS outstanding
        FROM public.rent_requests rr
       WHERE rr.id = p_rent_request_id
    ) e;
$function$;

COMMENT ON FUNCTION public.rent_plan_amount_due_now(uuid) IS
  'What a tenant owes right now: today''s pinned instalment plus arrears, capped at outstanding. '
  'This is what a collection is judged against - agent_expected_collection() alone is today only.';

GRANT EXECUTE ON FUNCTION public.rent_plan_arrears_ugx(uuid)     TO authenticated;
GRANT EXECUTE ON FUNCTION public.rent_plan_amount_due_now(uuid)  TO authenticated;

-- 2. Record what was owed, on the receipt itself -------------------------
ALTER TABLE public.agent_collections
  ADD COLUMN IF NOT EXISTS arrears_amount   numeric,
  ADD COLUMN IF NOT EXISTS total_due_amount numeric;

COMMENT ON COLUMN public.agent_collections.expected_amount IS
  'Today''s pinned instalment for this plan at the moment of collection. Unchanged meaning.';
COMMENT ON COLUMN public.agent_collections.arrears_amount IS
  'Unsettled instalments from days BEFORE today, at the moment of collection. NULL on receipts '
  'written before 2026-09-10, which were measured against today only.';
COMMENT ON COLUMN public.agent_collections.total_due_amount IS
  'expected_amount + arrears_amount, capped at outstanding. shortfall_amount and is_partial are '
  'measured against this.';

-- 3. Patch the live wrapper in place -------------------------------------
DO $migration$
DECLARE
  v_def   text;
  v_after text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'agent_allocate_tenant_payment'
   LIMIT 1;

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'agent_allocate_tenant_payment not found';
  END IF;

  -- Already patched (or redeployed with the fix): nothing to do.
  IF position('v_total_due' in v_def) > 0 THEN
    RAISE NOTICE 'agent_allocate_tenant_payment already measures against total due - skipping';
    RETURN;
  END IF;

  v_after := v_def;

  -- Every anchor below is a SINGLE line that is byte-identical in the deployed
  -- definition and in 20260909180000_agent_collection_client_ref_idempotency.sql.
  -- The two differ in line wrapping around the UPDATE, so multi-line anchors
  -- would match one and not the other, and the migration would abort on a
  -- rebuilt environment.

  -- 3a. declarations
  v_after := replace(v_after,
    '  v_is_partial boolean := false;',
    '  v_is_partial boolean := false;' || E'\n' ||
    '  v_arrears numeric := 0; v_total_due numeric := 0; v_due jsonb;');

  -- 3b. the measurement itself. `v_expected` keeps its own assignment above
  -- (today's pinned instalment); what changes is what the payment is JUDGED
  -- against - today's instalment plus arrears, capped at outstanding.
  v_after := replace(v_after,
    '  v_shortfall := GREATEST(0, v_expected - COALESCE(p_amount, 0));',
    '  v_due       := public.rent_plan_amount_due_now(p_rent_request_id);' || E'\n' ||
    '  v_arrears   := COALESCE((v_due->>''arrears'')::numeric, 0);' || E'\n' ||
    '  v_total_due := COALESCE((v_due->>''total_due'')::numeric, 0);' || E'\n' ||
    '  v_shortfall := GREATEST(0, v_total_due - COALESCE(p_amount, 0));');

  v_after := replace(v_after,
    '  v_is_partial := v_expected > 0 AND COALESCE(p_amount, 0) < v_expected;',
    '  v_is_partial := v_total_due > 0 AND COALESCE(p_amount, 0) < v_total_due;');

  -- 3c. persist the new columns on the receipt
  v_after := replace(v_after,
    '         SET expected_amount = v_expected,',
    '         SET arrears_amount = v_arrears, total_due_amount = v_total_due,' || E'\n' ||
    '             expected_amount = v_expected,');

  -- 3d. return them to the caller so the confirmation screen can show them
  v_after := replace(v_after,
    '      ''expected_amount'', v_expected,',
    '      ''arrears_amount'', v_arrears, ''total_due_amount'', v_total_due,' || E'\n' ||
    '      ''expected_amount'', v_expected,');

  -- Every edit must have landed. A partial patch would leave the function
  -- referencing variables it never declared, so fail loudly instead.
  IF position('v_arrears numeric := 0' in v_after) = 0
     OR position('rent_plan_amount_due_now' in v_after) = 0
     OR position('v_total_due > 0 AND COALESCE(p_amount, 0) < v_total_due' in v_after) = 0
     OR position('arrears_amount = v_arrears' in v_after) = 0
     OR position('''arrears_amount'', v_arrears' in v_after) = 0 THEN
    RAISE EXCEPTION
      'agent_allocate_tenant_payment did not match the expected shape - refusing a partial patch. '
      'The live definition has changed; re-derive the replacements before re-running.';
  END IF;

  EXECUTE v_after;
END
$migration$;

-- 4. Post-condition -------------------------------------------------------
DO $verify$
DECLARE v_ok boolean;
BEGIN
  SELECT p.prosrc LIKE '%v_total_due > 0 AND COALESCE(p_amount, 0) < v_total_due%'
    INTO v_ok
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'agent_allocate_tenant_payment'
   LIMIT 1;

  IF v_ok IS NOT TRUE THEN
    RAISE EXCEPTION
      'agent_allocate_tenant_payment still measures partials against today only';
  END IF;
END
$verify$;
