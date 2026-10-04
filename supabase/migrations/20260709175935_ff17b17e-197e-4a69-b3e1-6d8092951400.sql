CREATE TABLE public.redirect_monitor (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  old_domain text NOT NULL,
  new_domain text NOT NULL,
  paths jsonb NOT NULL DEFAULT '["/","/opportunities","/join"]'::jsonb,
  enabled boolean NOT NULL DEFAULT true,
  alert_emails text[] NOT NULL DEFAULT '{}',
  notify_managers boolean NOT NULL DEFAULT true,
  failure_threshold integer NOT NULL DEFAULT 1,
  require_ever_healthy boolean NOT NULL DEFAULT true,
  currently_healthy boolean,
  ever_healthy boolean NOT NULL DEFAULT false,
  consecutive_failures integer NOT NULL DEFAULT 0,
  consecutive_healthy integer NOT NULL DEFAULT 0,
  last_healthy_at timestamptz,
  last_checked_at timestamptz,
  last_status jsonb,
  open_alert_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (old_domain, new_domain)
);

CREATE TABLE public.redirect_monitor_alerts (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  old_domain text NOT NULL,
  new_domain text NOT NULL,
  alert_type text NOT NULL,
  severity text NOT NULL DEFAULT 'critical',
  detail jsonb,
  email_sent boolean NOT NULL DEFAULT false,
  push_sent boolean NOT NULL DEFAULT false,
  recipients text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);

GRANT SELECT, UPDATE ON public.redirect_monitor TO authenticated;
GRANT ALL ON public.redirect_monitor TO service_role;
GRANT SELECT ON public.redirect_monitor_alerts TO authenticated;
GRANT ALL ON public.redirect_monitor_alerts TO service_role;

ALTER TABLE public.redirect_monitor ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.redirect_monitor_alerts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Signed-in users can view redirect monitor"
ON public.redirect_monitor FOR SELECT TO authenticated USING (true);

CREATE POLICY "Managers can update redirect monitor settings"
ON public.redirect_monitor FOR UPDATE TO authenticated
USING (public.has_role(auth.uid(), 'manager'))
WITH CHECK (public.has_role(auth.uid(), 'manager'));

CREATE POLICY "Signed-in users can view redirect monitor alerts"
ON public.redirect_monitor_alerts FOR SELECT TO authenticated USING (true);

CREATE TRIGGER update_redirect_monitor_updated_at
BEFORE UPDATE ON public.redirect_monitor
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

INSERT INTO public.redirect_monitor (old_domain, new_domain)
VALUES ('welilereceipts.com', 'welileapp.com')
ON CONFLICT (old_domain, new_domain) DO NOTHING;