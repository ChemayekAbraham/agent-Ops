-- 1. Reversal ledger table -------------------------------------------------
CREATE TABLE public.agent_tenant_float_reversals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL,
  rent_request_id uuid NOT NULL,
  landlord_id uuid,
  landlord_name text,
  original_transaction_group uuid NOT NULL UNIQUE,
  reversal_transaction_group uuid NOT NULL,
  amount numeric NOT NULL CHECK (amount > 0),
  commission_clawback numeric NOT NULL DEFAULT 0,
  reason text NOT NULL CHECK (char_length(reason) >= 10),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_atfr_agent ON public.agent_tenant_float_reversals(agent_id, created_at DESC);
CREATE INDEX idx_atfr_rent_request ON public.agent_tenant_float_reversals(rent_request_id);

ALTER TABLE public.agent_tenant_float_reversals ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Agents view own reversals"
  ON public.agent_tenant_float_reversals
  FOR SELECT TO authenticated
  USING (agent_id = auth.uid());

CREATE POLICY "Staff view all reversals"
  ON public.agent_tenant_float_reversals
  FOR SELECT TO authenticated
  USING (
    has_role(auth.uid(), 'manager'::app_role)
    OR has_role(auth.uid(), 'super_admin'::app_role)
    OR has_role(auth.uid(), 'cfo'::app_role)
    OR has_role(auth.uid(), 'coo'::app_role)
    OR has_role(auth.uid(), 'operations'::app_role)
  );

-- 2. List reversible allocations -----------------------------------------
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
  created_at timestamptz
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
      AND gl.created_at >= now() - interval '7 days'
      AND gl.reference_id IS NOT NULL
  )
  SELECT
    c.transaction_group,
    c.amount,
    c.landlord_id,
    COALESCE(l.name, p.full_name, 'Landlord') AS landlord_name,
    c.description,
    c.created_at
  FROM candidate c
  LEFT JOIN public.landlords l ON l.id = c.landlord_id
  LEFT JOIN public.profiles p ON p.id = c.landlord_id
  WHERE NOT EXISTS (
    SELECT 1 FROM public.agent_tenant_float_reversals r
    WHERE r.original_transaction_group = c.transaction_group
  )
  ORDER BY c.created_at DESC;
$$;

GRANT EXECUTE ON FUNCTION public.get_agent_reversible_allocations(uuid, uuid) TO authenticated;

