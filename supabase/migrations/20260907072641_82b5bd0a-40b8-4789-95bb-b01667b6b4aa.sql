DO $do$
DECLARE
  fn text;
  src text;
BEGIN
  FOREACH fn IN ARRAY ARRAY['get_agent_collection_league_details','get_agent_collection_league_leaderboard'] LOOP
    SELECT pg_get_functiondef(p.oid) INTO src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname='public' AND p.proname=fn;

    src := replace(src,
      $$'performance_percentage', s.performance,$$,
      $$'team_avatar_url', pr.avatar_url,
           'performance_percentage', s.performance,$$);
    src := replace(src,
      $$'performance_percentage', p.performance,$$,
      $$'team_avatar_url', pr.avatar_url,
           'performance_percentage', p.performance,$$);
    EXECUTE src;
  END LOOP;
END
$do$;