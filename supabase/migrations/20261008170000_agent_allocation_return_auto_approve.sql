-- Agent float send-backs approve automatically (when it is provably safe).
--
-- Before: request_allocation_return always raised a pending request that the CFO had
-- to approve. Now, when the Rent Plan is funded, nothing has been paid to the landlord,
-- the float is still 'open' and no landlord payout was ever started / completed / failed,
-- the send-back completes in the same transaction. Any other case still goes to the CFO
-- exactly as before.
--
-- The approve sequence (reverse the fee, post the two balanced ledger entries with
-- idempotency key allocation-return:<request_id>, reduce the agent float, cancel the
-- float, move the Rent Plan funded -> agent_ops_approved) now lives in ONE internal
-- helper, _complete_allocation_return, used by both the CFO approve path and the
-- automatic path. The Rent Plan is NOT cancelled: the agent sent the float back so they
-- can correct it.
--
-- Edit control: the agent who sent the float back
--   * cannot approve Agent Ops, Tenant Ops or Landlord Ops on that same Rent Plan
--     (new BEFORE UPDATE trigger on rent_requests), and
--   * edits the amount through agent_edit_sent_back_rent_plan, which puts the Rent Plan
--     back into Agent Ops review (status 'pending') before the amount changes.
--
-- Additive only: one new column + index on agent_allocation_return_requests, three new
-- functions, one new trigger. The two existing functions are replaced in place
-- (same signatures, same grants). Rollback: supabase/rollbacks/20261008170000_*.

-- ───────────────────────────────────────────────────────────────────────────
-- 1. Mark automatic send-backs (read-only history on the CFO screen keys on this)
-- ───────────────────────────────────────────────────────────────────────────
ALTER TABLE public.agent_allocation_return_requests
  ADD COLUMN IF NOT EXISTS auto_approved boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_aarr_auto_approved_plan
  ON public.agent_allocation_return_requests (rent_request_id, agent_id)
  WHERE auto_approved;

