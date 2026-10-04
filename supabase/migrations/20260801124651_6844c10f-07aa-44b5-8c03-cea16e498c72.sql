-- 1. Per-caller counters for the public (no-auth) MCP endpoint.
CREATE TABLE public.mcp_public_rate_limits (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  caller_hash TEXT NOT NULL UNIQUE,
  minute_start TIMESTAMPTZ NOT NULL DEFAULT now(),
  minute_count INTEGER NOT NULL DEFAULT 0,
  hour_start TIMESTAMPTZ NOT NULL DEFAULT now(),
  hour_count INTEGER NOT NULL DEFAULT 0,
  total_calls BIGINT NOT NULL DEFAULT 0,
  blocked_until TIMESTAMPTZ,
  block_count INTEGER NOT NULL DEFAULT 0,
  last_tool TEXT,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT ON public.mcp_public_rate_limits TO authenticated;
GRANT ALL ON public.mcp_public_rate_limits TO service_role;

ALTER TABLE public.mcp_public_rate_limits ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Ops can view public MCP rate limits"
ON public.mcp_public_rate_limits
FOR SELECT
TO authenticated
USING (
  public.has_role(auth.uid(), 'super_admin')
  OR public.has_role(auth.uid(), 'cto')
  OR public.has_role(auth.uid(), 'cfo')
  OR public.has_role(auth.uid(), 'manager')
);

CREATE INDEX idx_mcp_public_rate_limits_last_seen
  ON public.mcp_public_rate_limits (last_seen_at DESC);
CREATE INDEX idx_mcp_public_rate_limits_blocked
  ON public.mcp_public_rate_limits (blocked_until)
  WHERE blocked_until IS NOT NULL;

-- 2. Abuse / rejection log.
CREATE TABLE public.mcp_public_abuse_events (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  caller_hash TEXT NOT NULL,
  tool TEXT,
  reason TEXT NOT NULL,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT ON public.mcp_public_abuse_events TO authenticated;
GRANT ALL ON public.mcp_public_abuse_events TO service_role;

ALTER TABLE public.mcp_public_abuse_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Ops can view public MCP abuse events"
ON public.mcp_public_abuse_events
FOR SELECT
TO authenticated
USING (
  public.has_role(auth.uid(), 'super_admin')
  OR public.has_role(auth.uid(), 'cto')
  OR public.has_role(auth.uid(), 'cfo')
  OR public.has_role(auth.uid(), 'manager')
);

CREATE INDEX idx_mcp_public_abuse_events_created
  ON public.mcp_public_abuse_events (created_at DESC);
CREATE INDEX idx_mcp_public_abuse_events_caller
  ON public.mcp_public_abuse_events (caller_hash, created_at DESC);

CREATE TRIGGER update_mcp_public_rate_limits_updated_at
BEFORE UPDATE ON public.mcp_public_rate_limits
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- 3. Atomic sliding-window rate check. Called by the public MCP endpoint
--    before every tool run. Never stores a raw IP — only a one-way hash.
CREATE OR REPLACE FUNCTION public.check_mcp_public_rate_limit(
  p_caller_hash TEXT,
  p_tool TEXT DEFAULT NULL,
  p_per_minute INTEGER DEFAULT 30,
  p_per_hour INTEGER DEFAULT 300
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_hash TEXT;
  v_row public.mcp_public_rate_limits;
  v_now TIMESTAMPTZ := now();
  v_per_minute INTEGER := GREATEST(1, LEAST(COALESCE(p_per_minute, 30), 600));
  v_per_hour INTEGER := GREATEST(1, LEAST(COALESCE(p_per_hour, 300), 20000));
  v_retry INTEGER;
  v_reason TEXT;
BEGIN
  v_hash := NULLIF(btrim(COALESCE(p_caller_hash, '')), '');
  IF v_hash IS NULL THEN
    -- Unidentifiable caller: allow but do not track (fail-open, never fail-shut
    -- on a public informational endpoint).
    RETURN jsonb_build_object('allowed', true, 'reason', 'untracked');
  END IF;
  v_hash := left(v_hash, 128);

  INSERT INTO public.mcp_public_rate_limits (caller_hash, last_tool)
  VALUES (v_hash, left(COALESCE(p_tool, ''), 120))
  ON CONFLICT (caller_hash) DO NOTHING;

  SELECT * INTO v_row
  FROM public.mcp_public_rate_limits
  WHERE caller_hash = v_hash
  FOR UPDATE;

  -- Currently serving a temporary block.
  IF v_row.blocked_until IS NOT NULL AND v_row.blocked_until > v_now THEN
    v_retry := GREATEST(1, CEIL(EXTRACT(EPOCH FROM (v_row.blocked_until - v_now)))::INTEGER);
    UPDATE public.mcp_public_rate_limits
      SET last_seen_at = v_now, last_tool = left(COALESCE(p_tool, last_tool), 120)
    WHERE caller_hash = v_hash;
    RETURN jsonb_build_object(
      'allowed', false,
      'reason', 'temporarily_blocked',
      'retry_after_seconds', v_retry
    );
  END IF;

  -- Roll the windows.
  IF v_row.minute_start < v_now - INTERVAL '1 minute' THEN
    v_row.minute_start := v_now;
    v_row.minute_count := 0;
  END IF;
  IF v_row.hour_start < v_now - INTERVAL '1 hour' THEN
    v_row.hour_start := v_now;
    v_row.hour_count := 0;
  END IF;

  v_row.minute_count := v_row.minute_count + 1;
  v_row.hour_count := v_row.hour_count + 1;

  IF v_row.minute_count > v_per_minute THEN
    v_reason := 'per_minute_limit';
    v_retry := GREATEST(1, 60 - FLOOR(EXTRACT(EPOCH FROM (v_now - v_row.minute_start)))::INTEGER);
  ELSIF v_row.hour_count > v_per_hour THEN
    v_reason := 'per_hour_limit';
    v_retry := GREATEST(1, 3600 - FLOOR(EXTRACT(EPOCH FROM (v_now - v_row.hour_start)))::INTEGER);
  END IF;

  IF v_reason IS NULL THEN
    UPDATE public.mcp_public_rate_limits
      SET minute_start = v_row.minute_start,
          minute_count = v_row.minute_count,
          hour_start = v_row.hour_start,
          hour_count = v_row.hour_count,
          total_calls = total_calls + 1,
          last_tool = left(COALESCE(p_tool, last_tool), 120),
          last_seen_at = v_now,
          blocked_until = NULL
    WHERE caller_hash = v_hash;

    RETURN jsonb_build_object(
      'allowed', true,
      'remaining_this_minute', GREATEST(0, v_per_minute - v_row.minute_count),
      'remaining_this_hour', GREATEST(0, v_per_hour - v_row.hour_count)
    );
  END IF;

  -- Over the limit. Escalate repeat offenders to a 15-minute block; a hard
  -- burst (3x the minute allowance) is blocked immediately.
  v_row.block_count := v_row.block_count + 1;
  IF v_row.block_count >= 3 OR v_row.minute_count > (v_per_minute * 3) THEN
    v_row.blocked_until := v_now + INTERVAL '15 minutes';
    v_retry := 900;
    v_reason := 'temporarily_blocked';
  END IF;

  UPDATE public.mcp_public_rate_limits
    SET minute_start = v_row.minute_start,
        minute_count = v_row.minute_count,
        hour_start = v_row.hour_start,
        hour_count = v_row.hour_count,
        block_count = v_row.block_count,
        blocked_until = v_row.blocked_until,
        last_tool = left(COALESCE(p_tool, last_tool), 120),
        last_seen_at = v_now
  WHERE caller_hash = v_hash;

  INSERT INTO public.mcp_public_abuse_events (caller_hash, tool, reason, details)
  VALUES (
    v_hash,
    left(COALESCE(p_tool, ''), 120),
    v_reason,
    jsonb_build_object(
      'minute_count', v_row.minute_count,
      'hour_count', v_row.hour_count,
      'per_minute', v_per_minute,
      'per_hour', v_per_hour,
      'block_count', v_row.block_count
    )
  );

  RETURN jsonb_build_object(
    'allowed', false,
    'reason', v_reason,
    'retry_after_seconds', v_retry
  );
END;
$$;

REVOKE ALL ON FUNCTION public.check_mcp_public_rate_limit(TEXT, TEXT, INTEGER, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.check_mcp_public_rate_limit(TEXT, TEXT, INTEGER, INTEGER) TO anon, authenticated, service_role;

-- 4. Housekeeping.
CREATE OR REPLACE FUNCTION public.cleanup_mcp_public_rate_limits()
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  DELETE FROM public.mcp_public_rate_limits
  WHERE last_seen_at < now() - INTERVAL '7 days'
    AND (blocked_until IS NULL OR blocked_until < now());

  DELETE FROM public.mcp_public_abuse_events
  WHERE created_at < now() - INTERVAL '30 days';
END;
$$;

REVOKE ALL ON FUNCTION public.cleanup_mcp_public_rate_limits() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.cleanup_mcp_public_rate_limits() TO service_role;

SELECT cron.schedule(
  'cleanup-mcp-public-rate-limits',
  '20 3 * * *',
  $$SELECT public.cleanup_mcp_public_rate_limits();$$
);