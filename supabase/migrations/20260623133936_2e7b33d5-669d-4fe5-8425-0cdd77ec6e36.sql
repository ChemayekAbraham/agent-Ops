-- 1. Allow a transient "return_pending" state on allocations
ALTER TABLE public.agent_landlord_float_allocations
  DROP CONSTRAINT IF EXISTS agent_landlord_float_allocations_status_check;
ALTER TABLE public.agent_landlord_float_allocations
  ADD CONSTRAINT agent_landlord_float_allocations_status_check
  CHECK (status = ANY (ARRAY['open'::text,'partially_paid'::text,'fully_paid'::text,'cancelled'::text,'return_pending'::text]));

-- 2. CFO-approval queue for returning allocated (not-yet-paid) float to the CFO
CREATE TABLE public.agent_allocation_return_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL,
  allocation_id uuid NOT NULL REFERENCES public.agent_landlord_float_allocations(id) ON DELETE CASCADE,
  rent_request_id uuid,
  landlord_id uuid,
  landlord_name text,
  amount numeric NOT NULL CHECK (amount > 0),
  reason text NOT NULL CHECK (char_length(reason) >= 10),
  status text NOT NULL DEFAULT 'pending' CHECK (status = ANY (ARRAY['pending'::text,'approved'::text,'rejected'::text,'cancelled'::text])),
  cfo_id uuid,
  cfo_decision_at timestamptz,
  cfo_note text,
  reversal_transaction_group uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX uq_aarr_pending_allocation
  ON public.agent_allocation_return_requests(allocation_id) WHERE status = 'pending';