-- ───────────────────────────────────────────────────────────────────────────
-- 2. The single internal helper: the approve path, in one place
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public._complete_allocation_return(
  p_request_id uuid,
  p_decided_by uuid,
  p_note       text,
  p_auto       boolean DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_req       public.agent_allocation_return_requests%ROWTYPE;
  v_alloc     public.agent_landlord_float_allocations%ROWTYPE;
  v_new_group uuid;
  v_fee_rev   jsonb;
  v_claims    text := current_setting('request.jwt.claims', true);
  v_sub       text := current_setting('request.jwt.claim.sub', true);
  v_ledger_a  text;
  v_ledger_b  text;
BEGIN
  SELECT * INTO v_req FROM public.agent_allocation_return_requests
   WHERE id = p_request_id FOR UPDATE;
  IF v_req.id IS NULL THEN
    RAISE EXCEPTION 'Allocation return request % not found', p_request_id;
  END IF;
  IF v_req.status <> 'pending' THEN
    RAISE EXCEPTION 'Allocation return request % is already %', p_request_id, v_req.status;
  END IF;

  SELECT * INTO v_alloc FROM public.agent_landlord_float_allocations
   WHERE id = v_req.allocation_id FOR UPDATE;

  -- Automatic path runs as the system, like the 24-hour recall job: with the agent's
  -- login still attached, the agent-only plan-status guards on rent_requests would
  -- (correctly) refuse the funded -> agent_ops_approved move. Restored at the end.
  IF p_auto THEN
    PERFORM set_config('request.jwt.claims', '', true);
    PERFORM set_config('request.jwt.claim.sub', '', true);
  END IF;

  v_ledger_a := CASE WHEN p_auto
    THEN format('Auto-approved agent send-back — float returned to CFO for %s', COALESCE(v_req.landlord_name,'landlord'))
    ELSE format('CFO-approved allocation return — float returned to CFO for %s', COALESCE(v_req.landlord_name,'landlord')) END;
  v_ledger_b := CASE WHEN p_auto
    THEN format('Reversal — auto-approved agent send-back (%s)', COALESCE(v_req.landlord_name,'landlord'))
    ELSE format('Reversal — CFO-approved allocation return (%s)', COALESCE(v_req.landlord_name,'landlord')) END;

  BEGIN
    v_fee_rev := public.reverse_funding_treasury(v_req.rent_request_id);
  EXCEPTION WHEN OTHERS THEN
    v_fee_rev := jsonb_build_object('status','error','message',SQLERRM);
    RAISE WARNING 'reverse_funding_treasury failed for %: %', v_req.rent_request_id, SQLERRM;
  END;

  SELECT public.create_ledger_transaction(entries := jsonb_build_array(
    jsonb_build_object(
      'user_id', v_req.agent_id, 'amount', v_req.amount, 'direction', 'cash_in',
      'category', 'rent_disbursement', 'ledger_scope', 'platform', 'classification', 'production',
      'currency', 'UGX', 'source_table', 'rent_requests', 'source_id', v_req.rent_request_id,
      'linked_party', v_req.landlord_id,
      'description', v_ledger_a,
      'transaction_date', now()
    ),
    jsonb_build_object(
      'user_id', v_req.agent_id, 'amount', v_req.amount, 'direction', 'cash_out',
      'category', 'rent_receivable_created', 'ledger_scope', 'bridge', 'classification', 'production',
      'currency', 'UGX', 'source_table', 'rent_requests', 'source_id', v_req.rent_request_id,
      'linked_party', v_req.landlord_id,
      'description', v_ledger_b,
      'transaction_date', now()
    )
  ), idempotency_key := 'allocation-return:'||p_request_id::text) INTO v_new_group;

  UPDATE public.agent_landlord_float
     SET balance = GREATEST(0, COALESCE(balance,0) - v_req.amount),
         total_funded = GREATEST(0, COALESCE(total_funded,0) - v_req.amount),
         updated_at = now()
   WHERE agent_id = v_req.agent_id;

  IF v_alloc.id IS NOT NULL THEN
    UPDATE public.agent_landlord_float_allocations
       SET status = 'cancelled',
           notes = COALESCE(notes,'') || ' | Returned to CFO: ' || v_req.reason,
           updated_at = now()
     WHERE id = v_alloc.id;
  END IF;

  IF v_req.rent_request_id IS NOT NULL THEN
    UPDATE public.rent_requests
       SET status = CASE WHEN status = 'funded' THEN 'agent_ops_approved' ELSE status END,
           updated_at = now()
     WHERE id = v_req.rent_request_id;
  END IF;

  UPDATE public.agent_allocation_return_requests
     SET status = 'approved',
         cfo_id = p_decided_by,            -- NULL for the automatic path (system actor)
         cfo_decision_at = now(),
         cfo_note = CASE WHEN p_auto THEN 'auto-approved agent send-back' ELSE p_note END,
         auto_approved = p_auto,
         reversal_transaction_group = v_new_group,
         updated_at = now()
   WHERE id = p_request_id;

  IF p_auto THEN
    INSERT INTO public.audit_logs (user_id, action_type, action, table_name, record_id, reason, metadata)
    VALUES (NULL, 'auto_approve_allocation_return', 'auto_approve_allocation_return',
            'agent_allocation_return_requests', p_request_id::text,
            'Auto-approved agent send-back: ' || v_req.reason,
            jsonb_build_object('system_actor', true, 'requested_by', v_req.agent_id,
                               'rent_request_id', v_req.rent_request_id,
                               'allocation_id', v_req.allocation_id,
                               'amount', v_req.amount, 'agent_reason', v_req.reason,
                               'reversal_transaction_group', v_new_group,
                               'fee_recognition_reversal', v_fee_rev));
  ELSE
    INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, metadata)
    VALUES (p_decided_by, 'cfo_approve_allocation_return', 'agent_allocation_return_requests', p_request_id,
            jsonb_build_object('cfo_note', p_note, 'amount', v_req.amount,
                               'reversal_transaction_group', v_new_group,
                               'fee_recognition_reversal', v_fee_rev));
  END IF;

  INSERT INTO public.system_events (event_type, user_id, metadata)
  VALUES ('agent.allocation_return.approved', p_decided_by, jsonb_build_object(
    'request_id', p_request_id, 'agent_id', v_req.agent_id, 'amount', v_req.amount,
    'reversal_transaction_group', v_new_group, 'auto', p_auto));

  IF p_auto THEN
    PERFORM set_config('request.jwt.claims', COALESCE(v_claims, ''), true);
    PERFORM set_config('request.jwt.claim.sub', COALESCE(v_sub, ''), true);
  END IF;

  RETURN jsonb_build_object('amount', v_req.amount, 'landlord_name', v_req.landlord_name,
                            'agent_id', v_req.agent_id,
                            'rent_request_id', v_req.rent_request_id,
                            'allocation_id', v_req.allocation_id,
                            'reversal_transaction_group', v_new_group,
                            'fee_recognition_reversal', v_fee_rev);
