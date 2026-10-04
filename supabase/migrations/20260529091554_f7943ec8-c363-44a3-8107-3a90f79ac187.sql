-- Dispute resolution flow for landlord payment edits.
-- When an agent disputes an edit, the underlying amount is reverted to the
-- original until Tenant Ops resolves the dispute (uphold or keep reverted).

ALTER TABLE public.landlord_payment_edits
  ADD COLUMN IF NOT EXISTS reverted_on_dispute boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS resolution text CHECK (resolution IN ('upheld','reverted')),
  ADD COLUMN IF NOT EXISTS resolved_by uuid,
  ADD COLUMN IF NOT EXISTS resolved_by_name text,
  ADD COLUMN IF NOT EXISTS resolved_at timestamptz,
  ADD COLUMN IF NOT EXISTS resolution_note text,
  ADD COLUMN IF NOT EXISTS final_amount numeric;

CREATE INDEX IF NOT EXISTS idx_lpe_open_disputes
  ON public.landlord_payment_edits (created_at DESC)
  WHERE agent_response = 'disputed' AND resolution IS NULL;

-- Agent agrees/disputes. Disputing now REVERTS the applied amount to the
-- original value so the payout is paused at the pre-edit figure until Ops
-- resolves.
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
  v_edit public.landlord_payment_edits%ROWTYPE;
  v_reverted boolean := false;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;
  IF p_response NOT IN ('agreed','disputed') THEN
    RAISE EXCEPTION 'Invalid response';
  END IF;

  SELECT * INTO v_edit FROM public.landlord_payment_edits WHERE id = p_edit_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Edit not found';
  END IF;
  IF v_edit.agent_id IS DISTINCT FROM v_actor AND NOT public.is_ops_role(v_actor) THEN
    RAISE EXCEPTION 'Not authorised';
  END IF;
  IF v_edit.agent_response IS NOT NULL THEN
    RAISE EXCEPTION 'You have already responded to this change';
  END IF;
  IF p_response = 'disputed' AND (p_note IS NULL OR length(trim(p_note)) < 5) THEN
    RAISE EXCEPTION 'Dispute note must be at least 5 characters';
  END IF;

  -- On dispute, revert the underlying record to the original amount.
  IF p_response = 'disputed' THEN
    IF v_edit.edit_type = 'rent_amount' AND v_edit.rent_request_id IS NOT NULL THEN
      UPDATE public.rent_requests
         SET rent_amount = v_edit.old_amount, updated_at = now()
       WHERE id = v_edit.rent_request_id;
      v_reverted := true;
    ELSIF v_edit.edit_type = 'landlord_payout' AND v_edit.payout_id IS NOT NULL THEN
      UPDATE public.agent_landlord_payouts
         SET amount = v_edit.old_amount, updated_at = now()
       WHERE id = v_edit.payout_id;
      v_reverted := true;
    END IF;
  END IF;

  UPDATE public.landlord_payment_edits
     SET agent_response = p_response,
         agent_responded_at = now(),
         agent_dispute_note = CASE WHEN p_response = 'disputed' THEN trim(p_note) ELSE NULL END,
         reverted_on_dispute = v_reverted
   WHERE id = p_edit_id;

  BEGIN
    INSERT INTO public.system_events (event_type, actor_id, subject_id, payload)
    VALUES ('payment_edit.responded', v_actor, v_actor,
      jsonb_build_object('edit_id', p_edit_id, 'response', p_response, 'reverted', v_reverted));
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  BEGIN
    INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, metadata)
    VALUES (
      v_actor,
      'agent.respond_payment_edit',
      CASE WHEN v_edit.edit_type = 'rent_amount' THEN 'rent_requests' ELSE 'agent_landlord_payouts' END,
      COALESCE(v_edit.rent_request_id, v_edit.payout_id)::text,
      jsonb_build_object('edit_id', p_edit_id, 'response', p_response, 'reverted', v_reverted,
        'old_amount', v_edit.old_amount, 'new_amount', v_edit.new_amount)
    );
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  RETURN jsonb_build_object('edit_id', p_edit_id, 'response', p_response, 'reverted', v_reverted);
END;
$function$;

