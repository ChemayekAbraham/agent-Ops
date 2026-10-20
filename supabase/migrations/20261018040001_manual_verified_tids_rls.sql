-- Run after 20261018040000. Service role and SECURITY DEFINER functions only, so
-- RLS is enabled with no policies.

ALTER TABLE public.manual_verified_tids ENABLE ROW LEVEL SECURITY;
