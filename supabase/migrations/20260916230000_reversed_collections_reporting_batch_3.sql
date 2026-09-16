-- Reversed collections: reporting sweep, batch 3.
--
-- Continues 20260910160000..190000 (batch 1) and 20260916210000 (batch 2).
-- Takes the five surfaces where a wrong collected figure is most visible, and
-- most expensive:
--
--   get_coo_overview_snapshot           COO headline
--   get_ceo_growth_quality              CEO headline
--   agent_ops_report_agent              the per-agent report
--   get_agent_collection_league_details the leaderboard - a wrong figure here
--                                       PAYS THE WRONG PERSON
--   get_agent_daily_activity_report     daily activity
--
-- THE RULE, again, because it is what makes this safe (batch 1):
--   * AMOUNT reads must be filtered.
--   * IDENTITY reads must NOT be, or agent and tenant counts move underneath
--     every other figure.
--   * WRITE targets must never be touched.
--
-- Seventeen call sites across these five, and they are NOT uniform. Left
-- deliberately unfiltered:
--   get_coo_overview_snapshot     line 46  SELECT DISTINCT tenant_id  (universe)
--                                 line 52  SELECT DISTINCT agent_id   (universe)
--   get_agent_daily_activity_report line 55, 68  SELECT agent_id      (who was
--                                 active at all today - a person who collected
--                                 and had it reversed was still out working)
--
-- A BUG FOUND ON THE WAY
-- get_agent_collection_league_details already tried to exclude reversals with
--   COALESCE(c.notes,'') NOT ILIKE '%[REVERSED]%'
-- That pattern needs a literal "[REVERSED]". Every reversal this system writes
-- is "[REVERSED: <reason>]" - agent_reverse_tenant_allocation appends
-- ' [REVERSED: ' || reason || ']', and so does 20260916180000. The closing
-- bracket never sits against the word, so the filter has matched NOTHING since
-- it was written, and the leaderboard has been counting reversed collections
-- the whole time. Replaced with the reversed_at column, which is what batch 1
-- made authoritative.

