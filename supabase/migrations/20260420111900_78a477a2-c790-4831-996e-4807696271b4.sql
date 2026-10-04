CREATE TABLE IF NOT EXISTS public.agent_landlord_float_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL,
  tenant_id uuid,
  rent_request_id uuid,
  landlord_id uuid,
  landlord_name text NOT NULL DEFAULT 'Unknown Landlord',
  landlord_phone text,
  mobile_money_provider text,
  allocated_amount numeric NOT NULL DEFAULT 0 CHECK (allocated_amount >= 0),
  paid_out_amount numeric NOT NULL DEFAULT 0 CHECK (paid_out_amount >= 0),
  remaining_amount numeric GENERATED ALWAYS AS (GREATEST(allocated_amount - paid_out_amount, 0)) STORED,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','partially_paid','fully_paid','cancelled')),
  source text NOT NULL DEFAULT 'cfo_disbursement',
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_alfa_agent_status ON public.agent_landlord_float_allocations (agent_id, status);
CREATE INDEX IF NOT EXISTS idx_alfa_tenant ON public.agent_landlord_float_allocations (tenant_id);
CREATE INDEX IF NOT EXISTS idx_alfa_rent_request ON public.agent_landlord_float_allocations (rent_request_id);
CREATE INDEX IF NOT EXISTS idx_alfa_landlord ON public.agent_landlord_float_allocations (landlord_id);

CREATE OR REPLACE FUNCTION public.touch_alfa_updated_at()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END;
$$;

DROP TRIGGER IF EXISTS trg_alfa_updated_at ON public.agent_landlord_float_allocations;
CREATE TRIGGER trg_alfa_updated_at
BEFORE UPDATE ON public.agent_landlord_float_allocations
FOR EACH ROW EXECUTE FUNCTION public.touch_alfa_updated_at();

CREATE OR REPLACE FUNCTION public.recompute_alfa_status()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NEW.status = 'cancelled' THEN RETURN NEW; END IF;
  IF NEW.paid_out_amount <= 0 THEN NEW.status := 'open';
  ELSIF NEW.paid_out_amount >= NEW.allocated_amount THEN NEW.status := 'fully_paid';
  ELSE NEW.status := 'partially_paid';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_alfa_status ON public.agent_landlord_float_allocations;
CREATE TRIGGER trg_alfa_status
BEFORE INSERT OR UPDATE OF allocated_amount, paid_out_amount ON public.agent_landlord_float_allocations
FOR EACH ROW EXECUTE FUNCTION public.recompute_alfa_status();

ALTER TABLE public.agent_landlord_float_allocations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Agents view own allocations" ON public.agent_landlord_float_allocations;
CREATE POLICY "Agents view own allocations" ON public.agent_landlord_float_allocations
FOR SELECT TO authenticated USING (agent_id = auth.uid());

DROP POLICY IF EXISTS "Tenants view own allocations" ON public.agent_landlord_float_allocations;
CREATE POLICY "Tenants view own allocations" ON public.agent_landlord_float_allocations
FOR SELECT TO authenticated USING (tenant_id = auth.uid());

DROP POLICY IF EXISTS "Staff view all allocations" ON public.agent_landlord_float_allocations;
CREATE POLICY "Staff view all allocations" ON public.agent_landlord_float_allocations
FOR SELECT TO authenticated USING (
  public.has_role(auth.uid(), 'manager'::app_role)
  OR public.has_role(auth.uid(), 'super_admin'::app_role)
  OR public.has_role(auth.uid(), 'cfo'::app_role)
  OR public.has_role(auth.uid(), 'coo'::app_role)
  OR public.has_role(auth.uid(), 'operations'::app_role)
);

CREATE OR REPLACE FUNCTION public.apply_landlord_payout_to_allocation()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_alloc_id uuid;
BEGIN
  IF NEW.status <> 'completed' OR (OLD.status IS NOT DISTINCT FROM 'completed') THEN
    RETURN NEW;
  END IF;
  IF NEW.rent_request_id IS NULL THEN RETURN NEW; END IF;

  SELECT id INTO v_alloc_id
  FROM public.agent_landlord_float_allocations
  WHERE agent_id = NEW.agent_id
    AND rent_request_id = NEW.rent_request_id
    AND status IN ('open','partially_paid')
  ORDER BY created_at ASC LIMIT 1;

  IF v_alloc_id IS NULL THEN
    SELECT id INTO v_alloc_id
    FROM public.agent_landlord_float_allocations
    WHERE agent_id = NEW.agent_id
      AND tenant_id IS NOT DISTINCT FROM NEW.tenant_id
      AND status IN ('open','partially_paid')
    ORDER BY created_at ASC LIMIT 1;
  END IF;

  IF v_alloc_id IS NOT NULL THEN
    UPDATE public.agent_landlord_float_allocations
    SET paid_out_amount = paid_out_amount + NEW.amount
    WHERE id = v_alloc_id;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_landlord_payout_to_allocation ON public.landlord_payouts;
CREATE TRIGGER trg_landlord_payout_to_allocation
AFTER UPDATE OF status ON public.landlord_payouts
FOR EACH ROW EXECUTE FUNCTION public.apply_landlord_payout_to_allocation();

CREATE OR REPLACE FUNCTION public.create_landlord_float_allocation(
  p_agent_id uuid,
  p_rent_request_id uuid,
  p_amount numeric,
  p_source text DEFAULT 'cfo_disbursement'
)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_id uuid;
  v_existing uuid;
  v_tenant_id uuid;
  v_landlord_id uuid;
  v_landlord_name text;
  v_landlord_phone text;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Allocation amount must be positive';
  END IF;

  SELECT id INTO v_existing
  FROM public.agent_landlord_float_allocations
  WHERE agent_id = p_agent_id
    AND rent_request_id = p_rent_request_id
    AND source = p_source
  LIMIT 1;

  IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;

  SELECT rr.tenant_id, rr.landlord_id
  INTO v_tenant_id, v_landlord_id
  FROM public.rent_requests rr
  WHERE rr.id = p_rent_request_id;

  SELECT l.name, COALESCE(l.mobile_money_number, l.phone)
  INTO v_landlord_name, v_landlord_phone
  FROM public.landlords l
  WHERE l.id = v_landlord_id;

  INSERT INTO public.agent_landlord_float_allocations (
    agent_id, tenant_id, rent_request_id, landlord_id,
    landlord_name, landlord_phone,
    allocated_amount, source
  ) VALUES (
    p_agent_id, v_tenant_id, p_rent_request_id, v_landlord_id,
    COALESCE(v_landlord_name, 'Unknown Landlord'), v_landlord_phone,
    p_amount, p_source
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_landlord_float_allocation(uuid, uuid, numeric, text) TO authenticated, service_role;

INSERT INTO public.agent_landlord_float_allocations (
  agent_id, allocated_amount, paid_out_amount,
  landlord_name, source, notes
)
SELECT
  alf.agent_id, alf.balance, 0,
  'Unallocated legacy float', 'legacy_backfill',
  'Auto-created during Phase 1 migration to preserve existing float balance'
FROM public.agent_landlord_float alf
WHERE alf.balance > 0
  AND NOT EXISTS (
    SELECT 1 FROM public.agent_landlord_float_allocations a
    WHERE a.agent_id = alf.agent_id AND a.source = 'legacy_backfill'
  );