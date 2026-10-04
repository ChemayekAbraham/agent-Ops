-- 1) Idempotency tracker on payouts
ALTER TABLE public.landlord_payouts
  ADD COLUMN IF NOT EXISTS allocation_applied_id uuid;

-- 2) Apply payout to allocation as soon as float is committed (idempotent)
CREATE OR REPLACE FUNCTION public.apply_landlord_payout_to_allocation()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_alloc_id uuid;
BEGIN
  -- Only act once the agent's float is actually committed to this payout.
  IF NEW.status NOT IN ('pending_finops_disbursement','awaiting_agent_receipt','disbursed','completed') THEN
    RETURN NEW;
  END IF;

  -- Idempotency: never apply the same payout twice as it moves through states.
  IF NEW.allocation_applied_id IS NOT NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.rent_request_id IS NULL AND NEW.tenant_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Prefer the allocation tied to the exact rent request.
  SELECT id INTO v_alloc_id
  FROM public.agent_landlord_float_allocations
  WHERE agent_id = NEW.agent_id
    AND rent_request_id = NEW.rent_request_id
    AND status IN ('open','partially_paid')
  ORDER BY created_at ASC LIMIT 1;

  -- Fallback: match by tenant.
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

    -- Lock this payout so later status changes can't re-apply it.
    UPDATE public.landlord_payouts
    SET allocation_applied_id = v_alloc_id
    WHERE id = NEW.id;
  END IF;

  RETURN NEW;
END;
$$;

-- Recreate trigger so it also fires on the committed (pending_finops) transition.
DROP TRIGGER IF EXISTS trg_landlord_payout_to_allocation ON public.landlord_payouts;
CREATE TRIGGER trg_landlord_payout_to_allocation
AFTER UPDATE OF status ON public.landlord_payouts
FOR EACH ROW EXECUTE FUNCTION public.apply_landlord_payout_to_allocation();

-- 3) Backfill: payouts whose float already left but whose allocation was never marked.
DO $backfill$
DECLARE p RECORD; v_alloc_id uuid;
BEGIN
  FOR p IN
    SELECT * FROM public.landlord_payouts
    WHERE status IN ('pending_finops_disbursement','awaiting_agent_receipt','disbursed','completed')
      AND allocation_applied_id IS NULL
    ORDER BY created_at ASC
  LOOP
    v_alloc_id := NULL;

    SELECT id INTO v_alloc_id
    FROM public.agent_landlord_float_allocations
    WHERE agent_id = p.agent_id
      AND rent_request_id = p.rent_request_id
      AND status IN ('open','partially_paid')
    ORDER BY created_at ASC LIMIT 1;

    IF v_alloc_id IS NULL THEN
      SELECT id INTO v_alloc_id
      FROM public.agent_landlord_float_allocations
      WHERE agent_id = p.agent_id
        AND tenant_id IS NOT DISTINCT FROM p.tenant_id
        AND status IN ('open','partially_paid')
      ORDER BY created_at ASC LIMIT 1;
    END IF;

    IF v_alloc_id IS NOT NULL THEN
      UPDATE public.agent_landlord_float_allocations
      SET paid_out_amount = paid_out_amount + p.amount
      WHERE id = v_alloc_id;

      UPDATE public.landlord_payouts
      SET allocation_applied_id = v_alloc_id
      WHERE id = p.id;
    END IF;
  END LOOP;
END
$backfill$;