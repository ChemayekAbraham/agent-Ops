-- 1. Store the merchant agent the withdrawer chose to collect cash from.
--    This is a *preference* and is distinct from assigned_cashout_agent_id,
--    which is set only when a merchant agent claims the payout for processing.
ALTER TABLE public.withdrawal_requests
  ADD COLUMN IF NOT EXISTS preferred_cashout_agent_id uuid REFERENCES public.cashout_agents(id);

-- 2. Return active cash-handling merchant agents, nearest first when the
--    requester's coordinates are supplied. Location is resolved from the
--    agent's profile residence coords, falling back to their latest captured
--    location. Distance uses the haversine formula (km).
CREATE OR REPLACE FUNCTION public.get_nearby_cashout_agents(
  _lat double precision DEFAULT NULL,
  _lng double precision DEFAULT NULL
)
RETURNS TABLE (
  cashout_agent_id uuid,
  agent_id uuid,
  agent_name text,
  label text,
  phone text,
  district text,
  region text,
  city text,
  agent_lat double precision,
  agent_lng double precision,
  distance_km double precision,
  queue_count integer
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH agents AS (
    SELECT
      ca.id AS cashout_agent_id,
      ca.agent_id,
      ca.label,
      ca.current_queue_count,
      p.full_name,
      p.phone,
      p.district,
      p.region,
      p.city,
      COALESCE(p.residence_lat::double precision, ul.latitude) AS agent_lat,
      COALESCE(p.residence_lng::double precision, ul.longitude) AS agent_lng
    FROM public.cashout_agents ca
    LEFT JOIN public.profiles p ON p.id = ca.agent_id
    LEFT JOIN LATERAL (
      SELECT latitude, longitude
      FROM public.user_locations
      WHERE user_id = ca.agent_id
      ORDER BY captured_at DESC NULLS LAST
      LIMIT 1
    ) ul ON true
    WHERE ca.is_active = true
      AND ca.handles_cash = true
  )
  SELECT
    a.cashout_agent_id,
    a.agent_id,
    COALESCE(NULLIF(btrim(a.full_name), ''), a.label, 'Merchant agent') AS agent_name,
    a.label,
    a.phone,
    a.district,
    a.region,
    a.city,
    a.agent_lat,
    a.agent_lng,
    CASE
      WHEN _lat IS NOT NULL AND _lng IS NOT NULL
           AND a.agent_lat IS NOT NULL AND a.agent_lng IS NOT NULL THEN
        6371 * 2 * asin(
          sqrt(
            power(sin(radians(a.agent_lat - _lat) / 2), 2)
            + cos(radians(_lat)) * cos(radians(a.agent_lat))
              * power(sin(radians(a.agent_lng - _lng) / 2), 2)
          )
        )
      ELSE NULL
    END AS distance_km,
    COALESCE(a.current_queue_count, 0) AS queue_count
  FROM agents a
  ORDER BY
    (CASE WHEN _lat IS NOT NULL AND _lng IS NOT NULL
               AND a.agent_lat IS NOT NULL AND a.agent_lng IS NOT NULL
          THEN 0 ELSE 1 END),
    distance_km ASC NULLS LAST,
    queue_count ASC,
    agent_name ASC;
$$;

GRANT EXECUTE ON FUNCTION public.get_nearby_cashout_agents(double precision, double precision) TO authenticated;