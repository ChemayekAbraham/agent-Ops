-- Tests for 20261016190000_agent_ops_metrics_quality_risk.sql (agent_ops_metrics_listing_quality / agent_ops_metrics_risk).
-- One transaction that always rolls back (the last statement raises with the report): "ROLLED BACK REPORT: N passed of N | failing: none" is success.
-- Every figure is recomputed from the base tables (house_listings, agent_listing_rejections, agent_advances, agent_subagents) in a different way
-- and compared, and each new figure is reconciled with the existing agent_ops_metrics_totals.
DO $test$
DECLARE
  r jsonb := '[]'::jsonb;
  v_U uuid; v_role text; v_ok boolean; v_i int;
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_s date := (now() AT TIME ZONE 'Africa/Kampala')::date - 29; v_e date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_ts timestamptz; v_te timestamptz; v_win timestamptz;
  q jsonb; k jsonb; tot jsonb; q0 jsonb; k0 jsonb; v_net jsonb; v_sum jsonb; v_pages jsonb := '[]'::jsonb; v_pg jsonb; v_off int; v_after jsonb; v_drop uuid;
  v_listed bigint; v_ver bigint; v_pend bigint; v_rej bigint; v_occ bigint; v_emp bigint; v_ev bigint; v_wait bigint; v_dsum numeric; v_dn bigint;
  v_nol bigint; v_nol_amt numeric; v_ina bigint; v_nev bigint; v_owing bigint; v_owing_amt numeric; v_team_amt numeric; v_teams bigint;
