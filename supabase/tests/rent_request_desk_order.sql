-- Rolled-back verification for 20261014140000_rent_request_desk_order.sql
--
-- Run against the live database, one block at a time. Each block ends in RAISE EXCEPTION, so nothing is kept and the error
-- text IS the report (steps with "pass"). Every step must pass.
--
-- Block 1  access and inputs
--   A  the twelve desk roles (ten staff roles + landlord_ops + partner_ops) are let in; signed-out and no-role refused;
--      anon and service_role cannot call it; a Service Center manager may rank only the requests routed to them (one
--      outside their queue, an empty list, or a NULL id refuses the whole call); a bad sort raises 22023; NULL / blank sort
--      is best_payers; NULL and empty lists return nothing; 20001 ids refused, 20000 allowed; unknown ids ignored
-- Block 2  the order and the scores
--   B  every request is ranked 1..n once, for each of the three sorts; the three sorts rank the same set
--   C  best_payers is score high to low, then created_at oldest first, then id, no score last; newest / oldest follow
--      created_at; the default and NULL equal best_payers; two calls give the same answer
--   D  the scores are the tenant payment score (the same rows _tenant_payment_score_core gives, and tenant_payment_score
--      for a sample); a subset ranks in the same relative order as in the full list
-- Block 3  nothing else moved
--   E  fingerprints of requests (status, tenant, agent, repaid, Service Center review), collections, ledger and wallets are
--      identical after the calls; the function is not VOLATILE and has no INSERT / UPDATE / DELETE; no other function calls it
--      (no status-transition or approval function is coupled to it)

-- ===== Block 1: A =====
DO $test$
DECLARE
  r jsonb := '[]'::jsonb;
  v_role text; v_user uuid; v_staff uuid; v_plain uuid; v_ok boolean; v_n int;
  v_scm uuid; v_own uuid[]; v_other uuid;
  v_a text; v_b text;
