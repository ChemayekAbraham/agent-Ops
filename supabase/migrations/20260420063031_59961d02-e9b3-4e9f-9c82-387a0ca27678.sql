
-- 1. Add tenancy lifecycle to rent_requests
ALTER TABLE public.rent_requests
  ADD COLUMN IF NOT EXISTS tenancy_status text NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS tenancy_ended_at timestamptz,
  ADD COLUMN IF NOT EXISTS tenancy_end_reason text,
  ADD COLUMN IF NOT EXISTS outstanding_at_end numeric;

ALTER TABLE public.rent_requests
  DROP CONSTRAINT IF EXISTS rent_requests_tenancy_status_check;
ALTER TABLE public.rent_requests
  ADD CONSTRAINT rent_requests_tenancy_status_check
  CHECK (tenancy_status IN ('active','evicted','terminated','completed'));

CREATE INDEX IF NOT EXISTS idx_rent_requests_landlord_tenancy
  ON public.rent_requests(landlord_id, tenancy_status, created_at DESC);

-- 2. Add tenant lifecycle to profiles
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS tenant_status text NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS evicted_at timestamptz,
  ADD COLUMN IF NOT EXISTS evicted_from_landlord_id uuid;

ALTER TABLE public.profiles
  DROP CONSTRAINT IF EXISTS profiles_tenant_status_check;
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_tenant_status_check
  CHECK (tenant_status IN ('active','evicted','inactive'));

-- 3. Augment tenant_replacements
ALTER TABLE public.tenant_replacements
  ADD COLUMN IF NOT EXISTS effective_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS new_rent_request_id uuid,
  ADD COLUMN IF NOT EXISTS evicted_by_role text;

-- 4. Helper: is this tenant locked from identity edits?
CREATE OR REPLACE FUNCTION public.is_tenant_locked(_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = _user_id AND tenant_status = 'evicted'
  );
$$;

-- 5. RLS: prevent identity changes on evicted tenants
-- We add a trigger guard (works regardless of caller role) — RLS alone can't compare per-column changes easily.
CREATE OR REPLACE FUNCTION public.guard_evicted_tenant_identity()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF OLD.tenant_status = 'evicted' THEN
    IF NEW.full_name IS DISTINCT FROM OLD.full_name
       OR NEW.national_id IS DISTINCT FROM OLD.national_id
       OR NEW.phone IS DISTINCT FROM OLD.phone THEN
      RAISE EXCEPTION 'Cannot modify identity fields on an evicted tenant (id=%). Record is locked for audit.', OLD.id
        USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_evicted_tenant_identity ON public.profiles;
CREATE TRIGGER trg_guard_evicted_tenant_identity
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_evicted_tenant_identity();

