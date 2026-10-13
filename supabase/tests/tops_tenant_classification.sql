-- Rolled-back verification for 20261013201000_tops_tenant_classification.sql
--
-- Run against the live database. The functions are read-only; the few rows changed below to build edge cases
-- are rolled back, and the block ends in RAISE EXCEPTION so the error text IS the report (steps with "pass").
--
--   A  access: staff roles may read; a user without a role and a signed-out call are refused; the helper is not
--      callable from the API; anon cannot call the public functions; an unknown category is refused
--   B  categories are mutually exclusive and sum to the population (rebuilt independently); sub-labels add up;
--      the summary equals the list totals
--   C  a tenant with two running Rent Plans is counted once, as Active
--   D  funded-but-landlord-unpaid lands in Waiting, never in Active (checked against am_plan_clock)
--   E  completed + a later open request is Dormant / Renewal in progress
--   F  deleted accounts and disabled tenant roles are excluded
--   G  "Needs review": a funded / repaying plan that is fully repaid, a completed plan that still owes, a running
--      plan with no amount, and two running plans
--   H  nothing else moved: Top-Up Eligibility, Weekly Performance and Agent Monitoring figures are the same
--      before and after the new functions run
DO $test$
DECLARE
  r jsonb := '[]'::jsonb;
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_staff uuid;
  v_plain uuid;
  v_role text;
  v_user uuid;
  v_ok boolean;
  v_sum jsonb;
  v_pop int;
  n_a int; n_b int; n_c int; n_d int;
  v_t uuid; v_p uuid;
  v_before jsonb; v_after jsonb;
  v_live uuid[];
  v_used uuid[] := '{}';
