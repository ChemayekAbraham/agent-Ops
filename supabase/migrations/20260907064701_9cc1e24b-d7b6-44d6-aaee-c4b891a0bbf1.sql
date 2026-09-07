-- =========================================================
-- AGENT COLLECTION LEAGUE — data correctness layer
-- =========================================================

-- 1) Team membership history (historical attribution)
CREATE TABLE IF NOT EXISTS public.agent_team_membership_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_agent_id uuid NOT NULL,
  member_agent_id uuid NOT NULL,
  valid_from timestamptz NOT NULL DEFAULT now(),
  valid_to timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.agent_team_membership_history TO authenticated;
GRANT ALL ON public.agent_team_membership_history TO service_role;
ALTER TABLE public.agent_team_membership_history ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Members and parents read own membership history" ON public.agent_team_membership_history;
CREATE POLICY "Members and parents read own membership history"
ON public.agent_team_membership_history FOR SELECT TO authenticated
USING (member_agent_id = auth.uid() OR parent_agent_id = auth.uid() OR public.is_ops_role(auth.uid()));

CREATE UNIQUE INDEX IF NOT EXISTS agent_team_membership_one_open
  ON public.agent_team_membership_history (member_agent_id) WHERE valid_to IS NULL;
CREATE INDEX IF NOT EXISTS idx_agent_team_membership_parent
  ON public.agent_team_membership_history (parent_agent_id, valid_from);
CREATE INDEX IF NOT EXISTS idx_agent_team_membership_member_window
  ON public.agent_team_membership_history (member_agent_id, valid_from, valid_to);

-- Backfill from the current active links (created_at is the best available start)
INSERT INTO public.agent_team_membership_history (parent_agent_id, member_agent_id, valid_from)
SELECT s.parent_agent_id, s.sub_agent_id, COALESCE(s.accepted_at, s.verified_at, s.created_at)
FROM public.agent_subagents s
WHERE s.status IN ('verified', 'active', 'accepted')
  AND NOT EXISTS (
    SELECT 1 FROM public.agent_team_membership_history h
    WHERE h.member_agent_id = s.sub_agent_id AND h.valid_to IS NULL
  );

-- Keep history in sync with the link table
CREATE OR REPLACE FUNCTION public.sync_agent_team_membership_history()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_active boolean := NEW.status IN ('verified', 'active', 'accepted');
BEGIN
  IF v_active THEN
    UPDATE public.agent_team_membership_history
       SET valid_to = now()
     WHERE member_agent_id = NEW.sub_agent_id
       AND valid_to IS NULL
       AND parent_agent_id <> NEW.parent_agent_id;

    IF NOT EXISTS (
      SELECT 1 FROM public.agent_team_membership_history
      WHERE member_agent_id = NEW.sub_agent_id
        AND parent_agent_id = NEW.parent_agent_id
        AND valid_to IS NULL
    ) THEN
      INSERT INTO public.agent_team_membership_history (parent_agent_id, member_agent_id, valid_from)
      VALUES (NEW.parent_agent_id, NEW.sub_agent_id,
              COALESCE(NEW.accepted_at, NEW.verified_at, NEW.created_at, now()));
    END IF;
  ELSE
    UPDATE public.agent_team_membership_history
       SET valid_to = now()
     WHERE member_agent_id = NEW.sub_agent_id
       AND valid_to IS NULL;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_agent_team_membership_history ON public.agent_subagents;
CREATE TRIGGER trg_sync_agent_team_membership_history
AFTER INSERT OR UPDATE OF status, parent_agent_id ON public.agent_subagents
FOR EACH ROW EXECUTE FUNCTION public.sync_agent_team_membership_history();