-- 6. Atomic replacement RPC
CREATE OR REPLACE FUNCTION public.replace_tenant_at_property(
  p_old_rent_request_id uuid,
  p_new_tenant_id uuid,
  p_reason text,
  p_effective_at timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller uuid := auth.uid();
  v_caller_role text;
  v_old_rr public.rent_requests%ROWTYPE;
  v_new_rr_id uuid;
  v_outstanding numeric;
  v_landlord_record public.landlords%ROWTYPE;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;

  IF p_reason IS NULL OR length(trim(p_reason)) < 10 THEN
    RAISE EXCEPTION 'Reason must be at least 10 characters' USING ERRCODE = '22023';
  END IF;

  IF p_old_rent_request_id = p_new_tenant_id THEN
    RAISE EXCEPTION 'Invalid input' USING ERRCODE = '22023';
  END IF;

  -- Caller role check
  SELECT role INTO v_caller_role FROM public.profiles WHERE id = v_caller;
  IF v_caller_role NOT IN ('landlord','agent','landlord_ops','coo','manager','operations','admin') THEN
    RAISE EXCEPTION 'Insufficient permissions for tenant replacement' USING ERRCODE = '42501';
  END IF;

  -- Lock old rent_request
  SELECT * INTO v_old_rr
  FROM public.rent_requests
  WHERE id = p_old_rent_request_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Old tenancy not found' USING ERRCODE = 'P0002';
  END IF;

  IF v_old_rr.tenancy_status <> 'active' THEN
    RAISE EXCEPTION 'Tenancy is not active (current: %)', v_old_rr.tenancy_status USING ERRCODE = '22023';
  END IF;

  IF v_old_rr.tenant_id = p_new_tenant_id THEN
    RAISE EXCEPTION 'New tenant must differ from current tenant' USING ERRCODE = '22023';
  END IF;

  -- Verify new tenant exists
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = p_new_tenant_id) THEN
    RAISE EXCEPTION 'New tenant profile not found' USING ERRCODE = 'P0002';
  END IF;

  -- Snapshot outstanding
  v_outstanding := COALESCE(v_old_rr.total_repayment, 0) - COALESCE(v_old_rr.amount_repaid, 0);
  IF v_outstanding < 0 THEN v_outstanding := 0; END IF;

  -- Seal the old tenancy
  UPDATE public.rent_requests
  SET tenancy_status = 'evicted',
      tenancy_ended_at = p_effective_at,
      tenancy_end_reason = p_reason,
      outstanding_at_end = v_outstanding,
      updated_at = now()
  WHERE id = p_old_rent_request_id;

  -- Flag old tenant as evicted (lock identity)
  UPDATE public.profiles
  SET tenant_status = 'evicted',
      evicted_at = p_effective_at,
      evicted_from_landlord_id = v_old_rr.landlord_id
  WHERE id = v_old_rr.tenant_id;

  -- Update landlord/property pointer
  SELECT * INTO v_landlord_record FROM public.landlords WHERE id = v_old_rr.landlord_id FOR UPDATE;
  IF FOUND THEN
    UPDATE public.landlords
    SET tenant_id = p_new_tenant_id,
        is_occupied = true,
        updated_at = now()
    WHERE id = v_old_rr.landlord_id;
  END IF;

  -- Sync house_listings if present
  UPDATE public.house_listings
  SET tenant_id = p_new_tenant_id, updated_at = now()
  WHERE landlord_id = v_old_rr.landlord_id;

  -- Insert NEW rent_request for new tenant (zero balance, pending status)
  INSERT INTO public.rent_requests (
    tenant_id, landlord_id, requested_amount, monthly_rent, duration_months,
    total_repayment, daily_repayment, amount_repaid,
    status, tenancy_status, created_at, updated_at,
    repayment_period, registration_fee, access_fee, platform_fee, monthly_rate
  )
  VALUES (
    p_new_tenant_id, v_old_rr.landlord_id, v_old_rr.requested_amount, v_old_rr.monthly_rent, v_old_rr.duration_months,
    v_old_rr.total_repayment, v_old_rr.daily_repayment, 0,
    'pending', 'active', now(), now(),
    v_old_rr.repayment_period, v_old_rr.registration_fee, v_old_rr.access_fee, v_old_rr.platform_fee, v_old_rr.monthly_rate
  )
  RETURNING id INTO v_new_rr_id;

  -- Record replacement
  INSERT INTO public.tenant_replacements (
    old_tenant_id, new_tenant_id, landlord_id, rent_request_id, new_rent_request_id,
    outstanding_balance, reason, replaced_by, evicted_by_role, effective_at
  ) VALUES (
    v_old_rr.tenant_id, p_new_tenant_id, v_old_rr.landlord_id, p_old_rent_request_id, v_new_rr_id,
    v_outstanding, p_reason, v_caller, v_caller_role, p_effective_at
  );

  -- Audit log
  INSERT INTO public.audit_logs (user_id, action, resource_type, resource_id, details, reason)
  VALUES (
    v_caller, 'tenant_replaced', 'rent_request', p_old_rent_request_id,
    jsonb_build_object(
      'old_tenant_id', v_old_rr.tenant_id,
      'new_tenant_id', p_new_tenant_id,
      'landlord_id', v_old_rr.landlord_id,
      'new_rent_request_id', v_new_rr_id,
      'outstanding_at_end', v_outstanding,
      'effective_at', p_effective_at
    ),
    p_reason
  );

  -- System event
  INSERT INTO public.system_events (event_type, severity, payload)
  VALUES (
    'tenant_replaced', 'info',
    jsonb_build_object(
      'old_rent_request_id', p_old_rent_request_id,
      'new_rent_request_id', v_new_rr_id,
      'old_tenant_id', v_old_rr.tenant_id,
      'new_tenant_id', p_new_tenant_id,
      'landlord_id', v_old_rr.landlord_id,
      'outstanding_at_end', v_outstanding,
      'caller', v_caller,
      'role', v_caller_role
    )
  );

  RETURN jsonb_build_object(
    'success', true,
    'new_rent_request_id', v_new_rr_id,
    'old_rent_request_id', p_old_rent_request_id,
    'outstanding_at_end', v_outstanding,
    'old_tenant_id', v_old_rr.tenant_id,
    'new_tenant_id', p_new_tenant_id,
    'landlord_id', v_old_rr.landlord_id
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.replace_tenant_at_property(uuid, uuid, text, timestamptz) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_tenant_locked(uuid) TO authenticated;
