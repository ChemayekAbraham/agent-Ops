-- Cancel a tenant's rent plan and return the landlord float still sitting on the
-- agent's float to the platform, in one auditable step.
--
-- Money rules honoured:
--   * only the UNSPENT portion of each allocation is reversed (remaining_amount);
--     `agent_landlord_float.balance` is derived by recompute_agent_landlord_float
--     from live allocations, so cancelling the allocation is what removes the float.
--     No absolute "set float to X" write.
--   * the already paid-out portion is NOT re-credited or silently written off — it is
--     recorded on the reversal row (paid_out portion) for CFO recovery follow-up.
CREATE OR REPLACE FUNCTION public.cancel_tenant_and_return_landlord_float(
  p_rent_request_id uuid,
  p_reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller     uuid := auth.uid();
  v_rr         public.rent_requests;
  v_agent      uuid;
  v_alloc      record;
  v_group      uuid;
  v_groups     uuid[] := ARRAY[]::uuid[];
  v_returned   numeric := 0;
  v_spent      numeric := 0;
  v_count      int := 0;
  v_freed      int := 0;
  v_reason     text;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED' USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NOT (public.has_role(v_caller,'cfo'::app_role)
       OR public.has_role(v_caller,'manager'::app_role)
       OR public.has_role(v_caller,'super_admin'::app_role)
       OR public.has_role(v_caller,'coo'::app_role)
       OR public.has_role(v_caller,'operations'::app_role)
       OR public.has_role(v_caller,'financial_ops'::app_role)) THEN
    RAISE EXCEPTION 'FORBIDDEN: only CFO / Finance Operations / COO / Operations may cancel a tenant and return float'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  v_reason := NULLIF(btrim(COALESCE(p_reason,'')),'');
  IF v_reason IS NULL OR char_length(v_reason) < 10 THEN
    RAISE EXCEPTION 'REASON_REQUIRED: provide at least 10 characters explaining the cancellation'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT * INTO v_rr FROM public.rent_requests WHERE id = p_rent_request_id FOR UPDATE;
  IF v_rr.id IS NULL THEN
    RAISE EXCEPTION 'RENT_REQUEST_NOT_FOUND' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_rr.status IN ('cancelled','rejected','deleted_by_agent','fully_repaid','completed') THEN
    RAISE EXCEPTION 'ALREADY_CLOSED: this rent plan is already %', v_rr.status
      USING ERRCODE = 'check_violation';
  END IF;

  v_agent := COALESCE(v_rr.assigned_agent_id, v_rr.agent_id);

  -- ===== 1. Return the landlord float =====
  FOR v_alloc IN
    SELECT * FROM public.agent_landlord_float_allocations
     WHERE rent_request_id = p_rent_request_id
       AND status IN ('open','partially_paid','return_pending')
     FOR UPDATE
  LOOP
    v_count := v_count + 1;
    v_spent := v_spent + COALESCE(v_alloc.paid_out_amount, 0);

    IF COALESCE(v_alloc.remaining_amount, 0) > 0 THEN
      SELECT public.create_ledger_transaction(entries := jsonb_build_array(
        jsonb_build_object(
          'user_id', v_alloc.agent_id, 'amount', v_alloc.remaining_amount, 'direction', 'cash_in',
          'category', 'rent_disbursement', 'ledger_scope', 'platform', 'classification', 'production',
          'currency', 'UGX', 'source_table', 'rent_requests', 'source_id', p_rent_request_id,
          'linked_party', v_alloc.landlord_id,
          'description', format('Tenant cancelled — landlord float returned to platform (%s)',
                                COALESCE(v_alloc.landlord_name,'landlord')),
          'transaction_date', now()
        ),
        jsonb_build_object(
          'user_id', v_alloc.agent_id, 'amount', v_alloc.remaining_amount, 'direction', 'cash_out',
          'category', 'rent_receivable_created', 'ledger_scope', 'bridge', 'classification', 'production',
          'currency', 'UGX', 'source_table', 'rent_requests', 'source_id', p_rent_request_id,
          'linked_party', v_alloc.landlord_id,
          'description', format('Reversal — tenant cancelled, float recalled (%s)',
                                COALESCE(v_alloc.landlord_name,'landlord')),
          'transaction_date', now()
        )
      )) INTO v_group;

      v_groups   := v_groups || v_group;
      v_returned := v_returned + v_alloc.remaining_amount;

      INSERT INTO public.agent_tenant_float_reversals (
        agent_id, rent_request_id, landlord_id, landlord_name,
        reversal_transaction_group, amount, commission_clawback, reason
      ) VALUES (
        v_alloc.agent_id, p_rent_request_id, v_alloc.landlord_id, v_alloc.landlord_name,
        v_group, v_alloc.remaining_amount, 0,
        format('Tenant cancelled: %s', v_reason)
      );
    END IF;

    -- Cancelling the allocation is what drops the agent's derived float balance.
    UPDATE public.agent_landlord_float_allocations
       SET status = 'cancelled',
           notes  = COALESCE(notes,'') || ' | Tenant cancelled, float returned to platform: ' || v_reason,
           updated_at = now()
     WHERE id = v_alloc.id;
  END LOOP;

  -- Lifetime counter follows the recall (delta, never an absolute set).
  IF v_returned > 0 THEN
    UPDATE public.agent_landlord_float
       SET total_funded = GREATEST(0, COALESCE(total_funded,0) - v_returned),
           updated_at = now()
     WHERE agent_id = v_agent;
  END IF;

  -- ===== 2. Cancel the tenant =====
  UPDATE public.rent_requests
     SET status                      = 'cancelled',
         tenancy_status              = 'terminated',
         agent_payment_status        = 'not_paying',
         agent_payment_status_reason = v_reason,
         agent_payment_status_set_at = now(),
         agent_payment_status_set_by = v_caller,
         updated_at                  = now()
   WHERE id = p_rent_request_id;

  -- Free the house back to Priority 1 and drop the landlord link.
  WITH freed AS (
    UPDATE public.house_listings
       SET suspended_tenant_id = tenant_id,
           tenant_id           = NULL,
           status              = 'available'
     WHERE tenant_id = v_rr.tenant_id
     RETURNING 1
  )
  SELECT count(*) INTO v_freed FROM freed;

  UPDATE public.landlords SET tenant_id = NULL WHERE tenant_id = v_rr.tenant_id;

  -- Close the inactive-tenant review so the case leaves the Ops queue.
  INSERT INTO public.tenant_inactive_reviews (
    rent_request_id, tenant_id, status, acknowledged_by, acknowledged_at,
    resolved_by, resolved_at, notes
  ) VALUES (
    p_rent_request_id, v_rr.tenant_id, 'resolved', v_caller, now(), v_caller, now(),
    format('Tenant cancelled, landlord float returned: %s', v_reason)
  )
  ON CONFLICT (rent_request_id) DO UPDATE
    SET status          = 'resolved',
        resolved_by     = EXCLUDED.resolved_by,
        resolved_at     = EXCLUDED.resolved_at,
        acknowledged_by = COALESCE(public.tenant_inactive_reviews.acknowledged_by, EXCLUDED.acknowledged_by),
        acknowledged_at = COALESCE(public.tenant_inactive_reviews.acknowledged_at, EXCLUDED.acknowledged_at),
        notes           = EXCLUDED.notes;

  -- ===== 3. Audit =====
  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, metadata)
  VALUES (
    v_caller, 'rent.tenant_cancelled_float_returned', 'rent_requests', p_rent_request_id::text, v_reason,
    jsonb_build_object(
      'tenant_id', v_rr.tenant_id,
      'agent_id', v_agent,
      'landlord_id', v_rr.landlord_id,
      'previous_status', v_rr.status,
      'new_status', 'cancelled',
      'allocations_cancelled', v_count,
      'float_returned', v_returned,
      'float_already_paid_out', v_spent,
      'houses_freed', v_freed,
      'reversal_transaction_groups', to_jsonb(v_groups)
    )
  );

  INSERT INTO public.system_events (event_type, user_id, metadata)
  VALUES ('agent.allocation_return.approved', v_caller, jsonb_build_object(
    'kind', 'tenant_cancelled_float_returned',
    'rent_request_id', p_rent_request_id,
    'tenant_id', v_rr.tenant_id,
    'agent_id', v_agent,
    'float_returned', v_returned,
    'float_already_paid_out', v_spent,
    'reason', v_reason));

  RETURN jsonb_build_object(
    'success', true,
    'rent_request_id', p_rent_request_id,
    'status', 'cancelled',
    'allocations_cancelled', v_count,
    'float_returned', v_returned,
    'float_already_paid_out', v_spent,
    'houses_freed', v_freed
  );
END;
$$;

REVOKE ALL ON FUNCTION public.cancel_tenant_and_return_landlord_float(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.cancel_tenant_and_return_landlord_float(uuid, text) TO authenticated;