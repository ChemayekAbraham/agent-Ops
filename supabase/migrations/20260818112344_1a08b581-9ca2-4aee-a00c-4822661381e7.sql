-- 1) Audit table for unauthorized Financial Ops edit attempts
CREATE TABLE IF NOT EXISTS public.financial_ops_security_violations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid,
  full_name text,
  phone text,
  roles text[] NOT NULL DEFAULT '{}',
  attempted_action text NOT NULL,
  context jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip_address text,
  user_agent text,
  notified boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.financial_ops_security_violations TO authenticated;
GRANT ALL ON public.financial_ops_security_violations TO service_role;

ALTER TABLE public.financial_ops_security_violations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Finance and execs can read finops violations" ON public.financial_ops_security_violations;
CREATE POLICY "Finance and execs can read finops violations"
ON public.financial_ops_security_violations
FOR SELECT TO authenticated
USING (
  public.has_role(auth.uid(), 'financial_ops'::app_role)
  OR public.has_role(auth.uid(), 'cfo'::app_role)
  OR public.has_role(auth.uid(), 'ceo'::app_role)
  OR public.has_role(auth.uid(), 'coo'::app_role)
  OR public.has_role(auth.uid(), 'super_admin'::app_role)
);

CREATE INDEX IF NOT EXISTS idx_finops_violations_created_at
  ON public.financial_ops_security_violations (created_at DESC);

-- 2) Logger: writes the audit row and fires the security notification.
CREATE OR REPLACE FUNCTION public.log_financial_ops_violation(
  p_action text,
  p_context jsonb DEFAULT '{}'::jsonb
)
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

  v_ip := coalesce(
    split_part(coalesce(v_headers ->> 'x-forwarded-for', ''), ',', 1),
    v_headers ->> 'cf-connecting-ip'
  );
  IF v_ip = '' THEN v_ip := v_headers ->> 'cf-connecting-ip'; END IF;
  v_ua := v_headers ->> 'user-agent';

  SELECT p.name, p.phone INTO v_name, v_phone
  FROM public.profiles p WHERE p.id = v_actor;

  SELECT array_agg(DISTINCT ur.role::text) INTO v_roles
  FROM public.user_roles ur WHERE ur.user_id = v_actor;

  INSERT INTO public.financial_ops_security_violations
    (user_id, full_name, phone, roles, attempted_action, context, ip_address, user_agent)
  VALUES
    (v_actor, v_name, v_phone, coalesce(v_roles, '{}'), p_action,
     coalesce(p_context, '{}'::jsonb), nullif(v_ip, ''), v_ua)
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

REVOKE ALL ON FUNCTION public.log_financial_ops_violation(text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.log_financial_ops_violation(text, jsonb) TO service_role;

-- 3) Guard: TRUE when the caller may edit; logs + notifies when not.
CREATE OR REPLACE FUNCTION public.finops_edit_authorized(
  p_action text,
  p_context jsonb DEFAULT '{}'::jsonb
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
BEGIN
  IF v_actor IS NOT NULL AND public.has_role(v_actor, 'financial_ops'::app_role) THEN
    RETURN true;
  END IF;
  PERFORM public.log_financial_ops_violation(p_action, p_context);
  RETURN false;
END;
$function$;

REVOKE ALL ON FUNCTION public.finops_edit_authorized(text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finops_edit_authorized(text, jsonb) TO service_role;

-- 4) Financial-Ops-only entry point for narrative merchant fixes.
CREATE OR REPLACE FUNCTION public.post_merchant_float_adjustment(
  p_desk_id uuid,
  p_agent_id uuid,
  p_adjustment_type text,
  p_amount numeric,
  p_reason text,
  p_evidence_note text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_reason text := btrim(coalesce(p_reason, ''));
  v_desk_agent uuid;
  v_row public.merchant_float_reconciliations;
BEGIN
  IF v_actor IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'Not authenticated');
  END IF;

  IF NOT public.finops_edit_authorized(
       'merchant_float_adjustment',
       jsonb_build_object('desk_id', p_desk_id, 'agent_id', p_agent_id,
                          'adjustment_type', p_adjustment_type, 'amount', p_amount)
     ) THEN
    RETURN jsonb_build_object(
      'ok', false,
      'unauthorized', true,
      'reason', 'Blocked: only the Financial Ops role can edit merchant balances. This attempt has been logged and reported.'
    );
  END IF;

  IF char_length(v_reason) < 10 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'A reason of at least 10 characters is required');
  END IF;
  IF p_amount IS NULL OR round(p_amount) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'Enter a non-zero amount');
  END IF;

  SELECT agent_id INTO v_desk_agent FROM public.cashout_agents WHERE id = p_desk_id;
  IF v_desk_agent IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'Merchant desk not found or has no linked agent');
  END IF;

  INSERT INTO public.merchant_float_reconciliations
    (desk_id, agent_id, adjustment_type, amount, reason, evidence_note, created_by)
  VALUES
    (p_desk_id, coalesce(p_agent_id, v_desk_agent), p_adjustment_type, round(p_amount),
     v_reason, nullif(btrim(coalesce(p_evidence_note, '')), ''), v_actor)
  RETURNING * INTO v_row;

  RETURN jsonb_build_object(
    'ok', true,
    'id', v_row.id,
    'adjustment_type', v_row.adjustment_type,
    'amount', v_row.amount,
    'created_at', v_row.created_at
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.post_merchant_float_adjustment(uuid, uuid, text, numeric, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.post_merchant_float_adjustment(uuid, uuid, text, numeric, text, text) TO authenticated, service_role;

-- 5) Direct table writes are no longer a bypass: Financial Ops only.
DROP POLICY IF EXISTS "Finance can post merchant reconciliations" ON public.merchant_float_reconciliations;
CREATE POLICY "Financial Ops can post merchant reconciliations"
ON public.merchant_float_reconciliations
FOR INSERT TO authenticated
WITH CHECK (
  created_by = auth.uid()
  AND public.has_role(auth.uid(), 'financial_ops'::app_role)
);

-- 6) Cache re-seed had no guard at all — Financial Ops only.
CREATE OR REPLACE FUNCTION public.finops_sync_merchant_desk_float_cache(
  p_desk_id uuid,
  p_reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'Not authenticated');
  END IF;
  IF NOT public.finops_edit_authorized(
       'merchant_float_cache_reseed',
       jsonb_build_object('desk_id', p_desk_id, 'reason', p_reason)
     ) THEN
    RETURN jsonb_build_object(
      'ok', false,
      'unauthorized', true,
      'reason', 'Blocked: only the Financial Ops role can edit merchant balances. This attempt has been logged and reported.'
    );
  END IF;
  RETURN jsonb_build_object('ok', true, 'result',
    public.sync_merchant_desk_float_cache(p_desk_id, p_reason));
END;
$function$;

REVOKE ALL ON FUNCTION public.finops_sync_merchant_desk_float_cache(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.finops_sync_merchant_desk_float_cache(uuid, text) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.sync_merchant_desk_float_cache(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sync_merchant_desk_float_cache(uuid, text) TO service_role;
