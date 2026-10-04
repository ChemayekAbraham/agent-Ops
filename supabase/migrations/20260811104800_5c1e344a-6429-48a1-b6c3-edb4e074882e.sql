CREATE OR REPLACE FUNCTION public.fin_ops_set_cash_location(p_deposit_request_id uuid, p_location text, p_note text DEFAULT NULL::text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_loc text;
  v_prev text;
BEGIN
  IF NOT (
    public.has_role(auth.uid(), 'cfo')
    OR public.has_role(auth.uid(), 'coo')
    OR public.has_role(auth.uid(), 'manager')
    OR public.has_role(auth.uid(), 'super_admin')
    OR public.has_role(auth.uid(), 'operations')
    OR public.has_role(auth.uid(), 'financial_ops')
  ) THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;

  v_loc := CASE WHEN p_location = 'bank' THEN 'bank' ELSE 'cash_at_hand' END;

  SELECT COALESCE(purpose_audit->>'cash_location', 'cash_at_hand')
    INTO v_prev
  FROM public.deposit_requests
  WHERE id = p_deposit_request_id;

  IF v_prev IS NULL THEN
    RAISE EXCEPTION 'deposit_request_not_found';
  END IF;

  UPDATE public.deposit_requests
  SET purpose_audit = COALESCE(purpose_audit, '{}'::jsonb)
    || jsonb_build_object(
         'cash_location', v_loc,
         'cash_location_changed_at', now(),
         'cash_location_changed_by', auth.uid(),
         'cash_location_previous', v_prev,
         'cash_location_note', p_note
       ),
    updated_at = now()
  WHERE id = p_deposit_request_id;

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, action, metadata)
  VALUES (
    auth.uid(),
    'cash_location_changed',
    'deposit_requests',
    p_deposit_request_id::text,
    'cash_location_changed',
    jsonb_build_object(
      'cash_location', v_loc,
      'previous', v_prev,
      'reason', COALESCE(NULLIF(p_note, ''), 'Cash location updated to ' || v_loc || ' by finance staff')
    )
  );

  RETURN v_loc;
END;
$function$;