-- 2) Daily team aggregate (single authoritative aggregation layer)
CREATE TABLE IF NOT EXISTS public.agent_team_daily_collection_stats (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stat_date date NOT NULL,
  parent_agent_id uuid NOT NULL,
  expected_amount numeric(14,2) NOT NULL DEFAULT 0,
  collected_amount numeric(14,2) NOT NULL DEFAULT 0,
  collection_count integer NOT NULL DEFAULT 0,
  total_team_members integer NOT NULL DEFAULT 0,
  active_collectors integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.agent_team_daily_collection_stats TO authenticated;
GRANT ALL ON public.agent_team_daily_collection_stats TO service_role;
ALTER TABLE public.agent_team_daily_collection_stats ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Own team reads daily league stats" ON public.agent_team_daily_collection_stats;
CREATE POLICY "Own team reads daily league stats"
ON public.agent_team_daily_collection_stats FOR SELECT TO authenticated
USING (
  parent_agent_id = auth.uid()
  OR public.is_ops_role(auth.uid())
  OR EXISTS (
    SELECT 1 FROM public.agent_team_membership_history h
    WHERE h.parent_agent_id = agent_team_daily_collection_stats.parent_agent_id
      AND h.member_agent_id = auth.uid()
      AND h.valid_to IS NULL
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS agent_team_daily_stats_unique
  ON public.agent_team_daily_collection_stats (parent_agent_id, stat_date);
CREATE INDEX IF NOT EXISTS idx_agent_team_daily_stats_date
  ON public.agent_team_daily_collection_stats (stat_date);

CREATE OR REPLACE FUNCTION public.touch_agent_team_daily_stats()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;

DROP TRIGGER IF EXISTS trg_touch_agent_team_daily_stats ON public.agent_team_daily_collection_stats;
CREATE TRIGGER trg_touch_agent_team_daily_stats
BEFORE UPDATE ON public.agent_team_daily_collection_stats
FOR EACH ROW EXECUTE FUNCTION public.touch_agent_team_daily_stats();

-- Kampala week start (Monday)
CREATE OR REPLACE FUNCTION public.agent_league_week_start(p_ts timestamptz DEFAULT now())
RETURNS date LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT (date_trunc('week', timezone('Africa/Kampala', p_ts)))::date;
$$;

-- Team resolution: the parent agent whose team the user belongs to (or the user themself)
CREATE OR REPLACE FUNCTION public.agent_league_team_parent(p_user uuid)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(
    (SELECT h.parent_agent_id FROM public.agent_team_membership_history h
      WHERE h.member_agent_id = p_user AND h.valid_to IS NULL
      ORDER BY h.valid_from DESC LIMIT 1),
    p_user
  );
$$;

-- Heat level mapping (single source of truth)
CREATE OR REPLACE FUNCTION public.agent_league_heat_level(p_expected numeric, p_collected numeric)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT CASE
    WHEN COALESCE(p_expected, 0) <= 0 THEN 'none'
    WHEN COALESCE(p_collected, 0) <= 0 THEN 'dark_red'
    WHEN (p_collected / p_expected) * 100 < 40 THEN 'red'
    WHEN (p_collected / p_expected) * 100 < 60 THEN 'light_red'
    WHEN (p_collected / p_expected) * 100 < 80 THEN 'light_green'
    WHEN (p_collected / p_expected) * 100 < 100 THEN 'green'
    ELSE 'dark_green'
  END;
$$;

-- 3) Reconciliation: rebuild the daily aggregate for a date range from authoritative data
CREATE OR REPLACE FUNCTION public.reconcile_agent_team_daily_stats(
  p_start date DEFAULT (timezone('Africa/Kampala', now()))::date - 7,
  p_end   date DEFAULT (timezone('Africa/Kampala', now()))::date
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rows integer := 0;
BEGIN
  DELETE FROM public.agent_team_daily_collection_stats
  WHERE stat_date BETWEEN p_start AND p_end;

  WITH days AS (
    SELECT d::date AS stat_date FROM generate_series(p_start, p_end, interval '1 day') d
  ),
  expected AS (
    SELECT
      COALESCE(h.parent_agent_id, p.agent_id) AS parent_agent_id,
      p.day AS stat_date,
      SUM(p.expected_ugx)::numeric AS expected_amount
    FROM public.agent_expected_day_plans p
    LEFT JOIN public.agent_team_membership_history h
      ON h.member_agent_id = p.agent_id
     AND h.valid_from::date <= p.day
     AND (h.valid_to IS NULL OR h.valid_to::date >= p.day)
    WHERE p.day BETWEEN p_start AND p_end
      AND p.agent_id IS NOT NULL
    GROUP BY 1, 2
  ),
  valid_collections AS (
    SELECT
      c.agent_id,
      (timezone('Africa/Kampala', c.created_at))::date AS stat_date,
      c.amount
    FROM public.agent_collections c
    WHERE c.amount > 0
      AND COALESCE(c.notes, '') NOT ILIKE '%[REVERSED]%'
      AND (timezone('Africa/Kampala', c.created_at))::date BETWEEN p_start AND p_end
  ),
  collected AS (
    SELECT
      COALESCE(h.parent_agent_id, vc.agent_id) AS parent_agent_id,
      vc.stat_date,
      SUM(vc.amount)::numeric AS collected_amount,
      COUNT(*)::int AS collection_count,
      COUNT(DISTINCT vc.agent_id)::int AS active_collectors
    FROM valid_collections vc
    LEFT JOIN public.agent_team_membership_history h
      ON h.member_agent_id = vc.agent_id
     AND h.valid_from::date <= vc.stat_date
     AND (h.valid_to IS NULL OR h.valid_to::date >= vc.stat_date)
    GROUP BY 1, 2
  ),
  team_size AS (
    SELECT d.stat_date, h.parent_agent_id, COUNT(DISTINCT h.member_agent_id)::int + 1 AS total_team_members
    FROM days d
    JOIN public.agent_team_membership_history h
      ON h.valid_from::date <= d.stat_date
     AND (h.valid_to IS NULL OR h.valid_to::date >= d.stat_date)
    GROUP BY 1, 2
  ),
  merged AS (
    SELECT parent_agent_id, stat_date FROM expected
    UNION SELECT parent_agent_id, stat_date FROM collected
    UNION SELECT parent_agent_id, stat_date FROM team_size
  )
  INSERT INTO public.agent_team_daily_collection_stats
    (stat_date, parent_agent_id, expected_amount, collected_amount, collection_count, total_team_members, active_collectors)
  SELECT
    m.stat_date,
    m.parent_agent_id,
    COALESCE(e.expected_amount, 0),
    COALESCE(c.collected_amount, 0),
    COALESCE(c.collection_count, 0),
    COALESCE(t.total_team_members, 1),
    COALESCE(c.active_collectors, 0)
  FROM merged m
  LEFT JOIN expected e ON e.parent_agent_id = m.parent_agent_id AND e.stat_date = m.stat_date
  LEFT JOIN collected c ON c.parent_agent_id = m.parent_agent_id AND c.stat_date = m.stat_date
  LEFT JOIN team_size t ON t.parent_agent_id = m.parent_agent_id AND t.stat_date = m.stat_date;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows;
END;
$$;

REVOKE ALL ON FUNCTION public.reconcile_agent_team_daily_stats(date, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reconcile_agent_team_daily_stats(date, date) TO service_role;

-- 4) Weekly ranking (window function, one pass, deterministic)
CREATE OR REPLACE FUNCTION public.agent_league_week_ranks(p_week_start date)
RETURNS TABLE (
  parent_agent_id uuid,
  expected_amount numeric,
  collected_amount numeric,
  performance numeric,
  active_rate numeric,
  consistency integer,
  total_members integer,
  active_collectors integer,
  team_rank integer
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH weekly AS (
    SELECT
      s.parent_agent_id,
      SUM(s.expected_amount) AS expected_amount,
      SUM(s.collected_amount) AS collected_amount,
      MAX(s.total_team_members) AS total_members,
      MAX(s.active_collectors) AS active_collectors,
      COUNT(*) FILTER (WHERE s.expected_amount > 0 AND s.collected_amount >= s.expected_amount * 0.8)::int AS consistency
    FROM public.agent_team_daily_collection_stats s
    WHERE s.stat_date BETWEEN p_week_start AND p_week_start + 6
    GROUP BY s.parent_agent_id
  ),
  eligible AS (
    SELECT w.*,
      ROUND((w.collected_amount / NULLIF(w.expected_amount, 0)) * 100, 1) AS performance,
      ROUND((w.active_collectors::numeric / NULLIF(w.total_members, 0)) * 100, 1) AS active_rate
    FROM weekly w
    WHERE w.expected_amount > 0
      AND w.total_members > 1
  )
  SELECT
    e.parent_agent_id,
    e.expected_amount,
    e.collected_amount,
    e.performance,
    e.active_rate,
    e.consistency,
    e.total_members,
    e.active_collectors,
    ROW_NUMBER() OVER (
      ORDER BY e.performance DESC, e.active_rate DESC NULLS LAST, e.consistency DESC, e.parent_agent_id
    )::int AS team_rank
  FROM eligible e;
$$;

REVOKE ALL ON FUNCTION public.agent_league_week_ranks(date) FROM PUBLIC;

-- 5) Home card RPC — one round trip
CREATE OR REPLACE FUNCTION public.get_agent_collection_league_home()
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user uuid := auth.uid();
  v_parent uuid;
  v_week_start date;
  v_prev_start date;
  v_total_teams int;
  v_me record;
  v_prev_pos int;
  v_days jsonb;
  v_team_name text;
  v_members int;
BEGIN
  IF v_user IS NULL THEN
    RETURN jsonb_build_object('error', 'not_authenticated');
  END IF;

  v_parent := public.agent_league_team_parent(v_user);
  v_week_start := public.agent_league_week_start(now());
  v_prev_start := v_week_start - 7;

  SELECT COUNT(DISTINCT member_agent_id) INTO v_members
  FROM public.agent_team_membership_history
  WHERE parent_agent_id = v_parent AND valid_to IS NULL;

  SELECT COALESCE(NULLIF(split_part(COALESCE(p.full_name, ''), ' ', 1), ''), 'Welile')
    INTO v_team_name
  FROM public.profiles p WHERE p.id = v_parent;

  SELECT * INTO v_me FROM public.agent_league_week_ranks(v_week_start)
   WHERE parent_agent_id = v_parent;

  SELECT COUNT(*) INTO v_total_teams FROM public.agent_league_week_ranks(v_week_start);

  SELECT r.team_rank INTO v_prev_pos FROM public.agent_league_week_ranks(v_prev_start) r
   WHERE r.parent_agent_id = v_parent;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'date', d.day,
           'expected_amount', COALESCE(s.expected_amount, 0),
           'collected_amount', COALESCE(s.collected_amount, 0),
           'performance_percentage',
             CASE WHEN COALESCE(s.expected_amount, 0) > 0
               THEN ROUND((s.collected_amount / s.expected_amount) * 100, 1) ELSE NULL END,
           'heat_level', public.agent_league_heat_level(s.expected_amount, s.collected_amount),
           'is_future', d.day::date > (timezone('Africa/Kampala', now()))::date
         ) ORDER BY d.day), '[]'::jsonb)
    INTO v_days
  FROM generate_series(v_week_start, v_week_start + 6, interval '1 day') AS d(day)
  LEFT JOIN public.agent_team_daily_collection_stats s
    ON s.parent_agent_id = v_parent AND s.stat_date = d.day::date;

  RETURN jsonb_build_object(
    'week_start', v_week_start,
    'week_end', v_week_start + 6,
    'has_team', v_members > 0,
    'my_team', jsonb_build_object(
      'parent_agent_id', v_parent,
      'is_parent', v_parent = v_user,
      'team_name', 'Team ' || COALESCE(v_team_name, 'Welile'),
      'rank', v_me.team_rank,
      'total_teams', v_total_teams,
      'expected_amount', COALESCE(v_me.expected_amount, 0),
      'collected_amount', COALESCE(v_me.collected_amount, 0),
      'performance_percentage', v_me.performance,
      'active_collectors', COALESCE(v_me.active_collectors, 0),
      'total_members', COALESCE(v_me.total_members, v_members + 1),
      'previous_rank', v_prev_pos,
      'rank_change', CASE WHEN v_prev_pos IS NOT NULL AND v_me.team_rank IS NOT NULL
                          THEN v_prev_pos - v_me.team_rank ELSE NULL END
    ),
    'current_week_days', v_days
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_agent_collection_league_home() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_agent_collection_league_home() TO authenticated;

-- 6) Full league RPC — one round trip
CREATE OR REPLACE FUNCTION public.get_agent_collection_league_details(
  p_week_start date DEFAULT NULL,
  p_history_weeks integer DEFAULT 12
)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user uuid := auth.uid();
  v_parent uuid;
  v_week_start date;
  v_prev_start date;
  v_hist_start date;
  v_me record;
  v_prev record;
  v_total int;
  v_prev_pos int;
  v_team_name text;
  v_members int;
  v_heatmap jsonb;
  v_team_members jsonb;
  v_leaderboard jsonb;
