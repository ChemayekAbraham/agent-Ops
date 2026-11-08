-- P10 (design v2 §10.3): the state after the Phase 4 rollbacks (4b, then 4a-assistant, then 4a) and after re-applying
-- them. LOCAL THROWAWAY CLUSTER ONLY. Run by run_phase4_tests.sh rollback with -v PHASE=rolled_back | reapplied.
\pset tuples_only on
\pset format unaligned
\pset pager off
SET client_min_messages = warning;
CREATE TEMP TABLE _r (n serial, name text, got text, want text);
CREATE FUNCTION pg_temp.c(p_name text, p_got text, p_want text) RETURNS void LANGUAGE sql AS
  $$ INSERT INTO _r (name, got, want) VALUES (p_name, p_got, p_want) $$;
CREATE TEMP TABLE _names AS SELECT unnest(ARRAY['lookup_promissory_note', 'activate_promissory_note', 'partner_rate_visible_to_caller',
  '_promissory_note_rate_view', 'portfolio_rate_requests_stamp_actor', 'partner_confirmed_login_emails', 'profile_ids_by_emails',
  '_partner_return_phase4_checks', 'get_partner_return_report', 'assistant_partner_new_portfolio_rate',
  '_note_contact_proven', 'guard_note_window_link', '_promissory_note_funded_house_rates',
  'partner_returns_visible_to_caller']) AS proname;  -- the 14th is 4b's (Q8); its rollback drops it
-- Production's profile-driven linking and trust impl (loaded verbatim): no Phase 4 file may change them.
CREATE TEMP TABLE _prod_fixed (fn text, md5 text);
INSERT INTO _prod_fixed VALUES ('public.link_promissory_notes_for_user(uuid)', '9676d0b3179d3cf2caca650a3fac2883'),
  ('public.link_proxy_records_on_profile()', 'cb81fbf93e0de2dad377985c1b5bf41b'),
  ('public.trg_link_promissory_notes_on_profile()', '0029eb5d611c54d0819f2e1a17d57e75'),
  ('public._get_user_trust_profile_impl(uuid)', '08b63c3f50831c6d873376e1498bae63');
SELECT pg_temp.c('P10 ' || :'PHASE' || ': production''s link functions, profile triggers and trust impl untouched (md5 = production; both profile triggers enabled)',
  (SELECT count(*) FILTER (WHERE md5(pg_get_functiondef(fn::regprocedure)) = md5) || '/' || count(*) FROM _prod_fixed) || ' / '
  || (SELECT string_agg(tgname || '=' || tgenabled::text, ',' ORDER BY tgname) FROM pg_trigger
       WHERE tgrelid = 'public.profiles'::regclass AND tgname IN ('trg_link_proxy_records_on_profile', 'trg_profiles_link_promissory_notes')),
  '4/4 / trg_link_proxy_records_on_profile=O,trg_profiles_link_promissory_notes=O');
SELECT :'PHASE' = 'rolled_back' AS rolled_back \gset

\if :rolled_back
SELECT pg_temp.c('P10 rolled back: the five readers are byte for byte the production text (md5 = manifest = the captured production md5) with the production ACLs',
  (SELECT count(*) FILTER (WHERE md5(pg_get_functiondef(t.fn::regprocedure)) = t.md5
                             AND t.md5 = (SELECT m.doc -> 'functions' ->> (p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')')
                                            FROM public._t_manifest m, pg_proc p WHERE p.oid = t.fn::regprocedure)
                             AND (SELECT p.proacl::text FROM pg_proc p WHERE p.oid = t.fn::regprocedure) = t.acl)
     || '/' || count(*) FROM public._t_p4_prod t), '5/5');
SELECT pg_temp.c('P10 rolled back: none of the fourteen Phase 4 functions (4a 13 + 4b partner_returns_visible_to_caller) is left',
  (SELECT COALESCE(string_agg(p.proname, ','), 'none') FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
    WHERE ns.nspname = 'public' AND p.proname IN (SELECT proname FROM _names)), 'none');
SELECT pg_temp.c('P10 rolled back: the requester trigger and the note link hold trigger are gone',
  (SELECT count(*)::text FROM pg_trigger WHERE tgname IN ('trg_portfolio_rate_requests_stamp_actor', 'trg_zz_guard_note_window_link')), '0');
SELECT pg_temp.c('P10 rolled back: the forged-event policy (Q5) is gone; the carve-out link guard (Phase 1, Q1; T2 investor moves) stays on INSERT OR UPDATE OF locked_from_portfolio_id, investor_id',
  (SELECT count(*)::text FROM pg_policies WHERE schemaname = 'public' AND tablename = 'system_events' AND policyname = 'system_events_no_browser_link_held')
  || '/' || (SELECT (pg_get_triggerdef(t.oid) LIKE '%BEFORE INSERT OR UPDATE OF locked_from_portfolio_id, investor_id, status ON public.investor_portfolios%')::text || '=' || t.tgenabled::text
               FROM pg_trigger t WHERE t.tgname = 'trg_partner_return_carry_guard'), '0/true=O');
