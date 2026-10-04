-- 1. Guard: Landlord Ops cannot assign an agent other than the request's own agent
CREATE OR REPLACE FUNCTION public.enforce_assigned_agent_matches_owner()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.assigned_agent_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' AND NEW.assigned_agent_id IS NOT DISTINCT FROM OLD.assigned_agent_id THEN
    RETURN NEW; -- untouched on this update, legacy rows stay editable
  END IF;

  IF NEW.assigned_agent_id IS DISTINCT FROM NEW.agent_id
     AND COALESCE(current_setting('rent_pipeline.allow_agent_override', true), 'false') <> 'true' THEN
    RAISE EXCEPTION 'ASSIGNED_AGENT_MISMATCH: assigned agent (%) must be the request''s own agent (%). Reassign the request agent instead of overriding the pipeline selector.',
      NEW.assigned_agent_id, NEW.agent_id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_assigned_agent_matches_owner ON public.rent_requests;
CREATE TRIGGER trg_enforce_assigned_agent_matches_owner
BEFORE INSERT OR UPDATE OF assigned_agent_id, agent_id ON public.rent_requests
FOR EACH ROW EXECUTE FUNCTION public.enforce_assigned_agent_matches_owner();

-- 2. Data + ledger correction for rent request ecfac8ba (tenant Nakandi Gorette)
DO $$
DECLARE
  v_rr        uuid := 'ecfac8ba-dc39-4e9d-9610-d397c3616ba3';
  v_alloc     uuid := 'e8a052ff-ce54-44a2-bc18-17780eecfc8e';
  v_wrong     uuid := '04ef6aad-ade8-4dbc-ae3f-09669a836952'; -- Akandwanaho Wycliffe
  v_right     uuid := '98b7b07a-3d03-4600-b94e-cda122bbe4ae'; -- Shafiq Senabulya
  v_amount    numeric := 1000000;
  v_bonus     numeric := 10000;
