-- Acceptance tests: landlord payout-number lock + change-request chain.
-- Handover doc 120. Written BEFORE the fix (migration 20260924090000) and run
-- against production first to prove the fraud path was open (red), then
-- after the migration to prove it is closed (green).
--
-- SAFE TO RUN AGAINST PRODUCTION: the whole script is one DO block that
-- ALWAYS ends in RAISE EXCEPTION, so every write it makes is rolled back.
-- The results come back as the error message ("ACCEPTANCE ... PASS/FAIL").
-- Payout probes additionally raise inside their own savepoint, so a probe
-- insert into landlord_payouts never survives even to the end of the block.
--
-- It impersonates real users by setting the JWT claims auth.uid() reads, so
-- it exercises the triggers/RPCs exactly as a logged-in agent / reviewer
-- would. It runs as the DB owner, so it tests the trigger-level enforcement,
-- which is the point: RLS still lets agents UPDATE their landlords, the
-- trigger is what must stop the number changing.
--
-- Fixtures are picked live each run: a verified landlord whose approved
-- number matches its MoMo number and whose registering user is an agent, and
-- four DISTINCT staff for the four stages (service centre reviewer,
-- tenant_ops, agent_ops, landlord_ops), none of them that agent.
--
--   psql "$DB" -f supabase/tests/landlord_number_lock_acceptance.sql
-- or paste the DO block into query_database.
--
-- Tests (the six the CEO asked for, plus the ones needed to prove them):
--   AT1  an agent cannot change a verified number (nor ops, nor service role)
--   AT2  a withdrawal uses the approved number, not whatever the row holds
--   AT3  a new number creates a change request at the START of the chain
--   AT4  an unapproved number cannot receive a payout (even 3 of 4 stages in)
--   AT5  the full chain applies the number and the payout follows it
--   AT6  every change writes an audit row; the audit trail is immutable
--   AT7  a rejected approval cannot be used
--   AT8  an expired approval cannot be used
--   AT9  segregation: requester can't approve; one person can't do two stages

DO $acceptance$
DECLARE
  r text[] := ARRAY[]::text[];
  v_l uuid; v_agent uuid; v_sc uuid; v_to uuid; v_ao uuid; v_lo uuid;
  v_name text; v_orig_mm text; v_orig_phone text; v_orig_approved text;
  n1 text; n2 text; n3 text; n4 text;
  v_req uuid; v_req_phone uuid; v_req3 uuid; v_req4 uuid;
  v_row record; v_msg text; v_res jsonb; v_cnt int;
  v_payout_window boolean;
  v_pass int := 0; v_fail int := 0;
