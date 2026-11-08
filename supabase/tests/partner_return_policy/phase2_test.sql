-- Phase 2 (per-person Partner Returns: every creation path uses the rule) functional tests.
-- LOCAL THROWAWAY CLUSTER ONLY (port 55432). Prerequisite: race_stub.sql + race_stub_phase2.sql,
-- then the Phase 1 and Phase 2 migrations (each applied twice). Run by run_phase2_tests.sh.
-- Prints one PASS/FAIL line per assertion and a SUMMARY line. Identities are pid('<name>').
\pset tuples_only on
\pset format unaligned
\pset pager off
SET client_min_messages = warning;

\ir phase2_helpers.sql

-- ===========================================================================
-- M. Right after the migrations (each applied twice)
-- ===========================================================================
SELECT public.t_check('M switch ships OFF, no cut-off, release_ready = false (Phase 2 does not set it; the release migration, Phase 7, will)',
  (SELECT enabled || '/' || COALESCE(cutoff_at::text, 'none') || '/' || release_ready FROM public.partner_return_policy), 'false/none/false');
SELECT public.t_check('M neither migration changed a policy setting (no settings audit row, no settings e-mail)',
  (SELECT count(*) FROM public.audit_logs WHERE action_type = 'partner_return_policy_settings_changed') || '/' || public.t_emails('Partner Returns settings changed'), '0/0');
SELECT public.t_check('M assert check release_ready: ok while the switch is off and not ready, and says ready=false',
  (SELECT ok || '|' || (detail LIKE '%(ready=false)') FROM public.assert_partner_return_policy_intact() WHERE check_name = 'release_ready'), 'true|true');
SELECT public.t_check('M assert_partner_return_policy_intact: 17 checks, all ok',
  (SELECT count(*) || '/' || COALESCE(string_agg(check_name, ',') FILTER (WHERE NOT ok), 'all ok') FROM public.assert_partner_return_policy_intact()),
  '17/all ok');
SELECT public.t_check('M one overload each of the listing and the summary (old signatures dropped)',
  (SELECT string_agg(p.oid::regprocedure::text, ' ; ' ORDER BY 1) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname IN ('agent_list_empty_house_opportunities', 'empty_house_opportunity_summary')),
  'agent_list_empty_house_opportunities(text,integer,integer,text,boolean,boolean,numeric,numeric,double precision,double precision,double precision,text,text,uuid) ; empty_house_opportunity_summary(text,uuid)');
SELECT public.t_check('M replaced functions keep their production ACL (CREATE OR REPLACE)',
  (SELECT COALESCE(string_agg(b.fn || ' was ' || b.acl || ' now ' || COALESCE(p.proacl::text, 'gone'), ' ; '), 'unchanged')
     FROM public._t_acl_before b
     LEFT JOIN pg_proc p ON p.oid = to_regprocedure('public.' || b.fn)
    WHERE b.fn NOT LIKE 'agent_list_empty_house_opportunities%' AND b.fn NOT LIKE 'empty_house_opportunity_summary%'
      AND (SELECT array_agg(x ORDER BY x) FROM unnest(p.proacl::text[]) x) IS DISTINCT FROM (SELECT array_agg(x ORDER BY x) FROM unnest(b.acl::text[]) x)),
  'unchanged');
SELECT public.t_check('M re-created listing/summary: same grantees as production (postgres, authenticated, service_role)',
  (SELECT string_agg(DISTINCT x, ',' ORDER BY x) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace, unnest(p.proacl::text[]) x
    WHERE n.nspname = 'public' AND p.proname IN ('agent_list_empty_house_opportunities', 'empty_house_opportunity_summary')),
  'authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres');
SELECT public.t_check('M grants: quote rate open to anon+authenticated; partner_rate_now backend only; split authenticated not anon; _partner_commitment_follow_rate closed to authenticated AND service_role',
  has_function_privilege('anon', 'public.partner_quote_rate(text,uuid)', 'EXECUTE') || '/'
  || has_function_privilege('authenticated', 'public.partner_quote_rate(text,uuid)', 'EXECUTE') || '/'
  || has_function_privilege('authenticated', 'public.partner_rate_now(uuid)', 'EXECUTE') || '/'
  || has_function_privilege('service_role', 'public.partner_rate_now(uuid)', 'EXECUTE') || '/'
  || has_function_privilege('authenticated', 'public.agent_create_promissory_notes_split(jsonb,uuid[])', 'EXECUTE') || '/'
  || has_function_privilege('anon', 'public.agent_create_promissory_notes_split(jsonb,uuid[])', 'EXECUTE') || '/'
  || has_function_privilege('authenticated', 'public._partner_commitment_follow_rate(uuid,numeric)', 'EXECUTE') || '/'
  || has_function_privilege('service_role', 'public._partner_commitment_follow_rate(uuid,numeric)', 'EXECUTE'),
  'true/true/false/true/true/false/false/false');