CREATE INDEX idx_aarr_agent ON public.agent_allocation_return_requests(agent_id, created_at DESC);
CREATE INDEX idx_aarr_status ON public.agent_allocation_return_requests(status, created_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.agent_allocation_return_requests TO authenticated;
GRANT ALL ON public.agent_allocation_return_requests TO service_role;

ALTER TABLE public.agent_allocation_return_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Agents view own allocation return requests"
  ON public.agent_allocation_return_requests FOR SELECT TO authenticated
  USING (agent_id = auth.uid());

CREATE POLICY "Staff view all allocation return requests"
  ON public.agent_allocation_return_requests FOR SELECT TO authenticated
  USING (
    has_role(auth.uid(),'manager'::app_role)
    OR has_role(auth.uid(),'super_admin'::app_role)
    OR has_role(auth.uid(),'cfo'::app_role)
    OR has_role(auth.uid(),'coo'::app_role)
    OR has_role(auth.uid(),'operations'::app_role)
  );

CREATE OR REPLACE FUNCTION public.touch_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;

CREATE TRIGGER trg_aarr_updated_at
  BEFORE UPDATE ON public.agent_allocation_return_requests
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- 3. Agent submits a not-yet-paid allocation for return to the CFO
CREATE OR REPLACE FUNCTION public.request_allocation_return(p_allocation_id uuid, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_caller uuid := auth.uid();
  v_alloc  public.agent_landlord_float_allocations%ROWTYPE;
  v_amount numeric;
  v_req_id uuid;
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

  INSERT INTO public.agent_allocation_return_requests (
    agent_id, allocation_id, rent_request_id, landlord_id, landlord_name, amount, reason
  ) VALUES (
    v_caller, v_alloc.id, v_alloc.rent_request_id, v_alloc.landlord_id,
    v_alloc.landlord_name, v_amount, trim(p_reason)
  ) RETURNING id INTO v_req_id;

  UPDATE public.agent_landlord_float_allocations
     SET status = 'return_pending', updated_at = now()
   WHERE id = v_alloc.id;

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, metadata)
  VALUES (v_caller, 'request_allocation_return', 'agent_allocation_return_requests', v_req_id,
          jsonb_build_object('allocation_id', v_alloc.id, 'rent_request_id', v_alloc.rent_request_id,
                             'amount', v_amount, 'reason', trim(p_reason)));

  INSERT INTO public.system_events (event_type, user_id, payload)
  VALUES ('agent.allocation_return.requested', v_caller, jsonb_build_object(
    'request_id', v_req_id, 'allocation_id', v_alloc.id, 'rent_request_id', v_alloc.rent_request_id,
    'landlord_id', v_alloc.landlord_id, 'landlord_name', v_alloc.landlord_name, 'amount', v_amount));

  RETURN jsonb_build_object('success', true, 'request_id', v_req_id,
                            'amount', v_amount, 'landlord_name', v_alloc.landlord_name);
END;
$function$;

-- 4. CFO approves/rejects; approval returns the float to the CFO and frees the landlord
CREATE OR REPLACE FUNCTION public.cfo_decide_allocation_return(p_request_id uuid, p_decision text, p_cfo_note text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_caller    uuid := auth.uid();
  v_req       public.agent_allocation_return_requests%ROWTYPE;
  v_alloc     public.agent_landlord_float_allocations%ROWTYPE;
  v_new_group uuid;
BEGIN
  IF v_caller IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Not authenticated.');
  END IF;
  IF NOT (has_role(v_caller,'cfo'::app_role)
          OR has_role(v_caller,'manager'::app_role)
          OR has_role(v_caller,'super_admin'::app_role)) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Only CFO can decide allocation returns.');
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

    -- Put the landlord back on the agent's ready-to-pay list
    IF v_alloc.id IS NOT NULL AND v_alloc.status = 'return_pending' THEN
      UPDATE public.agent_landlord_float_allocations
         SET status = CASE WHEN COALESCE(paid_out_amount,0) > 0 THEN 'partially_paid' ELSE 'open' END,
             updated_at = now()
       WHERE id = v_alloc.id;
    END IF;

    INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, metadata)
    VALUES (v_caller, 'cfo_reject_allocation_return', 'agent_allocation_return_requests', p_request_id,
            jsonb_build_object('cfo_note', p_cfo_note));
    INSERT INTO public.system_events (event_type, user_id, payload)
    VALUES ('agent.allocation_return.rejected', v_caller, jsonb_build_object(
      'request_id', p_request_id, 'agent_id', v_req.agent_id, 'cfo_note', p_cfo_note));

    RETURN jsonb_build_object('success', true, 'status', 'rejected');
  END IF;

  -- APPROVE
  -- Return the allocated float to the CFO/platform (balanced ledger reversal)
  SELECT public.create_ledger_transaction(entries := jsonb_build_array(
    jsonb_build_object(
      'user_id', v_req.agent_id, 'amount', v_req.amount, 'direction', 'cash_in',
      'category', 'rent_disbursement', 'ledger_scope', 'platform', 'classification', 'production',
      'currency', 'UGX', 'source_table', 'rent_requests', 'source_id', v_req.rent_request_id,
      'linked_party', v_req.landlord_id,
      'description', format('CFO-approved allocation return — float returned to CFO for %s', COALESCE(v_req.landlord_name,'landlord')),
      'transaction_date', now()
    ),
    jsonb_build_object(
      'user_id', v_req.agent_id, 'amount', v_req.amount, 'direction', 'cash_out',
      'category', 'rent_receivable_created', 'ledger_scope', 'bridge', 'classification', 'production',
      'currency', 'UGX', 'source_table', 'rent_requests', 'source_id', v_req.rent_request_id,
      'linked_party', v_req.landlord_id,
      'description', format('Reversal — CFO-approved allocation return (%s)', COALESCE(v_req.landlord_name,'landlord')),
      'transaction_date', now()
    )
  )) INTO v_new_group;

  -- Reduce the agent's landlord-float cache by the returned amount
  UPDATE public.agent_landlord_float
     SET balance = GREATEST(0, COALESCE(balance,0) - v_req.amount),
         total_funded = GREATEST(0, COALESCE(total_funded,0) - v_req.amount),
         updated_at = now()
   WHERE agent_id = v_req.agent_id;

  -- Cancel the allocation so the landlord leaves the agent's ready-to-pay list
  IF v_alloc.id IS NOT NULL THEN
    UPDATE public.agent_landlord_float_allocations
       SET status = 'cancelled',
           notes = COALESCE(notes,'') || ' | Returned to CFO: ' || v_req.reason,
           updated_at = now()
     WHERE id = v_alloc.id;
  END IF;

  -- Send the rent plan back to the pre-funding stage (back to Landlord Ops)
  IF v_req.rent_request_id IS NOT NULL THEN
    UPDATE public.rent_requests
       SET status = CASE WHEN status = 'funded' THEN 'agent_ops_approved' ELSE status END,
           updated_at = now()
     WHERE id = v_req.rent_request_id;
  END IF;

  UPDATE public.agent_allocation_return_requests
     SET status = 'approved', cfo_id = v_caller, cfo_decision_at = now(),
         cfo_note = p_cfo_note, reversal_transaction_group = v_new_group, updated_at = now()
   WHERE id = p_request_id;

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, metadata)
  VALUES (v_caller, 'cfo_approve_allocation_return', 'agent_allocation_return_requests', p_request_id,
          jsonb_build_object('cfo_note', p_cfo_note, 'amount', v_req.amount,
                             'reversal_transaction_group', v_new_group));
  INSERT INTO public.system_events (event_type, user_id, payload)
  VALUES ('agent.allocation_return.approved', v_caller, jsonb_build_object(
    'request_id', p_request_id, 'agent_id', v_req.agent_id, 'amount', v_req.amount,
    'reversal_transaction_group', v_new_group));

  RETURN jsonb_build_object('success', true, 'status', 'approved',
                            'amount_returned', v_req.amount, 'landlord_name', v_req.landlord_name);
END;
$function$;