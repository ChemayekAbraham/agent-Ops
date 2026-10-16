-- Tests for 20261016100000_agent_ops_metrics.sql (agent_ops_metrics_totals / _agents / _locations / _pins / _main_agents and the _aom_* helpers).
-- One transaction that always rolls back (the last statement raises with the report), so nothing is kept.
-- "ROLLED BACK REPORT: N passed of N | failing: none" is success.
--
-- Every figure is recomputed here straight from the base tables (house_listings, agent_listing_rejections, general_ledger, agent_advances,
-- agent_subagents ...), written a different way, and compared; the totals are also reconciled with the sum of every agent row (paged through
-- agent_ops_metrics_agents), with the three location levels and with the teams.
DO $test$
DECLARE
  r jsonb := '[]'::jsonb;
  v_U uuid; v_role text; v_ok boolean; v_a text; v_n bigint; v_i int; v_off int;
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_s date; v_e date; v_ts timestamptz; v_te timestamptz;
  v_tot jsonb; v_tot7 jsonb; v_pg jsonb; v_sum jsonb; v_drop uuid; v_after jsonb; v_row jsonb;
  v_l1 numeric; v_l2 numeric; v_l3 numeric;
  v_linked bigint; v_pin_direct bigint; v_pin_big bigint; v_pin_small bigint; v_pin_bad bigint; v_main_parent text;
