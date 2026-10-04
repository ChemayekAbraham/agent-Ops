CREATE TABLE public.mobile_rollout_config (
  id TEXT NOT NULL PRIMARY KEY DEFAULT 'current',
  stage TEXT NOT NULL DEFAULT 'canary',
  rollout_percent INTEGER NOT NULL DEFAULT 0,
  enabled BOOLEAN NOT NULL DEFAULT true,
  notes TEXT,
  updated_by UUID,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  CONSTRAINT mobile_rollout_percent_range CHECK (rollout_percent >= 0 AND rollout_percent <= 100),
  CONSTRAINT mobile_rollout_singleton CHECK (id = 'current')
);

GRANT SELECT ON public.mobile_rollout_config TO anon;
GRANT SELECT, INSERT, UPDATE ON public.mobile_rollout_config TO authenticated;
GRANT ALL ON public.mobile_rollout_config TO service_role;

ALTER TABLE public.mobile_rollout_config ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Rollout config is readable by everyone"
ON public.mobile_rollout_config
FOR SELECT
USING (true);

CREATE POLICY "Managers can insert rollout config"
ON public.mobile_rollout_config
FOR INSERT
TO authenticated
WITH CHECK (public.has_role(auth.uid(), 'manager'));

CREATE POLICY "Managers can update rollout config"
ON public.mobile_rollout_config
FOR UPDATE
TO authenticated
USING (public.has_role(auth.uid(), 'manager'))
WITH CHECK (public.has_role(auth.uid(), 'manager'));

CREATE TRIGGER update_mobile_rollout_config_updated_at
BEFORE UPDATE ON public.mobile_rollout_config
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();

INSERT INTO public.mobile_rollout_config (id, stage, rollout_percent, enabled, notes)
VALUES ('current', 'canary', 0, true, 'Initial canary stage — start at 0% and ramp up after verifying the iPhone update fix.')
ON CONFLICT (id) DO NOTHING;