END;
$function$;

-- Internal only: never callable from the API. The two public RPCs below are SECURITY
-- DEFINER with the same owner, so they can still call it.
REVOKE ALL ON FUNCTION public._complete_allocation_return(uuid, uuid, text, boolean)
  FROM PUBLIC, anon, authenticated, service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- 3. CFO decision: the approve path now delegates to the helper
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.cfo_decide_allocation_return(
  p_request_id uuid,
  p_decision   text,
  p_cfo_note   text DEFAULT NULL::text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_caller    uuid := auth.uid();
  v_req       public.agent_allocation_return_requests%ROWTYPE;
  v_alloc     public.agent_landlord_float_allocations%ROWTYPE;
  v_done      jsonb;
BEGIN

  IF v_caller IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Not authenticated.');
  END IF;
  IF NOT public.can_act_pinned_finance_action(v_caller) THEN
    RETURN jsonb_build_object('success', false, 'error',
      'Only the Chief Finance Officer or a designated super admin may return landlord float.');
  END IF;
  IF p_decision NOT IN ('approve','reject') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Decision must be approve or reject.');
  END IF;

  SELECT * INTO v_req FROM public.agent_allocation_return_requests WHERE id = p_request_id FOR UPDATE;
  IF v_req.id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Request not found.');
  END IF;
  IF v_req.status <> 'pending' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Request already ' || v_req.status || '.');
  END IF;

  SELECT * INTO v_alloc FROM public.agent_landlord_float_allocations WHERE id = v_req.allocation_id FOR UPDATE;

  IF p_decision = 'reject' THEN
    UPDATE public.agent_allocation_return_requests
       SET status = 'rejected', cfo_id = v_caller, cfo_decision_at = now(),
           cfo_note = p_cfo_note, updated_at = now()
     WHERE id = p_request_id;

    IF v_alloc.id IS NOT NULL AND v_alloc.status = 'return_pending' THEN
      UPDATE public.agent_landlord_float_allocations
         SET status = CASE WHEN COALESCE(paid_out_amount,0) > 0 THEN 'partially_paid' ELSE 'open' END,
             updated_at = now()
       WHERE id = v_alloc.id;
    END IF;

    INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, metadata)
    VALUES (v_caller, 'cfo_reject_allocation_return', 'agent_allocation_return_requests', p_request_id,
            jsonb_build_object('cfo_note', p_cfo_note));
    INSERT INTO public.system_events (event_type, user_id, metadata)
    VALUES ('agent.allocation_return.rejected', v_caller, jsonb_build_object(
      'request_id', p_request_id, 'agent_id', v_req.agent_id, 'cfo_note', p_cfo_note));

    RETURN jsonb_build_object('success', true, 'status', 'rejected');
  END IF;

  -- APPROVE: the shared helper does the reversal, ledger posting, float and plan moves.
  v_done := public._complete_allocation_return(p_request_id, v_caller, p_cfo_note, false);

  RETURN jsonb_build_object('success', true, 'status', 'approved',
                            'amount_returned', v_done->'amount',
                            'landlord_name', v_done->'landlord_name',
                            'fee_recognition_reversal', v_done->'fee_recognition_reversal');