BEGIN
  -- A. properties and grants
  r := r || jsonb_build_object('step', 'A the five public functions and the three helpers exist, SECURITY DEFINER, STABLE, search_path = public',
    'pass', (SELECT count(*) = 8 AND bool_and(p.prosecdef AND p.provolatile = 's' AND p.proconfig @> ARRAY['search_path=public'])
               FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND (p.proname LIKE 'agent_ops_metrics\_%' OR p.proname IN ('_aom_allowed', '_aom_scope', '_aom_rows'))));
  r := r || jsonb_build_object('step', 'A the five public functions: authenticated can execute; anon, service_role and PUBLIC cannot',
    'pass', (SELECT bool_and(has_function_privilege('authenticated', p.oid, 'EXECUTE') AND NOT has_function_privilege('anon', p.oid, 'EXECUTE') AND NOT has_function_privilege('service_role', p.oid, 'EXECUTE')
                             AND NOT EXISTS (SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a WHERE a.grantee = 0))
               FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE 'agent_ops_metrics\_%'));
  r := r || jsonb_build_object('step', 'A the three helpers cannot be executed by authenticated, anon, service_role or PUBLIC',
    'pass', (SELECT bool_and(NOT has_function_privilege('authenticated', p.oid, 'EXECUTE') AND NOT has_function_privilege('anon', p.oid, 'EXECUTE') AND NOT has_function_privilege('service_role', p.oid, 'EXECUTE')
                             AND NOT EXISTS (SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a WHERE a.grantee = 0))
               FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('_aom_allowed', '_aom_scope', '_aom_rows')));
  r := r || jsonb_build_object('step', 'A read-only and agent_earnings is never read: no INSERT / UPDATE / DELETE / FROM-JOIN agent_earnings in any body; listing money names the ledger categories',
    'pass', (SELECT bool_and(p.prosrc !~* '\m(insert\s+into|update\s+\w+\s+set|delete\s+from|(from|join)\s+(public\.)?agent_earnings|create\s+temp)') FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND (p.proname LIKE 'agent_ops_metrics\_%' OR p.proname IN ('_aom_allowed', '_aom_scope', '_aom_rows')))
        AND (SELECT p.prosrc ~ 'listing_bonus_approvals' AND p.prosrc ~ 'listing_rejection_recovery' AND p.prosrc ~ 'listing_rejection_offset' AND p.prosrc ~ 'admin_correction' AND p.prosrc ~ 'v_general_ledger_operational'
               FROM pg_proc p WHERE p.proname = '_aom_rows' AND p.pronamespace = 'public'::regnamespace));

  SELECT p.id INTO v_U FROM public.profiles p WHERE NOT EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = p.id) AND p.deleted_at IS NULL ORDER BY md5(p.id::text) LIMIT 1;

  -- B. the role gate
  FOREACH v_role IN ARRAY ARRAY['agent_ops', 'coo', 'ceo', 'cto', 'manager', 'super_admin'] LOOP
    BEGIN
      INSERT INTO public.user_roles (user_id, role) VALUES (v_U, v_role::public.app_role);
      PERFORM set_config('request.jwt.claims', json_build_object('sub', v_U, 'role', 'authenticated')::text, true);
      SET LOCAL ROLE authenticated;
      SELECT x.agents_role::text INTO v_a FROM public.agent_ops_metrics_totals(v_today - 6, v_today) x;
      PERFORM 1 FROM public.agent_ops_metrics_agents(v_today - 6, v_today, NULL, NULL, 'qualifying', 1, 0);
      PERFORM 1 FROM public.agent_ops_metrics_locations(v_today - 6, v_today, 'region');
      PERFORM 1 FROM public.agent_ops_metrics_pins(0, 30, 1, 31, 1);
      PERFORM 1 FROM public.agent_ops_metrics_main_agents(v_today - 6, v_today, 1, 0);
      RESET ROLE;
      r := r || jsonb_build_object('step', 'B ' || v_role || ' can read all five', 'pass', v_a::bigint > 0);
      RAISE EXCEPTION 'CASE_DONE';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM <> 'CASE_DONE' THEN r := r || jsonb_build_object('step', 'B ' || v_role || ' can read all five', 'pass', false, 'detail', left(SQLERRM, 200)); END IF;
    END;
  END LOOP;
  FOREACH v_role IN ARRAY ARRAY['tenant_ops', 'operations', 'cfo', 'financial_ops', 'landlord_ops', 'partner_ops', 'agent', 'tenant'] LOOP
    BEGIN
      INSERT INTO public.user_roles (user_id, role) VALUES (v_U, v_role::public.app_role);
      PERFORM set_config('request.jwt.claims', json_build_object('sub', v_U, 'role', 'authenticated')::text, true);
      SET LOCAL ROLE authenticated;
      v_ok := true;
      BEGIN PERFORM 1 FROM public.agent_ops_metrics_totals(v_today - 6, v_today); v_ok := false; EXCEPTION WHEN OTHERS THEN v_ok := v_ok AND SQLSTATE = '42501'; END;
      BEGIN PERFORM 1 FROM public.agent_ops_metrics_agents(v_today - 6, v_today); v_ok := false; EXCEPTION WHEN OTHERS THEN v_ok := v_ok AND SQLSTATE = '42501'; END;
      BEGIN PERFORM 1 FROM public.agent_ops_metrics_locations(v_today - 6, v_today, 'region'); v_ok := false; EXCEPTION WHEN OTHERS THEN v_ok := v_ok AND SQLSTATE = '42501'; END;
      BEGIN PERFORM 1 FROM public.agent_ops_metrics_pins(0, 30, 1, 31, 1); v_ok := false; EXCEPTION WHEN OTHERS THEN v_ok := v_ok AND SQLSTATE = '42501'; END;
      BEGIN PERFORM 1 FROM public.agent_ops_metrics_main_agents(v_today - 6, v_today); v_ok := false; EXCEPTION WHEN OTHERS THEN v_ok := v_ok AND SQLSTATE = '42501'; END;
      RESET ROLE;
      r := r || jsonb_build_object('step', 'B ' || v_role || ' is refused by all five (42501)', 'pass', v_ok);
      RAISE EXCEPTION 'CASE_DONE';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM <> 'CASE_DONE' THEN r := r || jsonb_build_object('step', 'B ' || v_role || ' is refused', 'pass', false, 'detail', left(SQLERRM, 200)); END IF;
    END;
  END LOOP;
  BEGIN
    INSERT INTO public.user_roles (user_id, role, enabled) VALUES (v_U, 'agent_ops'::public.app_role, false);
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_U, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    v_ok := false; BEGIN PERFORM 1 FROM public.agent_ops_metrics_totals(v_today - 6, v_today); EXCEPTION WHEN OTHERS THEN v_ok := SQLSTATE = '42501'; END;
    RESET ROLE;
    r := r || jsonb_build_object('step', 'B an agent_ops role that is switched off (enabled = false) is refused', 'pass', v_ok);
    RAISE EXCEPTION 'CASE_DONE';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'CASE_DONE' THEN r := r || jsonb_build_object('step', 'B disabled role case ran', 'pass', false, 'detail', left(SQLERRM, 200)); END IF;
  END;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_U, 'role', 'authenticated')::text, true);
  v_ok := false; BEGIN PERFORM 1 FROM public.agent_ops_metrics_totals(v_today - 6, v_today); EXCEPTION WHEN OTHERS THEN v_ok := SQLSTATE = '42501'; END;
  r := r || jsonb_build_object('step', 'B a signed-in user with no role is refused', 'pass', v_ok);
  PERFORM set_config('request.jwt.claims', '', true);
  v_ok := false; BEGIN PERFORM 1 FROM public.agent_ops_metrics_totals(v_today - 6, v_today); EXCEPTION WHEN OTHERS THEN v_ok := SQLSTATE = '42501'; END;
  r := r || jsonb_build_object('step', 'B signed-out (no user) is refused (42501)', 'pass', v_ok);
  BEGIN
    SET LOCAL ROLE anon;
    v_ok := false; BEGIN PERFORM 1 FROM public.agent_ops_metrics_totals(v_today - 6, v_today); EXCEPTION WHEN insufficient_privilege THEN v_ok := true; WHEN OTHERS THEN v_ok := false; END;
    RESET ROLE;
  END;
  r := r || jsonb_build_object('step', 'B the anon role cannot call it (permission denied)', 'pass', v_ok);

  -- from here on: an agent_ops user
  INSERT INTO public.user_roles (user_id, role) VALUES (v_U, 'agent_ops'::public.app_role);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_U, 'role', 'authenticated')::text, true);

  -- C. arguments
  v_ok := false; BEGIN PERFORM 1 FROM public.agent_ops_metrics_totals(NULL, v_today); EXCEPTION WHEN OTHERS THEN v_ok := SQLSTATE = '22023' AND SQLERRM LIKE 'RANGE_REQUIRED%'; END;
  r := r || jsonb_build_object('step', 'C totals: a missing date is refused (RANGE_REQUIRED)', 'pass', v_ok);
  v_ok := false; BEGIN PERFORM 1 FROM public.agent_ops_metrics_totals(v_today, v_today - 1); EXCEPTION WHEN OTHERS THEN v_ok := SQLSTATE = '22023' AND SQLERRM LIKE 'RANGE_INVALID%'; END;
  r := r || jsonb_build_object('step', 'C totals: an end before the start is refused (RANGE_INVALID)', 'pass', v_ok);
  v_ok := false; BEGIN PERFORM 1 FROM public.agent_ops_metrics_agents(v_today, v_today, NULL, NULL, 'everyone'); EXCEPTION WHEN OTHERS THEN v_ok := SQLSTATE = '22023' AND SQLERRM LIKE 'SCOPE_INVALID%'; END;
  r := r || jsonb_build_object('step', 'C agents: an unknown scope is refused (SCOPE_INVALID)', 'pass', v_ok);
  v_ok := false; BEGIN PERFORM 1 FROM public.agent_ops_metrics_agents(v_today, v_today, NULL, 'drop table x'); EXCEPTION WHEN OTHERS THEN v_ok := SQLSTATE = '22023' AND SQLERRM LIKE 'SORT_INVALID%'; END;
  r := r || jsonb_build_object('step', 'C agents: a sort that is not on the whitelist is refused (SORT_INVALID)', 'pass', v_ok);
  v_ok := false; BEGIN PERFORM 1 FROM public.agent_ops_metrics_agents(v_today, v_today, NULL, 'net:sideways'); EXCEPTION WHEN OTHERS THEN v_ok := SQLSTATE = '22023'; END;
  r := r || jsonb_build_object('step', 'C agents: a sort direction other than asc / desc is refused', 'pass', v_ok);
  v_ok := false; BEGIN PERFORM 1 FROM public.agent_ops_metrics_locations(v_today, v_today, 'village'); EXCEPTION WHEN OTHERS THEN v_ok := SQLSTATE = '22023' AND SQLERRM LIKE 'LEVEL_INVALID%'; END;
  r := r || jsonb_build_object('step', 'C locations: an unknown level is refused (LEVEL_INVALID)', 'pass', v_ok);
  v_ok := false; BEGIN PERFORM 1 FROM public.agent_ops_metrics_pins(5, 30, 1, 31); EXCEPTION WHEN OTHERS THEN v_ok := SQLSTATE = '22023' AND SQLERRM LIKE 'BOX_INVALID%'; END;
  r := r || jsonb_build_object('step', 'C pins: a box with min above max is refused (BOX_INVALID)', 'pass', v_ok);
  v_ok := false; BEGIN PERFORM 1 FROM public.agent_ops_metrics_pins(NULL, 30, 1, 31); EXCEPTION WHEN OTHERS THEN v_ok := SQLSTATE = '22023' AND SQLERRM LIKE 'BOX_REQUIRED%'; END;
  r := r || jsonb_build_object('step', 'C pins: a missing corner is refused (BOX_REQUIRED)', 'pass', v_ok);

  -- the windows
  v_s := v_today - 29; v_e := v_today;
  v_ts := v_s::timestamp AT TIME ZONE 'Africa/Kampala'; v_te := (v_e + 1)::timestamp AT TIME ZONE 'Africa/Kampala';
  SET LOCAL ROLE authenticated;
  SELECT to_jsonb(x) INTO v_tot FROM public.agent_ops_metrics_totals(v_s, v_e) x;
  SELECT to_jsonb(x) INTO v_tot7 FROM public.agent_ops_metrics_totals(v_today - 6, v_today) x;
  RESET ROLE;

  -- D. the independent recompute
  CREATE TEMP TABLE zz_gone ON COMMIT DROP AS
    SELECT p.id FROM public.profiles p WHERE p.deleted_at IS NOT NULL
    UNION SELECT d.user_id FROM public.deleted_accounts d WHERE d.status = 'soft_deleted' AND d.restored_at IS NULL AND d.purged_at IS NULL AND d.user_id IS NOT NULL;
  CREATE INDEX ON zz_gone (id);
  CREATE TEMP TABLE zz_scope ON COMMIT DROP AS
    SELECT DISTINCT u AS id FROM (
      SELECT agent_id AS u FROM public.agent_ops_qualifying_agent_ids()
      UNION ALL SELECT parent_agent_id FROM public.agent_subagents WHERE status = 'verified'
      UNION ALL SELECT sub_agent_id FROM public.agent_subagents WHERE status = 'verified'
      UNION ALL SELECT agent_id FROM public.house_listings
      UNION ALL SELECT agent_id FROM public.agent_listing_rejections
      UNION ALL SELECT agent_id FROM public.agent_advances
      UNION ALL SELECT user_id FROM public.general_ledger WHERE user_id IS NOT NULL AND created_at >= v_ts AND created_at < v_te AND ledger_scope = 'wallet' AND direction = 'cash_in'
         AND ((category = 'agent_commission_earned' AND source_table = 'listing_bonus_approvals') OR (category = 'agent_commission' AND source_table = 'house_listings') OR category = 'listing_rejection_offset')
    ) z WHERE u IS NOT NULL AND u NOT IN (SELECT id FROM zz_gone);
  CREATE INDEX ON zz_scope (id);

  r := r || jsonb_build_object('step', 'D agents_role, linked_subagents, qualifying_agents and listers_ever equal the direct counts',
    'pass', (v_tot->>'agents_role')::bigint = (SELECT count(DISTINCT user_id) FROM public.user_roles WHERE role::text = 'agent' AND enabled AND user_id NOT IN (SELECT id FROM zz_gone))
        AND (v_tot->>'linked_subagents')::bigint = (SELECT count(DISTINCT sub_agent_id) FROM public.agent_subagents WHERE status = 'verified' AND sub_agent_id NOT IN (SELECT id FROM zz_gone))
        AND (v_tot->>'qualifying_agents')::bigint = (SELECT count(*) FROM (SELECT DISTINCT agent_id FROM public.agent_ops_qualifying_agent_ids() WHERE agent_id NOT IN (SELECT id FROM zz_gone)) q)
        AND (v_tot->>'listers_ever')::bigint = (SELECT count(DISTINCT agent_id) FROM public.house_listings WHERE agent_id NOT IN (SELECT id FROM zz_gone)),
    'detail', json_build_object('role', v_tot->>'agents_role', 'linked', v_tot->>'linked_subagents', 'qual', v_tot->>'qualifying_agents', 'listers_ever', v_tot->>'listers_ever')::text);

  FOR v_i IN 1..2 LOOP
    v_row := CASE v_i WHEN 1 THEN v_tot ELSE v_tot7 END;
    v_ts := (CASE v_i WHEN 1 THEN v_s ELSE v_today - 6 END)::timestamp AT TIME ZONE 'Africa/Kampala';
    v_te := (v_today + 1)::timestamp AT TIME ZONE 'Africa/Kampala';
    r := r || jsonb_build_object('step', 'D houses in range (' || CASE v_i WHEN 1 THEN v_s ELSE v_today - 6 END || ' to ' || v_today || '): listed, verified, pending, with GPS, rejected and listers_in_range equal the direct counts',
      'pass', (v_row->>'houses_listed')::bigint = (SELECT count(*) FROM public.house_listings h WHERE h.created_at >= v_ts AND h.created_at < v_te AND h.agent_id NOT IN (SELECT id FROM zz_gone))
          AND (v_row->>'houses_verified')::bigint = (SELECT count(*) FROM public.house_listings h WHERE h.created_at >= v_ts AND h.created_at < v_te AND h.agent_id NOT IN (SELECT id FROM zz_gone) AND h.verified IS TRUE)
          AND (v_row->>'houses_pending')::bigint = (SELECT count(*) FROM public.house_listings h WHERE h.created_at >= v_ts AND h.created_at < v_te AND h.agent_id NOT IN (SELECT id FROM zz_gone) AND h.verified IS NOT TRUE AND COALESCE(h.status, '') <> 'rejected')
          AND (v_row->>'houses_with_gps')::bigint = (SELECT count(*) FROM public.house_listings h WHERE h.created_at >= v_ts AND h.created_at < v_te AND h.agent_id NOT IN (SELECT id FROM zz_gone) AND h.latitude IS NOT NULL AND h.longitude IS NOT NULL)
          AND (v_row->>'houses_rejected')::bigint = (SELECT count(*) FROM public.agent_listing_rejections x WHERE x.rejected_at >= v_ts AND x.rejected_at < v_te AND x.agent_id NOT IN (SELECT id FROM zz_gone))
          AND (v_row->>'listers_in_range')::bigint = (SELECT count(DISTINCT h.agent_id) FROM public.house_listings h WHERE h.created_at >= v_ts AND h.created_at < v_te AND h.agent_id NOT IN (SELECT id FROM zz_gone)),
      'detail', json_build_object('listed', v_row->>'houses_listed', 'verified', v_row->>'houses_verified', 'pending', v_row->>'houses_pending', 'rejected', v_row->>'houses_rejected', 'listers', v_row->>'listers_in_range')::text);
    -- listing money from the ledger only
    SELECT COALESCE(sum(g.amount), 0) INTO v_l1 FROM public.general_ledger g
     WHERE g.created_at >= v_ts AND g.created_at < v_te AND g.classification <> 'admin_correction' AND g.ledger_scope = 'wallet' AND g.direction = 'cash_in' AND g.user_id IN (SELECT id FROM zz_scope)
       AND ((g.category = 'agent_commission_earned' AND g.source_table = 'listing_bonus_approvals') OR (g.category = 'agent_commission' AND g.source_table = 'house_listings'))
       AND NOT EXISTS (SELECT 1 FROM public.ledger_anomaly_isolations i WHERE i.ledger_entry_id = g.id AND i.released_at IS NULL);
    SELECT COALESCE(sum(g.amount), 0) INTO v_l2 FROM public.general_ledger g
     WHERE g.created_at >= v_ts AND g.created_at < v_te AND g.classification <> 'admin_correction' AND g.ledger_scope = 'wallet' AND g.direction = 'cash_in' AND g.category = 'listing_rejection_offset'
       AND g.user_id IN (SELECT id FROM zz_scope) AND NOT EXISTS (SELECT 1 FROM public.ledger_anomaly_isolations i WHERE i.ledger_entry_id = g.id AND i.released_at IS NULL);
    SELECT COALESCE(sum(CASE WHEN g.direction = 'cash_in' THEN g.amount ELSE -g.amount END), 0) INTO v_l3
      FROM public.general_ledger g
     WHERE g.created_at >= v_ts AND g.created_at < v_te AND g.classification <> 'admin_correction' AND g.category = 'listing_rejection_recovery'
       AND NOT EXISTS (SELECT 1 FROM public.ledger_anomaly_isolations i WHERE i.ledger_entry_id = g.id AND i.released_at IS NULL)
       AND (SELECT w.user_id FROM public.general_ledger w WHERE w.transaction_group_id = g.transaction_group_id AND w.ledger_scope = 'wallet' AND w.user_id IS NOT NULL LIMIT 1) IN (SELECT id FROM zz_scope);
    r := r || jsonb_build_object('step', 'D listing_earned equals the ledger sum (agent_commission_earned from listing_bonus_approvals + agent_commission from house_listings, wallet cash_in, no admin_correction) for ' || CASE v_i WHEN 1 THEN v_s ELSE v_today - 6 END,
      'pass', (v_row->>'listing_earned')::numeric = v_l1, 'detail', (v_row->>'listing_earned') || ' vs ' || v_l1);
    r := r || jsonb_build_object('step', 'D listing_clawed_back equals recovery (platform leg, agent = the wallet leg of its group, cash_out reversals subtracted) + offset for ' || CASE v_i WHEN 1 THEN v_s ELSE v_today - 6 END,
      'pass', (v_row->>'listing_clawed_back')::numeric = v_l2 + v_l3, 'detail', (v_row->>'listing_clawed_back') || ' vs ' || (v_l2 + v_l3));
    r := r || jsonb_build_object('step', 'D advances given (count, amount) and repaid for advances issued in the range equal the direct figures, cancelled and reversed ones left out',
      'pass', (v_row->>'advances_given_count')::bigint = (SELECT count(*) FROM public.agent_advances a WHERE a.status <> 'cancelled' AND a.reversed_at IS NULL AND a.agent_id NOT IN (SELECT id FROM zz_gone) AND a.issued_at >= v_ts AND a.issued_at < v_te)
          AND (v_row->>'advances_given_amount')::numeric = (SELECT COALESCE(sum(a.principal), 0) FROM public.agent_advances a WHERE a.status <> 'cancelled' AND a.reversed_at IS NULL AND a.agent_id NOT IN (SELECT id FROM zz_gone) AND a.issued_at >= v_ts AND a.issued_at < v_te)
          AND (v_row->>'advances_repaid')::numeric = (SELECT COALESCE(sum(greatest(a.principal - COALESCE(a.outstanding_balance, 0), 0)), 0) FROM public.agent_advances a WHERE a.status <> 'cancelled' AND a.reversed_at IS NULL AND a.agent_id NOT IN (SELECT id FROM zz_gone) AND a.issued_at >= v_ts AND a.issued_at < v_te));
  END LOOP;
  r := r || jsonb_build_object('step', 'D advances outstanding and overdue (count and amount) are today''s balances and equal the direct figures',
    'pass', (v_tot->>'advances_outstanding')::numeric = (SELECT COALESCE(sum(a.outstanding_balance), 0) FROM public.agent_advances a WHERE a.status IN ('active', 'overdue') AND a.reversed_at IS NULL AND a.agent_id NOT IN (SELECT id FROM zz_gone))
        AND (v_tot->>'advances_overdue_count')::bigint = (SELECT count(*) FROM public.agent_advances a WHERE a.status = 'overdue' AND a.reversed_at IS NULL AND a.agent_id NOT IN (SELECT id FROM zz_gone))
        AND (v_tot->>'advances_overdue_amount')::numeric = (SELECT COALESCE(sum(a.outstanding_balance), 0) FROM public.agent_advances a WHERE a.status = 'overdue' AND a.reversed_at IS NULL AND a.agent_id NOT IN (SELECT id FROM zz_gone)),
    'detail', json_build_object('outstanding', v_tot->>'advances_outstanding', 'overdue_n', v_tot->>'advances_overdue_count', 'overdue_amt', v_tot->>'advances_overdue_amount')::text);
  r := r || jsonb_build_object('step', 'D the totals carry as_at (today) and the basis text', 'pass', v_tot->>'as_at' = v_today::text AND length(v_tot->>'basis') > 40 AND v_tot->>'range_start' = v_s::text);

  -- E. reconciliation: every agent row (paged), the three location levels, the teams
  v_ts := v_s::timestamp AT TIME ZONE 'Africa/Kampala'; v_te := (v_e + 1)::timestamp AT TIME ZONE 'Africa/Kampala';
  SET LOCAL ROLE authenticated;
  v_off := 0; v_n := -1;
  CREATE TEMP TABLE zz_pages (agent_id uuid, houses_listed bigint, houses_approved bigint, houses_pending bigint, houses_rejected bigint, listing_earned numeric, clawed_back numeric, advance_principal numeric, total_matched bigint) ON COMMIT DROP;
  GRANT ALL ON zz_pages TO authenticated;
  LOOP
    INSERT INTO zz_pages SELECT x.agent_id, x.houses_listed, x.houses_approved, x.houses_pending, x.houses_rejected, x.listing_earned, x.clawed_back, x.advance_principal, x.total_matched
      FROM public.agent_ops_metrics_agents(v_s, v_e, NULL, 'name', 'all', 200, v_off) x;
    EXIT WHEN NOT FOUND OR v_off > 20000;
    v_off := v_off + 200;
    EXIT WHEN v_off >= (SELECT max(total_matched) FROM zz_pages);
  END LOOP;
  RESET ROLE;
  r := r || jsonb_build_object('step', 'E paging through the "all" scope (200 at a time) returns each agent once, and total_matched is the number of agents',
    'pass', (SELECT count(*) = count(DISTINCT agent_id) AND count(*) = max(total_matched) AND count(*) = (SELECT count(*) FROM zz_scope) FROM zz_pages), 'detail', (SELECT count(*)::text || ' agents in ' || (v_off / 200 + 1) || ' pages' FROM zz_pages));
  r := r || jsonb_build_object('step', 'E the totals equal the sum of every agent row: houses listed / verified / pending / rejected, listing earned and clawed back',
    'pass', (v_tot->>'houses_listed')::bigint = (SELECT sum(houses_listed) FROM zz_pages) AND (v_tot->>'houses_verified')::bigint = (SELECT sum(houses_approved) FROM zz_pages)
        AND (v_tot->>'houses_pending')::bigint = (SELECT sum(houses_pending) FROM zz_pages) AND (v_tot->>'houses_rejected')::bigint = (SELECT sum(houses_rejected) FROM zz_pages)
        AND (v_tot->>'listing_earned')::numeric = (SELECT sum(listing_earned) FROM zz_pages) AND (v_tot->>'listing_clawed_back')::numeric = (SELECT sum(clawed_back) FROM zz_pages)
        AND (v_tot->>'advances_given_amount')::numeric = (SELECT sum(advance_principal) FROM zz_pages),
    'detail', (SELECT json_build_object('listed', sum(houses_listed), 'approved', sum(houses_approved), 'pending', sum(houses_pending), 'rejected', sum(houses_rejected), 'earned', sum(listing_earned), 'clawed', sum(clawed_back))::text FROM zz_pages));
  SET LOCAL ROLE authenticated;
  SELECT (SELECT sum(houses_listed) FROM public.agent_ops_metrics_locations(v_s, v_e, 'region')) INTO v_l1;
  SELECT (SELECT sum(houses_listed) FROM public.agent_ops_metrics_locations(v_s, v_e, 'district')) INTO v_l2;
  SELECT (SELECT sum(houses_listed) FROM public.agent_ops_metrics_locations(v_s, v_e, 'sub_county')) INTO v_l3;
  r := r || jsonb_build_object('step', 'E locations: region, district and sub_county levels each add up to the totals'' houses listed, verified and pending',
    'pass', v_l1 = (v_tot->>'houses_listed')::numeric AND v_l2 = v_l1 AND v_l3 = v_l1
        AND (SELECT sum(houses_verified) FROM public.agent_ops_metrics_locations(v_s, v_e, 'district')) = (v_tot->>'houses_verified')::numeric
        AND (SELECT sum(houses_pending) FROM public.agent_ops_metrics_locations(v_s, v_e, 'sub_county')) = (v_tot->>'houses_pending')::numeric
        AND (SELECT sum(houses_with_gps) FROM public.agent_ops_metrics_locations(v_s, v_e, 'region')) = (v_tot->>'houses_with_gps')::numeric,
    'detail', v_l1 || '/' || v_l2 || '/' || v_l3);
  SELECT to_jsonb(x) INTO v_row FROM public.agent_ops_metrics_main_agents(v_s, v_e, 1, 0) x;
  RESET ROLE;
  r := r || jsonb_build_object('step', 'E main agents: the top team''s size, houses and earnings equal the direct figures (verified sub-agents, earliest link, not deleted)',
    'pass', v_row IS NOT NULL AND (v_row->>'team_size')::bigint = (
        SELECT count(*) FROM (SELECT DISTINCT ON (s.sub_agent_id) s.sub_agent_id, s.parent_agent_id FROM public.agent_subagents s WHERE s.status = 'verified' AND s.sub_agent_id NOT IN (SELECT id FROM zz_gone)
                               ORDER BY s.sub_agent_id, s.verified_at NULLS LAST, s.created_at) t WHERE t.parent_agent_id = (v_row->>'main_agent_id')::uuid)
      AND (v_row->>'team_houses')::bigint = (
        SELECT count(*) FROM public.house_listings h WHERE h.created_at >= v_ts AND h.created_at < v_te AND h.agent_id IN (
          SELECT t.sub_agent_id FROM (SELECT DISTINCT ON (s.sub_agent_id) s.sub_agent_id, s.parent_agent_id FROM public.agent_subagents s WHERE s.status = 'verified' AND s.sub_agent_id NOT IN (SELECT id FROM zz_gone)
                                       ORDER BY s.sub_agent_id, s.verified_at NULLS LAST, s.created_at) t WHERE t.parent_agent_id = (v_row->>'main_agent_id')::uuid)),
    'detail', v_row::text);

  -- F. the agent list: scopes, sort, search, paging, clamp   (direct figures are read before switching to the authenticated role)
  SELECT count(*) INTO v_linked FROM (SELECT DISTINCT u FROM (SELECT parent_agent_id u FROM public.agent_subagents WHERE status = 'verified' UNION ALL SELECT sub_agent_id FROM public.agent_subagents WHERE status = 'verified') z WHERE u NOT IN (SELECT id FROM zz_gone)) q;
  SELECT count(*) INTO v_pin_direct FROM public.house_listings h WHERE h.latitude BETWEEN 0.2 AND 0.5 AND h.longitude BETWEEN 32.4 AND 32.8 AND h.agent_id NOT IN (SELECT id FROM zz_gone);
  SET LOCAL ROLE authenticated;
  v_ok := (SELECT count(*) FROM public.agent_ops_metrics_agents(v_s, v_e, NULL, NULL, 'qualifying', 200, 0)) = LEAST(200, (v_tot->>'qualifying_agents')::int)
      AND (SELECT max(total_matched) FROM public.agent_ops_metrics_agents(v_s, v_e, NULL, NULL, 'qualifying', 1, 0)) = (v_tot->>'qualifying_agents')::bigint;
  r := r || jsonb_build_object('step', 'F scope qualifying has the qualifying agents (total_matched = qualifying_agents)', 'pass', v_ok);
  r := r || jsonb_build_object('step', 'F scope linked has exactly the people at the two ends of a verified link (not deleted)',
    'pass', (SELECT max(total_matched) FROM public.agent_ops_metrics_agents(v_s, v_e, NULL, NULL, 'linked', 1, 0)) = v_linked);
  r := r || jsonb_build_object('step', 'F a limit above 200 is clamped to 200, a limit of 0 or less to 1, a negative offset to 0',
    'pass', (SELECT count(*) FROM public.agent_ops_metrics_agents(v_s, v_e, NULL, NULL, 'all', 99999, 0)) = 200
        AND (SELECT count(*) FROM public.agent_ops_metrics_agents(v_s, v_e, NULL, NULL, 'all', 0, 0)) = 1
        AND (SELECT count(*) FROM public.agent_ops_metrics_agents(v_s, v_e, NULL, NULL, 'qualifying', 5, -50)) = 5
        AND (SELECT count(*) FROM public.agent_ops_metrics_main_agents(v_s, v_e, 99999, 0)) <= 200);
  r := r || jsonb_build_object('step', 'F sorting: houses_listed falls; net:asc rises; the default is houses_listed',
    'pass', (SELECT bool_and(a.houses_listed <= COALESCE(lag_v, a.houses_listed)) FROM (SELECT houses_listed, lag(houses_listed) OVER () AS lag_v FROM public.agent_ops_metrics_agents(v_s, v_e, NULL, 'houses_listed', 'qualifying', 60, 0)) a)
        AND (SELECT bool_and(a.net >= COALESCE(lag_v, a.net)) FROM (SELECT net, lag(net) OVER () AS lag_v FROM public.agent_ops_metrics_agents(v_s, v_e, NULL, 'net:asc', 'qualifying', 60, 0)) a)
        AND (SELECT array_agg(agent_id) FROM public.agent_ops_metrics_agents(v_s, v_e, NULL, NULL, 'qualifying', 10, 0)) = (SELECT array_agg(agent_id) FROM public.agent_ops_metrics_agents(v_s, v_e, NULL, 'houses_listed', 'qualifying', 10, 0)));
  SELECT to_jsonb(x) INTO v_row FROM public.agent_ops_metrics_agents(v_s, v_e, NULL, 'houses_listed', 'qualifying', 1, 0) x;
  v_a := split_part(v_row->>'name', ' ', 1);
  r := r || jsonb_build_object('step', 'F search finds the agent by name part (any case) and by phone, matches nothing for text that is not there, and treats % as text',
    'pass', EXISTS (SELECT 1 FROM public.agent_ops_metrics_agents(v_s, v_e, lower(v_a), NULL, 'qualifying', 200, 0) x WHERE x.agent_id = (v_row->>'agent_id')::uuid)
        AND EXISTS (SELECT 1 FROM public.agent_ops_metrics_agents(v_s, v_e, right(v_row->>'phone', 7), NULL, 'qualifying', 200, 0) x WHERE x.agent_id = (v_row->>'agent_id')::uuid)
        AND NOT EXISTS (SELECT 1 FROM public.agent_ops_metrics_agents(v_s, v_e, 'zzzz-no-such-agent', NULL, 'all', 200, 0))
        AND (SELECT count(*) FROM public.agent_ops_metrics_agents(v_s, v_e, '%', NULL, 'all', 200, 0)) < 200,
    'detail', v_row->>'name');
  -- G. pins
  SELECT count(*) INTO v_pin_big FROM public.agent_ops_metrics_pins(-2, 29, 5, 36, 100000);
  SELECT count(*) INTO v_pin_small FROM public.agent_ops_metrics_pins(0.2, 32.4, 0.5, 32.8, 2000);
  SELECT count(*) INTO v_pin_bad FROM public.agent_ops_metrics_pins(0.2, 32.4, 0.5, 32.8, 2000) p WHERE p.latitude NOT BETWEEN 0.2 AND 0.5 OR p.longitude NOT BETWEEN 32.4 AND 32.8;
  RESET ROLE;
  r := r || jsonb_build_object('step', 'G pins: a huge limit is capped at 2000; every pin is inside the box; the count equals the direct count for a small box',
    'pass', v_pin_big <= 2000 AND v_pin_bad = 0 AND v_pin_small = LEAST(2000, v_pin_direct), 'detail', v_pin_big || '/' || v_pin_small || '/' || v_pin_direct);
  SELECT s.parent_agent_id::text INTO v_main_parent FROM public.agent_subagents s WHERE s.sub_agent_id = (v_row->>'agent_id')::uuid AND s.status = 'verified' ORDER BY s.verified_at NULLS LAST, s.created_at LIMIT 1;
  r := r || jsonb_build_object('step', 'F the agent row for the top lister equals the direct figures (houses, earned, net, main agent)',
    'pass', (v_row->>'houses_listed')::bigint = (SELECT count(*) FROM public.house_listings h WHERE h.agent_id = (v_row->>'agent_id')::uuid AND h.created_at >= v_ts AND h.created_at < v_te)
        AND (v_row->>'houses_approved')::bigint = (SELECT count(*) FROM public.house_listings h WHERE h.agent_id = (v_row->>'agent_id')::uuid AND h.created_at >= v_ts AND h.created_at < v_te AND h.verified)
        AND (v_row->>'listing_earned')::numeric = (SELECT COALESCE(sum(g.amount), 0) FROM public.general_ledger g WHERE g.user_id = (v_row->>'agent_id')::uuid AND g.created_at >= v_ts AND g.created_at < v_te AND g.classification <> 'admin_correction'
             AND g.ledger_scope = 'wallet' AND g.direction = 'cash_in' AND ((g.category = 'agent_commission_earned' AND g.source_table = 'listing_bonus_approvals') OR (g.category = 'agent_commission' AND g.source_table = 'house_listings')))
        AND (v_row->>'net')::numeric = (v_row->>'listing_earned')::numeric - (v_row->>'clawed_back')::numeric
        AND (v_row->>'main_agent_id') IS NOT DISTINCT FROM v_main_parent,
    'detail', v_row::text);

  -- H. deleted accounts are left out everywhere (simulated inside this rolled-back test)
  SELECT l.agent_id INTO v_drop FROM (SELECT h.agent_id, count(*) c FROM public.house_listings h WHERE h.created_at >= v_ts AND h.created_at < v_te GROUP BY 1 ORDER BY 2 DESC LIMIT 1) l;
  BEGIN
    UPDATE public.profiles SET deleted_at = now() WHERE id = v_drop;
    SET LOCAL ROLE authenticated;
    SELECT to_jsonb(x) INTO v_after FROM public.agent_ops_metrics_totals(v_s, v_e) x;
    v_ok := NOT EXISTS (SELECT 1 FROM public.agent_ops_metrics_agents(v_s, v_e, NULL, NULL, 'all', 200, 0) a WHERE a.agent_id = v_drop);
    RESET ROLE;
    r := r || jsonb_build_object('step', 'H an agent whose profile is soft-deleted leaves the totals (listed houses, listers) and every list',
      'pass', v_ok AND (v_after->>'houses_listed')::bigint < (v_tot->>'houses_listed')::bigint AND (v_after->>'listers_ever')::bigint = (v_tot->>'listers_ever')::bigint - 1,
      'detail', (v_after->>'houses_listed') || ' vs ' || (v_tot->>'houses_listed'));
    RAISE EXCEPTION 'CASE_DONE';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'CASE_DONE' THEN r := r || jsonb_build_object('step', 'H soft-deleted agent case ran', 'pass', false, 'detail', left(SQLERRM, 250)); END IF;
  END;

  RAISE EXCEPTION 'ROLLED BACK REPORT: % passed of % | failing: %', (SELECT count(*) FROM jsonb_array_elements(r) e WHERE (e->>'pass') = 'true'), jsonb_array_length(r),
    COALESCE((SELECT string_agg(e->>'step' || ' ' || COALESCE((e->'detail')::text, ''), '; ') FROM jsonb_array_elements(r) e WHERE (e->>'pass') = 'false'), 'none');
END
$test$;