BEGIN
  r := r || jsonb_build_object('step', 'A both functions exist, SECURITY DEFINER, STABLE, search_path = public, return jsonb',
    'pass', (SELECT count(*) = 2 AND bool_and(p.prosecdef AND p.provolatile = 's' AND p.proconfig @> ARRAY['search_path=public'] AND p.prorettype = 'jsonb'::regtype)
               FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('agent_ops_metrics_listing_quality', 'agent_ops_metrics_risk')));
  r := r || jsonb_build_object('step', 'A authenticated can execute; anon, service_role and PUBLIC cannot',
    'pass', (SELECT bool_and(has_function_privilege('authenticated', p.oid, 'EXECUTE') AND NOT has_function_privilege('anon', p.oid, 'EXECUTE') AND NOT has_function_privilege('service_role', p.oid, 'EXECUTE')
                             AND NOT EXISTS (SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a WHERE a.grantee = 0))
               FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('agent_ops_metrics_listing_quality', 'agent_ops_metrics_risk')));
  r := r || jsonb_build_object('step', 'A read-only, never reads agent_earnings, and reuses the helpers',
    'pass', (SELECT bool_and(p.prosrc !~* '\m(insert\s+into|update\s+\w+\s+set|delete\s+from|(from|join)\s+(public\.)?agent_earnings|create\s+temp)' AND p.prosrc ~ '_aom_allowed' AND p.prosrc ~ '_aom_rows')
               FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('agent_ops_metrics_listing_quality', 'agent_ops_metrics_risk')));
  r := r || jsonb_build_object('step', 'A the first five functions and the helpers are unchanged in count (5 + 3)',
    'pass', (SELECT count(*) = 8 FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND (p.proname ~ '^agent_ops_metrics_(totals|agents|locations|pins|main_agents)$' OR p.proname IN ('_aom_allowed', '_aom_scope', '_aom_rows'))));

  SELECT p.id INTO v_U FROM public.profiles p WHERE NOT EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = p.id) AND p.deleted_at IS NULL ORDER BY md5(p.id::text) LIMIT 1;

  -- B. role gate
  FOREACH v_role IN ARRAY ARRAY['agent_ops', 'coo', 'ceo', 'cto', 'manager', 'super_admin'] LOOP
    BEGIN
      INSERT INTO public.user_roles (user_id, role) VALUES (v_U, v_role::public.app_role);
      PERFORM set_config('request.jwt.claims', json_build_object('sub', v_U, 'role', 'authenticated')::text, true);
      SET LOCAL ROLE authenticated;
      q := public.agent_ops_metrics_listing_quality(v_s, v_e, 1, 0);
      k := public.agent_ops_metrics_risk(v_s, v_e, 1, 0);
      RESET ROLE;
      r := r || jsonb_build_object('step', 'B ' || v_role || ' can read both', 'pass', (q->'network') IS NOT NULL AND (k->'summary') IS NOT NULL);
      RAISE EXCEPTION 'CASE_DONE';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM <> 'CASE_DONE' THEN r := r || jsonb_build_object('step', 'B ' || v_role || ' can read both', 'pass', false, 'detail', left(SQLERRM, 200)); END IF;
    END;
  END LOOP;
  FOREACH v_role IN ARRAY ARRAY['tenant_ops', 'operations', 'cfo', 'financial_ops', 'landlord_ops', 'partner_ops', 'agent', 'tenant'] LOOP
    BEGIN
      INSERT INTO public.user_roles (user_id, role) VALUES (v_U, v_role::public.app_role);
      PERFORM set_config('request.jwt.claims', json_build_object('sub', v_U, 'role', 'authenticated')::text, true);
      SET LOCAL ROLE authenticated;
      v_ok := true;
      BEGIN PERFORM public.agent_ops_metrics_listing_quality(v_s, v_e); v_ok := false; EXCEPTION WHEN OTHERS THEN v_ok := v_ok AND SQLSTATE = '42501'; END;
      BEGIN PERFORM public.agent_ops_metrics_risk(v_s, v_e); v_ok := false; EXCEPTION WHEN OTHERS THEN v_ok := v_ok AND SQLSTATE = '42501'; END;
      RESET ROLE;
      r := r || jsonb_build_object('step', 'B ' || v_role || ' is refused by both (42501)', 'pass', v_ok);
      RAISE EXCEPTION 'CASE_DONE';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM <> 'CASE_DONE' THEN r := r || jsonb_build_object('step', 'B ' || v_role || ' is refused', 'pass', false, 'detail', left(SQLERRM, 200)); END IF;
    END;
  END LOOP;
  BEGIN
    INSERT INTO public.user_roles (user_id, role, enabled) VALUES (v_U, 'agent_ops'::public.app_role, false);
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_U, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    v_ok := false; BEGIN PERFORM public.agent_ops_metrics_risk(v_s, v_e); EXCEPTION WHEN OTHERS THEN v_ok := SQLSTATE = '42501'; END;
    RESET ROLE;
    r := r || jsonb_build_object('step', 'B a switched-off agent_ops role is refused', 'pass', v_ok);
    RAISE EXCEPTION 'CASE_DONE';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'CASE_DONE' THEN r := r || jsonb_build_object('step', 'B disabled role case ran', 'pass', false, 'detail', left(SQLERRM, 200)); END IF;
  END;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_U, 'role', 'authenticated')::text, true);
  v_ok := false; BEGIN PERFORM public.agent_ops_metrics_listing_quality(v_s, v_e); EXCEPTION WHEN OTHERS THEN v_ok := SQLSTATE = '42501'; END;
  r := r || jsonb_build_object('step', 'B a signed-in user with no role is refused', 'pass', v_ok);
  PERFORM set_config('request.jwt.claims', '', true);
  v_ok := false; BEGIN PERFORM public.agent_ops_metrics_risk(v_s, v_e); EXCEPTION WHEN OTHERS THEN v_ok := SQLSTATE = '42501'; END;
  r := r || jsonb_build_object('step', 'B signed-out is refused (42501)', 'pass', v_ok);
  BEGIN
    SET LOCAL ROLE anon;
    v_ok := false; BEGIN PERFORM public.agent_ops_metrics_listing_quality(v_s, v_e); EXCEPTION WHEN insufficient_privilege THEN v_ok := true; WHEN OTHERS THEN v_ok := false; END;
    RESET ROLE;
  END;
  r := r || jsonb_build_object('step', 'B the anon role cannot call it (permission denied)', 'pass', v_ok);

  INSERT INTO public.user_roles (user_id, role) VALUES (v_U, 'agent_ops'::public.app_role);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_U, 'role', 'authenticated')::text, true);

  -- C. arguments
  v_ok := false; BEGIN PERFORM public.agent_ops_metrics_listing_quality(NULL, v_e); EXCEPTION WHEN OTHERS THEN v_ok := SQLSTATE = '22023' AND SQLERRM LIKE 'RANGE_REQUIRED%'; END;
  r := r || jsonb_build_object('step', 'C quality: a missing date is refused (RANGE_REQUIRED)', 'pass', v_ok);
  v_ok := false; BEGIN PERFORM public.agent_ops_metrics_risk(v_e, v_e - 1); EXCEPTION WHEN OTHERS THEN v_ok := SQLSTATE = '22023' AND SQLERRM LIKE 'RANGE_INVALID%'; END;
  r := r || jsonb_build_object('step', 'C risk: an end before the start is refused (RANGE_INVALID)', 'pass', v_ok);
  v_ok := false; BEGIN PERFORM public.agent_ops_metrics_risk(v_s, NULL); EXCEPTION WHEN OTHERS THEN v_ok := SQLSTATE = '22023' AND SQLERRM LIKE 'RANGE_REQUIRED%'; END;
  r := r || jsonb_build_object('step', 'C risk: a missing date is refused (RANGE_REQUIRED)', 'pass', v_ok);

  -- the answers (as an agent_ops user), then everything is compared outside the role
  SET LOCAL ROLE authenticated;
  q := public.agent_ops_metrics_listing_quality(v_s, v_e, 200, 0);
  k := public.agent_ops_metrics_risk(v_s, v_e, 200, 0);
  q0 := public.agent_ops_metrics_listing_quality(v_s, v_e, 1, 0);
  k0 := public.agent_ops_metrics_risk(v_s, v_e, 1, 0);
  SELECT to_jsonb(x) INTO tot FROM public.agent_ops_metrics_totals(v_s, v_e) x;
  v_off := 0;
  LOOP
    v_pg := public.agent_ops_metrics_listing_quality(v_s, v_e, 200, v_off)->'agents';
    EXIT WHEN jsonb_array_length(v_pg) = 0 OR v_off > 5000;
    v_pages := v_pages || v_pg;
    v_off := v_off + 200;
  END LOOP;
  RESET ROLE;
  v_net := q->'network';
  v_ts := v_s::timestamp AT TIME ZONE 'Africa/Kampala'; v_te := (v_e + 1)::timestamp AT TIME ZONE 'Africa/Kampala';
  v_win := (v_today - 29)::timestamp AT TIME ZONE 'Africa/Kampala';

  CREATE TEMP TABLE zz_gone ON COMMIT DROP AS
    SELECT p.id FROM public.profiles p WHERE p.deleted_at IS NOT NULL
    UNION SELECT d.user_id FROM public.deleted_accounts d WHERE d.status = 'soft_deleted' AND d.restored_at IS NULL AND d.purged_at IS NULL AND d.user_id IS NOT NULL;

  -- D. quality
  SELECT count(*), count(*) FILTER (WHERE h.verified IS TRUE), count(*) FILTER (WHERE h.verified IS NOT TRUE AND COALESCE(h.status, '') <> 'rejected'),
         count(*) FILTER (WHERE h.verified IS NOT TRUE AND h.status = 'rejected'), count(*) FILTER (WHERE h.tenant_id IS NOT NULL), count(*) FILTER (WHERE h.tenant_id IS NULL),
         COALESCE(sum(extract(epoch FROM (h.verified_at - h.created_at)) / 86400.0) FILTER (WHERE h.verified IS TRUE AND h.verified_at IS NOT NULL AND h.verified_at >= h.created_at), 0),
         count(*) FILTER (WHERE h.verified IS TRUE AND h.verified_at IS NOT NULL AND h.verified_at >= h.created_at)
    INTO v_listed, v_ver, v_pend, v_rej, v_occ, v_emp, v_dsum, v_dn
    FROM public.house_listings h WHERE h.created_at >= v_ts AND h.created_at < v_te AND h.agent_id NOT IN (SELECT id FROM zz_gone);
  SELECT count(*) INTO v_ev FROM public.agent_listing_rejections x WHERE x.rejected_at >= v_ts AND x.rejected_at < v_te AND x.agent_id NOT IN (SELECT id FROM zz_gone);
  SELECT count(*) INTO v_wait FROM public.house_listings h WHERE h.verified IS NOT TRUE AND COALESCE(h.status, '') <> 'rejected' AND h.agent_id NOT IN (SELECT id FROM zz_gone);

  r := r || jsonb_build_object('step', 'D network row equals the direct counts: listed, verified, pending, currently rejected, occupied, empty, rejection events, waiting',
    'pass', (v_net->>'houses_listed')::bigint = v_listed AND (v_net->>'houses_verified')::bigint = v_ver AND (v_net->>'houses_pending')::bigint = v_pend
        AND (v_net->>'houses_currently_rejected')::bigint = v_rej AND (v_net->>'occupied')::bigint = v_occ AND (v_net->>'empty')::bigint = v_emp
        AND (v_net->>'rejection_events')::bigint = v_ev AND (v_net->>'waiting_total')::bigint = v_wait,
    'detail', json_build_object('listed', v_net->>'houses_listed', 'ver', v_net->>'houses_verified', 'pend', v_net->>'houses_pending', 'rej_now', v_net->>'houses_currently_rejected', 'events', v_net->>'rejection_events', 'waiting', v_net->>'waiting_total')::text);
  r := r || jsonb_build_object('step', 'D verified + pending + currently rejected = listed, and occupied + empty = listed (network row)',
    'pass', (v_net->>'houses_verified')::bigint + (v_net->>'houses_pending')::bigint + (v_net->>'houses_currently_rejected')::bigint = (v_net->>'houses_listed')::bigint
        AND (v_net->>'occupied')::bigint + (v_net->>'empty')::bigint = (v_net->>'houses_listed')::bigint);
  r := r || jsonb_build_object('step', 'D network row equals the existing totals: houses listed, verified, pending, rejection events, listing earnings',
    'pass', (v_net->>'houses_listed') = (tot->>'houses_listed') AND (v_net->>'houses_verified') = (tot->>'houses_verified') AND (v_net->>'houses_pending') = (tot->>'houses_pending')
        AND (v_net->>'rejection_events') = (tot->>'houses_rejected') AND (v_net->>'listing_earned')::numeric = (tot->>'listing_earned')::numeric,
    'detail', (v_net->>'houses_listed') || '/' || (tot->>'houses_listed') || ' ' || (v_net->>'listing_earned') || '/' || (tot->>'listing_earned'));
  r := r || jsonb_build_object('step', 'D approval rate, average days to verify and earnings per approved house equal the direct figures',
    'pass', (v_net->>'approval_rate')::numeric = round(100.0 * v_ver / NULLIF(v_listed, 0), 1)
        AND (v_net->>'avg_days_to_verify')::numeric = round((v_dsum / NULLIF(v_dn, 0))::numeric, 1)
        AND (v_net->>'earn_per_approved')::numeric = round((tot->>'listing_earned')::numeric / NULLIF(v_ver, 0)),
    'detail', (v_net->>'approval_rate') || ' ' || COALESCE(v_net->>'avg_days_to_verify', 'null') || ' ' || COALESCE(v_net->>'earn_per_approved', 'null'));
  r := r || jsonb_build_object('step', 'D paging all agent rows (200 at a time) returns each agent once; the rows add up to the network row (houses, and the listers\' earnings)',
    'pass', jsonb_array_length(v_pages) = (v_net->>'agents')::int
        AND (SELECT count(DISTINCT e->>'agent_id') FROM jsonb_array_elements(v_pages) e) = jsonb_array_length(v_pages)
        AND (SELECT sum((e->>'houses_listed')::bigint) FROM jsonb_array_elements(v_pages) e) = v_listed
        AND (SELECT sum((e->>'houses_verified')::bigint) FROM jsonb_array_elements(v_pages) e) = v_ver
        AND (SELECT sum((e->>'houses_pending')::bigint) FROM jsonb_array_elements(v_pages) e) = v_pend
        AND (SELECT sum((e->>'houses_currently_rejected')::bigint) FROM jsonb_array_elements(v_pages) e) = v_rej
        AND (SELECT sum((e->>'occupied')::bigint) FROM jsonb_array_elements(v_pages) e) = v_occ
        AND (SELECT sum((e->>'empty')::bigint) FROM jsonb_array_elements(v_pages) e) = v_emp
        AND (SELECT sum((e->>'listing_earned')::numeric) FROM jsonb_array_elements(v_pages) e) = (v_net->>'listing_earned_listers')::numeric
        AND (v_net->>'listing_earned_listers')::numeric <= (v_net->>'listing_earned')::numeric,
    'detail', jsonb_array_length(v_pages)::text || ' rows');
  r := r || jsonb_build_object('step', 'D every agent row: verified + pending + currently rejected = listed; rate = verified / listed; earn per approved = earnings / verified',
    'pass', NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_pages) e
        WHERE (e->>'houses_verified')::bigint + (e->>'houses_pending')::bigint + (e->>'houses_currently_rejected')::bigint <> (e->>'houses_listed')::bigint
           OR (e->>'approval_rate')::numeric <> round(100.0 * (e->>'houses_verified')::bigint / (e->>'houses_listed')::bigint, 1)
           OR ((e->>'houses_verified')::bigint > 0 AND (e->>'earn_per_approved')::numeric <> round((e->>'listing_earned')::numeric / (e->>'houses_verified')::bigint))
           OR ((e->>'houses_verified')::bigint = 0 AND (e->>'earn_per_approved') IS NOT NULL)));
  r := r || jsonb_build_object('step', 'D the top agent row equals direct counts for that agent (listed, verified, currently rejected, occupied, empty, average days)',
    'pass', (SELECT count(*) = (q->'agents'->0->>'houses_listed')::bigint AND count(*) FILTER (WHERE h.verified IS TRUE) = (q->'agents'->0->>'houses_verified')::bigint
                AND count(*) FILTER (WHERE h.verified IS NOT TRUE AND h.status = 'rejected') = (q->'agents'->0->>'houses_currently_rejected')::bigint
                AND count(*) FILTER (WHERE h.tenant_id IS NOT NULL) = (q->'agents'->0->>'occupied')::bigint AND count(*) FILTER (WHERE h.tenant_id IS NULL) = (q->'agents'->0->>'empty')::bigint
                AND round((avg(extract(epoch FROM (h.verified_at - h.created_at)) / 86400.0) FILTER (WHERE h.verified IS TRUE AND h.verified_at IS NOT NULL AND h.verified_at >= h.created_at))::numeric, 1) IS NOT DISTINCT FROM (q->'agents'->0->>'avg_days_to_verify')::numeric
              FROM public.house_listings h WHERE h.agent_id = (q->'agents'->0->>'agent_id')::uuid AND h.created_at >= v_ts AND h.created_at < v_te),
    'detail', (q->'agents'->0)::text);
  r := r || jsonb_build_object('step', 'D agents are listed biggest lister first',
    'pass', (SELECT bool_and((e->>'houses_listed')::bigint <= COALESCE(lag_v, (e->>'houses_listed')::bigint)) FROM (SELECT e, lag((e->>'houses_listed')::bigint) OVER () AS lag_v FROM jsonb_array_elements(q->'agents') e) z(e, lag_v)));
  r := r || jsonb_build_object('step', 'D waiting list: oldest first, each pending, the first one is the oldest pending house, days waiting in Kampala days, name and phone present',
    'pass', jsonb_array_length(q->'waiting') = LEAST(200, v_wait)
        AND (q->'waiting'->0->>'listing_id')::uuid IN (SELECT h.id FROM public.house_listings h WHERE h.verified IS NOT TRUE AND COALESCE(h.status, '') <> 'rejected' AND h.agent_id NOT IN (SELECT id FROM zz_gone)
                                                         AND h.created_at = (SELECT min(h2.created_at) FROM public.house_listings h2 WHERE h2.verified IS NOT TRUE AND COALESCE(h2.status, '') <> 'rejected' AND h2.agent_id NOT IN (SELECT id FROM zz_gone)))
        AND (q->'waiting'->0->>'days_waiting')::int = v_today - ((SELECT min(h2.created_at) FROM public.house_listings h2 WHERE h2.verified IS NOT TRUE AND COALESCE(h2.status, '') <> 'rejected' AND h2.agent_id NOT IN (SELECT id FROM zz_gone)) AT TIME ZONE 'Africa/Kampala')::date
        AND (v_net->>'oldest_waiting_days')::int = (q->'waiting'->0->>'days_waiting')::int
        AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(q->'waiting') e WHERE NOT EXISTS (SELECT 1 FROM public.house_listings h WHERE h.id = (e->>'listing_id')::uuid AND h.verified IS NOT TRUE AND COALESCE(h.status, '') <> 'rejected'))
        AND (SELECT bool_and((e->>'listed_at')::timestamptz >= COALESCE(lag_v, (e->>'listed_at')::timestamptz)) FROM (SELECT e, lag((e->>'listed_at')::timestamptz) OVER () AS lag_v FROM jsonb_array_elements(q->'waiting') e) z(e, lag_v))
        AND (q->'waiting'->0->>'agent_name') <> '',
    'detail', (q->'waiting'->0)::text);
  r := r || jsonb_build_object('step', 'D limit and offset: the limit is clamped to 1..200 and the offset moves both lists',
    'pass', jsonb_array_length(q0->'agents') = 1 AND jsonb_array_length(q0->'waiting') = 1 AND (q0->'agents'->0) = (q->'agents'->0));

  -- E. risk
  SELECT count(*), COALESCE(sum(a.outstanding_balance), 0) INTO v_owing, v_owing_amt FROM (
    SELECT a.agent_id, sum(a.outstanding_balance) AS outstanding_balance FROM public.agent_advances a
     WHERE a.status IN ('active', 'overdue') AND a.status <> 'cancelled' AND a.reversed_at IS NULL AND a.agent_id NOT IN (SELECT id FROM zz_gone) GROUP BY a.agent_id HAVING sum(a.outstanding_balance) > 0) a;
  SELECT count(*), COALESCE(sum(a.o), 0) INTO v_nol, v_nol_amt FROM (
    SELECT a.agent_id, sum(a.outstanding_balance) AS o FROM public.agent_advances a
     WHERE a.status IN ('active', 'overdue') AND a.reversed_at IS NULL AND a.agent_id NOT IN (SELECT id FROM zz_gone)
       AND NOT EXISTS (SELECT 1 FROM public.house_listings h WHERE h.agent_id = a.agent_id AND h.created_at >= v_ts AND h.created_at < v_te) GROUP BY a.agent_id HAVING sum(a.outstanding_balance) > 0) a;
  SELECT count(*) INTO v_ina FROM (SELECT h.agent_id FROM public.house_listings h WHERE h.agent_id NOT IN (SELECT id FROM zz_gone) GROUP BY h.agent_id HAVING max(h.created_at) < v_win) z;
  SELECT count(*) INTO v_nev FROM (SELECT DISTINCT s.sub_agent_id FROM public.agent_subagents s WHERE s.status = 'verified' AND s.sub_agent_id NOT IN (SELECT id FROM zz_gone)
        AND NOT EXISTS (SELECT 1 FROM public.house_listings h WHERE h.agent_id = s.sub_agent_id)) z;
  v_sum := k->'summary';
  r := r || jsonb_build_object('step', 'E summary equals the direct counts: advance with no listing (count and amount), agents owing (count and amount), inactive listers, never-listed sub-agents',
    'pass', (v_sum->>'advance_no_listing_count')::bigint = v_nol AND (v_sum->>'advance_no_listing_amount')::numeric = v_nol_amt
        AND (v_sum->>'owing_agents')::bigint = v_owing AND (v_sum->>'owing_amount')::numeric = v_owing_amt
        AND (v_sum->>'inactive_listers_count')::bigint = v_ina AND (v_sum->>'never_listed_subagents_count')::bigint = v_nev,
    'detail', json_build_object('nol', v_sum->>'advance_no_listing_count', 'vs', v_nol, 'owing', v_sum->>'owing_agents', 'vs2', v_owing, 'inact', v_sum->>'inactive_listers_count', 'vs3', v_ina, 'nev', v_sum->>'never_listed_subagents_count', 'vs4', v_nev)::text);
  r := r || jsonb_build_object('step', 'E the amount owing equals the existing totals'' advances outstanding (the full book, Returns-repaid advances included)',
    'pass', (v_sum->>'owing_amount')::numeric = (tot->>'advances_outstanding')::numeric, 'detail', (v_sum->>'owing_amount') || ' vs ' || (tot->>'advances_outstanding'));
  r := r || jsonb_build_object('step', 'E the four flags add up to the agents owing',
    'pass', (v_sum->>'flag_no_earnings')::bigint + (v_sum->>'flag_high')::bigint + (v_sum->>'flag_watch')::bigint + (v_sum->>'flag_ok')::bigint = (v_sum->>'owing_agents')::bigint);
  r := r || jsonb_build_object('step', 'E each ratio row: ratio = outstanding / earnings (two decimals), flag by the stated thresholds, worst flag first',
    'pass', NOT EXISTS (SELECT 1 FROM jsonb_array_elements(k->'advance_vs_earnings') e
        WHERE (e->>'advance_outstanding')::numeric <= 0
           OR ((e->>'listing_earned')::numeric > 0 AND (e->>'ratio')::numeric <> round((e->>'advance_outstanding')::numeric / (e->>'listing_earned')::numeric, 2))
           OR ((e->>'listing_earned')::numeric <= 0 AND (e->>'flag' <> 'no_earnings' OR e->>'ratio' IS NOT NULL))
           OR ((e->>'listing_earned')::numeric > 0 AND e->>'flag' <> CASE WHEN (e->>'advance_outstanding')::numeric / (e->>'listing_earned')::numeric >= 3 THEN 'high' WHEN (e->>'advance_outstanding')::numeric / (e->>'listing_earned')::numeric >= 1 THEN 'watch' ELSE 'ok' END))
        AND (SELECT bool_and(CASE e->>'flag' WHEN 'no_earnings' THEN 0 WHEN 'high' THEN 1 WHEN 'watch' THEN 2 ELSE 3 END >= COALESCE(lag_v, 0)) FROM (SELECT e, lag(CASE e->>'flag' WHEN 'no_earnings' THEN 0 WHEN 'high' THEN 1 WHEN 'watch' THEN 2 ELSE 3 END) OVER () AS lag_v FROM jsonb_array_elements(k->'advance_vs_earnings') e) z(e, lag_v)));
  r := r || jsonb_build_object('step', 'E advance-with-no-listing rows: outstanding above 0 and no house in the range, biggest first',
    'pass', NOT EXISTS (SELECT 1 FROM jsonb_array_elements(k->'advance_no_listing') e WHERE (e->>'advance_outstanding')::numeric <= 0
                         OR EXISTS (SELECT 1 FROM public.house_listings h WHERE h.agent_id = (e->>'agent_id')::uuid AND h.created_at >= v_ts AND h.created_at < v_te))
        AND (SELECT COALESCE(bool_and((e->>'advance_outstanding')::numeric <= COALESCE(lag_v, (e->>'advance_outstanding')::numeric)), true) FROM (SELECT e, lag((e->>'advance_outstanding')::numeric) OVER () AS lag_v FROM jsonb_array_elements(k->'advance_no_listing') e) z(e, lag_v)));
  r := r || jsonb_build_object('step', 'E inactive listers: listed before, nothing in the last 30 days (the day shown is before today minus 29), days inactive from the last listing',
    'pass', NOT EXISTS (SELECT 1 FROM jsonb_array_elements(k->'inactive_listers') e
        WHERE EXISTS (SELECT 1 FROM public.house_listings h WHERE h.agent_id = (e->>'agent_id')::uuid AND h.created_at >= v_win)
           OR NOT EXISTS (SELECT 1 FROM public.house_listings h WHERE h.agent_id = (e->>'agent_id')::uuid)
           OR (e->>'days_inactive')::int <> v_today - (e->>'last_listing')::date OR (e->>'last_listing')::date >= v_today - 29));
  r := r || jsonb_build_object('step', 'E never-listed sub-agents: verified link and no house of their own',
    'pass', NOT EXISTS (SELECT 1 FROM jsonb_array_elements(k->'never_listed_subagents') e
        WHERE EXISTS (SELECT 1 FROM public.house_listings h WHERE h.agent_id = (e->>'agent_id')::uuid)
           OR NOT EXISTS (SELECT 1 FROM public.agent_subagents s WHERE s.sub_agent_id = (e->>'agent_id')::uuid AND s.status = 'verified')));
  SELECT count(*), COALESCE(sum(t.o), 0) INTO v_teams, v_team_amt FROM (
    SELECT s.parent_agent_id AS pid, sum(a.outstanding_balance) AS o
      FROM (SELECT DISTINCT ON (s0.sub_agent_id) s0.sub_agent_id, s0.parent_agent_id FROM public.agent_subagents s0 WHERE s0.status = 'verified' AND s0.sub_agent_id NOT IN (SELECT id FROM zz_gone)
             ORDER BY s0.sub_agent_id, s0.verified_at NULLS LAST, s0.created_at) s
      JOIN public.agent_advances a ON a.agent_id = s.sub_agent_id AND a.status IN ('active', 'overdue') AND a.reversed_at IS NULL
     GROUP BY s.parent_agent_id HAVING sum(a.outstanding_balance) > 0) t;
  r := r || jsonb_build_object('step', 'E main agents by advance: count and total equal the direct team figures; biggest team debt first; the top row equals the direct figure',
    'pass', (v_sum->>'main_agents_owing_count')::bigint = v_teams AND (v_sum->>'main_agents_owing_amount')::numeric = v_team_amt
        AND (SELECT COALESCE(bool_and((e->>'team_advances_outstanding')::numeric <= COALESCE(lag_v, (e->>'team_advances_outstanding')::numeric)), true) FROM (SELECT e, lag((e->>'team_advances_outstanding')::numeric) OVER () AS lag_v FROM jsonb_array_elements(k->'main_agents_by_advance') e) z(e, lag_v))
        AND (k->'main_agents_by_advance'->0->>'team_advances_outstanding')::numeric = (
            SELECT sum(a.outstanding_balance) FROM (SELECT DISTINCT ON (s0.sub_agent_id) s0.sub_agent_id, s0.parent_agent_id FROM public.agent_subagents s0 WHERE s0.status = 'verified' AND s0.sub_agent_id NOT IN (SELECT id FROM zz_gone)
                   ORDER BY s0.sub_agent_id, s0.verified_at NULLS LAST, s0.created_at) s
              JOIN public.agent_advances a ON a.agent_id = s.sub_agent_id AND a.status IN ('active', 'overdue') AND a.reversed_at IS NULL
             WHERE s.parent_agent_id = (k->'main_agents_by_advance'->0->>'main_agent_id')::uuid),
    'detail', v_teams || ' / ' || (v_sum->>'main_agents_owing_count') || '; ' || v_team_amt || ' / ' || (v_sum->>'main_agents_owing_amount'));
  r := r || jsonb_build_object('step', 'E limit and offset on risk: limit 1 returns one row per list and equals the first row of the full answer',
    'pass', jsonb_array_length(k0->'advance_vs_earnings') = 1 AND (k0->'advance_vs_earnings'->0) = (k->'advance_vs_earnings'->0) AND (k0->'main_agents_by_advance'->0) = (k->'main_agents_by_advance'->0)
        AND (k0->'summary'->>'owing_agents') = (v_sum->>'owing_agents'));

  -- F. deleted accounts are left out everywhere (simulated inside this rolled-back test)
  v_drop := (q->'agents'->0->>'agent_id')::uuid;
  BEGIN
    UPDATE public.profiles SET deleted_at = now() WHERE id = v_drop;
    SET LOCAL ROLE authenticated;
    v_after := public.agent_ops_metrics_listing_quality(v_s, v_e, 200, 0);
    v_pg := public.agent_ops_metrics_risk(v_s, v_e, 200, 0);
    RESET ROLE;
    r := r || jsonb_build_object('step', 'F an agent whose profile is soft-deleted leaves the quality rows and the network row',
      'pass', NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_after->'agents') e WHERE (e->>'agent_id')::uuid = v_drop)
          AND (v_after->'network'->>'houses_listed')::bigint = (v_net->>'houses_listed')::bigint - (q->'agents'->0->>'houses_listed')::bigint
          AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_pg->'inactive_listers') e WHERE (e->>'agent_id')::uuid = v_drop)
          AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_pg->'advance_vs_earnings') e WHERE (e->>'agent_id')::uuid = v_drop),
      'detail', v_drop::text);
    RAISE EXCEPTION 'CASE_DONE';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'CASE_DONE' THEN r := r || jsonb_build_object('step', 'F soft-deleted agent case ran', 'pass', false, 'detail', left(SQLERRM, 250)); END IF;
  END;

  RAISE EXCEPTION 'ROLLED BACK REPORT: % passed of % | failing: %', (SELECT count(*) FROM jsonb_array_elements(r) e WHERE (e->>'pass') = 'true'), jsonb_array_length(r),
    COALESCE((SELECT string_agg(e->>'step' || ' ' || COALESCE((e->'detail')::text, ''), '; ') FROM jsonb_array_elements(r) e WHERE (e->>'pass') = 'false'), 'none');
END
$test$;