SELECT public.t_check('M rent_facilitation_reward_rates: no browser access, service_role SELECT only, RLS on, MFA policy',
  has_table_privilege('authenticated', 'public.rent_facilitation_reward_rates', 'SELECT') || '/'
  || has_table_privilege('anon', 'public.rent_facilitation_reward_rates', 'SELECT') || '/'
  || has_table_privilege('service_role', 'public.rent_facilitation_reward_rates', 'SELECT') || '/'
  || has_table_privilege('service_role', 'public.rent_facilitation_reward_rates', 'INSERT') || '/'
  || (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.rent_facilitation_reward_rates'::regclass) || '/'
  || (SELECT count(*) FROM pg_policies WHERE tablename = 'rent_facilitation_reward_rates' AND policyname = 'mfa_required_for_staff'),
  'false/false/true/false/true/1');
SELECT public.t_check('M notice queues gained return_rate numeric(6,2)',
  (SELECT string_agg(table_name || ':' || data_type || '(' || numeric_precision || ',' || numeric_scale || ')', ',' ORDER BY table_name)
     FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'return_rate'
      AND table_name IN ('promissory_note_pledge_notices', 'promissory_house_booking_notices', 'funder_house_progress_notices')),
  'funder_house_progress_notices:numeric(6,2),promissory_house_booking_notices:numeric(6,2),promissory_note_pledge_notices:numeric(6,2)');
SELECT public.t_check('M backfill: the 4 pre-existing rent-facilitation fundings (3 from the stub, rr_nocut between the applies) stored once; rr_legacy at the legacy 15, decided at its funded_at',
  (SELECT count(*) FROM public.rent_facilitation_reward_rates) || '/'
  || (SELECT trim_scale(rate) || '|' || basis || '|' || (decided_at = timestamptz '2026-09-01 09:00+03')
        FROM public.rent_facilitation_reward_rates WHERE rent_request_id = public.pid('rr_legacy')), '4/15|legacy|true');
SELECT public.t_check('M backfill re-run (apply #2): a funding whose supporter changed while the stamp trigger was off is decided again for the new supporter (legacy 15, at its funded_at)',
  (SELECT (split_part(v, '|', 1) = public.pid('moved_from')::text)::text FROM public._t_between WHERE k = 'rr_moved_before') || '/'
  || (SELECT (supporter_id = public.pid('moved_to')) || '|' || trim_scale(rate) || '|' || basis || '|' || (decided_at = timestamptz '2026-09-10 09:00+03')
        FROM public.rent_facilitation_reward_rates WHERE rent_request_id = public.pid('rr_moved')), 'true/true|15|legacy|true');
SELECT public.t_check('M backfill re-run leaves an unchanged supporter''s stored row alone (its marker rate 17 kept)',
  (SELECT (supporter_id = public.pid('same_supporter')) || '|' || trim_scale(rate) FROM public.rent_facilitation_reward_rates
    WHERE rent_request_id = public.pid('rr_same')), 'true|17');
SELECT public.t_check('M CREATE OR REPLACE TRIGGER: the three Phase 2 triggers kept their OIDs across the re-apply and are enabled',
  (SELECT count(*) || '/' || bool_and(t.oid::text = b.v AND t.tgenabled = 'O') FROM public._t_between b JOIN pg_trigger t ON 'trg:' || t.tgname = b.k), '3/true');
SELECT public.t_check('M late-link trigger is statement-level AFTER UPDATE with transition tables',
  (SELECT (tgtype & 1 = 0)::text || '/' || (tgtype & 16 > 0)::text || '/' || COALESCE(tgoldtable::text, '-') || '/' || COALESCE(tgnewtable::text, '-')
     FROM pg_trigger WHERE tgname = 'trg_zz_partner_note_linked_late'), 'true/true/old_notes/new_notes');
SELECT public.t_check('M the stub''s partner_supported_house_returns carried the production fingerprint (manifest), and Phase 2 replaced it',
  (SELECT (f.md5 = (SELECT m.doc -> 'functions' ->> 'partner_supported_house_returns()' FROM public._t_manifest m))::text
          || '/' || (md5(pg_get_functiondef('public.partner_supported_house_returns()'::regprocedure)) <> f.md5)
     FROM public._t_prod_fp f WHERE f.fn = 'partner_supported_house_returns()'), 'true/true');
-- Functions the build creates (not in the stub before the migrations, not a known production function).
CREATE TEMP VIEW t_build_new AS
  SELECT a.proname FROM public._t_fn_after a
   WHERE a.proname NOT IN (SELECT proname FROM public._t_fn_before)
     AND a.proname NOT IN (SELECT split_part(k, '(', 1) FROM public._t_manifest, jsonb_object_keys(doc -> 'functions') k);
SELECT public.t_check('M every function Phase 1 + Phase 2 create is on the manifest''s expected-absent list (a production name clash is caught before applying)',
  (SELECT COALESCE(string_agg(proname, ',' ORDER BY proname), 'none') FROM t_build_new
    WHERE proname NOT IN (SELECT jsonb_array_elements_text(doc -> 'expected_absent_in_production') FROM public._t_manifest)), 'none');
SELECT 'INFO  M functions created by Phase 1 + 2: ' || (SELECT count(*) FROM t_build_new)
  || '; on the expected-absent list but not created by Phase 1 + 2: '
  || COALESCE((SELECT string_agg(x, ',' ORDER BY x) FROM public._t_manifest, jsonb_array_elements_text(doc -> 'expected_absent_in_production') x
                WHERE x NOT IN (SELECT proname FROM public._t_fn_after)), 'none')
  || '; known production functions the stub lacks that the build replaces: '
  || COALESCE((SELECT string_agg(a.proname, ',' ORDER BY a.proname) FROM public._t_fn_after a
                WHERE a.proname NOT IN (SELECT proname FROM public._t_fn_before) AND a.proname NOT IN (SELECT proname FROM t_build_new)), 'none');
SELECT public.t_check('M manifest (Phase 4 round 3: Phase 1 adds partner_note_window_open, Phase 4 14 names incl. 4b partner_returns_visible_to_caller): 53 expected-absent names, distinct, including partner_rate_lock, _promissory_note_rate_json, _promissory_note_notice_contacts and partner_note_window_applies; all four created by the build',
  (SELECT jsonb_array_length(doc -> 'expected_absent_in_production') || '/'
          || (SELECT count(DISTINCT x) FROM jsonb_array_elements_text(doc -> 'expected_absent_in_production') x) || '/'
          || (doc -> 'expected_absent_in_production' ? 'partner_rate_lock') || '/' || (doc -> 'expected_absent_in_production' ? '_promissory_note_rate_json')
          || '/' || (doc -> 'expected_absent_in_production' ? '_promissory_note_notice_contacts')
          || '/' || (doc -> 'expected_absent_in_production' ? 'partner_note_window_applies')
     FROM public._t_manifest) || '/'
  || (SELECT count(*) FROM t_build_new WHERE proname IN ('partner_rate_lock', '_promissory_note_rate_json', '_promissory_note_notice_contacts', 'partner_note_window_applies')),
  '53/53/true/true/true/true/4');
SELECT public.t_check('M manifest (Phase 4 fix round): the build creates 34 functions (partner_note_window_open added), every one listed; the other 19 listed names are later-phase ones (53 = 34 + 5 agreement names + 14 Phase 4 names)',
  (SELECT count(*) FROM t_build_new) || '/'
  || (SELECT count(*) FROM t_build_new WHERE proname IN (SELECT jsonb_array_elements_text(doc -> 'expected_absent_in_production') FROM public._t_manifest)) || '/'
  || (SELECT string_agg(x, ',' ORDER BY x) FROM public._t_manifest, jsonb_array_elements_text(doc -> 'expected_absent_in_production') x
       WHERE x NOT IN (SELECT proname FROM t_build_new)),
  '34/34/_note_contact_proven,_partner_return_phase4_checks,_promissory_note_funded_house_rates,_promissory_note_rate_view,activate_promissory_note,assistant_partner_new_portfolio_rate,get_partner_return_report,guard_note_window_link,lookup_promissory_note,partner_agreement_terms,partner_agreement_terms_now,partner_agreement_version_now,partner_confirmed_login_emails,partner_rate_visible_to_caller,partner_renewal_rate,partner_returns_visible_to_caller,portfolio_rate_requests_stamp_actor,profile_ids_by_emails,stamp_partner_agreement_terms');
SELECT public.t_check('M _promissory_note_notice_contacts(promissory_notes) (round 4): owner only (no PUBLIC, anon, authenticated, service_role); STABLE sql, SECURITY INVOKER, pinned search_path; OUT phone, email',
  (SELECT COALESCE(p.proacl::text, 'default') || '/' || l.lanname || ':' || p.prosecdef || ':' || p.provolatile::text || ':' || COALESCE(array_to_string(p.proconfig, ','), '-')
          || '/' || pg_get_function_arguments(p.oid)
     FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang WHERE p.oid = 'public._promissory_note_notice_contacts(public.promissory_notes)'::regprocedure) || '/'
  || (SELECT bool_or(has_function_privilege(r, 'public._promissory_note_notice_contacts(public.promissory_notes)', 'EXECUTE'))::text
        FROM unnest(ARRAY['anon', 'authenticated', 'service_role']) r),
  '{postgres=X/postgres}/sql:false:s:search_path=public, pg_temp/p_note promissory_notes, OUT phone text, OUT email text/false');
SET ROLE authenticated;
SELECT public.t_check('M a signed-in browser cannot call either note helper (42501)',
  split_part(public.t_err('SELECT public._promissory_note_notice_contacts(NULL::public.promissory_notes)'), ':', 1) || '/'
  || split_part(public.t_err('SELECT public._promissory_note_rate_json(NULL::public.promissory_notes, NULL::uuid)'), ':', 1), '42501/42501');
RESET ROLE;
-- Round 5: who a pre-cut-off note's window is for (Phase 1 partner_note_window_applies, the window's frozen person and agent).
-- Round 6: four arguments (owner and agent frozen at the cut-off, the note's agent NOW, the person); the 3-argument
-- version is dropped first, so exactly one overload exists.
SELECT public.t_check('M partner_note_window_applies(uuid,uuid,uuid,uuid) (round 6): owner only (no PUBLIC, anon, authenticated, service_role); IMMUTABLE sql, SECURITY INVOKER, pinned search_path',
  (SELECT COALESCE(p.proacl::text, 'default') || '/' || l.lanname || ':' || p.prosecdef || ':' || p.provolatile::text || ':' || COALESCE(array_to_string(p.proconfig, ','), '-')
     FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang WHERE p.oid = 'public.partner_note_window_applies(uuid,uuid,uuid,uuid)'::regprocedure) || '/'
  || (SELECT bool_or(has_function_privilege(r, 'public.partner_note_window_applies(uuid,uuid,uuid,uuid)', 'EXECUTE'))::text
        FROM unnest(ARRAY['anon', 'authenticated', 'service_role']) r),
  '{postgres=X/postgres}/sql:false:i:search_path=public, pg_temp/false');
SELECT public.t_check('M (round 6) exactly one partner_note_window_applies: the 4-argument one (owner, agent then, agent now, person); the 3-argument one is gone',
  (SELECT string_agg(p.oid::regprocedure::text || ' ' || pg_get_function_arguments(p.oid) || ' -> ' || pg_get_function_result(p.oid), ' ; ')
     FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'partner_note_window_applies') || '/'
  || (to_regprocedure('public.partner_note_window_applies(uuid,uuid,uuid)') IS NULL),
  'partner_note_window_applies(uuid,uuid,uuid,uuid) p_owner uuid, p_agent_then uuid, p_agent_now uuid, p_person uuid -> boolean/true');
-- Cases 1-8 are the round-5 table with the current agent equal to the frozen one; 9-15 the round-6 current-agent cases
-- (W = the agent who holds the note now); 16-17 a NULL person (no caller passes one).
SELECT public.t_check('M partner_note_window_applies(owner, agent then, agent now, person) truth table: (X,Y,Y,X) (X,Y,Y,Z) (X,X,X,X) (-,Y,Y,Y) (-,Y,Y,Z) (-,-,-,Z) (X,-,-,X) (X,-,-,Z) | round 6: (-,Y,W,W) (-,Y,W,Y) (-,Y,W,Z) (-,-,W,W) (-,Y,-,Z) (X,Y,W,W) (X,Y,X,X) | (-,Y,W,null) (X,Y,W,null)',
  (SELECT string_agg(COALESCE(public.partner_note_window_applies(v.o, v.a, v.c, v.p)::text, 'null'), ',' ORDER BY v.n)
     FROM (VALUES (1, public.pid('x'), public.pid('y'), public.pid('y'), public.pid('x')), (2, public.pid('x'), public.pid('y'), public.pid('y'), public.pid('z')),
                  (3, public.pid('x'), public.pid('x'), public.pid('x'), public.pid('x')), (4, NULL, public.pid('y'), public.pid('y'), public.pid('y')),
                  (5, NULL, public.pid('y'), public.pid('y'), public.pid('z')), (6, NULL, NULL, NULL, public.pid('z')),
                  (7, public.pid('x'), NULL, NULL, public.pid('x')), (8, public.pid('x'), NULL, NULL, public.pid('z')),
                  (9, NULL, public.pid('y'), public.pid('w'), public.pid('w')), (10, NULL, public.pid('y'), public.pid('w'), public.pid('y')),
                  (11, NULL, public.pid('y'), public.pid('w'), public.pid('z')), (12, NULL, NULL, public.pid('w'), public.pid('w')),
                  (13, NULL, public.pid('y'), NULL, public.pid('z')), (14, public.pid('x'), public.pid('y'), public.pid('w'), public.pid('w')),
                  (15, public.pid('x'), public.pid('y'), public.pid('x'), public.pid('x')),
                  (16, NULL, public.pid('y'), public.pid('w'), NULL), (17, public.pid('x'), public.pid('y'), public.pid('w'), NULL)) v(n, o, a, c, p)),
  'true,false,true,false,true,true,true,false,false,false,true,false,true,false,true,true,null');
SELECT public.t_check('M (round 6; Phase 4 fix round) the helper''s callers: exactly partner_note_linked_late and partner_note_window_open (comments stripped); partner_rates_for goes through partner_note_window_open once; each passes the note''s current agent (n.agent_id) as the agent now',
  (SELECT string_agg(p.proname, ',' ORDER BY p.proname) FROM pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace AND p.proname <> 'partner_note_window_applies'
      AND regexp_replace(p.prosrc, '--[^\n]*', '', 'g') LIKE '%partner_note_window_applies(%') || '/'
  || (SELECT (length(c) - length(replace(c, 'public.partner_note_window_open(n.status, w.ends_on, w.partner_user_id, w.agent_id, n.agent_id, i.pid)', '')))
             / length('public.partner_note_window_open(n.status, w.ends_on, w.partner_user_id, w.agent_id, n.agent_id, i.pid)')
        FROM (SELECT regexp_replace(prosrc, '--[^\n]*', '', 'g') AS c FROM pg_proc WHERE oid = 'public.partner_rates_for(uuid[],boolean)'::regprocedure) x) || '/'
  || (SELECT (length(c) - length(replace(c, 'public.partner_note_window_applies(w.partner_user_id, w.agent_id, n.agent_id, n.partner_user_id)', '')))
             / length('public.partner_note_window_applies(w.partner_user_id, w.agent_id, n.agent_id, n.partner_user_id)')
        FROM (SELECT regexp_replace(prosrc, '--[^\n]*', '', 'g') AS c FROM pg_proc WHERE oid = 'public.partner_note_linked_late()'::regprocedure) x),
  'partner_note_linked_late,partner_note_window_open/1/1');
-- Round 6 (a): at most one OPEN request (pending, or approved and not applied) per portfolio. The gate's and the late link's
-- INSERT ... ON CONFLICT (portfolio_id) WHERE status = 'pending' DO NOTHING infer it as an arbiter next to the one-pending
-- index (EXPLAIN of each shipped statement, taken from the function text with its variables replaced by literals).
CREATE FUNCTION public.t_arbiters(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE j json;
BEGIN
  EXECUTE 'EXPLAIN (FORMAT JSON, COSTS OFF) ' || p_sql INTO j;
  RETURN (SELECT string_agg(x, ',') FROM json_array_elements_text(j -> 0 -> 'Plan' -> 'Conflict Arbiter Indexes') x);
END $$;
CREATE FUNCTION public.t_conflict_stmt(p_fn text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE d text := pg_get_functiondef(p_fn::regprocedure); s text;
BEGIN
  IF p_fn = 'public.enforce_partner_return_rate_policy()' THEN
    s := substring(d from '(INSERT INTO public\.portfolio_rate_approvals\s+\(portfolio_id, requested_rate, rate_in_force, standard_rate, source, requested_by\)\s+VALUES \(NEW\.id[^;]*?ON CONFLICT[^;]*?DO NOTHING)');
    s := replace(replace(replace(s, 'NEW.id', 'gen_random_uuid()'), 'NEW.roi_percentage', '12'), 'OLD.roi_percentage', '10');
  ELSE
    s := substring(d from '(INSERT INTO public\.portfolio_rate_approvals[^;]*?ON CONFLICT[^;]*?RETURNING portfolio_id)');
    s := replace(replace(replace(s, 'v_todo_rates', 'ARRAY[15]::numeric[]'), 'v_todo_in_force', 'ARRAY[10]::numeric[]'), 'v_todo', 'ARRAY[gen_random_uuid()]');
  END IF;
  RETURN s;
END $$;
SELECT public.t_check('M (round 6, a) portfolio_rate_approvals_one_open: unique on portfolio_id where pending, or approved and not applied; valid; next to one_pending and one_scheduled',
  (SELECT string_agg(c.relname || '=' || i.indisunique || '|' || i.indisvalid || '|' || COALESCE(pg_get_expr(i.indpred, i.indrelid), '-'), ' ; ' ORDER BY c.relname)
     FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
    WHERE i.indrelid = 'public.portfolio_rate_approvals'::regclass AND c.relname LIKE 'portfolio_rate_approvals_one_%'),
  'portfolio_rate_approvals_one_open=true|true|((status = ''pending''::text) OR ((status = ''approved''::text) AND (applied_at IS NULL))) ; '
  || 'portfolio_rate_approvals_one_pending=true|true|(status = ''pending''::text) ; '
  || 'portfolio_rate_approvals_one_scheduled=true|true|((status = ''approved''::text) AND (applied_at IS NULL))');
SELECT public.t_check('M (round 6, a) each function has exactly one ON CONFLICT, on (portfolio_id) WHERE status = ''pending'' DO NOTHING; EXPLAIN of that shipped statement: arbiters one_pending AND one_open (gate | late link)',
  (SELECT string_agg((length(c) - length(replace(c, 'ON CONFLICT', ''))) / length('ON CONFLICT') || ':'
                     || (position('ON CONFLICT (portfolio_id) WHERE status = ''pending'' DO NOTHING' in c) > 0), ',' ORDER BY f)
     FROM (SELECT f, regexp_replace(pg_get_functiondef(f::regprocedure), '--[^\n]*', '', 'g') AS c
             FROM unnest(ARRAY['public.enforce_partner_return_rate_policy()', 'public.partner_note_linked_late()']) f) x) || ' / '
  || public.t_arbiters(public.t_conflict_stmt('public.enforce_partner_return_rate_policy()')) || ' | '
  || public.t_arbiters(public.t_conflict_stmt('public.partner_note_linked_late()')),
  '1:true,1:true / portfolio_rate_approvals_one_pending,portfolio_rate_approvals_one_open | portfolio_rate_approvals_one_pending,portfolio_rate_approvals_one_open');
SELECT public.t_check('M (round 6, a) direct writes (rolled back): a pending request beside a scheduled one is refused by one_open in either order; beside an APPLIED approval it is allowed',
  public.t_err($q$DO $d$ DECLARE v uuid := gen_random_uuid(); BEGIN
      INSERT INTO public.portfolio_rate_approvals (portfolio_id, requested_rate, rate_in_force, standard_rate, source, status, decided_at) VALUES (v, 13, 10, 10, 'rate_change', 'approved', now());
      INSERT INTO public.portfolio_rate_approvals (portfolio_id, requested_rate, rate_in_force, standard_rate, source) VALUES (v, 12, 10, 10, 'rate_change'); END $d$$q$) || ' | '
  || public.t_err($q$DO $d$ DECLARE v uuid := gen_random_uuid(); BEGIN
      INSERT INTO public.portfolio_rate_approvals (portfolio_id, requested_rate, rate_in_force, standard_rate, source) VALUES (v, 12, 10, 10, 'rate_change');
      INSERT INTO public.portfolio_rate_approvals (portfolio_id, requested_rate, rate_in_force, standard_rate, source, status, decided_at) VALUES (v, 13, 10, 10, 'rate_change', 'approved', now()); END $d$$q$) || ' | '
  || public.t_err($q$DO $d$ DECLARE v uuid := gen_random_uuid(); BEGIN
      INSERT INTO public.portfolio_rate_approvals (portfolio_id, requested_rate, rate_in_force, standard_rate, source, status, decided_at, applied_at) VALUES (v, 13, 10, 10, 'rate_change', 'approved', now(), now());
      INSERT INTO public.portfolio_rate_approvals (portfolio_id, requested_rate, rate_in_force, standard_rate, source) VALUES (v, 12, 10, 10, 'rate_change'); END $d$$q$),
  '23505: duplicate key value violates unique constraint "portfolio_rate_approvals_one_open" | 23505: duplicate key value violates unique constraint "portfolio_rate_approvals_one_open" | ok');
SELECT public.t_check('M partner_return_note_windows gained partner_user_id and agent_id (uuid, nullable; ADD COLUMN IF NOT EXISTS ran twice); no window row before the switch-on',
  (SELECT string_agg(column_name || ':' || data_type || ':' || is_nullable, ',' ORDER BY ordinal_position)
     FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'partner_return_note_windows'
      AND column_name IN ('partner_user_id', 'agent_id')) || '/' || (SELECT count(*) FROM public.partner_return_note_windows),
  'partner_user_id:uuid:YES,agent_id:uuid:YES/0');
SELECT public.t_check('M partner_rate_lock(uuid[]) and _promissory_note_rate_json(promissory_notes,uuid): owner only (no PUBLIC, anon, authenticated, service_role)',
  (SELECT string_agg(p.oid::regprocedure::text || '=' || COALESCE(p.proacl::text, 'default'), ' ; ' ORDER BY p.proname) FROM pg_proc p
    WHERE p.oid IN ('public.partner_rate_lock(uuid[])'::regprocedure, 'public._promissory_note_rate_json(public.promissory_notes,uuid)'::regprocedure)) || '/'
  || (SELECT bool_or(has_function_privilege(r, f, 'EXECUTE'))::text
        FROM unnest(ARRAY['anon', 'authenticated', 'service_role']) r,
             unnest(ARRAY['public.partner_rate_lock(uuid[])', 'public._promissory_note_rate_json(public.promissory_notes,uuid)']) f),
  '_promissory_note_rate_json(promissory_notes,uuid)={postgres=X/postgres} ; partner_rate_lock(uuid[])={postgres=X/postgres}/false');
SELECT public.t_check('M partner_rate_lock is SECURITY INVOKER plpgsql with a pinned search_path; _promissory_note_rate_json is STABLE sql, not SECURITY DEFINER',
  (SELECT string_agg(p.proname || ':' || l.lanname || ':' || p.prosecdef || ':' || p.provolatile::text || ':' || COALESCE(array_to_string(p.proconfig, ','), '-'), ' ' ORDER BY p.proname)
     FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang
    WHERE p.oid IN ('public.partner_rate_lock(uuid[])'::regprocedure, 'public._promissory_note_rate_json(public.promissory_notes,uuid)'::regprocedure)),
  '_promissory_note_rate_json:sql:false:s:search_path=public, pg_temp partner_rate_lock:plpgsql:false:v:search_path=public, pg_temp');
SELECT public.t_check('M partner_rate_lock: NULLs and duplicates collapse, buckets taken once each (rolled back)',
  public.t_err('SELECT public.partner_rate_lock(NULL::uuid[])') || '/'
  || public.t_err(format('DO $d$ BEGIN PERFORM public.partner_rate_lock(ARRAY[%L, %L, NULL, %L]::uuid[]);
                            IF public.t_rate_buckets_held() <> ARRAY(SELECT DISTINCT b FROM unnest(ARRAY[%s, %s]) b ORDER BY 1) THEN
                              RAISE EXCEPTION ''held %%'', public.t_rate_buckets_held(); END IF; END $d$',
                         public.pid('lockp'), public.pid('lockp'), public.pid('someone_else'),
                         public.t_rate_bucket('lockp'), public.t_rate_bucket('someone_else'))), 'ok/ok');
SELECT public.t_check('M backfill with no cut-off yet (apply #2): a funding with no stored rate funded just now is still legacy 15 at its funded_at',
  (SELECT trim_scale(rate) || '|' || basis || '|' || (decided_at = (SELECT funded_at FROM public.rent_requests WHERE id = public.pid('rr_nocut')))
     FROM public.rent_facilitation_reward_rates WHERE rent_request_id = public.pid('rr_nocut')), '15|legacy|true');

-- ===========================================================================
-- OFF. Switch off: every path gives exactly what production gives today. The people set up here
--      are the cut-off population used later.
-- ===========================================================================
DO $$ BEGIN
  PERFORM public.t2_person(x) FROM unnest(ARRAY['off_new','off_ex20','ex15','ex20','mix','returner','emp','emp_off','noteP',
                                                 'p_new','leaver','ctxnew','tu','rc1','rc2','rc3','ra','rb','rd','sup_new']) x;
  PERFORM public.t2_person('signer', 'signed');
  INSERT INTO public.hr_staff (user_id, active) VALUES (public.pid('emp'), true);
  INSERT INTO public._t_ids VALUES
    ('off_ex20_p', public.t2_port('off_ex20', 20)), ('ex15_p', public.t2_port('ex15', 15)), ('ex20_p', public.t2_port('ex20', 20)),
    ('mix15_p', public.t2_port('mix', 15)), ('mix20_p', public.t2_port('mix', 20)), ('returner_p', public.t2_port('returner', 20));
  -- A note linked to its person before the cut-off (window open at the cut-off).
  INSERT INTO public.promissory_notes (agent_id, partner_user_id, partner_name, whatsapp_number, amount, status, fulfilment_due_on, recorded_on)
  VALUES (public.pid('agent1'), public.pid('noteP'), 'Note P', '0779999001', 1000000, 'activated', current_date - 5, current_date - 20);
  -- Notes written before the cut-off for people not known yet (linked late, after the cut-off).
  INSERT INTO public.promissory_notes (agent_id, partner_user_id, partner_name, whatsapp_number, amount, status, fulfilment_due_on, recorded_on)
  VALUES (public.pid('agent1'), NULL, 'Late One',   '0771000001', 1000000, 'pending', current_date + 5, current_date - 3),
         (public.pid('agent1'), NULL, 'Late Two a', '0771000002', 500000,  'pending', current_date + 5, current_date - 3),
         (public.pid('agent1'), NULL, 'Late Two b', '0771000002', 700000,  'pending', current_date + 9, current_date - 3),
         (public.pid('agent1'), NULL, 'Late Three', '0771000003', 500000,  'pending', current_date + 5, current_date - 3),
         (public.pid('agent1'), NULL, 'Late Four',  '0771000004', 500000,  'pending', current_date + 5, current_date - 3),
         (public.pid('agent1'), NULL, 'Late Race',  '0771000009', 500000,  'pending', current_date + 5, current_date - 3),
         (public.pid('agent1'), NULL, 'Late Lock',  '0771000010', 500000,  'pending', current_date + 5, current_date - 3),
         (public.pid('agent1'), NULL, 'Late Miss',  '0771000011', 500000,  'pending', current_date + 5, current_date - 3),
         (public.pid('agent1'), NULL, 'Late Miss2', '0771000012', 500000,  'pending', current_date + 5, current_date - 3),
         (public.pid('agent1'), NULL, 'Late Once',  '0771000013', 500000,  'pending', current_date + 5, current_date - 3),
         (public.pid('agent1'), NULL, 'Late Sched', '0771000014', 500000,  'pending', current_date + 5, current_date - 3);
END $$;
SELECT public.t_vset('off_t0', clock_timestamp()::text);
SELECT public.t_check('OFF late notes stayed unlinked at insert (no profile has their phone yet)',
  (SELECT count(*)::text FROM public.promissory_notes WHERE whatsapp_number LIKE '077100000%' AND partner_user_id IS NULL), '6');

-- Every creation path, for a new person and for an existing 20% partner: 15, basis switch_off.
SELECT format($q$SELECT public.t_check(%L, public.t2_fam(public.t2_%s(%L)), %L)$q$,
              'OFF ' || w.who || ' via ' || p.path, p.path, w.who, '15|switch_off|e15|' || p.kids || '|req:0|ret:' || p.ret)
  FROM (VALUES ('off_new'), ('off_ex20')) w(who)
  CROSS JOIN (VALUES (1, 'fcpp', 'c:-|l:-|h:-', '15'), (2, 'psm', 'c:15|l:15|h:-', '15'), (3, 'psh4', 'c:15|l:-|h:15', '15'),
                     (4, 'psh3', 'c:15|l:-|h:15', '15'), (5, 'cpp', 'c:-|l:-|h:-', '-'), (6, 'cs', 'c:-|l:-|h:-', '15')) p(o, path, kids, ret)
 ORDER BY w.who, p.o \gexec
SELECT public.t_check('OFF create_pending_portfolio typed 20 -> 20 typed_switch_off, no CFO request',
  public.t2_fam(public.t2_cpp('off_new', 20)), '20|typed_switch_off|e20|c:-|l:-|h:-|req:0|ret:-');
SELECT public.t_check('OFF get_countersign_summary -> 15 (new and existing 20)', public.t2_sum('off_new') || '/' || public.t2_sum('off_ex20'), '15/15');
SELECT public.t_check('OFF payroll -> 20 typed_switch_off, no CFO request', public.t2_fam(public.t2_pay('emp_off')),
  '20|typed_switch_off|e20|c:-|l:-|h:-|req:0|ret:20');
SELECT public.t_check('OFF payroll notification quotes the stored 20 exactly (''earning 20% per month.'', no 20.00)',
  (SELECT (position('earning 20% per month.' in message) > 0 AND position('.00' in message) = 0)::text
     FROM public.notifications WHERE user_id = public.pid('emp_off') ORDER BY created_at DESC LIMIT 1), 'true');
SELECT public.t_check('OFF every rate stored since the switch-off section began prints without trailing zeros (portfolios, commitments, lines, houses)',
  regexp_replace(public.t2_raw_since(public.t_v('off_t0')::timestamptz), '/[0-9]+', '', 'g') || ' / '
  || (public.t2_raw_since(public.t_v('off_t0')::timestamptz) !~ '/0( |$)'), 'p:0 c:0 l:0 h:0 / true');
SELECT public.t_check('OFF pay_partner_self_cycles-style wallet text from the stored commitment rate: ''15% monthly returns ...''',
  public.t2_cycle_texts(public.t_v('off_t0')::timestamptz), '15% monthly returns on self-managed funding');
SELECT public.t_as('off_ex20') IS NULL AS x \gset
SELECT public.t_check('OFF partner_quote_rate public/me = 15/15',
  trim_scale(public.partner_quote_rate('public')) || '/' || trim_scale(public.partner_quote_rate('me')), '15/15');
-- Listing and summary: identical to production's 15% figures.
DO $$ BEGIN PERFORM public.t2_house(x) FROM unnest(ARRAY[180000, 250000, 333333, 75000, 1000001]) x; END $$;
SELECT public.t_as('agent1') IS NULL AS x \gset
SELECT public.t_check('OFF listing: returns_rate_pct 15 and every house = round(rent * 0.15), x12 for the year',
  (SELECT (r ->> 'returns_rate_pct') || '/' || bool_and((h ->> 'partner_monthly_return')::numeric = round((h ->> 'monthly_rent')::numeric * 0.15)
                                                  AND (h ->> 'partner_annual_return')::numeric = round((h ->> 'monthly_rent')::numeric * 0.15 * 12))
                                       || '/' || (count(*) > 0)
     FROM (SELECT public.agent_list_empty_house_opportunities(p_limit => 100) r) s, jsonb_array_elements(r -> 'houses') h GROUP BY r ->> 'returns_rate_pct'),
  '15/true/true');
SELECT public.t_check('OFF summary equals production''s 15% summary (plus returns_rate_pct)',
  ((public.empty_house_opportunity_summary() - 'returns_rate_pct') = public._t_old_summary())::text
  || '/' || (public.empty_house_opportunity_summary() ->> 'returns_rate_pct'), 'true/15');
-- Supporter pool card: same numbers as production's fixed 15%.
INSERT INTO public.general_ledger (amount, direction, category, user_id, source_table, transaction_date) VALUES
  (3000000, 'cash_in', 'supporter_rent_fund', public.pid('pool_a'), 'test', now() - interval '20 days'),
  (1234567, 'cash_in', 'supporter_rent_fund', public.pid('ex20'),   'test', now() - interval '10 days'),
  (800000,  'cash_out', 'pool_rent_deployment', NULL, 'test', now() - interval '5 days'),
  (250001,  'cash_out', 'supporter_capital_return', public.pid('pool_a'), 'test', now() - interval '3 days');
SELECT public.t_as(NULL) IS NULL AS x \gset
SELECT public.t_check('OFF supporter pool stats equal production''s 15% formula (plus the new key obligationRatePct)',
  ((public.get_supporter_pool_stats()::jsonb - 'obligationRatePct') = public._t_old_pool_stats()::jsonb)::text, 'true');
SELECT public.t_check('OFF pool card obligationRatePct prints as 15 (trim_scale, never 15.00)',
  public.get_supporter_pool_stats()::jsonb ->> 'obligationRatePct', '15');
-- Promissory notes while off: 15 legacy; projections from the stamp.
SELECT public.t_as('agent1') IS NULL AS x \gset
SELECT public.t_vset('off_note_res', public.agent_create_promissory_note('{"partner_name":"Off Note","whatsapp_number":"0772555001","amount":1000000}'::jsonb)::text);
SELECT public.t_check('OFF agent_create_promissory_note (unlinked) -> stored 15 legacy; response prints 15 (note and top level, never 15.00), monthly/annual from 15, no return_rate_basis',
  (SELECT (r -> 'note' ->> 'return_rate') || '/' || (r ->> 'return_rate') || '/' || (r -> 'note' ? 'return_rate_basis') || '/'
          || (SELECT trim_scale(n.return_rate) || '|' || n.return_rate_basis FROM public.promissory_notes n WHERE n.id = (r -> 'note' ->> 'id')::uuid)
          || '/' || (r ->> 'monthly_return') || '/' || (r ->> 'annual_return') || '/' || (r -> 'note' ->> 'partner_user_id' IS NULL)
     FROM (SELECT public.t_v('off_note_res')::jsonb r) s),
  '15/15/false/15|legacy/150000/1800000/true');
-- A note for a phone that belongs to a known person is linked to them at insert. Round 3 hid that person's rate from the
-- calling agent; Phase 6 F3 (owner rule: switch never on = production) shows it for a legacy note (every note while the
-- switch is off) and for an unlinked 'new' note, as production does; only a person-stamped note hides it (Phase 4 tests).
SELECT public.t2_person('off_known', 'countersigned', '0772555030') IS NOT NULL AS x \gset
SELECT public.t_vset('off_known_res', public.agent_create_promissory_note('{"partner_name":"Off Known","whatsapp_number":"0772555030","amount":1000000}'::jsonb)::text);
SELECT public.t_check('OFF note for a known phone (linked to someone else at insert; Phase 6 F3: switch never on = production): the answer shows note.partner_user_id, return_rate (15) and the monthly/annual figures as production does, no return_rate_basis; the stored note IS linked to off_known; stored 15 legacy',
  (SELECT public.t_note_link(r, 'off_known') || '/' || (r -> 'note' ? 'return_rate') || '/' || (r -> 'note' ? 'return_rate_basis') || '/'
          || (r ? 'return_rate' AND r ? 'monthly_return' AND r ? 'annual_return') || '/'
          || COALESCE(jsonb_typeof(r -> 'return_rate') || ',' || jsonb_typeof(r -> 'monthly_return') || ',' || jsonb_typeof(r -> 'annual_return'), 'missing') || '/'
          || (SELECT trim_scale(n.return_rate) || '|' || n.return_rate_basis FROM public.promissory_notes n WHERE n.id = (r -> 'note' ->> 'id')::uuid)
          || '/' || (r ->> 'support_mode') || '|' || (r ->> 'attached_count')
     FROM (SELECT public.t_v('off_known_res')::jsonb r) s),
  'true|true/true/false/true/number,number,number/15|legacy/existing_support|0');
SELECT public.t_check('OFF ... the pledge notice for that note still carries the real rate and figures (15, 150,000 a month)',
  (SELECT trim_scale(return_rate) || '/' || monthly_return || '/' || annual_return FROM public.promissory_note_pledge_notices WHERE partner_name = 'Off Known'),
  '15/150000/1800000');
SELECT public.t_check('OFF pledge notice keeps the note rate',
  (SELECT trim_scale(return_rate) || '/' || monthly_return FROM public.promissory_note_pledge_notices WHERE partner_name = 'Off Note'), '15/150000');
SELECT public.t_check('OFF split booking (unlinked): 2 notes at 15 (printed 15 in the note and at top level), each for its house rent, no return_rate_basis in the response',
  (SELECT string_agg((n -> 'note' ->> 'return_rate') || '|' || (n ->> 'return_rate') || '/' || (n -> 'note' ->> 'amount') || '/' || (n -> 'note' ? 'return_rate_basis'),
                     ',' ORDER BY (n -> 'note' ->> 'amount')::numeric)
     FROM (SELECT public.agent_create_promissory_notes_split('{"partner_name":"Off Split","whatsapp_number":"0772555002"}'::jsonb,
                                                            ARRAY[public.t2_house(210000), public.t2_house(190000)]) r) s,
          jsonb_array_elements(r -> 'notes') n),
  '15|15/190000/false,15|15/210000/false');
SELECT public.t_vset('off_known_split', public.agent_create_promissory_notes_split('{"partner_name":"Off Known Split","whatsapp_number":"0772555030"}'::jsonb,
                                                                                  ARRAY[public.t2_house(170000), public.t2_house(160000)])::text);
SELECT public.t_check('OFF split booking for a known phone (off_known; Phase 6 F3: a legacy note is public, as production): the notes do NOT hide the rate / linked account (the hiding flag is false; stored linked to off_known); the figures are on the notices',
  (SELECT count(*) || '/' || bool_and(NOT (n -> 'note' ? 'return_rate') AND NOT (n -> 'note' ? 'return_rate_basis')
                                      AND jsonb_typeof(n -> 'return_rate') = 'null' AND jsonb_typeof(n -> 'monthly_return') = 'null'
                                      AND jsonb_typeof(n -> 'annual_return') = 'null'
                                      AND public.t_note_link(n, 'off_known') = 'false|true')
     FROM jsonb_array_elements(public.t_v('off_known_split')::jsonb -> 'notes') n)
  || '/' || (SELECT string_agg(trim_scale(return_rate) || '@' || monthly_return, ',' ORDER BY monthly_return)
               FROM public.promissory_note_pledge_notices WHERE partner_name = 'Off Known Split'),
  '2/false/15@24000,15@25500');
-- Round 4: a linked note's pledge and booking notices go to the linked person's PROFILE phone and email (its figures carry
-- that person's rate); an unlinked note keeps the typed contacts. The contact rule does not depend on the switch.
SELECT public.agent_create_promissory_note('{"partner_name":"Off Probe Mail","whatsapp_number":"0772555030","email":"agent1@welile.test","amount":100000}'::jsonb) IS NOT NULL AS x \gset
SELECT public.agent_create_promissory_note_for_houses('{"partner_name":"Off Probe WA","whatsapp_number":"0772555099","phone_number":"0772555030","amount":100000}'::jsonb,
                                                     ARRAY[public.t2_house(100000)]) IS NOT NULL AS x \gset
SELECT public.t_check('OFF notices (switch off, round 4): known-phone notes (typed phone, agent''s own email; agent''s number as WhatsApp + the person''s as phone) -> pledge and booking notices to off_known''s PROFILE phone/email at 15; the split too',
  public.t_notices('Off Known') || ' || ' || public.t_notices('Off Probe Mail') || ' || ' || public.t_notices('Off Probe WA') || ' || ' || public.t_notices('Off Known Split'),
  'P 0772555030 off_known@partner.test 15 | B none || P 0772555030 off_known@partner.test 15 | B none || '
  || 'P 0772555030 off_known@partner.test 15 | B booked 0772555030 off_known@partner.test 15 || '
  || 'P 0772555030 off_known@partner.test 15; P 0772555030 off_known@partner.test 15 | B booked 0772555030 off_known@partner.test 15; B booked 0772555030 off_known@partner.test 15');
SELECT public.t_check('OFF ... those notes are linked to off_known, and typed contacts stay on the note row (only the notices use the profile)',
  (SELECT string_agg(partner_name || ':' || (partner_user_id = public.pid('off_known')) || ':' || COALESCE(whatsapp_number, '-') || ',' || COALESCE(phone_number, '-') || ',' || COALESCE(email, '-'), ' ' ORDER BY partner_name)
     FROM public.promissory_notes WHERE partner_name IN ('Off Probe Mail', 'Off Probe WA')),
  'Off Probe Mail:true:0772555030,-,agent1@welile.test Off Probe WA:true:0772555099,0772555030,-');
SELECT public.t_check('OFF notices: unlinked notes keep the typed contacts (WhatsApp first) and the public 15',
  public.t_notices('Off Note') || ' || ' || public.t_notices('Off Split'),
  'P 0772555001 - 15 | B none || P 0772555002 - 15; P 0772555002 - 15 | B booked 0772555002 - 15; B booked 0772555002 - 15');
-- House notice and share text while off.
SELECT public.t_as(NULL) IS NULL AS x \gset
DO $$ DECLARE v_h uuid; BEGIN
  SELECT h.id INTO v_h FROM public.partner_supported_houses h JOIN public.investor_portfolios ip ON ip.id = h.portfolio_id
   WHERE ip.investor_id = public.pid('off_new') LIMIT 1;
  PERFORM public.enqueue_funder_house_notice('off-' || v_h, 'earning_started', public.pid('off_new'), v_h, NULL, NULL, 'Off house', 'Wakiso',
                                             1, 200000, 200000, 'Agent', now(), now());
END $$;
SELECT public.t_check('OFF house notice: about UGX 30,000 a month (15% of 200,000), rate kept on the notice',
  (SELECT n.monthly_return || '/' || trim_scale(n.return_rate) || '/' || (m.message LIKE '%about UGX 30,000 a month%')
     FROM public.funder_house_progress_notices n JOIN public.notifications m ON m.event_key = n.dedupe_key WHERE n.dedupe_key LIKE 'off-%'),
  '30000/15/true');
SELECT public.t_as('agent1') IS NULL AS x \gset
SELECT public.t_vset('off_share_house', public.t2_house(200000)::text);
SELECT public.t_check('OFF house share text quotes 15% (UGX 30,000 on 200,000)',
  (SELECT (og_description LIKE '%receive UGX 30,000 every month%')::text || '/' || created
     FROM public.get_or_create_house_share_link(public.t_v('off_share_house')::uuid)), 'true/true');
SELECT public.t_vset('off_share_code', (SELECT code FROM public.short_links WHERE resource_id = public.t_v('off_share_house')::uuid));
SELECT public.t_info('OFF 3-argument partner_support_houses called by name (pre-existing overload clash with the 4-argument one)',
  $s$SELECT public.partner_support_houses(ARRAY[gen_random_uuid()], 1, 'k')$s$);
-- Legacy rent facilitation while off.
SELECT public.t_as(NULL) IS NULL AS x \gset
UPDATE public.rent_requests SET supporter_id = public.pid('off_ex20'), status = 'funded', funded_at = now() - interval '31 days'
 WHERE id = public.pid('rr_unfunded');
SELECT public.t_check('OFF supporter set on a rent request -> stored 15 switch_off',
  (SELECT trim_scale(rate) || '|' || basis FROM public.rent_facilitation_reward_rates WHERE rent_request_id = public.pid('rr_unfunded')), '15|switch_off');
SELECT public.t_check('OFF legacy reward pays round(600,000 x 15%) = 90,000 at the stored rate; result rate prints 15 (not 15.00)',
  (SELECT (r ->> 'status') || '/' || (r ->> 'amount') || '/' || (r ->> 'rate')
     FROM (SELECT public.post_rent_facilitation_reward(public.pid('rr_legacy'), 1) r) s), 'posted/90000/15');
SELECT public.t_check('OFF reward: wallet line = exactly today''s edge text at 15 (no proxy agent); platform line says Returns, not ROI',
  (SELECT string_agg(category || '=' || description, ' | ' ORDER BY category) FROM public.general_ledger
    WHERE idempotency_key = 'rent-reward:' || public.pid('rr_legacy') || ':1'),
  'roi_expense=Platform Returns payout #1 to supporter for rent facilitation of UGX 600,000 | roi_wallet_credit=' || public.t_edge_reward_text(1, 600000));
-- A proxy-managed funding: the edge sends its own text with "(managed by ...)"; the database keeps only that suffix.
INSERT INTO public.rent_requests (id, tenant_id, landlord_id, rent_amount, status, supporter_id, funded_at)
VALUES (public.pid('rr_proxy'), gen_random_uuid(), gen_random_uuid(), 350000, 'funded', public.pid('off_new'), now() - interval '31 days'),
       (public.pid('rr_junk'), gen_random_uuid(), gen_random_uuid(), 1234567, 'funded', public.pid('off_new'), now() - interval '31 days');
-- (Each call is posted first; a check in the same statement could not see the rows the call wrote.)
SELECT public.t_vset('rew_proxy', public.post_rent_facilitation_reward(public.pid('rr_proxy'), 1, NULL, public.t_edge_reward_text(1, 350000, 'Agent Kato'))::text);
SELECT public.t_check('OFF proxy-managed reward: wallet text = exactly today''s edge text (15%, managed by Agent Kato)',
  (SELECT (r ->> 'status') || '/' || (r ->> 'amount') FROM (SELECT public.t_v('rew_proxy')::jsonb r) s)
  || '/' || ((SELECT description FROM public.general_ledger WHERE idempotency_key = 'rent-reward:' || public.pid('rr_proxy') || ':1'
               AND category = 'roi_wallet_credit') = public.t_edge_reward_text(1, 350000, 'Agent Kato')), 'posted/52500/true');
SELECT public.t_vset('rew_junk', public.post_rent_facilitation_reward(public.pid('rr_junk'), 1, NULL,
                                   '99% monthly ROI bonus (managed by Agent Kato) plus interest')::text);
SELECT public.t_check('OFF a caller text that is not a managed-by note is ignored: the wallet line is the database text only',
  (SELECT (r ->> 'status') FROM (SELECT public.t_v('rew_junk')::jsonb r) s)
  || '/' || (SELECT description FROM public.general_ledger WHERE idempotency_key = 'rent-reward:' || public.pid('rr_junk') || ':1'
               AND category = 'roi_wallet_credit'), 'posted/' || public.t_edge_reward_text(1, 1234567));
-- Houses booked through promissory notes while off (partner_supported_house_returns parity with production).
SELECT public.t2_person('hr_off', 'countersigned', '0774000001') IS NOT NULL AS x \gset
SELECT public.t_as('agent1') IS NULL AS x \gset
SELECT public.t_vset('hr_houses', ARRAY[public.t2_house(200000), public.t2_house(300000)]::text);
SELECT public.agent_create_promissory_note_for_houses('{"partner_name":"HR Off","whatsapp_number":"0774000001","amount":500000}'::jsonb,
                                                     public.t_v('hr_houses')::uuid[]) IS NOT NULL AS x \gset
UPDATE public.house_listings SET tenant_id = public.pid('hr_tenant') WHERE id = (public.t_v('hr_houses')::uuid[])[1];
INSERT INTO public.agent_landlord_payouts (tenant_id, amount, cfo_approved_at) VALUES (public.pid('hr_tenant'), 200000, now());
SELECT public.t_as('hr_off') IS NULL AS x \gset
SELECT public.t_vset('hr_off_new', public.partner_supported_house_returns()::text);
SELECT public.t_vset('hr_off_old', public._t_old_house_returns()::text);
SELECT public.t_as(NULL) IS NULL AS x \gset
-- (d) Linking a pre-cut-off note before any cut-off does nothing.
UPDATE public.profiles SET phone = '0771000004' WHERE id = public.pid('rd');
INSERT INTO public._t_ids VALUES ('rd_p', public.t2_port('rd', NULL, 'pending_ops_approval'));
SELECT public.t_vset('linked', public.link_promissory_notes_for_user(public.pid('rd'))::text);
SELECT public.t_check('OFF (d) linking before any cut-off: note linked, rate kept, nothing queued, no alert',
  public.t_v('linked') || '/'
  || (SELECT trim_scale(return_rate) || '|' || return_rate_basis FROM public.promissory_notes WHERE whatsapp_number = '0771000004') || '/'
  || (SELECT count(*) FROM public.portfolio_rate_approvals) || '/' || public.t_emails('Promissory note linked late%'), '1/15|legacy/0/0');
SELECT public.t_check('OFF nothing anywhere went to the CFO', (SELECT count(*)::text FROM public.portfolio_rate_approvals), '0');

-- Round 5 set-up, switch still off and no cut-off yet: pre-cut-off notes for the window-ownership tests (section W) and the
-- note guard as service_role (section S). Their phones (07750000xx) belong to no profile, so nothing links at insert.
-- Round 6: W8-W10 for the book-transfer tests (W(v)); wt is the agent receiving a book, wh a third person, wagent3 an
-- agent whose note is transferred away.
DO $$ BEGIN
  PERFORM public.t2_person(x) FROM unnest(ARRAY['wa','wb','wc','wd','we','wf','wg','wagent','wagent2','sx','sy','sz','wt','wh','wagent3']) x;
  INSERT INTO public.user_roles (user_id, role, enabled) VALUES (public.pid('wagent'), 'agent', true), (public.pid('wagent2'), 'agent', true),
                                                                (public.pid('wt'), 'agent', true), (public.pid('wagent3'), 'agent', true);
  INSERT INTO public.promissory_notes (agent_id, partner_user_id, partner_name, whatsapp_number, email, amount, status, fulfilment_due_on, recorded_on)
  SELECT public.pid(v.a), public.pid(v.p), v.nm, v.ph, v.em, 500000, v.st, current_date + 5, current_date - 3
    FROM (VALUES ('agent1', 'wa', 'W1 linked to wa', '0775000001', NULL, 'activated'),
                 ('agent1', NULL, 'W2 unlinked phone', '0775000002', NULL, 'pending'),
                 ('agent1', NULL, 'W3 unlinked email', '0775000003', 'w3.typed@x.test', 'pending'),
                 ('wagent', NULL, 'W4 written by wagent', '0775000004', NULL, 'pending'),
                 ('agent1', NULL, 'W5 unlinked email', '0775000005', 'w5.typed@x.test', 'pending'),
                 ('wagent2', NULL, 'W6 old snapshot', '0775000006', NULL, 'pending'),
                 ('agent1', 'wf', 'W7 old snapshot', '0775000007', NULL, 'activated'),
                 ('agent1', NULL, 'W8 transferred then claimed', '0775000008', NULL, 'pending'),
                 ('agent1', NULL, 'W9 transferred then third', '0775000009', NULL, 'pending'),
                 ('wagent3', NULL, 'W10 transferred away', '0775000010', NULL, 'pending'),
                 ('agent1', NULL, 'S1 pending unlinked', '0775000011', NULL, 'pending'),
                 ('agent1', NULL, 'S2 activated unlinked', '0775000012', NULL, 'activated'),
                 ('agent1', 'sy', 'S3 pending sy', '0775000013', NULL, 'pending'),
                 ('agent1', 'sx', 'S4 pending sx', '0775000014', NULL, 'pending'),
                 ('agent1', NULL, 'S5 pending unlinked', '0775000015', NULL, 'pending'),
                 ('agent1', NULL, 'S6 activated unlinked', '0775000016', NULL, 'activated'),
                 ('agent1', 'sy', 'S7 pending sy', '0775000017', NULL, 'pending'),
                 ('agent1', 'sx', 'S8 pending sx', '0775000018', NULL, 'pending'),
                 ('agent1', NULL, 'S9 pending unlinked', '0775000019', NULL, 'pending')) v(a, p, nm, ph, em, st);
END $$;
-- activate-promissory-note (supabase/functions/activate-promissory-note/index.ts) runs as service_role and sends one of two
-- updates through PostgREST (only the keys it sends are in the SET list; user_id comes from the request body):
--   pending branch   (lines 69-76): .update({ status: 'activated', partner_user_id: user_id }).eq('id', note.id)
--   activated branch (lines 45-50): .update({ partner_user_id: user_id }).eq('id', note.id).is('partner_user_id', null)
-- t_edge_activate runs that statement as the CALLER (set the role first): '<current_user> ok <rows>' or the error; the effect
-- is kept when it succeeds. Production's service_role bypasses RLS; the stub's does not, so _t_service_role_bypass (a
-- permissive policy for service_role) stands in for BYPASSRLS while these run and is dropped right after.
CREATE FUNCTION public.t_edge_activate(p_note text, p_user text, p_branch text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE v_id uuid := (SELECT id FROM public.promissory_notes WHERE partner_name = p_note); v_n integer;
BEGIN
  IF p_branch = 'pending' THEN
    UPDATE public.promissory_notes n SET status = b.status, partner_user_id = b.partner_user_id
      FROM json_to_record(json_build_object('status', 'activated', 'partner_user_id', public.pid(p_user))) AS b(status text, partner_user_id uuid)
     WHERE n.id = v_id;
  ELSE
    UPDATE public.promissory_notes n SET partner_user_id = b.partner_user_id
      FROM json_to_record(json_build_object('partner_user_id', public.pid(p_user))) AS b(partner_user_id uuid)
     WHERE n.id = v_id AND n.partner_user_id IS NULL;
  END IF;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN current_user || ' ok ' || v_n;
EXCEPTION WHEN others THEN
  RETURN current_user || ' ' || SQLSTATE || ': ' || SQLERRM;
END $$;
-- A note's status and who it is linked to (by test name).
CREATE FUNCTION public.t_note_state(p_note text) RETURNS text LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT n.status || '|' || COALESCE((SELECT k FROM unnest(ARRAY['wa','wb','wc','wd','we','wf','wg','wagent','wagent2','sx','sy','sz','wt','wh','wagent3']) k
                                       WHERE public.pid(k) = n.partner_user_id),
                                      CASE WHEN n.partner_user_id IS NULL THEN 'nobody' ELSE 'someone else' END)
    FROM public.promissory_notes n WHERE n.partner_name = p_note $$;
CREATE POLICY _t_service_role_bypass ON public.promissory_notes FOR ALL TO service_role USING (true) WITH CHECK (true);
SET ROLE service_role;
SELECT public.t_vset('s1', public.t_edge_activate('S1 pending unlinked', 'sx', 'pending'));
SELECT public.t_vset('s2', public.t_edge_activate('S2 activated unlinked', 'sx', 'activated'));
SELECT public.t_vset('s3', public.t_edge_activate('S3 pending sy', 'sx', 'pending'));
SELECT public.t_vset('s4', public.t_edge_activate('S4 pending sx', 'sx', 'pending'));
SELECT public.t_vset('s_rate', split_part(public.t_err($q$UPDATE public.promissory_notes SET return_rate = 20 WHERE partner_name = 'S4 pending sx'$q$), ':', 1) || '/'
  || split_part(public.t_err($q$UPDATE public.promissory_notes SET return_rate_basis = 'employee' WHERE partner_name = 'S4 pending sx'$q$), ':', 1));
RESET ROLE;
DROP POLICY _t_service_role_bypass ON public.promissory_notes;
SELECT public.t_check('S (round 5, before any cut-off) service_role = an edge function: activate-promissory-note''s pending branch links and activates an unlinked pending note (S1); the activated branch links an unlinked activated note (S2)',
  public.t_v('s1') || ' / ' || public.t_v('s2') || ' / ' || public.t_note_state('S1 pending unlinked') || ' ' || public.t_note_state('S2 activated unlinked'),
  'service_role ok 1 / service_role ok 1 / activated|sx activated|sx');
SELECT public.t_check('S (before any cut-off) service_role: the pending branch for a note linked to someone else (S3, sy) is refused, nothing changed -- a move is refused from the Phase 1 apply on, switch on or not',
  public.t_v('s3') || ' / ' || public.t_note_state('S3 pending sy'), 'service_role 42501: A promissory note cannot be moved to another partner / pending|sy');
SELECT public.t_check('S (before any cut-off) service_role: the pending branch for a note already linked to the opener (S4, sx) activates it',
  public.t_v('s4') || ' / ' || public.t_note_state('S4 pending sx'), 'service_role ok 1 / activated|sx');
SELECT public.t_check('S (before any cut-off) service_role cannot change a note''s rate or its basis (42501)', public.t_v('s_rate'), '42501/42501');

-- ===========================================================================
-- CUT. The CEO turns the switch on (database-owner session; Phase 2 made it possible).
-- ===========================================================================
SELECT public.t_raises('CUT switch-on refused while release_ready is false (Phase 2 alone does not make it ready)',
  $s$SELECT public.set_partner_return_policy(true, NULL, 'phase 2 test')$s$, 'Partner Returns cannot be turned on yet: the release (creation paths, agreements, edge functions and screens using each person''s rate) is not complete');
-- The release migration (Phase 7) sets release_ready; here a database-owner session stands in for it.
SELECT public.t_vset('mails_before', public.t_emails('Partner Returns settings changed')::text);
UPDATE public.partner_return_policy SET release_ready = true;
SELECT public.t_check('CUT release_ready set (stand-in for the Phase 7 release): audited once and e-mailed to the CEO and CFO',
  (SELECT count(*) FROM public.audit_logs WHERE action_type = 'partner_return_policy_settings_changed'
      AND (new_values ->> 'release_ready')::boolean AND NOT (old_values ->> 'release_ready')::boolean) || '/'
  || (public.t_emails('Partner Returns settings changed') - public.t_v('mails_before')::int), '1/2');
-- Ready, but a check fails: still refused, naming the failing checks (sorted).
ALTER TABLE public.promissory_notes DISABLE TRIGGER trg_zz_partner_note_linked_late;
SELECT public.t_raises('CUT ready, but a Phase 2 trigger is disabled: switch-on refused naming phase2_triggers_enabled',
  $s$SELECT public.set_partner_return_policy(true, NULL, 'phase 2 test')$s$,
  'Partner Returns cannot be turned on: these checks fail: phase2_triggers_enabled (see assert_partner_return_policy_intact())');
UPDATE cron.job SET active = false WHERE jobname = 'partner-rate-drift-check';
SELECT public.t_raises('CUT ready, a Phase 2 trigger disabled AND the drift job paused: refused naming both',
  $s$SELECT public.set_partner_return_policy(true, NULL, 'phase 2 test')$s$,
  'Partner Returns cannot be turned on: these checks fail: cron_jobs_scheduled, phase2_triggers_enabled (see assert_partner_return_policy_intact())');
ALTER TABLE public.promissory_notes ENABLE TRIGGER trg_zz_partner_note_linked_late;
SELECT public.t_raises('CUT ready, only the drift job paused: refused naming cron_jobs_scheduled',
  $s$UPDATE public.partner_return_policy SET enabled = true$s$,
  'Partner Returns cannot be turned on: these checks fail: cron_jobs_scheduled (see assert_partner_return_policy_intact())');
UPDATE cron.job SET active = true WHERE jobname = 'partner-rate-drift-check';
SELECT public.t_check('CUT the refused attempts changed nothing (off, no cut-off, empty lists)',
  (SELECT enabled || '/' || COALESCE(cutoff_at::text, 'none') FROM public.partner_return_policy) || '/'
  || (SELECT count(*) FROM public.partner_return_cohort) || '/' || (SELECT count(*) FROM public.partner_return_note_windows), 'false/none/0/0');
SELECT public.t_check('CUT switch-on succeeds once release_ready is set and every check passes', (public.set_partner_return_policy(true, NULL, 'phase 2 test') ->> 'changed'), 'true');
SELECT public.t_check('CUT assert all 17 ok with the switch on', (SELECT COALESCE(string_agg(check_name, ',') FILTER (WHERE NOT ok), 'all ok') FROM public.assert_partner_return_policy_intact()), 'all ok');
-- The returner redeems everything after the cut-off; the employee leaver is enrolled inactive.
UPDATE public.investor_portfolios SET status = 'redeemed' WHERE investor_id = public.pid('returner');
SELECT public.t_check('CUT personas per the rule',
  (SELECT string_agg(x || '=' || public.t_rate(x), ' ' ORDER BY x) FROM unnest(ARRAY['p_new','ex15','ex20','mix','emp','signer','noteP','returner']) x),
  'emp=20|employee ex15=15|existing_partner ex20=20|existing_partner mix=20|existing_partner noteP=15|promissory_note p_new=10|new returner=10|new signer=15|signed_agreement');

-- ===========================================================================
-- ON. Every persona through every creation path: stored rate = person's rate, children follow it,
--     the RPC returns it, nothing goes to the CFO.
-- ===========================================================================
SELECT format($q$SELECT public.t_check(%L, public.t2_fam(public.t2_%s(%L)), %L)$q$,
              'ON ' || w.who || ' via ' || p.path, p.path, w.who,
              w.r || '|' || w.basis || '|e' || w.r || '|' || replace(p.kids, 'R', w.r) || '|req:0|ret:' || replace(p.ret, 'R', w.r))
  FROM (VALUES (1, 'p_new', '10', 'new'), (2, 'ex15', '15', 'existing_partner'), (3, 'ex20', '20', 'existing_partner'),
               (4, 'mix', '20', 'existing_partner'), (5, 'emp', '20', 'employee'), (6, 'signer', '15', 'signed_agreement'),
               (7, 'noteP', '15', 'promissory_note'), (8, 'returner', '10', 'new')) w(o, who, r, basis)
  CROSS JOIN (VALUES (1, 'fcpp', 'c:-|l:-|h:-', 'R'), (2, 'psm', 'c:R|l:R|h:-', 'R'), (3, 'psh4', 'c:R|l:-|h:R', 'R'),
                     (4, 'psh3', 'c:R|l:-|h:R', 'R'), (5, 'cpp', 'c:-|l:-|h:-', '-'), (6, 'cs', 'c:-|l:-|h:-', 'R')) p(o, path, kids, ret)
 ORDER BY w.o, p.o \gexec
SELECT public.t_check('ON get_countersign_summary shows each person''s own rate',
  (SELECT string_agg(x || '=' || public.t2_sum(x), ' ' ORDER BY x) FROM unnest(ARRAY['p_new','ex15','ex20','mix','emp','signer','noteP','returner']) x),
  'emp=20 ex15=15 ex20=20 mix=20 noteP=15 p_new=10 returner=10 signer=15');
SELECT public.t_check('ON the persona rates did not drift after all those portfolios',
  (SELECT string_agg(x || '=' || public.t_rate(x), ' ' ORDER BY x) FROM unnest(ARRAY['p_new','ex15','ex20','mix','emp','signer','noteP','returner']) x),
  'emp=20|employee ex15=15|existing_partner ex20=20|existing_partner mix=20|existing_partner noteP=15|promissory_note p_new=10|new returner=10|new signer=15|signed_agreement');
SELECT public.t_check('ON create_pending_portfolio typed 20 for a new partner -> stored 10 + CFO request 20',
  public.t2_fam(public.t2_cpp('p_new', 20)), '10|new|e10|c:-|l:-|h:-|req:1|ret:-');
SELECT public.t_check('ON create_pending_portfolio typed 20 for an existing 20 partner -> accepted, no request',
  public.t2_fam(public.t2_cpp('ex20', 20)), '20|existing_partner|e20|c:-|l:-|h:-|req:0|ret:-');
SELECT public.t2_psm('ex20') IS NOT NULL AS x \gset
SELECT public.t_check('ON psm result for ex20: monthly_return = round(400,000 x 20%) = 80,000',
  (SELECT (r ->> 'monthly_return') || '/' || (r ->> 'roi_percentage') FROM (SELECT public.t_v('last_res')::jsonb r) s), '80000/20');
SELECT public.t2_psh4('p_new') IS NOT NULL AS x \gset
SELECT public.t_check('ON houses result for a new partner: monthly_return = round(400,000 x 10%) = 40,000',
  (SELECT (r ->> 'monthly_return') || '/' || (r ->> 'roi_percentage') FROM (SELECT public.t_v('last_res')::jsonb r) s), '40000/10');

-- Payroll with the switch on.
SELECT public.t_check('ON payroll (active employee) -> 20 salary_reinvestment, no CFO request', public.t2_fam(public.t2_pay('emp')),
  '20|salary_reinvestment|e20|c:-|l:-|h:-|req:0|ret:20');
SELECT public.t_check('ON payroll (leaver''s final payslip, inactive staff) -> 20 salary_reinvestment, no CFO request',
  public.t2_fam(public.t2_pay('leaver', false)), '20|salary_reinvestment|e20|c:-|l:-|h:-|req:0|ret:20');
SELECT public.t_vset('pay2', public.hr_pay_post_staff_reinvestment(public.t2_payslip('emp'))::text);
SELECT public.t_check('ON payroll second payslip -> top-up of the same portfolio, notification quotes its stored 20',
  (SELECT (r ->> 'kind') || '/' || trim_scale((r ->> 'roi_percentage')::numeric) FROM (SELECT public.t_v('pay2')::jsonb r) s)
  || '/' || (SELECT (position('earning 20% per month.' in message) > 0 AND position('.00' in message) = 0)::text
                FROM public.notifications WHERE user_id = public.pid('emp') ORDER BY created_at DESC LIMIT 1),
  'topup/20/true');
BEGIN;
SELECT public.t2_pay('ctxnew_emp') IS NOT NULL AS x \gset
SELECT public.t_check('ON payroll context is cleared inside the same transaction', COALESCE(current_setting('app.partner_rate_context', true), '<unset>'), '');
SELECT public.t_check('ON ... a following plain insert typed 20 for a new partner in the SAME transaction is not payroll: 10 + CFO request 20',
  public.t_desc(public.t2_port('ctxnew', 20, 'pending_ops_approval')), '10|new|10|20');
COMMIT;
SELECT public.t_check('ON every rate stored since the cut-off prints without trailing zeros (portfolios, commitments, lines, houses)',
  regexp_replace(public.t2_raw_since((SELECT cutoff_at FROM public.partner_return_policy)), '/[0-9]+', '', 'g') || ' / '
  || (public.t2_raw_since((SELECT cutoff_at FROM public.partner_return_policy)) !~ '/0( |$)'), 'p:0 c:0 l:0 h:0 / true');
SELECT public.t_check('ON pay_partner_self_cycles-style wallet texts from the stored commitment rates: 10% / 15% / 20%, never 10.00',
  public.t2_cycle_texts((SELECT cutoff_at FROM public.partner_return_policy)),
  '10% monthly returns on self-managed funding | 15% monthly returns on self-managed funding | 20% monthly returns on self-managed funding');
-- The gate takes the person's rate lock (partner_rate_lock: bucket hashtext(id) & 255 of 256) before it asks the
-- rule (the late-link trigger and the reward stamp take the same one). lockp and someone_else are in different buckets.
SELECT public.t2_person('lockp') IS NOT NULL AS x \gset
BEGIN;
SELECT public.t_desc(public.t2_port('lockp', NULL, 'pending_ops_approval')) IS NOT NULL AS x \gset
SELECT public.t_holds_rate_lock('lockp') AS gate_lock, public.t_holds_rate_lock('someone_else') AS other_lock,
       (public.t_rate_buckets_held() = ARRAY[public.t_rate_bucket('lockp')]) AS gate_exact,
       (public.t_rate_bucket('lockp') <> public.t_rate_bucket('someone_else')) AS gate_differ \gset
ROLLBACK;
SELECT public.t_check('ON the gate holds the partner-rate lock of the portfolio''s person (and no one else''s) until commit',
  :'gate_lock' || '/' || :'other_lock', 't/f');
SELECT public.t_check('ON ... exactly one partner-rate bucket held (the person''s), and the other person is in a different bucket',
  :'gate_exact' || '/' || :'gate_differ', 't/t');
-- One transaction opening portfolios for 1,000 different people (the gate path, switch on): at most 256 rate locks.
BEGIN;
INSERT INTO public.investor_portfolios (investor_id, agent_id, portfolio_code, investment_amount, duration_months, portfolio_pin, status)
SELECT public.pid('gp_' || i), public.pid('agent1'), 'GP-' || i, 100000, 12, '1111', 'pending_ops_approval' FROM generate_series(1, 1000) i;
SELECT cardinality(public.t_rate_buckets_held()) AS gp_held,
       (SELECT count(DISTINCT public.t_rate_bucket('gp_' || i)) FROM generate_series(1, 1000) i) AS gp_buckets,
       (public.t_rate_buckets_held() = (SELECT array_agg(DISTINCT public.t_rate_bucket('gp_' || i) ORDER BY public.t_rate_bucket('gp_' || i)) FROM generate_series(1, 1000) i)) AS gp_same,
       public.t_advisory_held() AS gp_adv,
       (SELECT count(*) || ':' || string_agg(DISTINCT trim_scale(roi_percentage) || '|' || rate_basis, ',') FROM public.investor_portfolios WHERE portfolio_code LIKE 'GP-%') AS gp_rows \gset
ROLLBACK;
SELECT public.t_check('ON one transaction opening portfolios for 1,000 people: succeeds; holds exactly the people''s distinct buckets (<= 256), no other advisory lock',
  :'gp_rows' || '/' || (:gp_held <= 256) || '/' || :'gp_same' || '/' || (:gp_held = :gp_buckets) || '/' || (:gp_adv = :gp_held), '1000:10|new/true/t/true/true');
SELECT 'INFO  ON 1,000 gated inserts in one transaction held ' || :gp_held || ' partner-rate locks (' || :gp_adv || ' advisory locks in all)';

-- Top-up of a house commitment keeps the portfolio's stored rate even when the person's rate moved.
SELECT public.t_as('tu') IS NULL AS x \gset
SELECT public.t_vset('tu_res', public.partner_support_houses(public.t2_houses(1), 1, NULL::text, NULL::uuid)::text);
UPDATE public.partner_self_commitments SET status = 'active' WHERE id = (public.t_v('tu_res')::jsonb ->> 'commitment_id')::uuid;
INSERT INTO public.hr_staff (user_id, active) VALUES (public.pid('tu'), true);
SELECT public.t_check('TU person is now an employee (rule says 20), their house portfolio is stored at 10',
  public.t_rate('tu') || '/' || public.t_desc((public.t_v('tu_res')::jsonb ->> 'portfolio_id')::uuid), '20|employee/10|new|10|-');
SELECT public.t_check('TU the 4-argument top-up branch no longer uses MIN(uuid) (ORDER BY ... LIMIT 1)',
  (position('MIN(portfolio_id)' in pg_get_functiondef('public.partner_support_houses(uuid[],integer,text,uuid)'::regprocedure)) = 0
   AND position('ORDER BY h.portfolio_id LIMIT 1' in pg_get_functiondef('public.partner_support_houses(uuid[],integer,text,uuid)'::regprocedure)) > 0)::text, 'true');
SELECT public.t_as('tu') IS NULL AS x \gset
SELECT public.t_vset('tu_call', format('SELECT public.partner_support_houses(%L::uuid[], 1, NULL::text, %L::uuid)',
                                       public.t2_houses(1), public.t_v('tu_res')::jsonb ->> 'commitment_id'));
-- KNOWN pre-existing production defect (owner decision pending; not fixed by Phase 2): the top-up writes a second
-- funder_pending_portfolios row with source 'self_managed_house_topup', which the production source check refuses
-- (and, behind it, the one-row-per-portfolio unique index). Asserted exactly, so any change is noticed.
SELECT public.t_check('TU house top-up gets past the portfolio lookup and stops at the KNOWN pre-existing defect: source check refuses self_managed_house_topup',
  public.t_err(public.t_v('tu_call')),
  '23514: new row for relation "funder_pending_portfolios" violates check constraint "funder_pending_portfolios_source_check"');
BEGIN;
ALTER TABLE public.funder_pending_portfolios DROP CONSTRAINT funder_pending_portfolios_source_check;
SELECT public.t_err(public.t_v('tu_call')) AS tu_err2 \gset
-- Both obstacles removed (rolled back): which rate a top-up gives.
DROP INDEX public.funder_pending_portfolios_portfolio_id_key;
SELECT public.t2_ret(public.partner_support_houses(public.t2_houses(2), 1, NULL::text, (public.t_v('tu_res')::jsonb ->> 'commitment_id')::uuid)) IS NOT NULL AS x \gset
SELECT (SELECT (r ->> 'topup') || '/' || ((r ->> 'monthly_return')::numeric = round((r ->> 'committed_amount')::numeric * 0.10))
          FROM (SELECT public.t_v('last_res')::jsonb r) s) || '/' || public.t2_fam((public.t_v('tu_res')::jsonb ->> 'portfolio_id')::uuid) AS tu_got,
       (SELECT count(*) || '/' || string_agg(DISTINCT monthly_rate::text, ',')
          FROM public.partner_supported_houses WHERE commitment_id = (public.t_v('tu_res')::jsonb ->> 'commitment_id')::uuid) AS tu_houses \gset
ROLLBACK;
SELECT public.t_check('TU ... and with the source check out of the way, the KNOWN unique index funder_pending_portfolios_portfolio_id_key refuses it (rolled back)',
  :'tu_err2', '23505: duplicate key value violates unique constraint "funder_pending_portfolios_portfolio_id_key"');
SELECT public.t_check('TU (both obstacles removed, rolled back) top-up keeps the stored 10: result, monthly return, portfolio and children, no CFO request',
  :'tu_got', 'true/true/10|new|e10|c:10|l:-|h:10|req:0|ret:10');
SELECT public.t_check('TU (both obstacles removed, rolled back) 3 houses on the commitment, all stored as 10 (not 10.00)', :'tu_houses', '3/10');
SELECT public.t_check('TU constraint and index are back after the rollback',
  (SELECT count(*) FROM pg_constraint WHERE conname = 'funder_pending_portfolios_source_check') || '/'
  || (SELECT count(*) FROM pg_indexes WHERE indexname = 'funder_pending_portfolios_portfolio_id_key'), '1/1');

-- Reconcile: the rule's answer changes between partner_rate_now and the portfolio insert (a
-- test-only trigger makes the partner active staff right after the commitment row is written).
CREATE OR REPLACE FUNCTION public._t_flip() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('t.flip', true) = 'on' THEN
    INSERT INTO public.hr_staff (user_id, active) VALUES (NEW.partner_id, true) ON CONFLICT (user_id) DO UPDATE SET active = true;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER _t_flip AFTER INSERT ON public.partner_self_commitments FOR EACH ROW EXECUTE FUNCTION public._t_flip();
SELECT set_config('t.flip', 'on', false) IS NULL AS x \gset
SELECT public.t_check('RC psm: rule moved 10 -> 20 mid-call; commitment and lines follow the stored 20, result says 20',
  public.t2_fam(public.t2_psm('rc1')), '20|employee|e20|c:20|l:20|h:-|req:0|ret:20');
SELECT public.t_check('RC psm: monthly_return from the stored 20',
  (SELECT ((r ->> 'monthly_return')::numeric = round(400000 * 0.20))::text FROM (SELECT public.t_v('last_res')::jsonb r) s), 'true');
SELECT public.t_check('RC houses (4-arg): commitment and houses follow the stored 20',
  public.t2_fam(public.t2_psh4('rc2')), '20|employee|e20|c:20|l:-|h:20|req:0|ret:20');
SELECT public.t_check('RC houses (3-arg body): commitment and houses follow the stored 20',
  public.t2_fam(public.t2_psh3('rc3')), '20|employee|e20|c:20|l:-|h:20|req:0|ret:20');
SELECT set_config('t.flip', 'off', false) IS NULL AS x \gset
DROP TRIGGER _t_flip ON public.partner_self_commitments;
SELECT public.t_check('RC conformance empty after the reconcile paths', public.t2_conf(), 'empty');

-- ===========================================================================
-- Q. Who a quoted figure is for
-- ===========================================================================
SELECT public.t_as(NULL) IS NULL AS x \gset
SET ROLE anon;
SELECT public.t_check('Q anon: public -> 10', trim_scale(public.partner_quote_rate('public'))::text, '10');
SELECT public.t_check('Q anon: NULL/blank -> public 10', trim_scale(public.partner_quote_rate(NULL))::text || '/' || trim_scale(public.partner_quote_rate('  '))::text, '10/10');
SELECT public.t_raises('Q anon asking ''me'' is refused', $s$SELECT public.partner_quote_rate('me')$s$, '42501');
RESET ROLE;
SELECT public.t_as('ex20') IS NULL AS x \gset
SET ROLE authenticated;
SELECT public.t_check('Q existing 20 partner asking ''me'' (any case) -> 20', trim_scale(public.partner_quote_rate('ME'))::text, '20');
RESET ROLE;
SELECT public.t_as('agent1') IS NULL AS x \gset
SET ROLE authenticated;
SELECT public.t_raises('Q plain agent asking ''partner'' is refused', format('SELECT public.partner_quote_rate(%L, %L::uuid)', 'partner', public.pid('ex20')), '42501');
SELECT public.t_raises('Q unknown audience refused', $s$SELECT public.partner_quote_rate('everyone')$s$, '22023');
RESET ROLE;
SELECT public.t_as('pops') IS NULL AS x \gset
SET ROLE authenticated;
SELECT public.t_check('Q partner ops quoting ex20 / emp / a new person -> 20 / 20 / 10',
  trim_scale(public.partner_quote_rate('partner', public.pid('ex20'))) || '/' || trim_scale(public.partner_quote_rate('partner', public.pid('emp')))
  || '/' || trim_scale(public.partner_quote_rate('partner', public.pid('p_new'))), '20/20/10');
SELECT public.t_raises('Q partner without an id refused', $s$SELECT public.partner_quote_rate('partner', NULL)$s$, '22023');
RESET ROLE;
SELECT public.t_as('coo') IS NULL AS x \gset
SELECT public.t_check('Q COO quoting ex20 -> 20', trim_scale(public.partner_quote_rate('partner', public.pid('ex20')))::text, '20');

-- Listing and summary use the quote rate.
SELECT public.t_as('agent1') IS NULL AS x \gset
SET ROLE authenticated;
SELECT public.t_check('Q listing (agent, default audience): returns_rate_pct 10, every house = round(rent x 10%), year x12',
  (SELECT (r ->> 'returns_rate_pct') || '/' || bool_and((h ->> 'partner_monthly_return')::numeric = round((h ->> 'monthly_rent')::numeric * 0.10)
                                                  AND (h ->> 'partner_annual_return')::numeric = round((h ->> 'monthly_rent')::numeric * 0.10 * 12))
     FROM (SELECT public.agent_list_empty_house_opportunities(p_limit => 100) r) s, jsonb_array_elements(r -> 'houses') h GROUP BY r ->> 'returns_rate_pct'),
  '10/true');
SELECT public.t_check('Q listing, old call shape (12 positional arguments) still works',
  (SELECT r ->> 'returns_rate_pct' FROM (SELECT public.agent_list_empty_house_opportunities(NULL, 30, 0, NULL, false, false, NULL, NULL, NULL, NULL, NULL, NULL) r) s), '10');
SELECT public.t_raises('Q listing for a named partner as a plain agent is refused',
  format('SELECT public.agent_list_empty_house_opportunities(p_quote_for => %L, p_partner_id => %L::uuid)', 'partner', public.pid('ex20')), '42501');
SELECT public.t_vset('sum_agent', public.empty_house_opportunity_summary()::text);
RESET ROLE;
SELECT public.t_check('Q summary (agent, no arguments): returns_rate_pct 10, totals = round(rent x 10%)',
  (SELECT (s ->> 'returns_rate_pct') || '/' || ((s ->> 'monthly_return_if_all_funded')::numeric
            = (SELECT COALESCE(SUM(ROUND(COALESCE(h.monthly_rent, 0) * 0.10)), 0) FROM public.house_listings h
                WHERE h.status = 'available' AND h.tenant_id IS NULL AND NOT h.is_hidden AND h.monthly_rent > 0
                  AND NOT public.house_has_live_claim(h.id)))
     FROM (SELECT public.t_v('sum_agent')::jsonb s) x), '10/true');
SET ROLE anon;
SELECT public.t_raises('Q anon cannot call the listing or the summary',
  $s$SELECT public.agent_list_empty_house_opportunities(), public.empty_house_opportunity_summary()$s$, '42501');
RESET ROLE;
SELECT public.t_as('coo') IS NULL AS x \gset
SET ROLE authenticated;
SELECT public.t_check('Q listing for a named partner (COO, ex20) -> 20, figures from 20',
  (SELECT (r ->> 'returns_rate_pct') || '/' || bool_and((h ->> 'partner_monthly_return')::numeric = round((h ->> 'monthly_rent')::numeric * 0.20))
     FROM (SELECT public.agent_list_empty_house_opportunities(p_quote_for => 'partner', p_partner_id => public.pid('ex20')) r) s,
          jsonb_array_elements(r -> 'houses') h GROUP BY r ->> 'returns_rate_pct'), '20/true');
RESET ROLE;
SELECT public.t_as('pops') IS NULL AS x \gset
SET ROLE authenticated;
SELECT public.t_check('Q summary for a named partner (partner ops, ex20) -> 20',
  (public.empty_house_opportunity_summary('partner', public.pid('ex20')) ->> 'returns_rate_pct'), '20');
SELECT public.t_info('Q partner ops calling the listing for a named partner (the listing''s own role check)',
  format('SELECT public.agent_list_empty_house_opportunities(p_quote_for => %L, p_partner_id => %L::uuid)', 'partner', public.pid('ex20')));
RESET ROLE;
SELECT public.t_as('agent1') IS NULL AS x \gset
SELECT public.t_vset('on_share_house', public.t2_house(200000)::text);
SELECT public.t_vset('pub_plan', public.t2_plan(300000)::text);
SELECT public.t_check('Q share text quotes the public 10% (UGX 20,000 on 200,000)',
  (SELECT (og_description LIKE '%receive UGX 20,000 every month%')::text FROM public.get_or_create_house_share_link(public.t_v('on_share_house')::uuid)), 'true');
SELECT public.t_vset('on_share_code', (SELECT code FROM public.short_links WHERE resource_id = public.t_v('on_share_house')::uuid));
SELECT public.t_as(NULL) IS NULL AS x \gset
SET ROLE anon;
SELECT public.t_check('Q public offer page and public plan page (anon) quote the public 10%',
  (public.public_house_support_offer(public.t_v('on_share_code')) ->> 'monthly_return')
  || '/' || (public.public_support_plan(public.t_v('pub_plan')::uuid) ->> 'monthly_return'), '20000/30000');
RESET ROLE;
SELECT public.t_as('agent1') IS NULL AS x \gset
SELECT public.t_check('Q plan share text quotes the public 10% (UGX 30,000 on 300,000)',
  (SELECT (og_description LIKE '%earn UGX 30,000 per month%')::text FROM public.get_or_create_plan_share_link(public.t_v('pub_plan')::uuid)), 'true');
SELECT public.t_check('Q the share link made while off refreshes its text on the next share: same code, now UGX 20,000',
  (SELECT (code = public.t_v('off_share_code'))::text || '/' || created || '/' || (og_description LIKE '%receive UGX 20,000 every month%')
     FROM public.get_or_create_house_share_link(public.t_v('off_share_house')::uuid)), 'true/false/true');

-- ===========================================================================
-- N. Promissory notes: figures from the note's stamp; the split booking
-- ===========================================================================
SELECT public.t_as('agent1') IS NULL AS x \gset
SELECT public.t_vset('on_note_res', public.agent_create_promissory_note('{"partner_name":"On Note","whatsapp_number":"0772666001","amount":1000000}'::jsonb)::text);
SELECT public.t_check('N new note for an unknown partner -> stored 10 new; response prints the public 10 (note and top level, never 10.00), projections from 10, no return_rate_basis',
  (SELECT (r -> 'note' ->> 'return_rate') || '/' || (r ->> 'return_rate') || '/' || (r -> 'note' ? 'return_rate_basis') || '/'
          || (SELECT n.return_rate_basis FROM public.promissory_notes n WHERE n.id = (r -> 'note' ->> 'id')::uuid)
          || '/' || (r ->> 'monthly_return') || '/' || (r ->> 'annual_return')
     FROM (SELECT public.t_v('on_note_res')::jsonb r) s),
  '10/10/false/new/100000/1200000');
SELECT public.t_check('N pledge notice keeps 10', (SELECT trim_scale(return_rate) || '/' || monthly_return FROM public.promissory_note_pledge_notices WHERE partner_name = 'On Note'), '10/100000');
UPDATE public.profiles SET phone = '0772777020' WHERE id = public.pid('ex20');
SELECT public.t_vset('ex20_note_res', public.agent_create_promissory_note_for_houses('{"partner_name":"Ex Twenty","whatsapp_number":"0772777020","amount":200000}'::jsonb,
                                                                               ARRAY[public.t2_house(200000)])::text);
-- Round 3: a note linked at insert to someone other than the caller is stamped with THAT person's rate (20 for an existing
-- 20% partner); the calling agent must not learn it. The stored note keeps it, and the partner's notices carry it.
SELECT public.t_check('N note for houses for a known phone (ex20) links at insert, stored 20 existing_partner; the agent''s response hides it (no return_rate/basis/partner_user_id in the note, return_rate/monthly/annual null, ex20''s id nowhere in the response)',
  (SELECT public.t_note_link(r, 'ex20') || '/'
          || (SELECT trim_scale(n.return_rate) || '|' || n.return_rate_basis FROM public.promissory_notes n WHERE n.id = (r -> 'note' ->> 'id')::uuid) || '/'
          || (r -> 'note' ? 'return_rate') || '/' || (r -> 'note' ? 'return_rate_basis') || '/'
          || COALESCE(jsonb_typeof(r -> 'return_rate') || ',' || jsonb_typeof(r -> 'monthly_return') || ',' || jsonb_typeof(r -> 'annual_return'), 'missing') || '/'
          || (r ->> 'house_count') || '/' || (r ->> 'houses_monthly_rent') || '/' || (r::text ~ '"20(\.0+)?"|: 20[,}]')
          || '/' || (r::text LIKE '%' || public.pid('ex20')::text || '%')
     FROM (SELECT public.t_v('ex20_note_res')::jsonb r) s), 'false|true/20|existing_partner/false/false/null,null,null/1/200000/false/false');
SELECT public.t_check('N booking notice keeps the note rate', (SELECT trim_scale(return_rate)::text FROM public.promissory_house_booking_notices WHERE partner_name = 'Ex Twenty'), '20');
SELECT public.t_check('N ... and the pledge notice carries the real 20 and its figures (40,000 a month on 200,000)',
  (SELECT trim_scale(return_rate) || '/' || monthly_return || '/' || annual_return FROM public.promissory_note_pledge_notices WHERE partner_name = 'Ex Twenty'),
  '20/40000/480000');
-- agent_create_promissory_note for an employee's phone (emp, 20 employee): hidden from the agent.
UPDATE public.profiles SET phone = '0772777021' WHERE id = public.pid('emp');
SELECT public.t_vset('emp_note_res', public.agent_create_promissory_note('{"partner_name":"Emp Note","whatsapp_number":"0772777021","amount":300000}'::jsonb)::text);
SELECT public.t_check('N agent_create_promissory_note for an employee''s phone (emp): stored 20 employee; the response hides it (no return_rate/basis/partner_user_id, figures null)',
  (SELECT public.t_note_link(r, 'emp') || '/'
          || (SELECT trim_scale(n.return_rate) || '|' || n.return_rate_basis FROM public.promissory_notes n WHERE n.id = (r -> 'note' ->> 'id')::uuid) || '/'
          || (r -> 'note' ? 'return_rate') || '/' || (r -> 'note' ? 'return_rate_basis') || '/'
          || COALESCE(jsonb_typeof(r -> 'return_rate') || ',' || jsonb_typeof(r -> 'monthly_return') || ',' || jsonb_typeof(r -> 'annual_return'), 'missing')
     FROM (SELECT public.t_v('emp_note_res')::jsonb r) s), 'false|true/20|employee/false/false/null,null,null');
SELECT public.t_check('N ... its pledge notice carries the real 20 (60,000 a month on 300,000)',
  (SELECT trim_scale(return_rate) || '/' || monthly_return FROM public.promissory_note_pledge_notices WHERE partner_name = 'Emp Note'), '20/60000');
-- Can the agent who wrote that note read the person's rate some other way? The pledge notice and the note carry it. Round 4:
-- the stub carries production's RLS (pg_policies read 2026-11-06): promissory_notes is readable only by admin roles and the
-- linked partner; "Agents view own pledge notices" checks the note through that same RLS; booking notices are readable by the
-- linked partner and ops roles.
SELECT public.t_as('agent1') IS NULL AS x \gset
SET ROLE authenticated;
SELECT COALESCE((SELECT trim_scale(return_rate) || '/' || monthly_return FROM public.promissory_note_pledge_notices
                  WHERE note_id = (public.t_v('emp_note_res')::jsonb -> 'note' ->> 'id')::uuid), 'not visible') || ' | '
       || COALESCE((SELECT trim_scale(return_rate)::text FROM public.promissory_notes WHERE id = (public.t_v('emp_note_res')::jsonb -> 'note' ->> 'id')::uuid), 'not visible') || ' | '
       || COALESCE((SELECT trim_scale(return_rate)::text FROM public.promissory_house_booking_notices WHERE partner_name = 'Ex Twenty'), 'not visible') || ' | '
       || (SELECT count(*) FROM public.promissory_notes) || ' notes visible'
       AS pledge_seen \gset
RESET ROLE;
SELECT public.t_as('emp') IS NULL AS x \gset
SET ROLE authenticated;
SELECT (SELECT trim_scale(return_rate)::text FROM public.promissory_notes WHERE id = (public.t_v('emp_note_res')::jsonb -> 'note' ->> 'id')::uuid)
       || ' | ' || COALESCE((SELECT trim_scale(return_rate) || '/' || monthly_return FROM public.promissory_note_pledge_notices
                              WHERE note_id = (public.t_v('emp_note_res')::jsonb -> 'note' ->> 'id')::uuid), 'not visible') AS emp_seen \gset
RESET ROLE;
SELECT public.t_as('ex20') IS NULL AS x \gset
SET ROLE authenticated;
SELECT COALESCE((SELECT trim_scale(return_rate)::text FROM public.promissory_house_booking_notices WHERE partner_name = 'Ex Twenty'), 'not visible') AS ex20_seen \gset
RESET ROLE;
BEGIN;
CREATE POLICY "Agents can view own promissory notes" ON public.promissory_notes FOR SELECT TO authenticated
  USING (agent_id = (SELECT auth.uid()));
SELECT public.t_as('agent1') IS NULL AS x \gset
SET LOCAL ROLE authenticated;
SELECT COALESCE((SELECT trim_scale(return_rate) || '/' || monthly_return FROM public.promissory_note_pledge_notices
                  WHERE note_id = (public.t_v('emp_note_res')::jsonb -> 'note' ->> 'id')::uuid), 'not visible') || ' | '
       || COALESCE((SELECT trim_scale(return_rate)::text FROM public.promissory_notes WHERE id = (public.t_v('emp_note_res')::jsonb -> 'note' ->> 'id')::uuid), 'not visible')
       AS pledge_seen_old \gset
ROLLBACK;
SELECT public.t_as(NULL) IS NULL AS x \gset
SELECT public.t_check('N the agent cannot read that person''s rate from the pledge notice, the note or the booking notice either (production RLS in the stub): notice | note | booking | notes visible',
  :'pledge_seen', 'not visible | not visible | not visible | 0 notes visible');
SELECT public.t_check('N ... while the linked partner reads their own note and pledge notice (emp: 20, 60,000) and their booking notice (ex20: 20)',
  :'emp_seen' || ' / ' || :'ex20_seen', '20 | not visible / 20');
SELECT 'INFO  N ... only because promissory_notes hides the note from its agent: with "Agents can view own promissory notes" back (the rollback of 20261104244000 recreates it) the agent reads notice | note = '
       || :'pledge_seen_old';
SELECT public.t_as('agent1') IS NULL AS x \gset
SELECT public.t_vset('split_houses', ARRAY[public.t2_house(150000), public.t2_house(260000), public.t2_house(99000)]::text);
SELECT public.t_vset('notes_before', (SELECT count(*)::text FROM public.promissory_notes));
SET ROLE authenticated;
SELECT public.t_vset('split_res', public.agent_create_promissory_notes_split('{"partner_name":"Split Partner","whatsapp_number":"0772888001","email":"split@x.test"}'::jsonb,
                                                                            public.t_v('split_houses')::uuid[])::text);
RESET ROLE;
SELECT public.t_check('N split: one note per house, amount = that house''s rent, order kept, 10 new each (stored; printed 10), no return_rate_basis in any response',
  (SELECT string_agg((n -> 'note' ->> 'amount') || '@' || (n -> 'note' ->> 'return_rate') || '|' || (n ->> 'return_rate') || '/'
                     || (SELECT pn.return_rate_basis FROM public.promissory_notes pn WHERE pn.id = (n -> 'note' ->> 'id')::uuid) || '/' || (n -> 'note' ? 'return_rate_basis')
                     || '/' || ((n ->> 'house_id') = (public.t_v('split_houses')::uuid[])[o]::text), ',' ORDER BY o)
     FROM jsonb_array_elements(public.t_v('split_res')::jsonb -> 'notes') WITH ORDINALITY AS e(n, o)),
  '150000@10|10/new/false/true,260000@10|10/new/false/true,99000@10|10/new/false/true');
SELECT public.t_check('N split monthly/annual per note from the public 10 (unlinked)',
  (SELECT string_agg((n ->> 'monthly_return') || '|' || (n ->> 'annual_return'), ',' ORDER BY o)
     FROM jsonb_array_elements(public.t_v('split_res')::jsonb -> 'notes') WITH ORDINALITY AS e(n, o)), '15000|180000,26000|312000,9900|118800');
SELECT public.t_check('N split totals and note_ids',
  (SELECT (r ->> 'house_count') || '/' || (r ->> 'total_amount') || '/' || jsonb_array_length(r -> 'note_ids') FROM (SELECT public.t_v('split_res')::jsonb r) s), '3/509000/3');
SELECT public.t_check('N split: 3 notes, 3 reserved house intents, 3 pledge + 3 booking notices at 10',
  ((SELECT count(*) FROM public.promissory_notes) - public.t_v('notes_before')::int) || '/'
  || (SELECT count(*) FROM public.promissory_note_house_intents WHERE house_id = ANY (public.t_v('split_houses')::uuid[]) AND status = 'reserved') || '/'
  || (SELECT count(*) || '@' || string_agg(DISTINCT trim_scale(return_rate)::text, ',') FROM public.promissory_note_pledge_notices WHERE partner_name = 'Split Partner') || '/'
  || (SELECT count(*) || '@' || string_agg(DISTINCT trim_scale(return_rate)::text, ',') FROM public.promissory_house_booking_notices WHERE partner_name = 'Split Partner'),
  '3/3/3@10/3@10');
SELECT public.t_vset('split_known_houses', ARRAY[public.t2_house(140000), public.t2_house(130000)]::text);
SET ROLE authenticated;
SELECT public.t_vset('split_known_res', public.agent_create_promissory_notes_split('{"partner_name":"Split Known","whatsapp_number":"0772777021"}'::jsonb,
                                                                                  public.t_v('split_known_houses')::uuid[])::text);
RESET ROLE;
SELECT public.t_check('N split for a known phone (emp): every note linked to emp and stored 20 employee, every response hides it (no partner_user_id either)',
  (SELECT count(*) || '/' || bool_and(public.t_note_link(n, 'emp') = 'false|true') || '/'
          || string_agg(DISTINCT (SELECT trim_scale(pn.return_rate) || '|' || pn.return_rate_basis FROM public.promissory_notes pn WHERE pn.id = (n -> 'note' ->> 'id')::uuid), ',') || '/'
          || bool_and(NOT (n -> 'note' ? 'return_rate') AND NOT (n -> 'note' ? 'return_rate_basis')
                      AND jsonb_typeof(n -> 'return_rate') = 'null' AND jsonb_typeof(n -> 'monthly_return') = 'null' AND jsonb_typeof(n -> 'annual_return') = 'null')
     FROM jsonb_array_elements(public.t_v('split_known_res')::jsonb -> 'notes') n), '2/true/20|employee/true');
-- Booking order vs returned order: houses are reserved in house-id order (no deadlock between two bookings that
-- share houses); the notes come back in the order the screen sent them.
CREATE TABLE public._t_book_log (seq bigserial PRIMARY KEY, house_id uuid);
CREATE FUNCTION public._t_book_log() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN INSERT INTO public._t_book_log (house_id) VALUES (NEW.house_id); RETURN NULL; END $$;
CREATE TRIGGER _t_book_log AFTER INSERT ON public.promissory_note_house_intents FOR EACH ROW EXECUTE FUNCTION public._t_book_log();
SELECT public.t_vset('ord_houses', (SELECT array_agg(h ORDER BY h DESC) FROM unnest(ARRAY[public.t2_house(111000), public.t2_house(222000),
                                     public.t2_house(333000), public.t2_house(444000)]) h)::text);
SET ROLE authenticated;
SELECT public.t_vset('ord_res', public.agent_create_promissory_notes_split('{"partner_name":"Split Order","whatsapp_number":"0772888011"}'::jsonb,
                                                                          public.t_v('ord_houses')::uuid[])::text);
RESET ROLE;
DROP TRIGGER _t_book_log ON public.promissory_note_house_intents;
SELECT public.t_check('N split: houses sent in descending id order are reserved in ascending id order, and the notes come back in the order sent',
  ((SELECT array_agg(house_id ORDER BY seq) FROM public._t_book_log) = (SELECT array_agg(h ORDER BY h) FROM unnest(public.t_v('ord_houses')::uuid[]) h))::text || '/'
  || ((SELECT array_agg((n ->> 'house_id')::uuid ORDER BY o) FROM jsonb_array_elements(public.t_v('ord_res')::jsonb -> 'notes') WITH ORDINALITY e(n, o))
      = public.t_v('ord_houses')::uuid[]) || '/'
  || ((SELECT array_agg(h ORDER BY h) FROM unnest(public.t_v('ord_houses')::uuid[]) h) <> public.t_v('ord_houses')::uuid[]), 'true/true/true');
SELECT public.t_check('N split: note_ids and notes in the same (sent) order',
  ((SELECT array_agg((n -> 'note' ->> 'id') ORDER BY o) FROM jsonb_array_elements(public.t_v('ord_res')::jsonb -> 'notes') WITH ORDINALITY e(n, o))
   = (SELECT array_agg(x ORDER BY o) FROM jsonb_array_elements_text(public.t_v('ord_res')::jsonb -> 'note_ids') WITH ORDINALITY y(x, o)))::text, 'true');
-- A reservation that loses the house to another booking at the last moment (the unique index ux_pnhi_house_reserved)
-- is reported as HOUSES_UNAVAILABLE (23514), whole booking undone; any other unique violation is re-raised as it is.
CREATE FUNCTION public._t_steal() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('t.steal', true) = NEW.house_id::text THEN
    PERFORM set_config('t.steal', '', true);
    INSERT INTO public.promissory_note_house_intents (note_id, house_id, agent_id, status)
    VALUES (gen_random_uuid(), NEW.house_id, NEW.agent_id, 'reserved');            -- someone else got there first
  ELSIF current_setting('t.steal', true) = 'other:' || NEW.house_id::text THEN
    RAISE EXCEPTION USING ERRCODE = 'unique_violation', CONSTRAINT = 't_some_other_key', MESSAGE = 'T_OTHER_UNIQUE';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER _t_steal BEFORE INSERT ON public.promissory_note_house_intents FOR EACH ROW EXECUTE FUNCTION public._t_steal();
SELECT public.t_vset('steal_h', ARRAY[public.t2_house(101000), public.t2_house(102000)]::text);
SELECT public.t_vset('notes_before_steal', (SELECT count(*)::text FROM public.promissory_notes));
SELECT public.t_check('N split: losing a house to a concurrent booking (ux_pnhi_house_reserved) -> HOUSES_UNAVAILABLE 23514, nothing kept',
  public.t_err(format($q$SELECT set_config('t.steal', %L, true), public.agent_create_promissory_notes_split('{"partner_name":"Steal","whatsapp_number":"0772888012"}'::jsonb, %L::uuid[])$q$,
                      (public.t_v('steal_h')::uuid[])[2], public.t_v('steal_h')))
  || '/' || ((SELECT count(*) FROM public.promissory_notes) - public.t_v('notes_before_steal')::int)
  || '/' || (SELECT count(*) FROM public.promissory_note_house_intents WHERE house_id = ANY (public.t_v('steal_h')::uuid[])),
  '23514: HOUSES_UNAVAILABLE: some selected houses were just booked by someone else. Refresh and try again./0/0');
SELECT public.t_check('N split: any other unique violation is re-raised unchanged',
  public.t_err(format($q$SELECT set_config('t.steal', %L, true), public.agent_create_promissory_notes_split('{"partner_name":"Steal","whatsapp_number":"0772888012"}'::jsonb, %L::uuid[])$q$,
                      'other:' || (public.t_v('steal_h')::uuid[])[1], public.t_v('steal_h'))), '23505: T_OTHER_UNIQUE');
DROP TRIGGER _t_steal ON public.promissory_note_house_intents;
SELECT public.t_vset('notes_before', (SELECT count(*)::text FROM public.promissory_notes));
SELECT public.t_vset('h_free', public.t2_house(120000)::text);
SELECT public.t_raises('N split with one house already booked fails whole',
  format('SELECT public.agent_create_promissory_notes_split(%L::jsonb, ARRAY[%L, %L]::uuid[])', '{"partner_name":"Split Two","whatsapp_number":"0772888002"}',
         public.t_v('h_free'), (public.t_v('split_houses')::uuid[])[2]), 'HOUSES_UNAVAILABLE%');
SELECT public.t_raises('N split with one house that is not listed fails whole',
  format('SELECT public.agent_create_promissory_notes_split(%L::jsonb, ARRAY[%L, %L]::uuid[])', '{"partner_name":"Split Two","whatsapp_number":"0772888002"}',
         public.t_v('h_free'), gen_random_uuid()), 'HOUSES_UNAVAILABLE%');
SELECT public.t_check('N ... nothing written by the failed splits (no note, the free house still free)',
  ((SELECT count(*) FROM public.promissory_notes) - public.t_v('notes_before')::int) || '/' || public.house_has_live_claim(public.t_v('h_free')::uuid), '0/false');
SELECT public.t_check('N split: duplicate ids collapse (h, h, NULL, h2 -> 2 notes)',
  (SELECT (r ->> 'house_count') || '/' || (r ->> 'total_amount') FROM (SELECT public.agent_create_promissory_notes_split('{"partner_name":"Split Dup","whatsapp_number":"0772888003"}'::jsonb,
            ARRAY[public.t_v('h_free')::uuid, public.t_v('h_free')::uuid, NULL, public.t2_house(80000)]) r) s), '2/200000');
SELECT public.t_raises('N split: 26 houses refused', format('SELECT public.agent_create_promissory_notes_split(%L::jsonb, %L::uuid[])',
  '{"partner_name":"Split Many","whatsapp_number":"0772888004"}', (SELECT array_agg(gen_random_uuid()) FROM generate_series(1, 26))), 'TOO_MANY_HOUSES%');
SELECT public.t_check('N split: 25 distinct houses accepted', (SELECT (public.agent_create_promissory_notes_split('{"partner_name":"Split 25","whatsapp_number":"0772888005"}'::jsonb,
  public.t2_houses(25, 50000)) ->> 'house_count')), '25');
SELECT public.t_raises('N split: empty list refused', $s$SELECT public.agent_create_promissory_notes_split('{"partner_name":"Split E","whatsapp_number":"0772888006"}'::jsonb, '{}'::uuid[])$s$, 'HOUSES_REQUIRED%');
SELECT public.t_as(NULL) IS NULL AS x \gset
SET ROLE anon;
SELECT public.t_raises('N split: anon cannot call it', $s$SELECT public.agent_create_promissory_notes_split('{}'::jsonb, ARRAY[gen_random_uuid()])$s$, '42501');
RESET ROLE;
SELECT public.t_as('plain') IS NULL AS x \gset
SELECT public.t_raises('N split: a signed-in user with no agent/supporter role is refused', format('SELECT public.agent_create_promissory_notes_split(%L::jsonb, ARRAY[%L]::uuid[])',
  '{"partner_name":"Plain","whatsapp_number":"0772888007"}', public.t2_house(100000)), '42501');
SELECT public.t_as('supporter1') IS NULL AS x \gset
UPDATE public.profiles SET phone = '0772999111' WHERE id = public.pid('supporter1');
SELECT public.t_check('N split by a supporter for themselves (v_self): notes linked to them, their own rate shown (new 10, printed 10) with monthly/annual',
  (SELECT string_agg(DISTINCT (n -> 'note' ->> 'partner_user_id' = public.pid('supporter1')::text) || '@' || (n -> 'note' ->> 'return_rate') || '|' || (n ->> 'return_rate')
                     || '|' || ((n ->> 'monthly_return')::numeric = round((n -> 'note' ->> 'amount')::numeric * 0.10)), ',')
     FROM (SELECT public.agent_create_promissory_notes_split('{"partner_name":"x","whatsapp_number":"0700000000"}'::jsonb, ARRAY[public.t2_house(100000), public.t2_house(110000)]) r) s,
          jsonb_array_elements(r -> 'notes') n), 'true@10|10|true');
-- A supporter who is an employee (20) booking for themselves sees their own 20.
INSERT INTO public.hr_staff (user_id, active) VALUES (public.pid('supporter1'), true) ON CONFLICT (user_id) DO UPDATE SET active = true;
SELECT public.t_vset('self_emp_res', public.agent_create_promissory_note_for_houses('{"partner_name":"x","whatsapp_number":"0700000000","amount":250000}'::jsonb,
                                                                                   ARRAY[public.t2_house(250000)])::text);
UPDATE public.hr_staff SET active = false WHERE user_id = public.pid('supporter1');
SELECT public.t_check('N note for houses by a supporter for themselves while an employee: their own 20 shown (note and top level), 50,000 / 600,000; no basis',
  (SELECT (r -> 'note' ->> 'partner_user_id' = public.pid('supporter1')::text) || '/' || (r -> 'note' ->> 'return_rate') || '/' || (r ->> 'return_rate') || '/'
          || (r ->> 'monthly_return') || '/' || (r ->> 'annual_return') || '/' || (r -> 'note' ? 'return_rate_basis')
     FROM (SELECT public.t_v('self_emp_res')::jsonb r) s), 'true/20/20/50000/600000/false');
-- Round 4: a supporter booking for themselves (v_self): the notes are linked to them, so the notices use their own profile.
SELECT public.t_check('N v_self notices: the supporter''s own profile phone/email, their own rate (two split notes at 10, the employee-time note at 20)',
  public.t_notices('Supporter One'),
  'P 0772999111 supporter1@welile.test 10; P 0772999111 supporter1@welile.test 10; P 0772999111 supporter1@welile.test 20 | '
  || 'B booked 0772999111 supporter1@welile.test 10; B booked 0772999111 supporter1@welile.test 10; B booked 0772999111 supporter1@welile.test 20');
DO $$ BEGIN
  PERFORM public.t2_person('sup_noemail', 'none', '0772999222');
  UPDATE public.profiles SET email = NULL WHERE id = public.pid('sup_noemail');
  INSERT INTO public.user_roles (user_id, role, enabled) VALUES (public.pid('sup_noemail'), 'supporter', true);
END $$;
SELECT public.t_as('sup_noemail') IS NULL AS x \gset
SELECT public.agent_create_promissory_note_for_houses('{"partner_name":"Self No Email","whatsapp_number":"0700000000","email":"typed.self@x.test","amount":90000}'::jsonb,
                                                     ARRAY[public.t2_house(90000)]) IS NOT NULL AS x \gset
SELECT public.t_check('N (round 5) v_self with no profile email: the note keeps the typed email; the notices use the person''s LOGIN email (auth.users), ahead of the typed one, and the profile phone',
  (SELECT partner_name || '|' || email || '|' || (partner_user_id = public.pid('sup_noemail')) FROM public.promissory_notes WHERE agent_id = public.pid('sup_noemail'))
  || ' / ' || public.t_notices((SELECT partner_name FROM public.promissory_notes WHERE agent_id = public.pid('sup_noemail'))),
  'Partner sup_noemail|typed.self@x.test|true / P 0772999222 sup_noemail@partner.test 10 | B booked 0772999222 sup_noemail@partner.test 10');
-- Round 5: a supporter who signed up by phone (no login email) and has no profile email books for themselves: the contacts on
-- their own note are their own, so the notices fall back to the email they typed.
DO $$ BEGIN
  PERFORM public.t2_person('sup_nologin', 'none', '0772999444');
  UPDATE auth.users SET email = NULL WHERE id = public.pid('sup_nologin');
  UPDATE public.profiles SET email = NULL WHERE id = public.pid('sup_nologin');
  INSERT INTO public.user_roles (user_id, role, enabled) VALUES (public.pid('sup_nologin'), 'supporter', true);
END $$;
SELECT public.t_as('sup_nologin') IS NULL AS x \gset
SELECT public.agent_create_promissory_note_for_houses('{"partner_name":"x","whatsapp_number":"0700000000","email":"typed.nologin@x.test","amount":70000}'::jsonb,
                                                     ARRAY[public.t2_house(70000)]) IS NOT NULL AS x \gset
SELECT public.t_check('N (round 5) v_self with no login email and no profile email: the notices fall back to the email the supporter typed on their own note (profile phone kept)',
  (SELECT email || '|' || (partner_user_id = public.pid('sup_nologin')) FROM public.promissory_notes WHERE agent_id = public.pid('sup_nologin'))
  || ' / ' || public.t_notices('Partner sup_nologin'),
  'typed.nologin@x.test|true / P 0772999444 typed.nologin@x.test 10 | B booked 0772999444 typed.nologin@x.test 10');
DO $$ BEGIN
  PERFORM public.t2_person('sup_nophone', 'none');
  INSERT INTO public.user_roles (user_id, role, enabled) VALUES (public.pid('sup_nophone'), 'supporter', true);
END $$;
SELECT public.t_as('sup_nophone') IS NULL AS x \gset
SELECT public.agent_create_promissory_note_for_houses('{"partner_name":"x","whatsapp_number":"0772999333","amount":80000}'::jsonb,
                                                     ARRAY[public.t2_house(80000)]) IS NOT NULL AS x \gset
SELECT public.t_check('N (round 5) v_self with no profile phone: the notices fall back to the supporter''s own typed WhatsApp (round 4: no phone); email from the login',
  (SELECT whatsapp_number || '|' || (partner_user_id = public.pid('sup_nophone')) FROM public.promissory_notes WHERE agent_id = public.pid('sup_nophone'))
  || ' / ' || public.t_notices('Partner sup_nophone'),
  '0772999333|true / P 0772999333 sup_nophone@partner.test 10 | B booked 0772999333 sup_nophone@partner.test 10');
SELECT public.t_as('supporter1') IS NULL AS x \gset
-- An agent typing their OWN phone: the note is linked to them, so they see their own rate (an agent who is also staff: 20).
DO $$ BEGIN
  PERFORM public.t2_person('agent_emp', 'none', '0772444001');
  INSERT INTO public.user_roles (user_id, role, enabled) VALUES (public.pid('agent_emp'), 'agent', true);
  INSERT INTO public.hr_staff (user_id, active) VALUES (public.pid('agent_emp'), true);
END $$;
SELECT public.t_as('agent_emp') IS NULL AS x \gset
SELECT public.t_vset('agent_own_res', public.agent_create_promissory_note('{"partner_name":"Agent Own","whatsapp_number":"0772444001","amount":100000}'::jsonb)::text);
SELECT public.t_vset('agent_own_h_res', public.agent_create_promissory_note_for_houses('{"partner_name":"Agent Own H","whatsapp_number":"0772444001","amount":120000}'::jsonb,
                                                                                    ARRAY[public.t2_house(120000)])::text);
SELECT public.t_check('N an agent who types their own phone sees their own rate (agent + employee = 20): note and houses RPCs, figures from 20',
  (SELECT (r -> 'note' ->> 'partner_user_id' = public.pid('agent_emp')::text) || '/' || (r -> 'note' ->> 'return_rate') || '/' || (r ->> 'return_rate') || '/'
          || (r ->> 'monthly_return') || '/' || (r ->> 'annual_return') FROM (SELECT public.t_v('agent_own_res')::jsonb r) s) || ' '
  || (SELECT (r -> 'note' ->> 'partner_user_id' = public.pid('agent_emp')::text) || '/' || (r -> 'note' ->> 'return_rate') || '/' || (r ->> 'return_rate') || '/'
          || (r ->> 'monthly_return') || '/' || (r ->> 'annual_return') FROM (SELECT public.t_v('agent_own_h_res')::jsonb r) s),
  'true/20/20/20000/240000 true/20/20/24000/288000');
SELECT public.t_as('agent1') IS NULL AS x \gset
SELECT public.t_check('N ... while another agent typing that same phone gets it hidden',
  (SELECT public.t_note_link(r, 'agent_emp') || '/' || (r -> 'note' ? 'return_rate') || '/' || jsonb_typeof(r -> 'return_rate')
     FROM (SELECT public.agent_create_promissory_note('{"partner_name":"Agent Own 2","whatsapp_number":"0772444001","amount":100000}'::jsonb) r) s), 'false|true/false/null');
-- The helper itself (round 4): for a viewer other than the linked person 'note' drops return_rate, return_rate_basis AND
-- partner_user_id (the other columns stay); for the linked person (and for an unlinked note) the id and the rate are there.
SELECT public.t_as(NULL) IS NULL AS x \gset
SELECT public.t_check('N _promissory_note_rate_json: other viewer -> no rate, basis or partner_user_id, id/amount/whatsapp kept, figures null; linked person -> partner_user_id and 20; unlinked note -> partner_user_id null key kept, its rate',
  (SELECT (j -> 'note' ?| ARRAY['return_rate', 'return_rate_basis', 'partner_user_id'])::text || '/' || (j -> 'note' ?& ARRAY['id', 'amount', 'whatsapp_number', 'agent_id'])
          || '/' || COALESCE(j ->> 'return_rate', 'null')
     FROM public.promissory_notes n, public._promissory_note_rate_json(n, public.pid('agent1')) j WHERE n.partner_name = 'Emp Note') || ' '
  || (SELECT (j -> 'note' ->> 'partner_user_id' = public.pid('emp')::text) || '/' || (j ->> 'return_rate') || '/' || (j -> 'note' ? 'return_rate_basis')
     FROM public.promissory_notes n, public._promissory_note_rate_json(n, public.pid('emp')) j WHERE n.partner_name = 'Emp Note') || ' '
  || (SELECT (j -> 'note' ? 'partner_user_id') || '|' || jsonb_typeof(j -> 'note' -> 'partner_user_id') || '/' || (j ->> 'return_rate')
     FROM public.promissory_notes n, public._promissory_note_rate_json(n, public.pid('agent1')) j WHERE n.partner_name = 'On Note'),
  'false/true/null true/20/false true|null/10');

-- Round 4: notices for notes the agent links to someone else at insert go to that person's PROFILE contacts, with their rate.
DO $$ BEGIN
  PERFORM public.t2_person('noemail', 'countersigned', '0772777050');
  UPDATE public.profiles SET email = NULL WHERE id = public.pid('noemail');
END $$;
SELECT public.t_as('agent1') IS NULL AS x \gset
SELECT public.agent_create_promissory_note('{"partner_name":"Probe Mail","whatsapp_number":"0772777021","email":"agent1@welile.test","amount":300000}'::jsonb) IS NOT NULL AS x \gset
SELECT public.agent_create_promissory_note('{"partner_name":"Probe WA","whatsapp_number":"0772777099","phone_number":"0772777021","amount":300000}'::jsonb) IS NOT NULL AS x \gset
SELECT public.agent_create_promissory_note_for_houses('{"partner_name":"Probe Houses","whatsapp_number":"0772777099","phone_number":"0772777021","email":"agent1@welile.test","amount":200000}'::jsonb,
                                                     ARRAY[public.t2_house(200000)]) IS NOT NULL AS x \gset
SELECT public.agent_create_promissory_note('{"partner_name":"Probe No Email","whatsapp_number":"0772777050","email":"agent1@welile.test","amount":300000}'::jsonb) IS NOT NULL AS x \gset
SELECT public.agent_create_promissory_note('{"partner_name":"Typed Contacts","whatsapp_number":"0772666011","phone_number":"0772666012","email":"Typed@X.test","amount":300000}'::jsonb) IS NOT NULL AS x \gset
SELECT public.t_as(NULL) IS NULL AS x \gset
SELECT public.t_check('N notices (switch on, round 4): emp''s phone + the agent''s own email; the agent''s number as WhatsApp + emp''s as phone; houses -> every pledge and booking notice to emp''s PROFILE phone/email with emp''s 20 (60,000 / 60,000 / 40,000 a month)',
  public.t_notices('Probe Mail') || ' || ' || public.t_notices('Probe WA') || ' || ' || public.t_notices('Probe Houses') || ' || '
  || (SELECT string_agg(monthly_return::text, ',' ORDER BY partner_name) FROM public.promissory_note_pledge_notices WHERE partner_name IN ('Probe Mail', 'Probe WA', 'Probe Houses'))
  || ' || ' || (SELECT (partner_user_id = public.pid('emp'))::text FROM public.promissory_house_booking_notices WHERE partner_name = 'Probe Houses'),
  'P 0772777021 emp@partner.test 20 | B none || P 0772777021 emp@partner.test 20 | B none || P 0772777021 emp@partner.test 20 | B booked 0772777021 emp@partner.test 20'
  || ' || 40000,60000,60000 || true');
SELECT public.t_check('N notices: the earlier known-phone notes too (ex20''s houses note: pledge + booking to ex20''s profile; emp''s note: to emp''s profile)',
  public.t_notices('Ex Twenty') || ' || ' || public.t_notices('Emp Note'),
  'P 0772777020 ex20@partner.test 20 | B booked 0772777020 ex20@partner.test 20 || P 0772777021 emp@partner.test 20 | B none');
SELECT public.t_check('N (round 5) notices: a linked person with no profile email -> the notice uses their LOGIN email (never the agent''s typed one), their phone, their rate',
  public.t_notices('Probe No Email') || ' / ' || (SELECT trim_scale(return_rate) || '|' || (partner_user_id = public.pid('noemail')) FROM public.promissory_notes WHERE partner_name = 'Probe No Email'),
  'P 0772777050 noemail@partner.test ' || (SELECT trim_scale(return_rate)::text FROM public.promissory_notes WHERE partner_name = 'Probe No Email') || ' | B none / '
  || (SELECT trim_scale(rate)::text FROM public.partner_rates_for(ARRAY[public.pid('noemail')]) r) || '|true');
-- Round 5: the referring agent rewrote the person's profile email to the agent's own inbox (a production policy lets the
-- referring agent edit it); a person with neither a login email nor a profile email, linked through an agent's note.
DO $$ BEGIN
  PERFORM public.t2_person('nref', 'countersigned', '0772777060');
  UPDATE public.profiles SET email = 'agent1@welile.test' WHERE id = public.pid('nref');
  PERFORM public.t2_person('nologin', 'countersigned', '0772777070');
  UPDATE auth.users SET email = NULL WHERE id = public.pid('nologin');
  UPDATE public.profiles SET email = NULL WHERE id = public.pid('nologin');
END $$;
SELECT public.t_as('agent1') IS NULL AS x \gset
SELECT public.agent_create_promissory_note('{"partner_name":"Probe Ref","whatsapp_number":"0772777060","email":"agent1@welile.test","amount":100000}'::jsonb) IS NOT NULL AS x \gset
SELECT public.agent_create_promissory_note('{"partner_name":"Probe No Login","whatsapp_number":"0772777070","email":"agent1@welile.test","amount":100000}'::jsonb) IS NOT NULL AS x \gset
SELECT public.t_as(NULL) IS NULL AS x \gset
SELECT public.t_check('N (round 5) profile email rewritten to the agent''s inbox: the notice still goes to the person''s login email (nref@partner.test), never agent1@welile.test',
  public.t_notices('Probe Ref') || ' / ' || (SELECT (partner_user_id = public.pid('nref'))::text FROM public.promissory_notes WHERE partner_name = 'Probe Ref'),
  'P 0772777060 nref@partner.test ' || (SELECT trim_scale(return_rate)::text FROM public.promissory_notes WHERE partner_name = 'Probe Ref') || ' | B none / true');
SELECT public.t_check('N (round 5) a person linked through an agent''s note with no login email and no profile email: no email on the notice; the agent''s typed email is never used (no fallback on a note someone else wrote)',
  public.t_notices('Probe No Login') || ' / ' || (SELECT (partner_user_id = public.pid('nologin'))::text FROM public.promissory_notes WHERE partner_name = 'Probe No Login'),
  'P 0772777070 - ' || (SELECT trim_scale(return_rate)::text FROM public.promissory_notes WHERE partner_name = 'Probe No Login') || ' | B none / true');
SELECT public.t_check('N notices: unlinked notes keep the typed contacts (WhatsApp before phone; email as typed, lower-cased by the RPC) and the public 10',
  public.t_notices('On Note') || ' || ' || public.t_notices('Typed Contacts') || ' || ' || public.t_notices('Split Partner'),
  'P 0772666001 - 10 | B none || P 0772666011 typed@x.test 10 | B none || '
  || 'P 0772888001 split@x.test 10; P 0772888001 split@x.test 10; P 0772888001 split@x.test 10 | '
  || 'B booked 0772888001 split@x.test 10; B booked 0772888001 split@x.test 10; B booked 0772888001 split@x.test 10');
-- Later kinds of booking notice (released, funded) are queued by production code through the same function: same contacts.
DO $$ DECLARE v_n uuid := (SELECT id FROM public.promissory_notes WHERE partner_name = 'Probe Houses'); BEGIN
  UPDATE public.promissory_note_house_intents SET status = 'released', released_at = now() WHERE note_id = v_n;
  PERFORM public.psm_queue_house_booking_notice(v_n, 'released');
END $$;
SELECT public.t_check('N a later booking notice (released) for that note also goes to emp''s profile with 20',
  (SELECT string_agg(kind || ' ' || phone || ' ' || email || ' ' || trim_scale(return_rate), '; ' ORDER BY created_at, kind)
     FROM public.promissory_house_booking_notices WHERE partner_name = 'Probe Houses'),
  'booked 0772777021 emp@partner.test 20; released 0772777021 emp@partner.test 20');
-- The helper on edge cases (as the owner): no profile, a blank profile phone, blank typed WhatsApp / email; round 5: the login
-- email, and the fallback to the typed contacts only on a note written by its own linked person.
UPDATE public.profiles SET phone = '   ' WHERE id = public.pid('noemail');
DO $$ BEGIN
  PERFORM public.t2_person('bare', 'none');                     -- no profile phone
  UPDATE auth.users SET email = NULL WHERE id = public.pid('bare');
  UPDATE public.profiles SET email = NULL WHERE id = public.pid('bare');
END $$;
SELECT public.t_check('N _promissory_note_notice_contacts edge cases (round 5): (1) linked to an id with no profile and no login -> -,-; (2) a blank profile phone, a login email -> -,login; (3) unlinked, blank WhatsApp -> the trimmed phone_number, blank email -> -; (4) written by its own linked person who has no phone and no login email -> the typed WhatsApp and email, trimmed; (5) the same person on a note someone else wrote -> -,-; (6) own note, blank WhatsApp -> the typed phone_number; (7) own note of a person with a phone and a login -> those win over the typed ones',
  (SELECT string_agg(COALESCE(c.phone, '-') || ',' || COALESCE(c.email, '-'), ' ' ORDER BY o)
     FROM unnest(ARRAY[
            jsonb_build_object('partner_user_id', gen_random_uuid(), 'agent_id', public.pid('agent1'), 'whatsapp_number', '0772000001', 'email', 'typed@x.test'),
            jsonb_build_object('partner_user_id', public.pid('noemail'), 'agent_id', public.pid('agent1'), 'whatsapp_number', '0772777050', 'email', 'typed@x.test'),
            jsonb_build_object('whatsapp_number', '   ', 'phone_number', ' 0772000002 ', 'email', '  '),
            jsonb_build_object('partner_user_id', public.pid('bare'), 'agent_id', public.pid('bare'), 'whatsapp_number', ' 0772000003 ', 'email', ' Typed.Bare@x.test '),
            jsonb_build_object('partner_user_id', public.pid('bare'), 'agent_id', public.pid('agent1'), 'whatsapp_number', '0772000003', 'email', 'typed.bare@x.test'),
            jsonb_build_object('partner_user_id', public.pid('bare'), 'agent_id', public.pid('bare'), 'whatsapp_number', '   ', 'phone_number', '0772000004', 'email', ''),
            jsonb_build_object('partner_user_id', public.pid('supporter1'), 'agent_id', public.pid('supporter1'), 'whatsapp_number', '0772000005', 'email', 'typed.s1@x.test')]) WITH ORDINALITY u(j, o),
          public._promissory_note_notice_contacts(jsonb_populate_record(NULL::public.promissory_notes, u.j)) c),
  '-,- -,noemail@partner.test 0772000002,- 0772000003,Typed.Bare@x.test -,- 0772000004,- 0772999111,supporter1@welile.test');
UPDATE public.profiles SET phone = '0772777050' WHERE id = public.pid('noemail');

-- ===========================================================================
-- L. A promissory note linked to its person only after the fact
-- ===========================================================================
SELECT public.t_as(NULL) IS NULL AS x \gset
-- (a) Notes written after the cut-off for an unknown person (basis new).
SELECT public.t_as('agent1') IS NULL AS x \gset
SELECT public.agent_create_promissory_note('{"partner_name":"Ra note","whatsapp_number":"0773000001","amount":500000}'::jsonb) IS NOT NULL AS x \gset
SELECT public.t_as(NULL) IS NULL AS x \gset
UPDATE public.profiles SET phone = '0773000001' WHERE id = public.pid('ex15');
SELECT public.t_vset('linked', public.link_promissory_notes_for_user(public.pid('ex15'))::text);
SELECT public.t_check('L(a) post-cut-off new note linked (owner side) to an existing 15 partner -> re-stamped 15 existing_partner',
  public.t_v('linked') || '/'
  || (SELECT trim_scale(return_rate) || '|' || return_rate_basis FROM public.promissory_notes WHERE whatsapp_number = '0773000001'), '1/15|existing_partner');
-- Never lowered: a note written while the new-partner rate was 12, linked to a person whose rule says 10.
SELECT (public.set_partner_return_policy(true, 12) ->> 'changed') AS x \gset
SELECT public.t_as('agent1') IS NULL AS x \gset
SELECT public.agent_create_promissory_note('{"partner_name":"Rb note","whatsapp_number":"0773000002","amount":500000}'::jsonb) IS NOT NULL AS x \gset
SELECT public.t_as(NULL) IS NULL AS x \gset
SELECT (public.set_partner_return_policy(true, 10) ->> 'changed') AS x \gset
UPDATE public.profiles SET phone = '0773000002' WHERE id = public.pid('rb');
SELECT public.t_vset('linked', public.link_promissory_notes_for_user(public.pid('rb'))::text);
SELECT public.t_check('L(a) a 12% new note linked to a person whose rule is 10 keeps 12 (never lowered)',
  public.t_v('linked') || '/'
  || (SELECT trim_scale(return_rate) || '|' || return_rate_basis FROM public.promissory_notes WHERE whatsapp_number = '0773000002'), '1/12|new');
-- Only with the switch on: a new note linked while the switch is off keeps its rate.
SELECT public.t_as('agent1') IS NULL AS x \gset
SELECT public.agent_create_promissory_note('{"partner_name":"Rc note","whatsapp_number":"0773000003","amount":500000}'::jsonb) IS NOT NULL AS x \gset
SELECT public.t_as(NULL) IS NULL AS x \gset
SELECT (public.set_partner_return_policy(false) ->> 'changed') AS x \gset
UPDATE public.profiles SET phone = '0773000003' WHERE id = public.pid('mix');
SELECT public.t_vset('linked', public.link_promissory_notes_for_user(public.pid('mix'))::text);
SELECT public.t_check('L(a) switch OFF: a 10% new note linked to a 20% partner stays 10',
  public.t_v('linked') || '/'
  || (SELECT trim_scale(return_rate) || '|' || return_rate_basis FROM public.promissory_notes WHERE whatsapp_number = '0773000003'), '1/10|new');
SELECT (public.set_partner_return_policy(true) ->> 'changed') AS x \gset

-- (b) Pre-cut-off notes linked late. Person ll1 opens portfolios after the cut-off, before the link.
DO $$ BEGIN
  PERFORM public.t2_person(x) FROM unnest(ARRAY['ll1','ll2','ll3','ll4']) x;
  INSERT INTO public._t_ids VALUES
    ('P_a', public.t2_port('ll1', NULL, 'pending_ops_approval')),     -- 10, inside the window -> request
    ('P_b', public.t2_port('ll1', 12, 'pending_ops_approval')),       -- 10 + open request 12 (lower) -> superseded by 15
    ('P_c', public.t2_port('ll1', 18, 'pending_ops_approval')),       -- 10 + open request 18 (higher) -> left alone
    ('P_e', public.t2_port('ll1', NULL, 'active')),                   -- decided outside the window (moved below)
    ('P_f', public.t2_port('ll1', NULL, 'redeemed')),                 -- not live -> nothing
    ('P_g', public.t2_port('ll1', NULL, 'awaiting_partner_details')), -- inside -> request
    ('Q_a', public.t2_port('ll2', NULL, 'active')),
    ('R3_a', public.t2_port('ll3', NULL, 'active')),
    ('R4_a', public.t2_port('ll4', NULL, 'active'));
  INSERT INTO public.hr_staff (user_id, active) VALUES (public.pid('ll1'), true);
  INSERT INTO public._t_ids VALUES ('P_d', public.t2_port('ll1', NULL, 'active'));   -- 20 employee: already above the note
  UPDATE public.hr_staff SET active = false WHERE user_id = public.pid('ll1');
  -- P_e: decided after the note window closes (stamp moved with the gate off; test only).
  ALTER TABLE public.investor_portfolios DISABLE TRIGGER trg_partner_return_rate_policy;
  UPDATE public.investor_portfolios SET rate_decided_at = (SELECT cutoff_at FROM public.partner_return_policy) + interval '60 days'
   WHERE id = public.tid('P_e');
  ALTER TABLE public.investor_portfolios ENABLE TRIGGER trg_partner_return_rate_policy;
END $$;
SELECT public.t_check('L(b) before the link: ll1 portfolios as set up',
  (SELECT string_agg(k || '=' || public.t_desc(public.tid(k)), ' ' ORDER BY k) FROM unnest(ARRAY['P_a','P_b','P_c','P_d','P_e','P_f','P_g']) k),
  'P_a=10|new|10|- P_b=10|new|10|12 P_c=10|new|10|18 P_d=20|employee|20|- P_e=10|new|10|- P_f=10|new|10|- P_g=10|new|10|-');
SELECT public.t_vset('mails_before', public.t_emails('Promissory note linked late%')::text);
UPDATE public.profiles SET phone = '0771000001' WHERE id = public.pid('ll1');
SELECT public.t_check('L(b) registration links the pre-cut-off note', public.link_promissory_notes_for_user(public.pid('ll1'))::text, '1');
SELECT public.t_check('L(b) note_late_link requests: only portfolios opened inside the window at a lower rate',
  (SELECT string_agg(k || '=' || public.t_desc(public.tid(k)), ' ' ORDER BY k) FROM unnest(ARRAY['P_a','P_b','P_c','P_d','P_e','P_f','P_g']) k),
  'P_a=10|new|10|15 P_b=10|new|10|15 P_c=10|new|10|18 P_d=20|employee|20|- P_e=10|new|10|- P_f=10|new|10|- P_g=10|new|10|15');
SELECT public.t_check('L(b) request shape: note_late_link, requested 15, in force 10, standard 15',
  (SELECT string_agg(DISTINCT source || '/' || trim_scale(requested_rate) || '/' || trim_scale(rate_in_force) || '/' || trim_scale(standard_rate), ',')
     FROM public.portfolio_rate_approvals WHERE source = 'note_late_link' AND portfolio_id IN (public.tid('P_a'), public.tid('P_b'), public.tid('P_g'))),
  'note_late_link/15/10/15');
SELECT public.t_check('L(b) the lower open request (12) was superseded with a note; the higher one (18) untouched',
  (SELECT string_agg(trim_scale(requested_rate) || ':' || status || ':' || (COALESCE(decision_note, '') LIKE '%linked late%'), ',' ORDER BY requested_at)
     FROM public.portfolio_rate_approvals WHERE portfolio_id = public.tid('P_b'))
  || ' / ' || (SELECT string_agg(trim_scale(requested_rate) || ':' || status, ',') FROM public.portfolio_rate_approvals WHERE portfolio_id = public.tid('P_c')),
  '12:superseded:true,15:pending:false / 18:pending');
SELECT public.t_check('L(b) one alert per linking statement (CEO + CFO)',
  (public.t_emails('Promissory note linked late%') - public.t_v('mails_before')::int)::text, '2');
SELECT public.t_vset('linked', public.link_promissory_notes_for_user(public.pid('ll1'))::text);
SELECT public.t_check('L(b) linking again changes nothing (already linked)', public.t_v('linked') || '/'
  || (SELECT count(*) FROM public.portfolio_rate_approvals WHERE source = 'note_late_link' AND status = 'pending'
         AND portfolio_id IN (SELECT id FROM public.investor_portfolios WHERE investor_id = public.pid('ll1'))), '0/3');
SELECT public.t_check('L(b) ll1''s next portfolio gets the note rate while the window is open', public.t_desc(public.t2_port('ll1', NULL, 'pending_ops_approval')),
  '15|promissory_note|15|-');
-- Two notes for one person in one statement: one request per portfolio (the higher note rate).
UPDATE public.profiles SET phone = '0771000002' WHERE id = public.pid('ll2');
SELECT public.t_check('L(b) two notes of one person linked in one statement -> one request for their portfolio',
  public.link_promissory_notes_for_user(public.pid('ll2')) || '/' || public.t_desc(public.tid('Q_a')), '2/10|new|10|15');
-- Two people in one owner-side statement.
SELECT public.t_vset('mails_before', public.t_emails('Promissory note linked late%')::text);
UPDATE public.promissory_notes SET partner_user_id = CASE whatsapp_number WHEN '0771000003' THEN public.pid('ll3') ELSE public.pid('ll4') END
 WHERE whatsapp_number IN ('0771000003', '0771000009') AND partner_user_id IS NULL;
SELECT public.t_check('L(b) two people linked in one statement: each portfolio queued, one alert pair naming 2 portfolios of 2 partners',
  public.t_desc(public.tid('R3_a')) || ' ' || public.t_desc(public.tid('R4_a')) || ' / '
  || (public.t_emails('Promissory note linked late%') - public.t_v('mails_before')::int) || '/'
  || (SELECT count(*) FROM public._email_outbox WHERE payload ->> 'subject' LIKE 'Promissory note linked late%' AND payload ->> 'text' LIKE '2 portfolio(s) of 2 partner(s)%'),
  '10|new|10|15 10|new|10|15 / 2/2');
SELECT public.t_vset('req_before', (SELECT count(*)::text FROM public.portfolio_rate_approvals));
UPDATE public.promissory_notes SET updated_at = now() WHERE partner_user_id IS NOT NULL;
SELECT public.t_check('L(b) ... confirmed: request count unchanged after touching every linked note',
  (SELECT count(*)::text FROM public.portfolio_rate_approvals), public.t_v('req_before'));

-- The late-link trigger takes the same per-person lock as the gate, for each person it links (rolled back).
SELECT public.t2_person('llk') IS NOT NULL AS x \gset
BEGIN;
UPDATE public.promissory_notes SET partner_user_id = public.pid('llk') WHERE whatsapp_number = '0771000010';
SELECT public.t_holds_rate_lock('llk') AS late_lock, public.t_holds_rate_lock('ll1') AS late_other,
       (public.t_rate_buckets_held() = ARRAY[public.t_rate_bucket('llk')]) AS late_exact,
       (public.t_rate_bucket('llk') <> public.t_rate_bucket('ll1')) AS late_differ \gset
ROLLBACK;
SELECT public.t_check('L the late-link trigger holds the linked person''s partner-rate lock (and no one else''s) until commit',
  :'late_lock' || '/' || :'late_other', 't/f');
SELECT public.t_check('L ... exactly one partner-rate bucket held (llk''s), ll1 is in a different bucket',
  :'late_exact' || '/' || :'late_differ', 't/t');
BEGIN;
UPDATE public.promissory_notes SET updated_at = now() WHERE partner_user_id IS NOT NULL;
SELECT public.t_holds_rate_lock('ll1') AS plain_lock, (SELECT count(*) FROM pg_locks WHERE locktype = 'advisory' AND pid = pg_backend_pid()) AS plain_locks \gset
ROLLBACK;
SELECT public.t_check('L a plain UPDATE of every linked note (links nobody) takes no partner-rate lock', :'plain_lock' || '/' || :'plain_locks', 'f/0');

-- One statement linking the notes of 5,000 and of 20,000 different people (round 2: 20,000 failed with 53200 'out of
-- shared memory'): both succeed and the transaction holds at most 256 partner-rate locks (rolled back).
-- Phase 6 F2: the late link takes the rate lock only for people whose linked note has an OPEN pre-cut-off window. The bulk
-- notes are written after the cut-off, so each test gives them a frozen window as the switch-on snapshot would have
-- (guard trigger off inside the rolled-back transaction only): open (ends in 30 days, unlinked at the cut-off, agent1).
-- The same bulk without windows, and with closed windows, must take no lock at all (below).
CREATE OR REPLACE FUNCTION public._t_bulk_windows(p_ends_on date) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE v integer;
BEGIN
  ALTER TABLE public.partner_return_note_windows DISABLE TRIGGER trg_partner_return_note_windows_guard;
  INSERT INTO public.partner_return_note_windows (note_id, return_rate, ends_on, snapshot_at, partner_user_id, agent_id)
  SELECT n.id, 15, p_ends_on, now(), NULL, n.agent_id FROM public.promissory_notes n
   WHERE n.whatsapp_number LIKE '0799%' AND n.partner_user_id IS NULL;
  GET DIAGNOSTICS v = ROW_COUNT;
  ALTER TABLE public.partner_return_note_windows ENABLE TRIGGER trg_partner_return_note_windows_guard;
  RETURN v;
END $$;
BEGIN;
INSERT INTO public.promissory_notes (agent_id, partner_user_id, partner_name, whatsapp_number, amount, status, fulfilment_due_on, recorded_on)
SELECT public.pid('agent1'), NULL, 'Bulk ' || i, '0799' || lpad(i::text, 6, '0'), 1000, 'pending', current_date + 5, current_date
  FROM generate_series(1, 5000) i;
SELECT public._t_bulk_windows(current_date + 30) AS b5_windows \gset
SELECT public.t_err($s$UPDATE public.promissory_notes n SET partner_user_id = public.pid('bulk_' || substr(n.whatsapp_number, 5))
                        WHERE n.partner_user_id IS NULL AND n.whatsapp_number LIKE '0799%'$s$) AS b5_err \gset
UPDATE public.promissory_notes n SET partner_user_id = public.pid('bulk_' || substr(n.whatsapp_number, 5))
 WHERE n.partner_user_id IS NULL AND n.whatsapp_number LIKE '0799%';
SELECT (SELECT count(*) FROM public.promissory_notes WHERE whatsapp_number LIKE '0799%' AND partner_user_id IS NOT NULL) AS b5_linked,
       cardinality(public.t_rate_buckets_held()) AS b5_held, public.t_advisory_held() AS b5_adv,
       (SELECT count(DISTINCT public.t_rate_bucket('bulk_' || lpad(i::text, 6, '0'))) FROM generate_series(1, 5000) i) AS b5_buckets \gset
ROLLBACK;
SELECT public.t_check('L one UPDATE linking 5,000 people (each with an open pre-cut-off window): succeeds, holds exactly their distinct buckets (<= 256), no other advisory lock',
  :b5_windows || '/' || :'b5_err' || '/' || :b5_linked || '/' || (:b5_held <= 256) || '/' || (:b5_held = :b5_buckets) || '/' || (:b5_adv = :b5_held), '5000/ok/5000/true/true/true');
BEGIN;
INSERT INTO public.promissory_notes (agent_id, partner_user_id, partner_name, whatsapp_number, amount, status, fulfilment_due_on, recorded_on)
SELECT public.pid('agent1'), NULL, 'Bulk ' || i, '0799' || lpad(i::text, 6, '0'), 1000, 'pending', current_date + 5, current_date
  FROM generate_series(1, 20000) i;
SELECT public._t_bulk_windows(current_date + 30) AS b20_windows \gset
SELECT clock_timestamp() AS b20_t0 \gset
UPDATE public.promissory_notes n SET partner_user_id = public.pid('bulk_' || substr(n.whatsapp_number, 5))
 WHERE n.partner_user_id IS NULL AND n.whatsapp_number LIKE '0799%';
SELECT (SELECT count(*) FROM public.promissory_notes WHERE whatsapp_number LIKE '0799%' AND partner_user_id IS NOT NULL) AS b20_linked,
       cardinality(public.t_rate_buckets_held()) AS b20_held, public.t_advisory_held() AS b20_adv,
       round(extract(epoch FROM clock_timestamp() - :'b20_t0'::timestamptz) * 1000) AS b20_ms \gset
ROLLBACK;
SELECT public.t_check('L one UPDATE linking 20,000 people: succeeds (no 53200), holds 256 partner-rate locks at most, no other advisory lock',
  :b20_windows || '/' || :b20_linked || '/' || (:b20_held <= 256) || '/' || (:b20_held > 0) || '/' || (:b20_adv = :b20_held), '20000/20000/true/true/true');
-- Phase 6 F2: the same bulk link with notes written after the cut-off (no window) or whose window has closed (ended
-- yesterday) takes no rate lock and no other advisory lock: a profile phone/email backfill no longer holds every linked
-- person's bucket (and so stalls nobody's portfolio creation) until it commits. A mix (one open window among 5,000
-- closed): exactly that person's bucket.
BEGIN;
INSERT INTO public.promissory_notes (agent_id, partner_user_id, partner_name, whatsapp_number, amount, status, fulfilment_due_on, recorded_on)
SELECT public.pid('agent1'), NULL, 'Bulk ' || i, '0799' || lpad(i::text, 6, '0'), 1000, 'pending', current_date + 5, current_date
  FROM generate_series(1, 5000) i;
UPDATE public.promissory_notes n SET partner_user_id = public.pid('bulk_' || substr(n.whatsapp_number, 5))
 WHERE n.partner_user_id IS NULL AND n.whatsapp_number LIKE '0799%';
SELECT (SELECT count(*) FROM public.promissory_notes WHERE whatsapp_number LIKE '0799%' AND partner_user_id IS NOT NULL) AS f2_post_linked,
       public.t_advisory_held() AS f2_post_adv \gset
ROLLBACK;
BEGIN;
INSERT INTO public.promissory_notes (agent_id, partner_user_id, partner_name, whatsapp_number, amount, status, fulfilment_due_on, recorded_on)
SELECT public.pid('agent1'), NULL, 'Bulk ' || i, '0799' || lpad(i::text, 6, '0'), 1000, 'pending', current_date + 5, current_date
  FROM generate_series(1, 5000) i;
SELECT public._t_bulk_windows(current_date - 1) AS f2_closed_windows \gset
UPDATE public.promissory_notes n SET partner_user_id = public.pid('bulk_' || substr(n.whatsapp_number, 5))
 WHERE n.partner_user_id IS NULL AND n.whatsapp_number LIKE '0799%' AND n.whatsapp_number <> '0799000077';
SELECT public.t_advisory_held() AS f2_closed_adv \gset
ALTER TABLE public.partner_return_note_windows DISABLE TRIGGER trg_partner_return_note_windows_guard;
UPDATE public.partner_return_note_windows SET ends_on = current_date + 30
 WHERE note_id = (SELECT id FROM public.promissory_notes WHERE whatsapp_number = '0799000077');
ALTER TABLE public.partner_return_note_windows ENABLE TRIGGER trg_partner_return_note_windows_guard;
UPDATE public.promissory_notes n SET partner_user_id = public.pid('bulk_000077') WHERE n.whatsapp_number = '0799000077';
SELECT (public.t_rate_buckets_held() = ARRAY[public.t_rate_bucket('bulk_000077')]) AS f2_one_exact, public.t_advisory_held() AS f2_one_adv \gset
ROLLBACK;
SELECT public.t_check('L (Phase 6 F2) one UPDATE linking 5,000 people by notes written after the cut-off (no window): 5,000 linked, no advisory lock at all',
  :f2_post_linked || '/' || :f2_post_adv, '5000/0');
SELECT public.t_check('L (Phase 6 F2) ... by pre-cut-off notes whose window closed yesterday: no advisory lock; then one note with an OPEN window: exactly its person''s bucket',
  :f2_closed_windows || '/' || :f2_closed_adv || '/' || :'f2_one_exact' || '/' || :f2_one_adv, '5000/0/t/1');
SELECT 'INFO  L bulk links: 5,000 people -> ' || :b5_held || ' partner-rate locks; 20,000 people -> ' || :b20_held || ' locks, '
       || :b20_ms || ' ms for the UPDATE (max_locks_per_transaction ' || current_setting('max_locks_per_transaction') || ', max_connections '
       || current_setting('max_connections') || ')';

-- A catch-up refused twice (another pending request for the same portfolio appears at the moment of each insert) is
-- counted in the alert, never dropped silently. Deterministic: a test-only BEFORE INSERT trigger opens a competing
-- pending rate_change (12) for the chosen portfolio right before the late link's own insert (t.compete: every time;
-- t.compete_once: only the first time, i.e. pass 1 refused and pass 2 succeeds, as with a staff change that commits
-- while the link waits). Round 6, t.compete_sched (once): the competing 12 is also approved by the CFO at once (scheduled,
-- not applied) before the link's insert: the in-transaction form of S8d (race R11d).
CREATE FUNCTION public._t_compete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_id uuid;
BEGIN
  IF NEW.source = 'note_late_link' AND NEW.portfolio_id::text = current_setting('t.compete_sched', true) THEN
    PERFORM set_config('t.compete_sched', '', true);
    INSERT INTO public.portfolio_rate_approvals (portfolio_id, requested_rate, rate_in_force, standard_rate, source, requested_by)
    VALUES (NEW.portfolio_id, 12, NEW.rate_in_force, NEW.rate_in_force, 'rate_change', NULL) RETURNING id INTO v_id;
    UPDATE public.portfolio_rate_approvals SET status = 'approved', decided_at = now(), decision_note = 'S8d test' WHERE id = v_id;
  END IF;
  IF NEW.source = 'note_late_link'
     AND NEW.portfolio_id::text IN (current_setting('t.compete', true), current_setting('t.compete_once', true)) THEN
    IF current_setting('t.compete_once', true) = NEW.portfolio_id::text THEN PERFORM set_config('t.compete_once', '', true); END IF;
    INSERT INTO public.portfolio_rate_approvals (portfolio_id, requested_rate, rate_in_force, standard_rate, source, requested_by)
    VALUES (NEW.portfolio_id, 12, NEW.rate_in_force, NEW.rate_in_force, 'rate_change', NULL);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER _t_compete BEFORE INSERT ON public.portfolio_rate_approvals FOR EACH ROW EXECUTE FUNCTION public._t_compete();
CREATE FUNCTION public.t_reqs(p_id uuid) RETURNS text LANGUAGE sql VOLATILE AS $$
  SELECT COALESCE(string_agg(a.source || '@' || trim_scale(a.requested_rate) || ':' || a.status, ',' ORDER BY a.requested_at, a.status DESC), '-')
    FROM public.portfolio_rate_approvals a WHERE a.portfolio_id = p_id $$;
CREATE FUNCTION public.t_last_late_mail() RETURNS text LANGUAGE sql VOLATILE AS $$
  SELECT payload ->> 'text' FROM public._email_outbox WHERE payload ->> 'subject' LIKE 'Promissory note linked late%'
   ORDER BY id DESC LIMIT 1 $$;
-- Round 4: the subjects of the alert pair just sent (CEO + CFO), distinct.
CREATE FUNCTION public.t_late_subjects(p_since bigint) RETURNS text LANGUAGE sql VOLATILE AS $$
  SELECT count(*) || ':' || string_agg(DISTINCT payload ->> 'subject', ',') FROM public._email_outbox
   WHERE payload ->> 'subject' LIKE 'Promissory note linked late%' AND id > p_since $$;
DO $$ BEGIN
  PERFORM public.t2_person(x) FROM unnest(ARRAY['lmiss1', 'lmiss2', 'lonce', 'lsched']) x;
  INSERT INTO public._t_ids VALUES
    ('S_a', public.t2_port('lsched', NULL, 'pending_ops_approval')),
    ('M_a', public.t2_port('lmiss1', NULL, 'pending_ops_approval')),
    ('M_b', public.t2_port('lmiss2', NULL, 'pending_ops_approval')),
    ('M_c', public.t2_port('lmiss2', NULL, 'active')),
    ('O_a', public.t2_port('lonce', NULL, 'pending_ops_approval'));
END $$;
-- (a) refused in both passes: nothing queued, the alert says so.
SELECT public.t_vset('mails_before', public.t_emails('Promissory note linked late%')::text);
SELECT public.t_vset('mail_id0', (SELECT COALESCE(max(id), 0)::text FROM public._email_outbox));
BEGIN;
SELECT set_config('t.compete', public.tid('M_a')::text, true) IS NOT NULL AS x \gset
UPDATE public.promissory_notes SET partner_user_id = public.pid('lmiss1') WHERE whatsapp_number = '0771000011';
COMMIT;
SELECT public.t_check('L refused twice: the link commits; M_a has the two competing 12s (the first superseded by pass 2), no note_late_link request',
  (SELECT (partner_user_id = public.pid('lmiss1'))::text FROM public.promissory_notes WHERE whatsapp_number = '0771000011') || '/' || public.t_reqs(public.tid('M_a')),
  'true/rate_change@12:superseded,rate_change@12:pending');
SELECT public.t_check('L refused twice: one alert pair whose text counts the refused portfolio (and nothing about a queued one)',
  (public.t_emails('Promissory note linked late%') - public.t_v('mails_before')::int) || '/' || public.t_last_late_mail(),
  '2/1 portfolio(s) could not be queued because another change to the same portfolio was in progress at the same moment. Check them in the CFO queue against the promissory note''s rate.');
SELECT public.t_check('L refused twice (round 4): nothing queued, so the subject says a check is needed (not "waiting for the CFO")',
  public.t_late_subjects(public.t_v('mail_id0')::bigint), '2:Promissory note linked late: Returns catch-up needs a check');
-- (b) one portfolio refused twice, another queued: both sentences, the counts right.
SELECT public.t_vset('mails_before', public.t_emails('Promissory note linked late%')::text);
SELECT public.t_vset('mail_id0', (SELECT COALESCE(max(id), 0)::text FROM public._email_outbox));
BEGIN;
SELECT set_config('t.compete', public.tid('M_b')::text, true) IS NOT NULL AS x \gset
UPDATE public.promissory_notes SET partner_user_id = public.pid('lmiss2') WHERE whatsapp_number = '0771000012';
COMMIT;
SELECT public.t_check('L one refused, one queued: M_b refused (competing 12 pending), M_c queued at 15',
  public.t_reqs(public.tid('M_b')) || ' / ' || public.t_reqs(public.tid('M_c')),
  'rate_change@12:superseded,rate_change@12:pending / note_late_link@15:pending');
SELECT public.t_check('L one refused, one queued: alert says 1 queued for 1 partner AND 1 refused',
  (public.t_emails('Promissory note linked late%') - public.t_v('mails_before')::int) || '/' || public.t_last_late_mail(),
  '2/1 portfolio(s) of 1 partner(s) were opened inside a promissory note''s window at a lower rate, before the note was linked to them. Each is waiting in the CFO queue (source note_late_link); nothing changes until the CFO approves. 1 portfolio(s) could not be queued because another change to the same portfolio was in progress at the same moment. Check them in the CFO queue against the promissory note''s rate.');
SELECT public.t_check('L one refused, one queued (round 4): something was queued, so the usual subject',
  public.t_late_subjects(public.t_v('mail_id0')::bigint), '2:Promissory note linked late: Returns catch-up waiting for the CFO');
-- (c) refused once (pass 1), queued by pass 2 (the round-2 r2_7 outcome, done deterministically).
SELECT public.t_vset('mails_before', public.t_emails('Promissory note linked late%')::text);
SELECT public.t_vset('mail_id0', (SELECT COALESCE(max(id), 0)::text FROM public._email_outbox));
BEGIN;
SELECT set_config('t.compete_once', public.tid('O_a')::text, true) IS NOT NULL AS x \gset
UPDATE public.promissory_notes SET partner_user_id = public.pid('lonce') WHERE whatsapp_number = '0771000013';
COMMIT;
SELECT public.t_check('L refused once, then pass 2: the lower 12 superseded, note_late_link 15 pending; the normal alert (nothing refused)',
  public.t_reqs(public.tid('O_a')) || ' / ' || (public.t_emails('Promissory note linked late%') - public.t_v('mails_before')::int) || '/'
  || (public.t_last_late_mail() LIKE '1 portfolio(s) of 1 partner(s) were opened%') || '/' || (public.t_last_late_mail() LIKE '%could not be queued%'),
  'rate_change@12:superseded,note_late_link@15:pending / 2/true/false');
SELECT public.t_check('L refused once, then queued (round 4): the usual subject', public.t_late_subjects(public.t_v('mail_id0')::bigint),
  '2:Promissory note linked late: Returns catch-up waiting for the CFO');
-- (d) Round 6, S8d in one transaction: a lower request (12) opened AND approved between the link's step-2 supersede and its insert.
SELECT public.t_vset('mails_before', public.t_emails('Promissory note linked late%')::text);
SELECT public.t_vset('mail_id0', (SELECT COALESCE(max(id), 0)::text FROM public._email_outbox));
BEGIN;
SELECT set_config('t.compete_sched', public.tid('S_a')::text, true) IS NOT NULL AS x \gset
UPDATE public.promissory_notes SET partner_user_id = public.pid('lsched') WHERE whatsapp_number = '0771000014';
COMMIT;
SELECT public.t_check('L (round 6, S8d in one transaction) a lower 12 scheduled by the CFO between the step-2 supersede and the insert: pass 1 conflicts on one_open, pass 2 supersedes the scheduled 12 and queues the note''s 15 -> one open request, the 15; the usual alert, nothing refused',
  public.t_reqs(public.tid('S_a')) || ' / open ' || (SELECT count(*) FROM public.portfolio_rate_approvals WHERE portfolio_id = public.tid('S_a')
                                                       AND (status = 'pending' OR (status = 'approved' AND applied_at IS NULL)))
  || ' / ' || public.t_late_subjects(public.t_v('mail_id0')::bigint) || ' / ' || (public.t_last_late_mail() LIKE '%could not be queued%'),
  'rate_change@12:superseded,note_late_link@15:pending / open 1 / 2:Promissory note linked late: Returns catch-up waiting for the CFO / false');
SELECT public.t_check('L (round 6, S8d) ... and the CFO can approve the note''s 15 (round 5: it failed on portfolio_rate_approvals_one_scheduled beside the scheduled 12)',
  public.t_err($q$SELECT public.cfo_decide_portfolio_rate_requests(ARRAY(SELECT id FROM public.portfolio_rate_approvals WHERE portfolio_id = public.tid('S_a') AND status = 'pending'), 'approve', 's8d')$q$)
  || ' / ' || (public.cfo_decide_portfolio_rate_requests(ARRAY(SELECT id FROM public.portfolio_rate_approvals WHERE portfolio_id = public.tid('S_a') AND status = 'pending'), 'approve', 's8d') ->> 'decided'),
  'ok / 1');
DROP TRIGGER _t_compete ON public.portfolio_rate_approvals;
DROP FUNCTION public._t_compete();

-- (c) CFO approves P_a's catch-up; the next-cycle job applies it; the decider then counts it.
UPDATE public.investor_portfolios SET status = 'active' WHERE id = public.tid('P_a');
INSERT INTO public.pending_wallet_operations (source_table, source_id, category, status, reviewed_at, amount, direction)
VALUES ('investor_portfolios', public.tid('P_a'), 'roi_payout', 'approved', now() + interval '1 second', 1000, 'cash_out');
-- Close every note window for ll1 so only the approved catch-up can keep the note rate.
ALTER TABLE public.partner_return_note_windows DISABLE TRIGGER USER;
UPDATE public.partner_return_note_windows SET ends_on = current_date - 1
 WHERE note_id IN (SELECT id FROM public.promissory_notes WHERE partner_user_id = public.pid('ll1'));
ALTER TABLE public.partner_return_note_windows ENABLE TRIGGER USER;
SELECT public.t_check('L(c) window closed, catch-up only requested -> ll1 is new (10)', public.t_rate('ll1'), '10|new');
SELECT public.t_check('L(c) CFO approves P_a''s catch-up',
  (public.cfo_decide_portfolio_rate_requests(ARRAY(SELECT id FROM public.portfolio_rate_approvals WHERE portfolio_id = public.tid('P_a') AND status = 'pending'),
                                             'approve', 'late note') ->> 'decided'), '1');
SELECT public.t_check('L(c) approved but not applied yet -> still 10', public.t_rate('ll1'), '10|new');
SELECT public.t_check('L(c) next-cycle job applies it', (public.apply_due_portfolio_rate_changes() ->> 'applied') || '/' || public.t_desc(public.tid('P_a')), '1/15|new|10|-');
SELECT public.t_check('L(c) applied catch-up on a live portfolio -> the person''s next portfolio gets 15 promissory_note',
  public.t_rate('ll1') || ' / ' || public.t_desc(public.t2_port('ll1', NULL, 'pending_ops_approval')), '15|promissory_note / 15|promissory_note|15|-');
UPDATE public.investor_portfolios SET status = 'redeemed' WHERE id = public.tid('P_a');
SELECT public.t_check('L(c) once that portfolio is redeemed, the catch-up no longer counts -> 10', public.t_rate('ll1'), '10|new');
SELECT public.t_check('L conformance empty (every differing rate is explained by a CFO request)', public.t2_conf(), 'empty');

-- ===========================================================================
-- G. Phase 1 gate, UPDATE path with the switch on (round 5: no sub-transaction). A newer staff rate request replaces every open
--    one (locked in id order first); its INSERT ... ON CONFLICT (portfolio_id) WHERE status = 'pending' DO NOTHING inserts
--    nothing when another pending request holds the one-pending slot, and a second try supersedes that request too; a second
--    miss in a row raises 23505 naming portfolio_rate_approvals_one_pending; any other unique violation is raised at once.
--    Deterministic, inside one transaction: a test-only BEFORE INSERT trigger opens a competing pending request right before
--    the gate's own insert. With no sub-transaction the competitor is NOT rolled back: the second try finds it and supersedes
--    it (the outcome when another transaction committed it while this one waited). A sequence counts the gate's tries (a
--    sequence is not rolled back with the failed edit). The race suite runs the cross-session cases: R6b (a late link holds
--    the slot), R6d (any held pending request), R6e (the second miss, which needs a test-only gap between the two tries).
--    Round 6 ('scheduled'): the competitor is a pending 15 that is approved by the CFO at once (scheduled, not applied) before
--    the gate's own insert, the in-transaction form of G13 (race R6f): the one-open index makes the insert a conflict, so the
--    second try replaces the scheduled 15 instead of leaving a pending request beside it.
-- ===========================================================================
CREATE SEQUENCE public._t_gate_try;
CREATE FUNCTION public._t_gate_compete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_try bigint; v_id uuid;
BEGIN
  IF NEW.source = 'rate_change' AND NEW.portfolio_id::text = current_setting('t.gate_pid', true) THEN
    v_try := nextval('public._t_gate_try');
    IF current_setting('t.gate_mode', true) = 'always' OR (current_setting('t.gate_mode', true) = 'once' AND v_try = 1) THEN
      INSERT INTO public.portfolio_rate_approvals (portfolio_id, requested_rate, rate_in_force, standard_rate, source, requested_by)
      VALUES (NEW.portfolio_id, 15, NEW.rate_in_force, NEW.rate_in_force, 'note_late_link', NULL);
    ELSIF current_setting('t.gate_mode', true) = 'other' THEN
      RAISE EXCEPTION USING ERRCODE = 'unique_violation', CONSTRAINT = 't_some_other_key', MESSAGE = 'T_OTHER_UNIQUE';
    ELSIF current_setting('t.gate_mode', true) = 'scheduled' AND v_try = 1 THEN
      INSERT INTO public.portfolio_rate_approvals (portfolio_id, requested_rate, rate_in_force, standard_rate, source, requested_by)
      VALUES (NEW.portfolio_id, 15, NEW.rate_in_force, NEW.rate_in_force, 'note_late_link', NULL) RETURNING id INTO v_id;
      UPDATE public.portfolio_rate_approvals SET status = 'approved', decided_at = now(), decision_note = 'G13 test' WHERE id = v_id;
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER _t_gate_compete BEFORE INSERT ON public.portfolio_rate_approvals FOR EACH ROW EXECUTE FUNCTION public._t_gate_compete();
-- '<ok | SQLSTATE constraint: message> / attempts <n> / <every request of G_a: source@rate:status, by time, then status, then
-- rate desc> / <rate|basis|entitled|pending>'.
CREATE FUNCTION public.t_gate_run(p_mode text, p_rate numeric) RETURNS text LANGUAGE plpgsql AS $$
DECLARE v_err text; v_con text;
BEGIN
  PERFORM setval('public._t_gate_try', 1, false);
  PERFORM set_config('t.gate_mode', p_mode, false);
  BEGIN
    UPDATE public.investor_portfolios SET roi_percentage = p_rate WHERE id = public.tid('G_a');
    v_err := 'ok';
  EXCEPTION WHEN others THEN
    GET STACKED DIAGNOSTICS v_con = CONSTRAINT_NAME;
    v_err := SQLSTATE || COALESCE(' ' || NULLIF(v_con, ''), '') || ': ' || SQLERRM;
  END;
  RETURN v_err || ' / attempts ' || (SELECT CASE WHEN is_called THEN last_value ELSE 0 END FROM public._t_gate_try)
         || ' / ' || (SELECT COALESCE(string_agg(a.source || '@' || trim_scale(a.requested_rate) || ':' || a.status, ','
                                                 ORDER BY a.requested_at, a.status DESC, a.requested_rate DESC), '-')
                        FROM public.portfolio_rate_approvals a WHERE a.portfolio_id = public.tid('G_a'))
         || ' / ' || public.t_desc(public.tid('G_a'));
END $$;
DO $$ BEGIN
  PERFORM public.t2_person('gr');
  INSERT INTO public._t_ids VALUES ('G_a', public.t2_port('gr', NULL, 'active'));
END $$;
SELECT set_config('t.gate_pid', public.tid('G_a')::text, false) IS NOT NULL AS x \gset
SELECT public.t_check('G plain staff edit 13 (no competition): one try, rate_change 13 pending, the rate in force stays 10',
  public.t_gate_run('count', 13), 'ok / attempts 1 / rate_change@13:pending / 10|new|10|13');
SELECT public.t_vset('g_once', public.t_gate_run('once', 12));
SELECT public.t_check('G (round 5) a competing pending 15 appears at the first insert: ON CONFLICT DO NOTHING inserts nothing, the second try supersedes the 15 (kept, superseded: nothing is rolled back) and inserts the 12; the 13 and the 15 superseded once each',
  public.t_v('g_once') || ' / '
  || (SELECT string_agg(trim_scale(requested_rate) || ':' || (length(decision_note) - length(replace(decision_note, 'Superseded: replaced by a newer rate request', '')))
                        / length('Superseded: replaced by a newer rate request') || 'x', ',' ORDER BY requested_rate)
        FROM public.portfolio_rate_approvals WHERE portfolio_id = public.tid('G_a') AND status = 'superseded'),
  'ok / attempts 2 / rate_change@13:superseded,note_late_link@15:superseded,rate_change@12:pending / 10|new|10|12 / 13:1x,15:1x');
SELECT public.t_check('G (round 5) a conflict at both tries: raised as 23505 naming portfolio_rate_approvals_one_pending, with the gate''s own message; the edit is rolled back (both competing 15s with it), nothing changed',
  public.t_gate_run('always', 11),
  '23505 portfolio_rate_approvals_one_pending: Another Returns rate request for this portfolio was opened at the same moment; try again / attempts 2 / '
  || 'rate_change@13:superseded,note_late_link@15:superseded,rate_change@12:pending / 10|new|10|12');
SELECT public.t_check('G any other unique violation: raised at once (one try, its own constraint), nothing changed',
  public.t_gate_run('other', 11),
  '23505 t_some_other_key: T_OTHER_UNIQUE / attempts 1 / rate_change@13:superseded,note_late_link@15:superseded,rate_change@12:pending / 10|new|10|12');
SELECT public.t_check('G ... and a normal edit afterwards still works (12 superseded, 14 pending, one try)',
  public.t_gate_run('count', 14),
  'ok / attempts 1 / rate_change@13:superseded,note_late_link@15:superseded,rate_change@12:superseded,rate_change@14:pending / 10|new|10|14');
SELECT public.t_check('G (round 6, G13 in one transaction) a competing 15 is opened AND approved (scheduled) between the gate''s supersede and its insert: the insert conflicts on one_open, the second try supersedes the scheduled 15 and inserts the 16 -> one open request, the 16',
  public.t_gate_run('scheduled', 16) || ' / open ' || (SELECT count(*) FROM public.portfolio_rate_approvals WHERE portfolio_id = public.tid('G_a')
                                                         AND (status = 'pending' OR (status = 'approved' AND applied_at IS NULL))),
  'ok / attempts 2 / rate_change@13:superseded,note_late_link@15:superseded,rate_change@12:superseded,rate_change@14:superseded,note_late_link@15:superseded,rate_change@16:pending / 10|new|10|16 / open 1');
SELECT public.t_vset('g13_cfo', public.t_err($q$SELECT public.cfo_decide_portfolio_rate_requests(ARRAY(SELECT id FROM public.portfolio_rate_approvals WHERE portfolio_id = public.tid('G_a') AND status = 'pending'), 'approve', 'g13')$q$)
  || ' / ' || (public.cfo_decide_portfolio_rate_requests(ARRAY(SELECT id FROM public.portfolio_rate_approvals WHERE portfolio_id = public.tid('G_a') AND status = 'pending'), 'approve', 'g13') ->> 'decided'));
SELECT public.t_check('G (round 6, G13) ... and the CFO can approve the 16 (round 5: it failed on portfolio_rate_approvals_one_scheduled beside the scheduled 15); the 16 is then the one open request, scheduled',
  public.t_v('g13_cfo') || ' / ' || (SELECT string_agg(trim_scale(requested_rate) || ':' || status || ':' || (applied_at IS NULL), ',') FROM public.portfolio_rate_approvals
                WHERE portfolio_id = public.tid('G_a') AND (status = 'pending' OR (status = 'approved' AND applied_at IS NULL))),
  'ok / 1 / 16:approved:true');
-- Phase 6 G1: the gate has three EXCEPTION blocks now, one around each bounded rate-lock wait (invite claim, insert
-- while on, insert while off after the cut-off); the rate-change retry loop itself stays free of sub-transactions.
SELECT public.t_check('G (round 5; Phase 6 G1) the gate''s retry code: no sub-transaction in the retry loop (no EXCEPTION clause between FOR v_try and END LOOP), open requests locked in id order, INSERT ... ON CONFLICT on the one-pending slot DO NOTHING, EXIT WHEN FOUND, the second miss raises 23505 naming portfolio_rate_approvals_one_pending',
  (SELECT (position('EXCEPTION WHEN' in substring(d from position('FOR v_try IN 1..2 LOOP' in d) for position('END LOOP;' in substring(d from position('FOR v_try IN 1..2 LOOP' in d))))) = 0
           AND position('FOR v_try IN 1..2 LOOP' in d) > 0)::text || '/' || (position('ORDER BY a.id FOR UPDATE;' in d) > 0) || '/'
          || (position('ON CONFLICT (portfolio_id) WHERE status = ''pending'' DO NOTHING;' in d) > 0) || '/'
          || (position('EXIT WHEN FOUND;' in d) > 0) || '/'
          || (position('USING ERRCODE = ''23505'', CONSTRAINT = ''portfolio_rate_approvals_one_pending'';' in d) > 0)
     FROM (SELECT pg_get_functiondef('public.enforce_partner_return_rate_policy()'::regprocedure) d) x), 'true/true/true/true/true');
DROP TRIGGER _t_gate_compete ON public.portfolio_rate_approvals;
DROP FUNCTION public._t_gate_compete();
SELECT set_config('t.gate_pid', '', false) IS NOT NULL AS x \gset
-- Round 5 (e): no sub-transaction per rate change. One transaction changing the rate of 100 portfolios (each queues a CFO
-- request) leaves the sub-transaction cache empty (pg_stat_get_backend_subxact, PG 16+). The round-4 body (BEGIN ... EXCEPTION
-- around each change; t_gate_body('r4') rebuilds it from the shipped text), put back inside a rolled-back transaction, fills
-- the 64-entry cache and overflows it.
DO $$ BEGIN PERFORM public.t2_person('gbulk'); PERFORM public.t2_port('gbulk', NULL, 'active') FROM generate_series(1, 100); END $$;
BEGIN;
UPDATE public.investor_portfolios SET roi_percentage = 12 WHERE investor_id = public.pid('gbulk');
SELECT public.t_my_subxact() AS sx5,
       (SELECT count(*) FROM public.portfolio_rate_approvals a JOIN public.investor_portfolios ip ON ip.id = a.portfolio_id
         WHERE ip.investor_id = public.pid('gbulk') AND a.status = 'pending' AND a.requested_rate = 12) AS rq5 \gset
ROLLBACK;
BEGIN;
DO $g$ BEGIN EXECUTE public.t_gate_body('r4'); END $g$;
UPDATE public.investor_portfolios SET roi_percentage = 12 WHERE investor_id = public.pid('gbulk');
SELECT public.t_my_subxact() AS sx4,
       (SELECT count(*) FROM public.portfolio_rate_approvals a JOIN public.investor_portfolios ip ON ip.id = a.portfolio_id
         WHERE ip.investor_id = public.pid('gbulk') AND a.status = 'pending' AND a.requested_rate = 12) AS rq4 \gset
ROLLBACK;
SELECT public.t_check('G (round 5, e) one transaction changing the rate of 100 portfolios: 100 CFO requests and 0 sub-transactions (round-4 body in a rolled-back transaction: 64, overflowed)',
  :'sx5' || ' ' || :rq5 || ' ; round-4 body ' || :'sx4' || ' ' || :rq4, '0/false 100 ; round-4 body 64/true 100');
SELECT public.t_check('G (round 5, e; Phase 6 G1) the shipped gate text is back after the rolled-back round-4 body: exactly three EXCEPTION clauses, all lock_not_available around the bounded rate-lock wait',
  (SELECT ((length(d) - length(replace(d, 'EXCEPTION WHEN', ''))) / length('EXCEPTION WHEN')) || '/'
          || ((length(d) - length(replace(d, 'EXCEPTION WHEN lock_not_available THEN', ''))) / length('EXCEPTION WHEN lock_not_available THEN'))
     FROM (SELECT pg_get_functiondef('public.enforce_partner_return_rate_policy()'::regprocedure) d) x), '3/3');

-- ===========================================================================
-- W. Round 5: a pre-cut-off note's window remembers who it is for. The switch-on snapshot froze, per note, the person and
--    the agent on it at the cut-off (partner_return_note_windows.partner_user_id / agent_id); partner_note_window_applies
--    reads them in the rule (partner_rates_for) and in the late link's catch-up look-up. A note linked at the cut-off counts
--    only for that person, wherever it is moved later; a note nobody was linked to counts for whoever it is linked to later,
--    except the agent who wrote it (round 6: and the agent who holds it now). Notes W1-W10 were written in the round-5 set-up,
--    before the cut-off.
-- ===========================================================================
SELECT public.t_as(NULL) IS NULL AS x \gset
SELECT public.t_check('W the snapshot froze each window''s person and agent from the note at the cut-off (S1 sx: linked before the cut-off; W1 wa; W2 and W4 nobody; W7 wf)',
  (SELECT string_agg(split_part(n.partner_name, ' ', 1) || '='
                     || COALESCE((SELECT k FROM unnest(ARRAY['wa','wf','sx']) k WHERE public.pid(k) = w.partner_user_id),
                                 CASE WHEN w.partner_user_id IS NULL THEN 'nobody' ELSE '?' END)
                     || '/' || COALESCE((SELECT k FROM unnest(ARRAY['agent1','wagent']) k WHERE public.pid(k) = w.agent_id), '?'), ' ' ORDER BY n.partner_name)
     FROM public.promissory_notes n JOIN public.partner_return_note_windows w ON w.note_id = n.id
    WHERE n.partner_name IN ('W1 linked to wa', 'W2 unlinked phone', 'W4 written by wagent', 'W7 old snapshot', 'S1 pending unlinked')),
  'S1=sx/agent1 W1=wa/agent1 W2=nobody/agent1 W4=nobody/wagent W7=wf/agent1');
-- (i) A note linked to wa at the cut-off counts only for wa, wherever owner-run code moves it.
DO $$ BEGIN INSERT INTO public._t_ids VALUES ('wa_p1', public.t2_port('wa', NULL, 'active')), ('wb_p1', public.t2_port('wb', NULL, 'active')); END $$;
SELECT public.t_check('W(i) W1, linked to wa at the cut-off, counts for wa: 15 promissory_note and wa''s new portfolio at 15; wb (no note) 10',
  public.t_rate('wa') || ' / ' || public.t_desc(public.tid('wa_p1')) || ' / ' || public.t_desc(public.tid('wb_p1')),
  '15|promissory_note / 15|promissory_note|15|- / 10|new|10|-');
SELECT public.t_vset('mails_before', public.t_emails('Promissory note linked late%')::text);
-- Owner-run move (as promissory_confirm_arrival_match does it: database owner, SECURITY DEFINER).
UPDATE public.promissory_notes SET partner_user_id = public.pid('wb') WHERE partner_name = 'W1 linked to wa';
SELECT public.t_check('W(i)+(iii) W1 moved to wb by owner-run code: it does not count for wb (10 new), wb''s portfolio at 10 gets no catch-up request, no alert',
  public.t_note_state('W1 linked to wa') || ' / ' || public.t_rate('wb') || ' / ' || public.t_desc(public.tid('wb_p1')) || ' / '
  || (public.t_emails('Promissory note linked late%') - public.t_v('mails_before')::int), 'activated|wb / 10|new / 10|new|10|- / 0');
SELECT public.t_check('W(i) ... wa, no longer linked: the window stops counting for wa, which keeps 15 only through the live portfolio it opened at the note''s rate (entitled 15, basis promissory_note)',
  public.t_rate('wa'), '15|promissory_note');
UPDATE public.investor_portfolios SET status = 'redeemed' WHERE id = public.tid('wa_p1');
DO $$ BEGIN INSERT INTO public._t_ids VALUES ('wa_p2', public.t2_port('wa', NULL, 'active')); END $$;
SELECT public.t_check('W(i) ... once that portfolio is redeemed wa gets nothing from W1 (10 new) while W1 is linked to wb; wa''s next portfolio opens at 10',
  public.t_rate('wa') || ' / ' || public.t_desc(public.tid('wa_p2')), '10|new / 10|new|10|-');
SELECT public.t_vset('mails_before', public.t_emails('Promissory note linked late%')::text);
UPDATE public.promissory_notes SET partner_user_id = public.pid('wa') WHERE partner_name = 'W1 linked to wa';
SELECT public.t_check('W(i)+(iii) moved back to wa by owner-run code: counts for wa again (15); wa''s portfolio opened at 10 meanwhile goes to the CFO at 15 (note_late_link), one alert pair',
  public.t_rate('wa') || ' / ' || public.t_desc(public.tid('wa_p2')) || ' / ' || public.t_reqs(public.tid('wa_p2')) || ' / '
  || (public.t_emails('Promissory note linked late%') - public.t_v('mails_before')::int), '15|promissory_note / 10|new|10|15 / note_late_link@15:pending / 2');
-- (ii) A note nobody was linked to at the cut-off counts for whoever owner-run code links it to later, except its own agent.
DO $$ BEGIN
  INSERT INTO public._t_ids VALUES ('wc_p', public.t2_port('wc', NULL, 'active')), ('wagent_p', public.t2_port('wagent', NULL, 'active'));
END $$;
SELECT public.t_vset('mails_before', public.t_emails('Promissory note linked late%')::text);
UPDATE public.profiles SET phone = '0775000002' WHERE id = public.pid('wc');
SELECT public.t_vset('linked', public.link_promissory_notes_for_user(public.pid('wc'))::text);
SELECT public.t_check('W(ii)+(iii) W2 (nobody at the cut-off) linked to wc by the signup phone match: counts for wc (15); wc''s portfolio at 10 goes to the CFO at 15, one alert pair',
  public.t_v('linked') || ' / ' || public.t_note_state('W2 unlinked phone') || ' / ' || public.t_rate('wc') || ' / ' || public.t_desc(public.tid('wc_p')) || ' / '
  || (public.t_emails('Promissory note linked late%') - public.t_v('mails_before')::int), '1 / pending|wc / 15|promissory_note / 10|new|10|15 / 2');
UPDATE public.profiles SET email = 'w3.typed@x.test' WHERE id = public.pid('wd');
SELECT public.t_vset('linked', public.link_promissory_notes_for_user(public.pid('wd'))::text);
SELECT public.t_check('W(ii) W3 (nobody at the cut-off) linked to wd by the profile email match: counts for wd (15)',
  public.t_v('linked') || ' / ' || public.t_note_state('W3 unlinked email') || ' / ' || public.t_rate('wd'), '1 / pending|wd / 15|promissory_note');
SELECT public.t_vset('mails_before', public.t_emails('Promissory note linked late%')::text);
UPDATE public.profiles SET phone = '0775000004' WHERE id = public.pid('wagent');
SELECT public.t_vset('linked', public.link_promissory_notes_for_user(public.pid('wagent'))::text);
SELECT public.t_check('W(ii)+(iii) W4 linked by the phone match to wagent, the agent who wrote it: it does not count for wagent (10 new); wagent''s portfolio at 10 gets no catch-up request; no alert',
  public.t_v('linked') || ' / ' || public.t_note_state('W4 written by wagent') || ' / ' || public.t_rate('wagent') || ' / ' || public.t_desc(public.tid('wagent_p')) || ' / '
  || (public.t_emails('Promissory note linked late%') - public.t_v('mails_before')::int), '1 / pending|wagent / 10|new / 10|new|10|- / 0');
SELECT public.t_check('W(ii) ... and wagent''s next portfolio opens at 10, not the note''s 15', public.t_desc(public.t2_port('wagent', NULL, 'pending_ops_approval')), '10|new|10|-');
-- Residual (finding): the email match reads profiles.email, which the person can set (and, under a production policy, their
-- referring agent). Anyone who is not the note's agent -- a stranger, or the agent's own second account -- can claim an
-- unlinked pre-cut-off note's window by putting its typed email on their profile.
UPDATE public.profiles SET email = 'w5.typed@x.test' WHERE id = public.pid('we');
SELECT public.t_vset('linked', public.link_promissory_notes_for_user(public.pid('we'))::text);
SELECT public.t_check('W(ii) residual (finding, round 5 does not close it): we puts W5''s typed email on their own profile; the owner-run email match links W5 to we and we gets its 15',
  public.t_v('linked') || ' / ' || public.t_note_state('W5 unlinked email') || ' / ' || public.t_rate('we'), '1 / pending|we / 15|promissory_note');
-- (iv) Window rows written by an older snapshot (before the round-5 columns: person and agent NULL). Production has no window
--      row yet (the snapshot runs at the first switch-on), so this only shows what such a row would do.
ALTER TABLE public.partner_return_note_windows DISABLE TRIGGER USER;
UPDATE public.partner_return_note_windows SET partner_user_id = NULL, agent_id = NULL
 WHERE note_id IN (SELECT id FROM public.promissory_notes WHERE partner_name IN ('W6 old snapshot', 'W7 old snapshot'));
ALTER TABLE public.partner_return_note_windows ENABLE TRIGGER USER;
UPDATE public.profiles SET phone = '0775000006' WHERE id = public.pid('wagent2');
SELECT public.link_promissory_notes_for_user(public.pid('wagent2')) IS NOT NULL AS x \gset
UPDATE public.promissory_notes SET partner_user_id = public.pid('wg') WHERE partner_name = 'W7 old snapshot';
SELECT public.t_check('W(iv) a window row with no person and no agent acts as "nobody at the cut-off, no agent frozen": round 6, W6 does NOT count for wagent2, the agent who holds it now (10 new; round 5: 15), and W7 counts for whoever it is moved to (wg 15; wf, its person at the cut-off, 10)',
  public.t_note_state('W6 old snapshot') || ' ' || public.t_rate('wagent2') || ' / ' || public.t_note_state('W7 old snapshot') || ' ' || public.t_rate('wg')
  || ' / ' || public.t_rate('wf'), 'pending|wagent2 10|new / activated|wg 15|promissory_note / 10|new');
-- (v) Round 6: a book transfer. partner_ops_transfer_proxy_book (SECURITY DEFINER, owner-run) moves a proxy agent's notes to
--     another agent with 'UPDATE promissory_notes SET agent_id = p_to_agent_id, updated_at = now() WHERE agent_id = p_from_agent_id';
--     the same statement is run here on the three W(v) notes only. The window keeps the agent frozen at the cut-off; the helper
--     also excludes the agent who holds the note NOW, so the receiving agent cannot claim a note nobody held at the cut-off
--     (round-5 money finding F), and the agent it was transferred away from still cannot either. Anyone else still can.
DO $$ BEGIN
  INSERT INTO public._t_ids VALUES ('wt_p', public.t2_port('wt', NULL, 'active')), ('wh_p', public.t2_port('wh', NULL, 'active')),
                                   ('wagent3_p', public.t2_port('wagent3', NULL, 'active'));
END $$;
SELECT public.t_vset('mails_before', public.t_emails('Promissory note linked late%')::text);
UPDATE public.promissory_notes SET agent_id = public.pid('wt'), updated_at = now() WHERE partner_name IN ('W8 transferred then claimed', 'W9 transferred then third');
UPDATE public.promissory_notes SET agent_id = public.pid('agent1'), updated_at = now() WHERE partner_name = 'W10 transferred away';
SELECT public.t_check('W(v) (round 6) the book transfer changed the notes'' agent only: their windows still say nobody held them at the cut-off and keep the agent frozen then; no request, no alert',
  (SELECT string_agg(split_part(n.partner_name, ' ', 1) || ' agent now=' || COALESCE((SELECT k FROM unnest(ARRAY['agent1','wt','wagent3']) k WHERE public.pid(k) = n.agent_id), '?')
                     || ' window=' || COALESCE(w.partner_user_id::text, 'nobody') || '/'
                     || COALESCE((SELECT k FROM unnest(ARRAY['agent1','wt','wagent3']) k WHERE public.pid(k) = w.agent_id), '?') || ' ' || n.status, ' ; ' ORDER BY n.partner_name)
     FROM public.promissory_notes n JOIN public.partner_return_note_windows w ON w.note_id = n.id
    WHERE n.partner_name IN ('W8 transferred then claimed', 'W9 transferred then third', 'W10 transferred away')) || ' / '
  || (SELECT count(*) FROM public.portfolio_rate_approvals WHERE portfolio_id IN (public.tid('wt_p'), public.tid('wh_p'), public.tid('wagent3_p'))) || '/'
  || (public.t_emails('Promissory note linked late%') - public.t_v('mails_before')::int),
  'W10 agent now=agent1 window=nobody/wagent3 pending ; W8 agent now=wt window=nobody/agent1 pending ; W9 agent now=wt window=nobody/agent1 pending / 0/0');
UPDATE public.profiles SET phone = '0775000008' WHERE id = public.pid('wt');
SELECT public.t_vset('linked', public.link_promissory_notes_for_user(public.pid('wt'))::text);
SELECT public.t_check('W(v) (round 6) W8, moved to wt by the book transfer, linked to wt by the owner-run phone match: it does not count for wt (10 new; round 5: 15), wt''s portfolio at 10 gets no catch-up request, no alert',
  public.t_v('linked') || ' / ' || public.t_note_state('W8 transferred then claimed') || ' / ' || public.t_rate('wt') || ' / ' || public.t_desc(public.tid('wt_p'))
  || ' / ' || public.t_reqs(public.tid('wt_p')) || ' / ' || (public.t_emails('Promissory note linked late%') - public.t_v('mails_before')::int),
  '1 / pending|wt / 10|new / 10|new|10|- / - / 0');
SELECT public.t_check('W(v) (round 6) ... and wt''s next portfolio opens at 10, not the note''s 15', public.t_desc(public.t2_port('wt', NULL, 'pending_ops_approval')), '10|new|10|-');
UPDATE public.profiles SET phone = '0775000010' WHERE id = public.pid('wagent3');
SELECT public.t_vset('linked', public.link_promissory_notes_for_user(public.pid('wagent3'))::text);
SELECT public.t_check('W(v) (round 6) W10, written by wagent3 and transferred away to agent1, linked to wagent3: still does not count for the agent frozen at the cut-off (10 new), no request, no alert',
  public.t_v('linked') || ' / ' || public.t_note_state('W10 transferred away') || ' / ' || public.t_rate('wagent3') || ' / ' || public.t_desc(public.tid('wagent3_p'))
  || ' / ' || public.t_reqs(public.tid('wagent3_p')) || ' / ' || (public.t_emails('Promissory note linked late%') - public.t_v('mails_before')::int),
  '1 / pending|wagent3 / 10|new / 10|new|10|- / - / 0');
UPDATE public.profiles SET phone = '0775000009' WHERE id = public.pid('wh');
SELECT public.t_vset('linked', public.link_promissory_notes_for_user(public.pid('wh'))::text);
SELECT public.t_check('W(v) (round 6) W9, also moved to wt, linked to wh (neither the agent then nor the agent now): counts for wh (15); wh''s portfolio at 10 goes to the CFO at 15, one alert pair',
  public.t_v('linked') || ' / ' || public.t_note_state('W9 transferred then third') || ' / ' || public.t_rate('wh') || ' / ' || public.t_desc(public.tid('wh_p'))
  || ' / ' || public.t_reqs(public.tid('wh_p')) || ' / ' || (public.t_emails('Promissory note linked late%') - public.t_v('mails_before')::int),
  '1 / pending|wh / 15|promissory_note / 10|new|10|15 / note_late_link@15:pending / 2');
-- Residual (finding, round 6): the exclusion reads the note's agent NOW. W8 stays linked to wt; once the book moves on again
-- (another transfer, or a staff UPDATE of agent_id, which the note guard does not watch), wt is neither the agent then nor
-- the agent now and W8 counts for wt. Nothing is queued for wt's earlier portfolios (the late link fires on partner_user_id
-- only), but wt's next portfolio opens at 15.
SELECT public.t_vset('mails_before', public.t_emails('Promissory note linked late%')::text);
UPDATE public.promissory_notes SET agent_id = public.pid('agent1'), updated_at = now() WHERE partner_name = 'W8 transferred then claimed';
SELECT public.t_check('W(v) residual (finding, round 6 does not close it): W8 (linked to wt while wt held it) moved on to agent1 -> it now counts for wt (15); no request for wt''s earlier portfolio, no alert; wt''s next portfolio opens at 15',
  public.t_note_state('W8 transferred then claimed') || ' / ' || public.t_rate('wt') || ' / ' || public.t_reqs(public.tid('wt_p')) || ' / '
  || (public.t_emails('Promissory note linked late%') - public.t_v('mails_before')::int) || ' / ' || public.t_desc(public.t2_port('wt', NULL, 'pending_ops_approval')),
  'pending|wt / 15|promissory_note / - / 0 / 15|promissory_note|15|-');