END;
$function$;

-- ───────────────────────────────────────────────────────────────────────────
-- 4. Agent send-back: automatic when safe, otherwise CFO approval as before
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.request_allocation_return(
  p_allocation_id uuid,
  p_reason        text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_caller      uuid := auth.uid();
  v_alloc       public.agent_landlord_float_allocations%ROWTYPE;
  v_amount      numeric;
  v_req_id      uuid;
  v_plan_status text;
  v_blocked_by  text;
  v_done        jsonb;
BEGIN
  IF v_caller IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Not authenticated.');
  END IF;
  IF p_reason IS NULL OR char_length(trim(p_reason)) < 10 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Please provide a reason (10+ characters).');
  END IF;

  SELECT * INTO v_alloc
    FROM public.agent_landlord_float_allocations
   WHERE id = p_allocation_id
   FOR UPDATE;

  IF v_alloc.id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Allocation not found.');
  END IF;
  IF v_alloc.agent_id <> v_caller THEN
    RETURN jsonb_build_object('success', false, 'error', 'Not authorized.');
  END IF;
  IF v_alloc.status NOT IN ('open','partially_paid') THEN
    RETURN jsonb_build_object('success', false, 'error', 'This allocation cannot be returned.');
  END IF;

  v_amount := v_alloc.remaining_amount;
  IF v_amount IS NULL OR v_amount <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Nothing left to return on this allocation.');
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.agent_allocation_return_requests
     WHERE allocation_id = p_allocation_id AND status = 'pending'
  ) THEN
    RETURN jsonb_build_object('success', false, 'error', 'A CFO approval is already pending for this landlord.');
  END IF;

  -- Can this complete on its own? Same payout test as detect_idle_landlord_float
  -- (ever_dispatched / has_failed_payout), widened to ANY payout row so a payout that
  -- was merely started (otp_verified, disbursing, escalated) also goes to the CFO.
  SELECT status INTO v_plan_status FROM public.rent_requests WHERE id = v_alloc.rent_request_id;
  v_blocked_by := CASE
    WHEN v_alloc.rent_request_id IS NULL OR v_plan_status IS DISTINCT FROM 'funded'
      THEN 'plan_not_funded'
    WHEN COALESCE(v_alloc.paid_out_amount, 0) <> 0
      THEN 'already_paid_out'
    WHEN v_alloc.status <> 'open'
      THEN 'float_not_open'
    WHEN EXISTS (SELECT 1 FROM public.landlord_payouts lp
                  WHERE lp.rent_request_id = v_alloc.rent_request_id
                     OR lp.allocation_applied_id = v_alloc.id)
      THEN 'payout_started'
    ELSE NULL
  END;

  INSERT INTO public.agent_allocation_return_requests (
    agent_id, allocation_id, rent_request_id, landlord_id, landlord_name, amount, reason
  ) VALUES (
    v_caller, v_alloc.id, v_alloc.rent_request_id, v_alloc.landlord_id,
    v_alloc.landlord_name, v_amount, trim(p_reason)
  ) RETURNING id INTO v_req_id;

  IF v_blocked_by IS NULL THEN
    -- Automatic: complete in this same transaction. Not cancelling the Rent Plan.
    v_done := public._complete_allocation_return(v_req_id, NULL, NULL, true);

    INSERT INTO public.notifications (user_id, title, message, type, metadata)
    VALUES (v_caller, 'Float returned', 'Float returned. You can now edit the Rent Plan.', 'float',
            jsonb_build_object('notice', 'allocation_return_auto_approved',
                               'request_id', v_req_id,
                               'rent_request_id', v_alloc.rent_request_id,
                               'allocation_id', v_alloc.id,
                               'amount', v_amount));

    RETURN jsonb_build_object('success', true, 'request_id', v_req_id,
                              'amount', v_amount, 'landlord_name', v_alloc.landlord_name,
                              'auto_approved', true, 'status', 'approved',
                              'message', 'Float returned. You can now edit the Rent Plan.');
  END IF;

  UPDATE public.agent_landlord_float_allocations
     SET status = 'return_pending', updated_at = now()
   WHERE id = v_alloc.id;

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, metadata)
  VALUES (v_caller, 'request_allocation_return', 'agent_allocation_return_requests', v_req_id,
          jsonb_build_object('allocation_id', v_alloc.id, 'rent_request_id', v_alloc.rent_request_id,
                             'amount', v_amount, 'reason', trim(p_reason),
                             'auto_approve_blocked_by', v_blocked_by));

  INSERT INTO public.system_events (event_type, user_id, metadata)
  VALUES ('agent.allocation_return.requested', v_caller, jsonb_build_object(
    'request_id', v_req_id, 'allocation_id', v_alloc.id, 'rent_request_id', v_alloc.rent_request_id,
    'landlord_id', v_alloc.landlord_id, 'landlord_name', v_alloc.landlord_name, 'amount', v_amount,
    'auto_approve_blocked_by', v_blocked_by));

  RETURN jsonb_build_object('success', true, 'request_id', v_req_id,
                            'amount', v_amount, 'landlord_name', v_alloc.landlord_name,
                            'auto_approved', false, 'status', 'pending',
                            'auto_approve_blocked_by', v_blocked_by);
