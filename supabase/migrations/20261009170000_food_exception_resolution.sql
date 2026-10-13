-- Food exception resolution — active Food Coordinator only.
--
-- NOT APPLIED TO PRODUCTION. Sandbox-tested only.
--
-- Exceptions raised during service could be seen but never cleared. This adds
-- the one column needed to record WHY an exception was closed, and the RPC that
-- closes it.
--
-- SAFETY PROPERTIES
--   * Authorisation is decided server-side from auth.uid(), never from a
--     client-supplied id, role claim or hidden control.
--   * A resolution reason is mandatory after trimming.
--   * The exception row is UPDATED, never deleted: `kind` and `detail` — the
--     original evidence — are untouched.
--   * `food_audit` is append-only (its UPDATE/DELETE trigger raises), so the
--     history written here cannot later be edited or removed.
--   * Concurrency: the row is locked with FOR UPDATE and re-checked, so a
--     second attempt sees the first result and is refused rather than
--     overwriting it.
--   * Nothing here touches payments, wallets, balances or the general ledger.
--     No ledger category is created or referenced.
--
-- ROLLBACK: drop the function, drop the column. Non-destructive — the column is
-- additive and nullable, so dropping it loses only resolution reasons recorded
-- after this shipped. The audit history in food_audit survives independently.

ALTER TABLE public.food_exceptions
  ADD COLUMN IF NOT EXISTS resolution_reason text;

-- Why the exception was closed, in the resolver's words. Nullable because rows
-- created before this migration have none; the RPC requires it going forward.
COMMENT ON COLUMN public.food_exceptions.resolution_reason IS
  'Mandatory reason captured by food_resolve_exception(); NULL only for rows predating that function.';

CREATE OR REPLACE FUNCTION public.food_resolve_exception(
  p_exception_id uuid,
  p_reason       text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor  uuid := auth.uid();
  v_reason text := btrim(coalesce(p_reason, ''));
  v_before jsonb;
  v_after  jsonb;
BEGIN
  -- 1. Authorisation, server-side. `is_active_food_coordinator` reads the
  --    assignment table under SECURITY DEFINER, so RLS cannot be used to spoof
  --    a positive answer, and a backup holder is NOT an active coordinator.
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;
  IF NOT public.is_active_food_coordinator(v_actor) THEN
    RAISE EXCEPTION 'Only the active Food Coordinator may resolve a food exception'
      USING ERRCODE = '42501';
  END IF;

  -- 2. A reason is mandatory, and whitespace is not a reason.
  IF v_reason = '' THEN
    RAISE EXCEPTION 'A resolution reason is required' USING ERRCODE = '22023';
  END IF;

  -- 3. Validate the identifier and lock the row. FOR UPDATE is what makes two
  --    simultaneous attempts safe: the second waits here, then fails step 4.
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

  -- 4. Eligibility. An already-resolved exception is never re-resolved, so the
  --    first resolver's reason and identity can never be overwritten.
  IF (v_before->>'resolved_at') IS NOT NULL THEN
    RAISE EXCEPTION 'That exception was already resolved on %',
      to_char((v_before->>'resolved_at')::timestamptz, 'DD Mon YYYY HH24:MI')
      USING ERRCODE = '22023';
  END IF;

  -- 5. Resolve. `kind` and `detail` are deliberately not touched — the original
  --    evidence is preserved exactly as it was raised.
  UPDATE public.food_exceptions
     SET resolved_at       = now(),
         resolved_by       = v_actor,
         resolution_reason = v_reason
   WHERE id = p_exception_id
  RETURNING to_jsonb(food_exceptions.*) INTO v_after;

  -- 6. Append-only audit history: who, when, why, which exception, and the
  --    full before/after state. food_audit's trigger blocks UPDATE and DELETE,
  --    so this entry is permanent.
  PERFORM public.food_audit_write(
    'exception', p_exception_id, 'resolved', v_before, v_after, v_reason, v_actor);

  RETURN jsonb_build_object(
    'exception_id', p_exception_id,
    'resolved_by',  v_actor,
    'resolved_at',  v_after->>'resolved_at',
    'reason',       v_reason);
END;
$$;

-- Least privilege: not callable by anon or PUBLIC. `authenticated` may call it,
-- and the check inside decides — the same pattern as every other food RPC.
REVOKE ALL ON FUNCTION public.food_resolve_exception(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.food_resolve_exception(uuid, text) TO authenticated;
