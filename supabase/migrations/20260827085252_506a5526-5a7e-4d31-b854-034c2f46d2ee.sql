CREATE TABLE public.merchant_capacity_overrides (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  agent_id uuid NOT NULL,
  override_capacity numeric(14,2) NOT NULL,
  effective_from timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  reason text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  created_by uuid NOT NULL,
  revoked_by uuid,
  revoked_at timestamptz,
  revoke_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT merchant_capacity_overrides_amount_check CHECK (override_capacity >= 0 AND override_capacity <= 50000000),
  CONSTRAINT merchant_capacity_overrides_reason_check CHECK (char_length(btrim(reason)) >= 10),
  CONSTRAINT merchant_capacity_overrides_status_check CHECK (status IN ('active','revoked','expired')),
  CONSTRAINT merchant_capacity_overrides_window_check CHECK (expires_at > effective_from)
);

GRANT SELECT ON public.merchant_capacity_overrides TO authenticated;
GRANT ALL ON public.merchant_capacity_overrides TO service_role;

ALTER TABLE public.merchant_capacity_overrides ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Finance and ops leadership can view capacity overrides"
ON public.merchant_capacity_overrides
FOR SELECT
TO authenticated
USING (
  public.has_role(auth.uid(), 'financial_ops')
  OR public.has_role(auth.uid(), 'cfo')
  OR public.has_role(auth.uid(), 'coo')
  OR public.has_role(auth.uid(), 'manager')
  OR public.has_role(auth.uid(), 'super_admin')
);

CREATE INDEX idx_merchant_capacity_overrides_agent_active
  ON public.merchant_capacity_overrides (agent_id, status, expires_at DESC);
CREATE INDEX idx_merchant_capacity_overrides_created_at
  ON public.merchant_capacity_overrides (created_at DESC);

CREATE TRIGGER trg_merchant_capacity_overrides_updated_at
BEFORE UPDATE ON public.merchant_capacity_overrides
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Who may SET or REVOKE an override (stricter than who may read it).
CREATE OR REPLACE FUNCTION public.assert_merchant_capacity_override_admin()
RETURNS uuid
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF public.has_role(v_uid, 'financial_ops')
     OR public.has_role(v_uid, 'manager')
     OR public.has_role(v_uid, 'super_admin') THEN
    RETURN v_uid;
  END IF;
  RAISE EXCEPTION 'Not authorized: capacity overrides are restricted to Financial Ops, manager and super admin';
END;
$$;

REVOKE ALL ON FUNCTION public.assert_merchant_capacity_override_admin() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.assert_merchant_capacity_override_admin() TO authenticated, service_role;