BEGIN
  SELECT user_id INTO v_staff FROM public.user_roles WHERE role = 'tenant_ops' AND enabled LIMIT 1;
  SELECT p.id INTO v_plain FROM public.profiles p
   WHERE NOT EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = p.id) LIMIT 1;

  -- A: access ----------------------------------------------------------------------
  FOREACH v_role IN ARRAY ARRAY['manager','super_admin','coo','ceo','cto','cfo','operations','tenant_ops','agent_ops','financial_ops'] LOOP
    SELECT user_id INTO v_user FROM public.user_roles WHERE role::text = v_role AND enabled LIMIT 1;
    IF v_user IS NULL THEN
      r := r || jsonb_build_object('step', 'A role ' || v_role, 'pass', NULL, 'detail', 'skipped: no enabled user holds this role');
      CONTINUE;
    END IF;
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_user, 'role', 'authenticated')::text, true);
    v_ok := true;
    BEGIN
      PERFORM public.tops_tenant_classification_summary();
      PERFORM 1 FROM public.tops_tenant_classification_list('active', NULL, NULL, 5, 0);
    EXCEPTION WHEN OTHERS THEN v_ok := false;
    END;
    r := r || jsonb_build_object('step', 'A role ' || v_role || ' can read the summary and the list', 'pass', v_ok);
  END LOOP;

  PERFORM set_config('request.jwt.claims', '', true);
  v_ok := false;
  BEGIN PERFORM public.tops_tenant_classification_summary(); EXCEPTION WHEN OTHERS THEN v_ok := SQLSTATE = '42501'; END;
  r := r || jsonb_build_object('step', 'A signed-out call refused (summary)', 'pass', v_ok);
  IF v_plain IS NOT NULL THEN
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_plain, 'role', 'authenticated')::text, true);
    v_ok := false;
    BEGIN PERFORM 1 FROM public.tops_tenant_classification_list(NULL, NULL, NULL, 5, 0); EXCEPTION WHEN OTHERS THEN v_ok := SQLSTATE = '42501'; END;
    r := r || jsonb_build_object('step', 'A user without a role refused (list)', 'pass', v_ok);
  END IF;
  r := r || jsonb_build_object('step', 'A the helper is not callable from the API; anon cannot call the public functions; authenticated can',
    'pass', NOT has_function_privilege('authenticated', 'public._tops_tenant_classification_core()', 'EXECUTE')
        AND NOT has_function_privilege('anon', 'public._tops_tenant_classification_core()', 'EXECUTE')
        AND NOT has_function_privilege('anon', 'public.tops_tenant_classification_summary()', 'EXECUTE')
        AND NOT has_function_privilege('anon', 'public.tops_tenant_classification_list(text,text,text,integer,integer,boolean)', 'EXECUTE')
        AND has_function_privilege('authenticated', 'public.tops_tenant_classification_summary()', 'EXECUTE')
        AND has_function_privilege('authenticated', 'public.tops_tenant_classification_list(text,text,text,integer,integer,boolean)', 'EXECUTE'));

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_staff, 'role', 'authenticated')::text, true);
  v_ok := false;
  BEGIN PERFORM 1 FROM public.tops_tenant_classification_list('nonsense', NULL, NULL, 5, 0); EXCEPTION WHEN OTHERS THEN v_ok := SQLSTATE = '22023'; END;
  r := r || jsonb_build_object('step', 'A an unknown category is refused', 'pass', v_ok);

  -- H (before): figures of the existing pages -------------------------------------------
  SELECT ARRAY(SELECT id FROM public.rent_requests WHERE status IN ('funded', 'disbursed', 'repaying')) INTO v_live;
  v_before := jsonb_build_object(
    'topup', (public.get_tenant_topup_eligibility(NULL, NULL, NULL, 1, 0))->'summary',
    'weekly', (public.get_tenant_ops_weekly_performance_amclock())->'current',
    'arrears', (SELECT COALESCE(sum(arrears), 0) FROM public.am_plan_arrears(v_live, v_today)),
    'uncovered', (SELECT count(*) FROM public.am_uncovered_plans(v_today, 1000, 0)));

  -- B: partition -------------------------------------------------------------------------
  CREATE TEMP TABLE _c ON COMMIT DROP AS SELECT * FROM public._tops_tenant_classification_core();
  v_sum := public.tops_tenant_classification_summary();
  SELECT count(*) INTO v_pop FROM public.profiles p
   WHERE p.deleted_at IS NULL
     AND EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = p.id AND ur.role::text = 'tenant' AND ur.enabled);
  SELECT count(*), count(DISTINCT tenant_id) INTO n_a, n_b FROM _c;
  r := r || jsonb_build_object('step', 'B one row per tenant, equal to the population rebuilt from user_roles and profiles',
    'pass', n_a = v_pop AND n_b = v_pop, 'detail', jsonb_build_object('population', v_pop, 'rows', n_a));
  r := r || jsonb_build_object('step', 'B the four categories are mutually exclusive and add up to the population',
    'pass', (v_sum->>'active')::int + (v_sum->>'waiting')::int + (v_sum->>'dormant')::int + (v_sum->>'inactive')::int = v_pop
        AND (v_sum->>'population')::int = v_pop
        AND NOT EXISTS (SELECT 1 FROM _c WHERE category NOT IN ('active', 'waiting', 'dormant', 'inactive')),
    'detail', v_sum);
  r := r || jsonb_build_object('step', 'B sub-labels add up: renewal only on Dormant, the Inactive sub-labels sum to Inactive',
    'pass', (v_sum->>'inactive_never_requested')::int + (v_sum->>'inactive_request_in_review')::int
              + (v_sum->>'inactive_only_rejected_cancelled')::int + (v_sum->>'inactive_other')::int = (v_sum->>'inactive')::int
        AND NOT EXISTS (SELECT 1 FROM _c WHERE category IN ('active', 'waiting') AND sub_label IS NOT NULL)
        AND NOT EXISTS (SELECT 1 FROM _c WHERE category = 'dormant' AND sub_label IS DISTINCT FROM 'renewal_in_progress' AND sub_label IS NOT NULL)
        AND NOT EXISTS (SELECT 1 FROM _c WHERE category = 'inactive' AND sub_label IS NULL));
  -- the list agrees with the summary
  SELECT count(*) INTO n_a FROM (
    SELECT c, (SELECT max(total_rows) FROM public.tops_tenant_classification_list(c, NULL, NULL, 1, 0)) AS n FROM unnest(ARRAY['active','waiting','dormant','inactive']) c) q
   WHERE n IS DISTINCT FROM (v_sum->>q.c)::int;
  r := r || jsonb_build_object('step', 'B the list totals equal the summary cards, and a search and a sub-label filter narrow them',
    'pass', n_a = 0
        AND (SELECT max(total_rows) FROM public.tops_tenant_classification_list('dormant', 'renewal_in_progress', NULL, 1, 0)) = (v_sum->>'dormant_renewal_in_progress')::int
        AND (SELECT max(total_rows) FROM public.tops_tenant_classification_list(NULL, NULL, NULL, 1, 0, true)) = (v_sum->>'needs_review')::int
        AND (SELECT count(*) FROM public.tops_tenant_classification_list(NULL, NULL, NULL, 7, 0)) = 7
        AND (SELECT count(*) FROM (SELECT tenant_id FROM public.tops_tenant_classification_list(NULL, NULL, NULL, 7, 7)
                                   INTERSECT SELECT tenant_id FROM public.tops_tenant_classification_list(NULL, NULL, NULL, 7, 0)) q) = 0);

  SELECT count(*) INTO n_a FROM public.tops_tenant_classification_list('active', NULL,
    (SELECT split_part(tenant_name, ' ', 1) FROM _c WHERE category = 'active' AND tenant_name IS NOT NULL LIMIT 1), 50, 0);
  SELECT count(*) INTO n_b FROM public.tops_tenant_classification_list('active', NULL, 'zzzzzz-no-such-tenant', 50, 0);
  r := r || jsonb_build_object('step', 'B search by name finds the tenant and a nonsense search finds nobody', 'pass', n_a >= 1 AND n_b = 0);

  -- C: two running plans, one tenant, once, Active ------------------------------------------
  SELECT count(*) INTO n_a FROM _c WHERE running_plans > 1;
  SELECT count(*) INTO n_b FROM _c WHERE running_plans > 1 AND category = 'active';
  SELECT count(*) INTO n_c FROM (SELECT tenant_id FROM _c GROUP BY 1 HAVING count(*) > 1) q;
  r := r || jsonb_build_object('step', 'C tenants with two running plans appear once, as Active, and are flagged for review',
    'pass', n_a > 0 AND n_c = 0
        AND n_b = (SELECT count(*) FROM _c WHERE running_plans > 1 AND category = 'active')
        AND NOT EXISTS (SELECT 1 FROM _c WHERE running_plans > 1 AND NOT needs_review),
    'detail', jsonb_build_object('tenants_with_two_running_plans', n_a, 'of_them_active', n_b));

  -- D: landlord-unpaid is Waiting, not Active --------------------------------------------------
  CREATE TEMP TABLE _clk ON COMMIT DROP AS SELECT * FROM public.am_plan_clock(v_live);
  CREATE TEMP TABLE _plan ON COMMIT DROP AS
    SELECT rr.id, rr.tenant_id, rr.status, COALESCE(rr.total_repayment, 0) AS total, COALESCE(rr.amount_repaid, 0) AS repaid, k.bucket
      FROM public.rent_requests rr JOIN _clk k ON k.rent_request_id = rr.id;
  -- every Active tenant has at least one plan the shared clock counts, still owing
  SELECT count(*) INTO n_a FROM _c c WHERE c.category = 'active'
     AND NOT EXISTS (SELECT 1 FROM _plan p WHERE p.tenant_id = c.tenant_id AND p.bucket IN ('counting', 'outstanding_balance') AND p.total - p.repaid > 0);
  -- every Waiting tenant has an unpaid-landlord plan and no counted plan that still owes
  SELECT count(*) INTO n_b FROM _c c WHERE c.category = 'waiting'
     AND (NOT EXISTS (SELECT 1 FROM _plan p WHERE p.tenant_id = c.tenant_id AND p.bucket IN ('tenant_paying_no_landlord', 'awaiting_landlord'))
          OR EXISTS (SELECT 1 FROM _plan p WHERE p.tenant_id = c.tenant_id AND p.bucket IN ('counting', 'outstanding_balance') AND p.total - p.repaid > 0));
  -- a tenant whose only live plans are landlord-unpaid is Waiting
  SELECT count(*) INTO n_c FROM (
    SELECT p.tenant_id FROM _plan p JOIN _c c ON c.tenant_id = p.tenant_id
     GROUP BY p.tenant_id, c.category
    HAVING bool_and(p.bucket IN ('tenant_paying_no_landlord', 'awaiting_landlord')) AND c.category <> 'waiting') q;
  r := r || jsonb_build_object('step', 'D funded-but-landlord-unpaid lands in Waiting, not Active (rebuilt from am_plan_clock)',
    'pass', n_a = 0 AND n_b = 0 AND n_c = 0 AND (v_sum->>'waiting')::int > 0,
    'detail', jsonb_build_object('waiting', v_sum->'waiting', 'active_without_a_counted_plan', n_a, 'waiting_with_a_counted_plan', n_b, 'only_unpaid_but_not_waiting', n_c));

  -- E: completed + a later open request ----------------------------------------------------
  SELECT count(*) INTO n_a FROM (
    SELECT t.tenant_id FROM _c t
     WHERE NOT EXISTS (SELECT 1 FROM public.rent_requests x WHERE x.tenant_id = t.tenant_id AND x.status IN ('funded', 'disbursed', 'repaying'))
       AND EXISTS (SELECT 1 FROM public.rent_requests d WHERE d.tenant_id = t.tenant_id
                     AND (d.status = 'completed' OR (COALESCE(d.total_repayment, 0) > 0 AND COALESCE(d.amount_repaid, 0) >= d.total_repayment)))
       AND EXISTS (SELECT 1 FROM public.rent_requests o
                    WHERE o.tenant_id = t.tenant_id
                      AND o.status NOT IN ('funded', 'disbursed', 'repaying', 'completed', 'rejected', 'cancelled', 'deleted_by_agent')
                      AND o.created_at > (SELECT max(d2.created_at) FROM public.rent_requests d2 WHERE d2.tenant_id = t.tenant_id
                                           AND (d2.status = 'completed' OR (COALESCE(d2.total_repayment, 0) > 0 AND COALESCE(d2.amount_repaid, 0) >= d2.total_repayment))))) q;
  SELECT count(*) INTO n_b FROM _c WHERE category = 'dormant' AND sub_label = 'renewal_in_progress';
  SELECT count(*) INTO n_c FROM _c WHERE category = 'dormant' AND completed_on IS NULL;
  SELECT count(*) INTO n_d FROM _c WHERE category = 'dormant' AND days_since_completion <> GREATEST(0, v_today - completed_on);
  r := r || jsonb_build_object('step', 'E completed + a later open request = Dormant / Renewal in progress (rebuilt independently); every Dormant tenant has completed_on and days_since_completion',
    'pass', n_a = n_b AND n_b > 0 AND n_c = 0 AND n_d = 0,
    'detail', jsonb_build_object('renewal_in_progress', n_b, 'rebuilt', n_a));

  -- F: deleted accounts and disabled roles are excluded ------------------------------------
  SELECT count(*) INTO n_a FROM _c WHERE tenant_id IN (SELECT id FROM public.profiles WHERE deleted_at IS NOT NULL);
  SELECT count(*) INTO n_b FROM public.profiles p WHERE p.deleted_at IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = p.id AND ur.role::text = 'tenant' AND ur.enabled);
  SELECT count(*) INTO n_c FROM _c WHERE tenant_id IN (
    SELECT ur.user_id FROM public.user_roles ur WHERE ur.role::text = 'tenant' AND NOT ur.enabled
      AND NOT EXISTS (SELECT 1 FROM public.user_roles u2 WHERE u2.user_id = ur.user_id AND u2.role::text = 'tenant' AND u2.enabled));
  r := r || jsonb_build_object('step', 'F deleted accounts and disabled tenant roles are excluded',
    'pass', n_a = 0 AND n_c = 0,
    'detail', jsonb_build_object('deleted_tenant_accounts_that_would_otherwise_count', n_b, 'in_the_result', n_a));

  -- H: nothing else moved ------------------------------------------------------------------
  -- (before the rows are edited below) the existing pages read the same figures after the new functions have run
  -- a deleted account (made here, rolled back) drops out of the population and of its category
  EXECUTE 'SET LOCAL session_replication_role = replica';
  SELECT tenant_id INTO v_t FROM _c WHERE category = 'active' ORDER BY tenant_id LIMIT 1;
  UPDATE public.profiles SET deleted_at = now() WHERE id = v_t;
  SELECT count(*) INTO n_a FROM public._tops_tenant_classification_core() WHERE tenant_id = v_t;
  SELECT count(*) INTO n_b FROM public._tops_tenant_classification_core();
  EXECUTE 'SET LOCAL session_replication_role = origin';
  r := r || jsonb_build_object('step', 'F a tenant whose account is marked deleted leaves the population and its category',
    'pass', n_a = 0 AND n_b = v_pop - 1);

  v_after := jsonb_build_object(
    'topup', (public.get_tenant_topup_eligibility(NULL, NULL, NULL, 1, 0))->'summary',
    'weekly', (public.get_tenant_ops_weekly_performance_amclock())->'current',
    'arrears', (SELECT COALESCE(sum(arrears), 0) FROM public.am_plan_arrears(v_live, v_today)),
    'uncovered', (SELECT count(*) FROM public.am_uncovered_plans(v_today, 1000, 0)));
  r := r || jsonb_build_object('step', 'H Top-Up Eligibility, Weekly Performance, Agent Monitoring arrears and the uncovered-plan list read the same figures before and after the new functions run',
    'pass', v_before = v_after,
    'detail', jsonb_build_object('topup_tenants', v_after->'topup'->'tenants', 'weekly_active', v_after->'weekly'->'total_active_tenants',
                                 'arrears', v_after->'arrears', 'uncovered', v_after->'uncovered'));

  -- G: needs review -------------------------------------------------------------------------
  EXECUTE 'SET LOCAL session_replication_role = replica';
  -- a funded / repaying plan that is fully repaid
  SELECT p.tenant_id, p.id INTO v_t, v_p FROM _plan p JOIN _c c ON c.tenant_id = p.tenant_id
   WHERE p.status = 'repaying' AND p.bucket = 'counting' AND p.total > 0 AND p.repaid < p.total AND c.running_plans = 1 AND c.completed_plans = 0 AND c.category = 'active'
   ORDER BY p.id LIMIT 1;
  v_used := v_used || v_t;
  UPDATE public.rent_requests SET amount_repaid = total_repayment WHERE id = v_p;
  SELECT count(*) INTO n_a FROM public._tops_tenant_classification_core() x
   WHERE x.tenant_id = v_t AND x.needs_review AND x.review_reasons LIKE '%running but fully repaid%' AND x.category = 'dormant';
  r := r || jsonb_build_object('step', 'G a repaying plan that is fully repaid is flagged Needs review (and the tenant is no longer Active)', 'pass', n_a = 1);

  -- a completed plan that still owes
  SELECT p.tenant_id, p.id INTO v_t, v_p FROM _plan p JOIN _c c ON c.tenant_id = p.tenant_id
   WHERE p.status = 'repaying' AND p.bucket = 'counting' AND p.total > 0 AND p.repaid < p.total AND c.running_plans = 1 AND c.completed_plans = 0 AND c.category = 'active'
     AND NOT (p.tenant_id = ANY (v_used))
   ORDER BY p.id LIMIT 1;
  v_used := v_used || v_t;
  UPDATE public.rent_requests SET status = 'completed' WHERE id = v_p;
  SELECT count(*) INTO n_b FROM public._tops_tenant_classification_core() x
   WHERE x.tenant_id = v_t AND x.needs_review AND x.review_reasons LIKE '%completed but still owing%';
  r := r || jsonb_build_object('step', 'G a completed plan that still owes is flagged Needs review', 'pass', n_b = 1);

  -- a running plan with no repayment amount
  SELECT p.tenant_id, p.id INTO v_t, v_p FROM _plan p JOIN _c c ON c.tenant_id = p.tenant_id
   WHERE p.status = 'repaying' AND p.bucket = 'counting' AND p.total > 0 AND c.running_plans = 1 AND c.completed_plans = 0 AND c.category = 'active'
     AND NOT (p.tenant_id = ANY (v_used))
   ORDER BY p.id DESC LIMIT 1;
  UPDATE public.rent_requests SET total_repayment = 0 WHERE id = v_p;
  SELECT count(*) INTO n_c FROM public._tops_tenant_classification_core() x
   WHERE x.tenant_id = v_t AND x.needs_review AND x.review_reasons LIKE '%no repayment amount%' AND x.category = 'inactive' AND x.sub_label = 'other';
  r := r || jsonb_build_object('step', 'G a running plan with no repayment amount is flagged Needs review (Inactive / other)', 'pass', n_c = 1);
  EXECUTE 'SET LOCAL session_replication_role = origin';

  RAISE EXCEPTION 'ROLLED BACK REPORT: %', jsonb_pretty(r);
END
$test$;
