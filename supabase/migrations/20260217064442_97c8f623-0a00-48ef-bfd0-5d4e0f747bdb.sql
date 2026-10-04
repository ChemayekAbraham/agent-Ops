-- Fix COALESCE type mismatch in get_manager_productivity function
CREATE OR REPLACE FUNCTION public.get_manager_productivity(
  filter_start timestamptz DEFAULT NULL,
  filter_end timestamptz DEFAULT NULL
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
DECLARE
  result json;
BEGIN
  -- Check manager role
  IF NOT has_role(auth.uid(), 'manager') THEN
    RETURN json_build_object('error', 'Unauthorized');
  END IF;

  SELECT json_build_object(
    'referral_leaderboard', COALESCE((
      SELECT json_agg(row_to_json(t) ORDER BY t.referral_count DESC)
      FROM (
        SELECT 
          p.id,
          p.full_name,
          p.email,
          p.phone,
          p.avatar_url,
          p.created_at,
          p.updated_at,
          count(r.id)::int as referral_count,
          (SELECT coalesce(array_agg(ur.role::text), ARRAY[]::text[]) FROM user_roles ur WHERE ur.user_id = p.id) as roles
        FROM profiles p
        INNER JOIN referrals r ON r.referrer_id = p.id
          AND (filter_start IS NULL OR r.created_at >= filter_start)
          AND (filter_end IS NULL OR r.created_at <= filter_end)
        GROUP BY p.id, p.full_name, p.email, p.phone, p.avatar_url, p.created_at, p.updated_at
      ) t
    ), '[]'::json),
    'current_total', (
      SELECT count(*) FROM referrals 
      WHERE (filter_start IS NULL OR created_at >= filter_start)
        AND (filter_end IS NULL OR created_at <= filter_end)
    ),
    'previous_total', (
      SELECT count(*) FROM referrals 
      WHERE filter_start IS NOT NULL
        AND created_at >= (filter_start - (COALESCE(filter_end, now()) - filter_start))
        AND created_at < filter_start
    )
  ) INTO result;

  RETURN result;
END;
$$;