END;
$function$;

-- ───────────────────────────────────────────────────────────────────────────
-- 5. Edit control, part 1: the sender cannot approve their own Rent Plan
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.block_send_back_agent_self_approval()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  -- System work (cron, the auto send-back itself) carries no login.
  IF v_uid IS NULL THEN
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.agent_allocation_return_requests r
     WHERE r.rent_request_id = NEW.id
       AND r.auto_approved
       AND r.status = 'approved'
       AND r.agent_id = v_uid
  ) THEN
    RAISE EXCEPTION 'You sent this float back, so you cannot approve this Rent Plan at Agent Ops, Tenant Ops or Landlord Ops.'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.block_send_back_agent_self_approval() FROM PUBLIC, anon, authenticated, service_role;

-- Runs first (a0 sorts before the other BEFORE UPDATE guards) and only when an Agent Ops,
-- Tenant Ops or Landlord Ops approval is being recorded.
DROP TRIGGER IF EXISTS trg_a0_block_send_back_self_approval ON public.rent_requests;
CREATE TRIGGER trg_a0_block_send_back_self_approval
  BEFORE UPDATE ON public.rent_requests
  FOR EACH ROW
  WHEN (
    (NEW.status IS DISTINCT FROM OLD.status
       AND NEW.status IN ('agent_ops_approved', 'tenant_ops_approved', 'landlord_ops_approved'))
    OR NEW.agent_ops_reviewed_by    IS DISTINCT FROM OLD.agent_ops_reviewed_by
    OR NEW.agent_ops_reviewed_at    IS DISTINCT FROM OLD.agent_ops_reviewed_at
    OR NEW.tenant_ops_reviewed_by   IS DISTINCT FROM OLD.tenant_ops_reviewed_by
    OR NEW.tenant_ops_reviewed_at   IS DISTINCT FROM OLD.tenant_ops_reviewed_at
    OR NEW.landlord_ops_reviewed_by IS DISTINCT FROM OLD.landlord_ops_reviewed_by
    OR NEW.landlord_ops_reviewed_at IS DISTINCT FROM OLD.landlord_ops_reviewed_at
  )
  EXECUTE FUNCTION public.block_send_back_agent_self_approval();

