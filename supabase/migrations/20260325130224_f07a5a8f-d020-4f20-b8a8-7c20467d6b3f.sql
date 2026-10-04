
-- Shadow audit logs: stores comparison results
CREATE TABLE public.shadow_audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  function_name text NOT NULL,
  primary_passed boolean NOT NULL,
  shadow_passed boolean NOT NULL,
  is_match boolean NOT NULL GENERATED ALWAYS AS (primary_passed = shadow_passed) STORED,
  shadow_errors jsonb DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- No RLS — only service role writes
ALTER TABLE public.shadow_audit_logs ENABLE ROW LEVEL SECURITY;

-- Index for monitoring queries
CREATE INDEX idx_shadow_audit_logs_function_created ON public.shadow_audit_logs (function_name, created_at DESC);

-- Shadow config: single-row routing config
CREATE TABLE public.shadow_config (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sample_percentage integer NOT NULL DEFAULT 10 CHECK (sample_percentage >= 0 AND sample_percentage <= 100),
  enabled boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.shadow_config ENABLE ROW LEVEL SECURITY;

-- Seed single config row
INSERT INTO public.shadow_config (sample_percentage, enabled) VALUES (10, true);

-- Monitoring function: match rate per function
CREATE OR REPLACE FUNCTION public.get_shadow_match_rate(p_hours integer DEFAULT 24)
RETURNS TABLE (
  function_name text,
  total_samples bigint,
  matches bigint,
  divergences bigint,
  match_rate_pct numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    function_name,
    count(*) AS total_samples,
    count(*) FILTER (WHERE is_match) AS matches,
    count(*) FILTER (WHERE NOT is_match) AS divergences,
    ROUND(100.0 * count(*) FILTER (WHERE is_match) / NULLIF(count(*), 0), 2) AS match_rate_pct
  FROM public.shadow_audit_logs
  WHERE created_at >= now() - make_interval(hours => p_hours)
  GROUP BY function_name
  ORDER BY function_name;
$$;
