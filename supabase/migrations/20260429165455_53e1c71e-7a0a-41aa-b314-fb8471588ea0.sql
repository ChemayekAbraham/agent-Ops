-- Bulk-reject 9 withdrawal_requests stuck in 'manager_approved' with no FinOps action.
-- These have no ledger movement (fin_ops_approved_at IS NULL) so no funds were ever
-- debited; users can simply re-request. Emits one system_event per row for audit.

DO $$
DECLARE
  v_ids uuid[];
  v_id uuid;
  v_user_id uuid;
BEGIN
  SELECT array_agg(id) INTO v_ids
  FROM public.withdrawal_requests
  WHERE status = 'manager_approved'
    AND fin_ops_approved_at IS NULL
    AND created_at < now();

  IF v_ids IS NULL OR array_length(v_ids, 1) IS NULL THEN
    RAISE NOTICE 'No stuck manager_approved withdrawals to reject.';
    RETURN;
  END IF;

  UPDATE public.withdrawal_requests
  SET status = 'rejected',
      rejection_reason = 'Manager-approved but FinOps did not complete; please re-request.',
      processed_at = now(),
      updated_at = now()
  WHERE id = ANY(v_ids);

  FOREACH v_id IN ARRAY v_ids LOOP
    SELECT user_id INTO v_user_id FROM public.withdrawal_requests WHERE id = v_id;
    INSERT INTO public.system_events (event_type, user_id, related_entity_type, related_entity_id, metadata)
    VALUES (
      'withdrawal_rejected',
      v_user_id,
      'withdrawal_requests',
      v_id,
      jsonb_build_object(
        'reason', 'finops_stuck_bulk_cleanup',
        'note', 'Manager-approved but FinOps did not complete; user may re-request.',
        'bulk_batch', '20260429-finops-stuck'
      )
    );
  END LOOP;

  RAISE NOTICE 'Rejected % stuck withdrawals.', array_length(v_ids, 1);
END $$;