-- Tenant Ops resolves a disputed edit: either UPHOLD (re-apply the new amount,
-- or a negotiated final amount) or REVERT (keep the original amount).
CREATE OR REPLACE FUNCTION public.ops_resolve_payment_edit(
  p_edit_id uuid,
  p_resolution text,
  p_note text DEFAULT NULL,
  p_final_amount numeric DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_actor_name text;
  v_edit public.landlord_payment_edits%ROWTYPE;
  v_applied numeric;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;
  IF NOT public.is_ops_role(v_actor) THEN
    RAISE EXCEPTION 'Not authorised';
  END IF;
  IF p_resolution NOT IN ('upheld','reverted') THEN
    RAISE EXCEPTION 'Invalid resolution';
  END IF;
  IF p_note IS NULL OR length(trim(p_note)) < 10 THEN
    RAISE EXCEPTION 'Resolution note must be at least 10 characters';
  END IF;

  SELECT * INTO v_edit FROM public.landlord_payment_edits WHERE id = p_edit_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Edit not found';
  END IF;
  IF v_edit.agent_response IS DISTINCT FROM 'disputed' THEN
    RAISE EXCEPTION 'Only disputed edits can be resolved';
  END IF;
  IF v_edit.resolution IS NOT NULL THEN
    RAISE EXCEPTION 'This dispute has already been resolved';
  END IF;

  SELECT full_name INTO v_actor_name FROM public.profiles WHERE id = v_actor;

  IF p_resolution = 'upheld' THEN
    v_applied := COALESCE(p_final_amount, v_edit.new_amount);
    IF v_applied <= 0 THEN
      RAISE EXCEPTION 'Final amount must be positive';
    END IF;
    IF v_edit.edit_type = 'rent_amount' AND v_edit.rent_request_id IS NOT NULL THEN
      UPDATE public.rent_requests
         SET rent_amount = v_applied, updated_at = now()
       WHERE id = v_edit.rent_request_id;
    ELSIF v_edit.edit_type = 'landlord_payout' AND v_edit.payout_id IS NOT NULL THEN
      UPDATE public.agent_landlord_payouts
         SET amount = v_applied, updated_at = now()
       WHERE id = v_edit.payout_id;
    END IF;
  ELSE
    -- reverted: ensure underlying record sits at the original amount
    v_applied := v_edit.old_amount;
    IF v_edit.edit_type = 'rent_amount' AND v_edit.rent_request_id IS NOT NULL THEN
      UPDATE public.rent_requests
         SET rent_amount = v_applied, updated_at = now()
       WHERE id = v_edit.rent_request_id;
    ELSIF v_edit.edit_type = 'landlord_payout' AND v_edit.payout_id IS NOT NULL THEN
      UPDATE public.agent_landlord_payouts
         SET amount = v_applied, updated_at = now()
       WHERE id = v_edit.payout_id;
    END IF;
  END IF;

  UPDATE public.landlord_payment_edits
     SET resolution = p_resolution,
         resolved_by = v_actor,
         resolved_by_name = v_actor_name,
         resolved_at = now(),
         resolution_note = trim(p_note),
         final_amount = v_applied
   WHERE id = p_edit_id;

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, metadata)
  VALUES (
    v_actor,
    'ops.resolve_payment_edit',
    CASE WHEN v_edit.edit_type = 'rent_amount' THEN 'rent_requests' ELSE 'agent_landlord_payouts' END,
    COALESCE(v_edit.rent_request_id, v_edit.payout_id)::text,
    jsonb_build_object('edit_id', p_edit_id, 'resolution', p_resolution,
      'final_amount', v_applied, 'old_amount', v_edit.old_amount, 'new_amount', v_edit.new_amount,
      'reason', trim(p_note), 'agent_id', v_edit.agent_id)
  );

  BEGIN
    INSERT INTO public.system_events (event_type, actor_id, subject_id, payload)
    VALUES ('payment_edit.resolved', v_actor, v_edit.agent_id,
      jsonb_build_object('edit_id', p_edit_id, 'resolution', p_resolution, 'final_amount', v_applied));
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  RETURN jsonb_build_object('edit_id', p_edit_id, 'resolution', p_resolution, 'final_amount', v_applied);
END;
$function$;