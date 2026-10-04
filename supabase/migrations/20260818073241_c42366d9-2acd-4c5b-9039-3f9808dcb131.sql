CREATE OR REPLACE FUNCTION public.get_agent_products_cumulative(p_date date DEFAULT NULL::date)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_day date;
  v_end timestamptz;
  v_res jsonb;
BEGIN
  IF NOT public.agent_ops_report_authorized() THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  v_day := COALESCE(p_date, (now() AT TIME ZONE 'Africa/Kampala')::date);
  v_end := ((v_day + 1)::timestamp AT TIME ZONE 'Africa/Kampala');

  WITH windows AS (
    SELECT w.days,
           ((v_day - (w.days - 1))::timestamp AT TIME ZONE 'Africa/Kampala') AS w_start
    FROM (VALUES (7), (30), (90), (365)) AS w(days)
  ),
  agent_qual AS (
    SELECT s.uid, MIN(s.ts) AS first_ts
    FROM (
      SELECT rr.agent_id AS uid, MIN(rr.created_at) AS ts
        FROM rent_requests rr
        WHERE rr.agent_id IS NOT NULL AND rr.tenant_id IS NOT NULL AND rr.agent_id <> rr.tenant_id
        GROUP BY rr.agent_id
      UNION ALL
      SELECT ac.agent_id, MIN(ac.created_at)
        FROM agent_collections ac
        WHERE ac.agent_id IS NOT NULL
        GROUP BY ac.agent_id
      UNION ALL
      SELECT lr.uid, lr.created_at
        FROM (
          SELECT hl.agent_id AS uid, hl.created_at,
                 row_number() OVER (PARTITION BY hl.agent_id ORDER BY hl.created_at) AS rn
            FROM house_listings hl
           WHERE hl.agent_id IS NOT NULL
        ) lr
       WHERE lr.rn = 3
    ) s
    WHERE s.uid IS NOT NULL
    GROUP BY s.uid
  ),
  sub_agents AS (
    SELECT sub_agent_id AS uid, MIN(created_at) AS first_ts
    FROM public.agent_subagents
    WHERE status IN ('verified', 'pending_acceptance')
    GROUP BY sub_agent_id
  ),
  all_agents AS (
    SELECT uid, MIN(first_ts) AS created_at
    FROM (
      SELECT uid, first_ts FROM agent_qual
      UNION ALL
      SELECT uid, first_ts FROM sub_agents
    ) s
    GROUP BY uid
  ),
  rows AS (
    SELECT
      w.days,
      to_char((v_day - (w.days - 1)), 'YYYY-MM-DD') AS from_date,
      to_char(v_day, 'YYYY-MM-DD') AS to_date,
      COALESCE((SELECT sum(ac.amount) FROM agent_collections ac
                 WHERE ac.created_at >= w.w_start AND ac.created_at < v_end), 0) AS rent_collected,
      COALESCE((SELECT count(*) FROM agent_collections ac
                 WHERE ac.created_at >= w.w_start AND ac.created_at < v_end), 0) AS collections_count,
      COALESCE((SELECT count(DISTINCT ac.agent_id) FROM agent_collections ac
                 WHERE ac.created_at >= w.w_start AND ac.created_at < v_end), 0) AS collecting_agents,
      COALESCE((SELECT count(*) FROM all_agents a
                 WHERE a.created_at >= w.w_start AND a.created_at < v_end), 0) AS new_agents,
      COALESCE((SELECT sum(av.principal) FROM agent_advances av
                 WHERE av.issued_at >= w.w_start AND av.issued_at < v_end), 0) AS advances_issued,
      COALESCE((SELECT count(*) FROM agent_advances av
                 WHERE av.issued_at >= w.w_start AND av.issued_at < v_end), 0) AS advances_count,
      COALESCE((SELECT sum(l.amount_deducted) FROM agent_advance_ledger l
                 WHERE l.date >= (v_day - (w.days - 1)) AND l.date <= v_day), 0) AS advances_recovered
    FROM windows w
  )
  SELECT jsonb_build_object(
    'as_of', to_char(v_day, 'YYYY-MM-DD'),
    'timezone', 'Africa/Kampala',
    'windows', COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.days), '[]'::jsonb)
  ) INTO v_res
  FROM rows r;

  RETURN v_res;
END;
$$;

REVOKE ALL ON FUNCTION public.get_agent_products_cumulative(date) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_agent_products_cumulative(date) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_agent_products_cumulative(date) TO authenticated;