-- ===========================================================================
-- S. Round 5: the note guard binds service_role (edge functions) too. After the cut-off an edge function cannot link a note
--    nobody was linked to, move a linked note, unlink one, or change a rate or basis; owner-run linkers and the database owner
--    still can. (The checks before the cut-off are in the round-5 set-up, before section CUT.)
-- ===========================================================================
CREATE POLICY _t_service_role_bypass ON public.promissory_notes FOR ALL TO service_role USING (true) WITH CHECK (true);
UPDATE public.profiles SET phone = '0775000019' WHERE id = public.pid('sz');
SET ROLE service_role;
SELECT public.t_vset('s5', public.t_edge_activate('S5 pending unlinked', 'sx', 'pending'));
SELECT public.t_vset('s6', public.t_edge_activate('S6 activated unlinked', 'sx', 'activated'));
SELECT public.t_vset('s7', public.t_edge_activate('S7 pending sy', 'sx', 'pending'));
SELECT public.t_vset('s8', public.t_edge_activate('S8 pending sx', 'sx', 'pending'));
SELECT public.t_vset('s_rate', split_part(public.t_err($q$UPDATE public.promissory_notes SET return_rate = 20 WHERE partner_name = 'S8 pending sx'$q$), ':', 1) || '/'
  || split_part(public.t_err($q$UPDATE public.promissory_notes SET return_rate_basis = 'employee' WHERE partner_name = 'S8 pending sx'$q$), ':', 1) || '/'
  || split_part(public.t_err($q$UPDATE public.promissory_notes SET partner_user_id = NULL WHERE partner_name = 'S8 pending sx'$q$), ':', 1) || '/'
  || public.t_err($q$UPDATE public.promissory_notes SET total_collected = COALESCE(total_collected, 0) + 1000, next_deduction_date = current_date + 30
                     WHERE partner_name = 'S8 pending sx'$q$));
