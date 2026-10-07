CREATE TABLE IF NOT EXISTS public.agent_elite_ranks (
  agent_id uuid PRIMARY KEY,
  rank_position int NOT NULL CHECK (rank_position BETWEEN 1 AND 4),
  tier_name text NOT NULL CHECK (tier_name IN ('diamond','platinum','gold','silver')),
  composite_score numeric NOT NULL,
  collection_score numeric NOT NULL,
  network_score numeric NOT NULL,
  activity_score numeric NOT NULL,
  gross_collected numeric NOT NULL DEFAULT 0,
  active_subagents int NOT NULL DEFAULT 0,
  active_days int NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.agent_elite_ranks TO authenticated;
GRANT ALL ON public.agent_elite_ranks TO service_role;
ALTER TABLE public.agent_elite_ranks ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Signed-in users can read elite ranks" ON public.agent_elite_ranks FOR SELECT TO authenticated USING (true);

-- Recomputes the top 4 from the last 30 days. Everyone not in the new top 4 is removed,
-- so an agent who falls out reverts to a normal agent immediately.
CREATE OR REPLACE FUNCTION public.refresh_agent_elite_ranks()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_count int;
BEGIN
  CREATE TEMP TABLE _scores ON COMMIT DROP AS
  WITH agents AS (
    SELECT DISTINCT ur.user_id AS agent_id FROM user_roles ur
    WHERE ur.role = 'agent' AND COALESCE(ur.enabled, true)
  ),
  owed AS (
    SELECT rr.agent_id, count(DISTINCT rr.tenant_id) n FROM rent_requests rr
    WHERE rr.status IN ('funded','disbursed','repaying') GROUP BY rr.agent_id
  ),
  coll AS (
    SELECT ac.agent_id, count(DISTINCT ac.tenant_id) tenants, sum(ac.amount) gross,
           count(DISTINCT (ac.created_at AT TIME ZONE 'Africa/Kampala')::date) days
    FROM agent_collections ac WHERE ac.created_at >= now() - interval '30 days' GROUP BY ac.agent_id
  ),
  reqdays AS (
    SELECT rr.agent_id, count(DISTINCT (rr.created_at AT TIME ZONE 'Africa/Kampala')::date) days
    FROM rent_requests rr WHERE rr.created_at >= now() - interval '30 days' GROUP BY rr.agent_id
  ),
  subs AS (
    SELECT s.parent_agent_id agent_id, count(DISTINCT s.sub_agent_id) n
    FROM agent_subagents s
    WHERE EXISTS (SELECT 1 FROM agent_collections c WHERE c.agent_id = s.sub_agent_id AND c.created_at >= now() - interval '30 days')
       OR EXISTS (SELECT 1 FROM rent_requests r WHERE r.agent_id = s.sub_agent_id AND r.created_at >= now() - interval '30 days')
    GROUP BY s.parent_agent_id
  )
  SELECT a.agent_id,
    CASE WHEN COALESCE(o.n,0) = 0 THEN 0 ELSE LEAST(1, COALESCE(c.tenants,0)::numeric / o.n) * 40 END AS collection_score,
    LEAST(COALESCE(s.n,0), 10)::numeric / 10 * 35 AS network_score,
    LEAST(GREATEST(COALESCE(c.days,0), COALESCE(r.days,0))
      + CASE WHEN p.last_active_at >= now() - interval '7 days' THEN 3 ELSE 0 END, 30)::numeric / 30 * 25 AS activity_score,
    COALESCE(c.gross,0) gross, COALESCE(s.n,0)::int subs,
    GREATEST(COALESCE(c.days,0), COALESCE(r.days,0))::int days
  FROM agents a
  LEFT JOIN owed o ON o.agent_id = a.agent_id
  LEFT JOIN coll c ON c.agent_id = a.agent_id
  LEFT JOIN reqdays r ON r.agent_id = a.agent_id
  LEFT JOIN subs s ON s.agent_id = a.agent_id
  LEFT JOIN profiles p ON p.id = a.agent_id;

  DELETE FROM agent_elite_ranks WHERE true;

  INSERT INTO agent_elite_ranks (agent_id, rank_position, tier_name, composite_score, collection_score,
    network_score, activity_score, gross_collected, active_subagents, active_days, updated_at)
  SELECT agent_id, rn, (ARRAY['diamond','platinum','gold','silver'])[rn],
    round(total,2), round(collection_score,2), round(network_score,2), round(activity_score,2), gross, subs, days, now()
  FROM (
    SELECT *, collection_score + network_score + activity_score AS total,
      row_number() OVER (ORDER BY collection_score + network_score + activity_score DESC, gross DESC, agent_id)::int rn
    FROM _scores WHERE collection_score + network_score + activity_score > 0
  ) x WHERE rn <= 4;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END $$;
REVOKE ALL ON FUNCTION public.refresh_agent_elite_ranks() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.get_my_elite_rank()
RETURNS TABLE(rank_position int, tier_name text, composite_score numeric, collection_score numeric,
  network_score numeric, activity_score numeric, updated_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT rank_position, tier_name, composite_score, collection_score, network_score, activity_score, updated_at
  FROM agent_elite_ranks WHERE agent_id = auth.uid();
$$;
GRANT EXECUTE ON FUNCTION public.get_my_elite_rank() TO authenticated;

-- Diamond (#1) Rent Plan requests skip Service Centre and go straight to Agent Ops.
CREATE OR REPLACE FUNCTION public.route_rent_request_service_center()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE v_manager uuid;
BEGIN
  IF COALESCE(NEW.status,'pending') <> 'pending' THEN RETURN NEW; END IF;

  IF EXISTS (SELECT 1 FROM agent_elite_ranks e
             WHERE e.agent_id = COALESCE(NEW.agent_id, NEW.assigned_agent_id) AND e.rank_position = 1) THEN
    NEW.service_center_comment := 'Skipped Service Centre: Diamond rank privilege';
    RETURN NEW;
  END IF;

  v_manager := public.resolve_service_center_manager_for_agent(COALESCE(NEW.agent_id, NEW.assigned_agent_id));
  IF v_manager IS NOT NULL THEN
    NEW.status := 'service_center_review';
    NEW.service_center_manager_id := v_manager;
  END IF;
  RETURN NEW;
END; $function$;

SELECT cron.schedule('refresh-agent-elite-ranks', '0 22 * * *', 'SELECT public.refresh_agent_elite_ranks();');
SELECT public.refresh_agent_elite_ranks();