BEGIN
  SELECT user_id INTO v_staff FROM public.user_roles WHERE role = 'operations' AND enabled LIMIT 1;
  SELECT p.id INTO v_plain FROM public.profiles p
   WHERE NOT EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = p.id) LIMIT 1;

  FOREACH v_role IN ARRAY ARRAY['manager','super_admin','coo','ceo','cto','cfo','operations','tenant_ops','agent_ops','financial_ops','landlord_ops','partner_ops'] LOOP
    SELECT ur.user_id INTO v_user FROM public.user_roles ur WHERE ur.role::text = v_role AND ur.enabled
     ORDER BY (SELECT count(*) FROM public.user_roles u2 WHERE u2.user_id = ur.user_id AND u2.enabled), ur.user_id LIMIT 1;
    IF v_user IS NULL THEN
      r := r || jsonb_build_object('step', 'A role ' || v_role, 'pass', NULL, 'detail', 'skipped: no enabled user holds this role');
      CONTINUE;
    END IF;
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_user, 'role', 'authenticated')::text, true);
    v_ok := true;
    BEGIN PERFORM * FROM public.rent_request_desk_order(ARRAY[]::uuid[], 'best_payers'); EXCEPTION WHEN OTHERS THEN v_ok := false; END;
    r := r || jsonb_build_object('step', 'A role ' || v_role || ' is let in', 'pass', v_ok);
  END LOOP;

  PERFORM set_config('request.jwt.claims', '', true);
  v_ok := false;
  BEGIN PERFORM * FROM public.rent_request_desk_order(ARRAY[gen_random_uuid()]); EXCEPTION WHEN OTHERS THEN v_ok := SQLSTATE = '42501'; END;
  r := r || jsonb_build_object('step', 'A signed-out call refused (42501)', 'pass', v_ok);
  IF v_plain IS NOT NULL THEN
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_plain, 'role', 'authenticated')::text, true);
    v_ok := false;
    BEGIN PERFORM * FROM public.rent_request_desk_order((SELECT array_agg(id) FROM (SELECT id FROM public.rent_requests LIMIT 5) q)); EXCEPTION WHEN OTHERS THEN v_ok := SQLSTATE = '42501'; END;
    r := r || jsonb_build_object('step', 'A a user with no role and no Service Center queue is refused (42501)', 'pass', v_ok);
  END IF;
  r := r || jsonb_build_object('step', 'A anon and service_role cannot call it; authenticated can',
    'pass', NOT has_function_privilege('anon', 'public.rent_request_desk_order(uuid[],text)', 'EXECUTE')
        AND NOT has_function_privilege('service_role', 'public.rent_request_desk_order(uuid[],text)', 'EXECUTE')
        AND has_function_privilege('authenticated', 'public.rent_request_desk_order(uuid[],text)', 'EXECUTE'));

  -- a Service Center manager who holds no desk role
  SELECT rr.service_center_manager_id INTO v_scm
    FROM public.rent_requests rr
   WHERE rr.service_center_manager_id IS NOT NULL AND rr.status = 'service_center_review'
     AND NOT EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = rr.service_center_manager_id AND ur.enabled
                       AND ur.role::text IN ('manager','super_admin','coo','ceo','cto','cfo','operations','tenant_ops','agent_ops','financial_ops','landlord_ops','partner_ops'))
   GROUP BY rr.service_center_manager_id ORDER BY count(*) DESC LIMIT 1;
  IF v_scm IS NULL THEN
    r := r || jsonb_build_object('step', 'A Service Center manager', 'pass', NULL, 'detail', 'skipped: no Service Center manager without a desk role has a pending queue');
  ELSE
    SELECT array_agg(id) INTO v_own FROM public.rent_requests WHERE service_center_manager_id = v_scm AND status = 'service_center_review';
    SELECT id INTO v_other FROM public.rent_requests WHERE service_center_manager_id IS DISTINCT FROM v_scm ORDER BY id LIMIT 1;
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_scm, 'role', 'authenticated')::text, true);
    SELECT count(*) INTO v_n FROM public.rent_request_desk_order(v_own, 'best_payers');
    r := r || jsonb_build_object('step', 'A a Service Center manager can rank the requests routed to them', 'pass', v_n = cardinality(v_own), 'detail', jsonb_build_object('queue', cardinality(v_own), 'ranked', v_n));
    v_ok := false;
    BEGIN PERFORM * FROM public.rent_request_desk_order(v_own || v_other, 'best_payers'); EXCEPTION WHEN OTHERS THEN v_ok := SQLSTATE = '42501'; END;
    r := r || jsonb_build_object('step', 'A one request outside their queue refuses the whole call (42501)', 'pass', v_ok);
    v_ok := false;
    BEGIN PERFORM * FROM public.rent_request_desk_order(ARRAY[v_other], 'newest'); EXCEPTION WHEN OTHERS THEN v_ok := SQLSTATE = '42501'; END;
    r := r || jsonb_build_object('step', 'A a request that is not theirs is refused (42501)', 'pass', v_ok);
    v_ok := false;
    BEGIN PERFORM * FROM public.rent_request_desk_order(ARRAY[]::uuid[]); EXCEPTION WHEN OTHERS THEN v_ok := SQLSTATE = '42501'; END;
    r := r || jsonb_build_object('step', 'A an empty list is refused for a Service Center manager (42501)', 'pass', v_ok);
    v_ok := false;
    BEGIN PERFORM * FROM public.rent_request_desk_order(ARRAY[v_own[1], NULL]::uuid[]); EXCEPTION WHEN OTHERS THEN v_ok := SQLSTATE = '42501'; END;
    r := r || jsonb_build_object('step', 'A a NULL id is refused for a Service Center manager (42501)', 'pass', v_ok);
  END IF;

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_staff, 'role', 'authenticated')::text, true);
  v_ok := false;
  BEGIN PERFORM * FROM public.rent_request_desk_order(ARRAY[gen_random_uuid()], 'cheapest'); EXCEPTION WHEN OTHERS THEN v_ok := SQLSTATE = '22023'; END;
  r := r || jsonb_build_object('step', 'A an unknown sort raises 22023', 'pass', v_ok);
  SELECT string_agg(request_id::text, ',' ORDER BY rank) INTO v_a FROM public.rent_request_desk_order((SELECT array_agg(id) FROM (SELECT id FROM public.rent_requests LIMIT 200) q), 'best_payers');
  SELECT string_agg(request_id::text, ',' ORDER BY rank) INTO v_b FROM public.rent_request_desk_order((SELECT array_agg(id) FROM (SELECT id FROM public.rent_requests LIMIT 200) q), NULL);
  r := r || jsonb_build_object('step', 'A a NULL sort means best_payers', 'pass', v_a = v_b AND v_a IS NOT NULL);
  SELECT string_agg(request_id::text, ',' ORDER BY rank) INTO v_b FROM public.rent_request_desk_order((SELECT array_agg(id) FROM (SELECT id FROM public.rent_requests LIMIT 200) q), '  ');
  r := r || jsonb_build_object('step', 'A a blank sort means best_payers', 'pass', v_a = v_b);
  SELECT count(*) INTO v_n FROM public.rent_request_desk_order(NULL, 'best_payers');
  r := r || jsonb_build_object('step', 'A a NULL list returns nothing', 'pass', v_n = 0);
  SELECT count(*) INTO v_n FROM public.rent_request_desk_order(ARRAY[]::uuid[], 'newest');
  r := r || jsonb_build_object('step', 'A an empty list returns nothing', 'pass', v_n = 0);
  SELECT count(*) INTO v_n FROM public.rent_request_desk_order(ARRAY(SELECT gen_random_uuid() FROM generate_series(1, 20000)), 'oldest');
  r := r || jsonb_build_object('step', 'A 20000 unknown ids are allowed and ignored', 'pass', v_n = 0);
  v_ok := false;
  BEGIN PERFORM * FROM public.rent_request_desk_order(ARRAY(SELECT gen_random_uuid() FROM generate_series(1, 20001))); EXCEPTION WHEN OTHERS THEN v_ok := SQLSTATE = '22023'; END;
  r := r || jsonb_build_object('step', 'A 20001 ids refused (22023)', 'pass', v_ok);

  RAISE EXCEPTION 'ROLLED BACK REPORT (block 1): %', jsonb_pretty(r);
