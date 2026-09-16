-- Reversed collections: the rest of the sweep (batches 4-7).
--
-- Finishes what 20260910160000..190000 (batch 1), 20260916210000 (batch 2) and
-- 20260916230000 (batch 3) started. After this, EVERY function that sums
-- collection money excludes reversed rows: 72 filtered, 0 money readers left.
--
-- THE TECHNIQUE, and why it is safer than editing WHERE clauses
-- Batch 1 added `reversed_at IS NULL` to each WHERE by hand. That works but
-- needs the WHERE clause located and its shape understood, and several of the
-- functions here have none at all, or three different ones. Instead each
-- AMOUNT read has its table reference swapped for an equivalent subquery:
--
--     FROM public.agent_collections ac
--  -> FROM (SELECT * FROM public.agent_collections WHERE reversed_at IS NULL) ac
--
-- Same alias, same columns, correct whether or not a WHERE exists, and the
-- planner pushes the predicate down. An alias that did not exist is replaced
-- with the table's own name so qualified references keep working.
--
-- Alias forms are applied BEFORE bare ones, because 'FROM agent_collections'
-- is a substring of 'FROM agent_collections ac' and would otherwise corrupt it.
-- Every rewrite runs through EXECUTE inside one transaction, so a malformed
-- body aborts the whole migration rather than shipping half a sweep.
--
-- THE RULE IS STILL THE RULE (batch 1)
--   * AMOUNT reads must be filtered.
--   * IDENTITY reads must NOT be, or agent and tenant counts move underneath
--     every other figure.
--   * WRITE targets must never be touched.
--
-- DELIBERATELY LEFT UNFILTERED, each checked by hand:
--   get_agent_directory_v2       count(DISTINCT ac.agent_id) AS total_active -
--                                the directory's own universe. Its sum(amount)
--                                and max(created_at) ARE filtered.
--   get_agent_products_services_report (both overloads)
--                                SELECT ac.agent_id ... - which agents were
--                                active at all. Protected with a placeholder
--                                during the swap and restored verbatim.
--   detect_credit_limit_reconciliation_drift, get_agent_monitoring_positions,
--   ops_tenant_repayment_forecast, settle_tenant_rent_from_deposit
--                                EXISTS / SELECT 1 probes - they ask "has this
--                                agent ever collected", not "how much".
--
-- SIX WRITERS UNTOUCHED: agent_allocate_tenant_payment(_internal),
-- confirm_field_collection, process_verified_field_deposit,
-- settle_tenant_rent_from_deposit, agent_reverse_tenant_allocation.
--
-- Applied to production and smoke-tested by executing the rewritten functions
-- (a plpgsql body only validates its SQL at run time, so creating it is not
-- proof it works).
--
-- STILL NOT FIXED, and not a reversal problem:
-- get_agent_products_services_report computes coverage from an
-- expected_cumulative / daily_receivable basis rather than the pinned bill in
-- agent_expected_day_plans, so its percentage was never comparable to the
-- Command Center's. Reversals are now right there; the denominator is not.

DO $sweep$
DECLARE
  r record; v_def text; v_before text; v_n int := 0;
  SUB  constant text := '(SELECT * FROM public.agent_collections WHERE reversed_at IS NULL)';
  KEEP constant text := '__WELILE_KEEP_AGENT_UNIVERSE__';
