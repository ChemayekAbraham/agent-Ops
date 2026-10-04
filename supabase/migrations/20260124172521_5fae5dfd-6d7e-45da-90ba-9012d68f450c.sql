-- Create user_login_history table to track login events
CREATE TABLE IF NOT EXISTS public.user_login_history (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  login_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  ip_address TEXT,
  user_agent TEXT,
  login_method TEXT DEFAULT 'password', -- password, google, magic_link, etc.
  success BOOLEAN DEFAULT true,
  metadata JSONB DEFAULT '{}'::jsonb
);

-- Enable RLS
ALTER TABLE public.user_login_history ENABLE ROW LEVEL SECURITY;

-- Only managers can view login history
CREATE POLICY "Managers can view all login history"
ON public.user_login_history
FOR SELECT
USING (
  EXISTS (
    SELECT 1 FROM user_roles
    WHERE user_id = auth.uid() AND role = 'manager' AND enabled = true
  )
);

-- Create index for efficient queries
CREATE INDEX idx_user_login_history_user_id ON public.user_login_history(user_id);
CREATE INDEX idx_user_login_history_login_at ON public.user_login_history(login_at DESC);

-- Create user_activity_log table for tracking all user actions
CREATE TABLE IF NOT EXISTS public.user_activity_log (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  activity_type TEXT NOT NULL, -- login, logout, role_change, verification, profile_update, etc.
  description TEXT NOT NULL,
  metadata JSONB DEFAULT '{}'::jsonb,
  performed_by UUID, -- who performed the action (for admin actions)
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.user_activity_log ENABLE ROW LEVEL SECURITY;

-- Managers can view all activity
CREATE POLICY "Managers can view all user activity"
ON public.user_activity_log
FOR SELECT
USING (
  EXISTS (
    SELECT 1 FROM user_roles
    WHERE user_id = auth.uid() AND role = 'manager' AND enabled = true
  )
);

-- Users can view their own activity
CREATE POLICY "Users can view their own activity"
ON public.user_activity_log
FOR SELECT
USING (user_id = auth.uid());

-- System can insert activity
CREATE POLICY "System can insert activity"
ON public.user_activity_log
FOR INSERT
WITH CHECK (true);

-- Create indexes
CREATE INDEX idx_user_activity_log_user_id ON public.user_activity_log(user_id);
CREATE INDEX idx_user_activity_log_created_at ON public.user_activity_log(created_at DESC);
CREATE INDEX idx_user_activity_log_type ON public.user_activity_log(activity_type);