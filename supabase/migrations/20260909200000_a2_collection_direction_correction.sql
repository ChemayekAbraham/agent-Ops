-- =====================================================================
-- A2 collection-direction correction (landlord/rent tenant collections)
-- =====================================================================
-- DEFECT
--   Agent float was being consumed TWICE per rent cycle:
--     1. rent_payment_for_tenant   (wallet, cash_out) -> CR A2  [CORRECT: disbursement]
--     2. agent_float_used_for_rent (wallet, cash_out) -> CR A2  [WRONG: collection]
--   Tenant collection is cash RECEIVED and physically held by the agent, so it
--   must INCREASE A2 (Cash at Hand - Float with Agents), not decrease it.
--
-- CORRECTION (collection group)
--   wallet.agent_float_used_for_rent     cash_in  -> DR A2  (float projection +)
--   platform.tenant_repayment_collected  cash_out -> CR A3  (receivable discharged)
--   wallet.agent_commission_earned       cash_in  -> CR L1
--   platform.agent_commission_payable    cash_out -> DR X3
--   raw: balanced (unchanged)   mapped: DR = CR (previously imbalanced by -2x)
--
-- WHY A NEW CATEGORY IS REQUIRED
--   DR A2 together with a float increase is only achievable with a wallet
--   cash_in leg, because wallet_route_for_category derives its sign from
--   direction with no per-category override. The raw-direction control then
--   forces the A3 credit leg to be cash_out, which requires a category mapped
--   to A3 with debit_when='cash_in'. platform.tenant_repayment is
--   debit_when='cash_out' and is therefore structurally unusable here. It is
--   left completely untouched so historical rows and every other repayment
--   path keep their existing meaning.
--
-- NOT CHANGED: compute_rent_repayment, tenant pricing, the 10% commission rule,
--   fee allocation, L7/R1 fee accounting, idempotency, A1/A5 treasury
--   architecture, agent settlement, historical rows, agent_float_assignment.
--   No backfill, no system_balance_correction, no corrective journals.
--   INSUFFICIENT_FLOAT is preserved verbatim: it guards float already consumed
--   by rent disbursement and remains meaningful after this correction.
--
-- APPLIED TO PRODUCTION 2026-09-10. The mapping insert and the three reader
-- patches below were applied verbatim. The allowlist, collection function,
-- guard trigger and reversal were applied as the equivalent explicit
-- CREATE OR REPLACE statements (identical resulting definitions) because the
-- environment's SQL gateway rejects dynamic DO/EXECUTE DDL. Every block here
-- is idempotent, so a fresh replay of the migration series reproduces the same
-- end state and re-running against the patched database is a no-op.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Minimum new mapping: platform.tenant_repayment_collected -> CR A3
-- ---------------------------------------------------------------------
INSERT INTO public.ledger_account_map (ledger_scope, category, wallet_bucket, account_code, debit_when)
SELECT 'platform', 'tenant_repayment_collected', NULL, 'A3', 'cash_in'
WHERE NOT EXISTS (
  SELECT 1 FROM public.ledger_account_map
   WHERE ledger_scope = 'platform'
     AND category = 'tenant_repayment_collected'
     AND wallet_bucket IS NULL
);

-- ---------------------------------------------------------------------
-- 2. Strict-mode allowlist entry (appended next to tenant_repayment)
-- ---------------------------------------------------------------------
DO $mig$
DECLARE v_def text; v_new text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'ledger_category_allowlist'
     AND pg_get_function_identity_arguments(p.oid) = '';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'ledger_category_allowlist() not found';
  END IF;

  IF position('tenant_repayment_collected' in v_def) > 0 THEN
    RAISE NOTICE 'allowlist already contains tenant_repayment_collected';
  ELSE
    v_new := replace(v_def, ',tenant_repayment,', ',tenant_repayment,tenant_repayment_collected,');
    IF v_new = v_def THEN
      RAISE EXCEPTION 'allowlist patch failed: anchor ",tenant_repayment," not found';
    END IF;
    EXECUTE v_new;
  END IF;
