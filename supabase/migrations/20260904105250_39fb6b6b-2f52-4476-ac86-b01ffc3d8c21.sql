CREATE OR REPLACE FUNCTION public.staff_requisition_reduce_amount(
  p_requisition_id uuid,
  p_new_amount numeric,
  p_reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.staff_requisitions;
  v_actor_name text;
BEGIN
  SELECT * INTO v_row FROM public.staff_requisitions WHERE id = p_requisition_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Requisition not found';
  END IF;

  IF v_row.requester_id <> auth.uid() THEN
    RAISE EXCEPTION 'Only the person who raised this requisition can reduce the amount';
  END IF;

  IF v_row.stage NOT IN ('supervisor', 'coo', 'cfo', 'ceo', 'returned') THEN
    RAISE EXCEPTION 'This requisition is no longer open for changes';
  END IF;

  IF p_new_amount IS NULL OR p_new_amount <= 0 THEN
    RAISE EXCEPTION 'Enter a valid amount';
  END IF;

  IF p_new_amount >= v_row.amount THEN
    RAISE EXCEPTION 'The new amount must be lower than the current requested amount';
  END IF;

  IF p_reason IS NULL OR length(btrim(p_reason)) < 10 THEN
    RAISE EXCEPTION 'Give a written basis of at least 10 characters';
  END IF;

  SELECT full_name INTO v_actor_name FROM public.profiles WHERE id = auth.uid();

  UPDATE public.staff_requisitions
     SET amount = p_new_amount,
         updated_at = now()
   WHERE id = p_requisition_id;

  INSERT INTO public.staff_requisition_events (
    requisition_id, actor_id, actor_name, actor_role, action, stage, comment, metadata
  ) VALUES (
    p_requisition_id,
    auth.uid(),
    COALESCE(v_actor_name, v_row.requester_name),
    v_row.requester_role,
    'amount_reduced',
    v_row.stage,
    p_reason,
    jsonb_build_object(
      'original_amount', v_row.amount,
      'new_amount', p_new_amount,
      'reduction', v_row.amount - p_new_amount
    )
  );

  RETURN jsonb_build_object(
    'success', true,
    'original_amount', v_row.amount,
    'new_amount', p_new_amount
  );
END;
$$;

REVOKE ALL ON FUNCTION public.staff_requisition_reduce_amount(uuid, numeric, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.staff_requisition_reduce_amount(uuid, numeric, text) TO authenticated;