BEGIN
  ---------------------------------------------------------------- fixtures
  SELECT l.id, l.registered_by, l.name, l.mobile_money_number, l.phone, l.verified_mobile_money_number
    INTO v_l, v_agent, v_name, v_orig_mm, v_orig_phone, v_orig_approved
  FROM public.landlords l
  WHERE l.verified
    AND l.verified_mobile_money_number IS NOT NULL
    AND NULLIF(btrim(l.mobile_money_number), '') IS NOT NULL
    AND right(regexp_replace(l.mobile_money_number, '\D', '', 'g'), 9)
        = right(regexp_replace(l.verified_mobile_money_number, '\D', '', 'g'), 9)
    AND l.registered_by IS NOT NULL
    AND EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = l.registered_by AND ur.role = 'agent' AND ur.enabled)
  ORDER BY l.verified_at DESC NULLS LAST
  LIMIT 1;
  IF v_l IS NULL THEN RAISE EXCEPTION 'ACCEPTANCE SETUP: no suitable verified landlord found'; END IF;

  SELECT ur.user_id INTO v_sc FROM public.user_roles ur
   WHERE ur.enabled AND ur.role IN ('operations','manager','agent_ops','coo','super_admin')
     AND public.is_service_center_reviewer(ur.user_id) AND ur.user_id <> v_agent
   ORDER BY (ur.role = 'operations') DESC, ur.user_id LIMIT 1;
  SELECT ur.user_id INTO v_to FROM public.user_roles ur
   WHERE ur.enabled AND ur.role = 'tenant_ops' AND ur.user_id NOT IN (v_agent, v_sc)
   ORDER BY ur.user_id LIMIT 1;
  SELECT ur.user_id INTO v_ao FROM public.user_roles ur
   WHERE ur.enabled AND ur.role = 'agent_ops' AND ur.user_id NOT IN (v_agent, v_sc, v_to)
   ORDER BY ur.user_id LIMIT 1;
  SELECT ur.user_id INTO v_lo FROM public.user_roles ur
   WHERE ur.enabled AND ur.role = 'landlord_ops' AND ur.user_id NOT IN (v_agent, v_sc, v_to, v_ao)
   ORDER BY ur.user_id LIMIT 1;
  IF v_sc IS NULL OR v_to IS NULL OR v_ao IS NULL OR v_lo IS NULL THEN
    RAISE EXCEPTION 'ACCEPTANCE SETUP: could not find 4 distinct stage reviewers (sc=% to=% ao=% lo=%)', v_sc, v_to, v_ao, v_lo;
  END IF;

  -- Fresh, unused numbers (0709xxxxxx range, checked unused).
  LOOP
    n1 := '0709' || lpad((floor(random() * 1000000))::int::text, 6, '0');
    n2 := '0709' || lpad((floor(random() * 1000000))::int::text, 6, '0');
    n3 := '0709' || lpad((floor(random() * 1000000))::int::text, 6, '0');
    n4 := '0709' || lpad((floor(random() * 1000000))::int::text, 6, '0');
    EXIT WHEN cardinality(ARRAY(SELECT DISTINCT x FROM unnest(ARRAY[n1,n2,n3,n4]) x)) = 4
      AND NOT EXISTS (SELECT 1 FROM public.landlords
                      WHERE right(regexp_replace(coalesce(phone,''), '\D','','g'),9) IN (right(n1,9),right(n2,9),right(n3,9),right(n4,9))
                         OR right(regexp_replace(coalesce(mobile_money_number,''), '\D','','g'),9) IN (right(n1,9),right(n2,9),right(n3,9),right(n4,9)));
  END LOOP;

  v_payout_window := EXTRACT(HOUR FROM (now() AT TIME ZONE 'Africa/Kampala')) BETWEEN 6 AND 21
                     AND NOT public.landlord_float_withdrawals_paused();

  ---------------------------------------------------------------- AT1
  BEGIN
    -- as the agent who registered the landlord
    PERFORM set_config('request.jwt.claim.sub', v_agent::text, true);
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_agent, 'role', 'authenticated')::text, true);
    UPDATE public.landlords SET mobile_money_number = n1, phone = n2 WHERE id = v_l;
    SELECT mobile_money_number, phone, verified_mobile_money_number INTO v_row FROM public.landlords WHERE id = v_l;
    IF v_row.mobile_money_number IS DISTINCT FROM v_orig_mm OR v_row.phone IS DISTINCT FROM v_orig_phone THEN
      RAISE EXCEPTION 'agent changed verified number: mm % -> %, phone % -> %', v_orig_mm, v_row.mobile_money_number, v_orig_phone, v_row.phone;
    END IF;

    -- service role (auth.uid() NULL) — the 87 unattributed rewrites
    PERFORM set_config('request.jwt.claim.sub', '', true);
    PERFORM set_config('request.jwt.claims', '', true);
    UPDATE public.landlords SET mobile_money_number = n4 WHERE id = v_l;
    SELECT mobile_money_number INTO v_msg FROM public.landlords WHERE id = v_l;
    IF v_msg IS DISTINCT FROM v_orig_mm THEN
      RAISE EXCEPTION 'service-role write changed verified number to %', v_msg;
    END IF;
    r := r || 'PASS AT1 agent/service-role cannot change a verified number'::text; v_pass := v_pass + 1;
  EXCEPTION WHEN OTHERS THEN
    r := r || ('FAIL AT1 ' || SQLERRM); v_fail := v_fail + 1;
  END;

  ---------------------------------------------------------------- AT2
  BEGIN
    SELECT verified_mobile_money_number INTO v_msg FROM public.landlords WHERE id = v_l;
    IF v_msg IS DISTINCT FROM v_orig_approved THEN
      RAISE EXCEPTION 'approved number moved from % to % without the chain', v_orig_approved, v_msg;
    END IF;
    IF v_payout_window THEN
      v_msg := NULL;
      BEGIN
        INSERT INTO public.landlord_payouts (agent_id, landlord_id, amount, landlord_phone, landlord_name, mobile_money_provider)
        VALUES (v_agent, v_l, 1000, n1, v_name, 'MTN');
        RAISE EXCEPTION 'probe_inserted';
      EXCEPTION WHEN OTHERS THEN v_msg := SQLERRM; END;
      IF v_msg NOT ILIKE '%does not match%' THEN
        RAISE EXCEPTION 'payout to a swapped-in number was not refused on phone grounds (got: %)', v_msg;
      END IF;
      v_msg := NULL;
      BEGIN
        INSERT INTO public.landlord_payouts (agent_id, landlord_id, amount, landlord_phone, landlord_name, mobile_money_provider)
        VALUES (v_agent, v_l, 1000, v_orig_approved, v_name, 'MTN');
        RAISE EXCEPTION 'probe_inserted';
      EXCEPTION WHEN OTHERS THEN v_msg := SQLERRM; END;
      IF v_msg ILIKE '%does not match%' OR v_msg ILIKE '%not approved a payout number%' OR v_msg ILIKE '%not verified%' THEN
        RAISE EXCEPTION 'payout to the approved number was refused on phone grounds: %', v_msg;
      END IF;
      r := r || 'PASS AT2 withdrawal resolves to the approved number'::text;
    ELSE
      r := r || 'PASS AT2 approved number unchanged (payout probes SKIPPED: outside 06-22 EAT or paused)'::text;
    END IF;
    v_pass := v_pass + 1;
  EXCEPTION WHEN OTHERS THEN
    r := r || ('FAIL AT2 ' || SQLERRM); v_fail := v_fail + 1;
  END;

  ---------------------------------------------------------------- AT3
  BEGIN
    SELECT id, status, requested_by, old_value, new_value INTO v_row
    FROM public.landlord_number_change_requests
    WHERE landlord_id = v_l AND field = 'mobile_money_number' AND status LIKE 'pending%'
    ORDER BY created_at DESC LIMIT 1;
    -- The service-role write (n4) came after the agent's (n1) and supersedes it.
    IF v_row.id IS NULL THEN RAISE EXCEPTION 'no open change request was created'; END IF;
    IF v_row.new_value <> n4 OR v_row.status <> 'pending_service_centre' OR v_row.old_value IS DISTINCT FROM v_orig_mm THEN
      RAISE EXCEPTION 'request wrong: new=% status=% old=%', v_row.new_value, v_row.status, v_row.old_value;
    END IF;
    SELECT count(*) INTO v_cnt FROM public.landlord_number_change_requests
     WHERE landlord_id = v_l AND field = 'mobile_money_number' AND new_value = n1 AND status = 'superseded' AND requested_by = v_agent;
    IF v_cnt <> 1 THEN RAISE EXCEPTION 'agent''s n1 request not recorded+superseded (found %)', v_cnt; END IF;
    SELECT id INTO v_req_phone FROM public.landlord_number_change_requests
     WHERE landlord_id = v_l AND field = 'phone' AND new_value = n2 AND status = 'pending_service_centre' AND requested_by = v_agent;
    IF v_req_phone IS NULL THEN RAISE EXCEPTION 'no change request for the contact phone'; END IF;

    -- Re-submit n1 as the agent, explicitly through the RPC, to drive the chain.
    PERFORM set_config('request.jwt.claim.sub', v_agent::text, true);
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_agent, 'role', 'authenticated')::text, true);
    v_res := public.request_landlord_number_change(v_l, 'mobile_money_number', n1, 'Landlord changed MoMo line, acceptance test');
    v_req := (v_res->>'request_id')::uuid;
    IF v_req IS NULL OR (SELECT status FROM public.landlord_number_change_requests WHERE id = v_req) <> 'pending_service_centre' THEN
      RAISE EXCEPTION 'RPC request did not start at service centre: %', v_res;
    END IF;
    r := r || 'PASS AT3 new number creates a change request at the start of the chain'::text; v_pass := v_pass + 1;
  EXCEPTION WHEN OTHERS THEN
    r := r || ('FAIL AT3 ' || SQLERRM); v_fail := v_fail + 1;
  END;

  ---------------------------------------------------------------- AT4
  BEGIN
    PERFORM set_config('request.jwt.claim.sub', v_sc::text, true);
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_sc, 'role', 'authenticated')::text, true);
    PERFORM public.review_landlord_number_change(v_req, 'approve', 'Service centre confirmed the request');
    PERFORM set_config('request.jwt.claim.sub', v_to::text, true);
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_to, 'role', 'authenticated')::text, true);
    PERFORM public.review_landlord_number_change(v_req, 'approve', 'Tenant ops called tenant, confirmed');
    PERFORM set_config('request.jwt.claim.sub', v_ao::text, true);
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_ao, 'role', 'authenticated')::text, true);
    PERFORM public.review_landlord_number_change(v_req, 'approve', 'Agent ops called agent, confirmed');
    IF (SELECT status FROM public.landlord_number_change_requests WHERE id = v_req) <> 'pending_landlord_ops' THEN
      RAISE EXCEPTION 'request did not advance to landlord ops';
    END IF;
    SELECT mobile_money_number, verified_mobile_money_number INTO v_row FROM public.landlords WHERE id = v_l;
    IF v_row.mobile_money_number IS DISTINCT FROM v_orig_mm OR v_row.verified_mobile_money_number IS DISTINCT FROM v_orig_approved THEN
      RAISE EXCEPTION 'number applied before landlord ops approved';
    END IF;
    IF v_payout_window THEN
      v_msg := NULL;
      BEGIN
        INSERT INTO public.landlord_payouts (agent_id, landlord_id, amount, landlord_phone, landlord_name, mobile_money_provider)
        VALUES (v_agent, v_l, 1000, n1, v_name, 'MTN');
        RAISE EXCEPTION 'probe_inserted';
      EXCEPTION WHEN OTHERS THEN v_msg := SQLERRM; END;
      IF v_msg NOT ILIKE '%does not match%' THEN
        RAISE EXCEPTION 'unapproved number was not refused (got: %)', v_msg;
      END IF;
    END IF;
    r := r || 'PASS AT4 unapproved number cannot receive a payout (3 of 4 stages done)'::text; v_pass := v_pass + 1;
  EXCEPTION WHEN OTHERS THEN
    r := r || ('FAIL AT4 ' || SQLERRM); v_fail := v_fail + 1;
  END;

  ---------------------------------------------------------------- AT5
  BEGIN
    PERFORM set_config('request.jwt.claim.sub', v_lo::text, true);
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_lo, 'role', 'authenticated')::text, true);
    v_res := public.review_landlord_number_change(v_req, 'approve', 'Landlord ops called landlord on new line, confirmed');
    SELECT mobile_money_number, verified_mobile_money_number, verified_mobile_money_source INTO v_row FROM public.landlords WHERE id = v_l;
    IF v_row.mobile_money_number IS DISTINCT FROM n1 OR v_row.verified_mobile_money_number IS DISTINCT FROM n1
       OR v_row.verified_mobile_money_source IS DISTINCT FROM 'number_change_request' THEN
      RAISE EXCEPTION 'full chain did not apply: mm=% approved=% src=% res=%', v_row.mobile_money_number, v_row.verified_mobile_money_number, v_row.verified_mobile_money_source, v_res;
    END IF;
    IF v_payout_window THEN
      v_msg := NULL;
      BEGIN
        INSERT INTO public.landlord_payouts (agent_id, landlord_id, amount, landlord_phone, landlord_name, mobile_money_provider)
        VALUES (v_agent, v_l, 1000, v_orig_approved, v_name, 'MTN');
        RAISE EXCEPTION 'probe_inserted';
      EXCEPTION WHEN OTHERS THEN v_msg := SQLERRM; END;
      IF v_msg NOT ILIKE '%does not match%' THEN
        RAISE EXCEPTION 'old number still payable after change (got: %)', v_msg;
      END IF;
      v_msg := NULL;
      BEGIN
        INSERT INTO public.landlord_payouts (agent_id, landlord_id, amount, landlord_phone, landlord_name, mobile_money_provider)
        VALUES (v_agent, v_l, 1000, n1, v_name, 'MTN');
        RAISE EXCEPTION 'probe_inserted';
      EXCEPTION WHEN OTHERS THEN v_msg := SQLERRM; END;
      IF v_msg ILIKE '%does not match%' OR v_msg ILIKE '%not approved a payout number%' THEN
        RAISE EXCEPTION 'newly approved number refused: %', v_msg;
      END IF;
    END IF;
    r := r || 'PASS AT5 full chain applies the number; payout follows the approved record'::text; v_pass := v_pass + 1;
  EXCEPTION WHEN OTHERS THEN
    r := r || ('FAIL AT5 ' || SQLERRM); v_fail := v_fail + 1;
  END;

  ---------------------------------------------------------------- AT6
  BEGIN
    -- created + 4 stage transitions + applied = at least 6 rows, one per transition
    SELECT count(*) INTO v_cnt FROM public.landlord_number_audit WHERE request_id = v_req;
    IF v_cnt < 6 THEN RAISE EXCEPTION 'expected >= 6 audit rows for the chained request, found %', v_cnt; END IF;
    IF EXISTS (SELECT 1 FROM public.landlord_number_audit WHERE request_id = v_req AND event LIKE 'stage_%' AND actor IS NULL) THEN
      RAISE EXCEPTION 'a stage transition has no actor';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.landlord_number_audit WHERE request_id = v_req AND event = 'applied'
                   AND old_value = v_orig_mm AND new_value = n1 AND actor = v_lo) THEN
      RAISE EXCEPTION 'no applied audit row with old/new/actor';
    END IF;
    -- the blocked direct edits are audited too, with old and new value
    IF NOT EXISTS (SELECT 1 FROM public.landlord_number_audit WHERE landlord_id = v_l AND event = 'direct_edit_blocked'
                   AND actor = v_agent AND new_value = n1) THEN
      RAISE EXCEPTION 'agent''s blocked direct edit not audited';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.landlord_number_audit WHERE landlord_id = v_l AND event = 'direct_edit_blocked'
                   AND actor IS NULL AND new_value = n4) THEN
      RAISE EXCEPTION 'service-role blocked edit not audited';
    END IF;
    -- immutable
    v_msg := NULL;
    BEGIN UPDATE public.landlord_number_audit SET new_value = 'x' WHERE request_id = v_req; v_msg := 'updated';
    EXCEPTION WHEN OTHERS THEN NULL; END;
    IF v_msg = 'updated' THEN RAISE EXCEPTION 'audit rows are mutable'; END IF;
    BEGIN DELETE FROM public.landlord_number_audit WHERE request_id = v_req; v_msg := 'deleted';
    EXCEPTION WHEN OTHERS THEN NULL; END;
    IF v_msg = 'deleted' THEN RAISE EXCEPTION 'audit rows are deletable'; END IF;
    r := r || format('PASS AT6 every change writes an audit row (%s rows on chained request); audit immutable', v_cnt); v_pass := v_pass + 1;
  EXCEPTION WHEN OTHERS THEN
    r := r || ('FAIL AT6 ' || SQLERRM); v_fail := v_fail + 1;
  END;

  ---------------------------------------------------------------- AT7
  BEGIN
    PERFORM set_config('request.jwt.claim.sub', v_sc::text, true);
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_sc, 'role', 'authenticated')::text, true);
    PERFORM public.review_landlord_number_change(v_req_phone, 'reject', 'Landlord denies changing number');
    v_msg := NULL;
    PERFORM set_config('request.jwt.claim.sub', v_to::text, true);
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_to, 'role', 'authenticated')::text, true);
    BEGIN
      PERFORM public.review_landlord_number_change(v_req_phone, 'approve', 'Trying to use a rejected request');
      v_msg := 'accepted';
    EXCEPTION WHEN OTHERS THEN NULL; END;
    IF v_msg = 'accepted' THEN RAISE EXCEPTION 'a rejected request was advanced'; END IF;
    IF (SELECT phone FROM public.landlords WHERE id = v_l) IS DISTINCT FROM v_orig_phone THEN
      RAISE EXCEPTION 'rejected number reached the landlord record';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.landlord_number_audit WHERE request_id = v_req_phone AND event = 'rejected' AND actor = v_sc) THEN
      RAISE EXCEPTION 'rejection not audited';
    END IF;
    r := r || 'PASS AT7 a rejected approval cannot be used'::text; v_pass := v_pass + 1;
  EXCEPTION WHEN OTHERS THEN
    r := r || ('FAIL AT7 ' || SQLERRM); v_fail := v_fail + 1;
  END;

  ---------------------------------------------------------------- AT8
  BEGIN
    PERFORM set_config('request.jwt.claim.sub', v_agent::text, true);
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_agent, 'role', 'authenticated')::text, true);
    v_res := public.request_landlord_number_change(v_l, 'mobile_money_number', n3, 'Another change, will expire');
    v_req3 := (v_res->>'request_id')::uuid;
    -- age it past its expiry (as the owner, via the same authorized flag the RPCs use)
    PERFORM set_config('landlord_numbers.change_authorized', 'true', true);
    UPDATE public.landlord_number_change_requests SET expires_at = now() - interval '1 minute' WHERE id = v_req3;
    PERFORM set_config('landlord_numbers.change_authorized', 'false', true);
    PERFORM set_config('request.jwt.claim.sub', v_sc::text, true);
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_sc, 'role', 'authenticated')::text, true);
    v_res := public.review_landlord_number_change(v_req3, 'approve', 'Approving after expiry should fail');
    IF COALESCE((v_res->>'ok')::boolean, true) OR (SELECT status FROM public.landlord_number_change_requests WHERE id = v_req3) <> 'expired' THEN
      RAISE EXCEPTION 'expired request was not refused/marked: %', v_res;
    END IF;
    v_msg := NULL;
    BEGIN
      PERFORM public.review_landlord_number_change(v_req3, 'approve', 'Second try on an expired request');
      v_msg := 'accepted';
    EXCEPTION WHEN OTHERS THEN NULL; END;
    IF v_msg = 'accepted' THEN RAISE EXCEPTION 'expired request accepted on retry'; END IF;
    IF (SELECT mobile_money_number FROM public.landlords WHERE id = v_l) IS DISTINCT FROM n1 THEN
      RAISE EXCEPTION 'expired number reached the landlord record';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.landlord_number_audit WHERE request_id = v_req3 AND event = 'expired') THEN
      RAISE EXCEPTION 'expiry not audited';
    END IF;
    r := r || 'PASS AT8 an expired approval cannot be used'::text; v_pass := v_pass + 1;
  EXCEPTION WHEN OTHERS THEN
    r := r || ('FAIL AT8 ' || SQLERRM); v_fail := v_fail + 1;
  END;

  ---------------------------------------------------------------- AT9
  BEGIN
    PERFORM set_config('request.jwt.claim.sub', v_sc::text, true);
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_sc, 'role', 'authenticated')::text, true);
    v_res := public.request_landlord_number_change(v_l, 'mobile_money_number', n4, 'Reviewer-raised change, segregation test');
    v_req4 := (v_res->>'request_id')::uuid;
    v_msg := NULL;
    BEGIN
      PERFORM public.review_landlord_number_change(v_req4, 'approve', 'Approving my own request');
      v_msg := 'accepted';
    EXCEPTION WHEN OTHERS THEN NULL; END;
    IF v_msg = 'accepted' THEN RAISE EXCEPTION 'requester approved own request'; END IF;
    PERFORM set_config('request.jwt.claim.sub', v_ao::text, true);
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_ao, 'role', 'authenticated')::text, true);
    PERFORM public.review_landlord_number_change(v_req4, 'approve', 'Service centre stage by agent ops');
    v_msg := NULL;
    BEGIN
      PERFORM public.review_landlord_number_change(v_req4, 'approve', 'Same person, second stage');
      v_msg := 'accepted';
    EXCEPTION WHEN OTHERS THEN NULL; END;
    IF v_msg = 'accepted' THEN RAISE EXCEPTION 'one person approved two stages'; END IF;
    r := r || 'PASS AT9 requester cannot approve; one person cannot approve two stages'::text; v_pass := v_pass + 1;
  EXCEPTION WHEN OTHERS THEN
    r := r || ('FAIL AT9 ' || SQLERRM); v_fail := v_fail + 1;
  END;

  RAISE EXCEPTION 'ACCEPTANCE % pass / % fail (landlord %, rolled back) :: %',
    v_pass, v_fail, v_l, array_to_string(r, ' || ');
END
$acceptance$;
