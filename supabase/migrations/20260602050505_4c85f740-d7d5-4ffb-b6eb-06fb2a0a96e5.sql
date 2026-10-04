-- ============================================================
-- Tenant Ops: search + edit tenant rent balance / rent amount
-- with full edit history and editor attribution.
-- Edits to rent_amount recompute daily_repayment which drives
-- the agent daily target (v_agent_daily_eligibility).
-- ============================================================

-- 1. Edit history table
CREATE TABLE public.tenant_balance_edits (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  rent_request_id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  agent_id uuid,
  editor_id uuid NOT NULL,
  editor_name text,
  old_rent_amount numeric,
  new_rent_amount numeric,
  old_total_repayment numeric,
  new_total_repayment numeric,
  old_amount_repaid numeric,
  new_amount_repaid numeric,
  old_daily_repayment numeric,
  new_daily_repayment numeric,
  old_outstanding numeric,
  new_outstanding numeric,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_tenant_balance_edits_rr ON public.tenant_balance_edits(rent_request_id, created_at DESC);
CREATE INDEX idx_tenant_balance_edits_tenant ON public.tenant_balance_edits(tenant_id);

GRANT SELECT ON public.tenant_balance_edits TO authenticated;
GRANT ALL ON public.tenant_balance_edits TO service_role;

ALTER TABLE public.tenant_balance_edits ENABLE ROW LEVEL SECURITY;

-- Only ops staff can read the edit history
CREATE POLICY "Ops staff can view tenant balance edits"
ON public.tenant_balance_edits
FOR SELECT
TO authenticated
USING (public.is_tenant_ops_staff(auth.uid()));

-- 2. Search RPC: find any tenant's rent requests for editing
CREATE OR REPLACE FUNCTION public.ops_search_tenant_rents(p_search text)
RETURNS TABLE (
  rent_request_id uuid,
  tenant_id uuid,
  tenant_name text,
  tenant_phone text,
  agent_id uuid,
  agent_name text,
  landlord_name text,
  status text,
  rent_amount numeric,
  total_repayment numeric,
  amount_repaid numeric,
  daily_repayment numeric,
  outstanding numeric,
  created_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    rr.id,
    rr.tenant_id,
    tp.full_name,
    tp.phone,
    rr.agent_id,
    ap.full_name,
    lp.full_name,
    rr.status,
    rr.rent_amount,
    rr.total_repayment,
    rr.amount_repaid,
    rr.daily_repayment,
    GREATEST(COALESCE(rr.total_repayment,0) - COALESCE(rr.amount_repaid,0), 0),
    rr.created_at
  FROM public.rent_requests rr
  LEFT JOIN public.profiles tp ON tp.id = rr.tenant_id
  LEFT JOIN public.profiles ap ON ap.id = rr.agent_id
  LEFT JOIN public.profiles lp ON lp.id = rr.landlord_id
  WHERE public.is_tenant_ops_staff(auth.uid())
    AND (
      p_search IS NULL OR length(trim(p_search)) < 2 OR
      tp.full_name ILIKE '%' || trim(p_search) || '%' OR
      tp.phone ILIKE '%' || trim(p_search) || '%' OR
      tp.national_id ILIKE '%' || trim(p_search) || '%' OR
      ap.full_name ILIKE '%' || trim(p_search) || '%'
    )
  ORDER BY rr.created_at DESC
  LIMIT 50;
$$;

GRANT EXECUTE ON FUNCTION public.ops_search_tenant_rents(text) TO authenticated;

-- 3. History RPC
CREATE OR REPLACE FUNCTION public.ops_tenant_balance_history(p_rent_request_id uuid)
RETURNS SETOF public.tenant_balance_edits
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT *
  FROM public.tenant_balance_edits
  WHERE rent_request_id = p_rent_request_id
    AND public.is_tenant_ops_staff(auth.uid())
  ORDER BY created_at DESC;
$$;

GRANT EXECUTE ON FUNCTION public.ops_tenant_balance_history(uuid) TO authenticated;

-- 4. Edit RPC: apply rent_amount / balance correction
CREATE OR REPLACE FUNCTION public.ops_edit_tenant_balance(
  p_rent_request_id uuid,
  p_new_rent_amount numeric,
  p_new_outstanding numeric,
  p_reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_editor_name text;
  r record;
  v_new_rent numeric;
  v_new_access numeric;
  v_new_request numeric;
  v_new_total numeric;
  v_new_repaid numeric;
  v_new_daily numeric;
  v_new_outstanding numeric;
  v_duration integer;
BEGIN
  IF NOT public.is_tenant_ops_staff(v_uid) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  IF p_reason IS NULL OR length(trim(p_reason)) < 10 THEN
    RAISE EXCEPTION 'A reason of at least 10 characters is required';
  END IF;

  SELECT * INTO r FROM public.rent_requests WHERE id = p_rent_request_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Rent request not found';
  END IF;

  v_duration := GREATEST(COALESCE(r.duration_days, 1), 1);
  v_new_rent := COALESCE(p_new_rent_amount, r.rent_amount);
  IF v_new_rent <= 0 THEN
    RAISE EXCEPTION 'Rent amount must be greater than zero';
  END IF;

  IF p_new_rent_amount IS NOT NULL AND p_new_rent_amount <> r.rent_amount THEN
    -- Scale access fee linearly with rent (preserves original rate), recompute request fee + totals
    IF COALESCE(r.rent_amount,0) > 0 THEN
      v_new_access := round(COALESCE(r.access_fee,0) * v_new_rent / r.rent_amount);
    ELSE
      v_new_access := round(v_new_rent * (power(1.33, v_duration::numeric / 30) - 1));
    END IF;
    v_new_request := CASE WHEN v_new_rent <= 200000 THEN 10000 ELSE 20000 END;
    v_new_total := v_new_rent + v_new_access + v_new_request;
    v_new_daily := ceil(v_new_total / v_duration);
  ELSE
    v_new_access := r.access_fee;
    v_new_request := r.request_fee;
    v_new_total := r.total_repayment;
    v_new_daily := r.daily_repayment;
  END IF;

  -- Balance (outstanding) edit: derive amount_repaid from desired outstanding
  IF p_new_outstanding IS NOT NULL THEN
    IF p_new_outstanding < 0 THEN
      RAISE EXCEPTION 'Outstanding balance cannot be negative';
    END IF;
    v_new_repaid := LEAST(GREATEST(v_new_total - p_new_outstanding, 0), v_new_total);
  ELSE
    -- keep prior repaid but never exceed new total
    v_new_repaid := LEAST(COALESCE(r.amount_repaid,0), v_new_total);
  END IF;

  v_new_outstanding := GREATEST(v_new_total - v_new_repaid, 0);

  UPDATE public.rent_requests
  SET rent_amount = v_new_rent,
      access_fee = v_new_access,
      request_fee = v_new_request,
      total_repayment = v_new_total,
      daily_repayment = v_new_daily,
      amount_repaid = v_new_repaid,
      updated_at = now()
  WHERE id = p_rent_request_id;

  SELECT full_name INTO v_editor_name FROM public.profiles WHERE id = v_uid;

  INSERT INTO public.tenant_balance_edits (
    rent_request_id, tenant_id, agent_id, editor_id, editor_name,
    old_rent_amount, new_rent_amount,
    old_total_repayment, new_total_repayment,
    old_amount_repaid, new_amount_repaid,
    old_daily_repayment, new_daily_repayment,
    old_outstanding, new_outstanding,
    reason
  ) VALUES (
    p_rent_request_id, r.tenant_id, r.agent_id, v_uid, v_editor_name,
    r.rent_amount, v_new_rent,
    r.total_repayment, v_new_total,
    r.amount_repaid, v_new_repaid,
    r.daily_repayment, v_new_daily,
    GREATEST(COALESCE(r.total_repayment,0) - COALESCE(r.amount_repaid,0), 0), v_new_outstanding,
    trim(p_reason)
  );

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, metadata)
  VALUES (
    v_uid, 'ops_tenant_balance_edit', 'rent_requests', p_rent_request_id::text,
    jsonb_build_object(
      'reason', trim(p_reason),
      'old_rent_amount', r.rent_amount, 'new_rent_amount', v_new_rent,
      'old_total_repayment', r.total_repayment, 'new_total_repayment', v_new_total,
      'old_amount_repaid', r.amount_repaid, 'new_amount_repaid', v_new_repaid,
      'old_daily_repayment', r.daily_repayment, 'new_daily_repayment', v_new_daily,
      'new_outstanding', v_new_outstanding
    )
  );

  RETURN jsonb_build_object(
    'rent_request_id', p_rent_request_id,
    'rent_amount', v_new_rent,
    'total_repayment', v_new_total,
    'amount_repaid', v_new_repaid,
    'daily_repayment', v_new_daily,
    'outstanding', v_new_outstanding
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.ops_edit_tenant_balance(uuid, numeric, numeric, text) TO authenticated;