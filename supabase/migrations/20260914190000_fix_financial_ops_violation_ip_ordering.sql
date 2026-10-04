-- Fixes the same XFF-before-cf-connecting-ip ordering bug found during
-- the adversarial regression pass, in a pre-existing function that
-- predates this initiative but is squarely a security/financial-ops
-- evidence function: log_financial_ops_violation records who attempted
-- an unauthorized financial-ops action. If its IP attribution can be
-- spoofed, its forensic value is weakened -- explicitly flagged for
-- priority fixing.
--
-- Two bugs, actually:
-- 1. The ordering itself: x-forwarded-for's first hop checked before
--    cf-connecting-ip, the wrong trust order (see 20260914180000 for the
--    full reasoning -- a client can pre-set its own x-forwarded-for
--    header before the request ever reaches Cloudflare).
-- 2. A dead fallback: `coalesce(split_part(...), cf-connecting-ip)` can
--    never actually reach the cf-connecting-ip side, because split_part
--    on a coalesced-to-'' input returns '' (not NULL), so coalesce()
--    never falls through. A separate `IF v_ip = '' THEN ...` line papered
--    over the empty-string case, but the net effect was still "prefer
--    x-forwarded-for whenever present at all."
--
-- Also added the SupabaseEdgeRuntime edge-runtime guard this function
-- never had, consistent with every other capture point in this series --
-- appropriate for a function whose whole purpose is producing trustworthy
-- security evidence.

CREATE OR REPLACE FUNCTION public.log_financial_ops_violation(p_action text, p_context jsonb DEFAULT '{}'::jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_headers jsonb;
  v_ip text;
  v_ua text;
  v_name text;
  v_phone text;
  v_roles text[];
  v_id uuid;
BEGIN
  BEGIN
    v_headers := coalesce(current_setting('request.headers', true), '{}')::jsonb;
  EXCEPTION WHEN others THEN
    v_headers := '{}'::jsonb;
  END;

  v_ua := v_headers ->> 'user-agent';

  IF v_ua IS NOT NULL AND v_ua ILIKE '%SupabaseEdgeRuntime%' THEN
    v_ip := NULL;
    v_ua := NULL;
  ELSE
    v_ip := nullif(v_headers ->> 'cf-connecting-ip', '');
    IF v_ip IS NULL THEN
      v_ip := nullif(split_part(coalesce(v_headers ->> 'x-forwarded-for', ''), ',', 1), '');
    END IF;
  END IF;

  SELECT p.name, p.phone INTO v_name, v_phone
  FROM public.profiles p WHERE p.id = v_actor;

  SELECT array_agg(DISTINCT ur.role::text) INTO v_roles
  FROM public.user_roles ur WHERE ur.user_id = v_actor;

  INSERT INTO public.financial_ops_security_violations
    (user_id, full_name, phone, roles, attempted_action, context, ip_address, user_agent)
  VALUES
    (v_actor, v_name, v_phone, coalesce(v_roles, '{}'), p_action,
     coalesce(p_context, '{}'::jsonb), v_ip, v_ua)
  RETURNING id INTO v_id;

  -- Immediate security notification (best effort, never blocks the denial).
  BEGIN
    PERFORM net.http_post(
      url := 'https://wirntoujqoyjobfhyelc.supabase.co/functions/v1/financial-ops-security-alert',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Indpcm50b3VqcW95am9iZmh5ZWxjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjY1NjE1MTYsImV4cCI6MjA4MjEzNzUxNn0.5-zxcRPVxvpxNiXhoo5VHpIuvbtuOLfiI3ph8jPIod8'
      ),
      body := jsonb_build_object('violation_id', v_id)
    );
  EXCEPTION WHEN others THEN
    NULL;
  END;

  RETURN v_id;
END;
$function$;