-- ───────────────────────────────────────────────────────────────────────────
-- 6. Edit control, part 2: changing the amount sends the plan back to Agent Ops
-- ───────────────────────────────────────────────────────────────────────────
-- Today the database refuses any agent edit of the amount once a Rent Plan has left
-- review, so "you can now edit the Rent Plan" needs a server path. This is the narrow
-- one: only the agent who sent the float back, only while the plan sits at
-- agent_ops_approved after that send-back. The plan goes back to Agent Ops review
-- (status 'pending') FIRST, then the amount changes, so a raised amount can never stay
-- approved. Fees and repayments are recomputed by the existing formula trigger.
CREATE OR REPLACE FUNCTION public.agent_edit_sent_back_rent_plan(
  p_request_id      uuid,
  p_new_rent_amount numeric,
  p_note            text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid  uuid := auth.uid();
  v_plan public.rent_requests%ROWTYPE;
  v_new  public.rent_requests%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Not authenticated.');
  END IF;
  IF p_note IS NULL OR char_length(trim(p_note)) < 10 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Please say what you changed (10+ characters).');
  END IF;
  IF p_new_rent_amount IS NULL OR p_new_rent_amount <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Enter a valid rent amount.');
  END IF;

  SELECT * INTO v_plan FROM public.rent_requests WHERE id = p_request_id FOR UPDATE;
  IF v_plan.id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Rent Plan not found.');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.agent_allocation_return_requests r
     WHERE r.rent_request_id = p_request_id
       AND r.auto_approved AND r.status = 'approved'
       AND r.agent_id = v_uid
  ) THEN
    RETURN jsonb_build_object('success', false, 'error',
      'Only the agent who sent the float back can edit this Rent Plan this way.');
  END IF;
  IF v_plan.status <> 'agent_ops_approved' THEN
    RETURN jsonb_build_object('success', false, 'error',
      'This Rent Plan is not waiting after a send-back (current stage: ' || v_plan.status || ').');
  END IF;
  IF p_new_rent_amount = v_plan.rent_amount THEN
    RETURN jsonb_build_object('success', false, 'error', 'The rent amount is unchanged.');
  END IF;

  -- Step 1: back to Agent Ops review (a status an agent is allowed to set).
  UPDATE public.rent_requests SET status = 'pending', updated_at = now() WHERE id = p_request_id;
  -- Step 2: now the amount may change; the formula trigger recomputes fees and repayments.
  UPDATE public.rent_requests SET rent_amount = p_new_rent_amount, updated_at = now() WHERE id = p_request_id;

  SELECT * INTO v_new FROM public.rent_requests WHERE id = p_request_id;

  INSERT INTO public.audit_logs (user_id, action_type, action, table_name, record_id, reason, metadata)
  VALUES (v_uid, 'agent_edit_sent_back_rent_plan', 'agent_edit_sent_back_rent_plan',
          'rent_requests', p_request_id::text, trim(p_note),
          jsonb_build_object('old_rent_amount', v_plan.rent_amount, 'new_rent_amount', v_new.rent_amount,
                             'old_total_repayment', v_plan.total_repayment,
                             'new_total_repayment', v_new.total_repayment,
                             'returned_to_status', v_new.status));

  INSERT INTO public.system_events (event_type, user_id, related_entity_type, related_entity_id, metadata)
  VALUES ('rent_request.edited_after_send_back', v_uid, 'rent_request', p_request_id,
          jsonb_build_object('old_rent_amount', v_plan.rent_amount, 'new_rent_amount', v_new.rent_amount,
                             'returned_to_status', v_new.status));

  RETURN jsonb_build_object('success', true, 'status', v_new.status,
                            'old_rent_amount', v_plan.rent_amount,
                            'new_rent_amount', v_new.rent_amount,
                            'needs_agent_ops_review', true);
END;
$function$;

REVOKE ALL ON FUNCTION public.agent_edit_sent_back_rent_plan(uuid, numeric, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.agent_edit_sent_back_rent_plan(uuid, numeric, text) TO authenticated, service_role;
