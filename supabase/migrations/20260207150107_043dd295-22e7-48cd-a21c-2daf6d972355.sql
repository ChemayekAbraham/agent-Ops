
-- Server-side aggregation for manager dashboard stats
-- Returns all counts + facilitated amount in a single round-trip
CREATE OR REPLACE FUNCTION public.get_manager_dashboard_stats()
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  result json;
  one_week_ago timestamptz := now() - interval '7 days';
BEGIN
  SELECT json_build_object(
    'pending_requests', (SELECT count(*) FROM rent_requests WHERE status = 'pending'),
    'total_facilitated', (SELECT coalesce(sum(rent_amount), 0) FROM rent_requests WHERE status IN ('funded', 'disbursed', 'completed')),
    'total_users', (SELECT count(*) FROM profiles),
    'active_users', (SELECT count(*) FROM profiles WHERE rent_discount_active = true),
    'new_signups_this_week', (SELECT count(*) FROM profiles WHERE created_at >= one_week_ago),
    'pending_orders', (SELECT count(*) FROM product_orders WHERE status IN ('pending', 'processing')),
    'pending_loans', (SELECT count(*) FROM loan_applications WHERE status = 'pending')
  ) INTO result;
  
  RETURN result;
END;
$$;

-- Server-side productivity data: returns top onboarders with referral counts, roles, and profile info
-- This replaces 3+ sequential client queries with a single efficient one
CREATE OR REPLACE FUNCTION public.get_manager_productivity(
  p_filter text DEFAULT 'all',
  p_custom_start timestamptz DEFAULT null,
  p_custom_end timestamptz DEFAULT null
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  result json;
  filter_start timestamptz;
  filter_end timestamptz;
  prev_start timestamptz;
  prev_end timestamptz;
  period_duration interval;
BEGIN
  -- Calculate filter dates
  IF p_filter = 'week' THEN
    filter_start := now() - interval '7 days';
    filter_end := now();
    prev_start := now() - interval '14 days';
    prev_end := now() - interval '7 days';
  ELSIF p_filter = 'month' THEN
    filter_start := now() - interval '1 month';
    filter_end := now();
    prev_start := now() - interval '2 months';
    prev_end := now() - interval '1 month';
  ELSIF p_filter = 'custom' AND p_custom_start IS NOT NULL AND p_custom_end IS NOT NULL THEN
    filter_start := p_custom_start;
    filter_end := p_custom_end;
    period_duration := p_custom_end - p_custom_start;
    prev_start := p_custom_start - period_duration;
    prev_end := p_custom_start;
  ELSE
    filter_start := null;
    filter_end := null;
    prev_start := null;
    prev_end := null;
  END IF;

  SELECT json_build_object(
    'onboarders', (
      SELECT coalesce(json_agg(row_to_json(t) ORDER BY t.referral_count DESC), '[]'::json)
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
          (SELECT coalesce(array_agg(ur.role), ARRAY[]::text[]) FROM user_roles ur WHERE ur.user_id = p.id) as roles
        FROM profiles p
        INNER JOIN referrals r ON r.referrer_id = p.id
          AND (filter_start IS NULL OR r.created_at >= filter_start)
          AND (filter_end IS NULL OR r.created_at <= filter_end)
        GROUP BY p.id, p.full_name, p.email, p.phone, p.avatar_url, p.created_at, p.updated_at
      ) t
    ),
    'current_total', (
      SELECT count(*) FROM referrals 
      WHERE (filter_start IS NULL OR created_at >= filter_start)
        AND (filter_end IS NULL OR created_at <= filter_end)
    ),
    'previous_total', (
      CASE WHEN prev_start IS NOT NULL THEN
        (SELECT count(*) FROM referrals WHERE created_at >= prev_start AND created_at < prev_end)
      ELSE 0 END
    ),
    'previous_recruiters', (
      CASE WHEN prev_start IS NOT NULL THEN
        (SELECT count(DISTINCT referrer_id) FROM referrals WHERE created_at >= prev_start AND created_at < prev_end)
      ELSE 0 END
    ),
    'trend_data', (
      SELECT coalesce(json_agg(row_to_json(td) ORDER BY td.period_date), '[]'::json)
      FROM (
        SELECT 
          CASE 
            WHEN p_filter = 'week' THEN to_char(date_trunc('day', r.created_at), 'Dy')
            WHEN p_filter = 'month' THEN to_char(date_trunc('week', r.created_at), 'Mon DD')
            ELSE to_char(date_trunc('month', r.created_at), 'Mon')
          END as date,
          date_trunc(
            CASE 
              WHEN p_filter = 'week' THEN 'day'
              WHEN p_filter = 'month' THEN 'week'
              ELSE 'month'
            END, 
            r.created_at
          ) as period_date,
          count(*)::int as count
        FROM referrals r
        WHERE (filter_start IS NULL OR r.created_at >= filter_start)
          AND (filter_end IS NULL OR r.created_at <= filter_end)
        GROUP BY 1, 2
      ) td
    )
  ) INTO result;
  
  RETURN result;
END;
$$;
