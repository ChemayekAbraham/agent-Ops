-- Phase 4 test load step (LOCAL THROWAWAY CLUSTER ONLY). Run by run_phase4_tests.sh right after the 4b rollback file
-- put the five readers back to their production text (md5 = manifest), before Phase 1.
--   * _t_p4_prod: md5, ACL and text of the five production readers (P4/P10/L checks compare against them);
--   * _t_prod_<reader>: byte-for-byte copies of the production readers under test-only names, so the masked 4b
--     readers can be compared with what production returns for the same caller (P4, P11). The production
--     get_public_trust_profile calls get_user_trust_profile; its copy calls the copy, so it is production end to end.
--     _t_prod_raw_get_public_trust_profile is the same text still calling get_user_trust_profile (masked after 4b).
--   * _t_fn_before: the public functions that exist before the build.
SET client_min_messages = warning;
CREATE TABLE public._t_p4_prod AS
  SELECT f.fn, md5(pg_get_functiondef(f.fn::regprocedure)) AS md5, p.proacl::text AS acl, p.prosrc AS src
    FROM (VALUES ('public.get_portfolio_by_activation_token(uuid)'), ('public.agent_onboarded_portfolios()'),
                 ('public.get_user_trust_profile(text)'), ('public.get_public_trust_profile(text)'),
                 ('public.get_partner_wallet_hub(uuid,integer,integer)')) f(fn)
    JOIN pg_proc p ON p.oid = f.fn::regprocedure;
DO $c$
DECLARE r record; v text;
BEGIN
  FOR r IN SELECT * FROM (VALUES ('get_portfolio_by_activation_token', 'public.get_portfolio_by_activation_token(uuid)'),
                                 ('agent_onboarded_portfolios', 'public.agent_onboarded_portfolios()'),
                                 ('get_user_trust_profile', 'public.get_user_trust_profile(text)'),
                                 ('get_public_trust_profile', 'public.get_public_trust_profile(text)'),
                                 ('get_partner_wallet_hub', 'public.get_partner_wallet_hub(uuid,integer,integer)')) x(nm, fn)
  LOOP
    v := replace(pg_get_functiondef(r.fn::regprocedure), 'FUNCTION public.' || r.nm || '(', 'FUNCTION public._t_prod_' || r.nm || '(');
    IF r.nm = 'get_public_trust_profile' THEN
      IF position('get_user_trust_profile(p_ai_id)' in v) = 0 THEN RAISE EXCEPTION 'production get_public_trust_profile changed shape'; END IF;
      v := replace(v, 'get_user_trust_profile(p_ai_id)', 'public._t_prod_get_user_trust_profile(p_ai_id)');
    END IF;
    EXECUTE v;
    IF r.nm = 'get_public_trust_profile' THEN
      -- _t_prod_raw_get_public_trust_profile: production's public text calling get_user_trust_profile by name, so after
      -- 4b it runs over the MASKED answer (4b's public reader must equal it plus earning_returns).
      EXECUTE replace(pg_get_functiondef(r.fn::regprocedure), 'FUNCTION public.get_public_trust_profile(',
                      'FUNCTION public._t_prod_raw_get_public_trust_profile(');
    END IF;
  END LOOP;
END $c$;
GRANT EXECUTE ON FUNCTION public._t_prod_get_portfolio_by_activation_token(uuid), public._t_prod_agent_onboarded_portfolios(),
  public._t_prod_get_user_trust_profile(text), public._t_prod_get_public_trust_profile(text),
  public._t_prod_get_partner_wallet_hub(uuid, integer, integer), public._t_prod_raw_get_public_trust_profile(text) TO PUBLIC;
CREATE TABLE public._t_fn_before AS SELECT DISTINCT p.proname::text AS proname FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public';
SELECT 'prod copies ready';