DO $b3$
DECLARE v_def text; v_n int := 0;
BEGIN
  ---------------------------------------------------------------- 1. COO snapshot
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='get_coo_overview_snapshot';
  IF v_def IS NULL THEN RAISE EXCEPTION 'get_coo_overview_snapshot missing'; END IF;
  IF position('reversed_at' in v_def) = 0 THEN
    IF position(E'FROM agent_collections\n         WHERE created_at >= v_start AND created_at < v_end)' in v_def) = 0
       OR position(E'FROM agent_collections\n    WHERE created_at >= v_start AND created_at < v_end' in v_def) = 0
       OR position('SELECT (created_at AT TIME ZONE ''Africa/Kampala'')::date AS day, amount FROM agent_collections' in v_def) = 0
    THEN RAISE EXCEPTION 'coo snapshot: an expected anchor is missing - inspect by hand'; END IF;

    v_def := replace(v_def,
      E'FROM agent_collections\n         WHERE created_at >= v_start AND created_at < v_end)',
      E'FROM agent_collections\n         WHERE reversed_at IS NULL AND created_at >= v_start AND created_at < v_end)');
    v_def := replace(v_def,
      E'FROM agent_collections\n    WHERE created_at >= v_start AND created_at < v_end',
      E'FROM agent_collections\n    WHERE reversed_at IS NULL AND created_at >= v_start AND created_at < v_end');
    v_def := replace(v_def,
      'SELECT (created_at AT TIME ZONE ''Africa/Kampala'')::date AS day, amount FROM agent_collections',
      'SELECT (created_at AT TIME ZONE ''Africa/Kampala'')::date AS day, amount FROM agent_collections WHERE reversed_at IS NULL');
    EXECUTE v_def; v_n := v_n + 1;
  END IF;

  ---------------------------------------------------------------- 2. CEO growth
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='get_ceo_growth_quality';
  IF v_def IS NULL THEN RAISE EXCEPTION 'get_ceo_growth_quality missing'; END IF;
  IF position('reversed_at' in v_def) = 0 THEN
    IF position('from public.agent_collections where created_at >= v_from;' in v_def) = 0
       OR position(E'from public.agent_collections\n  where (created_at at time zone ''Africa/Kampala'')::date = v_today;' in v_def) = 0
    THEN RAISE EXCEPTION 'ceo growth: an expected anchor is missing - inspect by hand'; END IF;

    v_def := replace(v_def,
      'from public.agent_collections where created_at >= v_from;',
      'from public.agent_collections where reversed_at is null and created_at >= v_from;');
    v_def := replace(v_def,
      E'from public.agent_collections\n  where (created_at at time zone ''Africa/Kampala'')::date = v_today;',
      E'from public.agent_collections\n  where reversed_at is null and (created_at at time zone ''Africa/Kampala'')::date = v_today;');
    EXECUTE v_def; v_n := v_n + 1;
  END IF;

  ---------------------------------------------------------------- 3. agent report
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='agent_ops_report_agent';
  IF v_def IS NULL THEN RAISE EXCEPTION 'agent_ops_report_agent missing'; END IF;
  IF position('reversed_at' in v_def) = 0 THEN
    IF position(E'FROM public.agent_collections ac\n    WHERE ac.amount > 0' in v_def) = 0
       OR position(E'FROM public.agent_collections ac\n    WHERE ac.agent_id = p_agent_id AND ac.amount > 0' in v_def) = 0
       OR position('FROM public.agent_collections ac WHERE ac.agent_id = p_agent_id AND ac.amount > 0' in v_def) = 0
    THEN RAISE EXCEPTION 'agent report: an expected anchor is missing - inspect by hand'; END IF;

    -- two identical block reads (the plan-scoped CTEs) plus the agent-scoped one
    v_def := replace(v_def,
      E'FROM public.agent_collections ac\n    WHERE ac.amount > 0',
      E'FROM public.agent_collections ac\n    WHERE ac.reversed_at IS NULL AND ac.amount > 0');
    v_def := replace(v_def,
      E'FROM public.agent_collections ac\n    WHERE ac.agent_id = p_agent_id AND ac.amount > 0',
      E'FROM public.agent_collections ac\n    WHERE ac.reversed_at IS NULL AND ac.agent_id = p_agent_id AND ac.amount > 0');
    -- collected_window (SUM) and payments_window (COUNT) share one inline shape.
    -- The count is filtered too: it counts payments taken, not agents who exist.
    v_def := replace(v_def,
      'FROM public.agent_collections ac WHERE ac.agent_id = p_agent_id AND ac.amount > 0',
      'FROM public.agent_collections ac WHERE ac.reversed_at IS NULL AND ac.agent_id = p_agent_id AND ac.amount > 0');
    EXECUTE v_def; v_n := v_n + 1;
  END IF;

  ---------------------------------------------------------------- 4. league table
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='get_agent_collection_league_details';
  IF v_def IS NULL THEN RAISE EXCEPTION 'get_agent_collection_league_details missing'; END IF;
  IF position('c.reversed_at IS NULL' in v_def) = 0 THEN
    IF position('COALESCE(c.notes, '''') NOT ILIKE ''%[REVERSED]%''' in v_def) = 0
    THEN RAISE EXCEPTION 'league: the broken notes filter was not found - inspect by hand'; END IF;
    -- The notes pattern never matched "[REVERSED: reason]". Use the column.
    v_def := replace(v_def,
      'COALESCE(c.notes, '''') NOT ILIKE ''%[REVERSED]%''',
      'c.reversed_at IS NULL');
    EXECUTE v_def; v_n := v_n + 1;
  END IF;

  ---------------------------------------------------------------- 5. daily activity
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='get_agent_daily_activity_report';
  IF v_def IS NULL THEN RAISE EXCEPTION 'get_agent_daily_activity_report missing'; END IF;
  IF position('reversed_at' in v_def) = 0 THEN
    IF position(E'FROM public.agent_collections\n    WHERE created_at >= v_start AND created_at < v_end;' in v_def) = 0
       OR position('SELECT agent_id, ''collection'' AS kind, amount FROM public.agent_collections WHERE created_at >= v_start' in v_def) = 0
    THEN RAISE EXCEPTION 'daily activity: an expected anchor is missing - inspect by hand'; END IF;

    v_def := replace(v_def,
      E'FROM public.agent_collections\n    WHERE created_at >= v_start AND created_at < v_end;',
      E'FROM public.agent_collections\n    WHERE reversed_at IS NULL AND created_at >= v_start AND created_at < v_end;');
    v_def := replace(v_def,
      'SELECT agent_id, ''collection'' AS kind, amount FROM public.agent_collections WHERE created_at >= v_start',
      'SELECT agent_id, ''collection'' AS kind, amount FROM public.agent_collections WHERE reversed_at IS NULL AND created_at >= v_start');
    -- lines 55 and 68 (SELECT agent_id ... ) are the "who was active" universe
    -- and are deliberately left alone.
    EXECUTE v_def; v_n := v_n + 1;
  END IF;

  RAISE NOTICE 'reporting sweep batch 3: % function(s) patched', v_n;
END $b3$;

DO $verify$
DECLARE v_bad text;
BEGIN
  SELECT string_agg(p.proname, ', ') INTO v_bad
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public'
     AND p.proname IN ('get_coo_overview_snapshot','get_ceo_growth_quality','agent_ops_report_agent',
                       'get_agent_collection_league_details','get_agent_daily_activity_report')
     AND position('reversed_at' in p.prosrc) = 0;
  IF v_bad IS NOT NULL THEN RAISE EXCEPTION 'still unfiltered: %', v_bad; END IF;

  -- The universes must survive untouched.
  IF (SELECT position('SELECT DISTINCT agent_id AS id FROM agent_collections WHERE agent_id IS NOT NULL' in p.prosrc)
        FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
       WHERE n.nspname='public' AND p.proname='get_coo_overview_snapshot') = 0
  THEN RAISE EXCEPTION 'coo snapshot agent universe was altered - counts would shift'; END IF;

  RAISE NOTICE 'batch 3 verified: amount reads filtered, universes intact';
END $verify$;
