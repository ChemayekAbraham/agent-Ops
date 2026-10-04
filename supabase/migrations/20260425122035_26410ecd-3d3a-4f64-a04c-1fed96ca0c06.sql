-- ============================================================
-- FIELD DEPOSIT BATCH LIFECYCLE
-- ============================================================

-- 1. Tables
CREATE TABLE IF NOT EXISTS public.field_deposit_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL,
  channel text NOT NULL CHECK (channel IN ('mtn','airtel','bank','cash_merchant')),
  declared_total numeric NOT NULL CHECK (declared_total > 0),
  tagged_total numeric NOT NULL DEFAULT 0 CHECK (tagged_total >= 0),
  surplus_total numeric NOT NULL DEFAULT 0 CHECK (surplus_total >= 0),
  proof_reference text,
  proof_image_url text,
  proof_submitted_at timestamptz,
  status text NOT NULL DEFAULT 'awaiting_proof'
    CHECK (status IN ('awaiting_proof','pending_finops_verification','verified','rejected','cancelled')),
  finops_verified_by uuid,
  finops_verified_at timestamptz,
  finops_proof_entered text,
  rejection_reason text,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_fdb_agent_status
  ON public.field_deposit_batches (agent_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_fdb_status_pending
  ON public.field_deposit_batches (status, proof_submitted_at)
  WHERE status = 'pending_finops_verification';

CREATE TABLE IF NOT EXISTS public.field_deposit_batch_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid NOT NULL REFERENCES public.field_deposit_batches(id) ON DELETE CASCADE,
  field_collection_id uuid NOT NULL REFERENCES public.field_collections(id) ON DELETE RESTRICT,
  amount numeric NOT NULL CHECK (amount > 0),
  commission_amount numeric NOT NULL DEFAULT 0,
  agent_collection_id uuid REFERENCES public.agent_collections(id) ON DELETE SET NULL,
  allocation_id uuid REFERENCES public.agent_landlord_float_allocations(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (field_collection_id)
);

CREATE INDEX IF NOT EXISTS idx_fdbi_batch ON public.field_deposit_batch_items (batch_id);

-- 2. Updated-at trigger
CREATE TRIGGER trg_fdb_updated_at
BEFORE UPDATE ON public.field_deposit_batches
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- 3. Helper: is the caller a financial-ops staffer?
CREATE OR REPLACE FUNCTION public.is_financial_ops_staff(p_user uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.staff_permissions
    WHERE user_id = p_user
      AND permitted_dashboard IN ('financial-ops','cfo','ceo','coo')
  )
  OR public.has_role(p_user, 'cfo'::app_role)
  OR public.has_role(p_user, 'ceo'::app_role)
  OR public.has_role(p_user, 'coo'::app_role)
  OR public.has_role(p_user, 'super_admin'::app_role);
$$;

-- 4. RLS
ALTER TABLE public.field_deposit_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.field_deposit_batch_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "agent_select_own_batches"
  ON public.field_deposit_batches FOR SELECT
  USING (auth.uid() = agent_id);

CREATE POLICY "agent_insert_own_batches"
  ON public.field_deposit_batches FOR INSERT
  WITH CHECK (auth.uid() = agent_id AND status = 'awaiting_proof');

CREATE POLICY "agent_update_own_pending_batches"
  ON public.field_deposit_batches FOR UPDATE
  USING (auth.uid() = agent_id AND status = 'awaiting_proof')
  WITH CHECK (auth.uid() = agent_id AND status IN ('awaiting_proof','pending_finops_verification'));

CREATE POLICY "staff_select_all_batches"
  ON public.field_deposit_batches FOR SELECT
  USING (public.is_financial_ops_staff(auth.uid()));

CREATE POLICY "staff_update_pending_batches"
  ON public.field_deposit_batches FOR UPDATE
  USING (status = 'pending_finops_verification' AND public.is_financial_ops_staff(auth.uid()));

CREATE POLICY "agent_select_own_items"
  ON public.field_deposit_batch_items FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM public.field_deposit_batches b
    WHERE b.id = batch_id AND b.agent_id = auth.uid()
  ));

CREATE POLICY "agent_insert_own_items"
  ON public.field_deposit_batch_items FOR INSERT
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.field_deposit_batches b
    WHERE b.id = batch_id AND b.agent_id = auth.uid() AND b.status = 'awaiting_proof'
  ));

CREATE POLICY "agent_delete_own_pending_items"
  ON public.field_deposit_batch_items FOR DELETE
  USING (EXISTS (
    SELECT 1 FROM public.field_deposit_batches b
    WHERE b.id = batch_id AND b.agent_id = auth.uid() AND b.status = 'awaiting_proof'
  ));

CREATE POLICY "staff_select_all_items"
  ON public.field_deposit_batch_items FOR SELECT
  USING (public.is_financial_ops_staff(auth.uid()));

-- 5. Tagged-total trigger
CREATE OR REPLACE FUNCTION public.fdb_recalc_tagged_total()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_batch uuid := COALESCE(NEW.batch_id, OLD.batch_id);
  v_sum numeric;
  v_declared numeric;
