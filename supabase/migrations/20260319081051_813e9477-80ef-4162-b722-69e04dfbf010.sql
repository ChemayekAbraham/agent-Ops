
-- Table to store role access requests from users
CREATE TABLE public.role_access_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  requested_role TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  reason TEXT,
  reviewed_by UUID,
  reviewed_at TIMESTAMPTZ,
  rejection_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, requested_role, status)
);

-- RLS
ALTER TABLE public.role_access_requests ENABLE ROW LEVEL SECURITY;

-- Users can view their own requests
CREATE POLICY "Users can view own requests"
  ON public.role_access_requests
  FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

-- Users can insert their own requests
CREATE POLICY "Users can create own requests"
  ON public.role_access_requests
  FOR INSERT
  TO authenticated
  WITH CHECK (user_id = auth.uid() AND status = 'pending');

-- Managers can view all requests
CREATE POLICY "Managers can view all requests"
  ON public.role_access_requests
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.user_roles
      WHERE user_id = auth.uid()
      AND role IN ('manager', 'super_admin', 'cto', 'coo')
      AND (enabled IS NULL OR enabled = true)
    )
  );

-- Managers can update requests (approve/reject)
CREATE POLICY "Managers can update requests"
  ON public.role_access_requests
  FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.user_roles
      WHERE user_id = auth.uid()
      AND role IN ('manager', 'super_admin', 'cto', 'coo')
      AND (enabled IS NULL OR enabled = true)
    )
  );
