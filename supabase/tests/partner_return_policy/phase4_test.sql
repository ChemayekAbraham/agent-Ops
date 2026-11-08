-- Phase 4 (Partner Returns: 4a, 4a-assistant, 4b) functional tests, design v2 §10.3: P1, P3-P9, P11, P12 and the §2.7
-- amendments (P2 race: race_run_phase4.sh; P10 rollback: run_phase4_tests.sh rollback; P7 grants matrix:
-- phase4_grants_test.sql). LOCAL THROWAWAY CLUSTER ONLY (port 55432). Prerequisite: the Phase 4 load of
-- run_phase4_tests.sh. Prints one PASS/FAIL line per assertion and a SUMMARY line. Identities are pid('<name>').
-- Psql variables (set by the runner): MIG2 (Phase 2 file, re-run inside a rolled-back transaction in P8), RB4B (the 4b
-- rollback file, applied inside rolled-back transactions in P8).
\pset tuples_only on
\pset format unaligned
\pset pager off
SET client_min_messages = warning;

\ir phase2_helpers.sql
\if :{?MIG2}
\else
\set MIG2 ../../migrations/20261105151000_partner_return_policy_phase2.sql
\endif
\if :{?RB4B}
\else
\set RB4B ../../rollbacks/20261107101000_partner_return_policy_phase4_masks.rollback.sql
\endif

