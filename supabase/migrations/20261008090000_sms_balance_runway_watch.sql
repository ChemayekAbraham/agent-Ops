-- SMS provider (Yoola) low-balance early warning.
-- Yoola returns the remaining credit balance in every send response, so the
-- latest balance and the 24h burn rate are derivable from sms_delivery_log.
-- Board week ending 2026-10-07: 555 messages were refused for lack of credit on
-- 5 of 7 days; the balance was ~654 credits within the last 48h against ~4,300
-- credits/day burn. This gives ops a runway figure BEFORE the refusals start.

CREATE TABLE IF NOT EXISTS public.sms_balance_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  level text NOT NULL CHECK (level IN ('warning', 'critical')),
  balance_credits numeric NOT NULL,
  credits_24h numeric NOT NULL,
  runway_hours numeric,
  emailed boolean NOT NULL DEFAULT false
);
ALTER TABLE public.sms_balance_alerts ENABLE ROW LEVEL SECURITY;
-- No policies: service role only (the edge function), never the client.

CREATE OR REPLACE FUNCTION public.get_sms_balance_runway()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH s AS (
    SELECT created_at,
           COALESCE(provider_response->>'balance',
                    provider_response->'attempts'->0->'response'->>'balance')::numeric AS bal,
           COALESCE(provider_response->>'credits_used',
                    provider_response->'attempts'->0->'response'->>'credits_used')::numeric AS cu
    FROM public.sms_delivery_log
    WHERE created_at >= now() - interval '24 hours'
      AND provider_response IS NOT NULL
      AND (provider_response ? 'balance' OR provider_response->'attempts'->0->'response' ? 'balance')
  ), latest AS (
    SELECT bal, created_at FROM s ORDER BY created_at DESC LIMIT 1
  ), burn AS (
    SELECT COALESCE(sum(cu), 0) AS credits_24h FROM s
  )
  SELECT jsonb_build_object(
    'balance_credits', (SELECT bal FROM latest),
    'balance_as_of', (SELECT created_at FROM latest),
    'credits_24h', (SELECT credits_24h FROM burn),
    'runway_hours', CASE WHEN (SELECT credits_24h FROM burn) > 0
                         THEN round(((SELECT bal FROM latest) / (SELECT credits_24h FROM burn)) * 24, 1) END
  );
$$;
REVOKE ALL ON FUNCTION public.get_sms_balance_runway() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_sms_balance_runway() TO service_role;
