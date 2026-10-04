CREATE TABLE IF NOT EXISTS public.support_diagnostic_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token text NOT NULL UNIQUE,
  report text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '7 days'),
  first_viewed_at timestamptz,
  view_count integer NOT NULL DEFAULT 0
);

GRANT ALL ON public.support_diagnostic_reports TO service_role;

ALTER TABLE public.support_diagnostic_reports ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_support_diag_reports_expires
  ON public.support_diagnostic_reports (expires_at);