SELECT public.t_vset('s9', has_function_privilege('service_role', 'public.link_promissory_notes_for_user(uuid)', 'EXECUTE')::text || '/'
  || public.link_promissory_notes_for_user(public.pid('sz')));
RESET ROLE;
SELECT public.t_check('S (round 5, after the cut-off) service_role, activate-promissory-note''s pending branch on an unlinked pending note (S5): refused 42501, nothing changed',
  public.t_v('s5') || ' / ' || public.t_note_state('S5 pending unlinked'),
  'service_role 42501: Link a promissory note to a partner through the partner-linking tools, not directly / pending|nobody');
SELECT public.t_check('S (after the cut-off) service_role, the activated branch on an unlinked activated note (S6): refused 42501, nothing changed',
  public.t_v('s6') || ' / ' || public.t_note_state('S6 activated unlinked'),
  'service_role 42501: Link a promissory note to a partner through the partner-linking tools, not directly / activated|nobody');
SELECT public.t_check('S (after the cut-off) service_role, the pending branch for a note linked to someone else (S7, sy; the round-4 agent-moves-the-note route): refused 42501, nothing changed',
  public.t_v('s7') || ' / ' || public.t_note_state('S7 pending sy'), 'service_role 42501: A promissory note cannot be moved to another partner / pending|sy');
