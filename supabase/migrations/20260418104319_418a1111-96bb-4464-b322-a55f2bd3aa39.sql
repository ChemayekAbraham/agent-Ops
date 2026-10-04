-- Create public_error_logs table to capture errors from unauthenticated public pages (e.g. /record-rent)
CREATE TABLE IF NOT EXISTS public.public_error_logs (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  pathname TEXT,
  user_agent TEXT,
  error_message TEXT,
  error_stack TEXT,
  metadata JSONB
);

ALTER TABLE public.public_error_logs ENABLE ROW LEVEL SECURITY;

-- Anyone (including anonymous) can insert error logs from public pages
CREATE POLICY "Anyone can insert public error logs"
ON public.public_error_logs
FOR INSERT
TO anon, authenticated
WITH CHECK (true);

-- Only authenticated staff can read; we keep this restrictive (no select policy = no reads for anon)
CREATE POLICY "Authenticated users can view public error logs"
ON public.public_error_logs
FOR SELECT
TO authenticated
USING (true);

CREATE INDEX IF NOT EXISTS idx_public_error_logs_created_at ON public.public_error_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_public_error_logs_pathname ON public.public_error_logs (pathname);