END
$mig$;

-- ---------------------------------------------------------------------
-- 3. Collection function: flip the A2 leg, swap the A3-discharge category,
--    and correct the float_before/float_after snapshot to an increase.
-- ---------------------------------------------------------------------
DO $mig$
DECLARE v_def text; v_new text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'agent_allocate_tenant_payment_internal';
  IF v_def IS NULL THEN
    RAISE EXCEPTION 'agent_allocate_tenant_payment_internal not found';
  END IF;
  v_new := v_def;

  -- (a) wallet A2 leg: cash_out -> cash_in (DR A2, float increases)
  v_new := replace(v_new,
    $x$'amount', p_amount, 'direction', 'cash_out',
      'category', 'agent_float_used_for_rent'$x$,
    $x$'amount', p_amount, 'direction', 'cash_in',
      'category', 'agent_float_used_for_rent'$x$);

  -- (b) description reflects cash received, not float spent
  v_new := replace(v_new,
    $x$'Tenant rent collection from agent wallet float'$x$,
    $x$'Tenant rent cash collected and held by agent'$x$);

  -- (c) A3 discharge leg: tenant_repayment/cash_in -> tenant_repayment_collected/cash_out
  v_new := replace(v_new,
    $x$'amount', p_amount, 'direction', 'cash_in',
      'category', 'tenant_repayment', 'ledger_scope', 'platform'$x$,
    $x$'amount', p_amount, 'direction', 'cash_out',
      'category', 'tenant_repayment_collected', 'ledger_scope', 'platform'$x$);

  -- (d) agent_collections float snapshot: float now increases
  v_new := replace(v_new,
    $x$v_float_balance, GREATEST(0, v_float_balance - p_amount), v_tracking_id, p_notes, p_client_ref$x$,
    $x$v_float_balance, v_float_balance + p_amount, v_tracking_id, p_notes, p_client_ref$x$);

  -- (e) returned float figures
  v_new := replace(v_new,
    $x$'float_before', v_float_balance, 'float_after', GREATEST(0, v_float_balance - p_amount),
    'wallet_float_before', v_float_balance, 'wallet_float_after', GREATEST(0, v_float_balance - p_amount),$x$,
    $x$'float_before', v_float_balance, 'float_after', v_float_balance + p_amount,
    'wallet_float_before', v_float_balance, 'wallet_float_after', v_float_balance + p_amount,$x$);

  -- Assertions: every intended edit must have landed.
  IF position($x$'direction', 'cash_in',
      'category', 'agent_float_used_for_rent'$x$ in v_new) = 0 THEN
    RAISE EXCEPTION 'patch (a) failed: A2 leg direction not flipped';
  END IF;
  IF position($x$'category', 'tenant_repayment_collected'$x$ in v_new) = 0 THEN
    RAISE EXCEPTION 'patch (c) failed: A3 discharge category not swapped';
  END IF;
  IF position($x$v_float_balance + p_amount, v_tracking_id$x$ in v_new) = 0 THEN
    RAISE EXCEPTION 'patch (d) failed: float snapshot not corrected';
  END IF;
  IF position($x$'float_after', v_float_balance + p_amount$x$ in v_new) = 0 THEN
    RAISE EXCEPTION 'patch (e) failed: returned float figures not corrected';
  END IF;
  -- The old wrongly-signed float leg must be gone entirely.
  IF position($x$'direction', 'cash_out',
      'category', 'agent_float_used_for_rent'$x$ in v_new) > 0 THEN
    RAISE EXCEPTION 'patch (a) incomplete: a cash_out float leg remains';
  END IF;

  EXECUTE v_new;
END
$mig$;

