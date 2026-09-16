-- Reversed collections: reporting sweep, batch 2.
--
-- Continues 20260910160000 / 170000 / 180000 / 190000. Batch 1 left roughly 71
-- reporting functions still counting reversed collections as money collected.
-- The 2026-09-15 incident makes two of them urgent: once 20260916180000 marks
-- 1,210 duplicate rows reversed, any surface that does not filter will keep
-- reporting UGX 136.6M collected against a UGX 6.08M bill.
--
-- THE RULE, restated from batch 1 because it is what makes this safe:
--   * AMOUNT reads must be filtered (what was collected).
--   * IDENTITY reads must NOT be, or agent counts move underneath every other
--     figure.
--   * WRITE targets must never be touched.
--
-- IN THIS BATCH
--   1. agent_ops_report_team_collections   one amount read
--   2. get_agent_ops_comprehensive_report  one amount read; its
--      `SELECT DISTINCT agent_id` universe is an IDENTITY read and is
--      deliberately left alone, exactly as agent_ops_collection_agents was in
--      batch 1.
--
-- NOT IN THIS BATCH, and deliberately so
--   get_agent_products_services_report has TWO overloads (p_date; p_date,
--   p_from) carrying 15 references between them, mixing `sum(ac.amount)`
--   totals with `SELECT ac.agent_id` universes. Each needs the judgement above
--   made individually, and batch 1 is explicit that a blind rewrite across
--   money-path functions "is the same class of change that inverted the
--   collection ledger on 2026-09-10". It also has a separate, pre-existing
--   accuracy problem: its expected_cumulative / daily_receivable basis is not
--   the pinned bill, so its coverage percentage is already not comparable to
--   the Command Center's. Both should be fixed together, not half-fixed here.
--
-- PATCHED IN PLACE rather than restated, following 20260910100000: the live
-- bodies are large and carry work that is not in this repository, so restating
-- them would risk clobbering it. Each patch is a no-op when already applied.

DO $sweep$
DECLARE
  v_def text;
  v_n   int := 0;
BEGIN
  -------------------------------------------------- 1. team collections report
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'agent_ops_report_team_collections';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'agent_ops_report_team_collections not found';
  END IF;

  IF position('ac.reversed_at IS NULL' in v_def) > 0 THEN
    RAISE NOTICE 'team collections already filtered';
  ELSE
    IF position(E'FROM public.agent_collections ac\n    WHERE ac.amount > 0' in v_def) = 0 THEN
      RAISE EXCEPTION 'team collections: expected amount-read anchor not found - inspect by hand';
    END IF;
    v_def := replace(v_def,
      E'FROM public.agent_collections ac\n    WHERE ac.amount > 0',
      E'FROM public.agent_collections ac\n    WHERE ac.reversed_at IS NULL\n      AND ac.amount > 0');
    EXECUTE v_def;
    v_n := v_n + 1;
  END IF;

  ------------------------------------------------- 2. comprehensive report
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'get_agent_ops_comprehensive_report';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'get_agent_ops_comprehensive_report not found';
  END IF;

  IF position('ac.reversed_at IS NULL' in v_def) > 0 THEN
    RAISE NOTICE 'comprehensive report already filtered';
  ELSE
    IF position('WHERE ac.created_at>=v_start AND ac.created_at<v_end' in v_def) = 0 THEN
      RAISE EXCEPTION 'comprehensive report: expected amount-read anchor not found - inspect by hand';
    END IF;
    v_def := replace(v_def,
      'WHERE ac.created_at>=v_start AND ac.created_at<v_end',
      'WHERE ac.reversed_at IS NULL AND ac.created_at>=v_start AND ac.created_at<v_end');
    EXECUTE v_def;
    v_n := v_n + 1;
  END IF;

  RAISE NOTICE 'reporting sweep batch 2: % function(s) patched', v_n;
END $sweep$;

-- Both amount reads filtered; the identity read left intact.
DO $verify$
DECLARE v_bad text;
BEGIN
  SELECT string_agg(p.proname, ', ') INTO v_bad
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname IN ('agent_ops_report_team_collections', 'get_agent_ops_comprehensive_report')
     AND position('reversed_at' in p.prosrc) = 0;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'still counting reversed collections: %', v_bad;
  END IF;

  IF (SELECT position('SELECT DISTINCT agent_id FROM public.agent_collections WHERE agent_id IS NOT NULL'
                      in p.prosrc)
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname='public' AND p.proname='get_agent_ops_comprehensive_report') = 0 THEN
    RAISE EXCEPTION 'the agent universe (identity read) was altered - agent counts would shift';
  END IF;

  RAISE NOTICE 'batch 2 verified: amount reads filtered, identity read intact';
END $verify$;