-- 3. Reversal RPC --------------------------------------------------------
CREATE OR REPLACE FUNCTION public.agent_unallocate_tenant_payment(
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
  v_caller         uuid := auth.uid();
  v_amount         numeric;
  v_landlord_id    uuid;
  v_landlord_name  text;
  v_commission     numeric;
  v_new_group      uuid := gen_random_uuid();
  v_tracking       text;
  v_rr_landlord    uuid;
  v_rr_paid        numeric;
  v_rr_total       numeric;
  v_orig_created   timestamptz;
BEGIN
  -- Authorization: only the agent themselves
  IF v_caller IS NULL OR v_caller <> p_agent_id THEN
    RETURN jsonb_build_object('success', false, 'error', 'Not authorized.');
  END IF;

  IF p_reason IS NULL OR char_length(trim(p_reason)) < 10 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Please provide a reason (10+ characters).');
  END IF;

  -- Already reversed?
  IF EXISTS (
    SELECT 1 FROM public.agent_tenant_float_reversals
    WHERE original_transaction_group = p_original_transaction_group
  ) THEN
    RETURN jsonb_build_object('success', false, 'error', 'This funding has already been marked not funded.');
  END IF;

  -- Locate the original wallet leg (agent cash_out, category rent_payment_for_tenant)
  SELECT gl.amount, gl.linked_party::uuid, gl.created_at
    INTO v_amount, v_landlord_id, v_orig_created
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

  -- 7-day window
  IF v_orig_created < now() - interval '7 days' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Funding older than 7 days — contact support.');
  END IF;

  -- Rent request must match the landlord on the original allocation
  SELECT landlord_id, COALESCE(amount_repaid, 0), COALESCE(total_repayment, 0)
    INTO v_rr_landlord, v_rr_paid, v_rr_total
  FROM public.rent_requests
  WHERE id = p_rent_request_id;

  IF v_rr_landlord IS NULL OR v_rr_landlord <> v_landlord_id THEN
    RETURN jsonb_build_object('success', false, 'error', 'Rent plan does not match the original funding.');
  END IF;

  v_commission := round(v_amount * 0.10);
  v_tracking   := substr(v_new_group::text, 1, 8);

  SELECT COALESCE(l.name, p.full_name, 'Landlord')
    INTO v_landlord_name
  FROM (SELECT v_landlord_id AS id) x
  LEFT JOIN public.landlords l ON l.id = x.id
  LEFT JOIN public.profiles p ON p.id = x.id;

  -- Post mirrored ledger transaction
  PERFORM public.create_ledger_transaction(
    'agent_tenant_float_allocation_reversal',
    jsonb_build_array(
      jsonb_build_object(
        'user_id', p_agent_id, 'amount', v_amount, 'direction', 'cash_in',
        'category', 'rent_payment_for_tenant', 'ledger_scope', 'wallet',
        'classification', 'production',
        'description', format('Tenant marked not funded — float returned to %s (%s)', v_landlord_name, v_tracking),
        'linked_party', v_landlord_id, 'reference_id', v_new_group::text,
        'recipient_type', 'operational_wallet'
      ),
      jsonb_build_object(
        'user_id', v_landlord_id, 'amount', v_amount, 'direction', 'cash_out',
        'category', 'rent_payment_received', 'ledger_scope', 'wallet',
        'classification', 'production',
        'description', format('Reversal — tenant marked not funded (%s)', v_tracking),
        'linked_party', p_agent_id, 'reference_id', v_new_group::text,
        'recipient_type', 'user'
      ),
      jsonb_build_object(
        'user_id', p_agent_id, 'amount', v_commission, 'direction', 'cash_out',
        'category', 'agent_commission_earned', 'ledger_scope', 'wallet',
        'classification', 'production',
        'description', format('10%% commission clawback — %s', v_tracking),
        'reference_id', v_new_group::text, 'recipient_type', 'user'
      ),
      jsonb_build_object(
        'user_id', p_agent_id, 'amount', v_commission, 'direction', 'cash_in',
        'category', 'agent_commission_payable', 'ledger_scope', 'platform',
        'classification', 'production',
        'description', format('Platform commission reversal (%s)', v_tracking),
        'reference_id', v_new_group::text
      )
    )
  );

  -- Reduce rent_request progress; demote completed → repaying if needed
  UPDATE public.rent_requests
     SET amount_repaid = GREATEST(0, COALESCE(amount_repaid, 0) - v_amount),
         status = CASE
                    WHEN status = 'completed'
                      AND (GREATEST(0, COALESCE(amount_repaid, 0) - v_amount) < COALESCE(total_repayment, 0))
                    THEN 'repaying'
                    ELSE status
                  END,
         updated_at = now()
   WHERE id = p_rent_request_id;

  -- Reversal record (also prevents double-reversal via UNIQUE)
  INSERT INTO public.agent_tenant_float_reversals (
    agent_id, rent_request_id, landlord_id, landlord_name,
    original_transaction_group, reversal_transaction_group,
    amount, commission_clawback, reason
  ) VALUES (
    p_agent_id, p_rent_request_id, v_landlord_id, v_landlord_name,
    p_original_transaction_group, v_new_group,
    v_amount, v_commission, p_reason
  );

  -- Audit trail
  INSERT INTO public.audit_logs (
    user_id, action_type, table_name, record_id, metadata
  ) VALUES (
    p_agent_id,
    'agent_unallocate_tenant_payment',
    'rent_requests',
    p_rent_request_id,
    jsonb_build_object(
      'reason', p_reason,
      'amount', v_amount,
      'commission_clawback', v_commission,
      'landlord_id', v_landlord_id,
      'landlord_name', v_landlord_name,
      'original_transaction_group', p_original_transaction_group,
      'reversal_transaction_group', v_new_group
    )
  );

  -- Emit system event (75% event-driven)
  INSERT INTO public.system_events (event_type, user_id, payload)
  VALUES (
    'agent.tenant.unfunded',
    p_agent_id,
    jsonb_build_object(
      'rent_request_id', p_rent_request_id,
      'landlord_id', v_landlord_id,
      'landlord_name', v_landlord_name,
      'amount', v_amount,
      'commission_clawback', v_commission,
      'original_transaction_group', p_original_transaction_group,
      'reversal_transaction_group', v_new_group
    )
  );

  RETURN jsonb_build_object(
    'success', true,
    'amount_returned', v_amount,
    'commission_clawback', v_commission,
    'landlord_name', v_landlord_name,
    'reversal_transaction_group', v_new_group
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.agent_unallocate_tenant_payment(uuid, uuid, uuid, text) TO authenticated;