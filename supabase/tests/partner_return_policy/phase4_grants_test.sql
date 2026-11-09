-- P7 (design v2 §2.4, §10.3): the Phase 4 grants matrix, by has_function_privilege. LOCAL THROWAWAY CLUSTER ONLY.
-- Run by run_phase4_tests.sh twice: on the stub's default ACL (new functions executable by PUBLIC unless revoked) and on
-- production's default ACL (new functions executable by the owner and service_role only), -v ACL_LABEL=stub_acl|prod_acl.
\pset tuples_only on
\pset format unaligned
\pset pager off
SET client_min_messages = warning;
CREATE TEMP TABLE _g (n serial, name text, got text, want text);
CREATE FUNCTION pg_temp.c(p_name text, p_got text, p_want text) RETURNS void LANGUAGE sql AS
  $$ INSERT INTO _g (name, got, want) VALUES (p_name, p_got, p_want) $$;
CREATE TEMP TABLE _m (fn text, anon boolean, auth boolean, svc boolean);
INSERT INTO _m VALUES
  ('public.partner_rate_visible_to_caller(uuid)',                 false, false, true),
  ('public._promissory_note_rate_view(public.promissory_notes,uuid)', false, false, false),
  ('public.lookup_promissory_note(text)',                          true,  true,  true),
  ('public.activate_promissory_note(text)',                        false, true,  false),
  ('public.partner_confirmed_login_emails(uuid[])',                false, false, true),
  ('public.profile_ids_by_emails(text[])',                         false, false, true),
  ('public._partner_return_phase4_checks(boolean)',                false, false, true),
  ('public.get_partner_return_report(date,date)',                  false, false, true),
  ('public.assistant_partner_new_portfolio_rate()',                false, true,  false),
  ('public.assert_partner_return_policy_intact()',                 false, false, true),
  ('public.get_portfolio_by_activation_token(uuid)',               true,  true,  true),
  ('public.agent_onboarded_portfolios()',                          false, true,  true),
  ('public.get_user_trust_profile(text)',                          false, true,  true),
  ('public.get_partner_wallet_hub(uuid,integer,integer)',          false, true,  true),
  ('public.get_public_trust_profile(text)',                        true,  true,  true);

SELECT pg_temp.c('P7 [' || :'ACL_LABEL' || '] ' || split_part(m.fn, '(', 1) || ': anon ' || CASE WHEN m.anon THEN 'yes' ELSE 'no' END
                 || ', authenticated ' || CASE WHEN m.auth THEN 'yes' ELSE 'no' END || ', service_role ' || CASE WHEN m.svc THEN 'yes' ELSE 'no' END,
                 has_function_privilege('anon', m.fn, 'EXECUTE') || '/' || has_function_privilege('authenticated', m.fn, 'EXECUTE') || '/'
                 || has_function_privilege('service_role', m.fn, 'EXECUTE'),
                 m.anon || '/' || m.auth || '/' || m.svc)
  FROM _m m;
SELECT pg_temp.c('P7 [' || :'ACL_LABEL' || '] the requester trigger function: not callable by anon or authenticated (service_role follows the default ACL: '
                 || has_function_privilege('service_role', 'public.portfolio_rate_requests_stamp_actor()', 'EXECUTE') || ')',
  has_function_privilege('anon', 'public.portfolio_rate_requests_stamp_actor()', 'EXECUTE') || '/'
  || has_function_privilege('authenticated', 'public.portfolio_rate_requests_stamp_actor()', 'EXECUTE'), 'false/false');
SELECT pg_temp.c('P7 [' || :'ACL_LABEL' || '] no Phase 4 function grants PUBLIC (no "=X/" entry)',
  (SELECT COALESCE(string_agg(p.proname, ',' ORDER BY p.proname), 'none') FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
    WHERE ns.nspname = 'public'
      AND p.proname IN ('partner_rate_visible_to_caller', '_promissory_note_rate_view', 'lookup_promissory_note', 'activate_promissory_note',
                        'portfolio_rate_requests_stamp_actor', 'partner_confirmed_login_emails', 'profile_ids_by_emails',
                        '_partner_return_phase4_checks', 'get_partner_return_report', 'assistant_partner_new_portfolio_rate')
      AND (p.proacl IS NULL OR EXISTS (SELECT 1 FROM unnest(p.proacl::text[]) a WHERE a LIKE '=%'))), 'none');
SELECT pg_temp.c('P7 [' || :'ACL_LABEL' || '] the five 4b readers keep exactly the ACL they had in production (CREATE OR REPLACE)',
  (SELECT COALESCE(string_agg(t.fn, ', '), 'unchanged') FROM public._t_p4_prod t JOIN pg_proc p ON p.oid = t.fn::regprocedure
    WHERE p.proacl::text IS DISTINCT FROM t.acl), 'unchanged');
SELECT pg_temp.c('P7 [' || :'ACL_LABEL' || '] new functions: SECURITY DEFINER except the note-rate helper (called only by owner-run functions), owner postgres, search_path pinned to public, pg_temp',
  (SELECT string_agg(p.proname || ':' || p.prosecdef || ':' || pg_get_userbyid(p.proowner) || ':' || COALESCE(array_to_string(p.proconfig, ';'), '-'), ' ' ORDER BY p.proname)
     FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
    WHERE ns.nspname = 'public'
      AND p.proname IN ('partner_rate_visible_to_caller', '_promissory_note_rate_view', 'lookup_promissory_note', 'activate_promissory_note',
                        'portfolio_rate_requests_stamp_actor', 'partner_confirmed_login_emails', 'profile_ids_by_emails',
                        '_partner_return_phase4_checks', 'get_partner_return_report', 'assistant_partner_new_portfolio_rate')),
  '_partner_return_phase4_checks:true:postgres:search_path=public, pg_temp _promissory_note_rate_view:false:postgres:search_path=public, pg_temp '
  || 'activate_promissory_note:true:postgres:search_path=public, pg_temp assistant_partner_new_portfolio_rate:true:postgres:search_path=public, pg_temp '
  || 'get_partner_return_report:true:postgres:search_path=public, pg_temp lookup_promissory_note:true:postgres:search_path=public, pg_temp '
  || 'partner_confirmed_login_emails:true:postgres:search_path=public, pg_temp partner_rate_visible_to_caller:true:postgres:search_path=public, pg_temp '
  || 'portfolio_rate_requests_stamp_actor:true:postgres:search_path=public, pg_temp profile_ids_by_emails:true:postgres:search_path=public, pg_temp');
SELECT pg_temp.c('P7 [' || :'ACL_LABEL' || '] the Phase 4 checks see their own grants as designed (activation_owner_run, rate_tools_backend_only ok)',
  (SELECT string_agg(check_name || '=' || ok, ' ' ORDER BY check_name) FROM public._partner_return_phase4_checks(false)
    WHERE check_name IN ('activation_owner_run', 'rate_tools_backend_only')), 'activation_owner_run=true rate_tools_backend_only=true');
SELECT CASE WHEN got IS NOT DISTINCT FROM want THEN 'PASS  ' || name ELSE 'FAIL  ' || name || '  got [' || COALESCE(got, '<null>') || '] want [' || COALESCE(want, '<null>') || ']' END
  FROM _g ORDER BY n;
SELECT 'SUMMARY P7 ' || :'ACL_LABEL' || ' ' || count(*) FILTER (WHERE got IS NOT DISTINCT FROM want) || '/' || count(*) || ' passed' FROM _g;
