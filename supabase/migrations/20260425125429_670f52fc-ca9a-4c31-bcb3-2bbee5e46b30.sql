-- 1. Audit table
CREATE TABLE IF NOT EXISTS public.field_deposit_batch_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid NOT NULL REFERENCES public.field_deposit_batches(id) ON DELETE CASCADE,
  event text NOT NULL CHECK (event IN (
    'created',
    'proof_submitted',
    'finops_verified',
    'allocation_completed',
    'rejected',
    'cancelled'
  )),
  actor_id uuid,
  actor_role text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_fdba_batch_created
  ON public.field_deposit_batch_audit (batch_id, created_at);

ALTER TABLE public.field_deposit_batch_audit ENABLE ROW LEVEL SECURITY;

-- Read access: batch-owning agent, or Financial Ops staff
DROP POLICY IF EXISTS "fdba_select_owner_or_finops" ON public.field_deposit_batch_audit;
CREATE POLICY "fdba_select_owner_or_finops"
  ON public.field_deposit_batch_audit
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.field_deposit_batches b
      WHERE b.id = field_deposit_batch_audit.batch_id
        AND b.agent_id = auth.uid()
    )
    OR public.is_financial_ops_staff(auth.uid())
  );

-- No client writes; only SECURITY DEFINER triggers/functions write here.

-- 2. Triggers that emit audit rows on lifecycle changes
CREATE OR REPLACE FUNCTION public.fdba_log_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid := auth.uid();
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.field_deposit_batch_audit (batch_id, event, actor_id, actor_role, details)
    VALUES (
      NEW.id, 'created', NEW.agent_id, 'agent',
      jsonb_build_object(
        'channel', NEW.channel,
        'declared_total', NEW.declared_total
      )
    );
    RETURN NEW;
  END IF;

  -- UPDATE
  -- proof submitted
  IF (OLD.proof_reference IS DISTINCT FROM NEW.proof_reference)
     AND NEW.proof_reference IS NOT NULL
     AND (OLD.proof_submitted_at IS NULL OR NEW.proof_submitted_at IS DISTINCT FROM OLD.proof_submitted_at)
  THEN
    INSERT INTO public.field_deposit_batch_audit (batch_id, event, actor_id, actor_role, details)
    VALUES (
      NEW.id, 'proof_submitted', COALESCE(v_actor, NEW.agent_id), 'agent',
      jsonb_build_object(
        'proof_reference', NEW.proof_reference,
        'has_image', NEW.proof_image_url IS NOT NULL
      )
    );
  END IF;

  -- finops verified
  IF (OLD.status IS DISTINCT FROM NEW.status) AND NEW.status = 'verified' THEN
    INSERT INTO public.field_deposit_batch_audit (batch_id, event, actor_id, actor_role, details)
    VALUES (
      NEW.id, 'finops_verified', NEW.finops_verified_by, 'financial_ops',
      jsonb_build_object(
        'declared_total', NEW.declared_total,
        'tagged_total', NEW.tagged_total,
        'surplus_total', NEW.surplus_total,
        'proof_entered', NEW.finops_proof_entered
      )
    );
  END IF;

  -- rejected
  IF (OLD.status IS DISTINCT FROM NEW.status) AND NEW.status = 'rejected' THEN
    INSERT INTO public.field_deposit_batch_audit (batch_id, event, actor_id, actor_role, details)
    VALUES (
      NEW.id, 'rejected', COALESCE(NEW.finops_verified_by, v_actor), 'financial_ops',
      jsonb_build_object('reason', NEW.rejection_reason)
    );
  END IF;

  -- cancelled (rare in practice; batches are usually deleted, but support it)
  IF (OLD.status IS DISTINCT FROM NEW.status) AND NEW.status = 'cancelled' THEN
    INSERT INTO public.field_deposit_batch_audit (batch_id, event, actor_id, actor_role, details)
    VALUES (NEW.id, 'cancelled', v_actor, NULL, '{}'::jsonb);
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_fdba_lifecycle_ins ON public.field_deposit_batches;
DROP TRIGGER IF EXISTS trg_fdba_lifecycle_upd ON public.field_deposit_batches;

CREATE TRIGGER trg_fdba_lifecycle_ins
  AFTER INSERT ON public.field_deposit_batches
  FOR EACH ROW EXECUTE FUNCTION public.fdba_log_lifecycle();

CREATE TRIGGER trg_fdba_lifecycle_upd
  AFTER UPDATE ON public.field_deposit_batches
  FOR EACH ROW EXECUTE FUNCTION public.fdba_log_lifecycle();

-- 3. Patch process_verified_field_deposit to emit allocation_completed
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
  v_batch              public.field_deposit_batches%ROWTYPE;
  v_item               RECORD;
  v_collection         public.field_collections%ROWTYPE;
  v_commission_rate    numeric := 0.10;
  v_commission         numeric;
  v_total_allocated    numeric := 0;
  v_total_commission   numeric := 0;
  v_surplus            numeric := 0;
  v_tagged_total       numeric := 0;
  v_allocation_count   integer := 0;
  v_result             jsonb;