BEGIN
  IF v_user IS NULL THEN
    RETURN jsonb_build_object('error', 'not_authenticated');
  END IF;

  v_parent := public.agent_league_team_parent(v_user);
  v_week_start := COALESCE(p_week_start, public.agent_league_week_start(now()));
  v_prev_start := v_week_start - 7;
  v_hist_start := v_week_start - (7 * GREATEST(1, LEAST(COALESCE(p_history_weeks, 12), 26)) - 7);

  SELECT COUNT(DISTINCT member_agent_id) INTO v_members
  FROM public.agent_team_membership_history
  WHERE parent_agent_id = v_parent AND valid_to IS NULL;

  SELECT COALESCE(NULLIF(split_part(COALESCE(p.full_name, ''), ' ', 1), ''), 'Welile')
    INTO v_team_name FROM public.profiles p WHERE p.id = v_parent;

  SELECT * INTO v_me FROM public.agent_league_week_ranks(v_week_start) WHERE parent_agent_id = v_parent;
  SELECT COUNT(*) INTO v_total FROM public.agent_league_week_ranks(v_week_start);
  SELECT * INTO v_prev FROM public.agent_league_week_ranks(v_prev_start) WHERE parent_agent_id = v_parent;
  v_prev_pos := v_prev.team_rank;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'date', d.day,
           'expected_amount', COALESCE(s.expected_amount, 0),
           'collected_amount', COALESCE(s.collected_amount, 0),
           'performance_percentage',
             CASE WHEN COALESCE(s.expected_amount, 0) > 0
               THEN ROUND((s.collected_amount / s.expected_amount) * 100, 1) ELSE NULL END,
           'heat_level', public.agent_league_heat_level(s.expected_amount, s.collected_amount),
           'is_future', d.day::date > (timezone('Africa/Kampala', now()))::date
         ) ORDER BY d.day), '[]'::jsonb)
    INTO v_heatmap
  FROM generate_series(v_hist_start, v_week_start + 6, interval '1 day') AS d(day)
  LEFT JOIN public.agent_team_daily_collection_stats s
    ON s.parent_agent_id = v_parent AND s.stat_date = d.day::date;

  WITH roster AS (
    SELECT v_parent AS agent_id, true AS is_parent
    UNION
    SELECT h.member_agent_id, false
    FROM public.agent_team_membership_history h
    WHERE h.parent_agent_id = v_parent
      AND h.valid_from::date <= v_week_start + 6
      AND (h.valid_to IS NULL OR h.valid_to::date >= v_week_start)
  ),
  exp AS (
    SELECT p.agent_id, SUM(p.expected_ugx) AS expected_amount
    FROM public.agent_expected_day_plans p
    WHERE p.day BETWEEN v_week_start AND v_week_start + 6
      AND p.agent_id IN (SELECT agent_id FROM roster)
    GROUP BY 1
  ),
  col AS (
    SELECT c.agent_id, SUM(c.amount) AS collected_amount, COUNT(*)::int AS collection_count,
           MAX(c.created_at) AS last_collection_at
    FROM public.agent_collections c
    WHERE c.amount > 0
      AND COALESCE(c.notes, '') NOT ILIKE '%[REVERSED]%'
      AND (timezone('Africa/Kampala', c.created_at))::date BETWEEN v_week_start AND v_week_start + 6
      AND c.agent_id IN (SELECT agent_id FROM roster)
    GROUP BY 1
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'agent_id', r.agent_id,
           'is_parent', r.is_parent,
           'is_me', r.agent_id = v_user,
           'name', COALESCE(pr.full_name, 'Agent'),
           'avatar_url', pr.avatar_url,
           'expected_amount', COALESCE(e.expected_amount, 0),
           'collected_amount', COALESCE(cl.collected_amount, 0),
           'collection_count', COALESCE(cl.collection_count, 0),
           'last_collection_at', cl.last_collection_at,
           'performance_percentage',
             CASE WHEN COALESCE(e.expected_amount, 0) > 0
               THEN ROUND((COALESCE(cl.collected_amount, 0) / e.expected_amount) * 100, 1) ELSE NULL END
         ) ORDER BY COALESCE(cl.collected_amount, 0) DESC), '[]'::jsonb)
    INTO v_team_members
  FROM roster r
  LEFT JOIN public.profiles pr ON pr.id = r.agent_id
  LEFT JOIN exp e ON e.agent_id = r.agent_id
  LEFT JOIN col cl ON cl.agent_id = r.agent_id;

  WITH ranks AS (
    SELECT * FROM public.agent_league_week_ranks(v_week_start)
  ),
  prev AS (
    SELECT r.parent_agent_id, r.team_rank FROM public.agent_league_week_ranks(v_prev_start) r
  ),
  shown AS (
    SELECT r.* FROM ranks r
    WHERE r.team_rank <= 10
       OR (v_me.team_rank IS NOT NULL AND r.team_rank BETWEEN v_me.team_rank - 2 AND v_me.team_rank + 2)
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'rank', s.team_rank,
           'team_name', 'Team ' || COALESCE(NULLIF(split_part(COALESCE(pr.full_name, ''), ' ', 1), ''), 'Welile'),
           'performance_percentage', s.performance,
           'rank_change', CASE WHEN pv.team_rank IS NOT NULL THEN pv.team_rank - s.team_rank ELSE NULL END,
           'is_me', s.parent_agent_id = v_parent,
           'achievement', CASE
             WHEN s.team_rank = 1 THEN 'top_team'
             WHEN s.performance >= 100 THEN 'full_collection'
             WHEN s.consistency >= 5 THEN 'green_week'
             ELSE NULL END,
           'expected_amount', CASE WHEN s.parent_agent_id = v_parent THEN s.expected_amount ELSE NULL END,
           'collected_amount', CASE WHEN s.parent_agent_id = v_parent THEN s.collected_amount ELSE NULL END
         ) ORDER BY s.team_rank), '[]'::jsonb)
    INTO v_leaderboard
  FROM shown s
  LEFT JOIN public.profiles pr ON pr.id = s.parent_agent_id
  LEFT JOIN prev pv ON pv.parent_agent_id = s.parent_agent_id;

  RETURN jsonb_build_object(
    'week', jsonb_build_object('week_start', v_week_start, 'week_end', v_week_start + 6),
    'has_team', v_members > 0,
    'my_team_summary', jsonb_build_object(
      'parent_agent_id', v_parent,
      'is_parent', v_parent = v_user,
      'team_name', 'Team ' || v_team_name,
      'rank', v_me.team_rank,
      'total_teams', v_total,
      'expected_amount', COALESCE(v_me.expected_amount, 0),
      'collected_amount', COALESCE(v_me.collected_amount, 0),
      'performance_percentage', v_me.performance,
      'active_collectors', COALESCE(v_me.active_collectors, 0),
      'total_members', COALESCE(v_me.total_members, v_members + 1),
      'active_collector_rate', v_me.active_rate,
      'consistency_days', COALESCE(v_me.consistency, 0),
      'previous_rank', v_prev_pos,
      'rank_change', CASE WHEN v_prev_pos IS NOT NULL AND v_me.team_rank IS NOT NULL
                          THEN v_prev_pos - v_me.team_rank ELSE NULL END
    ),
    'heatmap', v_heatmap,
    'team_members', v_team_members,
    'leaderboard', v_leaderboard,
    'leaderboard_meta', jsonb_build_object('total_teams', v_total, 'my_rank', v_me.team_rank),
    'previous_week_summary', CASE WHEN v_prev.parent_agent_id IS NULL THEN NULL ELSE jsonb_build_object(
      'week_start', v_prev_start,
      'week_end', v_prev_start + 6,
      'rank', v_prev.team_rank,
      'performance_percentage', v_prev.performance,
      'expected_amount', v_prev.expected_amount,
      'collected_amount', v_prev.collected_amount
    ) END
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_agent_collection_league_details(date, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_agent_collection_league_details(date, integer) TO authenticated;

-- 7) Paginated leaderboard (explicit "load more" only) — sanitised
CREATE OR REPLACE FUNCTION public.get_agent_collection_league_leaderboard(
  p_week_start date DEFAULT NULL,
  p_offset integer DEFAULT 0,
  p_limit integer DEFAULT 20
)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user uuid := auth.uid();
  v_parent uuid;
  v_week_start date;
  v_rows jsonb;
  v_total int;
BEGIN
  IF v_user IS NULL THEN
    RETURN jsonb_build_object('error', 'not_authenticated');
  END IF;

  v_parent := public.agent_league_team_parent(v_user);
  v_week_start := COALESCE(p_week_start, public.agent_league_week_start(now()));

  WITH ranks AS (SELECT * FROM public.agent_league_week_ranks(v_week_start)),
  page AS (
    SELECT * FROM ranks ORDER BY team_rank
    OFFSET GREATEST(0, COALESCE(p_offset, 0)) LIMIT LEAST(GREATEST(1, COALESCE(p_limit, 20)), 100)
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'rank', p.team_rank,
           'team_name', 'Team ' || COALESCE(NULLIF(split_part(COALESCE(pr.full_name, ''), ' ', 1), ''), 'Welile'),
           'performance_percentage', p.performance,
           'is_me', p.parent_agent_id = v_parent,
           'achievement', CASE WHEN p.team_rank = 1 THEN 'top_team'
                               WHEN p.performance >= 100 THEN 'full_collection' ELSE NULL END,
           'expected_amount', CASE WHEN p.parent_agent_id = v_parent THEN p.expected_amount ELSE NULL END,
           'collected_amount', CASE WHEN p.parent_agent_id = v_parent THEN p.collected_amount ELSE NULL END
         ) ORDER BY p.team_rank), '[]'::jsonb)
    INTO v_rows
  FROM page p LEFT JOIN public.profiles pr ON pr.id = p.parent_agent_id;

  SELECT COUNT(*) INTO v_total FROM public.agent_league_week_ranks(v_week_start);

  RETURN jsonb_build_object('rows', v_rows, 'total_teams', v_total, 'offset', COALESCE(p_offset, 0));
END;
$$;

REVOKE ALL ON FUNCTION public.get_agent_collection_league_leaderboard(date, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_agent_collection_league_leaderboard(date, integer, integer) TO authenticated;

-- 8) Seed the aggregate for the period we have data for
SELECT public.reconcile_agent_team_daily_stats(
  LEAST(
    (SELECT MIN(day) FROM public.agent_expected_day_plans),
    (timezone('Africa/Kampala', now()))::date - 60
  ),
  (timezone('Africa/Kampala', now()))::date
);