BEGIN
  SELECT COALESCE(SUM(amount), 0) INTO v_sum
    FROM public.field_deposit_batch_items WHERE batch_id = v_batch;
  SELECT declared_total INTO v_declared
    FROM public.field_deposit_batches WHERE id = v_batch;
  UPDATE public.field_deposit_batches
     SET tagged_total = v_sum,
         surplus_total = GREATEST(v_declared - v_sum, 0)
   WHERE id = v_batch;
  RETURN NULL;
END;
$$;

CREATE TRIGGER trg_fdbi_recalc
AFTER INSERT OR UPDATE OR DELETE ON public.field_deposit_batch_items
FOR EACH ROW EXECUTE FUNCTION public.fdb_recalc_tagged_total();

-- 6. Atomic fan-out RPC
CREATE OR REPLACE FUNCTION public.process_verified_field_deposit(
  p_batch_id uuid,
  p_finops_user uuid,
  p_finops_proof_entered text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_batch          public.field_deposit_batches%ROWTYPE;
  v_item           public.field_deposit_batch_items%ROWTYPE;
  v_collection     public.field_collections%ROWTYPE;
  v_commission_rate numeric := 0.10;
  v_commission     numeric;
  v_total_commission numeric := 0;
  v_total_allocated  numeric := 0;
  v_alloc_id       uuid;
  v_agent_coll_id  uuid;
  v_items_processed int := 0;
BEGIN
  SELECT * INTO v_batch FROM public.field_deposit_batches WHERE id = p_batch_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Batch % not found', p_batch_id; END IF;
  IF v_batch.status <> 'pending_finops_verification' THEN
    RAISE EXCEPTION 'Batch % is in status % — cannot verify', p_batch_id, v_batch.status;
  END IF;

  PERFORM public.apply_wallet_movement(v_batch.agent_id, 'agent_float_deposit', v_batch.declared_total, 'in');

  FOR v_item IN
    SELECT * FROM public.field_deposit_batch_items WHERE batch_id = p_batch_id ORDER BY created_at
  LOOP
    SELECT * INTO v_collection FROM public.field_collections WHERE id = v_item.field_collection_id FOR UPDATE;

    UPDATE public.field_collections
       SET status = 'confirmed', confirmed_at = now(), confirmed_by = p_finops_user
     WHERE id = v_collection.id;

    INSERT INTO public.agent_landlord_float_allocations(
      agent_id, allocated_amount, paid_out_amount,
      tenant_id, landlord_name, source, status, notes
    ) VALUES (
      v_batch.agent_id, v_item.amount, v_item.amount,
      v_collection.tenant_id,
      COALESCE(v_collection.tenant_name, 'Field collection'),
      'field_deposit_batch', 'completed',
      'Auto-allocated from verified field deposit ' || p_batch_id::text
    ) RETURNING id INTO v_alloc_id;

    INSERT INTO public.agent_collections(
      agent_id, tenant_id, amount, payment_method, float_before, float_after, notes
    ) VALUES (
      v_batch.agent_id, v_collection.tenant_id, v_item.amount, 'cash', 0, 0,
      'Field collection (batch ' || p_batch_id::text || ')'
    ) RETURNING id INTO v_agent_coll_id;

    PERFORM public.apply_wallet_movement(v_batch.agent_id, 'agent_float_used_for_rent', v_item.amount, 'out');

    v_commission := round(v_item.amount * v_commission_rate);
    IF v_commission > 0 THEN
      PERFORM public.apply_wallet_movement(v_batch.agent_id, 'agent_commission_earned', v_commission, 'in');
      INSERT INTO public.agent_earnings(agent_id, amount, earning_type, description, source_user_id)
      VALUES (v_batch.agent_id, v_commission, 'field_collection_commission',
              'Field collection commission for ' || COALESCE(v_collection.tenant_name, 'tenant'),
              v_collection.tenant_id);
    END IF;

    UPDATE public.field_deposit_batch_items
       SET commission_amount = v_commission,
           allocation_id = v_alloc_id,
           agent_collection_id = v_agent_coll_id
     WHERE id = v_item.id;

    v_total_commission := v_total_commission + v_commission;
    v_total_allocated  := v_total_allocated + v_item.amount;
    v_items_processed  := v_items_processed + 1;
  END LOOP;

  UPDATE public.field_deposit_batches
     SET status = 'verified',
         finops_verified_by = p_finops_user,
         finops_verified_at = now(),
         finops_proof_entered = p_finops_proof_entered
   WHERE id = p_batch_id;

  RETURN jsonb_build_object(
    'batch_id', p_batch_id,
    'items_processed', v_items_processed,
    'total_allocated', v_total_allocated,
    'total_commission', v_total_commission,
    'surplus_kept_as_float', GREATEST(v_batch.declared_total - v_total_allocated, 0)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.process_verified_field_deposit(uuid, uuid, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.process_verified_field_deposit(uuid, uuid, text) TO service_role;