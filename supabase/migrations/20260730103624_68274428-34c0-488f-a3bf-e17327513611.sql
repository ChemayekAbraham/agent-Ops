-- 1. Correction audit log ------------------------------------------------
CREATE TABLE public.agent_landlord_float_corrections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL,
  previous_balance numeric NOT NULL DEFAULT 0,
  corrected_balance numeric NOT NULL DEFAULT 0,
  difference numeric NOT NULL DEFAULT 0,
  open_allocation_total numeric NOT NULL DEFAULT 0,
  reason text NOT NULL,
  performed_by uuid,
  performed_by_process text NOT NULL DEFAULT 'system',
  applied boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.agent_landlord_float_corrections TO authenticated;
GRANT ALL ON public.agent_landlord_float_corrections TO service_role;

ALTER TABLE public.agent_landlord_float_corrections ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff read float corrections"
ON public.agent_landlord_float_corrections FOR SELECT TO authenticated
USING (
  public.has_role(auth.uid(), 'cfo'::app_role)
  OR public.has_role(auth.uid(), 'manager'::app_role)
  OR public.has_role(auth.uid(), 'super_admin'::app_role)
  OR public.has_role(auth.uid(), 'operations'::app_role)
  OR public.has_role(auth.uid(), 'financial_ops'::app_role)
  OR public.has_role(auth.uid(), 'agent_ops'::app_role)
);

CREATE POLICY "Agents read own float corrections"
ON public.agent_landlord_float_corrections FOR SELECT TO authenticated
USING (agent_id = auth.uid());

CREATE INDEX idx_alf_corrections_agent ON public.agent_landlord_float_corrections(agent_id, created_at DESC);
CREATE INDEX idx_alf_corrections_created ON public.agent_landlord_float_corrections(created_at DESC);

-- 2. Authoritative recompute ---------------------------------------------
CREATE OR REPLACE FUNCTION public.recompute_agent_landlord_float(
  p_agent_id uuid,
  p_reason text DEFAULT 'allocation_sync',
  p_performed_by uuid DEFAULT NULL,
  p_process text DEFAULT 'trigger',
  p_allow_increase boolean DEFAULT true,
  p_apply boolean DEFAULT true
)
RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_correct numeric := 0;
  v_prev numeric;
  v_exists boolean;
  v_apply boolean;
BEGIN
  IF p_agent_id IS NULL THEN RETURN NULL; END IF;

  SELECT COALESCE(SUM(remaining_amount), 0) INTO v_correct
  FROM public.agent_landlord_float_allocations
  WHERE agent_id = p_agent_id
    AND status IN ('open', 'partially_paid', 'return_pending');

  SELECT balance, true INTO v_prev, v_exists
  FROM public.agent_landlord_float WHERE agent_id = p_agent_id;

  IF NOT COALESCE(v_exists, false) THEN
    IF v_correct > 0 AND p_apply THEN
      INSERT INTO public.agent_landlord_float (agent_id, balance, total_funded, total_paid_out)
      VALUES (p_agent_id, v_correct, v_correct, 0)
      ON CONFLICT (agent_id) DO NOTHING;
    END IF;
    RETURN v_correct;
  END IF;

  IF v_prev = v_correct THEN RETURN v_correct; END IF;

  v_apply := p_apply AND (p_allow_increase OR v_correct < v_prev);

  IF v_apply THEN
    UPDATE public.agent_landlord_float
    SET balance = v_correct, updated_at = now()
    WHERE agent_id = p_agent_id;
  END IF;

  INSERT INTO public.agent_landlord_float_corrections (
    agent_id, previous_balance, corrected_balance, difference,
    open_allocation_total, reason, performed_by, performed_by_process, applied
  ) VALUES (
    p_agent_id, v_prev, CASE WHEN v_apply THEN v_correct ELSE v_prev END,
    v_correct - v_prev, v_correct, p_reason,
    COALESCE(p_performed_by, auth.uid()), p_process, v_apply
  );

  RETURN CASE WHEN v_apply THEN v_correct ELSE v_prev END;
END;
$$;

