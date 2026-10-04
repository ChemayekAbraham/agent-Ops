
-- 1. Pending CFO-approval requests for >7-day unfundings
CREATE TABLE public.agent_unfunding_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL,
  rent_request_id uuid NOT NULL,
  original_transaction_group uuid NOT NULL,
  landlord_id uuid,
  landlord_name text,
  amount numeric NOT NULL CHECK (amount > 0),
  reason text NOT NULL CHECK (char_length(reason) >= 10),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','cancelled')),
  cfo_id uuid,
  cfo_decision_at timestamptz,
  cfo_note text,
  reversal_transaction_group uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Only one OPEN request per original allocation
CREATE UNIQUE INDEX uq_aur_pending_original
  ON public.agent_unfunding_requests(original_transaction_group)
  WHERE status = 'pending';

CREATE INDEX idx_aur_status ON public.agent_unfunding_requests(status, created_at DESC);
CREATE INDEX idx_aur_agent  ON public.agent_unfunding_requests(agent_id, created_at DESC);

ALTER TABLE public.agent_unfunding_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Agents view own unfunding requests"
  ON public.agent_unfunding_requests
  FOR SELECT TO authenticated
  USING (agent_id = auth.uid());

CREATE POLICY "Staff view all unfunding requests"
  ON public.agent_unfunding_requests
  FOR SELECT TO authenticated
  USING (
    has_role(auth.uid(),'manager'::app_role)
    OR has_role(auth.uid(),'super_admin'::app_role)
    OR has_role(auth.uid(),'cfo'::app_role)
    OR has_role(auth.uid(),'coo'::app_role)
    OR has_role(auth.uid(),'operations'::app_role)
  );

-- 2. Refresh reversible-allocations RPC: drop 7-day cap, expose flag
DROP FUNCTION IF EXISTS public.get_agent_reversible_allocations(uuid, uuid);

CREATE OR REPLACE FUNCTION public.get_agent_reversible_allocations(
  p_agent_id uuid,
  p_rent_request_id uuid
)
RETURNS TABLE (
  transaction_group uuid,
  amount numeric,
  landlord_id uuid,
  landlord_name text,
  description text,
  created_at timestamptz,
  requires_cfo_approval boolean,
  pending_request_id uuid,
  pending_request_status text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH rr AS (
    SELECT id, landlord_id FROM public.rent_requests WHERE id = p_rent_request_id
  ),
  candidate AS (
    SELECT
      gl.reference_id::uuid AS transaction_group,
      gl.amount,
      gl.linked_party::uuid AS landlord_id,
      gl.description,
      gl.created_at
    FROM public.general_ledger gl
    JOIN rr ON rr.landlord_id::text = gl.linked_party
    WHERE gl.user_id = p_agent_id
      AND gl.category = 'rent_payment_for_tenant'
      AND gl.direction = 'cash_out'
      AND gl.ledger_scope = 'wallet'
      AND gl.reference_id IS NOT NULL
  )
  SELECT
    c.transaction_group,
    c.amount,
    c.landlord_id,
    COALESCE(l.name, p.full_name, 'Landlord') AS landlord_name,
    c.description,
    c.created_at,
    (c.created_at < now() - interval '7 days') AS requires_cfo_approval,
    aur.id AS pending_request_id,
    aur.status AS pending_request_status
  FROM candidate c
  LEFT JOIN public.landlords l ON l.id = c.landlord_id
  LEFT JOIN public.profiles  p ON p.id = c.landlord_id
  LEFT JOIN public.agent_tenant_float_reversals r
         ON r.original_transaction_group = c.transaction_group
  LEFT JOIN LATERAL (
    SELECT id, status
      FROM public.agent_unfunding_requests
     WHERE original_transaction_group = c.transaction_group
       AND status = 'pending'
     LIMIT 1
  ) aur ON true
  WHERE r.id IS NULL
  ORDER BY c.created_at DESC;
$$;

GRANT EXECUTE ON FUNCTION public.get_agent_reversible_allocations(uuid, uuid) TO authenticated;

-- 3. Agent submits a CFO-approval request for >7-day fundings
CREATE OR REPLACE FUNCTION public.request_agent_unallocation(
  p_agent_id uuid,
  p_rent_request_id uuid,
  p_original_transaction_group uuid,
  p_reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller        uuid := auth.uid();
  v_amount        numeric;
  v_landlord_id   uuid;
  v_landlord_name text;
  v_request_id    uuid;
BEGIN
  IF v_caller IS NULL OR v_caller <> p_agent_id THEN
    RETURN jsonb_build_object('success', false, 'error', 'Not authorized.');
  END IF;

  IF p_reason IS NULL OR char_length(trim(p_reason)) < 10 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Please provide a reason (10+ characters).');
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.agent_tenant_float_reversals
    WHERE original_transaction_group = p_original_transaction_group
  ) THEN
    RETURN jsonb_build_object('success', false, 'error', 'This funding has already been reversed.');
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.agent_unfunding_requests
    WHERE original_transaction_group = p_original_transaction_group
      AND status = 'pending'
  ) THEN
    RETURN jsonb_build_object('success', false, 'error', 'A CFO approval is already pending for this funding.');
  END IF;

  SELECT gl.amount, gl.linked_party::uuid
    INTO v_amount, v_landlord_id
  FROM public.general_ledger gl
  WHERE gl.reference_id = p_original_transaction_group::text
    AND gl.user_id = p_agent_id
    AND gl.category = 'rent_payment_for_tenant'
    AND gl.direction = 'cash_out'
    AND gl.ledger_scope = 'wallet'
  ORDER BY gl.created_at DESC
  LIMIT 1;

  IF v_amount IS NULL OR v_landlord_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Original funding not found.');
  END IF;

  SELECT COALESCE(l.name, p.full_name, 'Landlord')
    INTO v_landlord_name
  FROM (SELECT v_landlord_id AS id) x
  LEFT JOIN public.landlords l ON l.id = x.id
  LEFT JOIN public.profiles  p ON p.id = x.id;

  INSERT INTO public.agent_unfunding_requests (
    agent_id, rent_request_id, original_transaction_group,
    landlord_id, landlord_name, amount, reason
  ) VALUES (
    p_agent_id, p_rent_request_id, p_original_transaction_group,
    v_landlord_id, v_landlord_name, v_amount, trim(p_reason)
  )
  RETURNING id INTO v_request_id;

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, metadata)
  VALUES (
    p_agent_id, 'request_agent_unallocation', 'agent_unfunding_requests', v_request_id,
    jsonb_build_object(
      'rent_request_id', p_rent_request_id,
      'original_transaction_group', p_original_transaction_group,
      'amount', v_amount, 'reason', p_reason
    )
  );

  INSERT INTO public.system_events (event_type, user_id, payload)
  VALUES ('agent.unfunding.requested', p_agent_id, jsonb_build_object(
    'request_id', v_request_id,
    'rent_request_id', p_rent_request_id,
    'original_transaction_group', p_original_transaction_group,
    'landlord_id', v_landlord_id,
    'landlord_name', v_landlord_name,
    'amount', v_amount
  ));

  RETURN jsonb_build_object('success', true, 'request_id', v_request_id,
                            'amount', v_amount, 'landlord_name', v_landlord_name);