SELECT public.t_check('S (after the cut-off) service_role, the pending branch for a note already linked to the opener (S8, sx): activated (status only)',
  public.t_v('s8') || ' / ' || public.t_note_state('S8 pending sx'), 'service_role ok 1 / activated|sx');
SELECT public.t_check('S (after the cut-off) service_role: rate, basis and unlinking refused (42501); other columns still writable (process-promissory-deductions: total_collected, next_deduction_date)',
  public.t_v('s_rate'), '42501/42501/42501/ok');
SELECT public.t_check('S (after the cut-off) an owner-run linker called by service_role still links (SECURITY DEFINER: current_user is the owner inside): S9 -> sz by its phone',
  public.t_v('s9') || ' / ' || public.t_note_state('S9 pending unlinked'), 'true/1 / pending|sz');
WITH u AS (UPDATE public.promissory_notes SET partner_user_id = public.pid('sx') WHERE partner_name = 'S7 pending sy' RETURNING 1)
SELECT public.t_check('S the database owner (owner-run code such as promissory_confirm_arrival_match) can still move a linked note after the cut-off',
  (SELECT count(*) FROM u)::text || ' / ' || public.t_note_state('S7 pending sy'), '1 / pending|sx');
DROP POLICY _t_service_role_bypass ON public.promissory_notes;


