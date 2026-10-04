-- Backend guard: operational-float deposits must carry a tenant
-- allocation breakdown whose amounts sum to the deposit amount within
-- a 1 UGX tolerance. Prevents bypassing the in-app allocator by
-- writing directly to the table via PostgREST.
--
-- The breakdown is encoded in deposit_requests.notes as a fenced JSON
-- tail: "... | [ALLOCATIONS][{\"tid\":\"...\",\"a\":12345}, ...]"
-- (see encodeAllocationsNote in the client). The trigger parses that
-- tail; any mismatch / missing payload raises an exception.

CREATE OR REPLACE FUNCTION public.validate_operational_float_allocations()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_prefix CONSTANT text := '[ALLOCATIONS]';
  v_idx int;
  v_raw text;
  v_payload jsonb;
  v_sum numeric := 0;
  v_count int := 0;
  v_tolerance CONSTANT numeric := 1; -- UGX
BEGIN
  -- Only enforce on operational_float purpose. Other purposes are not
  -- required to carry an allocations payload.
  IF COALESCE(NEW.deposit_purpose, '') <> 'operational_float' THEN
    RETURN NEW;
  END IF;

  -- Allow rows to leave 'pending' without re-validating (approve/reject
  -- flows). We only guard while the row is being authored by the agent.
  IF TG_OP = 'UPDATE' AND NEW.status IS DISTINCT FROM 'pending' THEN
    RETURN NEW;
  END IF;

  IF NEW.notes IS NULL THEN
    RAISE EXCEPTION 'Operational Float deposits require a per-tenant allocation breakdown'
      USING ERRCODE = 'check_violation';
  END IF;

  v_idx := position(v_prefix IN NEW.notes);
  IF v_idx = 0 THEN
    RAISE EXCEPTION 'Operational Float deposits require a per-tenant allocation breakdown'
      USING ERRCODE = 'check_violation';
  END IF;

  v_raw := btrim(substring(NEW.notes FROM v_idx + length(v_prefix)));

  BEGIN
    v_payload := v_raw::jsonb;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'Operational Float allocation payload is malformed JSON'
      USING ERRCODE = 'check_violation';
  END;

  IF jsonb_typeof(v_payload) <> 'array' THEN
    RAISE EXCEPTION 'Operational Float allocation payload must be a JSON array'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT
    COALESCE(SUM((elem->>'a')::numeric), 0),
    COUNT(*)
  INTO v_sum, v_count
  FROM jsonb_array_elements(v_payload) AS elem
  WHERE COALESCE(elem->>'tid', '') <> '';

  IF v_count = 0 THEN
    RAISE EXCEPTION 'Operational Float deposits require at least one tenant allocation'
      USING ERRCODE = 'check_violation';
  END IF;

  IF abs(v_sum - NEW.amount) > v_tolerance THEN
    RAISE EXCEPTION
      'Operational Float allocations (UGX %) must equal deposit amount (UGX %) within % UGX (off by UGX %)',
      v_sum, NEW.amount, v_tolerance, abs(v_sum - NEW.amount)
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_validate_operational_float_allocations
  ON public.deposit_requests;

CREATE TRIGGER trg_validate_operational_float_allocations
BEFORE INSERT OR UPDATE OF amount, notes, deposit_purpose, status
ON public.deposit_requests
FOR EACH ROW
EXECUTE FUNCTION public.validate_operational_float_allocations();