-- =======================================================================
-- Operational Float breakdown audit log
-- =======================================================================
CREATE TABLE IF NOT EXISTS public.operational_float_audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deposit_request_id uuid NOT NULL REFERENCES public.deposit_requests(id) ON DELETE CASCADE,
  transaction_id text,
  action text NOT NULL CHECK (action IN ('created', 'edited')),
  changed_by uuid,
  changed_at timestamptz NOT NULL DEFAULT now(),
  previous_amount numeric,
  new_amount numeric,
  previous_allocations jsonb,
  new_allocations jsonb,
  changed_fields text[] NOT NULL DEFAULT '{}',
  source text
);

CREATE INDEX IF NOT EXISTS idx_op_float_audit_deposit
  ON public.operational_float_audit_log(deposit_request_id, changed_at DESC);
CREATE INDEX IF NOT EXISTS idx_op_float_audit_tid
  ON public.operational_float_audit_log(transaction_id);
CREATE INDEX IF NOT EXISTS idx_op_float_audit_changed_by
  ON public.operational_float_audit_log(changed_by, changed_at DESC);

ALTER TABLE public.operational_float_audit_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "op_float_audit_read_owner" ON public.operational_float_audit_log;
CREATE POLICY "op_float_audit_read_owner"
ON public.operational_float_audit_log
FOR SELECT
TO authenticated
USING (
  changed_by = auth.uid()
  OR EXISTS (
    SELECT 1 FROM public.deposit_requests dr
    WHERE dr.id = operational_float_audit_log.deposit_request_id
      AND dr.user_id = auth.uid()
  )
  OR EXISTS (
    SELECT 1 FROM public.staff_permissions sp
    WHERE sp.user_id = auth.uid()
      AND sp.permitted_dashboard IN (
        'financial_ops', 'cfo', 'ceo', 'coo', 'super_admin'
      )
  )
  OR public.has_role(auth.uid(), 'super_admin')
  OR public.has_role(auth.uid(), 'manager')
);

REVOKE INSERT, UPDATE, DELETE
  ON public.operational_float_audit_log FROM anon, authenticated;

-- =======================================================================
-- Helper: extract the [ALLOCATIONS] JSON tail from a notes string.
-- =======================================================================
CREATE OR REPLACE FUNCTION public.extract_operational_float_allocations(p_notes text)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  v_prefix CONSTANT text := '[ALLOCATIONS]';
  v_idx int;
  v_raw text;
BEGIN
  IF p_notes IS NULL THEN RETURN NULL; END IF;
  v_idx := position(v_prefix IN p_notes);
  IF v_idx = 0 THEN RETURN NULL; END IF;
  v_raw := btrim(substring(p_notes FROM v_idx + length(v_prefix)));
  BEGIN
    RETURN v_raw::jsonb;
  EXCEPTION WHEN others THEN
    RETURN NULL;
  END;
END;
$$;

-- =======================================================================
-- Trigger: log every meaningful change to an operational_float deposit.
-- =======================================================================
CREATE OR REPLACE FUNCTION public.log_operational_float_breakdown_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_prev_alloc jsonb;
  v_new_alloc jsonb;
  v_changed text[] := ARRAY[]::text[];
  v_actor uuid;
BEGIN
  IF COALESCE(NEW.deposit_purpose, '') <> 'operational_float'
     AND (TG_OP = 'INSERT' OR COALESCE(OLD.deposit_purpose, '') <> 'operational_float') THEN
    RETURN NEW;
  END IF;

  -- Skip lifecycle-only updates (approve/reject) — focus the audit
  -- trail on agent breakdown edits, not reviewer state changes.
  IF TG_OP = 'UPDATE'
     AND OLD.status IS DISTINCT FROM NEW.status
     AND NEW.status IS DISTINCT FROM 'pending' THEN
    RETURN NEW;
  END IF;

  v_new_alloc := public.extract_operational_float_allocations(NEW.notes);

  IF TG_OP = 'INSERT' THEN
    v_actor := COALESCE(auth.uid(), NEW.user_id);
    INSERT INTO public.operational_float_audit_log(
      deposit_request_id, transaction_id, action, changed_by,
      previous_amount, new_amount,
      previous_allocations, new_allocations,
      changed_fields, source
    ) VALUES (
      NEW.id, NEW.transaction_id, 'created', v_actor,
      NULL, NEW.amount,
      NULL, v_new_alloc,
      ARRAY['created'], 'insert'
    );
    RETURN NEW;
  END IF;

  v_prev_alloc := public.extract_operational_float_allocations(OLD.notes);

  IF NEW.amount IS DISTINCT FROM OLD.amount THEN
    v_changed := array_append(v_changed, 'amount');
  END IF;
  IF v_new_alloc IS DISTINCT FROM v_prev_alloc THEN
    v_changed := array_append(v_changed, 'allocations');
  END IF;
  IF NEW.transaction_id IS DISTINCT FROM OLD.transaction_id THEN
    v_changed := array_append(v_changed, 'transaction_id');
  END IF;

  IF array_length(v_changed, 1) IS NULL THEN
    RETURN NEW;
  END IF;

  v_actor := COALESCE(auth.uid(), NEW.user_id);

  INSERT INTO public.operational_float_audit_log(
    deposit_request_id, transaction_id, action, changed_by,
    previous_amount, new_amount,
    previous_allocations, new_allocations,
    changed_fields, source
  ) VALUES (
    NEW.id, NEW.transaction_id, 'edited', v_actor,
    OLD.amount, NEW.amount,
    v_prev_alloc, v_new_alloc,
    v_changed, 'update'
  );

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_log_operational_float_breakdown_change
  ON public.deposit_requests;

CREATE TRIGGER trg_log_operational_float_breakdown_change
AFTER INSERT OR UPDATE OF amount, notes, transaction_id, deposit_purpose
ON public.deposit_requests
FOR EACH ROW
EXECUTE FUNCTION public.log_operational_float_breakdown_change();