-- ===========================================================================
-- R. Legacy rent facilitation with the switch on
-- ===========================================================================
-- The reward stamp takes the supporter's rate lock first (partner_rate_lock), on insert and on a supporter change (rolled back).
BEGIN;
SELECT public.t2_plan(410000) AS st_plan \gset
UPDATE public.rent_requests SET supporter_id = public.pid('lockp') WHERE id = :'st_plan';
SELECT (public.t_rate_buckets_held() = ARRAY[public.t_rate_bucket('lockp')]) AS st_upd,
       (SELECT count(*) FROM public.rent_facilitation_reward_rates WHERE supporter_id = public.pid('lockp')) AS st_upd_rows \gset
ROLLBACK;
BEGIN;
INSERT INTO public.rent_requests (tenant_id, landlord_id, rent_amount, status, supporter_id, funded_at)
VALUES (gen_random_uuid(), gen_random_uuid(), 420000, 'funded', public.pid('someone_else'), now());
SELECT (public.t_rate_buckets_held() = ARRAY[public.t_rate_bucket('someone_else')]) AS st_ins \gset
ROLLBACK;
BEGIN;
UPDATE public.rent_requests SET status = status WHERE id = public.t_v('pub_plan')::uuid;
SELECT cardinality(public.t_rate_buckets_held()) AS st_none \gset
ROLLBACK;
SELECT public.t_check('R the reward stamp holds exactly the supporter''s partner-rate bucket: supporter set by UPDATE / row inserted with a supporter / an update that sets no supporter takes none',
  :'st_upd' || '|' || :st_upd_rows || '/' || :'st_ins' || '/' || :st_none, 't|1/t/0');
