-- lovable-cron-fallback-reviewed: existing 15-min league backstop (96 runs/day) kept unchanged in cadence; only its look-back window widens from 2 to 7 days.
CREATE OR REPLACE FUNCTION public.reconcile_agent_team_daily_stats(p_start date DEFAULT ((timezone('Africa/Kampala'::text, now()))::date - 7), p_end date DEFAULT (timezone('Africa/Kampala'::text, now()))::date)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_rows integer := 0;
BEGIN
  DELETE FROM public.agent_team_daily_collection_stats
  WHERE stat_date BETWEEN p_start AND p_end;

  WITH days AS (
    SELECT d::date AS stat_date FROM generate_series(p_start, p_end, interval '1 day') d
  ),
  membership AS (
    SELECT DISTINCT ON (h.member_agent_id, d.stat_date)
      h.member_agent_id, d.stat_date, h.parent_agent_id
    FROM days d
    JOIN public.agent_team_membership_history h
      ON (timezone('Africa/Kampala', h.valid_from))::date <= d.stat_date
     AND (h.valid_to IS NULL OR (timezone('Africa/Kampala', h.valid_to))::date >= d.stat_date)
    ORDER BY h.member_agent_id, d.stat_date, h.valid_from DESC
  ),
  expected AS (
    SELECT COALESCE(m.parent_agent_id, p.agent_id) AS parent_agent_id,
           p.day AS stat_date,
           SUM(p.expected_ugx)::numeric AS expected_amount
    FROM public.agent_expected_day_plans p
    LEFT JOIN membership m ON m.member_agent_id = p.agent_id AND m.stat_date = p.day
    WHERE p.day BETWEEN p_start AND p_end AND p.agent_id IS NOT NULL
    GROUP BY 1, 2
  ),
  valid_collections AS (
    SELECT c.agent_id,
           (timezone('Africa/Kampala', c.created_at))::date AS stat_date,
           c.amount
    FROM public.agent_collections c
    WHERE c.amount > 0
      AND c.reversed_at IS NULL
      AND COALESCE(c.notes, '') NOT ILIKE '%[REVERSED]%'
      AND (timezone('Africa/Kampala', c.created_at))::date BETWEEN p_start AND p_end
  ),
  collected AS (
    SELECT COALESCE(m.parent_agent_id, vc.agent_id) AS parent_agent_id,
           vc.stat_date,
           SUM(vc.amount)::numeric AS collected_amount,
           COUNT(*)::int AS collection_count,
           COUNT(DISTINCT vc.agent_id)::int AS active_collectors
    FROM valid_collections vc
    LEFT JOIN membership m ON m.member_agent_id = vc.agent_id AND m.stat_date = vc.stat_date
    GROUP BY 1, 2
  ),
  team_size AS (
    SELECT stat_date, parent_agent_id, COUNT(DISTINCT member_agent_id)::int + 1 AS total_team_members
    FROM membership GROUP BY 1, 2
  ),
  merged AS (
    SELECT parent_agent_id, stat_date FROM expected
    UNION SELECT parent_agent_id, stat_date FROM collected
    UNION SELECT parent_agent_id, stat_date FROM team_size
  )
  INSERT INTO public.agent_team_daily_collection_stats
    (stat_date, parent_agent_id, expected_amount, collected_amount, collection_count, total_team_members, active_collectors)
  SELECT m.stat_date, m.parent_agent_id,
         COALESCE(e.expected_amount, 0), COALESCE(c.collected_amount, 0), COALESCE(c.collection_count, 0),
         COALESCE(t.total_team_members, 1), COALESCE(c.active_collectors, 0)
  FROM merged m
  LEFT JOIN expected e ON e.parent_agent_id = m.parent_agent_id AND e.stat_date = m.stat_date
  LEFT JOIN collected c ON c.parent_agent_id = m.parent_agent_id AND c.stat_date = m.stat_date
  LEFT JOIN team_size t ON t.parent_agent_id = m.parent_agent_id AND t.stat_date = m.stat_date;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows;
END;
$function$;

REVOKE ALL ON FUNCTION public.reconcile_agent_team_daily_stats(date, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_agent_team_daily_stats(date, date) TO service_role;

SELECT public.reconcile_agent_team_daily_stats('2026-07-01'::date, (timezone('Africa/Kampala', now()))::date);

SELECT cron.schedule(
  'refresh-agent-team-daily-collection-stats',
  '*/15 * * * *',
  $$SELECT public.reconcile_agent_team_daily_stats(
      (timezone('Africa/Kampala', now()))::date - 7,
      (timezone('Africa/Kampala', now()))::date
    );$$
);