-- Set (or replace) a temporary override. Recommendation only: no wallet,
-- float or ledger effect anywhere in this function.
CREATE OR REPLACE FUNCTION public.set_merchant_capacity_override(
  p_agent_id uuid,
  p_capacity numeric,
  p_days integer,
  p_reason text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := public.assert_merchant_capacity_override_admin();
  v_id uuid;
  v_days integer := coalesce(p_days, 1);
BEGIN
  IF p_agent_id IS NULL THEN
    RAISE EXCEPTION 'Agent is required';
  END IF;
  IF p_capacity IS NULL OR p_capacity < 0 THEN
    RAISE EXCEPTION 'Override amount must be zero or more';
  END IF;
  IF v_days < 1 OR v_days > 90 THEN
    RAISE EXCEPTION 'Override duration must be between 1 and 90 days';
  END IF;
  IF coalesce(char_length(btrim(p_reason)), 0) < 10 THEN
    RAISE EXCEPTION 'A reason of at least 10 characters is required';
  END IF;

  UPDATE public.merchant_capacity_overrides
     SET status = 'revoked',
         revoked_by = v_uid,
         revoked_at = now(),
         revoke_reason = coalesce(revoke_reason, 'Replaced by a newer override')
   WHERE agent_id = p_agent_id
     AND status = 'active';

  INSERT INTO public.merchant_capacity_overrides (
    agent_id, override_capacity, effective_from, expires_at, reason, created_by
  ) VALUES (
    p_agent_id, round(p_capacity, 2), now(), now() + make_interval(days => v_days), btrim(p_reason), v_uid
  ) RETURNING id INTO v_id;

  INSERT INTO public.audit_logs (action_type, table_name, record_id, user_id, reason, new_values)
  VALUES (
    'merchant_capacity_override_set',
    'merchant_capacity_overrides',
    v_id,
    v_uid,
    btrim(p_reason),
    jsonb_build_object(
      'agent_id', p_agent_id,
      'override_capacity', round(p_capacity, 2),
      'days', v_days,
      'expires_at', now() + make_interval(days => v_days)
    )
  );

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.set_merchant_capacity_override(uuid, numeric, integer, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_merchant_capacity_override(uuid, numeric, integer, text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.revoke_merchant_capacity_override(
  p_override_id uuid,
  p_reason text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := public.assert_merchant_capacity_override_admin();
  v_row public.merchant_capacity_overrides;
BEGIN
  IF coalesce(char_length(btrim(p_reason)), 0) < 10 THEN
    RAISE EXCEPTION 'A reason of at least 10 characters is required';
  END IF;

  SELECT * INTO v_row
    FROM public.merchant_capacity_overrides
   WHERE id = p_override_id
   FOR UPDATE;

  IF v_row.id IS NULL THEN
    RAISE EXCEPTION 'Override not found';
  END IF;
  IF v_row.status <> 'active' THEN
    RAISE EXCEPTION 'Override is no longer active';
  END IF;

  UPDATE public.merchant_capacity_overrides
     SET status = 'revoked',
         revoked_by = v_uid,
         revoked_at = now(),
         revoke_reason = btrim(p_reason)
   WHERE id = p_override_id;

  INSERT INTO public.audit_logs (action_type, table_name, record_id, user_id, reason, old_values, new_values)
  VALUES (
    'merchant_capacity_override_revoked',
    'merchant_capacity_overrides',
    p_override_id,
    v_uid,
    btrim(p_reason),
    jsonb_build_object('status', v_row.status, 'override_capacity', v_row.override_capacity),
    jsonb_build_object('status', 'revoked')
  );

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.revoke_merchant_capacity_override(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.revoke_merchant_capacity_override(uuid, text) TO authenticated, service_role;

-- Read path: active overrides plus full history, in one round trip.
CREATE OR REPLACE FUNCTION public.merchant_capacity_overrides_report(p_limit integer DEFAULT 200)
RETURNS TABLE (
  id uuid,
  agent_id uuid,
  agent_name text,
  override_capacity numeric,
  effective_from timestamptz,
  expires_at timestamptz,
  reason text,
  status text,
  is_in_force boolean,
  created_by uuid,
  created_by_name text,
  created_at timestamptz,
  revoked_by uuid,
  revoked_by_name text,
  revoked_at timestamptz,
  revoke_reason text
)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT o.id,
         o.agent_id,
         coalesce(pa.full_name, 'Merchant agent') AS agent_name,
         o.override_capacity,
         o.effective_from,
         o.expires_at,
         o.reason,
         CASE WHEN o.status = 'active' AND o.expires_at <= now() THEN 'expired' ELSE o.status END AS status,
         (o.status = 'active' AND o.effective_from <= now() AND o.expires_at > now()) AS is_in_force,
         o.created_by,
         coalesce(pc.full_name, 'Financial Ops') AS created_by_name,
         o.created_at,
         o.revoked_by,
         pr.full_name AS revoked_by_name,
         o.revoked_at,
         o.revoke_reason
    FROM public.merchant_capacity_overrides o
    LEFT JOIN public.profiles pa ON pa.id = o.agent_id
    LEFT JOIN public.profiles pc ON pc.id = o.created_by
    LEFT JOIN public.profiles pr ON pr.id = o.revoked_by
   WHERE public.assert_merchant_float_alloc_access()
   ORDER BY (o.status = 'active' AND o.expires_at > now()) DESC, o.created_at DESC
   LIMIT greatest(1, least(coalesce(p_limit, 200), 500));
$$;

REVOKE ALL ON FUNCTION public.merchant_capacity_overrides_report(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.merchant_capacity_overrides_report(integer) TO authenticated, service_role;