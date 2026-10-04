-- Create force refresh signals table
CREATE TABLE public.force_refresh_signals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  target_user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  triggered_by UUID NOT NULL,
  triggered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '5 minutes'),
  message TEXT
);

-- Enable RLS
ALTER TABLE public.force_refresh_signals ENABLE ROW LEVEL SECURITY;

-- Users can see signals targeted to them or to everyone (null)
CREATE POLICY "Users can see their refresh signals"
ON public.force_refresh_signals FOR SELECT
USING (target_user_id = auth.uid() OR target_user_id IS NULL);

-- Managers can insert signals
CREATE POLICY "Managers can create refresh signals"
ON public.force_refresh_signals FOR INSERT
WITH CHECK (
  EXISTS (SELECT 1 FROM user_roles WHERE user_id = auth.uid() AND role = 'manager')
);

-- Enable realtime for instant notifications
ALTER PUBLICATION supabase_realtime ADD TABLE public.force_refresh_signals;