SELECT public.t_vset('rr_on', public.t2_plan(500000)::text);
UPDATE public.rent_requests SET supporter_id = public.pid('ex20') WHERE id = public.t_v('rr_on')::uuid;
SELECT public.t_check('R supporter set later -> the rule''s rate for that person (ex20 -> 20 existing_partner)',
  (SELECT trim_scale(rate) || '|' || basis FROM public.rent_facilitation_reward_rates WHERE rent_request_id = public.t_v('rr_on')::uuid), '20|existing_partner');
SELECT public.t_vset('rr_on_at', (SELECT decided_at::text FROM public.rent_facilitation_reward_rates WHERE rent_request_id = public.t_v('rr_on')::uuid));
UPDATE public.rent_requests SET supporter_id = NULL WHERE id = public.t_v('rr_on')::uuid;
UPDATE public.rent_requests SET supporter_id = public.pid('ex20') WHERE id = public.t_v('rr_on')::uuid;
UPDATE public.rent_requests SET supporter_id = public.pid('ex20'), updated_at = now() WHERE id = public.t_v('rr_on')::uuid;
SELECT public.t_check('R same supporter again (after NULL, and a no-op set) keeps the first stamp',
  (SELECT trim_scale(rate) || '|' || basis || '|' || (decided_at::text = public.t_v('rr_on_at')) FROM public.rent_facilitation_reward_rates
    WHERE rent_request_id = public.t_v('rr_on')::uuid), '20|existing_partner|true');
UPDATE public.rent_requests SET supporter_id = public.pid('sup_new') WHERE id = public.t_v('rr_on')::uuid;
SELECT public.t_check('R re-assigned to another supporter -> decided again (new 10)',
  (SELECT trim_scale(rate) || '|' || basis || '|' || (supporter_id = public.pid('sup_new')) || '|' || (decided_at::text <> public.t_v('rr_on_at'))
     FROM public.rent_facilitation_reward_rates WHERE rent_request_id = public.t_v('rr_on')::uuid), '10|new|true|true');
INSERT INTO public.rent_requests (id, tenant_id, landlord_id, rent_amount, status, supporter_id, funded_at)
VALUES (public.pid('rr_ins'), gen_random_uuid(), gen_random_uuid(), 450000, 'funded', public.pid('emp'), now() - interval '31 days');
SELECT public.t_check('R a rent request inserted with its supporter -> stamped at insert (employee 20)',
  (SELECT trim_scale(rate) || '|' || basis FROM public.rent_facilitation_reward_rates WHERE rent_request_id = public.pid('rr_ins')), '20|employee');
SELECT public.t_vset('rew', public.post_rent_facilitation_reward(public.pid('rr_ins'), 1)::text);
SELECT public.t_check('R reward pays round(rent x stored rate): 450,000 x 20% = 90,000; result rate prints 20 (not 20.00); wallet text says 20%',
  (SELECT (r ->> 'status') || '/' || (r ->> 'amount') || '/' || (r ->> 'rate') FROM (SELECT public.t_v('rew')::jsonb r) s)
  || '/' || ((SELECT description FROM public.general_ledger WHERE idempotency_key = 'rent-reward:' || public.pid('rr_ins') || ':1' AND category = 'roi_wallet_credit')
               = '20% monthly reward (payment #1) on rent facilitation of UGX 450,000'),
  'posted/90000/20/true');
-- The edge function still sends its 15% text; the database writes the stored rate and keeps only "(managed by ...)".
INSERT INTO public.rent_requests (id, tenant_id, landlord_id, rent_amount, status, supporter_id, funded_at)
VALUES (public.pid('rr_on_proxy'), gen_random_uuid(), gen_random_uuid(), 800000, 'funded', public.pid('ex20'), now() - interval '31 days'),
       (public.pid('rr_on_paren'), gen_random_uuid(), gen_random_uuid(), 100000, 'funded', public.pid('p_new'), now() - interval '31 days'),
       (public.pid('rr_reinv'), gen_random_uuid(), gen_random_uuid(), 500000, 'funded', public.pid('ex20'), now() - interval '31 days');
SELECT public.t_vset('rew_on_proxy', public.post_rent_facilitation_reward(public.pid('rr_on_proxy'), 1, NULL,
                                       public.t_edge_reward_text(1, 800000, 'Agent Kato'))::text);
SELECT public.t_check('R proxy-managed, stored 20: the edge''s 15% text is replaced by the stored 20%, its "(managed by Agent Kato)" kept',
  (SELECT (r ->> 'amount') FROM (SELECT public.t_v('rew_on_proxy')::jsonb r) s) || '/'
  || (SELECT description FROM public.general_ledger WHERE idempotency_key = 'rent-reward:' || public.pid('rr_on_proxy') || ':1' AND category = 'roi_wallet_credit'),
  '160000/20% monthly reward (payment #1) on rent facilitation of UGX 800,000 (managed by Agent Kato)');
SELECT public.t_vset('paren_desc', (SELECT public.post_rent_facilitation_reward(public.pid('rr_on_paren'), 1, NULL,
  public.t_edge_reward_text(1, 100000, 'Okello (Gulu)'))::text));
SELECT public.t_check('R an agent name with brackets keeps its managed-by note: ''(managed by Okello (Gulu))''; result rate prints 10',
  (SELECT description FROM public.general_ledger WHERE idempotency_key = 'rent-reward:' || public.pid('rr_on_paren') || ':1' AND category = 'roi_wallet_credit')
  || '/' || (public.t_v('paren_desc')::jsonb ->> 'rate'),
  '10% monthly reward (payment #1) on rent facilitation of UGX 100,000 (managed by Okello (Gulu))/10');
-- The suffix rule on its own (the same pattern as post_rent_facilitation_reward), on the edge's texts and on junk.
SELECT public.t_check('R managed-by suffix pattern: kept for one level of brackets, nothing for trailing text, deeper nesting or no note',
  (SELECT string_agg(COALESCE(substring(t from '(\(managed by [^()]*(?:\([^()]*\)[^()]*)*\))\s*$'), '<none>'), ' | ' ORDER BY o)
     FROM unnest(ARRAY[public.t_edge_reward_text(1, 100000, 'Okello (Gulu)'), public.t_edge_reward_text(1, 100000, 'Agent Kato'),
                       '99% monthly ROI bonus (managed by Agent Kato) plus interest', public.t_edge_reward_text(1, 100000, 'A (b (c))'),
                       public.t_edge_reward_text(1, 100000), public.t_edge_reward_text(1, 100000, 'Agent Kato') || '  ']) WITH ORDINALITY u(t, o)),
  '(managed by Okello (Gulu)) | (managed by Agent Kato) | <none> | <none> | <none> | (managed by Agent Kato)');
SELECT public.t_check('R post_rent_facilitation_reward uses exactly that pattern',
  (position($p$substring(p_wallet_description from '(\(managed by [^()]*(?:\([^()]*\)[^()]*)*\))\s*$')$p$
            in pg_get_functiondef('public.post_rent_facilitation_reward(uuid,integer,uuid,text)'::regprocedure)) > 0)::text, 'true');
INSERT INTO public.rent_requests (id, tenant_id, landlord_id, rent_amount, status, supporter_id, funded_at)
VALUES (public.pid('rr_on_junk'), gen_random_uuid(), gen_random_uuid(), 100000, 'funded', public.pid('p_new'), now() - interval '31 days');
SELECT public.t_vset('rew_on_junk', public.post_rent_facilitation_reward(public.pid('rr_on_junk'), 1, NULL,
                                       '99% monthly ROI bonus (managed by Agent Kato) plus interest')::text);
SELECT public.t_check('R switch on: a caller text with trailing words after the managed-by note gets no suffix',
  (SELECT description FROM public.general_ledger WHERE idempotency_key = 'rent-reward:' || public.pid('rr_on_junk') || ':1' AND category = 'roi_wallet_credit'),
  '10% monthly reward (payment #1) on rent facilitation of UGX 100,000');
SELECT public.t_vset('rew_reinv', public.post_rent_facilitation_reward(public.pid('rr_reinv'), 1, public.tid('ex20_p'))::text);
SELECT public.t_check('R reinvested reward (stored 20): both ledger lines say Returns (no ROI), amount from 20%',
  (SELECT (r ->> 'mode') || '/' || (r ->> 'amount') FROM (SELECT public.t_v('rew_reinv')::jsonb r) s) || '/'
  || (SELECT string_agg(category || '=' || description, ' | ' ORDER BY category) FROM public.general_ledger
       WHERE idempotency_key = 'rent-reward:' || public.pid('rr_reinv') || ':1'),
  'reinvest/100000/roi_expense=Returns payout #1 auto-reinvested into portfolio | roi_reinvestment=Auto-reinvested Returns #1 (100,000) into portfolio');
SELECT public.t_check('R the stored rate wins over the rule (rr_unfunded stored 15 while off; off_ex20 is now 20 by the rule)',
  public.t_rate('off_ex20') || '/' || (SELECT (r ->> 'amount') || '@' || trim_scale((r ->> 'rate')::numeric) FROM (SELECT public.post_rent_facilitation_reward(public.pid('rr_unfunded'), 1) r) s),
  '20|existing_partner/60000@15');
SELECT public.t_check('R replay of the same payment: already_posted', (public.post_rent_facilitation_reward(public.pid('rr_ins'), 1) ->> 'status'), 'already_posted');
SELECT public.t_check('R no rent-reward ledger line anywhere says ROI (wallet, platform, reinvest; switch off and on)',
  (SELECT count(*) FILTER (WHERE description ~* 'ROI') || '/' || (count(*) >= 12) FROM public.general_ledger WHERE idempotency_key LIKE 'rent-reward:%'), '0/true');
INSERT INTO public.rent_requests (id, tenant_id, landlord_id, rent_amount, status, supporter_id, funded_at)
VALUES (public.pid('rr_nostamp'), gen_random_uuid(), gen_random_uuid(), 300000, 'funded', public.pid('ex15'), now() - interval '31 days');
DELETE FROM public.rent_facilitation_reward_rates WHERE rent_request_id = public.pid('rr_nostamp');
SELECT public.t_raises('R no stored rate -> RENT_REWARD_RATE_MISSING (nothing paid)', format('SELECT public.post_rent_facilitation_reward(%L::uuid, 1)', public.pid('rr_nostamp')),
  'RENT_REWARD_RATE_MISSING%');
SELECT public.t_check('R ... and nothing was recorded for it', (SELECT count(*)::text FROM public.supporter_roi_payments WHERE rent_request_id = public.pid('rr_nostamp')), '0');
SET ROLE authenticated;
SELECT public.t_raises('R browsers cannot write the stored rates', format('INSERT INTO public.rent_facilitation_reward_rates VALUES (%L, %L, 30, %L)', gen_random_uuid(), gen_random_uuid(), 'x'), '42501');
RESET ROLE;