BEGIN
  ---------------------------------------------------------------- blanket group
  -- Every agent_collections site in these is a payment metric: volume, count of
  -- payments, tenants who paid, last payment at. A reversed collection did not
  -- happen, so none of them may count it.
  FOR r IN SELECT unnest(ARRAY[
      'agent_advance_activity','agent_ops_list_subagent_commission_whitelist',
      'agent_ops_partial_collection_report','get_advance_activity_monthly_trend',
      'get_agent_advance_activity_correlation','get_agent_ops_rent_behaviour',
      'get_agent_ops_rent_behaviour_detail','get_agent_profile_360',
      'get_agent_weekly_champion_team','get_service_center_tenant_payments',
      'get_tenant_missed_dates','get_tenant_missed_days','get_tenant_payment_day_state',
      'get_tenant_repayment_reliability','ops_tenant_ops_home_range',
      'ops_tenant_ops_tool_counts','ops_list_subagent_tenant_transfers',
      'rent_pipeline_tenant_history','snapshot_agent_daily_eligibility',
      'ops_tenant_products_services_rows','get_agent_earned_vouch_in_range',
      'get_tenant_receivable_account_movements','get_agent_monitoring_positions',
      'ops_tenant_repayment_forecast','get_tenant_ops_agent_360',
      'smartphone_leaderboard_ranks','get_receivables_forecast','get_service_centre_360',
      'ops_agent_ops_weekly_bundle','ops_tenant_ops_weekly_bundle',
      'ops_tenant_products_services_report','get_agent_products_cumulative',
      'ops_tenant_ops_tool_report','detect_credit_limit_reconciliation_drift'
    ]::text[]) AS fn
  LOOP
    FOR v_def IN SELECT pg_get_functiondef(p.oid) FROM pg_proc p
                   JOIN pg_namespace n ON n.oid = p.pronamespace
                  WHERE n.nspname = 'public' AND p.proname = r.fn
    LOOP
      CONTINUE WHEN position('reversed_at' in v_def) > 0;
      v_before := v_def;

      v_def := replace(v_def, 'FROM public.agent_collections ac', 'FROM ' || SUB || ' ac');
      v_def := replace(v_def, 'FROM public.agent_collections c',  'FROM ' || SUB || ' c');
      v_def := replace(v_def, 'FROM agent_collections ac',        'FROM ' || SUB || ' ac');
      v_def := replace(v_def, 'FROM agent_collections c',         'FROM ' || SUB || ' c');
      v_def := replace(v_def, 'from public.agent_collections ac', 'from ' || SUB || ' ac');
      v_def := replace(v_def, 'from public.agent_collections c',  'from ' || SUB || ' c');
      v_def := replace(v_def, 'JOIN public.agent_collections c',  'JOIN ' || SUB || ' c');
      v_def := replace(v_def, 'FROM public.agent_collections WHERE agent_id = p_user_id;',
                              'FROM public.agent_collections WHERE reversed_at IS NULL AND agent_id = p_user_id;');
      v_def := replace(v_def, 'FROM public.agent_collections WHERE agent_id = r.user_id;',
                              'FROM public.agent_collections WHERE reversed_at IS NULL AND agent_id = r.user_id;');
      v_def := replace(v_def, 'FROM agent_collections WHERE created_at >= p_from AND created_at <= p_to',
                              'FROM ' || SUB || ' agent_collections WHERE created_at >= p_from AND created_at <= p_to');
      v_def := replace(v_def, 'FROM agent_collections WHERE created_at BETWEEN p_from AND p_to',
                              'FROM ' || SUB || ' agent_collections WHERE created_at BETWEEN p_from AND p_to');
      -- bare forms LAST
      v_def := replace(v_def, 'FROM public.agent_collections', 'FROM ' || SUB || ' agent_collections');
      v_def := replace(v_def, 'FROM agent_collections',        'FROM ' || SUB || ' agent_collections');

      CONTINUE WHEN v_def = v_before;
      EXECUTE v_def;
      v_n := v_n + 1;
    END LOOP;
  END LOOP;

  ------------------------------------------------- directory: keep the universe
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'get_agent_directory_v2';
  IF v_def IS NOT NULL AND position('reversed_at' in v_def) = 0 THEN
    v_before := v_def;
    v_def := replace(v_def, 'SELECT sum(ac.amount) FROM agent_collections ac',
                            'SELECT sum(ac.amount) FROM ' || SUB || ' ac');
    v_def := replace(v_def, '(SELECT max(ac.created_at) FROM agent_collections ac WHERE ac.agent_id = pg.uid)',
                            '(SELECT max(ac.created_at) FROM ' || SUB || ' ac WHERE ac.agent_id = pg.uid)');
    IF v_def <> v_before THEN EXECUTE v_def; v_n := v_n + 1; END IF;
  END IF;

  --------------------------------- products & services: protect the universes
  FOR v_def IN
    SELECT pg_get_functiondef(p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'get_agent_products_services_report'
  LOOP
    CONTINUE WHEN position('reversed_at' in v_def) > 0;
    v_before := v_def;
    v_def := replace(v_def, 'SELECT ac.agent_id FROM agent_collections ac', KEEP);
    v_def := replace(v_def, 'FROM public.agent_collections ac', 'FROM ' || SUB || ' ac');
    v_def := replace(v_def, 'FROM agent_collections ac',        'FROM ' || SUB || ' ac');
    v_def := replace(v_def, KEEP, 'SELECT ac.agent_id FROM agent_collections ac');
    CONTINUE WHEN v_def = v_before;
    EXECUTE v_def; v_n := v_n + 1;
  END LOOP;

  RAISE NOTICE 'final sweep: % function(s) patched', v_n;
END $sweep$;

DO $verify$
DECLARE v_left text; v_writers int;
BEGIN
  SELECT string_agg(p.proname, ', ' ORDER BY p.proname) INTO v_left
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.prosrc ILIKE '%agent_collections%'
     AND p.prosrc NOT ILIKE '%reversed_at%'
     AND p.prosrc ~* 'sum\s*\(\s*(ac|c)?\.?amount'
     AND p.prosrc !~* '(insert into|update)\s+public\.agent_collections';
  IF v_left IS NOT NULL THEN
    RAISE EXCEPTION 'money readers still counting reversed collections: %', v_left;
  END IF;

  -- The universes must have survived.
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname='public' AND p.proname='get_agent_products_services_report'
         AND p.prosrc LIKE '%SELECT ac.agent_id FROM agent_collections ac%') <> 2 THEN
    RAISE EXCEPTION 'products/services agent universes were altered';
  END IF;
  IF (SELECT position('count(DISTINCT ac.agent_id)::int FROM agent_collections ac WHERE ac.agent_id IS NOT NULL' in p.prosrc)
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname='public' AND p.proname='get_agent_directory_v2') = 0 THEN
    RAISE EXCEPTION 'directory total_active universe was altered';
  END IF;

  SELECT count(*) INTO v_writers FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname='public' AND p.prosrc ~* '(insert into|update)\s+public\.agent_collections';
  RAISE NOTICE 'final sweep verified: 0 money readers left, universes intact, % writers untouched', v_writers;
END $verify$;
