CREATE OR REPLACE FUNCTION public.get_sms_broadcast_status()
RETURNS TABLE (
  campaign_key text,
  message text,
  audiences text[],
  total_recipients integer,
  run_count integer,
  status text,
  sent bigint,
  failed bigint,
  last_activity timestamptz,
  last_run_at timestamptz,
  created_at timestamptz,
  updated_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    c.campaign_key,
    c.message,
    c.audiences,
    c.total_recipients,
    c.run_count,
    c.status,
    COALESCE(s.sent, 0) AS sent,
    COALESCE(s.failed, 0) AS failed,
    s.last_activity,
    c.last_run_at,
    c.created_at,
    c.updated_at
  FROM public.sms_broadcast_campaigns c
  LEFT JOIN LATERAL (
    SELECT
      count(*) FILTER (WHERE l.status = 'sent' AND l.phone ~ '^\\+256[0-9]{9}$') AS sent,
      count(*) FILTER (WHERE l.status = 'failed' AND l.phone ~ '^\\+256[0-9]{9}$') AS failed,
      max(l.created_at) FILTER (WHERE l.status IN ('sent', 'failed') AND l.phone ~ '^\\+256[0-9]{9}$') AS last_activity
    FROM public.sms_broadcast_log l
    WHERE l.campaign_key = c.campaign_key
  ) s ON true
  WHERE
    has_role(auth.uid(), 'manager'::app_role)
    OR has_role(auth.uid(), 'super_admin'::app_role)
    OR has_role(auth.uid(), 'ceo'::app_role)
    OR has_role(auth.uid(), 'coo'::app_role)
    OR has_role(auth.uid(), 'cto'::app_role)
    OR has_role(auth.uid(), 'cmo'::app_role)
    OR has_role(auth.uid(), 'crm'::app_role)
  ORDER BY c.updated_at DESC;
$$;

GRANT EXECUTE ON FUNCTION public.get_sms_broadcast_status() TO authenticated;