BEGIN
  -- 2a. Allocation back to the owning agent (paid_out = 0, safe)
  UPDATE public.agent_landlord_float_allocations
  SET agent_id = v_right,
      notes = COALESCE(NULLIF(notes, '') || ' | ', '') ||
              'Reassigned 2026-08-14 from Akandwanaho Wycliffe to Shafiq Senabulya: Landlord Ops agent mis-pick corrected',
      updated_at = now()
  WHERE id = v_alloc AND paid_out_amount = 0;

  -- 2b. Clear the wrong pipeline assignment so it falls back to the owning agent
  UPDATE public.rent_requests
  SET assigned_agent_id = NULL, updated_at = now()
  WHERE id = v_rr;

  -- 2c. Rebalance the landlord float summaries
  UPDATE public.agent_landlord_float
  SET balance = GREATEST(0, balance - v_amount),
      total_funded = GREATEST(0, total_funded - v_amount),
      updated_at = now()
  WHERE agent_id = v_wrong;

  UPDATE public.agent_landlord_float
  SET balance = balance + v_amount,
      total_funded = total_funded + v_amount,
      updated_at = now()
  WHERE agent_id = v_right;

  INSERT INTO public.agent_landlord_float_corrections
    (agent_id, previous_balance, corrected_balance, difference, open_allocation_total, reason, performed_by_process, applied)
  SELECT agent_id, balance + v_amount, balance, -v_amount, balance,
         'nakandi_gorette_allocation_reassigned_to_owning_agent_2026_08_14', 'manual_correction', true
  FROM public.agent_landlord_float WHERE agent_id = v_wrong;

  -- 2d. Move the bridge receivable to the owning agent
  PERFORM public.create_ledger_transaction(
    jsonb_build_array(
      jsonb_build_object(
        'user_id', v_wrong, 'ledger_scope', 'bridge', 'direction', 'cash_out',
        'category', 'orphan_reversal', 'amount', v_amount,
        'description', 'Reversal: landlord float receivable wrongly assigned – Nangozi Sharon (tenant Nakandi Gorette)',
        'source_table', 'rent_requests', 'source_id', v_rr, 'linked_party', 'Nangozi Sharon'
      ),
      jsonb_build_object(
        'user_id', v_right, 'ledger_scope', 'bridge', 'direction', 'cash_in',
        'category', 'orphan_reassignment', 'amount', v_amount,
        'description', 'Reassignment: landlord float receivable to owning agent – Nangozi Sharon (tenant Nakandi Gorette)',
        'source_table', 'rent_requests', 'source_id', v_rr, 'linked_party', 'Nangozi Sharon'
      )
    ),
    'nakandi_gorette_bridge_reassign_2026_08_14'
  );

  -- 2e. Claw back the two UGX 5,000 bonuses from the wrong agent
  PERFORM public.create_ledger_transaction(
    jsonb_build_array(
      jsonb_build_object(
        'user_id', v_wrong, 'ledger_scope', 'wallet', 'direction', 'cash_out',
        'category', 'orphan_reversal', 'amount', v_bonus,
        'wallet_bucket', 'withdrawable', 'recipient_type', 'user',
        'classification', 'admin_correction', 'solvency_bypass_reason', 'admin_correction_seed',
        'description', 'Clawback of landlord verification + rent funded bonuses wrongly credited – Nangozi Sharon',
        'source_table', 'rent_requests', 'source_id', v_rr
      ),
      jsonb_build_object(
        'ledger_scope', 'platform', 'direction', 'cash_in',
        'category', 'orphan_reversal', 'amount', v_bonus,
        'classification', 'admin_correction',
        'description', 'Platform recovery of bonuses wrongly credited to non-owning agent – Nangozi Sharon',
        'source_table', 'rent_requests', 'source_id', v_rr
      )
    ),
    'nakandi_gorette_bonus_clawback_2026_08_14',
    true
  );

  -- 2f. Pay the bonuses to the owning agent
  PERFORM public.create_ledger_transaction(
    jsonb_build_array(
      jsonb_build_object(
        'user_id', v_right, 'ledger_scope', 'wallet', 'direction', 'cash_in',
        'category', 'agent_commission_earned', 'amount', v_bonus,
        'wallet_bucket', 'withdrawable', 'recipient_type', 'user',
        'description', 'UGX 10,000 landlord verification + rent funded bonuses – landlord Nangozi Sharon (corrected)',
        'source_table', 'rent_requests', 'source_id', v_rr, 'linked_party', 'Nangozi Sharon'
      ),
      jsonb_build_object(
        'ledger_scope', 'platform', 'direction', 'cash_out',
        'category', 'agent_commission_earned', 'amount', v_bonus,
        'description', 'Platform expense: reassigned verification + rent funded bonuses – Nangozi Sharon',
        'source_table', 'rent_requests', 'source_id', v_rr
      )
    ),
    'nakandi_gorette_bonus_repay_2026_08_14'
  );

  -- 2g. Audit + event
  INSERT INTO public.audit_logs (action_type, action, table_name, record_id, metadata)
  VALUES (
    'rent_request_agent_allocation_corrected',
    'rent_request_agent_allocation_corrected',
    'rent_requests', v_rr::text,
    jsonb_build_object(
      'reason', 'Landlord Ops agent mis-pick on 2026-08-05 routed landlord float and bonuses to the wrong agent',
      'wrong_agent_id', v_wrong, 'correct_agent_id', v_right,
      'allocation_id', v_alloc, 'amount', v_amount, 'bonuses_moved', v_bonus,
      'tenant_name', 'Nakandi Gorette', 'landlord_name', 'Nangozi Sharon'
    )
  );

  INSERT INTO public.system_events (event_type, payload, source)
  VALUES (
    'rent_request.agent_reassigned',
    jsonb_build_object(
      'rent_request_id', v_rr, 'allocation_id', v_alloc,
      'previous_agent_id', v_wrong, 'new_agent_id', v_right,
      'amount', v_amount, 'bonuses_moved', v_bonus,
      'reason', 'Landlord Ops agent mis-pick corrected; allocation and bonuses returned to owning agent'
    ),
    'nakandi_gorette_allocation_correction'
  );
END $$;