-- 3. Bulk reconciliation (report or apply) --------------------------------
CREATE OR REPLACE FUNCTION public.reconcile_agent_landlord_float_all(
  p_apply boolean DEFAULT false,
  p_allow_increase boolean DEFAULT false,
  p_reason text DEFAULT 'scheduled_scan',
  p_process text DEFAULT 'cron'
)
RETURNS TABLE (
  agent_id uuid,
  agent_name text,
  previous_balance numeric,
  correct_balance numeric,
  difference numeric,
  applied boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r record;
  v_apply boolean;
BEGIN
  FOR r IN
    SELECT f.agent_id AS aid,
           f.balance AS prev,
           COALESCE((
             SELECT SUM(a.remaining_amount)
             FROM public.agent_landlord_float_allocations a
             WHERE a.agent_id = f.agent_id
               AND a.status IN ('open','partially_paid','return_pending')
           ), 0) AS correct
    FROM public.agent_landlord_float f
  LOOP
    IF r.prev = r.correct THEN CONTINUE; END IF;
    v_apply := p_apply AND (p_allow_increase OR r.correct < r.prev);

    IF v_apply THEN
      UPDATE public.agent_landlord_float
      SET balance = r.correct, updated_at = now()
      WHERE agent_landlord_float.agent_id = r.aid;
    END IF;

    INSERT INTO public.agent_landlord_float_corrections (
      agent_id, previous_balance, corrected_balance, difference,
      open_allocation_total, reason, performed_by, performed_by_process, applied
    ) VALUES (
      r.aid, r.prev, CASE WHEN v_apply THEN r.correct ELSE r.prev END,
      r.correct - r.prev, r.correct, p_reason, auth.uid(), p_process, v_apply
    );

    agent_id := r.aid;
    SELECT p.full_name INTO agent_name FROM public.profiles p WHERE p.id = r.aid;
    previous_balance := r.prev;
    correct_balance := r.correct;
    difference := r.correct - r.prev;
    applied := v_apply;
    RETURN NEXT;
  END LOOP;
END;
$$;

GRANT EXECUTE ON FUNCTION public.reconcile_agent_landlord_float_all(boolean, boolean, text, text) TO authenticated;

-- 4. Keep the cache permanently in sync with allocations ------------------
CREATE OR REPLACE FUNCTION public.sync_landlord_float_from_allocation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP IN ('INSERT','UPDATE') THEN
    PERFORM public.recompute_agent_landlord_float(
      NEW.agent_id, 'allocation_' || lower(TG_OP), auth.uid(), 'allocation_trigger', true, true);
  END IF;
  IF TG_OP IN ('UPDATE','DELETE') AND OLD.agent_id IS DISTINCT FROM COALESCE(NEW.agent_id, '00000000-0000-0000-0000-000000000000'::uuid) THEN
    PERFORM public.recompute_agent_landlord_float(
      OLD.agent_id, 'allocation_' || lower(TG_OP), auth.uid(), 'allocation_trigger', true, true);
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_landlord_float_from_allocation ON public.agent_landlord_float_allocations;
CREATE TRIGGER trg_sync_landlord_float_from_allocation
AFTER INSERT OR UPDATE OR DELETE ON public.agent_landlord_float_allocations
FOR EACH ROW EXECUTE FUNCTION public.sync_landlord_float_from_allocation();

-- 5. Stop the double credit: funding history no longer mutates the float ---
DROP TRIGGER IF EXISTS trg_credit_float_on_funding ON public.agent_float_funding;

CREATE OR REPLACE FUNCTION public.credit_float_on_funding()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  -- RETIRED 2026-07-30: agent_landlord_float.balance is derived from
  -- agent_landlord_float_allocations via trg_sync_landlord_float_from_allocation.
  -- Crediting here double-counted every CFO funding call.
  RETURN NEW;
END;
$$;

-- 6. Idempotent CFO funding: one active funding row per rent request -------
ALTER TABLE public.agent_float_funding ADD COLUMN IF NOT EXISTS rent_request_id uuid;

CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_float_funding_one_per_request
ON public.agent_float_funding (rent_request_id)
WHERE rent_request_id IS NOT NULL AND status = 'active';

-- 7. Reconciliation report view -------------------------------------------
CREATE OR REPLACE VIEW public.v_agent_landlord_float_reconciliation AS
SELECT
  f.agent_id,
  p.full_name AS agent_name,
  p.phone AS agent_phone,
  f.balance AS cached_balance,
  COALESCE(a.open_total, 0) AS correct_balance,
  f.balance - COALESCE(a.open_total, 0) AS difference,
  COALESCE(a.open_count, 0) AS open_allocations,
  f.total_funded,
  f.total_paid_out,
  f.updated_at
FROM public.agent_landlord_float f
LEFT JOIN public.profiles p ON p.id = f.agent_id
LEFT JOIN (
  SELECT agent_id,
         SUM(remaining_amount) AS open_total,
         COUNT(*) AS open_count
  FROM public.agent_landlord_float_allocations
  WHERE status IN ('open','partially_paid','return_pending')
  GROUP BY agent_id
) a ON a.agent_id = f.agent_id;

GRANT SELECT ON public.v_agent_landlord_float_reconciliation TO authenticated;

-- 8. Hourly automated detection (report-only) ------------------------------
SELECT cron.unschedule('reconcile-agent-landlord-float')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'reconcile-agent-landlord-float');

SELECT cron.schedule(
  'reconcile-agent-landlord-float',
  '17 * * * *',
  $$ SELECT public.reconcile_agent_landlord_float_all(false, false, 'scheduled_scan', 'cron'); $$
);