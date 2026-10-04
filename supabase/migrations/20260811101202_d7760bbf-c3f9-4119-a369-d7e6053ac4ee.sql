CREATE OR REPLACE FUNCTION public.fin_ops_set_cash_location(
  p_deposit_request_id uuid,
  p_location text
)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_loc text;
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

  v_loc := lower(coalesce(p_location, ''));
  IF v_loc NOT IN ('bank', 'cash_at_hand') THEN
    RAISE EXCEPTION 'invalid_location';
  END IF;

  UPDATE public.deposit_requests
  SET purpose_audit = coalesce(purpose_audit, '{}'::jsonb) || jsonb_build_object(
        'cash_location', v_loc,
        'cash_location_set_by', auth.uid(),
        'cash_location_set_at', now()
      )
  WHERE id = p_deposit_request_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'deposit_request_not_found';
  END IF;

  RETURN v_loc;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.fin_ops_set_cash_location(uuid, text) TO authenticated;