-- ===========================================================================
-- Phase 4 helpers
-- ===========================================================================
CREATE TABLE public._t4_people (k text PRIMARY KEY);
GRANT SELECT ON public._t4_people TO PUBLIC;
INSERT INTO public._t4_people VALUES ('agent1'), ('agent2'), ('pops'), ('cfo'), ('ceo'), ('coo');
CREATE FUNCTION public.t4_tok(p_key text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT 'tok-' || md5('note:' || p_key) $$;
-- A person: auth user (optional confirmed email / phone), profile (optional phone), roles.
CREATE FUNCTION public.t4_person(p_name text, p_email text DEFAULT NULL, p_email_ok boolean DEFAULT false, p_phone text DEFAULT NULL,
                                 p_phone_ok boolean DEFAULT false, p_profile_phone text DEFAULT NULL, p_roles text[] DEFAULT '{}') RETURNS uuid
 LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO public._t4_people VALUES (p_name) ON CONFLICT DO NOTHING;
  INSERT INTO auth.users (id, email, email_confirmed_at, phone, phone_confirmed_at)
  VALUES (public.pid(p_name), COALESCE(p_email, p_name || '@p4.test'), CASE WHEN p_email_ok THEN now() END, p_phone,
          CASE WHEN p_phone_ok THEN now() END)
  ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email, email_confirmed_at = EXCLUDED.email_confirmed_at,
                                 phone = EXCLUDED.phone, phone_confirmed_at = EXCLUDED.phone_confirmed_at;
  INSERT INTO public.profiles (id, full_name, email, phone) VALUES (public.pid(p_name), 'P4 ' || p_name, p_name || '@p4.test', p_profile_phone)
  ON CONFLICT (id) DO UPDATE SET phone = EXCLUDED.phone;
  INSERT INTO public.user_roles (user_id, role, enabled) SELECT public.pid(p_name), r, true FROM unnest(p_roles) r ON CONFLICT DO NOTHING;
  RETURN public.pid(p_name);
END $$;
-- A promissory note written as the database owner (the Phase 1 stamp trigger decides its rate), token t4_tok(p_key).
CREATE FUNCTION public.t4_note(p_key text, p_agent text DEFAULT 'agent1', p_partner text DEFAULT NULL, p_status text DEFAULT 'pending',
                               p_whatsapp text DEFAULT NULL, p_email text DEFAULT NULL, p_phone text DEFAULT NULL,
                               p_name text DEFAULT NULL, p_amount numeric DEFAULT 300000, p_due date DEFAULT current_date + 5) RETURNS uuid
 LANGUAGE sql AS $$
  INSERT INTO public.promissory_notes (agent_id, partner_user_id, partner_name, whatsapp_number, email, phone_number, amount, status,
                                       fulfilment_due_on, activation_token)
  VALUES (public.pid(p_agent), CASE WHEN p_partner IS NULL THEN NULL ELSE public.pid(p_partner) END, COALESCE(p_name, p_key),
          COALESCE(p_whatsapp, '0776' || lpad((abs(hashtext(p_key)) % 1000000)::text, 6, '0')), p_email, p_phone, p_amount, p_status,
          p_due, public.t4_tok(p_key))
  RETURNING id $$;
CREATE FUNCTION public.t4_nid(p_key text) RETURNS uuid LANGUAGE sql STABLE AS
  $$ SELECT id FROM public.promissory_notes WHERE activation_token = public.t4_tok(p_key) $$;
CREATE FUNCTION public.t4_who(p uuid) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN p IS NULL THEN 'nobody' ELSE COALESCE((SELECT k FROM public._t4_people WHERE public.pid(k) = p), 'someone') END $$;
-- status|who|rate|basis
CREATE FUNCTION public.t4_state(p_key text) RETURNS text LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT n.status || '|' || public.t4_who(n.partner_user_id) || '|' || trim_scale(n.return_rate) || '|' || n.return_rate_basis
    FROM public.promissory_notes n WHERE n.activation_token = public.t4_tok(p_key) $$;
-- activation events of a note: <count>[:<link_only or full>/<via or edge>,...]
CREATE FUNCTION public.t4_events(p_key text) RETURNS text LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT count(*) || COALESCE(':' || string_agg(COALESCE(e.metadata ->> 'link_only', 'full') || '/' || COALESCE(e.metadata ->> 'via', 'edge'), ',' ORDER BY e.id), '')
    FROM public.system_events e
   WHERE e.event_type = 'promissory_note_activated' AND e.metadata ->> 'note_id' = public.t4_nid(p_key)::text $$;
CREATE FUNCTION public.t4_held(p_key text) RETURNS integer LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT count(*)::int FROM public.system_events e
   WHERE e.event_type = 'promissory_note_link_held' AND e.related_entity_id = public.t4_nid(p_key) $$;
CREATE FUNCTION public.t4_roles(p_name text) RETURNS text LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT COALESCE(string_agg(r.role || ':' || r.enabled, ',' ORDER BY r.role COLLATE "C"), 'none') FROM public.user_roles r WHERE r.user_id = public.pid(p_name) $$;
-- activate_promissory_note as p_user: 'ok already=.. status=.. your=.. rate=.. monthly=..' or 'ERR <sqlstate>: <message>'
CREATE FUNCTION public.t4_act(p_user text, p_key text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE j jsonb;
BEGIN
  PERFORM public.t_as(p_user);
  j := public.activate_promissory_note(public.t4_tok(p_key));
  PERFORM public.t_vset('t4_last', j::text);
  RETURN 'ok already=' || (j ->> 'already_active') || ' status=' || (j ->> 'status') || ' your=' || COALESCE(j ->> 'your_rate', 'null')
      || ' rate=' || COALESCE(j ->> 'return_rate', 'null') || ' monthly=' || COALESCE(j ->> 'monthly_return', 'null');
EXCEPTION WHEN others THEN
  RETURN 'ERR ' || SQLSTATE || ': ' || SQLERRM;
END $$;
CREATE FUNCTION public.t4_lookup(p_user text, p_token text) RETURNS jsonb LANGUAGE plpgsql AS $$
BEGIN PERFORM public.t_as(p_user); RETURN public.lookup_promissory_note(p_token); END $$;
-- lookup as p_user: 'rate=.. monthly=.. mine=..' or 'NULL'
CREATE FUNCTION public.t4_lk(p_user text, p_key text) RETURNS text LANGUAGE sql VOLATILE AS $$
  SELECT CASE WHEN j IS NULL THEN 'NULL'
              ELSE 'rate=' || COALESCE(j ->> 'return_rate', 'null') || ' monthly=' || COALESCE(j ->> 'monthly_return', 'null')
                   || ' mine=' || COALESCE(j ->> 'linked_to_me', 'null') END
    FROM (SELECT public.t4_lookup(p_user, public.t4_tok(p_key)) j) x $$;
-- A portfolio (the gate decides as for any insert). p_code also names its activation token pid('tok:' || p_code).
CREATE FUNCTION public.t4_port(p_person text, p_rate numeric DEFAULT NULL, p_status text DEFAULT 'active', p_agent text DEFAULT 'agent1',
                               p_code text DEFAULT NULL, p_parent uuid DEFAULT NULL, p_amount numeric DEFAULT 100000) RETURNS uuid
 LANGUAGE sql AS $$
  INSERT INTO public.investor_portfolios (investor_id, agent_id, portfolio_code, investment_amount, duration_months, portfolio_pin,
                                          status, roi_percentage, locked_from_portfolio_id, activation_token)
  VALUES (CASE WHEN p_person IS NULL THEN NULL ELSE public.pid(p_person) END, public.pid(p_agent),
          COALESCE(p_code, 'T4-' || COALESCE(p_person, 'none') || '-' || substr(md5(random()::text), 1, 6)), p_amount, 12, '1111',
          p_status, p_rate, p_parent, COALESCE(public.pid('tok:' || p_code), gen_random_uuid()))
  RETURNING id $$;
CREATE FUNCTION public.t4_pid(p_code text) RETURNS uuid LANGUAGE sql STABLE AS
  $$ SELECT id FROM public.investor_portfolios WHERE portfolio_code = p_code $$;
CREATE FUNCTION public.t4_reqs(p_id uuid) RETURNS text LANGUAGE sql VOLATILE AS $$
  SELECT COALESCE(string_agg(a.source || '@' || trim_scale(a.requested_rate) || ':' || a.status
                             || CASE WHEN a.status = 'approved' THEN CASE WHEN a.applied_at IS NULL THEN '(scheduled)' ELSE '(applied)' END ELSE '' END,
                             ',' ORDER BY a.requested_at, a.status DESC), '-')
    FROM public.portfolio_rate_approvals a WHERE a.portfolio_id = p_id $$;
-- An edge function's request: the service role, PostgREST's request.headers.
CREATE FUNCTION public.t4_svc(p_hdr text) RETURNS void LANGUAGE sql VOLATILE AS $$
  SELECT set_config('request.jwt.claim.sub', '', false), set_config('request.jwt.claim.role', 'service_role', false),
         set_config('request.jwt.claims', '', false), set_config('request.headers', COALESCE(p_hdr, ''), false) $$;
CREATE FUNCTION public.t4_requester(p_id uuid) RETURNS text LANGUAGE sql VOLATILE AS $$
  SELECT COALESCE(string_agg(a.source || ':' || public.t4_who(a.requested_by), ',' ORDER BY a.requested_at), 'no request')
    FROM public.portfolio_rate_approvals a WHERE a.portfolio_id = p_id AND a.status = 'pending' $$;
-- partner_rate_visible_to_caller from an owner-run wrapper (anyone may call the wrapper; the helper itself is closed).
CREATE FUNCTION public._t4_visible(p uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS
  $$ SELECT public.partner_rate_visible_to_caller(p) $$;
GRANT EXECUTE ON FUNCTION public._t4_visible(uuid) TO PUBLIC;
CREATE FUNCTION public.t4_vis(p_user text, p_target text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN PERFORM public.t_as(p_user); RETURN COALESCE(public._t4_visible(CASE WHEN p_target IS NULL THEN NULL ELSE public.pid(p_target) END)::text, 'NULL'); END $$;
-- The five readers (masked 4b text, or the production copy) as p_user.
CREATE FUNCTION public.t4_tp(p_user text, p_code text, p_prod boolean DEFAULT false) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE j jsonb;
BEGIN
  PERFORM public.t_as(p_user);
  IF p_prod THEN SELECT to_jsonb(t) INTO j FROM public._t_prod_get_portfolio_by_activation_token(public.pid('tok:' || p_code)) t;
  ELSE SELECT to_jsonb(t) INTO j FROM public.get_portfolio_by_activation_token(public.pid('tok:' || p_code)) t; END IF;
  RETURN j;
END $$;
-- '<rate>/<Returns earned>' on the token page, and whether the rest of the row is production's (figures nulled when hidden)
CREATE FUNCTION public.t4_tpf(p_user text, p_code text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE j jsonb := public.t4_tp(p_user, p_code); p jsonb := public.t4_tp(p_user, p_code, true);
BEGIN
  RETURN COALESCE(j ->> 'roi_percentage', 'null') || '/' || COALESCE(j ->> 'total_roi_earned', 'null') || ' '
      || CASE WHEN j = p THEN 'same as production'
              WHEN j = p || '{"roi_percentage": null, "total_roi_earned": null}'::jsonb THEN 'production with the figures hidden'
              ELSE 'DIFFERS: ' || j::text || ' vs ' || p::text END;
END $$;
CREATE FUNCTION public.t4_aop(p_user text, p_prod boolean DEFAULT false) RETURNS text LANGUAGE plpgsql AS $$
DECLARE v text;
BEGIN
  PERFORM public.t_as(p_user);
  EXECUTE format($q$
    SELECT string_agg(x, ' ' ORDER BY x COLLATE "C") FROM (
      SELECT COALESCE(ip.portfolio_code, 'assignment:' || t.status) || '=' || COALESCE(trim_scale(t.roi_percentage)::text, '-') || '/'
             || COALESCE(trim_scale(t.total_roi_earned)::text, '-') AS x
        FROM public.%I() t LEFT JOIN public.investor_portfolios ip ON ip.id = t.portfolio_id) s $q$,
    CASE WHEN p_prod THEN '_t_prod_agent_onboarded_portfolios' ELSE 'agent_onboarded_portfolios' END) INTO v;
  RETURN COALESCE(v, 'none');
END $$;
-- every other column of agent_onboarded_portfolios, as a sorted set
CREATE FUNCTION public.t4_aop_rest(p_user text, p_prod boolean DEFAULT false) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v jsonb;
BEGIN
  PERFORM public.t_as(p_user);
  EXECUTE format($q$ SELECT COALESCE(jsonb_agg(r ORDER BY r::text COLLATE "C"), '[]') FROM (
                       SELECT to_jsonb(t) - 'roi_percentage' - 'total_roi_earned' AS r FROM public.%I() t) s $q$,
    CASE WHEN p_prod THEN '_t_prod_agent_onboarded_portfolios' ELSE 'agent_onboarded_portfolios' END) INTO v;
  RETURN v;
END $$;
CREATE FUNCTION public.t4_ai(p_name text) RETURNS text LANGUAGE sql IMMUTABLE AS
  $$ SELECT 'WEL-' || upper(substr(replace(public.pid(p_name)::text, '-', ''), 1, 6)) $$;
CREATE FUNCTION public.t4_ut(p_user text, p_target text, p_prod boolean DEFAULT false) RETURNS jsonb LANGUAGE plpgsql AS $$
BEGIN
  PERFORM public.t_as(p_user);
  IF p_prod THEN RETURN public._t_prod_get_user_trust_profile(COALESCE(public.t4_ai(p_target), 'WEL-NOPE00')); END IF;
  RETURN public.get_user_trust_profile(COALESCE(public.t4_ai(p_target), 'WEL-NOPE00'));
END $$;
-- p_prod: production's public reader over production's user reader; 'raw': production's public text over 4b's (masked)
-- user reader.
CREATE FUNCTION public.t4_pt(p_user text, p_target text, p_prod boolean DEFAULT false, p_raw boolean DEFAULT false) RETURNS jsonb LANGUAGE plpgsql AS $$
BEGIN
  PERFORM public.t_as(p_user);
  IF p_raw THEN RETURN public._t_prod_raw_get_public_trust_profile(COALESCE(public.t4_ai(p_target), 'WEL-NOPE00')); END IF;
  IF p_prod THEN RETURN public._t_prod_get_public_trust_profile(COALESCE(public.t4_ai(p_target), 'WEL-NOPE00')); END IF;
  RETURN public.get_public_trust_profile(COALESCE(public.t4_ai(p_target), 'WEL-NOPE00'));
END $$;
-- What 4b hides from a caller who may not see the person's Returns (S7): the 17 figures of production's impl that move
-- with the person's principal or Returns, as JSON null (existing keys only, keys kept).
CREATE FUNCTION public.t4_masked_paths() RETURNS text[] LANGUAGE sql IMMUTABLE AS $$ SELECT ARRAY[
  'supporter_activity.portfolio_value', 'supporter_activity.total_roi_earned', 'supporter_activity.roi_paid_30d',
  'supporter_activity.roi_paid_180d', 'supporter_activity.roi_monthly_avg', 'cash_flow_capacity.roi_monthly',
  'cash_flow_capacity.monthly_avg', 'cash_flow_capacity.weekly_avg', 'cash_flow_capacity.daily_avg', 'network.portfolio_value',
  'trust.score', 'trust.borrowing_limit_ugx', 'trust.breakdown.supporter', 'trust.vouch_breakdown.total_ugx',
  'trust.vouch_breakdown.portfolio_component_ugx', 'trust.vouch_breakdown.boosters_ugx',
  'trust.vouch_breakdown.booster_breakdown.payment_history'] $$;
CREATE FUNCTION public.t4_ut_hidden(j jsonb) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE p text;
BEGIN
  FOREACH p IN ARRAY public.t4_masked_paths() LOOP j := jsonb_set(j, string_to_array(p, '.'), 'null'::jsonb, false); END LOOP;
  RETURN j;
END $$;
CREATE FUNCTION public.t4_pt_shown(j jsonb, p_earning boolean) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT j || jsonb_build_object('supporter_activity', (j -> 'supporter_activity') || jsonb_build_object('earning_returns', p_earning)) $$;
-- user trust profile: 'same' | 'hidden' (= production with the Returns figures nulled) | the difference
CREATE FUNCTION public.t4_ut_cmp(p_user text, p_target text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE j jsonb := public.t4_ut(p_user, p_target); p jsonb := public.t4_ut(p_user, p_target, true);
BEGIN
  RETURN CASE WHEN j = p THEN 'same' WHEN j = public.t4_ut_hidden(p) THEN 'hidden' ELSE 'DIFFERS: ' || j::text || ' vs ' || p::text END;
END $$;
-- public trust profile: 'shown' (= production plus earning_returns) | 'hidden' (= production's public text over the masked
-- user answer, plus earning_returns, and that differs from production) | the difference
CREATE FUNCTION public.t4_pt_cmp(p_user text, p_target text, p_earning boolean) RETURNS text LANGUAGE plpgsql AS $$
DECLARE j jsonb := public.t4_pt(p_user, p_target); p jsonb := public.t4_pt(p_user, p_target, true);
        r jsonb := public.t4_pt(p_user, p_target, false, true);
BEGIN
  RETURN CASE WHEN j = public.t4_pt_shown(p, p_earning) THEN 'shown'
              WHEN j = public.t4_pt_shown(r, p_earning) AND r <> p THEN 'hidden'
              ELSE 'DIFFERS: ' || j::text || ' vs ' || p::text END;
END $$;
CREATE FUNCTION public.t4_wh(p_user text, p_target text, p_prod boolean DEFAULT false) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE j jsonb;
BEGIN
  PERFORM public.t_as(p_user);
  IF p_prod THEN SELECT to_jsonb(t) INTO j FROM public._t_prod_get_partner_wallet_hub(public.pid(p_target), 25, 0) t;
  ELSE SELECT to_jsonb(t) INTO j FROM public.get_partner_wallet_hub(public.pid(p_target), 25, 0) t; END IF;
  RETURN j;
END $$;
-- production's wallet hub with the Returns figures and Returns ledger rows taken out
CREATE FUNCTION public.t4_wh_hidden(j jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT j || jsonb_build_object('roi_amount', NULL, 'total_available', NULL, 'recent_transactions',
           COALESCE((SELECT jsonb_agg(x ORDER BY o) FROM jsonb_array_elements(j -> 'recent_transactions') WITH ORDINALITY a(x, o)
                      WHERE x ->> 'category' <> ALL (ARRAY['roi_wallet_credit', 'roi_payout', 'roi_accrual', 'roi_reinvestment', 'roi_expense',
                                                           'interest_expense', 'supporter_platform_rewards', 'partner_returns_allocated',
                                                           'managed_proxy_payout'])), '[]'::jsonb)) $$;
CREATE FUNCTION public.t4_wh_cmp(p_user text, p_target text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE j jsonb := public.t4_wh(p_user, p_target); p jsonb := public.t4_wh(p_user, p_target, true);
BEGIN
  RETURN CASE WHEN j = p THEN 'same' WHEN j = public.t4_wh_hidden(p) THEN 'hidden' ELSE 'DIFFERS: ' || j::text || ' vs ' || p::text END
      || ' (' || jsonb_array_length(j -> 'recent_transactions') || ' rows, roi ' || COALESCE(j ->> 'roi_amount', 'null') || ', total '
      || COALESCE(j ->> 'total_available', 'null') || ', deposits ' || (j ->> 'deposits_amount') || ')';
END $$;
-- activate-promissory-note's writes (security branch 5e2ad5e930), as the CURRENT role (set service_role first):
-- '200' | '200 already' | '403' | '400' | '404' | '409' | the error.
CREATE FUNCTION public.t4_edge(p_user text, p_key text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE n public.promissory_notes; v_uid uuid := public.pid(p_user); v_n integer;
BEGIN
  SELECT * INTO n FROM public.promissory_notes WHERE activation_token = public.t4_tok(p_key);
  IF n.id IS NULL THEN RETURN '404'; END IF;
  IF n.partner_user_id IS NOT NULL AND n.partner_user_id <> v_uid THEN RETURN '403'; END IF;
  IF n.status = 'activated' THEN
    IF n.partner_user_id IS NULL THEN
      UPDATE public.promissory_notes x SET partner_user_id = b.partner_user_id
        FROM json_to_record(json_build_object('partner_user_id', v_uid)) AS b(partner_user_id uuid)
       WHERE x.id = n.id AND x.status = 'activated' AND x.partner_user_id IS NULL;
      GET DIAGNOSTICS v_n = ROW_COUNT;
      IF v_n = 0 THEN RETURN '409'; END IF;
      INSERT INTO public.system_events (event_type, description, metadata)
      VALUES ('promissory_note_activated', format('Partner %s linked to already-active promissory note for %s', n.partner_name, n.amount),
              jsonb_build_object('note_id', n.id, 'partner_user_id', v_uid, 'agent_id', n.agent_id, 'amount', n.amount, 'link_only', true));
    END IF;
    RETURN '200 already';
  END IF;
  IF n.status <> 'pending' THEN RETURN '400'; END IF;
  UPDATE public.promissory_notes x SET status = b.status, partner_user_id = b.partner_user_id
    FROM json_to_record(json_build_object('status', 'activated', 'partner_user_id', v_uid)) AS b(status text, partner_user_id uuid)
   WHERE x.id = n.id AND x.status = 'pending' AND (x.partner_user_id IS NULL OR x.partner_user_id = v_uid);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n = 0 THEN RETURN '409'; END IF;
  INSERT INTO public.user_roles (user_id, role, enabled)
  SELECT v_uid, r, true FROM unnest(ARRAY['tenant', 'agent', 'landlord', 'supporter']) r ON CONFLICT (user_id, role) DO NOTHING;
  INSERT INTO public.system_events (event_type, description, metadata)
  VALUES ('promissory_note_activated', format('Partner %s activated promissory note for %s', n.partner_name, n.amount),
          jsonb_build_object('note_id', n.id, 'partner_user_id', v_uid, 'agent_id', n.agent_id, 'amount', n.amount));
  RETURN '200';
EXCEPTION WHEN others THEN
  RETURN SQLSTATE || ': ' || SQLERRM;
END $$;
-- The rows an activation leaves for a person and a note, with the ids replaced (P11 compares RPC and edge runs).
CREATE FUNCTION public.t4_canon(p_key text, p_user text) RETURNS text LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT n.status || '|' || CASE WHEN n.partner_user_id IS NULL THEN 'nobody' WHEN n.partner_user_id = public.pid(p_user) THEN 'caller' ELSE 'other' END
      || '|' || trim_scale(n.return_rate) || ' ' || n.return_rate_basis
      || ' | roles ' || public.t4_roles(p_user)
      || ' | events ' || COALESCE((SELECT string_agg(e.event_type || ' "' || COALESCE(e.description, '-') || '" '
                                                      || ((e.metadata - 'via' - 'note_id' - 'partner_user_id')::text)
                                                      || ' note=' || ((e.metadata ->> 'note_id') = n.id::text)
                                                      || ' user=' || ((e.metadata ->> 'partner_user_id') = public.pid(p_user)::text)
                                                      || ' user_id=' || COALESCE(e.user_id::text, '-'), ' ; ' ORDER BY e.id)
                                     FROM public.system_events e WHERE e.metadata ->> 'note_id' = n.id::text), 'none')
    FROM public.promissory_notes n WHERE n.activation_token = public.t4_tok(p_key) $$;
CREATE FUNCTION public.t4_outcome(p text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN p LIKE 'ok already=false%' THEN '200' WHEN p LIKE 'ok already=true%' THEN '200 already'
              WHEN p LIKE '%NOTE_LINKED_ELSEWHERE%' THEN '403' WHEN p LIKE '%NOTE_NOT_OPEN%' THEN '400' ELSE p END $$;
CREATE FUNCTION public.t4_asst(p_user text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN PERFORM public.t_as(p_user); RETURN public.assistant_partner_new_portfolio_rate()::text;
EXCEPTION WHEN others THEN RETURN 'ERR ' || SQLSTATE || ': ' || SQLERRM; END $$;
CREATE FUNCTION public.t4_report(p_start date DEFAULT current_date, p_end date DEFAULT current_date) RETURNS jsonb LANGUAGE sql VOLATILE AS
  $$ SELECT public.get_partner_return_report(p_start, p_end) $$;
-- service_role stands in for production's BYPASSRLS (as in phase2_test.sql), for the edge-write emulation.
CREATE POLICY _t4_service_role_bypass ON public.promissory_notes FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY _t4_service_role_bypass ON public.user_roles FOR ALL TO service_role USING (true) WITH CHECK (true);
SELECT public.t_as(NULL) IS NULL AS x \gset

-- ===========================================================================
-- L. Right after the load (Phase 1 x2, Phase 2 x2, 4a x2, 4a-assistant x2, 4b x2)
-- ===========================================================================
SELECT public.t_check('L assert: 26 checks (Phase 2''s 17 + Phase 4''s 9), all ok (the P9 seed''s mixed-rate funded notice is not counted: S6)',
  (SELECT count(*) || '/' || COALESCE(string_agg(check_name, ',') FILTER (WHERE NOT ok), 'all ok') FROM public.assert_partner_return_policy_intact()),
  '26/all ok');
SELECT public.t_check('L the assert''s Phase 4 rows come from _partner_return_phase4_checks(false), in its order, immediately before release_ready (the last row)',
  (SELECT string_agg(check_name, ',' ORDER BY o) FROM public.assert_partner_return_policy_intact() WITH ORDINALITY a(check_name, ok, detail, o) WHERE o > 16),
  'activation_owner_run,activation_contact_match,carry_link_immutable,note_rate_view_shared,rate_tools_backend_only,requester_trigger_enabled,open_notices_carry_rate,rate_masked_for_others,note_browser_writes_closed,release_ready');
SELECT public.t_check('L without the Phase 4 rows the assert lists exactly Phase 2''s 17 checks, in Phase 2''s order (captured before 4a)',
  (SELECT string_agg(check_name, ',' ORDER BY o) FROM public.assert_partner_return_policy_intact() WITH ORDINALITY a(check_name, ok, detail, o)
    WHERE check_name NOT IN (SELECT c.check_name FROM public._partner_return_phase4_checks(false) c)),
  (SELECT v FROM public._t_p4_state WHERE k = 'assert_names_phase2'));
SELECT public.t_check('L 4a + 4a-assistant + 4b created exactly the fourteen functions the manifest lists as Phase 4''s expected-absent names (S1 adds _note_contact_proven and guard_note_window_link; S6 _promissory_note_funded_house_rates; Q8 4b partner_returns_visible_to_caller)',
  (SELECT string_agg(a.proname, ',' ORDER BY a.proname COLLATE "C") FROM public._t_fn_after a WHERE a.proname NOT IN (SELECT proname FROM public._t_fn_before_4a)) || ' / '
  || (SELECT count(*) FROM public._t_fn_after a WHERE a.proname NOT IN (SELECT proname FROM public._t_fn_before_4a)
        AND a.proname IN (SELECT jsonb_array_elements_text(doc -> 'expected_absent_in_production') FROM public._t_manifest)),
  '_note_contact_proven,_partner_return_phase4_checks,_promissory_note_funded_house_rates,_promissory_note_rate_view,activate_promissory_note,assistant_partner_new_portfolio_rate,get_partner_return_report,guard_note_window_link,lookup_promissory_note,partner_confirmed_login_emails,partner_rate_visible_to_caller,partner_returns_visible_to_caller,portfolio_rate_requests_stamp_actor,profile_ids_by_emails / 14');
SELECT public.t_check('L manifest: the five readers'' fingerprints equal the production text the 4b rollback file restores (captured before 4b)',
  (SELECT count(*) FILTER (WHERE t.md5 = m.doc -> 'functions' ->> (p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')')) || '/' || count(*)
     FROM public._t_p4_prod t JOIN pg_proc p ON p.oid = t.fn::regprocedure, public._t_manifest m), '5/5');
SELECT public.t_check('L manifest: _get_user_trust_profile_impl and assistant_require_partner are fingerprinted (4b and 4a-assistant depend on them)',
  (SELECT (doc -> 'functions' ? '_get_user_trust_profile_impl(p_user_id uuid)') || '/' || (doc -> 'functions' ? 'assistant_require_partner()') FROM public._t_manifest),
  'true/true');
SELECT public.t_check('L 4b: the five readers carry the 4b marker, no longer match production, and keep their production ACL, SECURITY DEFINER and owner',
  (SELECT count(*) FILTER (WHERE position('Partner Returns Phase 4b' in p.prosrc) > 0 AND md5(pg_get_functiondef(p.oid)) <> t.md5
                             AND p.proacl::text = t.acl AND p.prosecdef AND pg_get_userbyid(p.proowner) = 'postgres') || '/' || count(*)
     FROM public._t_p4_prod t JOIN pg_proc p ON p.oid = t.fn::regprocedure), '5/5');
SELECT public.t_check('L 4b kept the production signatures and result columns (CREATE OR REPLACE, no DROP)',
  (SELECT count(*) FILTER (WHERE pg_get_function_result(p.oid) = pg_get_function_result(c.oid)) || '/' || count(*)
     FROM public._t_p4_prod t JOIN pg_proc p ON p.oid = t.fn::regprocedure
     JOIN pg_proc c ON c.proname = '_t_prod_' || p.proname), '5/5');
SELECT public.t_check('L requester trigger: BEFORE INSERT FOR EACH ROW on portfolio_rate_approvals, enabled, same OID across the 4a re-apply (CREATE OR REPLACE TRIGGER)',
  (SELECT (t.tgtype & 2 > 0)::text || '/' || (t.tgtype & 4 > 0)::text || '/' || (t.tgtype & 1 > 0)::text || '/' || t.tgenabled::text || '/'
          || (t.oid::text = (SELECT v FROM public._t_p4_between WHERE k = 'trigger'))
     FROM pg_trigger t WHERE t.tgname = 'trg_portfolio_rate_requests_stamp_actor' AND t.tgrelid = 'public.portfolio_rate_approvals'::regclass),
  'true/true/true/O/true');
SELECT public.t_check('L switch ships off, no cut-off, release_ready false (4a/4b change no setting)',
  (SELECT enabled || '/' || COALESCE(cutoff_at::text, 'none') || '/' || release_ready FROM public.partner_return_policy), 'false/none/false');

-- ===========================================================================
-- P9. Notice backfill (4a section 10): unsent rows queued before Phase 2 get the note's rate (a 'funded' booking notice:
--     the rate of the houses the person funded); sent rows untouched; the second apply wrote nothing.
-- ===========================================================================
SELECT public.t_check('P9 booking notices: reserved -> note 15; funded, houses all 12 -> 12 (the cancelled 17 row ignored); funded, houses 12+14 -> stays NULL; fully sent -> untouched (NULL); half sent (email pending) -> 15',
  (SELECT string_agg(b.partner_name || '=' || COALESCE(trim_scale(b.return_rate)::text, '-'), ' ' ORDER BY b.partner_name COLLATE "C")
     FROM public.promissory_house_booking_notices b WHERE b.partner_name LIKE 'P9 %'),
  'P9 funded mixed=- P9 funded one rate=12 P9 half sent=15 P9 reserved=15 P9 sent=-');
SELECT public.t_check('P9 pledge notices: pending -> 15; sent -> untouched (NULL); sms sent, email pending -> 15',
  (SELECT string_agg(p.partner_name || '=' || COALESCE(trim_scale(p.return_rate)::text, '-'), ' ' ORDER BY p.partner_name COLLATE "C")
     FROM public.promissory_note_pledge_notices p WHERE p.partner_name LIKE 'P9 %'),
  'P9 pledge half=15 P9 pledge pending=15 P9 pledge sent=-');
SELECT public.t_check('P9 funder house-progress notices: from the supported house (13), else the commitment (11); sent -> untouched; neither -> NULL',
  (SELECT string_agg(f.partner_name || '=' || COALESCE(trim_scale(f.return_rate)::text, '-'), ' ' ORDER BY f.partner_name COLLATE "C")
     FROM public.funder_house_progress_notices f WHERE f.partner_name LIKE 'P9 %'),
  'P9 progress commitment=11 P9 progress house=13 P9 progress nothing=- P9 progress sent=-');
SELECT public.t_check('P9 the second 4a apply wrote no notice row (every xmin unchanged since the first apply)',
  (SELECT count(*) FILTER (WHERE x.cur IS DISTINCT FROM b.v) || ' changed of ' || count(*)
     FROM public._t_p4_between b
     LEFT JOIN (SELECT 'booking:' || id AS k, xmin::text AS cur FROM public.promissory_house_booking_notices
                UNION ALL SELECT 'pledge:' || id, xmin::text FROM public.promissory_note_pledge_notices
                UNION ALL SELECT 'progress:' || id, xmin::text FROM public.funder_house_progress_notices) x ON x.k = b.k
    WHERE b.k <> 'trigger'), '0 changed of 12');
SELECT public.t_check('P9 (S6) open_notices_carry_rate ignores the unsent mixed-rate funded notice (its houses carry two rates: no % line by design)',
  (SELECT ok || ': ' || detail FROM public._partner_return_phase4_checks(false) WHERE check_name = 'open_notices_carry_rate')
  || ' / ' || (SELECT count(*) FROM public.promissory_house_booking_notices WHERE partner_name = 'P9 funded mixed' AND return_rate IS NULL AND sms_sent_at IS NULL),
  'true: 0 unsent pledge/booking notice(s) have no stored Returns rate (their email would show none) / 1');
BEGIN;
INSERT INTO public.promissory_house_booking_notices (note_id, partner_user_id, kind, partner_name, house_count, total_rent)
SELECT n.id, n.partner_user_id, 'reserved', 'P9 mixed reserved', 1, 1 FROM public.promissory_notes n WHERE n.partner_name = 'P9 funded mixed';
UPDATE public.promissory_house_booking_notices SET return_rate = NULL WHERE partner_name = 'P9 funded one rate';
SELECT ok || ': ' || detail AS p9_other FROM public._partner_return_phase4_checks(false) WHERE check_name = 'open_notices_carry_rate' \gset
ROLLBACK;
SELECT public.t_check('P9 (S6) ... but an unsent rate-less reserved notice on the same note, and a rate-less funded notice whose houses carry ONE rate, still fail it',
  :'p9_other', 'false: 2 unsent pledge/booking notice(s) have no stored Returns rate (their email would show none)');
UPDATE public.promissory_house_booking_notices SET sms_sent_at = now(), email_sent_at = now() WHERE partner_name = 'P9 funded mixed';
SELECT public.t_check('P9 ... and still passes once the mixed notice is sent', (SELECT ok::text FROM public._partner_return_phase4_checks(false) WHERE check_name = 'open_notices_carry_rate'), 'true');

-- ===========================================================================
-- P12. Batch readers for edge functions
-- ===========================================================================
DO $$ BEGIN
  PERFORM public.t4_person('e1', ' E1.Mixed@Mail.Test ', true);
  PERFORM public.t4_person('e2', 'e2@mail.test', false);
  PERFORM public.t4_person('e3', 'x3@welile.user', true);
  PERFORM public.t4_person('e4', 'x4@noapp.welile.user', true);
  PERFORM public.t4_person('e5', 'x5@welile.agent', true);
  PERFORM public.t4_person('e6', 'x6@gone.invalid', true);
  PERFORM public.t4_person('e7', 'e7@mail.test', true);
  PERFORM public.t4_person('e8', '  ', true);
  PERFORM public.t4_person('e9', 'staff@welile.com', true);
  PERFORM public.t4_person('e10', 'a@sub.welile.user', true);
  UPDATE auth.users SET deleted_at = now() WHERE id = public.pid('e7');
END $$;
SELECT public.t_check('P12 partner_confirmed_login_emails: only confirmed, real, live addresses, trimmed and lower-cased (unconfirmed, welile.user, noapp.welile.user, welile.agent, sub.welile.user, .invalid, soft-deleted and blank left out; welile.com kept)',
  (SELECT string_agg(public.t4_who(user_id) || '=' || email, ' ' ORDER BY email COLLATE "C")
     FROM public.partner_confirmed_login_emails(ARRAY(SELECT public.pid('e' || i) FROM generate_series(1, 10) i) || gen_random_uuid())),
  'e1=e1.mixed@mail.test e9=staff@welile.com');
SELECT public.t_check('P12 partner_confirmed_login_emails: NULL or empty input -> no rows; 1,000 ids -> answered; 1,001 ids -> no rows (cap)',
  (SELECT count(*) FROM public.partner_confirmed_login_emails(NULL)) || '/' || (SELECT count(*) FROM public.partner_confirmed_login_emails('{}'))
  || '/' || (SELECT count(*) FROM public.partner_confirmed_login_emails(ARRAY(SELECT gen_random_uuid() FROM generate_series(1, 999)) || public.pid('e1')))
  || '/' || (SELECT count(*) FROM public.partner_confirmed_login_emails(ARRAY(SELECT gen_random_uuid() FROM generate_series(1, 1000)) || public.pid('e1'))),
  '0/0/1/0');
DO $$ BEGIN
  INSERT INTO public.profiles (id, full_name, email) VALUES (public.pid('pe1'), 'pe1', 'Mixed.Case@P12.test'), (public.pid('pe2'), 'pe2', 'mixed.case@p12.TEST'),
                                                           (public.pid('pe3'), 'pe3', 'other@p12.test');
END $$;
SELECT public.t_check('P12 profile_ids_by_emails: case-insensitive, input trimmed, blank and NULL ignored, duplicates once; returns lower(email); every profile with that address',
  (SELECT string_agg(r.email || '=' || w.k, ' ' ORDER BY r.email COLLATE "C", w.k COLLATE "C")
     FROM public.profile_ids_by_emails(ARRAY[' MIXED.case@p12.test ', 'mixed.case@P12.test', '', '   ', NULL, 'Other@P12.Test', 'nobody@p12.test']) r
     CROSS JOIN LATERAL (SELECT COALESCE((SELECT k FROM unnest(ARRAY['pe1', 'pe2', 'pe3']) k WHERE public.pid(k) = r.id), '?') AS k) w),
  'mixed.case@p12.test=pe1 mixed.case@p12.test=pe2 other@p12.test=pe3');
SELECT public.t_check('P12 profile_ids_by_emails: NULL -> no rows; 500 emails -> answered; 501 -> no rows (cap)',
  (SELECT count(*) FROM public.profile_ids_by_emails(NULL)) || '/'
  || (SELECT count(*) FROM public.profile_ids_by_emails(ARRAY(SELECT 'x' || i || '@none.test' FROM generate_series(1, 499) i) || 'other@p12.test'::text)) || '/'
  || (SELECT count(*) FROM public.profile_ids_by_emails(ARRAY(SELECT 'x' || i || '@none.test' FROM generate_series(1, 500) i) || 'other@p12.test'::text)),
  '0/1/0');

-- ===========================================================================
-- P8. Phase 4's structural checks (switch off)
-- ===========================================================================
SELECT public.t_check('P8 every _partner_return_phase4_checks row ok after the apply (9 rows)',
  (SELECT count(*) || '/' || COALESCE(string_agg(check_name, ',') FILTER (WHERE NOT ok), 'all ok') FROM public._partner_return_phase4_checks(false)), '9/all ok');
SELECT public.t_check('P8 for release (true): masks applied (4b) -> ok; the security migration is missing in the stub -> note_browser_writes_closed fails',
  (SELECT string_agg(check_name || '=' || ok, ' ' ORDER BY check_name COLLATE "C") FROM public._partner_return_phase4_checks(true)
    WHERE check_name IN ('rate_masked_for_others', 'note_browser_writes_closed')), 'note_browser_writes_closed=false rate_masked_for_others=true');
SELECT public.t_check('P8 the default argument is false (release-only checks pass while release_ready is false)',
  (SELECT count(*) FILTER (WHERE ok)::text FROM public._partner_return_phase4_checks()), '9');
SELECT public.t_check('P8 the assert carries the hook line exactly once, right before the release_ready check',
  (SELECT (length(prosrc) - length(replace(prosrc, 'RETURN QUERY SELECT * FROM public._partner_return_phase4_checks(false);', '')))
          / length('RETURN QUERY SELECT * FROM public._partner_return_phase4_checks(false);') || '/'
          || (position('RETURN QUERY SELECT * FROM public._partner_return_phase4_checks(false);' in prosrc) < position('RETURN QUERY SELECT ''release_ready''' in prosrc))
     FROM pg_proc WHERE oid = 'public.assert_partner_return_policy_intact()'::regprocedure), '1/true');
-- (a) 4b rolled back (rolled-back transaction): the masks check fails for release only.
BEGIN;
\i :RB4B
SELECT (SELECT ok || ': ' || detail FROM public._partner_return_phase4_checks(true) WHERE check_name = 'rate_masked_for_others') || ' / '
    || (SELECT ok::text FROM public._partner_return_phase4_checks(false) WHERE check_name = 'rate_masked_for_others') AS p8_nomask \gset
ROLLBACK;
SELECT public.t_check('P8 with 4b rolled back: rate_masked_for_others fails for release (5 readers) and passes while release_ready is false',
  :'p8_nomask', 'false: 5 reader(s) still show another person''s Returns rate or Returns earned (4b; required before release_ready) / true');
-- (b) the REAL security migration (20261106200000, 5e2ad5e930, verbatim): trg_guard_note_direct_edit + the browser INSERT
--     policy dropped; then the INSERT policy put back (production's text) to show the trigger alone is not enough.
BEGIN;
\ir sec_link_security_load.sql
SELECT ok AS p8_sec_both FROM public._partner_return_phase4_checks(true) WHERE check_name = 'note_browser_writes_closed' \gset
CREATE POLICY "Agents can create promissory notes" ON public.promissory_notes FOR INSERT TO authenticated
  WITH CHECK (agent_id = (SELECT auth.uid()));
SELECT ok AS p8_sec_trigger_only FROM public._partner_return_phase4_checks(true) WHERE check_name = 'note_browser_writes_closed' \gset
DROP POLICY "Agents can create promissory notes" ON public.promissory_notes;
ALTER TABLE public.promissory_notes DISABLE TRIGGER trg_guard_note_direct_edit;
SELECT ok AS p8_sec_disabled FROM public._partner_return_phase4_checks(true) WHERE check_name = 'note_browser_writes_closed' \gset
ALTER TABLE public.promissory_notes ENABLE TRIGGER trg_guard_note_direct_edit;
DROP POLICY "Agents can update own pending notes" ON public.promissory_notes;
SELECT ok AS p8_sec_no_update FROM public._partner_return_phase4_checks(true) WHERE check_name = 'note_browser_writes_closed' \gset
ROLLBACK;
SELECT public.t_check('P8 note_browser_writes_closed (release): trigger only, INSERT policy kept -> false; trigger + INSERT policy dropped (UPDATE policy kept, as the security migration does) -> true; trigger disabled -> false; UPDATE policy dropped too -> true',
  :'p8_sec_trigger_only' || '/' || :'p8_sec_both' || '/' || :'p8_sec_disabled' || '/' || :'p8_sec_no_update', 'f/t/f/t');
-- (c) each other check turns false when its condition is broken (all at once, rolled back).
BEGIN;
GRANT EXECUTE ON FUNCTION public.activate_promissory_note(text) TO anon;
DO $b$ BEGIN
  EXECUTE replace(pg_get_functiondef('public.activate_promissory_note(text)'::regprocedure), 'NOTE_CONTACT_MISMATCH', 'NOTE_CONTACT_DIFFERS');
  EXECUTE replace(pg_get_functiondef('public.lookup_promissory_note(text)'::regprocedure), 'public._promissory_note_rate_view(n, v_uid)',
                  'public._promissory_note_rate_json(n, v_uid)');
END $b$;
GRANT EXECUTE ON FUNCTION public.get_partner_return_report(date, date) TO authenticated;
ALTER TABLE public.portfolio_rate_approvals DISABLE TRIGGER trg_portfolio_rate_requests_stamp_actor;
INSERT INTO public.promissory_note_pledge_notices (note_id, partner_name, amount) VALUES (gen_random_uuid(), 'P8 unsent, no rate', 1000);
SELECT string_agg(check_name || '=' || ok, ' ' ORDER BY check_name COLLATE "C") AS p8_broken FROM public._partner_return_phase4_checks(false) \gset
ROLLBACK;
SELECT public.t_check('P8 broken conditions: anon may activate, contact check gone, lookup bypasses the shared rate rule, the report open to browsers, requester trigger disabled, an unsent rate-less notice -> each check false (release-only checks pass)',
  :'p8_broken', 'activation_contact_match=false activation_owner_run=false carry_link_immutable=true note_browser_writes_closed=true note_rate_view_shared=false open_notices_carry_rate=false rate_masked_for_others=true rate_tools_backend_only=false requester_trigger_enabled=false');
BEGIN;
DROP FUNCTION public.profile_ids_by_emails(text[]);
SELECT ok AS p8_missing FROM public._partner_return_phase4_checks(false) WHERE check_name = 'rate_tools_backend_only' \gset
ROLLBACK;
SELECT public.t_check('P8 rate_tools_backend_only also fails when a batch reader is missing', :'p8_missing', 'f');
-- (d) the switch-on guard (assert, through its hook) requires Phase 4's checks, the release-only ones once release_ready is set.
BEGIN;
UPDATE public.partner_return_policy SET release_ready = true;
SELECT public.t_err($s$SELECT public.set_partner_return_policy(true, NULL, 'p8')$s$) AS p8_on_nosec \gset
\ir sec_link_security_load.sql
ALTER TABLE public.portfolio_rate_approvals DISABLE TRIGGER trg_portfolio_rate_requests_stamp_actor;
SELECT public.t_err($s$SELECT public.set_partner_return_policy(true, NULL, 'p8')$s$) AS p8_on_notrigger \gset
ALTER TABLE public.portfolio_rate_approvals ENABLE TRIGGER trg_portfolio_rate_requests_stamp_actor;
SELECT public.t_err($s$SELECT public.set_partner_return_policy(true, NULL, 'p8')$s$) AS p8_on_ok \gset
ROLLBACK;
-- 4b rolled back first (its rollback refuses once release_ready is set: run_phase4_tests.sh rollback), then release_ready.
BEGIN;
\i :RB4B
\ir sec_link_security_load.sql
UPDATE public.partner_return_policy SET release_ready = true;
SELECT public.t_err($s$SELECT public.set_partner_return_policy(true, NULL, 'p8')$s$) AS p8_on_nomask \gset
ROLLBACK;
SELECT public.t_check('P8 switch-on with release_ready set but no security migration: refused naming note_browser_writes_closed',
  :'p8_on_nosec', '55000: Partner Returns cannot be turned on: these checks fail: note_browser_writes_closed (see assert_partner_return_policy_intact())');
SELECT public.t_check('P8 switch-on with the requester trigger disabled: refused naming requester_trigger_enabled',
  :'p8_on_notrigger', '55000: Partner Returns cannot be turned on: these checks fail: requester_trigger_enabled (see assert_partner_return_policy_intact())');
SELECT public.t_check('P8 switch-on with everything Phase 4 needs in place: allowed (rolled back)', :'p8_on_ok', 'ok');
BEGIN;
SELECT public.t_err($s$UPDATE public.partner_return_policy SET release_ready = true, enabled = true$s$) AS p8_combined \gset
ROLLBACK;
SELECT public.t_check('P8 (S3) one database-owner UPDATE setting release_ready AND enabled together while a release-only check fails (no security migration): refused, naming it',
  :'p8_combined', '55000: Partner Returns cannot be turned on: these release checks fail: note_browser_writes_closed (see _partner_return_phase4_checks(true))');
SELECT public.t_check('P8 switch-on with 4b rolled back: refused naming rate_masked_for_others',
  :'p8_on_nomask', '55000: Partner Returns cannot be turned on: these checks fail: rate_masked_for_others (see assert_partner_return_policy_intact())');
-- (e) a later re-run of Phase 2's assert drops the hook: the report shows it, and still lists Phase 4's failures.
SELECT public.t_check('P8 the report says the assert has the Phase 4 hook', (public.t4_report() ->> 'assert_has_phase4_hook'), 'true');
BEGIN;
\i :MIG2
ALTER TABLE public.portfolio_rate_approvals DISABLE TRIGGER trg_portfolio_rate_requests_stamp_actor;
SELECT (r ->> 'assert_has_phase4_hook') || ' / ' || (r -> 'checks_failing')::text || ' / ' || (r -> 'release_checks_failing')::text || ' / '
       || (SELECT count(*) FROM public.assert_partner_return_policy_intact()) AS p8_nohook
  FROM (SELECT public.t4_report() r) x \gset
ROLLBACK;
SELECT public.t_check('P8 Phase 2 re-run (hook gone): assert_has_phase4_hook false, the assert back to 17 rows, and the report still lists the broken Phase 4 check (it calls the checks directly)',
  :'p8_nohook', 'false / ["requester_trigger_enabled"] / ["note_browser_writes_closed", "requester_trigger_enabled"] / 17');

-- ===========================================================================
-- P6 (switch off). The daily report's Returns rate check
-- ===========================================================================
SELECT public.t_as(NULL) IS NULL AS x \gset
SELECT public.t_check('P6 top-level keys (counts and settings only)',
  (SELECT string_agg(k, ',' ORDER BY k COLLATE "C") FROM jsonb_object_keys(public.t4_report()) k),
  'assert_has_phase4_hook,cfo_queue,checks_failing,conformance,drift_open,monitor,new_portfolios,note_links_held,notes,policy,release_checks_failing,rule_check,window');
SELECT public.t_check('P6 rule_check keys; cfo_queue includes pending_lowering',
  (SELECT string_agg(k, ',' ORDER BY k COLLATE "C") FROM jsonb_object_keys(public.t4_report() -> 'rule_check') k) || ' / '
  || (public.t4_report() -> 'cfo_queue' ? 'pending_lowering'),
  'cohort_new_below_own,non_cohort_new_above_public,note_windows_beyond_90d,open_pending_portfolios,precutoff_offer_live_non_cohort / true');
SELECT public.t_check('P6 switch off: policy block, assert_has_phase4_hook a top-level boolean, nothing failing, release blocked by the security migration only',
  (SELECT (r -> 'policy' ->> 'enabled') || '/' || (r -> 'policy' ->> 'release_ready') || '/' || (r -> 'policy' ->> 'public_rate') || '/'
          || COALESCE(r -> 'policy' ->> 'cutoff_at', 'none') || ' | ' || jsonb_typeof(r -> 'assert_has_phase4_hook') || ' | '
          || (r -> 'checks_failing')::text || ' | ' || (r -> 'release_checks_failing')::text FROM (SELECT public.t4_report() r) x),
  'false/false/15/none | boolean | [] | ["note_browser_writes_closed"]');
SELECT public.t_check('P6 switch off (no cut-off): the four cut-off rule counts are 0; open_pending_portfolios counts every portfolio not active/locked/redeemed/cancelled',
  (SELECT (r -> 'rule_check' ->> 'cohort_new_below_own') || '/' || (r -> 'rule_check' ->> 'non_cohort_new_above_public') || '/'
          || (r -> 'rule_check' ->> 'precutoff_offer_live_non_cohort') || '/' || (r -> 'rule_check' ->> 'note_windows_beyond_90d') || '/'
          || ((r -> 'rule_check' ->> 'open_pending_portfolios')::int
              = (SELECT count(*) FROM public.investor_portfolios WHERE status NOT IN ('active', 'locked', 'redeemed', 'cancelled')))
     FROM (SELECT public.t4_report() r) x), '0/0/0/0/true');
SELECT public.t_check('P6 new_portfolios and notes add up to the rows decided / written in the window (today, Kampala)',
  (SELECT ((SELECT COALESCE(sum((e ->> 'count')::int), 0) FROM jsonb_array_elements(r -> 'new_portfolios') e)
            = (SELECT count(*) FROM public.investor_portfolios ip
                WHERE ip.rate_decided_at >= (current_date::timestamp AT TIME ZONE 'Africa/Kampala')
                  AND ip.rate_decided_at < ((current_date + 1)::timestamp AT TIME ZONE 'Africa/Kampala')))::text || '/'
          || ((SELECT COALESCE(sum((e ->> 'count')::int), 0) FROM jsonb_array_elements(r -> 'notes') e)
            = (SELECT count(*) FROM public.promissory_notes n
                WHERE n.created_at >= (current_date::timestamp AT TIME ZONE 'Africa/Kampala')
                  AND n.created_at < ((current_date + 1)::timestamp AT TIME ZONE 'Africa/Kampala')))::text
     FROM (SELECT public.t4_report() r) x), 'true/true');
-- Monitor: the newest run of the drift job by runid (not by start time), never another job's run.
INSERT INTO cron.job_run_details (runid, jobid, status, start_time, end_time)
SELECT 41, j.jobid, 'succeeded', now() - interval '5 minutes', now() - interval '5 minutes' FROM cron.job j WHERE j.jobname = 'partner-rate-drift-check';
INSERT INTO cron.job_run_details (runid, jobid, status, start_time, end_time)
SELECT 42, j.jobid, 'failed', now() - interval '15 minutes', now() - interval '15 minutes' FROM cron.job j WHERE j.jobname = 'partner-rate-drift-check';
INSERT INTO cron.job_run_details (runid, jobid, status, start_time, end_time)
SELECT 43, j.jobid, 'succeeded', now(), now() FROM cron.job j WHERE j.jobname <> 'partner-rate-drift-check' LIMIT 1;
SELECT public.t_check('P6 monitor: the drift job''s newest run by runid (42, failed; not the later-starting 41, not another job''s 43)',
  (SELECT (m ->> 'scheduled') || '/' || (m ->> 'active') || '/' || (m ->> 'last_status') || '/' || (m ->> 'schedule' = (SELECT schedule FROM cron.job WHERE jobname = 'partner-rate-drift-check'))
     FROM (SELECT public.t4_report() -> 'monitor' m) x), 'true/true/failed/true');
BEGIN;
ALTER SCHEMA cron RENAME TO cron_hidden;
SELECT (public.t4_report() -> 'monitor')::text AS p6_nocron \gset
ROLLBACK;
SELECT public.t_check('P6 no cron schema: monitor {scheduled: false} (the report still answers)', :'p6_nocron', '{"scheduled": false}');
BEGIN;
DELETE FROM cron.job WHERE jobname = 'partner-rate-drift-check';
SELECT (public.t4_report() -> 'monitor')::text AS p6_nojob \gset
ROLLBACK;
SELECT public.t_check('P6 drift job not scheduled: monitor {scheduled: false}', :'p6_nojob', '{"scheduled": false}');
SELECT public.t_check('P6 who may run it: an agent refused (42501 Not authorised); partner_ops, the CFO and a backend session allowed',
  (SELECT string_agg(public.t_err(format('SELECT public.t_as(%L); SELECT public.get_partner_return_report(current_date, current_date)', u)), ' ' ORDER BY o)
     FROM unnest(ARRAY['agent1', 'pops', 'cfo', NULL]) WITH ORDINALITY u(u, o)),
  '42501: Not authorised ok ok ok');
SELECT public.t_check('P6 window: 93 days allowed; 94 days, end before start and NULL refused (22023 INVALID_WINDOW)',
  public.t_err($s$SELECT public.t_as(NULL); SELECT public.get_partner_return_report(current_date - 92, current_date)$s$) || ' | '
  || split_part(public.t_err($s$SELECT public.get_partner_return_report(current_date - 93, current_date)$s$), ':', 1) || ' '
  || split_part(public.t_err($s$SELECT public.get_partner_return_report(current_date, current_date - 1)$s$), ':', 1) || ' '
  || split_part(public.t_err($s$SELECT public.get_partner_return_report(NULL, current_date)$s$), ':', 1), 'ok | 22023 22023 22023');
SELECT public.t_check('P6 counts only: no person id and no partner name anywhere in the report',
  (SELECT (r::text !~ '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-') || '/' || (position('P9 ' in r::text) = 0) FROM (SELECT public.t4_report(current_date - 30, current_date) r) x),
  'true/true');

-- ===========================================================================
-- P1 (switch off) + P11 activation equivalence
-- ===========================================================================
DO $$ BEGIN
  PERFORM public.t4_person(x) FROM unnest(ARRAY['a1', 'a2', 'a3', 'a_other', 'er1', 'ee1', 'er2', 'ee2', 'er3', 'ee3', 'er4', 'ee4',
                                                'er5', 'ee5', 'er6', 'ee6', 'er7', 'ee7']) x;
  INSERT INTO public.user_roles (user_id, role, enabled) VALUES (public.pid('a2'), 'agent', false), (public.pid('er5'), 'tenant', false),
                                                                (public.pid('ee5'), 'tenant', false);
  PERFORM public.t4_note('A pending');
  PERFORM public.t4_note('A linked elsewhere', p_partner => 'a_other');
  PERFORM public.t4_note('A activated unlinked', p_status => 'activated');
  PERFORM public.t4_note('A fulfilled', p_status => 'fulfilled');
  PERFORM public.t4_note('A cancelled', p_status => 'cancelled');
  PERFORM public.t4_note('A pending a2');
  -- P11 clones: same partner name, amount and agent; one is activated through the RPC, the other through the edge writes.
  -- E3 / E4 are already linked to their own caller (er3 / ee3, er4 / ee4); E6 to someone else in both runs.
  PERFORM public.t4_note(v.k || x.x, p_name => 'Clone ' || v.k, p_status => v.s,
                         p_partner => CASE v.p WHEN 'self' THEN 'e' || x.x || substr(v.k, 2) WHEN 'other' THEN 'a_other' END)
     FROM (VALUES ('E1', 'pending', NULL), ('E2', 'activated', NULL), ('E3', 'pending', 'self'), ('E4', 'activated', 'self'),
                  ('E5', 'pending', NULL), ('E6', 'pending', 'other'), ('E7', 'fulfilled', NULL)) v(k, s, p),
          (VALUES ('r'), ('e')) x(x);
END $$;
SELECT public.t_check('P1 the test notes are legacy 15 (switch off), unlinked unless written for someone',
  public.t4_state('A pending') || ' ' || public.t4_state('A linked elsewhere'), 'pending|nobody|15|legacy pending|a_other|15|legacy');
SELECT public.t_check('P1 no session (anon) -> AUTH_REQUIRED (42501), nothing written',
  public.t4_act(NULL, 'A pending') || ' / ' || public.t4_state('A pending') || ' / ' || public.t4_events('A pending'),
  'ERR 42501: AUTH_REQUIRED: please sign in to activate this note / pending|nobody|15|legacy / 0');
SELECT public.t_check('P1 tokens: too short, too long, unknown -> NOTE_NOT_FOUND (P0002)',
  (SELECT string_agg(split_part(public.t_err(format('SELECT public.t_as(%L); SELECT public.activate_promissory_note(%L)', 'a1', t)), ':', 1)
                     || split_part(public.t_err(format('SELECT public.t_as(%L); SELECT public.activate_promissory_note(%L)', 'a1', t)), ':', 2), ' ' ORDER BY o)
     FROM unnest(ARRAY['short', repeat('x', 257), 'tok-unknown-0000000000']) WITH ORDINALITY t(t, o)),
  'P0002 NOTE_NOT_FOUND P0002 NOTE_NOT_FOUND P0002 NOTE_NOT_FOUND');
SELECT public.t_check('P1 a note linked to another account -> NOTE_LINKED_ELSEWHERE (42501), unchanged, no event',
  public.t4_act('a1', 'A linked elsewhere') || ' / ' || public.t4_state('A linked elsewhere') || ' / ' || public.t4_events('A linked elsewhere'),
  'ERR 42501: NOTE_LINKED_ELSEWHERE: this note is already linked to another account / pending|a_other|15|legacy / 0');
SELECT public.t_check('P1 pending -> activated and linked to the caller; your_rate = partner_rate_now (15, switch off); the note''s 15 and 45,000/month shown (own note); the four public roles; one event',
  public.t4_act('a1', 'A pending') || ' / ' || public.t4_state('A pending') || ' / ' || public.t4_roles('a1') || ' / ' || public.t4_events('A pending'),
  'ok already=false status=activated your=15 rate=15 monthly=45000 / activated|a1|15|legacy / agent:true,landlord:true,supporter:true,tenant:true / 1:full/activate_promissory_note');
SELECT public.t_check('P1 your_rate equals partner_rate_now for the caller; the response carries no contact',
  ((public.t_v('t4_last')::jsonb ->> 'your_rate')::numeric = public.partner_rate_now(public.pid('a1')))::text || ' / '
  || (SELECT string_agg(k, ',' ORDER BY k COLLATE "C") FROM jsonb_object_keys(public.t_v('t4_last')::jsonb) k),
  'true / already_active,amount,monthly_return,note_id,return_rate,status,success,your_rate');
SELECT public.t_check('P1 the same caller again: already active, nothing written',
  public.t4_act('a1', 'A pending') || ' / ' || public.t4_events('A pending'), 'ok already=true status=activated your=15 rate=15 monthly=45000 / 1:full/activate_promissory_note');
SELECT public.t_check('P1 a role staff disabled stays disabled (a2: agent disabled; the other three granted)',
  public.t4_act('a2', 'A pending a2') || ' / ' || public.t4_roles('a2'),
  'ok already=false status=activated your=15 rate=15 monthly=45000 / agent:false,landlord:true,supporter:true,tenant:true');
SELECT public.t_check('P1 activated + unlinked -> linked only (already active), a link-only event, no roles granted',
  public.t4_act('a3', 'A activated unlinked') || ' / ' || public.t4_state('A activated unlinked') || ' / ' || public.t4_events('A activated unlinked')
  || ' / ' || public.t4_roles('a3'),
  'ok already=true status=activated your=15 rate=15 monthly=45000 / activated|a3|15|legacy / 1:true/activate_promissory_note / none');
SELECT public.t_check('P1 other statuses -> NOTE_NOT_OPEN (22023), unchanged',
  public.t4_act('a1', 'A fulfilled') || ' / ' || public.t4_act('a1', 'A cancelled') || ' / ' || public.t4_state('A fulfilled') || ' ' || public.t4_state('A cancelled'),
  'ERR 22023: NOTE_NOT_OPEN: note is already fulfilled / ERR 22023: NOTE_NOT_OPEN: note is already cancelled / fulfilled|nobody|15|legacy cancelled|nobody|15|legacy');
-- P11: the same activations through the RPC (r) and through the security branch's edge writes as service_role (e).
SELECT public.t_vset('p11_r', string_agg(k || ':' || public.t4_outcome(public.t4_act('er' || substr(k, 2), k || 'r')), ' ' ORDER BY k))
  FROM unnest(ARRAY['E1', 'E2', 'E3', 'E4', 'E5', 'E6', 'E7']) k;
SET ROLE service_role;
SELECT public.t_vset('p11_e', string_agg(k || ':' || public.t4_edge('ee' || substr(k, 2), k || 'e'), ' ' ORDER BY k))
  FROM unnest(ARRAY['E1', 'E2', 'E3', 'E4', 'E5', 'E6', 'E7']) k;
RESET ROLE;
SELECT public.t_check('P11 switch off: RPC and edge give the same outcome for each case (pending, activated unlinked, pending/activated already the caller''s, a disabled role, linked elsewhere, not open)',
  public.t_v('p11_r'), public.t_v('p11_e'));
SELECT public.t_check('P11 ... and the edge outcomes are today''s responses',
  public.t_v('p11_e'), 'E1:200 E2:200 already E3:200 E4:200 already E5:200 E6:403 E7:400');
SELECT public.t_check('P11 switch off: the RPC leaves exactly the rows the edge leaves (note, roles, events; the RPC''s event adds only "via")',
  (SELECT string_agg(k || ' ' || (public.t4_canon(k || 'r', 'er' || substr(k, 2)) = public.t4_canon(k || 'e', 'ee' || substr(k, 2))), ', ' ORDER BY k)
     FROM unnest(ARRAY['E1', 'E2', 'E3', 'E4', 'E5', 'E6', 'E7']) k),
  'E1 true, E2 true, E3 true, E4 true, E5 true, E6 true, E7 true');
SELECT public.t_check('P11 ... the pending case in full (RPC run)', public.t4_canon('E1r', 'er1'),
  'activated|caller|15 legacy | roles agent:true,landlord:true,supporter:true,tenant:true | events promissory_note_activated "Partner Clone E1 activated promissory note for 300000" {"amount": 300000, "agent_id": "'
  || public.pid('agent1') || '"} note=true user=true user_id=-');
SELECT public.t_check('P11 ... the disabled-role case: tenant stays disabled in both', public.t4_roles('er5') || ' / ' || public.t4_roles('ee5'),
  'agent:true,landlord:true,supporter:true,tenant:false / agent:true,landlord:true,supporter:true,tenant:false');

-- ===========================================================================
-- P3 (switch off). What the activation link shows
-- ===========================================================================
DO $$ BEGIN
  PERFORM public.t4_note('H1', p_whatsapp => '+256 771-234 567', p_email => ' John.Doe@Example.com ');
  PERFORM public.t4_note('H2', p_whatsapp => '12345', p_email => 'nobody');
  PERFORM public.t4_note('H3', p_whatsapp => '123456', p_email => '@x.com');
  PERFORM public.t4_note('H4', p_email => 'a@b@c.com');
  PERFORM public.t4_note('H5', p_email => 'ab@');
  PERFORM public.t4_note('Dup 1');
  PERFORM public.t4_note('Dup 2');
  UPDATE public.promissory_notes SET activation_token = public.t4_tok('Dup 1') WHERE activation_token = public.t4_tok('Dup 2');
END $$;
SELECT public.t_check('P3 hints mask the contacts (last 3 digits; first letter + domain after the last @); too short or malformed -> null',
  (SELECT string_agg(k || '=' || COALESCE(j ->> 'whatsapp_hint', 'null') || ',' || COALESCE(j ->> 'email_hint', 'null'), ' ' ORDER BY k)
     FROM unnest(ARRAY['H1', 'H2', 'H3', 'H4', 'H5']) k, LATERAL (SELECT public.t4_lookup(NULL, public.t4_tok(k)) j) x),
  'H1=*********567,J***@Example.com H2=null,null H3=***456,null H4=' || (SELECT '*******' || right(regexp_replace(whatsapp_number, '\D', '', 'g'), 3) FROM public.promissory_notes WHERE activation_token = public.t4_tok('H4'))
  || ',a***@c.com H5=' || (SELECT '*******' || right(regexp_replace(whatsapp_number, '\D', '', 'g'), 3) FROM public.promissory_notes WHERE activation_token = public.t4_tok('H5')) || ',null');
SELECT public.t_check('P3 the old page''s keys are present and empty; the contacts appear nowhere in the answer',
  (SELECT (j ->> 'whatsapp_number') || '|' || (j ->> 'email') || '|' || (position('771234' in j::text) = 0) || '|' || (position('John' in j::text) = 0)
          || '|' || (SELECT string_agg(k, ',' ORDER BY k COLLATE "C") FROM jsonb_object_keys(j) k)
     FROM (SELECT public.t4_lookup(NULL, public.t4_tok('H1')) j) x),
  '||true|true|amount,contribution_type,created_at,deduction_day,email,email_hint,id,linked_to_me,monthly_return,partner_name,return_rate,status,total_collected,whatsapp_hint,whatsapp_number');
SELECT public.t_check('P3 switch off: every note is legacy, so its 15 shows to anyone (anon, a stranger, the person), linked or not; linked_to_me never null',
  public.t4_lk(NULL, 'A linked elsewhere') || ' / ' || public.t4_lk('a1', 'A linked elsewhere') || ' / ' || public.t4_lk('a_other', 'A linked elsewhere')
  || ' / ' || public.t4_lk('a1', 'H1'),
  'rate=15 monthly=45000 mine=false / rate=15 monthly=45000 mine=false / rate=15 monthly=45000 mine=true / rate=15 monthly=45000 mine=false');
SELECT public.t_check('P3 duplicate token -> NULL (lookup) and NOTE_NOT_FOUND (activate); NULL, short, long and unknown tokens -> NULL',
  public.t4_lk(NULL, 'Dup 1') || ' ' || split_part(public.t4_act('a1', 'Dup 1'), ':', 2) || ' '
  || COALESCE(public.lookup_promissory_note(NULL)::text, 'NULL') || ' ' || COALESCE(public.lookup_promissory_note('short')::text, 'NULL') || ' '
  || COALESCE(public.lookup_promissory_note(repeat('x', 257))::text, 'NULL') || ' ' || COALESCE(public.lookup_promissory_note('tok-unknown-0000000000')::text, 'NULL'),
  'NULL  NOTE_NOT_FOUND NULL NULL NULL NULL');

-- ===========================================================================
-- P4 + P11 (switch off). The 4b readers: who sees a person's rate and Returns earned; otherwise production's answer
-- ===========================================================================
DO $$ BEGIN
  PERFORM public.t4_person(x) FROM unnest(ARRAY['m_agent', 'm_x', 'm_y', 'm_z', 'm_t', 'm_q', 'm_w', 'm_s', 'm_v', 'm_px', 'm_px2',
                                                'm_none', 'm_paid', 'm_oldpaid']) x;
  PERFORM public.t4_person('m_owner', p_roles => ARRAY['supporter']);
  INSERT INTO public.user_roles (user_id, role, enabled) VALUES (public.pid('m_agent'), 'agent', true), (public.pid('m_px'), 'agent', true);
  PERFORM public.t4_port(NULL, 15, 'active', 'm_agent', 'M-INV');
  PERFORM public.t4_port('m_owner', 20, 'active', 'm_agent', 'M-OWN');
  PERFORM public.t4_port('m_x', 18, 'active', 'm_agent', 'M-C');
  PERFORM public.t4_port('m_y', 16, 'active', 'm_agent', 'M-M');
  PERFORM public.t4_port('m_z', 17, 'active', 'agent1', 'M-N');
  PERFORM public.t4_port('m_t', 14, 'active', 'agent1', 'M-T');
  PERFORM public.t4_port('m_q', 13, 'active', 'm_agent', 'M-PEND');
  PERFORM public.t4_port('m_w', 19, 'active', 'pops', 'M-W');
  PERFORM public.t4_port('m_v', 12, 'active', 'agent1', 'M-V');
  UPDATE public.investor_portfolios SET total_roi_earned = round(roi_percentage * 100) WHERE portfolio_code LIKE 'M-%';
  INSERT INTO public.proxy_agent_assignments (agent_id, beneficiary_id, beneficiary_role, is_active, is_managed_account, approval_status)
  VALUES (public.pid('m_agent'), public.pid('m_y'), 'supporter', true, true, 'approved'),
         (public.pid('m_agent'), public.pid('m_z'), 'supporter', true, false, 'approved'),
         (public.pid('m_agent'), public.pid('m_t'), 'tenant', true, false, 'approved'),
         (public.pid('m_agent'), public.pid('m_q'), 'supporter', true, false, 'pending'),
         (public.pid('m_agent'), public.pid('m_s'), 'supporter', true, false, 'approved'),
         (public.pid('m_agent'), public.pid('m_v'), 'supporter', true, false, 'approved'),
         (public.pid('m_px'), public.pid('m_owner'), 'supporter', true, false, 'approved'),
         (public.pid('m_px2'), public.pid('m_owner'), 'supporter', false, false, 'approved');
  INSERT INTO public.supporter_roi_payments (rent_request_id, supporter_id, rent_amount, roi_amount, due_date, paid_at, status)
  VALUES (gen_random_uuid(), public.pid('m_paid'), 100000, 15000, now() - interval '30 days', now() - interval '30 days', 'paid'),
         (gen_random_uuid(), public.pid('m_oldpaid'), 100000, 15000, now() - interval '200 days', now() - interval '200 days', 'paid');
  INSERT INTO public.general_ledger (user_id, amount, direction, category, description, source_table, ledger_scope, transaction_date)
  VALUES (public.pid('m_owner'), 50000, 'cash_in', 'wallet_deposit', 'Deposit', 'deposits', 'wallet', now() - interval '7 days'),
         (public.pid('m_owner'), 3000, 'cash_in', 'roi_wallet_credit', '20% monthly reward on portfolio M-OWN', 'investor_portfolios', 'wallet', now() - interval '6 days'),
         (public.pid('m_owner'), 2000, 'cash_out', 'roi_payout', 'Returns payout', 'investor_portfolios', 'platform', now() - interval '5 days'),
         (public.pid('m_owner'), 100000, 'cash_in', 'partner_funding', 'Portfolio funding', 'investor_portfolios', 'platform', now() - interval '4 days'),
         (public.pid('m_owner'), 500, 'cash_in', 'supporter_platform_rewards', '20% monthly reward (payment #1)', 'rent_requests', 'wallet', now() - interval '3 days'),
         (public.pid('m_owner'), 400, 'cash_in', 'partner_returns_allocated', 'Returns allocated', 'investor_portfolios', 'wallet', now() - interval '2 days'),
         (public.pid('m_owner'), 300, 'cash_out', 'managed_proxy_payout', 'Proxy payout', 'investor_portfolios', 'platform', now() - interval '1 day'),
         (public.pid('m_owner'), 700, 'cash_out', 'wallet_withdrawal', 'Withdrawal', 'withdrawal_requests', 'wallet', now() - interval '12 hours');
END $$;
SELECT public.t_check('P4 token page: the person, partner staff and an approved active supporter proxy (Q8: one helper for the four readers) see the rate and Returns earned; the creating agent and another agent see NULLs; otherwise production''s row',
  'owner ' || public.t4_tpf('m_owner', 'M-OWN') || ' | pops ' || public.t4_tpf('pops', 'M-OWN') || ' | creator ' || public.t4_tpf('m_agent', 'M-OWN')
  || ' | agent ' || public.t4_tpf('agent1', 'M-OWN') || ' | proxy ' || public.t4_tpf('m_px', 'M-OWN'),
  'owner 20/2000 same as production | pops 20/2000 same as production | creator null/null production with the figures hidden | agent null/null production with the figures hidden | proxy 20/2000 same as production');
SELECT public.t_check('P4 token page: an invite portfolio with no person yet shows its rate to any signed-in caller (P11: same as production)',
  public.t4_tpf('agent1', 'M-INV') || ' | ' || public.t4_tpf('m_px', 'M-INV'), '15/1500 same as production | 15/1500 same as production');
SELECT public.t_check('P4 agent_onboarded_portfolios, production (creator m_agent): every row with its figures',
  public.t4_aop('m_agent', true), 'M-C=18/1800 M-INV=15/1500 M-M=16/1600 M-N=17/1700 M-OWN=20/2000 M-PEND=13/1300 M-T=14/1400 M-V=12/1200 assignment:approved=-/0');
SELECT public.t_check('P4 agent_onboarded_portfolios (4b, m_agent): figures only for approved active supporter proxies (managed M-M, non-managed M-N and M-V); creator-only rows (M-C, M-OWN, M-PEND, the invite M-INV), a tenant proxy (M-T) and a pending proxy -> NULL',
  public.t4_aop('m_agent'), 'M-C=-/- M-INV=-/- M-M=16/1600 M-N=17/1700 M-OWN=-/- M-PEND=-/- M-T=-/- M-V=12/1200 assignment:approved=-/0');
SELECT public.t_check('P4 agent_onboarded_portfolios: the same rows and every other column as production (m_agent, pops)',
  (public.t4_aop_rest('m_agent') = public.t4_aop_rest('m_agent', true))::text || '/' || (public.t4_aop_rest('pops') = public.t4_aop_rest('pops', true))
  || '/' || jsonb_array_length(public.t4_aop_rest('m_agent')), 'true/true/9');
SELECT public.t_check('P4 + P11 agent_onboarded_portfolios: partner staff (pops, creator of M-W) see figures, as production; a non-agent sees no rows',
  public.t4_aop('pops') || ' = ' || public.t4_aop('pops', true) || ' | ' || public.t4_aop('m_owner') || ' = ' || public.t4_aop('m_owner', true),
  'M-W=19/1900 = M-W=19/1900 | none = none');
SELECT public.t_check('P4 + P11 get_user_trust_profile: self, partner staff and an approved active proxy -> production''s answer; an inactive proxy, the creating agent, another agent -> Returns figures hidden; unknown id -> production''s error',
  'self ' || public.t4_ut_cmp('m_owner', 'm_owner') || ' | pops ' || public.t4_ut_cmp('pops', 'm_owner') || ' | cfo ' || public.t4_ut_cmp('cfo', 'm_owner')
  || ' | proxy ' || public.t4_ut_cmp('m_px', 'm_owner') || ' | inactive proxy ' || public.t4_ut_cmp('m_px2', 'm_owner')
  || ' | creator ' || public.t4_ut_cmp('m_agent', 'm_owner') || ' | agent ' || public.t4_ut_cmp('agent1', 'm_owner')
  || ' | unknown ' || public.t4_ut_cmp('agent1', NULL) || ' | no Returns ' || public.t4_ut_cmp('agent1', 'm_none'),
  'self same | pops same | cfo same | proxy same | inactive proxy hidden | creator hidden | agent hidden | unknown same | no Returns same');
SELECT public.t_check('P4 get_user_trust_profile hidden for an agent: the keys stay, as JSON null (Returns earned, portfolio value, payouts, cash-flow figures that contain them)',
  (SELECT jsonb_typeof(j -> 'supporter_activity' -> 'total_roi_earned') || ',' || (j -> 'supporter_activity' ? 'total_roi_earned') || ','
          || jsonb_typeof(j -> 'supporter_activity' -> 'portfolio_value') || ',' || jsonb_typeof(j -> 'cash_flow_capacity' -> 'monthly_avg') || ','
          || jsonb_typeof(j -> 'cash_flow_capacity' -> 'wallet_monthly') || ',' || (j -> 'supporter_activity' ->> 'active_portfolios')
     FROM (SELECT public.t4_ut('agent1', 'm_owner') j) x), 'null,true,null,null,number,1');
SELECT public.t_check('P4 + P11 get_public_trust_profile: self, partner staff and an approved proxy -> production''s answer plus earning_returns; the creating agent and another agent -> production''s public text over the masked user answer (keys kept); a subject with no Returns -> production''s answer',
  'self ' || public.t4_pt_cmp('m_owner', 'm_owner', true) || ' | pops ' || public.t4_pt_cmp('pops', 'm_owner', true)
  || ' | proxy ' || public.t4_pt_cmp('m_px', 'm_owner', true) || ' | creator ' || public.t4_pt_cmp('m_agent', 'm_owner', true)
  || ' | agent ' || public.t4_pt_cmp('agent1', 'm_owner', true) || ' | no Returns ' || public.t4_pt_cmp('agent1', 'm_none', false),
  'self shown | pops shown | proxy shown | creator hidden | agent hidden | no Returns shown');
SELECT public.t_check('P4 earning_returns: a live portfolio -> true; nothing -> false; Returns paid 30 days ago -> true; only 200 days ago -> false',
  (SELECT string_agg(x || '=' || (public.t4_pt('agent1', x) -> 'supporter_activity' ->> 'earning_returns'), ' ' ORDER BY x COLLATE "C")
     FROM unnest(ARRAY['m_owner', 'm_none', 'm_paid', 'm_oldpaid']) x), 'm_none=false m_oldpaid=false m_owner=true m_paid=true');
SELECT public.t_check('P4 + P11 get_partner_wallet_hub: self, partner staff and an approved proxy -> production''s answer; an agent outside the proxy and the creating agent -> Returns figure, total and Returns rows out; deposits and other rows intact',
  'self ' || public.t4_wh_cmp('m_owner', 'm_owner') || ' | pops ' || public.t4_wh_cmp('pops', 'm_owner') || ' | proxy ' || public.t4_wh_cmp('m_px', 'm_owner')
  || ' | agent ' || public.t4_wh_cmp('agent1', 'm_owner') || ' | creator ' || public.t4_wh_cmp('m_agent', 'm_owner'),
  'self same (8 rows, roi 2000, total 3200, deposits 100000) | pops same (8 rows, roi 2000, total 3200, deposits 100000) | proxy same (8 rows, roi 2000, total 3200, deposits 100000) | agent hidden (3 rows, roi null, total null, deposits 100000) | creator hidden (3 rows, roi null, total null, deposits 100000)');
SELECT public.t_check('P4 wallet hub for an agent: the rows left are the deposit, the funding and the withdrawal (no "% monthly reward" text)',
  (SELECT string_agg(x ->> 'category', ',' ORDER BY x ->> 'category' COLLATE "C") || ' / ' || (position('monthly reward' in (j -> 'recent_transactions')::text) = 0)
     FROM (SELECT public.t4_wh('agent1', 'm_owner') j) s, jsonb_array_elements(j -> 'recent_transactions') x GROUP BY j),
  'partner_funding,wallet_deposit,wallet_withdrawal / true');
SELECT public.t_check('P7 partner_rate_visible_to_caller: the person and partner staff (pops, cfo) true; an agent, a proxy agent and a NULL person false (never NULL)',
  public.t4_vis('m_owner', 'm_owner') || ' ' || public.t4_vis('pops', 'm_owner') || ' ' || public.t4_vis('cfo', 'm_owner') || ' '
  || public.t4_vis('agent1', 'm_owner') || ' ' || public.t4_vis('m_px', 'm_owner') || ' ' || public.t4_vis('pops', NULL),
  'true true true false false false');

-- ===========================================================================
-- 4a-assistant (switch off): the caller's own rate only
-- ===========================================================================
SELECT public.t_check('AS a partner (supporter role) asks: available, their own rate (15 while the switch is off); a non-partner is refused (42501)',
  public.t4_asst('m_owner') || ' / ' || public.t4_asst('agent1'), '{"available": true, "rate_percent": 15} / ERR 42501: not a partner');
BEGIN;
CREATE OR REPLACE FUNCTION public.partner_rate_now(p_partner uuid) RETURNS numeric LANGUAGE plpgsql STABLE AS
  $$ BEGIN RAISE EXCEPTION 'PARTNER_RATE_UNAVAILABLE' USING ERRCODE = '55000'; END $$;
SELECT public.t_as('m_owner') IS NULL AS x \gset
SELECT public.assistant_partner_new_portfolio_rate()::text AS as_fail \gset
ROLLBACK;
SELECT public.t_check('AS when the rule cannot answer: {available: false}, never a number', :'as_fail', '{"available": false}');

-- ===========================================================================
-- ON. Switch-on: data written before the cut-off, then the release stand-ins, then the CEO's switch-on
-- ===========================================================================
SELECT public.t_as(NULL) IS NULL AS x \gset
DO $$ BEGIN
  PERFORM public.t4_person('ex20', p_roles => ARRAY['supporter']);
  PERFORM public.t4_port('ex20', 20, 'active', 'agent1', 'EX20-OLD');
  PERFORM public.t4_person('am_ex');
  PERFORM public.t4_port('am_ex', 18, 'active', 'agent1', 'AMEX-PARENT', p_amount => 300000);
  PERFORM public.t4_person('d14');
  PERFORM public.t4_port('d14', 15, 'pending_approval', 'agent1', 'D14-OFFER');
  -- Pre-cut-off notes for the D3 tests (phones 07783000xx belong to no profile yet, so nothing links at insert).
  PERFORM public.t4_note('D3 a', p_whatsapp => '0778300001', p_email => 'd3a@note.test');
  PERFORM public.t4_note('D3 c', p_whatsapp => '0778300003');
  PERFORM public.t4_note('D3 d', p_whatsapp => '0778300004', p_phone => '0778300014');
  PERFORM public.t4_note('D3 e', p_whatsapp => '0778300005');
  PERFORM public.t4_person('d3ag', p_phone => '256778300006', p_phone_ok => true, p_roles => ARRAY['agent']);
  PERFORM public.t4_note('D3 f', p_agent => 'd3ag', p_whatsapp => '0778300006');
  PERFORM public.t4_note('D3 g', p_whatsapp => '0778300007', p_email => 'd3g@note.test');
  PERFORM public.t4_note('D3 h', p_whatsapp => '0778300008', p_email => 'd3h@note.test');
  PERFORM public.t4_note('D3 act', p_status => 'activated', p_whatsapp => '0778300009', p_email => 'd3act@note.test');
  PERFORM public.t4_person('d3k');
  PERFORM public.t4_note('D3 linked', p_partner => 'd3k', p_whatsapp => '0778300010');
  PERFORM public.t4_note('F far due', p_due => current_date + 100);
  PERFORM public.t4_person('d3x');
  PERFORM public.t4_person('d3x2');
  PERFORM public.t4_person('d3p');   -- its profile phone (the note's number) is set after the cut-off: held
  PERFORM public.t4_person('d3u', p_email => 'd3a@note.test', p_email_ok => false);
  PERFORM public.t4_person('d3e', p_email => ' D3A@Note.Test ', p_email_ok => true);
  PERFORM public.t4_person('d3pu', p_phone => '256778300003', p_phone_ok => false);
  PERFORM public.t4_person('d3ph', p_phone => '256778300003', p_phone_ok => true);
  PERFORM public.t4_person('d3ph2', p_phone => '+256 778 300 014', p_phone_ok => true);
  PERFORM public.t4_person('d3s');
  PERFORM public.t4_person('d3l', p_email => 'd3g@note.test', p_email_ok => true);
  PERFORM public.t4_person('d3h', p_email => 'd3h@note.test', p_email_ok => true);
  PERFORM public.t4_person('d3am', p_email => 'd3act@note.test', p_email_ok => true);
  PERFORM public.t4_person('d3n');
END $$;
SELECT public.t_check('ON the D3 notes stayed unlinked at insert (no profile carries their phones or emails before the cut-off)',
  (SELECT string_agg(k || '=' || public.t4_who(n.partner_user_id), ' ' ORDER BY k COLLATE "C") FROM unnest(ARRAY['D3 a', 'D3 c', 'D3 linked']) k
     JOIN public.promissory_notes n ON n.activation_token = public.t4_tok(k)), 'D3 a=nobody D3 c=nobody D3 linked=d3k');
-- The REAL security migration 20261106200000 (verbatim; trigger present, the browser INSERT policy dropped, the agents' UPDATE policy kept).
\ir sec_link_security_load.sql
-- The release migration (Phase 7) sets release_ready; a database-owner session stands in for it.
UPDATE public.partner_return_policy SET release_ready = true;
SELECT public.t_check('ON release ready: the assert all ok (26), nothing blocks release',
  (SELECT count(*) || '/' || COALESCE(string_agg(check_name, ',') FILTER (WHERE NOT ok), 'all ok') FROM public.assert_partner_return_policy_intact())
  || ' / ' || (public.t4_report() -> 'release_checks_failing')::text, '26/all ok / []');
SELECT public.t_check('ON the CEO''s switch-on (database-owner session) succeeds', (public.set_partner_return_policy(true, NULL, 'phase 4 test') ->> 'changed'), 'true');
SELECT public.t_check('ON personas after the cut-off: ex20 20 existing_partner, am_ex 18 existing_partner, a new person 10',
  public.t_rate('ex20') || ' ' || public.t_rate('am_ex') || ' ' || public.t_rate('d3n'), '20|existing_partner 18|existing_partner 10|new');
SELECT public.t_check('ON the D3 notes have open windows (frozen at the cut-off, nobody linked, agent frozen)',
  (SELECT count(*) || '/' || bool_and(w.ends_on >= (now() AT TIME ZONE 'Africa/Kampala')::date AND w.partner_user_id IS NULL)
     FROM public.partner_return_note_windows w JOIN public.promissory_notes n ON n.id = w.note_id
    WHERE n.activation_token IN (SELECT public.t4_tok(k) FROM unnest(ARRAY['D3 a', 'D3 c', 'D3 d', 'D3 e', 'D3 f', 'D3 g', 'D3 h', 'D3 act']) k)),
  '8/true');

-- ===========================================================================
-- P1 (switch on): D3 verified contact match; the guard vs the RPC; the late link
-- ===========================================================================
-- (S1) d3p saves its own profile phone = D3 a's WhatsApp number after the cut-off: production's two profile triggers
-- (link_proxy_records_on_profile, link_promissory_notes_for_user) try to link it; the hold keeps it off (one event).
SELECT public.t_as('d3p') IS NULL AS x \gset
UPDATE public.profiles SET phone = '0778300001' WHERE id = public.pid('d3p');
SELECT public.t_as(NULL) IS NULL AS x \gset
SELECT public.t_check('P1 D3 (S1) d3p''s own profile phone save matching D3 a after the cut-off: production''s profile triggers try to link it; held (one event), note unlinked, d3p stays 10|new',
  public.t4_state('D3 a') || ' / ' || public.t4_held('D3 a') || ' / ' || public.t_rate('d3p'), 'pending|nobody|15|legacy / 1 / 10|new');
SELECT public.t_check('P1 D3 a second account with no proof of the note''s contact -> NOTE_CONTACT_MISMATCH (42501); nothing written (note, event, roles)',
  public.t4_act('d3x', 'D3 a') || ' / ' || public.t4_state('D3 a') || ' / ' || public.t4_events('D3 a') || ' / ' || public.t4_roles('d3x'),
  'ERR 42501: NOTE_CONTACT_MISMATCH: this note was written for a phone number or email this account has not confirmed with a code; Partner Ops can link the note to you / pending|nobody|15|legacy / 0 / none');
SELECT public.t_check('P1 D3 a profile phone match alone (no code, editable) -> refused',
  public.t4_act('d3p', 'D3 a') || ' / ' || public.t4_state('D3 a'),
  'ERR 42501: NOTE_CONTACT_MISMATCH: this note was written for a phone number or email this account has not confirmed with a code; Partner Ops can link the note to you / pending|nobody|15|legacy');
SELECT public.t_check('P1 D3 the note''s email as an UNconfirmed login email -> refused; the note''s phone as an UNconfirmed auth phone -> refused',
  split_part(public.t4_act('d3u', 'D3 a'), ':', 2) || ' /' || split_part(public.t4_act('d3pu', 'D3 c'), ':', 2),
  ' NOTE_CONTACT_MISMATCH / NOTE_CONTACT_MISMATCH');
SELECT public.t_check('P1 D3 (S1) email_confirmed_at / phone_confirmed_at are not proof: d3e (the note''s email, confirmed flag) and d3ph (the note''s phone, confirmed flag) refused, nothing written',
  public.t4_act('d3e', 'D3 a') || ' / ' || public.t4_act('d3ph', 'D3 c') || ' / ' || public.t4_state('D3 a') || ' ' || public.t4_state('D3 c'),
  'ERR 42501: NOTE_CONTACT_MISMATCH: this note was written for a phone number or email this account has not confirmed with a code; Partner Ops can link the note to you / ERR 42501: NOTE_CONTACT_MISMATCH: this note was written for a phone number or email this account has not confirmed with a code; Partner Ops can link the note to you / pending|nobody|15|legacy pending|nobody|15|legacy');
-- The proofs: a verified email-change code for the note's email (case and spaces ignored), an OTP login to the note's
-- WhatsApp number, a consumed phone-change challenge to its second phone.
INSERT INTO public.email_verification_challenges (user_id, new_email, verified_at) VALUES (public.pid('d3e'), ' D3A@Note.Test ', now());
INSERT INTO public.otp_login_audit (phone, resolved_user_id, outcome, stage) VALUES ('+256 778 300 003', public.pid('d3ph'), 'success', 'otp_verify');
INSERT INTO public.phone_change_otp_challenges (user_id, new_phone_last9, status, consumed_at) VALUES (public.pid('d3ph2'), '778300014', 'consumed', now());
SELECT public.t_check('P1 D3 a verified email code for the note''s email (case and spaces ignored) -> links; your_rate 15 (the note''s window now counts for them)',
  public.t4_act('d3e', 'D3 a') || ' / ' || public.t4_state('D3 a') || ' / ' || public.t4_events('D3 a') || ' / ' || public.t_rate('d3e'),
  'ok already=false status=activated your=15 rate=15 monthly=45000 / activated|d3e|15|legacy / 1:full/activate_promissory_note / 15|promissory_note');
SELECT public.t_check('P1 D3 an OTP login to the WhatsApp number -> links; a consumed phone change to the second phone -> links',
  public.t4_act('d3ph', 'D3 c') || ' / ' || public.t4_act('d3ph2', 'D3 d') || ' / ' || public.t4_state('D3 c') || ' ' || public.t4_state('D3 d'),
  'ok already=false status=activated your=15 rate=15 monthly=45000 / ok already=false status=activated your=15 rate=15 monthly=45000 / activated|d3ph|15|legacy activated|d3ph2|15|legacy');
ALTER TABLE public.partner_return_note_windows DISABLE TRIGGER USER;
UPDATE public.partner_return_note_windows SET ends_on = (now() AT TIME ZONE 'Africa/Kampala')::date - 1 WHERE note_id = public.t4_nid('D3 e');
ALTER TABLE public.partner_return_note_windows ENABLE TRIGGER USER;
SELECT public.t_check('P1 D3 an expired window -> links without a contact match; your_rate 10 (the window no longer counts); the note shows its 15 to its person',
  public.t4_act('d3s', 'D3 e') || ' / ' || public.t4_state('D3 e'),
  'ok already=false status=activated your=10 rate=15 monthly=45000 / activated|d3s|15|legacy');
SELECT public.t_check('P1 the note''s own agent (verified phone matches) -> links, but the window does not count for them: your_rate 10; the note keeps 15',
  public.t4_act('d3ag', 'D3 f') || ' / ' || public.t4_state('D3 f') || ' / ' || public.t_rate('d3ag'),
  'ok already=false status=activated your=10 rate=15 monthly=45000 / activated|d3ag|15|legacy / 10|new');
INSERT INTO auth.identities (provider_id, user_id, identity_data, provider) VALUES
  ('g-d3l', public.pid('d3l'), '{"email": "D3G@note.test"}', 'google'), ('a-d3am', public.pid('d3am'), '{"email": "d3act@note.test"}', 'apple');
INSERT INTO public.email_verification_challenges (user_id, new_email, verified_at) VALUES (public.pid('d3h'), 'd3h@note.test', now());
DO $$ BEGIN INSERT INTO public._t_ids VALUES ('d3l_p', public.t4_port('d3l')); END $$;
SELECT public.t_vset('late_mails', public.t_emails('Promissory note linked late%')::text);
SELECT public.t_check('P1 the late link still fires through the RPC (d3l proved the email by Google sign-in): d3l''s portfolio opened after the cut-off at 10 goes to the CFO at 15 (note_late_link), one alert pair; your_rate 15',
  public.t_desc(public.tid('d3l_p')) || ' -> ' || public.t4_act('d3l', 'D3 g') || ' / ' || public.t_desc(public.tid('d3l_p')) || ' / '
  || public.t4_reqs(public.tid('d3l_p')) || ' / ' || (public.t_emails('Promissory note linked late%') - public.t_v('late_mails')::int),
  '10|new|10|- -> ok already=false status=activated your=15 rate=15 monthly=45000 / 10|new|10|15 / note_late_link@15:pending / 2');
SET ROLE service_role;
SELECT public.t_vset('d3h_edge', public.t4_edge('d3h', 'D3 h'));
RESET ROLE;
SELECT public.t_check('P1 after the cut-off the old edge function''s direct link (service_role) is refused by the Phase 1 guard, while the RPC links the same note for the proven person (email code)',
  public.t_v('d3h_edge') || ' / ' || public.t4_act('d3h', 'D3 h') || ' / ' || public.t4_state('D3 h'),
  '42501: Link a promissory note to a partner through the partner-linking tools, not directly / ok already=false status=activated your=15 rate=15 monthly=45000 / activated|d3h|15|legacy');
SELECT public.t_check('P1 D3 also guards the link-only path (an activated, unlinked pre-cut-off note): a stranger refused; the proven person (Apple sign-in) linked, link-only event',
  split_part(public.t4_act('d3x2', 'D3 act'), ':', 2) || ' / ' || public.t4_act('d3am', 'D3 act') || ' / ' || public.t4_events('D3 act'),
  ' NOTE_CONTACT_MISMATCH / ok already=true status=activated your=15 rate=15 monthly=45000 / 1:true/activate_promissory_note');
SELECT public.t_check('P1 a pre-cut-off note already linked to its person at the cut-off: no contact check; your_rate 15',
  public.t4_act('d3k', 'D3 linked') || ' / ' || public.t4_state('D3 linked'),
  'ok already=false status=activated your=15 rate=15 monthly=45000 / activated|d3k|15|legacy');
DO $$ BEGIN PERFORM public.t4_note('Post new'); PERFORM public.t4_note('Post ex'); END $$;
SELECT public.t_check('P1 notes written after the cut-off for nobody are new 10 and have no window (no contact check)',
  public.t4_state('Post new') || ' ' || public.t4_state('Post ex') || ' ' || (SELECT count(*) FROM public.partner_return_note_windows
     WHERE note_id IN (public.t4_nid('Post new'), public.t4_nid('Post ex'))), 'pending|nobody|10|new pending|nobody|10|new 0');
SELECT public.t_check('P1 a new person activates a post-cut-off note: linked; your_rate 10; the note''s 10 shown',
  public.t4_act('d3n', 'Post new') || ' / ' || public.t4_state('Post new'),
  'ok already=false status=activated your=10 rate=10 monthly=30000 / activated|d3n|10|new');
SELECT public.t_check('P1 an existing partner activates a post-cut-off note: the late link raises it to their own 20 before the answer (rate 20, 60,000); your_rate 20',
  public.t4_act('ex20', 'Post ex') || ' / ' || public.t4_state('Post ex'),
  'ok already=false status=activated your=20 rate=20 monthly=60000 / activated|ex20|20|existing_partner');
SELECT public.t_check('P1 ... your_rate is partner_rate_now for the caller',
  ((public.t_v('t4_last')::jsonb ->> 'your_rate')::numeric = public.partner_rate_now(public.pid('ex20')))::text, 'true');

-- ===========================================================================
-- P3 (switch on). Note rates on the activation link
-- ===========================================================================
DO $$ BEGIN
  PERFORM public.t4_person('p3y'); PERFORM public.t4_person('p3z');
  PERFORM public.t4_note('Post new2');
  PERFORM public.t4_note('Post ex20', p_partner => 'ex20');
END $$;
SELECT public.t_check('P3 an unlinked note at the public rate (new 10) shows to anon',
  public.t4_state('Post new2') || ' / ' || public.t4_lk(NULL, 'Post new2'), 'pending|nobody|10|new / rate=10 monthly=30000 mine=false');
UPDATE public.promissory_notes SET partner_user_id = public.pid('p3y') WHERE activation_token = public.t4_tok('Post new2');
SELECT public.t_check('P3 the same new note once owner-run code links it to p3y: hidden from anon and from a stranger; shown to p3y',
  public.t4_state('Post new2') || ' / ' || public.t4_lk(NULL, 'Post new2') || ' / ' || public.t4_lk('p3z', 'Post new2') || ' / ' || public.t4_lk('p3y', 'Post new2'),
  'pending|p3y|10|new / rate=null monthly=null mine=false / rate=null monthly=null mine=false / rate=10 monthly=30000 mine=true');
SELECT public.t_check('P3 a note written after the cut-off for an existing partner carries their 20: shown to them, hidden from anon',
  public.t4_state('Post ex20') || ' / ' || public.t4_lk('ex20', 'Post ex20') || ' / ' || public.t4_lk(NULL, 'Post ex20'),
  'pending|ex20|20|existing_partner / rate=20 monthly=60000 mine=true / rate=null monthly=null mine=false');
UPDATE public.promissory_notes SET partner_user_id = NULL WHERE activation_token = public.t4_tok('Post ex20');
SELECT public.t_check('P3 that person-stamped note unlinked by owner-run code: hidden from everyone (anon, the former person)',
  public.t4_state('Post ex20') || ' / ' || public.t4_lk(NULL, 'Post ex20') || ' / ' || public.t4_lk('ex20', 'Post ex20'),
  'pending|nobody|20|existing_partner / rate=null monthly=null mine=false / rate=null monthly=null mine=false');
SELECT public.t_check('P3 a legacy (pre-cut-off) note linked to someone else still shows its 15 to anon (switch-off parity)',
  public.t4_lk(NULL, 'D3 c') || ' / ' || public.t4_lk('p3z', 'D3 c'), 'rate=15 monthly=45000 mine=false / rate=15 monthly=45000 mine=false');

-- ===========================================================================
-- P5. Who typed a rate a service-role insert queued for the CFO (x-welile-actor)
-- ===========================================================================
DO $$ BEGIN PERFORM public.t4_person(x) FROM unnest(ARRAY['p5a', 'p5b', 'p5c', 'p5d', 'p5e', 'p5f']) x; END $$;
SELECT public.t4_svc(format('{"x-welile-actor": "%s", "accept": "application/json"}', public.pid('pops'))) IS NULL AS x \gset
DO $$ BEGIN INSERT INTO public._t_ids VALUES ('p5a_p', public.t4_port('p5a', 20)); END $$;
SELECT public.t_check('P5 service role + header naming a staff user: stored at the person''s 10, queued at 20, requested_by = that staff user',
  public.t_desc(public.tid('p5a_p')) || ' / ' || public.t4_requester(public.tid('p5a_p')), '10|new|10|20 / new_portfolio:pops');
SELECT public.t4_svc('{"x-welile-actor": "not-a-uuid"}') IS NULL AS x \gset
DO $$ BEGIN INSERT INTO public._t_ids VALUES ('p5b_p', public.t4_port('p5b', 20)); END $$;
SELECT public.t4_svc('this is not json') IS NULL AS x \gset
DO $$ BEGIN INSERT INTO public._t_ids VALUES ('p5c_p', public.t4_port('p5c', 20)); END $$;
SELECT public.t4_svc(format('{"x-welile-actor": "%s"}', gen_random_uuid())) IS NULL AS x \gset
DO $$ BEGIN INSERT INTO public._t_ids VALUES ('p5d_p', public.t4_port('p5d', 20)); END $$;
SELECT public.t4_svc('') IS NULL AS x \gset
DO $$ BEGIN INSERT INTO public._t_ids VALUES ('p5e_p', public.t4_port('p5e', 20)); END $$;
SELECT public.t_check('P5 malformed uuid, a header that is not JSON, an unknown user id, an empty-string GUC (pooled reset): the insert succeeds, requested_by stays NULL',
  public.t4_requester(public.tid('p5b_p')) || ' ' || public.t4_requester(public.tid('p5c_p')) || ' ' || public.t4_requester(public.tid('p5d_p'))
  || ' ' || public.t4_requester(public.tid('p5e_p')), 'new_portfolio:nobody new_portfolio:nobody new_portfolio:nobody new_portfolio:nobody');
SELECT public.t_as('coo') IS NULL AS x \gset
SELECT set_config('request.headers', format('{"x-welile-actor": "%s"}', public.pid('pops')), false) IS NOT NULL AS x \gset
DO $$ BEGIN INSERT INTO public._t_ids VALUES ('p5f_p', public.t4_port('p5f', 20)); END $$;
SELECT public.t_check('P5 a signed-in (authenticated) insert with the header: ignored, the gate''s auth.uid() (coo) stands',
  public.t4_requester(public.tid('p5f_p')), 'new_portfolio:coo');
SELECT public.t4_svc(format('{"x-welile-actor": "%s"}', public.pid('cfo'))) IS NULL AS x \gset
UPDATE public.investor_portfolios SET roi_percentage = 18 WHERE id = public.tid('p5a_p');
SELECT public.t_check('P5 a rate change through the service role with the header: the new request (rate_change) records who typed it; the old one superseded',
  public.t_desc(public.tid('p5a_p')) || ' / ' || public.t4_requester(public.tid('p5a_p')), '10|new|10|18 / rate_change:cfo');
SELECT public.t4_svc('') IS NULL AS x \gset
SELECT public.t_as(NULL) IS NULL AS x \gset
SELECT public.t_check('P5 the trigger function is not callable as an RPC by browsers',
  has_function_privilege('anon', 'public.portfolio_rate_requests_stamp_actor()', 'EXECUTE') || '/'
  || has_function_privilege('authenticated', 'public.portfolio_rate_requests_stamp_actor()', 'EXECUTE'), 'false/false');

-- ===========================================================================
-- P6 (switch on). Each rule count turns positive on a crafted row
-- ===========================================================================
SELECT public.t_vset('r0', public.t4_report()::text);
SELECT public.t_check('P6 switch on: policy block (enabled, public rate 10, cut-off set); note_windows_beyond_90d = 1 (the far-due note written before the cut-off)',
  (SELECT (r -> 'policy' ->> 'enabled') || '/' || (r -> 'policy' ->> 'public_rate') || '/' || (r -> 'policy' ->> 'cutoff_at' IS NOT NULL) || '/'
          || (r -> 'rule_check' ->> 'note_windows_beyond_90d') FROM (SELECT public.t_v('r0')::jsonb r) x), 'true/10/true/1');
DO $$ BEGIN
  INSERT INTO public._t_ids VALUES ('p6_ex', public.t4_port('ex20')), ('p6_new', public.t4_port('p3z'));
  -- Crafted (the gate would never store these): rows written with the triggers off.
  PERFORM set_config('session_replication_role', 'replica', true);
  UPDATE public.investor_portfolios SET roi_percentage = 12 WHERE id = (SELECT id FROM public._t_ids WHERE k = 'p6_ex');
  UPDATE public.investor_portfolios SET roi_percentage = 15 WHERE id = (SELECT id FROM public._t_ids WHERE k = 'p6_new');
END $$;
UPDATE public.investor_portfolios SET status = 'active' WHERE portfolio_code = 'D14-OFFER';
SELECT public.t_vset('r1', public.t4_report()::text);
DO $$ BEGIN INSERT INTO public._t_ids VALUES ('p6_pend', public.t4_port('p3z', NULL, 'pending_ops_approval')), ('p6_low', public.t4_port('ex20', 12)); END $$;
SELECT public.t_vset('r2', public.t4_report()::text);
SELECT public.t_check('P6 deltas: cohort partner below their own rate +1; non-cohort new above the public rate +1; pre-cut-off offer live for a non-cohort person +1 (D14); a new pending portfolio +1; a typed rate below the person''s own -> pending_lowering +1',
  (SELECT 'below_own +' || ((r1 -> 'rule_check' ->> 'cohort_new_below_own')::int - (r0 -> 'rule_check' ->> 'cohort_new_below_own')::int)
       || ' above_public +' || ((r1 -> 'rule_check' ->> 'non_cohort_new_above_public')::int - (r0 -> 'rule_check' ->> 'non_cohort_new_above_public')::int)
       || ' precutoff +' || ((r1 -> 'rule_check' ->> 'precutoff_offer_live_non_cohort')::int - (r0 -> 'rule_check' ->> 'precutoff_offer_live_non_cohort')::int)
       || ' pending +' || ((r2 -> 'rule_check' ->> 'open_pending_portfolios')::int - (r1 -> 'rule_check' ->> 'open_pending_portfolios')::int)
       || ' lowering +' || ((r2 -> 'cfo_queue' ->> 'pending_lowering')::int - (r1 -> 'cfo_queue' ->> 'pending_lowering')::int)
     FROM (SELECT public.t_v('r0')::jsonb r0, public.t_v('r1')::jsonb r1, public.t_v('r2')::jsonb r2) x),
  'below_own +1 above_public +1 precutoff +1 pending +1 lowering +1');
SELECT public.t_check('P6 the typed-12 request for ex20 is a lowering one (12 < standard 20); the report''s pending count includes it',
  public.t_desc(public.tid('p6_low')) || ' / ' || ((public.t_v('r2')::jsonb -> 'cfo_queue' ->> 'pending')::int
                                                   = (SELECT count(*) FROM public.portfolio_rate_approvals WHERE status = 'pending')),
  '20|existing_partner|20|12 / true');
SELECT public.t_check('P6 the crafted rows also show as conformance issues and failing rates_conform (history, not a switch-on precondition)',
  (SELECT (r -> 'checks_failing')::text FROM (SELECT public.t_v('r2')::jsonb r) x), '["rates_conform"]');
SELECT public.t_check('P6 still counts only after the switch-on: no person id, no partner name',
  (SELECT (t !~ '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-') || '/' || (position('P4 ' in t) = 0) FROM (SELECT public.t_v('r2') t) x), 'true/true');

-- ===========================================================================
-- AM. The §2.7 amendments to the Phase 1/2 files
-- ===========================================================================
-- #1 a carried (split/lock) child of a continuing parent keeps the partner existing after the parent is redeemed.
DO $$ BEGIN INSERT INTO public._t_ids VALUES ('am_child', public.t4_port('am_ex', NULL, 'locked', 'agent1', 'AMEX-CHILD', public.t4_pid('AMEX-PARENT'), 100000)); END $$;
UPDATE public.investor_portfolios SET status = 'redeemed' WHERE portfolio_code = 'AMEX-PARENT';
SELECT public.t_check('AM#1 carried child of am_ex''s pre-cut-off 18 portfolio: 18 carried; parent redeemed -> am_ex still existing 18 (Phase 1 before §2.7: new 10); the next portfolio opens at 18',
  public.t_desc(public.tid('am_child')) || ' / ' || public.t_rate('am_ex') || ' / ' || public.t_desc(public.t4_port('am_ex', NULL, 'active', 'agent1', 'AMEX-NEXT')),
  '18|carried|18|- / 18|existing_partner / 18|existing_partner|18|-');
UPDATE public.investor_portfolios SET status = 'redeemed' WHERE portfolio_code IN ('AMEX-CHILD', 'AMEX-NEXT');
SELECT public.t_check('AM#1 once the carried child (and the rest) is redeemed too, am_ex is a new partner (10)', public.t_rate('am_ex'), '10|new');
SELECT public.t_vset('rq0', public.t4_report() -> 'rule_check' ->> 'cohort_new_below_own');
SELECT public.t_vset('amex_back', public.t_desc(public.t4_port('am_ex')));
SELECT 'INFO  P6 (note, not counted) am_ex, on the cut-off list but now a new partner (redeemed everything), opens a portfolio at '
       || public.t_v('amex_back') || ': cohort_new_below_own +'
       || ((public.t4_report() -> 'rule_check' ->> 'cohort_new_below_own')::int - public.t_v('rq0')::int)
       || ' (a legitimate new 10 counted as below their own rate; the count does not check has_live_continuing)';
-- #2 D10: an approved new-portfolio rate applies before the portfolio's first Returns event.
DO $$ BEGIN PERFORM public.t4_person(x) FROM unnest(ARRAY['am_d10', 'am_paid', 'am_recent']) x; END $$;
SELECT public.t4_svc(format('{"x-welile-actor": "%s"}', public.pid('pops'))) IS NULL AS x \gset
DO $$ BEGIN
  INSERT INTO public._t_ids VALUES ('am_d10_p', public.t4_port('am_d10', 20)), ('am_paid_p', public.t4_port('am_paid', 20)),
                                   ('am_recent_p', public.t4_port('am_recent', 20));
END $$;
SELECT public.t4_svc('') IS NULL AS x \gset
INSERT INTO public.pending_wallet_operations (source_table, source_id, category, status, reviewed_at)
VALUES ('investor_portfolios', public.tid('am_paid_p'), 'roi_payout', 'approved', now() - interval '20 days'),
       ('investor_portfolios', public.tid('am_recent_p'), 'roi_payout', 'approved', now() - interval '2 days');
SELECT public.t_as('cfo') IS NULL AS x \gset
SELECT public.t_check('AM#2 the CFO approves the three typed 20s (imported after the cut-off, stored at 10)',
  public.cfo_decide_portfolio_rate_requests(ARRAY(SELECT id FROM public.portfolio_rate_approvals WHERE status = 'pending'
     AND portfolio_id IN (public.tid('am_d10_p'), public.tid('am_paid_p'), public.tid('am_recent_p'))), 'approve', 'AM D10') ->> 'decided', '3');
SELECT public.t_as(NULL) IS NULL AS x \gset
SELECT public.t_vset('am_apply', (public.apply_due_portfolio_rate_changes() ->> 'applied'));
SELECT public.t_check('AM#2 next apply run: no Returns event yet -> 20 applied now (D10); paid 2 days ago -> applied (approval inside the grace); paid 20 days ago -> waits for the next cycle (scheduled)',
  public.t_v('am_apply') || ' / ' || public.t_desc(public.tid('am_d10_p')) || ' ' || public.t4_reqs(public.tid('am_d10_p')) || ' / '
  || public.t_desc(public.tid('am_recent_p')) || ' / ' || public.t_desc(public.tid('am_paid_p')) || ' ' || public.t4_reqs(public.tid('am_paid_p')),
  '2 / 20|new|10|- new_portfolio@20:approved(applied) / 20|new|10|- / 10|new|10|- new_portfolio@20:approved(scheduled)');
-- #3 a 'funded' booking notice states the rate of the houses the person funded, not the note's.
DO $$ BEGIN
  PERFORM public.t4_person('am_f'); PERFORM public.t4_person('am_g');
  PERFORM public.t4_note('AM fund', p_partner => 'am_f'); PERFORM public.t4_note('AM fund mixed', p_partner => 'am_f');
  PERFORM public.t4_note('AM fund 15', p_partner => 'am_g'); PERFORM public.t4_note('AM reserved', p_partner => 'am_f');
  INSERT INTO public.promissory_note_house_intents (note_id, house_id, agent_id, monthly_rent, status)
  SELECT public.t4_nid(v.k), public.pid(v.h), public.pid('agent1'), 200000, v.s
    FROM (VALUES ('AM fund', 'amh1', 'funded'), ('AM fund', 'amh2', 'funded'), ('AM fund mixed', 'amh3', 'funded'), ('AM fund mixed', 'amh4', 'funded'),
                 ('AM fund 15', 'amh5', 'funded'), ('AM reserved', 'amh6', 'reserved')) v(k, h, s);
  INSERT INTO public.partner_supported_houses (partner_id, house_id, principal, monthly_rate, status)
  VALUES (public.pid('am_f'), public.pid('amh1'), 200000, 12, 'active'), (public.pid('am_f'), public.pid('amh2'), 200000, 12, 'active'),
         (public.pid('am_f'), public.pid('amh3'), 200000, 12, 'active'), (public.pid('am_f'), public.pid('amh4'), 200000, 14, 'active'),
         (public.pid('am_g'), public.pid('amh5'), 200000, 15, 'active');
  PERFORM public.psm_queue_house_booking_notice(public.t4_nid(k), CASE WHEN k = 'AM reserved' THEN 'reserved' ELSE 'funded' END)
     FROM unnest(ARRAY['AM fund', 'AM fund mixed', 'AM fund 15', 'AM reserved']) k;
END $$;
SELECT public.t_check('AM#3 booking notices: funded, houses at 12 -> 12 (the note says 10); houses at 12 and 14 -> NULL (no % line); houses at 15 -> 15; reserved -> the note''s 10',
  (SELECT string_agg(b.partner_name || ':' || b.kind || '=' || COALESCE(trim_scale(b.return_rate)::text, '-'), ' ' ORDER BY b.partner_name COLLATE "C")
     FROM public.promissory_house_booking_notices b WHERE b.partner_name LIKE 'AM %') || ' / ' || public.t4_state('AM fund'),
  'AM fund:funded=12 AM fund 15:funded=15 AM fund mixed:funded=- AM reserved:reserved=10 / pending|am_f|10|new');

-- ===========================================================================
-- 4a-assistant (switch on)
-- ===========================================================================
SELECT public.t4_person('as_new', p_roles => ARRAY['supporter']) IS NOT NULL AS x \gset
SELECT public.t_check('AS switch on: a new partner -> 10; an existing partner -> their own 20 (never the public rate)',
  'as_new=' || public.t4_asst('as_new') || ' ex20=' || public.t4_asst('ex20'),
  'as_new={"available": true, "rate_percent": 10} ex20={"available": true, "rate_percent": 20}');

-- ===========================================================================
-- A. The PostgREST login role (session_user authenticator, as in production): anon and the service role
-- ===========================================================================
SELECT public.t_as(NULL) IS NULL AS x \gset
\c - authenticator
SET client_min_messages = warning;
SET ROLE anon;
SELECT public.t_as(NULL) IS NULL AS x \gset
SELECT public.t_check('A anon (authenticator login): partner_rate_visible_to_caller is false, not NULL',
  public.t4_vis(NULL, 'm_owner') || '/' || public.t4_vis(NULL, NULL), 'false/false');
SELECT public.t_check('A anon token page: a linked portfolio -> NULL rate and Returns earned (production shows 20 / 2000); an invite portfolio -> its 15; otherwise production''s row',
  public.t4_tpf(NULL, 'M-OWN') || ' | ' || public.t4_tpf(NULL, 'M-INV') || ' | production ' || COALESCE(public.t4_tp(NULL, 'M-OWN', true) ->> 'roi_percentage', 'null'),
  'null/null production with the figures hidden | 15/1500 same as production | production 20');
SELECT public.t_check('A anon public trust profile: Returns figures hidden (keys kept), earning_returns true',
  public.t4_pt_cmp(NULL, 'm_owner', true), 'hidden');
SELECT public.t_check('A anon cannot call get_user_trust_profile, activate_promissory_note, the report or the batch readers (42501); lookup answers',
  split_part(public.t_err($s$SELECT public.get_user_trust_profile('WEL-000000')$s$), ':', 1) || ' '
  || split_part(public.t_err($s$SELECT public.activate_promissory_note('tok-0000000000000000')$s$), ':', 1) || ' '
  || split_part(public.t_err($s$SELECT public.get_partner_return_report(current_date, current_date)$s$), ':', 1) || ' '
  || split_part(public.t_err($s$SELECT public.partner_confirmed_login_emails('{}')$s$), ':', 1) || ' '
  || split_part(public.t_err($s$SELECT public.profile_ids_by_emails('{}')$s$), ':', 1) || ' '
  || public.t4_lk(NULL, 'D3 c'),
  '42501 42501 42501 42501 42501 rate=15 monthly=45000 mine=false');
RESET ROLE;
SET ROLE authenticated;
SELECT public.t_as(NULL) IS NULL AS x \gset
SELECT public.t_check('A authenticated with no user (a broken JWT): activation -> AUTH_REQUIRED; the report and the batch readers -> permission denied (42501)',
  public.t_err($s$SELECT public.activate_promissory_note('tok-0000000000000000')$s$) || ' | '
  || split_part(public.t_err($s$SELECT public.get_partner_return_report(current_date, current_date)$s$), ':', 1),
  '42501: AUTH_REQUIRED: please sign in to activate this note | 42501');
RESET ROLE;
SET ROLE service_role;
SELECT set_config('request.jwt.claim.role', 'service_role', false) IS NOT NULL AS x \gset
SELECT public.t_check('A service role (an edge function): may see a person''s rate (backend), runs the report and the batch readers; may not activate (42501)',
  COALESCE(public.partner_rate_visible_to_caller(public.pid('m_owner'))::text, 'NULL') || ' | '
  || public.t_err($s$SELECT public.get_partner_return_report(current_date, current_date)$s$) || ' | '
  || public.t_err($s$SELECT public.partner_confirmed_login_emails(ARRAY[public.pid('e1')])$s$) || ' | '
  || split_part(public.t_err($s$SELECT public.activate_promissory_note('tok-0000000000000000')$s$), ':', 1),
  'true | ok | ok | 42501');
RESET ROLE;
\c - postgres
SET client_min_messages = warning;
DROP POLICY _t4_service_role_bypass ON public.promissory_notes;
DROP POLICY _t4_service_role_bypass ON public.user_roles;

-- ===========================================================================
SELECT 'SUMMARY ' || count(*) FILTER (WHERE ok) || '/' || count(*) || ' passed'
       || COALESCE(' -- FAILED: ' || string_agg(name, '; ' ORDER BY n) FILTER (WHERE NOT ok), '')
  FROM public._t_results;