BEGIN
  SELECT * INTO v_batch FROM public.field_deposit_batches WHERE id = p_batch_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Batch not found';
  END IF;
  IF v_batch.status <> 'pending_finops_verification' THEN
    RAISE EXCEPTION 'Batch is in status % and cannot be verified', v_batch.status;
  END IF;

  -- Credit declared total to agent operations float
  PERFORM public.apply_wallet_movement(
    v_batch.agent_id, 'agent_float_deposit', v_batch.declared_total, 'in'
  );

  FOR v_item IN
    SELECT bi.id AS item_id, bi.amount, bi.field_collection_id
    FROM public.field_deposit_batch_items bi
    WHERE bi.batch_id = p_batch_id
  LOOP
    SELECT * INTO v_collection FROM public.field_collections WHERE id = v_item.field_collection_id FOR UPDATE;

    UPDATE public.field_collections
       SET status = 'confirmed', confirmed_at = now()
     WHERE id = v_item.field_collection_id;

    INSERT INTO public.agent_landlord_float_allocations (
      agent_id, tenant_id, allocated_amount, source, status, notes
    ) VALUES (
      v_batch.agent_id, v_collection.tenant_id, v_item.amount,
      'field_deposit_batch',
      'allocated',
      'Field deposit batch ' || p_batch_id::text
    );

    INSERT INTO public.agent_collections (
      agent_id, tenant_id, amount, payment_method, notes, float_before, float_after
    ) VALUES (
      v_batch.agent_id, v_collection.tenant_id, v_item.amount,
      'cash',
      'Auto-recorded from verified field deposit batch',
      0, 0
    );

    PERFORM public.apply_wallet_movement(
      v_batch.agent_id, 'agent_float_used_for_rent', v_item.amount, 'out'
    );

    v_commission := round(v_item.amount * v_commission_rate);
    IF v_commission > 0 THEN
      PERFORM public.apply_wallet_movement(v_batch.agent_id, 'agent_commission_earned', v_commission, 'in');
      INSERT INTO public.agent_earnings (agent_id, amount, earning_type, description)
      VALUES (v_batch.agent_id, v_commission, 'field_collection_commission',
              'Field collection commission for ' || COALESCE(v_collection.tenant_name, 'tenant'));
      UPDATE public.field_collections
         SET commission_amount = v_commission,
             commission_paid_at = now()
       WHERE id = v_item.field_collection_id;
    END IF;

    v_tagged_total     := v_tagged_total + v_item.amount;
    v_total_allocated  := v_total_allocated + v_item.amount;
    v_total_commission := v_total_commission + v_commission;
    v_allocation_count := v_allocation_count + 1;
  END LOOP;

  v_surplus := GREATEST(0, v_batch.declared_total - v_tagged_total);

  UPDATE public.field_deposit_batches
     SET status = 'verified',
         finops_verified_by = p_finops_user,
         finops_verified_at = now(),
         finops_proof_entered = p_finops_proof_entered,
         tagged_total = v_tagged_total,
         surplus_total = v_surplus
   WHERE id = p_batch_id;

  -- Allocation audit row (status flip emits 'finops_verified' via trigger; this captures the work)
  INSERT INTO public.field_deposit_batch_audit (batch_id, event, actor_id, actor_role, details)
  VALUES (
    p_batch_id, 'allocation_completed', p_finops_user, 'system',
    jsonb_build_object(
      'allocations', v_allocation_count,
      'total_allocated', v_total_allocated,
      'total_commission', v_total_commission,
      'surplus_to_float', v_surplus
    )
  );

  v_result := jsonb_build_object(
    'allocations', v_allocation_count,
    'total_allocated', v_total_allocated,
    'total_commission', v_total_commission,
    'surplus_to_float', v_surplus
  );
  RETURN v_result;
END;
$$;

-- 4. Backfill history for existing batches
INSERT INTO public.field_deposit_batch_audit (batch_id, event, actor_id, actor_role, details, created_at)
SELECT b.id, 'created', b.agent_id, 'agent',
       jsonb_build_object('channel', b.channel, 'declared_total', b.declared_total),
       b.created_at
FROM public.field_deposit_batches b
WHERE NOT EXISTS (
  SELECT 1 FROM public.field_deposit_batch_audit a
  WHERE a.batch_id = b.id AND a.event = 'created'
);

INSERT INTO public.field_deposit_batch_audit (batch_id, event, actor_id, actor_role, details, created_at)
SELECT b.id, 'proof_submitted', b.agent_id, 'agent',
       jsonb_build_object('proof_reference', b.proof_reference, 'has_image', b.proof_image_url IS NOT NULL),
       b.proof_submitted_at
FROM public.field_deposit_batches b
WHERE b.proof_submitted_at IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.field_deposit_batch_audit a
    WHERE a.batch_id = b.id AND a.event = 'proof_submitted'
  );

INSERT INTO public.field_deposit_batch_audit (batch_id, event, actor_id, actor_role, details, created_at)
SELECT b.id, 'finops_verified', b.finops_verified_by, 'financial_ops',
       jsonb_build_object(
         'declared_total', b.declared_total,
         'tagged_total', b.tagged_total,
         'surplus_total', b.surplus_total,
         'proof_entered', b.finops_proof_entered
       ),
       b.finops_verified_at
FROM public.field_deposit_batches b
WHERE b.status = 'verified' AND b.finops_verified_at IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.field_deposit_batch_audit a
    WHERE a.batch_id = b.id AND a.event = 'finops_verified'
  );

INSERT INTO public.field_deposit_batch_audit (batch_id, event, actor_id, actor_role, details, created_at)
SELECT b.id, 'rejected', b.finops_verified_by, 'financial_ops',
       jsonb_build_object('reason', b.rejection_reason),
       COALESCE(b.finops_verified_at, b.updated_at)
FROM public.field_deposit_batches b
WHERE b.status = 'rejected'
  AND NOT EXISTS (
    SELECT 1 FROM public.field_deposit_batch_audit a
    WHERE a.batch_id = b.id AND a.event = 'rejected'
  );