END;
$$;

GRANT EXECUTE ON FUNCTION public.request_agent_unallocation(uuid, uuid, uuid, text) TO authenticated;

-- 4. CFO approves or rejects. On approval we run the same reversal the agent
--    would normally do within 7 days (skipping the 7-day gate).
CREATE OR REPLACE FUNCTION public.cfo_decide_agent_unallocation(
  p_request_id uuid,
  p_decision   text,           -- 'approve' | 'reject'
  p_cfo_note   text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller        uuid := auth.uid();
  v_req           public.agent_unfunding_requests%ROWTYPE;
  v_amount        numeric;
  v_landlord_id   uuid;
  v_landlord_name text;
  v_commission    numeric;
  v_new_group     uuid := gen_random_uuid();
  v_tracking      text;
  v_rr_landlord   uuid;
  v_rr_paid       numeric;
  v_rr_total      numeric;
BEGIN
  IF v_caller IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Not authenticated.');
  END IF;
  IF NOT (has_role(v_caller,'cfo'::app_role)
          OR has_role(v_caller,'manager'::app_role)
          OR has_role(v_caller,'super_admin'::app_role)) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Only CFO can decide unfunding requests.');
  END IF;
  IF p_decision NOT IN ('approve','reject') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Decision must be approve or reject.');
  END IF;

  SELECT * INTO v_req
    FROM public.agent_unfunding_requests
   WHERE id = p_request_id
   FOR UPDATE;

  IF v_req.id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Request not found.');
  END IF;
  IF v_req.status <> 'pending' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Request already ' || v_req.status || '.');
  END IF;

  IF p_decision = 'reject' THEN
    UPDATE public.agent_unfunding_requests
       SET status = 'rejected', cfo_id = v_caller,
           cfo_decision_at = now(), cfo_note = p_cfo_note,
           updated_at = now()
     WHERE id = p_request_id;

    INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, metadata)
    VALUES (v_caller, 'cfo_reject_agent_unallocation', 'agent_unfunding_requests', p_request_id,
            jsonb_build_object('cfo_note', p_cfo_note));

    INSERT INTO public.system_events (event_type, user_id, payload)
    VALUES ('agent.unfunding.rejected', v_caller, jsonb_build_object(
      'request_id', p_request_id, 'agent_id', v_req.agent_id, 'cfo_note', p_cfo_note));

    RETURN jsonb_build_object('success', true, 'status', 'rejected');
  END IF;

  -- APPROVE: re-validate and post the mirrored reversal
  IF EXISTS (SELECT 1 FROM public.agent_tenant_float_reversals
              WHERE original_transaction_group = v_req.original_transaction_group) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Already reversed.');
  END IF;

  SELECT gl.amount, gl.linked_party::uuid
    INTO v_amount, v_landlord_id
  FROM public.general_ledger gl
  WHERE gl.reference_id = v_req.original_transaction_group::text
    AND gl.user_id = v_req.agent_id
    AND gl.category = 'rent_payment_for_tenant'
    AND gl.direction = 'cash_out'
    AND gl.ledger_scope = 'wallet'
  ORDER BY gl.created_at DESC
  LIMIT 1;

  IF v_amount IS NULL OR v_landlord_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Original funding not found.');
  END IF;

  SELECT landlord_id, COALESCE(amount_repaid,0), COALESCE(total_repayment,0)
    INTO v_rr_landlord, v_rr_paid, v_rr_total
  FROM public.rent_requests
  WHERE id = v_req.rent_request_id;

  IF v_rr_landlord IS NULL OR v_rr_landlord <> v_landlord_id THEN
    RETURN jsonb_build_object('success', false, 'error', 'Rent plan does not match the original funding.');
  END IF;

  v_commission := round(v_amount * 0.10);
  v_tracking   := substr(v_new_group::text, 1, 8);

  SELECT COALESCE(l.name, p.full_name, 'Landlord')
    INTO v_landlord_name
  FROM (SELECT v_landlord_id AS id) x
  LEFT JOIN public.landlords l ON l.id = x.id
  LEFT JOIN public.profiles  p ON p.id = x.id;

  PERFORM public.create_ledger_transaction(
    'agent_tenant_float_allocation_reversal',
    jsonb_build_array(
      jsonb_build_object(
        'user_id', v_req.agent_id, 'amount', v_amount, 'direction', 'cash_in',
        'category', 'rent_payment_for_tenant', 'ledger_scope', 'wallet',
        'classification', 'production',
        'description', format('CFO-approved unfunding — float returned to %s (%s)', v_landlord_name, v_tracking),
        'linked_party', v_landlord_id, 'reference_id', v_new_group::text,
        'recipient_type', 'operational_wallet'
      ),
      jsonb_build_object(
        'user_id', v_landlord_id, 'amount', v_amount, 'direction', 'cash_out',
        'category', 'rent_payment_received', 'ledger_scope', 'wallet',
        'classification', 'production',
        'description', format('Reversal — CFO-approved unfunding (%s)', v_tracking),
        'linked_party', v_req.agent_id, 'reference_id', v_new_group::text,
        'recipient_type', 'user'
      ),
      jsonb_build_object(
        'user_id', v_req.agent_id, 'amount', v_commission, 'direction', 'cash_out',
        'category', 'agent_commission_earned', 'ledger_scope', 'wallet',
        'classification', 'production',
        'description', format('10%% commission clawback — %s', v_tracking),
        'reference_id', v_new_group::text, 'recipient_type', 'user'
      ),
      jsonb_build_object(
        'user_id', v_req.agent_id, 'amount', v_commission, 'direction', 'cash_in',
        'category', 'agent_commission_payable', 'ledger_scope', 'platform',
        'classification', 'production',
        'description', format('Platform commission reversal (%s)', v_tracking),
        'reference_id', v_new_group::text
      )
    )
  );

  UPDATE public.rent_requests
     SET amount_repaid = GREATEST(0, COALESCE(amount_repaid,0) - v_amount),
         status = CASE
                    WHEN status = 'completed'
                      AND (GREATEST(0, COALESCE(amount_repaid,0) - v_amount) < COALESCE(total_repayment,0))
                    THEN 'repaying'
                    ELSE status
                  END,
         updated_at = now()
   WHERE id = v_req.rent_request_id;

  INSERT INTO public.agent_tenant_float_reversals (
    agent_id, rent_request_id, landlord_id, landlord_name,
    original_transaction_group, reversal_transaction_group,
    amount, commission_clawback, reason
  ) VALUES (
    v_req.agent_id, v_req.rent_request_id, v_landlord_id, v_landlord_name,
    v_req.original_transaction_group, v_new_group,
    v_amount, v_commission,
    'CFO approved: ' || v_req.reason
  );

  UPDATE public.agent_unfunding_requests
     SET status = 'approved', cfo_id = v_caller,
         cfo_decision_at = now(), cfo_note = p_cfo_note,
         reversal_transaction_group = v_new_group,
         updated_at = now()
   WHERE id = p_request_id;

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, metadata)
  VALUES (v_caller, 'cfo_approve_agent_unallocation', 'agent_unfunding_requests', p_request_id,
          jsonb_build_object('cfo_note', p_cfo_note,
                             'amount', v_amount,
                             'commission_clawback', v_commission,
                             'reversal_transaction_group', v_new_group));

  INSERT INTO public.system_events (event_type, user_id, payload)
  VALUES ('agent.unfunding.approved', v_caller, jsonb_build_object(
    'request_id', p_request_id, 'agent_id', v_req.agent_id,
    'amount', v_amount, 'commission_clawback', v_commission,
    'reversal_transaction_group', v_new_group));

  RETURN jsonb_build_object('success', true, 'status', 'approved',
                            'amount_returned', v_amount,
                            'commission_clawback', v_commission,
                            'reversal_transaction_group', v_new_group);
END;
$$;

GRANT EXECUTE ON FUNCTION public.cfo_decide_agent_unallocation(uuid, text, text) TO authenticated;
