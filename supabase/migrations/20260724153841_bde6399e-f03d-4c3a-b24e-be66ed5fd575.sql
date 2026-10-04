
-- 1. Guard trigger on agent_advance_requests: block approval/payment if principal < 10,000
CREATE OR REPLACE FUNCTION public.enforce_agent_advance_min_principal()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_min_principal CONSTANT NUMERIC := 10000;
BEGIN
  -- Only enforce on transitions into approval/payment states
  IF NEW.status IN ('agent_ops_approved', 'cfo_approved', 'cfo_paid')
     AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM NEW.status)
  THEN
    IF COALESCE(NEW.principal, 0) < v_min_principal THEN
      RAISE EXCEPTION 'Advance principal (UGX %) is below the minimum of UGX 10,000. Reject the request instead of approving a token amount.',
        COALESCE(NEW.principal, 0)
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_agent_advance_min_principal ON public.agent_advance_requests;
CREATE TRIGGER trg_enforce_agent_advance_min_principal
BEFORE INSERT OR UPDATE ON public.agent_advance_requests
FOR EACH ROW
EXECUTE FUNCTION public.enforce_agent_advance_min_principal();

-- 2. Guard trigger on agent_advances (the disbursed record)
CREATE OR REPLACE FUNCTION public.enforce_agent_advance_row_min_principal()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF COALESCE(NEW.principal, 0) < 10000 THEN
    RAISE EXCEPTION 'Cannot create an agent advance with principal below UGX 10,000 (got UGX %).', COALESCE(NEW.principal, 0)
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_agent_advance_row_min_principal ON public.agent_advances;
CREATE TRIGGER trg_enforce_agent_advance_row_min_principal
BEFORE INSERT ON public.agent_advances
FOR EACH ROW
EXECUTE FUNCTION public.enforce_agent_advance_row_min_principal();

-- 3. Clean up orphan "cfo_paid" requests that never actually disbursed
--    (no matching agent_advances row AND no ledger entries).
UPDATE public.agent_advance_requests r
SET status = 'pending',
    cfo_paid_at = NULL,
    paid_by_cfo = NULL,
    cfo_approved_at = NULL,
    cfo_approved_by = NULL,
    cfo_notes = COALESCE(cfo_notes, '') ||
      CASE WHEN COALESCE(cfo_notes,'') = '' THEN '' ELSE ' · ' END ||
      '[Auto-reverted 2026-07-24: token principal <UGX 10,000 was flipped to cfo_paid but never disbursed. Please reject or resubmit with a proper amount.]'
WHERE r.principal < 10000
  AND r.status = 'cfo_paid'
  AND NOT EXISTS (
    SELECT 1 FROM public.agent_advances a
    WHERE a.agent_id = r.agent_id
      AND a.created_at BETWEEN r.cfo_paid_at - interval '5 min' AND r.cfo_paid_at + interval '5 min'
  )
  AND NOT EXISTS (
    SELECT 1 FROM public.general_ledger g
    WHERE g.source_table = 'agent_advance_requests'
      AND g.source_id = r.id
  );