END
$test$;

-- ===== Block 2: B, C and D =====
DO $test$
DECLARE
  r jsonb := '[]'::jsonb;
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_staff uuid; v_ids uuid[]; v_total int; v_n int; v_m int; v_k int; s text;
  v_sub uuid[]; v_a text; v_b text;
BEGIN
  SELECT user_id INTO v_staff FROM public.user_roles WHERE role = 'operations' AND enabled LIMIT 1;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_staff, 'role', 'authenticated')::text, true);
  SELECT array_agg(id), count(*) INTO v_ids, v_total FROM public.rent_requests;

  CREATE TEMP TABLE _o (sort text, request_id uuid, tenant_id uuid, rank int, score int, label text, reason text, basis text) ON COMMIT DROP;
  FOREACH s IN ARRAY ARRAY['best_payers', 'newest', 'oldest'] LOOP
    INSERT INTO _o SELECT s, * FROM public.rent_request_desk_order(v_ids, s);
  END LOOP;
  INSERT INTO _o SELECT 'default', * FROM public.rent_request_desk_order(v_ids);
  INSERT INTO _o SELECT 'null', * FROM public.rent_request_desk_order(v_ids, NULL);
  INSERT INTO _o SELECT 'again', * FROM public.rent_request_desk_order(v_ids, 'best_payers');

  -- B: every request is ranked 1..n exactly once, for each sort
  FOREACH s IN ARRAY ARRAY['best_payers', 'newest', 'oldest', 'default', 'null', 'again'] LOOP
    SELECT count(*), count(DISTINCT request_id) INTO v_n, v_m FROM _o WHERE sort = s;
    SELECT count(DISTINCT rank) INTO v_k FROM _o WHERE sort = s;
    r := r || jsonb_build_object('step', 'B ' || s || ': every request is ranked 1..n exactly once',
      'pass', v_n = v_total AND v_m = v_total AND v_k = v_total
          AND (SELECT min(rank) FROM _o WHERE sort = s) = 1 AND (SELECT max(rank) FROM _o WHERE sort = s) = v_total,
      'detail', jsonb_build_object('rows', v_n, 'requests', v_total));
  END LOOP;
  SELECT count(*) INTO v_n FROM (
    SELECT request_id FROM _o WHERE sort = 'best_payers'
    EXCEPT SELECT request_id FROM _o WHERE sort = 'newest') q;
  SELECT count(*) INTO v_m FROM (
    SELECT request_id FROM _o WHERE sort = 'best_payers'
    EXCEPT SELECT request_id FROM _o WHERE sort = 'oldest') q;
  r := r || jsonb_build_object('step', 'B the three sorts rank the same set of requests', 'pass', v_n = 0 AND v_m = 0);

  -- C: the orders
  WITH x AS (
    SELECT o.rank, o.request_id, o.score, rr.created_at AS created,
           lag(o.score) OVER w AS p_score, lag(rr.created_at) OVER w AS p_created, lag(o.request_id) OVER w AS p_id,
           lag(o.score IS NULL) OVER w AS p_null
      FROM _o o JOIN public.rent_requests rr ON rr.id = o.request_id
     WHERE o.sort = 'best_payers'
    WINDOW w AS (ORDER BY o.rank))
  SELECT count(*) INTO v_n FROM x
   WHERE rank > 1 AND NOT (
         (p_null AND score IS NULL AND (p_created < created OR (p_created = created AND p_id < request_id)))
      OR (NOT p_null AND score IS NULL)
      OR (NOT p_null AND score IS NOT NULL AND (
             p_score > score
          OR (p_score = score AND (p_created < created OR (p_created = created AND p_id < request_id))))));
  r := r || jsonb_build_object('step', 'C best_payers: score high to low, then oldest first, then id; requests with no score last', 'pass', v_n = 0, 'detail', v_n);
  WITH x AS (
    SELECT o.rank, o.request_id, rr.created_at AS created,
           lag(rr.created_at) OVER w AS p_created, lag(o.request_id) OVER w AS p_id
      FROM _o o JOIN public.rent_requests rr ON rr.id = o.request_id WHERE o.sort = 'newest'
    WINDOW w AS (ORDER BY o.rank))
  SELECT count(*) INTO v_n FROM x
   WHERE rank > 1 AND NOT (p_created > created OR (p_created = created AND p_id < request_id) OR (created IS NULL AND p_created IS NOT NULL) OR (created IS NULL AND p_created IS NULL AND p_id < request_id));
  r := r || jsonb_build_object('step', 'C newest: created_at newest first, then id', 'pass', v_n = 0, 'detail', v_n);
  WITH x AS (
    SELECT o.rank, o.request_id, rr.created_at AS created,
           lag(rr.created_at) OVER w AS p_created, lag(o.request_id) OVER w AS p_id
      FROM _o o JOIN public.rent_requests rr ON rr.id = o.request_id WHERE o.sort = 'oldest'
    WINDOW w AS (ORDER BY o.rank))
  SELECT count(*) INTO v_n FROM x
   WHERE rank > 1 AND NOT (p_created < created OR (p_created = created AND p_id < request_id) OR (created IS NULL AND p_created IS NOT NULL) OR (created IS NULL AND p_created IS NULL AND p_id < request_id));
  r := r || jsonb_build_object('step', 'C oldest: created_at oldest first, then id', 'pass', v_n = 0, 'detail', v_n);
  SELECT string_agg(request_id::text, ',' ORDER BY rank) INTO v_a FROM _o WHERE sort = 'best_payers';
  SELECT string_agg(request_id::text, ',' ORDER BY rank) INTO v_b FROM _o WHERE sort = 'default';
  r := r || jsonb_build_object('step', 'C the default is best_payers', 'pass', v_a = v_b);
  SELECT string_agg(request_id::text, ',' ORDER BY rank) INTO v_b FROM _o WHERE sort = 'null';
  r := r || jsonb_build_object('step', 'C a NULL sort is best_payers', 'pass', v_a = v_b);
  SELECT string_agg(request_id::text, ',' ORDER BY rank) INTO v_b FROM _o WHERE sort = 'again';
  r := r || jsonb_build_object('step', 'C two calls give the same order', 'pass', v_a = v_b);
  SELECT string_agg(request_id::text, ',' ORDER BY rank) INTO v_a FROM _o WHERE sort = 'newest';
  SELECT string_agg(request_id::text, ',' ORDER BY rank DESC) INTO v_b FROM _o WHERE sort = 'oldest';
  r := r || jsonb_build_object('step', 'C oldest is newest reversed (ties aside)', 'pass', true,
    'detail', jsonb_build_object('identical_when_reversed', v_a = v_b));

  -- D: the scores are the tenant payment score
  SELECT count(*) INTO v_n FROM _o o
    JOIN public.rent_requests rr ON rr.id = o.request_id
    LEFT JOIN public._tenant_payment_score_core(ARRAY(SELECT DISTINCT tenant_id FROM public.rent_requests WHERE tenant_id IS NOT NULL), v_today) c ON c.tenant_id = rr.tenant_id
   WHERE o.sort = 'best_payers'
     AND (o.score IS DISTINCT FROM c.score OR o.label IS DISTINCT FROM c.label OR o.reason IS DISTINCT FROM c.reason OR o.basis IS DISTINCT FROM c.basis OR o.tenant_id IS DISTINCT FROM rr.tenant_id);
  r := r || jsonb_build_object('step', 'D every request carries its tenant''s score, label, reason and basis exactly as _tenant_payment_score_core gives them', 'pass', v_n = 0, 'detail', v_n);
  SELECT count(*) INTO v_n FROM _o o WHERE o.sort = 'best_payers' AND o.tenant_id IS NOT NULL AND o.score IS NULL;
  SELECT count(*) INTO v_m FROM _o o WHERE o.sort = 'best_payers' AND o.tenant_id IS NULL;
  r := r || jsonb_build_object('step', 'D every request with a tenant has a score; a request with no tenant has none and ranks last',
    'pass', v_n = 0 AND NOT EXISTS (SELECT 1 FROM _o o WHERE o.sort = 'best_payers' AND o.tenant_id IS NULL AND o.rank <= (SELECT count(*) FROM _o WHERE sort = 'best_payers' AND tenant_id IS NOT NULL)),
    'detail', jsonb_build_object('without_tenant', v_m));
  SELECT count(*) INTO v_n FROM (
    SELECT o.request_id, o.score FROM _o o WHERE o.sort = 'best_payers' ORDER BY md5(o.request_id::text) LIMIT 300) q
    JOIN public.rent_requests rr ON rr.id = q.request_id
    JOIN public.tenant_payment_score(ARRAY[rr.tenant_id]) f ON f.tenant_id = rr.tenant_id
   WHERE f.score = q.score;
  SELECT count(*) INTO v_m FROM (SELECT o.request_id FROM _o o JOIN public.rent_requests rr ON rr.id = o.request_id WHERE o.sort = 'best_payers' AND rr.tenant_id IS NOT NULL ORDER BY md5(o.request_id::text) LIMIT 300) q;
  r := r || jsonb_build_object('step', 'D the score equals tenant_payment_score (the staff function) for a 300 sample', 'pass', v_n = v_m, 'detail', jsonb_build_object('matched', v_n, 'sampled', v_m));
  -- a subset (one desk's worth) ranks in the same relative order as in the full list
  SELECT array_agg(id) INTO v_sub FROM (SELECT id FROM public.rent_requests WHERE status IN ('pending', 'agent_ops_approved', 'tenant_ops_approved', 'landlord_ops_approved', 'coo_approved') ORDER BY created_at DESC LIMIT 1000) q;
  SELECT string_agg(request_id::text, ',' ORDER BY rank) INTO v_a FROM public.rent_request_desk_order(v_sub, 'best_payers');
  SELECT string_agg(request_id::text, ',' ORDER BY rank) INTO v_b FROM _o WHERE sort = 'best_payers' AND request_id = ANY (v_sub);
  r := r || jsonb_build_object('step', 'D a desk''s own requests rank in the same relative order as in the full list (and only those requests come back)',
    'pass', v_a = v_b AND (SELECT count(*) FROM public.rent_request_desk_order(v_sub, 'best_payers')) = cardinality(v_sub),
    'detail', cardinality(v_sub));
  r := r || jsonb_build_object('step', 'D the label mix of the first 50 under best_payers (informational)', 'pass', true,
    'detail', (SELECT jsonb_object_agg(coalesce(label, 'none'), n) FROM (SELECT label, count(*) n FROM _o WHERE sort = 'best_payers' AND rank <= 50 GROUP BY 1) q));

  RAISE EXCEPTION 'ROLLED BACK REPORT (block 2): %', jsonb_pretty(r);
END
$test$;

-- ===== Block 3: E =====
DO $test$
DECLARE
  r jsonb := '[]'::jsonb;
  v_staff uuid; v_ids uuid[]; fp_before jsonb; fp_after jsonb; v_src text; v_n int;
BEGIN
  SELECT user_id INTO v_staff FROM public.user_roles WHERE role = 'operations' AND enabled LIMIT 1;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_staff, 'role', 'authenticated')::text, true);
  SELECT array_agg(id) INTO v_ids FROM public.rent_requests;

  fp_before := jsonb_build_object(
    'rent_requests', (SELECT md5(string_agg(concat_ws('|', id, status, tenant_id, agent_id, amount_repaid, total_repayment, service_center_manager_id, service_center_reviewed_at, updated_at), ',' ORDER BY id)) FROM public.rent_requests),
    'agent_collections', (SELECT jsonb_build_object('n', count(*), 'sum', COALESCE(sum(amount), 0), 'reversed', count(*) FILTER (WHERE reversed_at IS NOT NULL)) FROM public.agent_collections),
    'ledger', (SELECT jsonb_build_object('n', count(*), 'amount', COALESCE(sum(amount), 0)) FROM public.general_ledger),
    'wallets', (SELECT jsonb_build_object('n', count(*), 'withdrawable', COALESCE(sum(withdrawable), 0), 'float', COALESCE(sum(float_balance), 0)) FROM public.wallet_balances_projection));
  PERFORM count(*) FROM public.rent_request_desk_order(v_ids, 'best_payers');
  PERFORM count(*) FROM public.rent_request_desk_order(v_ids, 'newest');
  PERFORM count(*) FROM public.rent_request_desk_order(v_ids, 'oldest');
  fp_after := jsonb_build_object(
    'rent_requests', (SELECT md5(string_agg(concat_ws('|', id, status, tenant_id, agent_id, amount_repaid, total_repayment, service_center_manager_id, service_center_reviewed_at, updated_at), ',' ORDER BY id)) FROM public.rent_requests),
    'agent_collections', (SELECT jsonb_build_object('n', count(*), 'sum', COALESCE(sum(amount), 0), 'reversed', count(*) FILTER (WHERE reversed_at IS NOT NULL)) FROM public.agent_collections),
    'ledger', (SELECT jsonb_build_object('n', count(*), 'amount', COALESCE(sum(amount), 0)) FROM public.general_ledger),
    'wallets', (SELECT jsonb_build_object('n', count(*), 'withdrawable', COALESCE(sum(withdrawable), 0), 'float', COALESCE(sum(float_balance), 0)) FROM public.wallet_balances_projection));
  r := r || jsonb_build_object('step', 'E requests (status, tenant, agent, repaid, Service Center review, updated_at), collections, ledger and wallets are identical after the calls',
    'pass', fp_before = fp_after, 'detail', CASE WHEN fp_before = fp_after THEN to_jsonb('identical'::text) ELSE jsonb_build_object('before', fp_before, 'after', fp_after) END);

  SELECT prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'rent_request_desk_order';
  r := r || jsonb_build_object('step', 'E the function has no INSERT / UPDATE / DELETE / TRUNCATE and is not VOLATILE',
    'pass', v_src !~* '\m(insert\s+into|update\s+\w|delete\s+from|truncate)\M'
        AND (SELECT provolatile FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'rent_request_desk_order') = 's');
  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname <> 'rent_request_desk_order' AND p.prosrc ILIKE '%rent_request_desk_order%';
  r := r || jsonb_build_object('step', 'E no other function calls it (no status-transition or approval function is coupled to the ordering)', 'pass', v_n = 0, 'detail', v_n);
  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'rent_request_desk_order';
  r := r || jsonb_build_object('step', 'E one function, one signature (no overload)', 'pass', v_n = 1, 'detail', v_n);

  RAISE EXCEPTION 'ROLLED BACK REPORT (block 3): %', jsonb_pretty(r);
END
$test$;
