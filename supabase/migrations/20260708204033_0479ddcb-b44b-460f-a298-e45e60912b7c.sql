
CREATE TABLE public.oauth_funnel_events (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  funnel_id UUID NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('google','apple')),
  stage TEXT NOT NULL CHECK (stage IN ('attempt','redirected','error','success')),
  env TEXT NOT NULL DEFAULT 'unknown',
  domain TEXT,
  origin TEXT,
  error_message TEXT,
  user_agent TEXT,
  user_id UUID,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

CREATE INDEX idx_oauth_funnel_events_funnel ON public.oauth_funnel_events (funnel_id);
CREATE INDEX idx_oauth_funnel_events_created ON public.oauth_funnel_events (created_at DESC);
CREATE INDEX idx_oauth_funnel_events_provider_stage ON public.oauth_funnel_events (provider, stage);

GRANT SELECT, INSERT ON public.oauth_funnel_events TO anon;
GRANT SELECT, INSERT ON public.oauth_funnel_events TO authenticated;
GRANT ALL ON public.oauth_funnel_events TO service_role;

ALTER TABLE public.oauth_funnel_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can log oauth funnel events"
ON public.oauth_funnel_events
FOR INSERT
TO anon, authenticated
WITH CHECK (true);

CREATE POLICY "Ops can read oauth funnel events"
ON public.oauth_funnel_events
FOR SELECT
TO authenticated
USING (
  public.has_role(auth.uid(), 'manager')
  OR public.has_role(auth.uid(), 'super_admin')
  OR public.has_role(auth.uid(), 'ceo')
  OR public.has_role(auth.uid(), 'coo')
  OR public.has_role(auth.uid(), 'cto')
);

CREATE OR REPLACE FUNCTION public.get_oauth_funnel_stats(p_days INTEGER DEFAULT 7)
RETURNS TABLE (
  provider TEXT,
  env TEXT,
  attempts BIGINT,
  redirected BIGINT,
  errors BIGINT,
  successes BIGINT,
  completion_rate NUMERIC
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH scoped AS (
    SELECT funnel_id, provider, env, stage
    FROM public.oauth_funnel_events
    WHERE created_at >= now() - (GREATEST(p_days, 1) || ' days')::interval
  ),
  per_funnel AS (
    SELECT
      funnel_id,
      max(provider) AS provider,
      max(env) AS env,
      bool_or(stage = 'attempt') AS had_attempt,
      bool_or(stage = 'redirected') AS had_redirect,
      bool_or(stage = 'error') AS had_error,
      bool_or(stage = 'success') AS had_success
    FROM scoped
    GROUP BY funnel_id
  )
  SELECT
    provider,
    env,
    count(*) FILTER (WHERE had_attempt) AS attempts,
    count(*) FILTER (WHERE had_redirect) AS redirected,
    count(*) FILTER (WHERE had_error AND NOT had_success) AS errors,
    count(*) FILTER (WHERE had_success) AS successes,
    ROUND(
      100.0 * count(*) FILTER (WHERE had_success)
      / NULLIF(count(*) FILTER (WHERE had_attempt), 0),
      1
    ) AS completion_rate
  FROM per_funnel
  GROUP BY provider, env
  ORDER BY provider, env;
$$;

GRANT EXECUTE ON FUNCTION public.get_oauth_funnel_stats(INTEGER) TO authenticated;