-- ---------------------------------------------------------------------
-- 4. Authorization trigger must accept the corrected direction.
--    guard_rent_request_agent_updates "Shape 1" authorises an agent's own
--    amount_repaid increase only when the SAME transaction posted a float leg
--    of exactly the delta. It pinned direction='cash_out'; without this patch
--    the corrected collection would silently revert amount_repaid.
-- ---------------------------------------------------------------------
DO $mig$
DECLARE v_def text; v_new text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'guard_rent_request_agent_updates';
  IF v_def IS NULL THEN
    RAISE EXCEPTION 'guard_rent_request_agent_updates not found';
  END IF;

  -- Idempotent: Shape 1 already keys on the corrected cash_in float leg.
  IF position($i$AND gl.category = 'agent_float_used_for_rent'
       AND gl.direction = 'cash_in'$i$ in v_def) > 0 THEN
    RETURN;
  END IF;

  -- Anchor on the two-line Shape 1 pair; Shape 2 is keyed on a different
  -- category line and is therefore untouched.
  v_new := replace(v_def,
    $x$AND gl.category = 'agent_float_used_for_rent'
       AND gl.direction = 'cash_out'$x$,
    $x$AND gl.category = 'agent_float_used_for_rent'
       AND gl.direction = 'cash_in'$x$);

  IF v_new = v_def THEN
    RAISE EXCEPTION 'guard patch failed: Shape 1 anchor not found';
  END IF;
  IF position($x$AND gl.category = 'tenant_repayment'
       AND gl.direction = 'cash_out'$x$ in v_new) = 0 THEN
    RAISE EXCEPTION 'guard patch altered Shape 2 unexpectedly';
  END IF;

  EXECUTE v_new;
END
$mig$;

