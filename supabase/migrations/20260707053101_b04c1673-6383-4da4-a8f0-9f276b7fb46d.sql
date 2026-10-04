CREATE OR REPLACE FUNCTION public.generate_house_listing_commission_report(
  p_from timestamptz DEFAULT NULL,
  p_to   timestamptz DEFAULT NULL
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH legs AS (
    SELECT
      gl.amount,
      gl.user_id,
      gl.created_at,
      CASE
        WHEN gl.description ILIKE '%instant house-listed reward%' THEN 'instant_reward'
        WHEN gl.description ILIKE '%recruiter override - house_listed%' THEN 'recruiter_override'
        WHEN gl.description ILIKE '%house listing bonus%'
          OR gl.description ILIKE '%Listing verification bonus%'
          OR gl.description ILIKE '%Listing bonus - landlord verified%' THEN 'verification_bonus'
        ELSE 'other'
      END AS commission_type
    FROM public.general_ledger gl
    WHERE gl.direction = 'cash_in'
      AND gl.ledger_scope IN ('wallet', 'bridge')
      AND gl.category IN ('agent_commission', 'agent_commission_earned')
      AND (
        gl.description ILIKE '%house-listed reward%'
        OR gl.description ILIKE '%house listing bonus%'
        OR gl.description ILIKE '%Listing verification bonus%'
        OR gl.description ILIKE '%recruiter override - house_listed%'
        OR gl.description ILIKE '%Listing bonus - landlord verified%'
      )
      AND (p_from IS NULL OR gl.created_at >= p_from)
      AND (p_to   IS NULL OR gl.created_at <= p_to)
  )
  SELECT jsonb_build_object(
    'total_amount', COALESCE((SELECT SUM(amount) FROM legs), 0),
    'total_count',  (SELECT COUNT(*) FROM legs),
    'agent_count',  (SELECT COUNT(DISTINCT user_id) FROM legs),
    'by_type', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'type', t.commission_type,
        'amount', t.amount,
        'count', t.cnt
      ) ORDER BY t.amount DESC), '[]'::jsonb)
      FROM (
        SELECT commission_type, SUM(amount) AS amount, COUNT(*) AS cnt
        FROM legs GROUP BY commission_type
      ) t
    ),
    'by_agent', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'agent_id', a.agent_id,
        'agent_name', a.agent_name,
        'phone', a.phone,
        'amount', a.amount,
        'count', a.cnt
      ) ORDER BY a.amount DESC), '[]'::jsonb)
      FROM (
        SELECT l.user_id AS agent_id,
               COALESCE(p.full_name, 'Unknown') AS agent_name,
               COALESCE(p.phone, '') AS phone,
               SUM(l.amount) AS amount,
               COUNT(*) AS cnt
        FROM legs l
        LEFT JOIN public.profiles p ON p.id = l.user_id
        GROUP BY l.user_id, p.full_name, p.phone
        ORDER BY SUM(l.amount) DESC
        LIMIT 1000
      ) a
    )
  );
$$;

GRANT EXECUTE ON FUNCTION public.generate_house_listing_commission_report(timestamptz, timestamptz) TO authenticated;
GRANT EXECUTE ON FUNCTION public.generate_house_listing_commission_report(timestamptz, timestamptz) TO service_role;