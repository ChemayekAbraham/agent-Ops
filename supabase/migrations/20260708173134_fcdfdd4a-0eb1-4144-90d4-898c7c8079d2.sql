-- Campaign-level summary for SMS broadcasts (drives the CTO broadcast status page)
CREATE TABLE IF NOT EXISTS public.sms_broadcast_campaigns (
  campaign_key text PRIMARY KEY,
  message text,
  audiences text[] NOT NULL DEFAULT '{}',
  total_recipients integer NOT NULL DEFAULT 0,
  run_count integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'running',
  last_run_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.sms_broadcast_campaigns TO authenticated;
GRANT ALL ON public.sms_broadcast_campaigns TO service_role;

ALTER TABLE public.sms_broadcast_campaigns ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can view broadcast campaigns"
ON public.sms_broadcast_campaigns
FOR SELECT
TO authenticated
USING (
  has_role(auth.uid(), 'manager'::app_role)
  OR has_role(auth.uid(), 'super_admin'::app_role)
  OR has_role(auth.uid(), 'ceo'::app_role)
  OR has_role(auth.uid(), 'coo'::app_role)
  OR has_role(auth.uid(), 'cto'::app_role)
  OR has_role(auth.uid(), 'cmo'::app_role)
  OR has_role(auth.uid(), 'crm'::app_role)
);

-- Secure aggregation: combines campaign metadata with live sent/failed counts
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
      count(*) FILTER (WHERE l.status = 'sent')   AS sent,
      count(*) FILTER (WHERE l.status = 'failed') AS failed,
      max(l.created_at) AS last_activity
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