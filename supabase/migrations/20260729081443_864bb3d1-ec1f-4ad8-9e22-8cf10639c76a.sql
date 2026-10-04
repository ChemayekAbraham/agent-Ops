WITH recent_locks AS (
  SELECT rr.id, rr.tenant_id, rr.agent_id, rr.collection_locked_at
  FROM public.rent_requests rr
  WHERE rr.tenancy_status = 'active'
    AND rr.collection_locked_at > now() - interval '24 hours'
),
cols AS (
  SELECT rl.id AS rr_id,
         ac.created_at,
         row_number() OVER (PARTITION BY rl.id ORDER BY ac.created_at DESC) AS rn
  FROM recent_locks rl
  LEFT JOIN public.agent_collections ac
    ON ac.agent_id = rl.agent_id AND ac.tenant_id = rl.tenant_id
),
top5 AS (
  SELECT rr_id, created_at
  FROM cols
  WHERE rn <= 5 AND created_at IS NOT NULL
),
gaps AS (
  SELECT rr_id,
         EXTRACT(EPOCH FROM (created_at - LAG(created_at) OVER (PARTITION BY rr_id ORDER BY created_at))) / 86400.0 AS gap_days
  FROM top5
),
stats AS (
  SELECT rr_id,
         COUNT(*) FILTER (WHERE gap_days IS NOT NULL) AS gap_count,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY gap_days) AS median_gap
  FROM gaps
  GROUP BY rr_id
),
last_col AS (
  SELECT rr_id, MAX(created_at) AS last_at FROM top5 GROUP BY rr_id
),
to_unlock AS (
  SELECT rl.id
  FROM recent_locks rl
  LEFT JOIN stats s ON s.rr_id = rl.id
  LEFT JOIN last_col lc ON lc.rr_id = rl.id
  WHERE
    COALESCE(s.gap_count, 0) < 1
    OR (
      s.median_gap >= 4
      AND EXTRACT(EPOCH FROM (now() - lc.last_at)) / 86400.0 < 15
    )
)
UPDATE public.rent_requests
   SET collection_locked_at = NULL,
       collection_locked_reason = NULL,
       collection_lock_days = NULL
 WHERE id IN (SELECT id FROM to_unlock)
 RETURNING id;