-- ---------------------------------------------------------------------
-- 5. Reversal must mirror whichever shape the forward collection used.
--    Legacy collections (cash_out float leg + tenant_repayment) keep their
--    existing reversal behaviour; corrected collections mirror the new shape.
-- ---------------------------------------------------------------------
DO $mig$
DECLARE v_def text; v_new text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'agent_reverse_tenant_allocation';
  IF v_def IS NULL THEN
    RAISE EXCEPTION 'agent_reverse_tenant_allocation not found';
  END IF;

  -- Idempotent: reversal is already shape-aware.
  IF position('v_rev_disc_cat' in v_def) > 0 THEN
    RETURN;
  END IF;

  -- Declare shape-detection locals.
  v_new := replace(v_def,
    $x$  v_rent_request record;$x$,
    $x$  v_rent_request record;
  v_fwd_float_dir text;
  v_rev_float_dir text;
  v_rev_disc_cat  text;
  v_rev_disc_dir  text;$x$);
  IF v_new = v_def THEN
    RAISE EXCEPTION 'reversal patch failed: DECLARE anchor not found';
  END IF;

  -- Detect the forward wallet-float direction for this collection.
  v_new := replace(v_new,
    $x$  v_reversal_tracking := 'REV-' || v_collection.tracking_id;$x$,
    $x$  SELECT gl.direction INTO v_fwd_float_dir
    FROM public.general_ledger gl
   WHERE gl.source_table = 'agent_collections'
     AND gl.source_id = v_rent_request.id
     AND gl.user_id = v_collection.agent_id
     AND gl.category = 'agent_float_used_for_rent'
     AND gl.ledger_scope = 'wallet'
   ORDER BY gl.created_at DESC
   LIMIT 1;

  IF v_fwd_float_dir = 'cash_in' THEN
    -- Corrected shape: forward was DR A2 / CR A3 (tenant_repayment_collected).
    v_rev_float_dir := 'cash_out';
    v_rev_disc_cat  := 'tenant_repayment_collected';
    v_rev_disc_dir  := 'cash_in';
  ELSE
    -- Legacy shape preserved exactly.
    v_rev_float_dir := 'cash_in';
    v_rev_disc_cat  := 'tenant_repayment';
    v_rev_disc_dir  := 'cash_out';
  END IF;

  v_reversal_tracking := 'REV-' || v_collection.tracking_id;$x$);

  -- Use the detected shape in the two mirror inserts.
  v_new := replace(v_new,
    $x$VALUES (v_collection.agent_id, v_collection.amount, 'cash_in', 'agent_float_used_for_rent', 'agent_collections', v_rent_request.id,$x$,
    $x$VALUES (v_collection.agent_id, v_collection.amount, v_rev_float_dir, 'agent_float_used_for_rent', 'agent_collections', v_rent_request.id,$x$);

  v_new := replace(v_new,
    $x$VALUES (v_collection.agent_id, v_collection.amount, 'cash_out', 'tenant_repayment', 'agent_collections', v_rent_request.id,$x$,
    $x$VALUES (v_collection.agent_id, v_collection.amount, v_rev_disc_dir, v_rev_disc_cat, 'agent_collections', v_rent_request.id,$x$);

  IF position($x$v_rev_float_dir, 'agent_float_used_for_rent'$x$ in v_new) = 0
     OR position($x$v_rev_disc_dir, v_rev_disc_cat$x$ in v_new) = 0 THEN
    RAISE EXCEPTION 'reversal patch failed: mirror insert anchors not found';
  END IF;

  EXECUTE v_new;
END
$mig$;

-- ---------------------------------------------------------------------
-- 6. Reporting readers: count both categories exactly once.
--    Each patch is asserted so signature drift fails the migration rather
--    than silently skipping a reader.
-- ---------------------------------------------------------------------
DO $mig$
DECLARE
  r record;
  v_def text;
  v_new text;
  v_patched int := 0;
  targets text[][] := ARRAY[
    -- sofp_ledger_legs: statement-of-financial-position repayment leg counter
    ARRAY['sofp_ledger_legs',
          $x$b.cat IN ('tenant_repayment','rent_repayment')$x$,
          $x$b.cat IN ('tenant_repayment','tenant_repayment_collected','rent_repayment')$x$],
    -- get_cashflow_forecast_series: expected-collections category list
    ARRAY['get_cashflow_forecast_series',
          $x$'tenant_repayment','rent_principal_collected'$x$,
          $x$'tenant_repayment','tenant_repayment_collected','rent_principal_collected'$x$],
    -- get_withdrawal_source_breakdown: 'collections' classification
    ARRAY['get_withdrawal_source_breakdown',
          $x$'rent_repayment','tenant_repayment','agent_repayment'$x$,
          $x$'rent_repayment','tenant_repayment','tenant_repayment_collected','agent_repayment'$x$]
  ];
BEGIN
  FOR i IN 1 .. array_length(targets, 1) LOOP
    FOR r IN
      SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = targets[i][1]
    LOOP
      v_def := pg_get_functiondef(r.oid);
      IF position('tenant_repayment_collected' in v_def) > 0 THEN
        v_patched := v_patched + 1;
        CONTINUE;
      END IF;
      v_new := replace(v_def, targets[i][2], targets[i][3]);
      IF v_new = v_def THEN
        RAISE EXCEPTION 'reader patch failed for %: anchor not found', targets[i][1];
      END IF;
      EXECUTE v_new;
      v_patched := v_patched + 1;
    END LOOP;
  END LOOP;

  IF v_patched < 3 THEN
    RAISE EXCEPTION 'expected at least 3 reader patches, applied %', v_patched;
  END IF;
END
$mig$;

COMMENT ON FUNCTION public.agent_allocate_tenant_payment_internal(uuid, uuid, uuid, numeric, text, uuid) IS
  'Agent tenant rent collection. Posts DR A2 (wallet.agent_float_used_for_rent cash_in, '
  'cash received and held by the agent) against CR A3 '
  '(platform.tenant_repayment_collected cash_out, receivable discharged), plus the 10% '
  'agent commission (CR L1 / DR X3) which is already priced into the tenant repayment. '
  'Corrected 2026-09-09: the collection previously posted the float leg cash_out, '
  'double-consuming agent float already consumed at disbursement by rent_payment_for_tenant.';