SELECT pg_temp.c('P10 rolled back: the assert is byte for byte Phase 2''s (md5 captured before 4a); 17 checks, all ok',
  (md5(pg_get_functiondef('public.assert_partner_return_policy_intact()'::regprocedure)) = (SELECT v FROM public._t_p4_state WHERE k = 'assert_md5_phase2'))::text
  || '/' || (SELECT count(*) || '/' || COALESCE(string_agg(check_name, ',') FILTER (WHERE NOT ok), 'all ok') FROM public.assert_partner_return_policy_intact()),
  'true/17/all ok');
SELECT pg_temp.c('P10 rolled back: the assert keeps its grants (service_role only)',
  (SELECT has_function_privilege('service_role', 'public.assert_partner_return_policy_intact()', 'EXECUTE') || '/'
       || has_function_privilege('authenticated', 'public.assert_partner_return_policy_intact()', 'EXECUTE') || '/'
       || has_function_privilege('anon', 'public.assert_partner_return_policy_intact()', 'EXECUTE')), 'true/false/false');
SELECT pg_temp.c('P10 rolled back: backfilled notice rates stay (data forward)',
  (SELECT string_agg(b.partner_name || '=' || COALESCE(trim_scale(b.return_rate)::text, '-'), ' ' ORDER BY b.partner_name)
     FROM public.promissory_house_booking_notices b WHERE b.partner_name LIKE 'P9 %'),
  'P9 funded mixed=- P9 funded one rate=12 P9 half sent=15 P9 reserved=15 P9 sent=-');
\else
SELECT pg_temp.c('P10 re-applied: the fourteen Phase 4 functions exist again',
  (SELECT count(DISTINCT p.proname)::text FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
    WHERE ns.nspname = 'public' AND p.proname IN (SELECT proname FROM _names)), '14');
SELECT pg_temp.c('P10 re-applied: the five readers carry the 4b marker again and keep the production ACLs',
  (SELECT count(*) FILTER (WHERE position('Partner Returns Phase 4b' in p.prosrc) > 0 AND p.proacl::text = t.acl) || '/' || count(*)
     FROM public._t_p4_prod t JOIN pg_proc p ON p.oid = t.fn::regprocedure), '5/5');
SELECT pg_temp.c('P10 re-applied: the assert has the Phase 4 hook again: 26 checks, all ok (the P9 seed''s unsent mixed-rate funded notice is not counted: S6)',
  (SELECT count(*) || '/' || COALESCE(string_agg(check_name, ',') FILTER (WHERE NOT ok), 'all ok') FROM public.assert_partner_return_policy_intact()),
  '26/all ok');
SELECT pg_temp.c('P10 re-applied: the requester trigger and the note link hold trigger are back and enabled',
  (SELECT string_agg(tgname || '=' || tgenabled::text, ',' ORDER BY tgname) FROM pg_trigger
    WHERE tgname IN ('trg_portfolio_rate_requests_stamp_actor', 'trg_zz_guard_note_window_link')),
  'trg_portfolio_rate_requests_stamp_actor=O,trg_zz_guard_note_window_link=O');
SELECT pg_temp.c('P10 re-applied: the hold covers partner_user_id and agent_id again, and the forged-event policy is back (RESTRICTIVE INSERT for authenticated, anon)',
  (SELECT (pg_get_triggerdef(t.oid) LIKE '%BEFORE UPDATE OF partner_user_id, agent_id ON public.promissory_notes%')::text FROM pg_trigger t WHERE t.tgname = 'trg_zz_guard_note_window_link')
  || '/' || (SELECT permissive || ':' || cmd || ':' || (SELECT string_agg(r::text, ',' ORDER BY r::text) FROM unnest(roles) r) FROM pg_policies
               WHERE schemaname = 'public' AND tablename = 'system_events' AND policyname = 'system_events_no_browser_link_held'),
  'true/RESTRICTIVE:INSERT:anon,authenticated');
\endif
SELECT CASE WHEN got IS NOT DISTINCT FROM want THEN 'PASS  ' || name ELSE 'FAIL  ' || name || '  got [' || COALESCE(got, '<null>') || '] want [' || COALESCE(want, '<null>') || ']' END
  FROM _r ORDER BY n;
SELECT 'SUMMARY P10 ' || :'PHASE' || ' ' || count(*) FILTER (WHERE got IS NOT DISTINCT FROM want) || '/' || count(*) || ' passed' FROM _r;
