CREATE TABLE public.user_device_sessions (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  device_id TEXT NOT NULL,
  device_label TEXT,
  user_agent TEXT,
  last_seen_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE (user_id, device_id)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_device_sessions TO authenticated;
GRANT ALL ON public.user_device_sessions TO service_role;

ALTER TABLE public.user_device_sessions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own device sessions"
ON public.user_device_sessions
FOR SELECT
TO authenticated
USING (auth.uid() = user_id);

CREATE POLICY "Users can register their own device sessions"
ON public.user_device_sessions
FOR INSERT
TO authenticated
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own device sessions"
ON public.user_device_sessions
FOR UPDATE
TO authenticated
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can remove their own device sessions"
ON public.user_device_sessions
FOR DELETE
TO authenticated
USING (auth.uid() = user_id);

CREATE INDEX idx_user_device_sessions_user_lastseen
ON public.user_device_sessions (user_id, last_seen_at DESC);