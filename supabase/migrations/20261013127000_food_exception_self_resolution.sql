-- Food M1 — a Food Coordinator may not resolve an exception about their own order.
--
-- NOT APPLIED TO PRODUCTION. Applies after 20261013126000.
--
-- PROBLEM (Issue E). food_resolve_exception admits the active Food
-- Coordinator for every exception. A coordinator is also a canteen user, so
-- they could close a complaint about their own order: they would be both the
-- subject and the judge.
--
-- FIX. Refuse with 42501 when the exception concerns an order the resolving
-- coordinator placed. The exception stays open, and visible on the overview
-- and in the log, until a different active coordinator resolves it (for
-- example after a handover). No other authority is created: who handles an
-- exception the coordinator cannot is an open business decision, recorded in
-- the risk-closure register.
--
-- Everything else is unchanged from 20261009170000 (with the
-- SET search_path = public, pg_temp from 20261012120000): active coordinator
-- only, a non-blank reason, a row lock, no re-resolution, original evidence
-- kept, an append-only audit entry. Grants are kept by CREATE OR REPLACE.
--
-- ROLLBACK: re-run the definition from 20261009170000, then its ALTER ...
-- SET search_path = public, pg_temp from 20261012120000.

CREATE OR REPLACE FUNCTION public.food_resolve_exception(
  p_exception_id uuid,
  p_reason       text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor  uuid := auth.uid();
  v_reason text := btrim(coalesce(p_reason, ''));
  v_before jsonb;
  v_after  jsonb;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;
  IF NOT public.is_active_food_coordinator(v_actor) THEN
    RAISE EXCEPTION 'Only the active Food Coordinator may resolve a food exception'
      USING ERRCODE = '42501';
  END IF;

  IF v_reason = '' THEN
    RAISE EXCEPTION 'A resolution reason is required' USING ERRCODE = '22023';
  END IF;

  IF p_exception_id IS NULL THEN
    RAISE EXCEPTION 'An exception id is required' USING ERRCODE = '22023';
  END IF;

  SELECT to_jsonb(e) INTO v_before
    FROM public.food_exceptions e
   WHERE e.id = p_exception_id
     FOR UPDATE;

  IF v_before IS NULL THEN
    RAISE EXCEPTION 'That food exception does not exist' USING ERRCODE = 'P0002';
  END IF;

  IF (v_before->>'resolved_at') IS NOT NULL THEN
    RAISE EXCEPTION 'That exception was already resolved on %',
      to_char((v_before->>'resolved_at')::timestamptz, 'DD Mon YYYY HH24:MI')
      USING ERRCODE = '22023';
  END IF;

  -- Conflict of interest: never the subject and the judge.
  IF (v_before->>'order_id') IS NOT NULL AND EXISTS (
       SELECT 1 FROM public.food_orders o
        WHERE o.id = (v_before->>'order_id')::uuid AND o.employee_id = v_actor) THEN
    RAISE EXCEPTION 'A Food Coordinator cannot resolve an exception about their own order'
      USING ERRCODE = '42501',
            HINT = 'It stays open until a different Food Coordinator resolves it.';
  END IF;

  UPDATE public.food_exceptions
     SET resolved_at       = now(),
         resolved_by       = v_actor,
         resolution_reason = v_reason
   WHERE id = p_exception_id
  RETURNING to_jsonb(food_exceptions.*) INTO v_after;

  PERFORM public.food_audit_write(
    'exception', p_exception_id, 'resolved', v_before, v_after, v_reason, v_actor);

  RETURN jsonb_build_object(
    'exception_id', p_exception_id,
    'resolved_by',  v_actor,
    'resolved_at',  v_after->>'resolved_at',
    'reason',       v_reason);
END;
$$;