-- Phase 2 re-applied after the cut-off, switch on (rolled back). Its backfill (round 4): a funding with no stored rate is decided
-- by the rule (rate and basis from partner_rates_for, decided now) when funded after the cut-off (or not funded), and at the
-- legacy 15 at its funded_at when funded before it; a stored row whose supporter changed while the stamp trigger was missing is
-- decided by the rule whenever the funding was made (as the live stamp trigger does); a stored row for the same supporter
-- stays, and so does a stored row whose rent request lost its supporter.
\if :{?MIG2}
\else
\set MIG2 ../../migrations/20261108161000_partner_return_policy_phase2.sql
\endif
SELECT public.t_as(NULL) IS NULL AS x \gset
BEGIN;
ALTER TABLE public.rent_requests DISABLE TRIGGER trg_zz_stamp_rent_reward_rate_ins;
ALTER TABLE public.rent_requests DISABLE TRIGGER trg_zz_stamp_rent_reward_rate_upd;
INSERT INTO public.rent_requests (id, tenant_id, landlord_id, rent_amount, status, supporter_id, funded_at) VALUES
  (public.pid('bf_post'),     gen_random_uuid(), gen_random_uuid(), 300000, 'funded',   public.pid('ex20'),  now()),
  (public.pid('bf_pre'),      gen_random_uuid(), gen_random_uuid(), 300000, 'funded',   public.pid('emp'),
     (SELECT cutoff_at - interval '1 day' FROM public.partner_return_policy)),
  (public.pid('bf_unfunded'), gen_random_uuid(), gen_random_uuid(), 300000, 'approved', public.pid('p_new'), NULL),
  (public.pid('bf_same'),     gen_random_uuid(), gen_random_uuid(), 300000, 'funded',   public.pid('ex15'),  now()),
  (public.pid('bf_moved'),    gen_random_uuid(), gen_random_uuid(), 300000, 'funded',   public.pid('ex15'),  now()),
  (public.pid('bf_moved_pre'), gen_random_uuid(), gen_random_uuid(), 300000, 'funded',  public.pid('ex15'),
     (SELECT cutoff_at - interval '2 days' FROM public.partner_return_policy)),
  (public.pid('bf_same_pre'), gen_random_uuid(), gen_random_uuid(), 300000, 'funded',   public.pid('ex15'),
     (SELECT cutoff_at - interval '3 days' FROM public.partner_return_policy)),
  (public.pid('bf_moved_pre_new'), gen_random_uuid(), gen_random_uuid(), 300000, 'funded', public.pid('ex15'),
     (SELECT cutoff_at - interval '4 days' FROM public.partner_return_policy)),
  (public.pid('bf_unset'),    gen_random_uuid(), gen_random_uuid(), 300000, 'funded',   public.pid('ex15'),
     (SELECT cutoff_at - interval '5 days' FROM public.partner_return_policy));
INSERT INTO public.rent_facilitation_reward_rates (rent_request_id, supporter_id, rate, basis, decided_at) VALUES
  (public.pid('bf_same'),      public.pid('ex15'), 17, 'existing_partner', now() - interval '1 hour'),
  (public.pid('bf_moved'),     public.pid('ex15'), 15, 'existing_partner', now() - interval '1 hour'),
  (public.pid('bf_moved_pre'), public.pid('ex15'), 15, 'legacy',           now() - interval '1 hour'),
  (public.pid('bf_same_pre'),  public.pid('ex15'), 17, 'legacy',           now() - interval '1 hour'),
  (public.pid('bf_moved_pre_new'), public.pid('ex15'), 15, 'legacy',       now() - interval '1 hour'),
  (public.pid('bf_unset'),     public.pid('ex15'), 15, 'legacy',           now() - interval '1 hour');
UPDATE public.rent_requests SET supporter_id = public.pid('emp') WHERE id IN (public.pid('bf_moved'), public.pid('bf_moved_pre'));
UPDATE public.rent_requests SET supporter_id = public.pid('p_new') WHERE id = public.pid('bf_moved_pre_new');
UPDATE public.rent_requests SET supporter_id = NULL WHERE id = public.pid('bf_unset');
ALTER TABLE public.rent_requests ENABLE TRIGGER trg_zz_stamp_rent_reward_rate_ins;
ALTER TABLE public.rent_requests ENABLE TRIGGER trg_zz_stamp_rent_reward_rate_upd;
SELECT (SELECT count(*) FROM public.rent_facilitation_reward_rates) AS bf_rows_before, now() AS bf_now,
       (SELECT enabled || '/' || (cutoff_at IS NOT NULL) FROM public.partner_return_policy) AS bf_pol \gset
\ir :MIG2
SELECT public.t_rate('ex20') || ' ' || public.t_rate('emp') || ' ' || public.t_rate('p_new') AS bf_rule,
       (SELECT string_agg(k || '=' || COALESCE((SELECT (x.supporter_id = public.pid(w)) || '|' || trim_scale(x.rate) || '|' || x.basis || '|'
                                                       || CASE WHEN x.decided_at = now() THEN 'now'
                                                               WHEN x.decided_at = rr.funded_at THEN 'funded_at'
                                                               WHEN x.decided_at = now() - interval '1 hour' THEN 'kept' ELSE x.decided_at::text END
                                                  FROM public.rent_facilitation_reward_rates x JOIN public.rent_requests rr ON rr.id = x.rent_request_id
                                                 WHERE x.rent_request_id = public.pid(k)), 'missing'), ' ' ORDER BY o)
          FROM unnest(ARRAY['bf_post','bf_pre','bf_unfunded','bf_same','bf_moved','bf_moved_pre','bf_same_pre','bf_moved_pre_new','bf_unset','rr_nostamp'],
                      ARRAY['ex20','emp','p_new','ex15','emp','emp','ex15','p_new','ex15','ex15']) WITH ORDINALITY u(k, w, o)) AS bf_rows,
       (SELECT count(*) FROM public.rent_facilitation_reward_rates) - :bf_rows_before AS bf_added,
       (now() = :'bf_now'::timestamptz) AS bf_same_tx \gset
ROLLBACK;
SELECT public.t_check('R backfill re-applied after the cut-off (switch on): the rule''s rates for the three supporters',
  :'bf_pol' || ' ' || :'bf_rule', 'true/true 20|existing_partner 20|employee 10|new');
SELECT public.t_check('R backfill re-apply (round 4): post-cut-off missing -> rule, now; pre-cut-off missing -> legacy 15 at funded_at; unfunded -> rule; same supporter kept (17, before or after the cut-off); changed supporter after AND before the cut-off -> rule, now (employee 20; a new partner 10, below legacy); supporter removed -> stored row left as it was',
  :'bf_rows', 'bf_post=true|20|existing_partner|now bf_pre=true|15|legacy|funded_at bf_unfunded=true|10|new|now bf_same=true|17|existing_partner|kept bf_moved=true|20|employee|now bf_moved_pre=true|20|employee|now bf_same_pre=true|17|legacy|kept bf_moved_pre_new=true|10|new|now bf_unset=true|15|legacy|kept rr_nostamp=true|15|legacy|funded_at');
SELECT public.t_check('R backfill re-apply: 4 rows added (bf_post, bf_pre, bf_unfunded and rr_nostamp, whose row the R section deleted; funded 31 days ago = before the cut-off), all in the apply''s transaction',
  :bf_added || '/' || :'bf_same_tx', '4/t');

-- Round 6 (d): Phase 1 re-applied over a database that still has the round-5 3-argument helper (as one switched on under the
-- round-5 text would), after the cut-off with the switch on (rolled back). The re-apply drops the 3-argument version first,
-- so exactly the 4-argument one is left (closed), and the rule it feeds still gives the W(v) answers.
\if :{?MIG1}
\else
\set MIG1 ../../migrations/20261108160000_partner_return_policy_phase1.sql
\endif
SELECT public.t_as(NULL) IS NULL AS x \gset
BEGIN;
CREATE FUNCTION public.partner_note_window_applies(p_owner uuid, p_agent uuid, p_person uuid)
 RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT CASE WHEN p_owner IS NOT NULL THEN p_owner = p_person
              ELSE p_agent IS DISTINCT FROM p_person END;
$function$;
REVOKE ALL ON FUNCTION public.partner_note_window_applies(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
SELECT (SELECT string_agg(oid::regprocedure::text, ' ; ' ORDER BY oid::regprocedure::text) FROM pg_proc
         WHERE proname = 'partner_note_window_applies' AND pronamespace = 'public'::regnamespace) AS ra_before \gset
\ir :MIG1
SELECT (SELECT string_agg(oid::regprocedure::text || '=' || COALESCE(proacl::text, 'default'), ' ; ' ORDER BY oid::regprocedure::text) FROM pg_proc
         WHERE proname = 'partner_note_window_applies' AND pronamespace = 'public'::regnamespace) AS ra_after,
       public.t_rate('wh') || ' ' || public.t_rate('wagent3') || ' ' || public.t_rate('wagent2') AS ra_rates \gset
ROLLBACK;
SELECT public.t_check('W (round 6, d) Phase 1 re-applied (after the cut-off, switch on; rolled back) over a round-5 database: before both overloads, after only the 4-argument one, closed; the rule still gives wh 15, wagent3 10, wagent2 10',
  :'ra_before' || ' | ' || :'ra_after' || ' | ' || :'ra_rates',
  'partner_note_window_applies(uuid,uuid,uuid) ; partner_note_window_applies(uuid,uuid,uuid,uuid) | partner_note_window_applies(uuid,uuid,uuid,uuid)={postgres=X/postgres} | 15|promissory_note 10|new 10|new');
SELECT public.t_check('W (round 6, d) after the rolled-back re-apply: still exactly the 4-argument helper',
  (SELECT string_agg(oid::regprocedure::text, ' ; ') FROM pg_proc WHERE proname = 'partner_note_window_applies' AND pronamespace = 'public'::regnamespace),
  'partner_note_window_applies(uuid,uuid,uuid,uuid)');

-- ===========================================================================
-- P. Supporter pool card with the switch on (money after the cut-off at each person's rate)
-- ===========================================================================
SELECT public.t_check('P only pre-cut-off contributions -> still production''s 15% numbers',
  ((public.get_supporter_pool_stats()::jsonb - 'obligationRatePct') = public._t_old_pool_stats()::jsonb)::text, 'true');
INSERT INTO public.general_ledger (amount, direction, category, user_id, source_table, transaction_date) VALUES
  (2000000, 'cash_in', 'supporter_rent_fund', public.pid('ex20'),  'test', now()),
  (1000000, 'cash_in', 'supporter_rent_fund', public.pid('p_new'), 'test', now());
SELECT public.t_check('P weighted rate = (4,234,567 x 15 + 2,000,000 x 20 + 1,000,000 x 10) / 7,234,567; obligation from it',
  (SELECT (s ->> 'obligationRatePct') || '/' || ((s ->> 'monthlyObligation')::numeric
            = round((7234567 - 250001) * ((4234567 * 15 + 2000000 * 20 + 1000000 * 10) / 7234567.0) / 100))
     FROM (SELECT public.get_supporter_pool_stats()::jsonb s) x),
  trim_scale(round((4234567 * 15 + 2000000 * 20 + 1000000 * 10) / 7234567.0, 2))::text || '/true');
SELECT public.t_check('P obligationRatePct never prints trailing zeros (whole rates print as 15, 20; mixed as 15.69)',
  (SELECT (s ->> 'obligationRatePct') !~ '\.([0-9]*0)?$' FROM (SELECT public.get_supporter_pool_stats()::jsonb s) x)::text || '/'
  || (SELECT position('trim_scale(round(v_rate, 2))' in pg_get_functiondef('public.get_supporter_pool_stats()'::regprocedure)) > 0)::text, 'true/true');
SELECT public.t_as('agent1') IS NULL AS x \gset
SELECT public.t_raises('P an agent cannot read the pool card', 'SELECT public.get_supporter_pool_stats()', '42501');
SELECT public.t_as(NULL) IS NULL AS x \gset

-- ===========================================================================
-- H. House progress notice with the switch on
-- ===========================================================================
DO $$ DECLARE v_h uuid; BEGIN
  SELECT h.id INTO v_h FROM public.partner_supported_houses h JOIN public.investor_portfolios ip ON ip.id = h.portfolio_id
   WHERE ip.investor_id = public.pid('ex20') AND h.monthly_rate = 20 LIMIT 1;
  PERFORM public.enqueue_funder_house_notice('on-' || v_h, 'earning_started', public.pid('ex20'), v_h, NULL, NULL, 'On house', 'Wakiso',
                                             1, 200000, 200000, 'Agent', now(), now());
  PERFORM public.enqueue_funder_house_notice('none-1', 'earning_started', public.pid('ex20'), gen_random_uuid(), NULL, gen_random_uuid(), 'Ghost', 'Wakiso',
                                             1, 200000, 200000, 'Agent', now(), now());
END $$;
SELECT public.t_check('H notice from the house''s stored 20: about UGX 40,000; with no stored rate: no figure',
  (SELECT string_agg(n.monthly_return || '/' || COALESCE(trim_scale(n.return_rate)::text, '-') || '/'
                     || (m.message LIKE '%about UGX 40,000 a month%') || '/' || (m.message NOT LIKE '%UGX%'), ' ' ORDER BY n.dedupe_key)
     FROM public.funder_house_progress_notices n JOIN public.notifications m ON m.event_key = n.dedupe_key WHERE n.dedupe_key LIKE 'none-%' OR n.dedupe_key LIKE 'on-%'),
  '0/-/false/true 40000/20/true/false');
SELECT public.t_check('H the worker was woken once per new notice (pg_net stand-in)', (SELECT count(*)::text FROM net._http_log WHERE body ? 'notice_id'), '3');

-- ===========================================================================
-- HR. The partner's list of houses booked through promissory notes (partner_supported_house_returns):
--     identical to production while every note is 15; afterwards each house earns its note's rate.
-- ===========================================================================
SELECT public.t_check('HR switch-off notes (hr_off, 15 legacy) give exactly production''s figures (plus return_rate 15 per house)',
  (SELECT ((r - 'houses') = (public.t_v('hr_off_old')::jsonb - 'houses')
           AND (SELECT jsonb_agg(h - 'return_rate' ORDER BY h ->> 'intent_id') FROM jsonb_array_elements(r -> 'houses') h)
             = (SELECT jsonb_agg(h ORDER BY h ->> 'intent_id') FROM jsonb_array_elements(public.t_v('hr_off_old')::jsonb -> 'houses') h))::text
          || '/' || (r ->> 'house_count') || '/' || (SELECT string_agg(DISTINCT h ->> 'return_rate', ',') FROM jsonb_array_elements(r -> 'houses') h)
          || '/' || (r ->> 'total_monthly_return') || '/' || (SELECT bool_or((h ->> 'monthly_paid_this_month')::boolean) FROM jsonb_array_elements(r -> 'houses') h)
     FROM (SELECT public.t_v('hr_off_new')::jsonb r) s), 'true/2/15/75000/true');
SELECT public.t_as('agent1') IS NULL AS x \gset
SELECT public.agent_create_promissory_note_for_houses('{"partner_name":"HR New","whatsapp_number":"0774000002","amount":300000}'::jsonb,
                                                     ARRAY[public.t2_house(300000)]) IS NOT NULL AS x \gset
SELECT public.t2_person('hr_new', 'countersigned', '0774000002') IS NOT NULL AS x \gset
SELECT public.t_as('hr_new') IS NULL AS x \gset
SELECT public.t_check('HR a note written after the cut-off for a new partner (10): the house earns 10% (round(300,000 x 10%) = 30,000; production would say 45,000)',
  (SELECT string_agg((h ->> 'return_rate') || '/' || (h ->> 'monthly_return') || '/' || (h ->> 'annual_return'), ',') || '|' || (r ->> 'total_monthly_return')
          || '|' || (public._t_old_house_returns() ->> 'total_monthly_return')
     FROM (SELECT public.partner_supported_house_returns() r) s, jsonb_array_elements(r -> 'houses') h GROUP BY r), '10/30000/360000|30000|45000');
SELECT public.t_as('ex20') IS NULL AS x \gset
SELECT public.t_check('HR an existing 20% partner''s note: their house earns 20% (round(200,000 x 20%) = 40,000)',
  (SELECT string_agg(DISTINCT (h ->> 'return_rate') || '/' || (h ->> 'monthly_return'), ',') FROM jsonb_array_elements(public.partner_supported_house_returns() -> 'houses') h),
  '20/40000');
SELECT public.t_as('hr_off') IS NULL AS x \gset
SELECT public.t_check('HR the switch-off notes keep their 15 after the switch-on (same figures as before)',
  ((public.partner_supported_house_returns() - 'houses') = (public.t_v('hr_off_new')::jsonb - 'houses'))::text, 'true');
-- Round 4: a note picked up by the caller's email or phone but linked to someone else shows no rate and no figures; the linked
-- person sees their own; the totals add only what is shown. agent_hr's profile is newer than emp's, so a note typed with
-- emp's phone as WhatsApp and agent_hr's own phone links to emp (the insert link takes the oldest matching profile).
DO $$ BEGIN
  PERFORM public.t2_person('agent_hr', 'none', '0772777060');
  INSERT INTO public.user_roles (user_id, role, enabled) VALUES (public.pid('agent_hr'), 'agent', true);
END $$;
SELECT public.t_as('agent_hr') IS NULL AS x \gset
SELECT public.agent_create_promissory_note_for_houses('{"partner_name":"HR Probe","whatsapp_number":"0772777021","phone_number":"0772777060","email":"agent_hr@partner.test","amount":300000}'::jsonb,
                                                     ARRAY[public.t2_house(300000)]) IS NOT NULL AS x \gset
SELECT public.agent_create_promissory_note_for_houses('{"partner_name":"HR Unlinked","whatsapp_number":"0772777061","email":"agent_hr@partner.test","amount":250000}'::jsonb,
                                                     ARRAY[public.t2_house(250000)]) IS NOT NULL AS x \gset
SELECT public.t_check('HR (round 4) an agent whose profile email AND phone match a note linked to emp (20): that house listed with return_rate/monthly/annual null; their unlinked note shows the public 10; totals = the shown figures only',
  (SELECT string_agg(COALESCE(h ->> 'return_rate', 'null') || '/' || COALESCE(h ->> 'monthly_return', 'null') || '/' || COALESCE(h ->> 'annual_return', 'null')
                     || '@' || (h ->> 'monthly_rent'), ',' ORDER BY (h ->> 'monthly_rent')::numeric)
          || '|' || (r ->> 'total_monthly_return') || '|' || (r ->> 'total_annual_return') || '|' || (r ->> 'house_count')
     FROM (SELECT public.partner_supported_house_returns() r) s, jsonb_array_elements(r -> 'houses') h GROUP BY r)
  || ' / ' || (SELECT (partner_user_id = public.pid('emp')) || '|' || trim_scale(return_rate) FROM public.promissory_notes WHERE partner_name = 'HR Probe'),
  '10/25000/300000@250000,null/null/null@300000|25000|300000|2 / true|20');
SELECT public.t_as('agent1') IS NULL AS x \gset
SELECT public.t_check('HR (round 4) agent1 (profile email typed on Probe Houses, linked to emp): every listed house whose note is linked to someone else has no rate or figures',
  (SELECT count(*) || '/' || bool_and(h ->> 'return_rate' IS NULL AND h ->> 'monthly_return' IS NULL AND h ->> 'annual_return' IS NULL)
     FROM jsonb_array_elements(public.partner_supported_house_returns() -> 'houses') h
     JOIN public.promissory_notes n ON n.id = (h ->> 'note_id')::uuid
    WHERE n.partner_user_id IS DISTINCT FROM public.pid('agent1') AND n.partner_user_id IS NOT NULL), '1/true');
SELECT public.t_as('emp') IS NULL AS x \gset
SELECT public.t_check('HR (round 4) the linked person (emp) sees that house with their own 20 (60,000 / 720,000); every house of theirs has figures; totals = the sum',
  (SELECT (SELECT (h ->> 'return_rate') || '/' || (h ->> 'monthly_return') || '/' || (h ->> 'annual_return') FROM jsonb_array_elements(r -> 'houses') h
            WHERE h ->> 'note_id' = (SELECT id::text FROM public.promissory_notes WHERE partner_name = 'HR Probe'))
          || '|' || (SELECT bool_and(h ->> 'return_rate' IS NOT NULL) FROM jsonb_array_elements(r -> 'houses') h)
          || '|' || ((r ->> 'total_monthly_return')::numeric = (SELECT sum((h ->> 'monthly_return')::numeric) FROM jsonb_array_elements(r -> 'houses') h))
     FROM (SELECT public.partner_supported_house_returns() r) s), '20/60000/720000|true|true');
SELECT public.t_as(NULL) IS NULL AS x \gset
SET ROLE anon;
SELECT public.t_raises('HR anon cannot call it', 'SELECT public.partner_supported_house_returns()', '42501');
RESET ROLE;

-- ===========================================================================
-- F. Monitoring: all checks ok; the right check fails when a creation path is reverted
-- ===========================================================================
SELECT public.t_check('F assert: 17 checks all ok at the end of the run',
  (SELECT count(*) || '/' || COALESCE(string_agg(check_name, ',') FILTER (WHERE NOT ok), 'all ok') FROM public.assert_partner_return_policy_intact()), '17/all ok');
SELECT public.t_vset('hr_def', pg_get_functiondef('public.hr_pay_post_staff_reinvestment(uuid)'::regprocedure));
\ir prod_hr_pay_post_staff_reinvestment.sql
SELECT public.t_check('F hr_pay_post_staff_reinvestment replaced by its production text -> exactly these checks fail',
  (SELECT string_agg(check_name, ',' ORDER BY check_name) FILTER (WHERE NOT ok) FROM public.assert_partner_return_policy_intact()),
  'creation_paths_use_rule,quotes_use_stored_or_public_rate');
SELECT public.t_vset('leaver2_p', public.t2_pay('leaver2', false)::text);
SELECT public.t_check('F ... and that production text, switch on, sends a leaver''s payroll portfolio to the CFO at 10 while telling them 20% (what Phase 2 fixes)',
  public.t2_fam(public.t_v('leaver2_p')::uuid) || '/'
  || (SELECT (position('earning 20% per month.' in message) > 0)::text FROM public.notifications WHERE user_id = public.pid('leaver2')),
  '10|new|e10|c:-|l:-|h:-|req:1|ret:-/true');
DO $$ BEGIN EXECUTE public.t_v('hr_def'); END $$;
SELECT public.t_check('F restored: all ok again (rates_conform ignores the queued request)',
  (SELECT COALESCE(string_agg(check_name, ',') FILTER (WHERE NOT ok), 'all ok') FROM public.assert_partner_return_policy_intact()), 'all ok');
SELECT public.t_vset('fcpp_def', pg_get_functiondef('public.funder_create_pending_portfolio(numeric,uuid,integer)'::regprocedure));
DO $$ BEGIN
  EXECUTE replace(replace(public.t_v('fcpp_def'), 'roi_mode, status, portfolio_pin', 'roi_percentage, roi_mode, status, portfolio_pin'),
                  $o$'monthly_payout', 'pending_ops_approval',$o$, $n$15, 'monthly_payout', 'pending_ops_approval',$n$);
END $$;
SELECT public.t_check('F a creation path typing roi_percentage again -> creation_paths_leave_rate_to_gate fails',
  (SELECT string_agg(check_name, ',' ORDER BY check_name) FILTER (WHERE NOT ok) FROM public.assert_partner_return_policy_intact()), 'creation_paths_leave_rate_to_gate');
DO $$ BEGIN EXECUTE public.t_v('fcpp_def'); END $$;
ALTER TABLE public.promissory_notes DISABLE TRIGGER trg_zz_partner_note_linked_late;
SELECT public.t_check('F late-link trigger disabled -> phase2_triggers_enabled fails',
  (SELECT string_agg(check_name, ',' ORDER BY check_name) FILTER (WHERE NOT ok) FROM public.assert_partner_return_policy_intact()), 'phase2_triggers_enabled');
ALTER TABLE public.promissory_notes ENABLE TRIGGER trg_zz_partner_note_linked_late;
SELECT public.t_vset('sum_def', pg_get_functiondef('public.empty_house_opportunity_summary(text,uuid)'::regprocedure));
DO $$ BEGIN EXECUTE replace(public.t_v('sum_def'), '(SELECT q.rate FROM quote q) / 100', '0.15'); END $$;
SELECT public.t_check('F a fixed 0.15 put back into the summary -> quotes_use_stored_or_public_rate fails',
  (SELECT string_agg(check_name, ',' ORDER BY check_name) FILTER (WHERE NOT ok) FROM public.assert_partner_return_policy_intact()), 'quotes_use_stored_or_public_rate');
SELECT public.t_vset('mails_before', public.t_emails('Partner Returns check%')::text);
SELECT public.t_vset('hr_def', pg_get_functiondef('public.partner_supported_house_returns()'::regprocedure));
DO $$ BEGIN EXECUTE replace(pg_get_functiondef('public._t_old_house_returns()'::regprocedure), 'FUNCTION public._t_old_house_returns(',
                            'FUNCTION public.partner_supported_house_returns('); END $$;
SELECT public.t_check('F partner_supported_house_returns put back to production''s fixed 0.15 -> quotes_use_stored_or_public_rate fails too',
  (SELECT string_agg(check_name, ',' ORDER BY check_name) FILTER (WHERE NOT ok) FROM public.assert_partner_return_policy_intact()),
  'quotes_use_stored_or_public_rate');
DO $$ BEGIN EXECUTE public.t_v('hr_def'); END $$;
SELECT public.t_vset('drift', public.record_partner_return_policy_drift()::text);
SELECT public.t_check('F drift recorder opens exactly that event and emails CEO+CFO once',
  public.t_v('drift') || '/' || (SELECT string_agg(check_name, ',') FROM public.money_path_drift_events WHERE resolved_at IS NULL)
  || '/' || (public.t_emails('Partner Returns check FAILED') - 0), '1/partner_rate.quotes_use_stored_or_public_rate/2');
DO $$ BEGIN EXECUTE public.t_v('sum_def'); END $$;
SELECT public.t_vset('drift', public.record_partner_return_policy_drift()::text);
SELECT public.t_check('F restored summary: the recorder resolves the event and sends the recovery mail',
  public.t_v('drift') || '/' || (SELECT count(*) FROM public.money_path_drift_events WHERE resolved_at IS NULL)
  || '/' || public.t_emails('Partner Returns check recovered'), '0/0/2');
-- release_ready cleared while the switch is on: that check (and only it) fails.
UPDATE public.partner_return_policy SET release_ready = false;
SELECT public.t_check('F release_ready cleared while the switch is on -> the release_ready check fails, and only it',
  (SELECT string_agg(check_name || ':' || (detail LIKE '%(ready=false)'), ',' ORDER BY check_name) FILTER (WHERE NOT ok) FROM public.assert_partner_return_policy_intact()),
  'release_ready:true');
UPDATE public.partner_return_policy SET release_ready = true;
-- A conformance problem is history, not a precondition: it does not stop a switch-on.
SELECT (public.set_partner_return_policy(false) ->> 'changed') AS x \gset
ALTER TABLE public.investor_portfolios DISABLE TRIGGER trg_partner_return_rate_policy;
INSERT INTO public._t_ids VALUES ('f_nogate', (SELECT public.t2_port('ex15', 33)));
ALTER TABLE public.investor_portfolios ENABLE TRIGGER trg_partner_return_rate_policy;
SELECT public.t_check('F a portfolio written past the gate after the cut-off -> only rates_conform fails',
  (SELECT string_agg(check_name, ',' ORDER BY check_name) FILTER (WHERE NOT ok) FROM public.assert_partner_return_policy_intact()), 'rates_conform');
SELECT public.t_check('F ... and the switch still goes back on (rates_conform is not a switch-on precondition)',
  (public.set_partner_return_policy(true) ->> 'changed'), 'true');
DELETE FROM public.investor_portfolios WHERE id = public.tid('f_nogate');
SELECT public.t_check('F release_ready stays true; switch still on; all 17 ok',
  (SELECT release_ready || '/' || enabled FROM public.partner_return_policy) || '/'
  || (SELECT count(*) || ':' || COALESCE(string_agg(check_name, ',') FILTER (WHERE NOT ok), 'all ok') FROM public.assert_partner_return_policy_intact()),
  'true/true/17:all ok');

-- ===========================================================================
-- A. The PostgREST login role (session_user authenticator, as in production) as anon
-- ===========================================================================
-- Same database as the runner (no hard-coded name), same host and port; only the login role changes.
CREATE POLICY _t_service_role_bypass ON public.promissory_notes FOR ALL TO service_role USING (true) WITH CHECK (true);
\c - authenticator
SET client_min_messages = warning;
-- Round 5: an edge function's request (PostgREST switches the authenticator login to service_role).
SET ROLE service_role;
SELECT public.t_vset('a_sr', session_user || '/' || current_user || ' | ' || public.t_edge_activate('S3 pending sy', 'sx', 'pending')
  || ' | ' || public.t_edge_activate('S5 pending unlinked', 'sx', 'pending'));
RESET ROLE;
SET ROLE anon;
SELECT public.t_raises('A anon via the PostgREST login role asking for a named partner''s rate is refused',
  format('SELECT public.partner_quote_rate(%L, %L::uuid)', 'partner', public.pid('ex20')), '42501');
SELECT public.t_check('A anon via the PostgREST login role: public rate 10', trim_scale(public.partner_quote_rate('public'))::text, '10');
RESET ROLE;
\c - postgres
SET client_min_messages = warning;
DROP POLICY _t_service_role_bypass ON public.promissory_notes;
SELECT public.t_check('A (round 5) service_role via the PostgREST login role (as an edge function): moving a linked note and linking an unlinked one are refused after the cut-off',
  public.t_v('a_sr') || ' | ' || public.t_note_state('S3 pending sy') || ' ' || public.t_note_state('S5 pending unlinked'),
  'authenticator/service_role | service_role 42501: A promissory note cannot be moved to another partner | service_role 42501: Link a promissory note to a partner through the partner-linking tools, not directly | pending|sy pending|nobody');

-- ===========================================================================
SELECT 'SUMMARY ' || count(*) FILTER (WHERE ok) || '/' || count(*) || ' passed'
       || COALESCE(' -- FAILED: ' || string_agg(name, '; ' ORDER BY n) FILTER (WHERE NOT ok), '')
  FROM public._t_results;
