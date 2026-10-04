CREATE TABLE public.landlord_payment_edits (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  edit_type text NOT NULL CHECK (edit_type IN ('rent_amount','landlord_payout')),
  rent_request_id uuid,
  payout_id uuid,
  tenant_id uuid,
  agent_id uuid,
  landlord_name text,
  old_amount numeric NOT NULL DEFAULT 0,
  new_amount numeric NOT NULL DEFAULT 0,
  reason text NOT NULL,
  edited_by uuid NOT NULL,
  edited_by_name text,
  agent_response text CHECK (agent_response IN ('agreed','disputed')),
  agent_responded_at timestamptz,
  agent_dispute_note text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_lpe_agent_pending ON public.landlord_payment_edits (agent_id) WHERE agent_response IS NULL;
CREATE INDEX idx_lpe_tenant ON public.landlord_payment_edits (tenant_id);
CREATE INDEX idx_lpe_created ON public.landlord_payment_edits (created_at DESC);

GRANT SELECT, INSERT, UPDATE ON public.landlord_payment_edits TO authenticated;
GRANT ALL ON public.landlord_payment_edits TO service_role;

ALTER TABLE public.landlord_payment_edits ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Ops can view all payment edits"
ON public.landlord_payment_edits FOR SELECT TO authenticated
USING (public.is_ops_role(auth.uid()) OR auth.uid() = agent_id);

CREATE POLICY "Ops can insert payment edits"
ON public.landlord_payment_edits FOR INSERT TO authenticated
WITH CHECK (public.is_ops_role(auth.uid()) AND edited_by = auth.uid());

CREATE POLICY "Agent can respond to own edits"
ON public.landlord_payment_edits FOR UPDATE TO authenticated
USING (auth.uid() = agent_id OR public.is_ops_role(auth.uid()))
WITH CHECK (auth.uid() = agent_id OR public.is_ops_role(auth.uid()));

ALTER PUBLICATION supabase_realtime ADD TABLE public.landlord_payment_edits;
ALTER TABLE public.landlord_payment_edits REPLICA IDENTITY FULL;

-- Unified edit RPC: records the change, applies it immediately, logs history + audit, flags the agent.
CREATE OR REPLACE FUNCTION public.ops_record_payment_edit(
  p_edit_type text,
  p_target_id uuid,
  p_new_amount numeric,
  p_reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_actor_name text;
  v_old numeric;
  v_tenant uuid;
  v_agent uuid;
  v_landlord_name text;
  v_rent_request_id uuid;
  v_payout_id uuid;
  v_edit_id uuid;
  v_new_total numeric;
  v_new_daily numeric;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;
  IF NOT public.is_ops_role(v_actor) THEN
    RAISE EXCEPTION 'Not authorised';
  END IF;
  IF p_reason IS NULL OR length(trim(p_reason)) < 10 THEN
    RAISE EXCEPTION 'Reason must be at least 10 characters';
  END IF;
  IF p_new_amount IS NULL OR p_new_amount <= 0 THEN
    RAISE EXCEPTION 'Amount must be positive';
  END IF;
  IF p_edit_type NOT IN ('rent_amount','landlord_payout') THEN
    RAISE EXCEPTION 'Invalid edit type';
  END IF;

  SELECT full_name INTO v_actor_name FROM public.profiles WHERE id = v_actor;

  IF p_edit_type = 'rent_amount' THEN
    SELECT rent_amount, tenant_id, COALESCE(assigned_agent_id, agent_id)
      INTO v_old, v_tenant, v_agent
      FROM public.rent_requests WHERE id = p_target_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Rent request not found';
    END IF;
    v_rent_request_id := p_target_id;

    UPDATE public.rent_requests
       SET rent_amount = p_new_amount, updated_at = now()
     WHERE id = p_target_id
     RETURNING total_repayment, daily_repayment INTO v_new_total, v_new_daily;
  ELSE
    SELECT amount, tenant_id, agent_id, landlord_name, rent_request_id
      INTO v_old, v_tenant, v_agent, v_landlord_name, v_rent_request_id
      FROM public.agent_landlord_payouts WHERE id = p_target_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Landlord payout not found';
    END IF;
    v_payout_id := p_target_id;

    UPDATE public.agent_landlord_payouts
       SET amount = p_new_amount, updated_at = now()
     WHERE id = p_target_id;
  END IF;

  INSERT INTO public.landlord_payment_edits (
    edit_type, rent_request_id, payout_id, tenant_id, agent_id, landlord_name,
    old_amount, new_amount, reason, edited_by, edited_by_name
  ) VALUES (
    p_edit_type, v_rent_request_id, v_payout_id, v_tenant, v_agent, v_landlord_name,
    COALESCE(v_old, 0), p_new_amount, trim(p_reason), v_actor, v_actor_name
  ) RETURNING id INTO v_edit_id;

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, metadata)
  VALUES (
    v_actor,
    'ops.record_payment_edit',
    CASE WHEN p_edit_type = 'rent_amount' THEN 'rent_requests' ELSE 'agent_landlord_payouts' END,
    p_target_id::text,
    jsonb_build_object(
      'edit_type', p_edit_type,
      'reason', trim(p_reason),
      'old_amount', COALESCE(v_old, 0),
      'new_amount', p_new_amount,
      'agent_id', v_agent,
      'edit_id', v_edit_id
    )
  );

  BEGIN
    INSERT INTO public.system_events (event_type, actor_id, subject_id, payload)
    VALUES (
      'payment_edit.recorded', v_actor, v_agent,
      jsonb_build_object('edit_id', v_edit_id, 'edit_type', p_edit_type,
        'old_amount', COALESCE(v_old,0), 'new_amount', p_new_amount, 'tenant_id', v_tenant)
    );
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  RETURN jsonb_build_object(
    'edit_id', v_edit_id,
    'old_amount', COALESCE(v_old, 0),
    'new_amount', p_new_amount,
    'agent_id', v_agent
  );
END;
$function$;

-- Agent agrees/disputes a recorded edit.
CREATE OR REPLACE FUNCTION public.agent_respond_payment_edit(
  p_edit_id uuid,
  p_response text,
  p_note text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_agent uuid;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;
  IF p_response NOT IN ('agreed','disputed') THEN
    RAISE EXCEPTION 'Invalid response';
  END IF;

  SELECT agent_id INTO v_agent FROM public.landlord_payment_edits WHERE id = p_edit_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Edit not found';
  END IF;
  IF v_agent IS DISTINCT FROM v_actor AND NOT public.is_ops_role(v_actor) THEN
    RAISE EXCEPTION 'Not authorised';
  END IF;
  IF p_response = 'disputed' AND (p_note IS NULL OR length(trim(p_note)) < 5) THEN
    RAISE EXCEPTION 'Dispute note must be at least 5 characters';
  END IF;

  UPDATE public.landlord_payment_edits
     SET agent_response = p_response,
         agent_responded_at = now(),
         agent_dispute_note = CASE WHEN p_response = 'disputed' THEN trim(p_note) ELSE NULL END
   WHERE id = p_edit_id;

  BEGIN
    INSERT INTO public.system_events (event_type, actor_id, subject_id, payload)
    VALUES ('payment_edit.responded', v_actor, v_actor,
      jsonb_build_object('edit_id', p_edit_id, 'response', p_response));
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  RETURN jsonb_build_object('edit_id', p_edit_id, 'response', p_response);
END;
$function$;